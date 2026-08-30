"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  createPublicClient,
  createWalletClient,
  custom,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import {
  governanceProposalTypes,
  threadProofCharterAbi,
  type GovernanceTargetOrganization,
} from "@/lib/governance-chain";

type InjectedProvider = Parameters<typeof custom>[0];
type Props = {
  charterAddress: Address;
  chainId: number;
  organizations: GovernanceTargetOrganization[];
  proposalIds: string[];
};

type BusyAction = "create" | "approve" | "cancel" | "execute" | null;

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

function requireHex32(value: FormDataEntryValue | null, label: string, allowEmpty = false): Hex {
  const text = String(value ?? "").trim();
  if (!text && allowEmpty) return ZERO_HASH;
  if (!HEX_32.test(text)) throw new Error(`${label} must be a 32-byte 0x-prefixed hash.`);
  return text as Hex;
}

function requireAddress(value: FormDataEntryValue | null, label: string): Address {
  const text = String(value ?? "").trim();
  if (!isAddress(text)) throw new Error(`${label} must be a valid EVM address.`);
  return text;
}

function requireInteger(value: FormDataEntryValue | null, label: string, min: number, max: number) {
  const parsed = Number(String(value ?? ""));
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function GovernanceConsole({ charterAddress, chainId, organizations, proposalIds }: Props) {
  const router = useRouter();
  const [proposalType, setProposalType] = useState<number>(governanceProposalTypes.organizationSuspension);
  const [executionType, setExecutionType] = useState<number>(governanceProposalTypes.organizationSuspension);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function walletContext() {
    const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
    if (!provider) throw new Error("No injected EVM wallet was found. Connect a ThreadProof governance representative wallet.");
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
    hash: Hex,
    successMessage: string,
  ) {
    const receipt = await context.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The ThreadProofCharter transaction reverted.");
    setMessage(`${successMessage} The transaction is mined; the governance cards will update after the chain indexer reconciles the event.`);
    router.refresh();
  }

  async function createProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    setMessage(null);
    try {
      const context = await walletContext();
      const form = new FormData(event.currentTarget);
      const metadataHash = requireHex32(form.get("metadataHash"), "Metadata hash", true);
      let actionHash: Hex;

      if (
        proposalType === governanceProposalTypes.organizationSuspension ||
        proposalType === governanceProposalTypes.organizationRestore
      ) {
        const organizationId = requireHex32(form.get("targetOrganizationId"), "Organization id");
        const newStatus = proposalType === governanceProposalTypes.organizationSuspension ? 2 : 1;
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashOrganizationStatusAction",
          args: [organizationId, newStatus],
        });
      } else if (proposalType === governanceProposalTypes.primaryAccountRotation) {
        const organizationId = requireHex32(form.get("targetOrganizationId"), "Organization id");
        const newAccount = requireAddress(form.get("newAccount"), "Replacement account");
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashPrimaryAccountRotationAction",
          args: [organizationId, newAccount],
        });
      } else if (proposalType === governanceProposalTypes.protectedIdentityDisclosure) {
        const subjectReference = requireHex32(form.get("subjectReference"), "Protected subject reference");
        const evidenceHash = requireHex32(form.get("evidenceHash"), "Evidence hash");
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashProtectedIdentityDisclosureAction",
          args: [subjectReference, evidenceHash],
        });
      } else if (proposalType === governanceProposalTypes.charterPolicyUpdate) {
        const targetProposalType = requireInteger(form.get("targetProposalType"), "Target proposal type", 1, 5);
        const threshold = requireInteger(form.get("threshold"), "Threshold", 1, 5);
        const eligibleMask = requireInteger(form.get("eligibleMask"), "Eligible mask", 1, 31);
        const requiredMask = requireInteger(form.get("requiredMask"), "Required mask", 0, 31);
        const timelockSeconds = requireInteger(form.get("timelockSeconds"), "Timelock", 0, 31_536_000);
        const votingPeriodSeconds = requireInteger(form.get("votingPeriodSeconds"), "Voting period", 1, 31_536_000);
        const policyVersion = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "policyVersion",
        });
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashPolicyUpdateAction",
          args: [
            targetProposalType,
            threshold,
            eligibleMask,
            requiredMask,
            BigInt(timelockSeconds),
            BigInt(votingPeriodSeconds),
            policyVersion,
          ],
        });
      } else {
        throw new Error("Unsupported Charter proposal type.");
      }

      const txHash = await context.wallet.writeContract({
        account: context.account,
        chain: null,
        address: charterAddress,
        abi: threadProofCharterAbi,
        functionName: "createProposal",
        args: [proposalType, actionHash, metadataHash],
      });
      await waitForMined(context, txHash, "Charter proposal created.");
      event.currentTarget.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the Charter proposal.");
    } finally {
      setBusy(null);
    }
  }

  async function submitSimpleAction(event: FormEvent<HTMLFormElement>, action: "approve" | "cancel") {
    event.preventDefault();
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const context = await walletContext();
      const form = new FormData(event.currentTarget);
      const proposalId = requireHex32(form.get("proposalId"), "Proposal id");
      const txHash = action === "approve"
        ? await context.wallet.writeContract({
            account: context.account,
            chain: null,
            address: charterAddress,
            abi: threadProofCharterAbi,
            functionName: "approveProposal",
            args: [proposalId],
          })
        : await context.wallet.writeContract({
            account: context.account,
            chain: null,
            address: charterAddress,
            abi: threadProofCharterAbi,
            functionName: "cancelProposal",
            args: [proposalId],
          });
      await waitForMined(context, txHash, action === "approve" ? "Approval recorded on-chain." : "Proposal cancelled on-chain.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to ${action} the Charter proposal.`);
    } finally {
      setBusy(null);
    }
  }

  async function executeProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("execute");
    setError(null);
    setMessage(null);
    try {
      const context = await walletContext();
      const form = new FormData(event.currentTarget);
      const proposalId = requireHex32(form.get("proposalId"), "Proposal id");
      let txHash: Hex;

      if (
        executionType === governanceProposalTypes.organizationSuspension ||
        executionType === governanceProposalTypes.organizationRestore
      ) {
        const organizationId = requireHex32(form.get("targetOrganizationId"), "Organization id");
        const newStatus = executionType === governanceProposalTypes.organizationSuspension ? 2 : 1;
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executeOrganizationStatus",
          args: [proposalId, organizationId, newStatus],
        });
      } else if (executionType === governanceProposalTypes.primaryAccountRotation) {
        const organizationId = requireHex32(form.get("targetOrganizationId"), "Organization id");
        const newAccount = requireAddress(form.get("newAccount"), "Replacement account");
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executePrimaryAccountRotation",
          args: [proposalId, organizationId, newAccount],
        });
      } else if (executionType === governanceProposalTypes.protectedIdentityDisclosure) {
        const subjectReference = requireHex32(form.get("subjectReference"), "Protected subject reference");
        const evidenceHash = requireHex32(form.get("evidenceHash"), "Evidence hash");
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executeProtectedIdentityDisclosure",
          args: [proposalId, subjectReference, evidenceHash],
        });
      } else if (executionType === governanceProposalTypes.charterPolicyUpdate) {
        const targetProposalType = requireInteger(form.get("targetProposalType"), "Target proposal type", 1, 5);
        const threshold = requireInteger(form.get("threshold"), "Threshold", 1, 5);
        const eligibleMask = requireInteger(form.get("eligibleMask"), "Eligible mask", 1, 31);
        const requiredMask = requireInteger(form.get("requiredMask"), "Required mask", 0, 31);
        const timelockSeconds = requireInteger(form.get("timelockSeconds"), "Timelock", 0, 31_536_000);
        const votingPeriodSeconds = requireInteger(form.get("votingPeriodSeconds"), "Voting period", 1, 31_536_000);
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executePolicyUpdate",
          args: [
            proposalId,
            targetProposalType,
            {
              threshold,
              eligibleMask,
              requiredMask,
              timelockSeconds: BigInt(timelockSeconds),
              votingPeriodSeconds: BigInt(votingPeriodSeconds),
              exists: true,
            },
          ],
        });
      } else {
        throw new Error("Unsupported Charter execution type.");
      }

      await waitForMined(context, txHash, "Charter action executed on-chain.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to execute the Charter action.");
    } finally {
      setBusy(null);
    }
  }

  const proposalOptions = proposalIds.map((proposalId) => <option value={proposalId} key={proposalId} />);

  return (
    <section className="panel form-panel">
      <div className="panel-heading"><div><span className="kicker">ON-CHAIN CHARTER</span><h2>Governance console</h2></div></div>
      <p className="muted">These controls write directly to ThreadProofCharter with the connected wallet. The contract re-checks the wallet's current Registry organization, active status, constituency, threshold, action hash and timelock. Supabase membership and the proposal read model never grant governance authority.</p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}

      <form className="stack-form" onSubmit={createProposal}>
        <span className="kicker">CREATE</span>
        <label>Proposal type<select value={proposalType} onChange={(event) => setProposalType(Number(event.target.value))} disabled={busy !== null}>
          <option value={1}>Organization emergency suspension</option>
          <option value={2}>Restore suspended organization</option>
          <option value={3}>Primary account recovery / rotation</option>
          <option value={4}>Protected identity disclosure authorization</option>
          <option value={5}>Charter policy update</option>
        </select></label>

        {[1, 2, 3].includes(proposalType) ? <OrganizationSelect organizations={organizations} name="targetOrganizationId" disabled={busy !== null} /> : null}
        {proposalType === 3 ? <label>Replacement EVM account<input name="newAccount" className="mono" required placeholder="0x…" disabled={busy !== null} /></label> : null}
        {proposalType === 4 ? <DisclosureFields disabled={busy !== null} /> : null}
        {proposalType === 5 ? <PolicyFields disabled={busy !== null} /> : null}
        <label>Public metadata hash <span className="muted">(optional)</span><input name="metadataHash" className="mono" placeholder="0x…; leave blank for zero hash" disabled={busy !== null} /></label>
        <div className="callout"><strong>Do not put confidential evidence here</strong><span>Metadata, protected-subject references and evidence are hashes or opaque references only. Protected identities, audit documents and private capacity values remain off-chain.</span></div>
        <div className="form-actions"><button className="button primary" type="submit" disabled={busy !== null}>{busy === "create" ? "Creating proposal…" : "Create Charter proposal"}</button></div>
      </form>

      <div className="field-grid two">
        <form className="stack-form" onSubmit={(event) => submitSimpleAction(event, "approve")}>
          <span className="kicker">APPROVE</span>
          <ProposalInput proposalOptions={proposalOptions} disabled={busy !== null} />
          <button className="button primary" type="submit" disabled={busy !== null}>{busy === "approve" ? "Recording approval…" : "Approve with this constituency"}</button>
        </form>
        <form className="stack-form" onSubmit={(event) => submitSimpleAction(event, "cancel")}>
          <span className="kicker">CANCEL</span>
          <ProposalInput proposalOptions={proposalOptions} disabled={busy !== null} />
          <button className="button secondary" type="submit" disabled={busy !== null}>{busy === "cancel" ? "Cancelling…" : "Cancel as proposer organization"}</button>
        </form>
      </div>

      <form className="stack-form" onSubmit={executeProposal}>
        <span className="kicker">EXECUTE AFTER THRESHOLD + TIMELOCK</span>
        <ProposalInput proposalOptions={proposalOptions} disabled={busy !== null} />
        <label>Execution type<select value={executionType} onChange={(event) => setExecutionType(Number(event.target.value))} disabled={busy !== null}>
          <option value={1}>Organization emergency suspension</option>
          <option value={2}>Restore suspended organization</option>
          <option value={3}>Primary account recovery / rotation</option>
          <option value={4}>Protected identity disclosure authorization</option>
          <option value={5}>Charter policy update</option>
        </select></label>
        {[1, 2, 3].includes(executionType) ? <OrganizationSelect organizations={organizations} name="targetOrganizationId" disabled={busy !== null} /> : null}
        {executionType === 3 ? <label>Replacement EVM account<input name="newAccount" className="mono" required placeholder="0x…" disabled={busy !== null} /></label> : null}
        {executionType === 4 ? <DisclosureFields disabled={busy !== null} /> : null}
        {executionType === 5 ? <PolicyFields disabled={busy !== null} /> : null}
        <div className="callout"><strong>Execution is fail-closed</strong><span>The action parameters must reproduce the proposal's committed action hash. A wrong target, changed account, changed policy or premature execution reverts on-chain.</span></div>
        <div className="form-actions"><button className="button primary" type="submit" disabled={busy !== null}>{busy === "execute" ? "Executing…" : "Execute approved Charter action"}</button></div>
      </form>
    </section>
  );
}

