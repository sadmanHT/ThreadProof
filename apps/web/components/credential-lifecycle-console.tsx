"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createPublicClient, createWalletClient, custom, toHex, type Hex } from "viem";
import {
  credentialRegistryLifecycleAbi,
  subcontractCredentialPolicyAbi,
  type CredentialLifecycleItem,
  type CredentialLifecycleConfig,
  type CredentialSubjectItem,
  type SubcontractCredentialPolicyItem,
} from "@/lib/credential-lifecycle-chain";

type InjectedProvider = Parameters<typeof custom>[0];
type Props = CredentialLifecycleConfig & {
  credentials: CredentialLifecycleItem[];
  subjects: CredentialSubjectItem[];
  subcontractPolicies: SubcontractCredentialPolicyItem[];
};
type BusyAction = "issue" | "revoke" | "status" | null;

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

function credentialIdFrom(form: FormData): Hex {
  const value = String(form.get("credentialId") ?? "").trim();
  if (!HEX_32.test(value)) throw new Error("Select a valid 32-byte credential id.");
  return value as Hex;
}

function hex32From(form: FormData, key: string, label: string): Hex {
  const value = String(form.get(key) ?? "").trim();
  if (!HEX_32.test(value)) throw new Error(`${label} must be a 32-byte hex value.`);
  return value as Hex;
}

function randomCredentialId(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes) as Hex;
}

function unixSeconds(value: string, label: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(`${label} is outside the supported range.`);
  return BigInt(seconds);
}

