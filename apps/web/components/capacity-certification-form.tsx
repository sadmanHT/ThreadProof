"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createPublicClient, createWalletClient, custom, type Address } from "viem";
import {
  prepareCapacityCertificationAction,
  resumeCapacityCertificationAction,
} from "@/app/app/capacity-certification-actions";
import {
  capacityVaultWriteAbi,
  credentialRegistryWriteAbi,
  type PreparedCapacityCertification,
} from "@/lib/capacity-certification-chain";

type Option = { id: string; displayName: string };
type ResumeJob = {
  id: string;
  status: string;
  factoryName: string;
  periodLabel: string;
  processLabel: string;
};
type Props = {
  auditorOrganizations: Option[];
  factories: Option[];
  resumableJobs: ResumeJob[];
};
type InjectedProvider = Parameters<typeof custom>[0];
type Stage = "idle" | "preparing" | "credential" | "certifying" | "awaiting-indexer";

export function CapacityCertificationForm({ auditorOrganizations, factories, resumableJobs }: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function walletContext() {
    const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
    if (!provider) throw new Error("No injected EVM wallet was found. Install or enable the auditor signing wallet.");
    const wallet = createWalletClient({ transport: custom(provider) });
    const publicClient = createPublicClient({ transport: custom(provider) });
    const [account] = await wallet.requestAddresses();
    if (!account) throw new Error("No wallet account was selected.");
    const chainId = await wallet.getChainId();
    return { wallet, publicClient, account, chainId };
  }

  async function executeCertification(
    prepared: PreparedCapacityCertification,
    credentialAlreadyOnChain: boolean,
    context: Awaited<ReturnType<typeof walletContext>>,
  ) {
    if (context.chainId !== prepared.chainId) {
      throw new Error(`Wallet is on chain ${context.chainId}. Switch it to ThreadProof chain ${prepared.chainId}.`);
    }

    if (!credentialAlreadyOnChain) {
      setStage("credential");
      const credentialTx = await context.wallet.writeContract({
        account: context.account,
        address: prepared.credentialRegistryAddress,
        abi: credentialRegistryWriteAbi,
        functionName: "issueCredential",
        args: [
          prepared.credential.credentialId,
          prepared.credential.factoryOrganizationId,
          prepared.credential.credentialType,
          prepared.credential.digest,
          prepared.credential.scopeHash,
          BigInt(prepared.credential.validFrom),
          BigInt(prepared.credential.validUntil),
        ],
      });
      const credentialReceipt = await context.publicClient.waitForTransactionReceipt({ hash: credentialTx });
      if (credentialReceipt.status !== "success") throw new Error("CredentialRegistry transaction reverted.");
    }

    setStage("certifying");
    const certificationTx = await context.wallet.writeContract({
      account: context.account as Address,
      address: prepared.capacityVaultAddress,
      abi: capacityVaultWriteAbi,
      functionName: "certifyCapacity",
      args: [
        prepared.certification.factoryOrganizationId,
        prepared.certification.periodId,
        prepared.certification.processId,
        BigInt(prepared.certification.initialCommitment),
        prepared.certification.capacityCredentialId,
        prepared.certification.policyHash,
        prepared.certification.circuitVersion,
      ],
    });
    const certificationReceipt = await context.publicClient.waitForTransactionReceipt({ hash: certificationTx });
    if (certificationReceipt.status !== "success") throw new Error("CapacityVault certification transaction reverted.");

    setStage("awaiting-indexer");
    setMessage("Both transactions are mined. ThreadProof is waiting for the indexer to reconcile the matching Besu events before the private opening appears as active.");
    router.refresh();
  }

  async function certify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const context = await walletContext();
      const form = new FormData(event.currentTarget);
      setStage("preparing");
      const result = await prepareCapacityCertificationAction({
        auditorOrganizationId: String(form.get("auditorOrganizationId") ?? ""),
        factoryOrganizationId: String(form.get("factoryOrganizationId") ?? ""),
        account: context.account,
        exactCapacity: String(form.get("exactCapacity") ?? ""),
        periodLabel: String(form.get("periodLabel") ?? ""),
        processLabel: String(form.get("processLabel") ?? ""),
        policyHash: String(form.get("policyHash") ?? ""),
        assessmentMethodology: String(form.get("assessmentMethodology") ?? ""),
        validFrom: String(form.get("validFrom") ?? ""),
        validUntil: String(form.get("validUntil") ?? ""),
        circuitVersion: Number(form.get("circuitVersion") ?? 1),
      });
      if (!result.ok) throw new Error(result.error);
      await executeCertification(result.prepared, result.credentialAlreadyOnChain, context);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to certify capacity.");
      setStage("idle");
    }
  }

  async function resume(jobId: string) {
    setError(null);
    setMessage(null);
    try {
      const context = await walletContext();
      setStage("preparing");
      const result = await resumeCapacityCertificationAction({ jobId, account: context.account });
      if (!result.ok) throw new Error(result.error);
      await executeCertification(result.prepared, result.credentialAlreadyOnChain, context);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to resume capacity certification.");
      setStage("idle");
    }
  }

  const busy = stage !== "idle" && stage !== "awaiting-indexer";
  const buttonLabel = stage === "preparing"
    ? "Preparing encrypted opening…"
    : stage === "credential"
      ? "Issuing capacity credential…"
      : stage === "certifying"
        ? "Certifying commitment…"
        : stage === "awaiting-indexer"
          ? "Mined · awaiting reconciliation"
          : "Issue credential and certify";

  return (
    <section className="panel form-panel">
      <div className="panel-heading"><div><span className="kicker">AUDITOR CERTIFICATION</span><h2>Certify a private capacity opening</h2></div></div>
      <p className="muted">Exact capacity and opening randomness are encrypted before storage. Only the Poseidon commitment, credential binding, policy, period, process and circuit version are submitted to the consortium chain.</p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}
      <form className="stack-form" onSubmit={certify}>
        <div className="field-grid two">
          <label>Auditor organization<select name="auditorOrganizationId" required disabled={busy}>{auditorOrganizations.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
          <label>Factory<select name="factoryOrganizationId" required disabled={busy}><option value="">Select factory</option>{factories.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
        </div>
        <div className="field-grid three">
          <label>Exact certified capacity<input name="exactCapacity" inputMode="numeric" pattern="[0-9]+" required placeholder="e.g. 1200000" disabled={busy} /></label>
          <label>Period label<input name="periodLabel" required placeholder="e.g. 2026-Q4" disabled={busy} /></label>
          <label>Process label<input name="processLabel" required placeholder="e.g. sewing-line-a" disabled={busy} /></label>
        </div>
        <label>Consortium policy hash<input name="policyHash" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={busy} /></label>
        <label>Assessment methodology<textarea name="assessmentMethodology" rows={3} required placeholder="Describe the audit method and evidence basis used to certify this capacity." disabled={busy} /></label>
        <div className="field-grid three">
          <label>Valid from<input name="validFrom" type="date" required disabled={busy} /></label>
          <label>Valid until<input name="validUntil" type="date" required disabled={busy} /></label>
          <label>Circuit version<input name="circuitVersion" type="number" min="1" max="4294967295" defaultValue="1" required disabled={busy} /></label>
        </div>
        <div className="callout"><strong>Authority remains on Besu</strong><span>The server validates that the selected wallet is an active account of the auditor organization and currently holds both CredentialRegistry ISSUER_ROLE and CapacityVault CERTIFIER_ROLE. A staged database row alone never certifies capacity.</span></div>
        <div className="form-actions"><button className="button primary" type="submit" disabled={busy || stage === "awaiting-indexer"}>{buttonLabel}</button></div>
      </form>

      {resumableJobs.length ? <div className="pending-panel"><span className="kicker">RESUMABLE WORK</span><h3>Interrupted certifications</h3><p className="muted">If a wallet flow stopped after staging or credential issuance, resume the same commitment instead of creating a competing opening.</p><div className="record-list">{resumableJobs.map((job) => <div className="record-row" key={job.id}><div><strong>{job.factoryName} · {job.periodLabel}</strong><span>{job.processLabel} · {job.status.replaceAll("_", " ")}</span></div><button type="button" className="button secondary small" disabled={busy} onClick={() => resume(job.id)}>Resume</button></div>)}</div></div> : null}
    </section>
  );
}