function OrganizationSelect({ organizations, name, disabled }: { organizations: GovernanceTargetOrganization[]; name: string; disabled: boolean }) {
  return <label>Target organization<select name={name} required disabled={disabled}><option value="">Select organization</option>{organizations.map((organization) => <option value={organization.chainOrganizationId} key={organization.chainOrganizationId}>{organization.displayName} · {organization.role} · {organization.status}</option>)}</select></label>;
}

function ProposalInput({ proposalOptions, disabled }: { proposalOptions: React.ReactNode[]; disabled: boolean }) {
  return <label>Proposal id<input name="proposalId" className="mono" list="charter-proposal-ids" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={disabled} /><datalist id="charter-proposal-ids">{proposalOptions}</datalist></label>;
}

function DisclosureFields({ disabled }: { disabled: boolean }) {
  return <div className="field-grid two"><label>Protected subject reference hash<input name="subjectReference" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="Opaque 32-byte reference" disabled={disabled} /></label><label>Investigation evidence hash<input name="evidenceHash" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="Hash only — no document contents" disabled={disabled} /></label></div>;
}

function PolicyFields({ disabled }: { disabled: boolean }) {
  return <><div className="field-grid three"><label>Target proposal type<select name="targetProposalType" required disabled={disabled}><option value="1">Suspension</option><option value="2">Restore</option><option value="3">Account rotation</option><option value="4">Protected disclosure</option><option value="5">Charter policy update</option></select></label><label>Threshold<input name="threshold" type="number" min="1" max="5" defaultValue="4" required disabled={disabled} /></label><label>Eligible constituency mask<input name="eligibleMask" type="number" min="1" max="31" defaultValue="31" required disabled={disabled} /></label></div><div className="field-grid three"><label>Required constituency mask<input name="requiredMask" type="number" min="0" max="31" defaultValue="0" required disabled={disabled} /></label><label>Timelock seconds<input name="timelockSeconds" type="number" min="0" max="31536000" defaultValue="86400" required disabled={disabled} /></label><label>Voting period seconds<input name="votingPeriodSeconds" type="number" min="1" max="31536000" defaultValue="604800" required disabled={disabled} /></label></div><p className="muted">Mask bits: buyer 1, factory/industry 2, auditor/independent 4, regulator 8, labor 16. The contract rejects impossible thresholds or required roles outside the eligible mask.</p></>;
}