export function CredentialLifecycleConsole({
  credentialRegistryAddress,
  subcontractGovernorAddress,
  chainId,
  credentials,
  subjects,
  subcontractPolicies,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<Hex | null>(null);
  const [lastCredentialId, setLastCredentialId] = useState<Hex | null>(null);

  async function walletContext() {
    const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
    if (!provider) throw new Error("No injected EVM wallet was found. Connect the credential authority wallet.");
    const wallet = createWalletClient({ transport: custom(provider) });
    const publicClient = createPublicClient({ transport: custom(provider) });
    const [account] = await wallet.requestAddresses();
    if (!account) throw new Error("No wallet account was selected.");
    const walletChainId = await wallet.getChainId();
    if (walletChainId !== chainId) {
      throw new Error(`Wallet is on chain ${walletChainId}. Switch it to ThreadProof chain ${chainId}.`);
    }
    return { wallet, publicClient, account };
  }

  async function waitForMined(
    context: Awaited<ReturnType<typeof walletContext>>,
    txHash: Hex,
    success: string,
  ) {
    const receipt = await context.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("CredentialRegistry transaction reverted.");
    setLastTxHash(txHash);
    setMessage(`${success} The transaction is mined; the read model updates only after the ThreadProof indexer reconciles the canonical event.`);
    router.refresh();
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("issue");
    setError(null);
    setMessage(null);
    setLastTxHash(null);
    setLastCredentialId(null);
    try {
      if (!subcontractGovernorAddress) {
        throw new Error("SubcontractGovernor is not configured, so policy-bound credential scopes cannot be derived safely.");
      }
      const form = new FormData(event.currentTarget);
      const subjectOrganizationId = hex32From(form, "subjectOrganizationId", "Subject organization id");
      const policyHash = hex32From(form, "policyHash", "Policy hash");
      const digest = hex32From(form, "digest", "Credential digest");
      const kind = String(form.get("credentialKind") ?? "");
      if (kind !== "compliance" && kind !== "process") throw new Error("Choose a subcontract credential kind.");
      const processId = kind === "process" ? hex32From(form, "processId", "Process id") : null;
      const validFrom = unixSeconds(String(form.get("validFrom") ?? ""), "Valid from");
      const validUntil = unixSeconds(String(form.get("validUntil") ?? ""), "Valid until");
      if (validUntil <= validFrom) throw new Error("Valid until must be later than valid from.");

      const context = await walletContext();
      const issuerRole = await context.publicClient.readContract({
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "ISSUER_ROLE",
      });
      const hasIssuerRole = await context.publicClient.readContract({
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "hasRole",
        args: [issuerRole, context.account],
      });
      if (!hasIssuerRole) throw new Error("The selected wallet does not hold CredentialRegistry ISSUER_ROLE.");

      const policy = await context.publicClient.readContract({
        address: subcontractGovernorAddress,
        abi: subcontractCredentialPolicyAbi,
        functionName: "getPolicy",
        args: [policyHash],
      });
      if (!policy.exists) throw new Error("The selected subcontract policy is not registered on-chain.");

      const credentialType = kind === "compliance" ? policy.complianceCredentialType : policy.processCredentialType;
      const scopeHash = kind === "compliance"
        ? await context.publicClient.readContract({
            address: subcontractGovernorAddress,
            abi: subcontractCredentialPolicyAbi,
            functionName: "complianceCredentialScopeHash",
            args: [subjectOrganizationId, policyHash],
          })
        : await context.publicClient.readContract({
            address: subcontractGovernorAddress,
            abi: subcontractCredentialPolicyAbi,
            functionName: "processCredentialScopeHash",
            args: [subjectOrganizationId, processId as Hex, policyHash],
          });

      const credentialId = randomCredentialId();
      const { request } = await context.publicClient.simulateContract({
        account: context.account,
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "issueCredential",
        args: [credentialId, subjectOrganizationId, credentialType, digest, scopeHash, validFrom, validUntil],
      });
      const txHash = await context.wallet.writeContract(request);
      setLastCredentialId(credentialId);
      await waitForMined(context, txHash, `${kind === "compliance" ? "Compliance" : "Process"} credential anchored on-chain as ${credentialId}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to issue the credential.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("revoke");
    setError(null);
    setMessage(null);
    setLastTxHash(null);
    setLastCredentialId(null);
    try {
      const context = await walletContext();
      const credentialId = credentialIdFrom(new FormData(event.currentTarget));
      const { request } = await context.publicClient.simulateContract({
        account: context.account,
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "revokeCredential",
        args: [credentialId],
      });
      const txHash = await context.wallet.writeContract(request);
      await waitForMined(context, txHash, "Credential revoked on-chain.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to revoke the credential.");
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("status");
    setError(null);
    setMessage(null);
    setLastTxHash(null);
    setLastCredentialId(null);
    try {
      const context = await walletContext();
      const form = new FormData(event.currentTarget);
      const credentialId = credentialIdFrom(form);
      const newStatus = Number(String(form.get("newStatus") ?? ""));
      if (![1, 2, 3].includes(newStatus)) throw new Error("Choose a valid credential status transition.");

      const suspenderRole = await context.publicClient.readContract({
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "SUSPENDER_ROLE",
      });
      const hasSuspenderRole = await context.publicClient.readContract({
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "hasRole",
        args: [suspenderRole, context.account],
      });
      if (!hasSuspenderRole) {
        throw new Error("The selected wallet does not hold CredentialRegistry SUSPENDER_ROLE. Use issuer revocation for credentials issued by your organization, or connect an authorized suspender wallet.");
      }

      const { request } = await context.publicClient.simulateContract({
        account: context.account,
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "setCredentialStatus",
        args: [credentialId, newStatus],
      });
      const txHash = await context.wallet.writeContract(request);
      const label = newStatus === 1 ? "restored to active" : newStatus === 2 ? "suspended" : "revoked";
      await waitForMined(context, txHash, `Credential ${label} on-chain.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update credential status.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel form-panel">
      <div className="panel-heading"><div><span className="kicker">CREDENTIAL AUTHORITY</span><h2>Issue and control canonical credentials</h2></div></div>
      <p className="muted">The browser never writes credential authority into Postgres. An authorized wallet simulates and submits directly to CredentialRegistry; the indexer later rebuilds the application mirror from confirmed events.</p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}{lastTxHash ? <> <Link href={`/app/chain/transactions/${lastTxHash}`}>Verify canonical transaction</Link>.</> : null}{lastCredentialId ? <> Credential id <span className="mono">{lastCredentialId}</span>.</> : null}</div> : null}

      <form className="stack-form" onSubmit={issue}>
        <span className="kicker">POLICY-BOUND ISSUANCE</span>
        <h3>Anchor a subcontract compliance or process credential</h3>
        <div className="field-grid two">
          <label>Subject factory<select name="subjectOrganizationId" required disabled={busy !== null}><option value="">Select active factory</option>{subjects.map((subject) => <option value={subject.chainOrganizationId} key={subject.organizationId}>{subject.name}</option>)}</select></label>
          <label>Registered policy<select name="policyHash" required disabled={busy !== null}><option value="">Select policy</option>{subcontractPolicies.map((policy) => <option value={policy.policyHash} key={policy.policyHash}>{policy.policyHash.slice(0, 12)}… · max depth {policy.maxDepth}</option>)}</select></label>
          <label>Credential kind<select name="credentialKind" required disabled={busy !== null}><option value="compliance">Compliance</option><option value="process">Process-specific</option></select></label>
          <label>Process id <span className="optional">required for process credentials</span><input name="processId" className="mono" pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={busy !== null} /></label>
          <label>Credential package digest<input name="digest" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={busy !== null} /></label>
          <label>Valid from<input name="validFrom" type="datetime-local" required disabled={busy !== null} /></label>
          <label>Valid until<input name="validUntil" type="datetime-local" required disabled={busy !== null} /></label>
        </div>
        <div className="callout"><strong>No plaintext evidence on-chain</strong><span>The transaction contains an opaque credential id, policy-derived credential type, digest, exact scope hash and validity window. The underlying assessment package stays outside the chain.</span></div>
        <button className="button primary" type="submit" disabled={busy !== null || !subjects.length || !subcontractPolicies.length || !subcontractGovernorAddress}>{busy === "issue" ? "Simulating and issuing…" : "Issue credential"}</button>
      </form>

      <div className="field-grid two">
        <form className="stack-form" onSubmit={revoke}>
          <span className="kicker">ISSUER REVOCATION</span>
          <CredentialSelect credentials={credentials} disabled={busy !== null} />
          <div className="callout"><strong>Irreversible</strong><span>CredentialRegistry checks that this wallet represents the credential's issuer organization or holds SUSPENDER_ROLE. A revoked credential can never return to active.</span></div>
          <button className="button primary" type="submit" disabled={busy !== null}>{busy === "revoke" ? "Simulating revocation…" : "Revoke credential"}</button>
        </form>

        <form className="stack-form" onSubmit={setStatus}>
          <span className="kicker">PRIVILEGED STATUS CONTROL</span>
          <CredentialSelect credentials={credentials} disabled={busy !== null} />
          <label>New status<select name="newStatus" required disabled={busy !== null}><option value="2">Suspended</option><option value="1">Active (restore suspension)</option><option value="3">Revoked (terminal)</option></select></label>
          <div className="callout"><strong>Requires SUSPENDER_ROLE</strong><span>The browser checks the role and simulates the exact transition before sending. Restoring a revoked credential still reverts even for a privileged wallet.</span></div>
          <button className="button secondary" type="submit" disabled={busy !== null}>{busy === "status" ? "Simulating status…" : "Submit status transition"}</button>
        </form>
      </div>
    </section>
  );
}

function CredentialSelect({ credentials, disabled }: { credentials: CredentialLifecycleItem[]; disabled: boolean }) {
  return <label>Credential<select name="credentialId" required disabled={disabled}><option value="">Select credential</option>{credentials.map((credential) => <option value={credential.credentialId} key={credential.credentialId}>{credential.label} · {credential.subjectName} · {credential.status} · issuer {credential.issuerName}</option>)}</select></label>;
}
