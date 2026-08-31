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
  governanceEmergencyTargets,
  governanceOperationalRoles,
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
type WalletContext = Awaited<ReturnType<typeof createGovernanceWalletContext>>;

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

async function createGovernanceWalletContext(chainId: number) {
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

async function protocolRolePayload(context: WalletContext, charterAddress: Address, form: FormData) {
  const account = requireAddress(form.get("roleAccount"), "Operational role account");
  const operation = String(form.get("roleOperation") ?? "");
  if (operation !== "grant" && operation !== "revoke") throw new Error("Choose whether to grant or revoke the operational role.");
  const grant = operation === "grant";
  const roleKind = String(form.get("operationalRole") ?? "");

  if (roleKind === governanceOperationalRoles.credentialIssuer) {
    const [target, role] = await Promise.all([
      context.publicClient.readContract({ address: charterAddress, abi: threadProofCharterAbi, functionName: "credentialRegistry" }),
      context.publicClient.readContract({ address: charterAddress, abi: threadProofCharterAbi, functionName: "CREDENTIAL_ISSUER_ROLE" }),
    ]);
    return { target, role, account, grant };
  }
  if (roleKind === governanceOperationalRoles.capacityCertifier) {
    const [target, role] = await Promise.all([
      context.publicClient.readContract({ address: charterAddress, abi: threadProofCharterAbi, functionName: "capacityVault" }),
      context.publicClient.readContract({ address: charterAddress, abi: threadProofCharterAbi, functionName: "CAPACITY_CERTIFIER_ROLE" }),
    ]);
    return { target, role, account, grant };
  }
  if (roleKind === governanceOperationalRoles.capacityRelayer) {
    const [target, role] = await Promise.all([
      context.publicClient.readContract({ address: charterAddress, abi: threadProofCharterAbi, functionName: "capacityVault" }),
      context.publicClient.readContract({ address: charterAddress, abi: threadProofCharterAbi, functionName: "CAPACITY_RELAYER_ROLE" }),
    ]);
    return { target, role, account, grant };
  }
  throw new Error("Unsupported operational protocol role.");
}

function verifierPayload(form: FormData) {
  return {
    circuitVersion: requireInteger(form.get("circuitVersion"), "Circuit version", 1, 4_294_967_295),
    verifierAddress: requireAddress(form.get("verifierAddress"), "Verifier address"),
    circuitArtifactHash: requireHex32(form.get("circuitArtifactHash"), "Circuit artifact hash"),
    verificationKeyHash: requireHex32(form.get("verificationKeyHash"), "Verification-key hash"),
  };
}

function subcontractPolicyPayload(form: FormData) {
  return {
    policyHash: requireHex32(form.get("subcontractPolicyHash"), "Subcontract policy hash"),
    maxDepth: requireInteger(form.get("maxSubcontractDepth"), "Maximum subcontract depth", 1, 8),
    complianceCredentialType: requireHex32(form.get("complianceCredentialType"), "Compliance credential type"),
    processCredentialType: requireHex32(form.get("processCredentialType"), "Process credential type"),
  };
}

function emergencyTarget(form: FormData) {
  return requireInteger(
    form.get("emergencyTarget"),
    "Emergency target",
    governanceEmergencyTargets.capacityVault,
    governanceEmergencyTargets.subcontractGovernor,
  );
}

function credentialId(form: FormData) {
  return requireHex32(form.get("credentialId"), "Credential id");
}

export function GovernanceConsole({ charterAddress, chainId, organizations, proposalIds }: Props) {
  const router = useRouter();
  const [proposalType, setProposalType] = useState<number>(governanceProposalTypes.organizationSuspension);
  const [executionType, setExecutionType] = useState<number>(governanceProposalTypes.organizationSuspension);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function walletContext() {
    return createGovernanceWalletContext(chainId);
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
        const targetProposalType = requireInteger(form.get("targetProposalType"), "Target proposal type", 1, 13);
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
      } else if (proposalType === governanceProposalTypes.protocolRoleUpdate) {
        const payload = await protocolRolePayload(context, charterAddress, form);
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashProtocolRoleAction",
          args: [payload.target, payload.role, payload.account, payload.grant],
        });
      } else if (proposalType === governanceProposalTypes.verifierRegistration) {
        const payload = verifierPayload(form);
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashVerifierRegistrationAction",
          args: [payload.circuitVersion, payload.verifierAddress, payload.circuitArtifactHash, payload.verificationKeyHash],
        });
      } else if (proposalType === governanceProposalTypes.subcontractPolicyRegistration) {
        const payload = subcontractPolicyPayload(form);
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashSubcontractPolicyAction",
          args: [payload.policyHash, payload.maxDepth, payload.complianceCredentialType, payload.processCredentialType],
        });
      } else if (
        proposalType === governanceProposalTypes.emergencyPause ||
        proposalType === governanceProposalTypes.emergencyUnpause
      ) {
        const target = emergencyTarget(form);
        const shouldPause = proposalType === governanceProposalTypes.emergencyPause;
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashEmergencyControlAction",
          args: [target, shouldPause],
        });
      } else if (
        proposalType === governanceProposalTypes.credentialSuspension ||
        proposalType === governanceProposalTypes.credentialRestore
      ) {
        const id = credentialId(form);
        const newStatus = proposalType === governanceProposalTypes.credentialSuspension ? 2 : 1;
        actionHash = await context.publicClient.readContract({
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "hashCredentialStatusAction",
          args: [id, newStatus],
        });
      } else {
        throw new Error("Unsupported Charter proposal type. Factory onboarding uses the dedicated governed onboarding console.");
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
        const targetProposalType = requireInteger(form.get("targetProposalType"), "Target proposal type", 1, 13);
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
      } else if (executionType === governanceProposalTypes.protocolRoleUpdate) {
        const payload = await protocolRolePayload(context, charterAddress, form);
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executeProtocolRoleUpdate",
          args: [proposalId, payload.target, payload.role, payload.account, payload.grant],
        });
      } else if (executionType === governanceProposalTypes.verifierRegistration) {
        const payload = verifierPayload(form);
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executeVerifierRegistration",
          args: [proposalId, payload.circuitVersion, payload.verifierAddress, payload.circuitArtifactHash, payload.verificationKeyHash],
        });
      } else if (executionType === governanceProposalTypes.subcontractPolicyRegistration) {
        const payload = subcontractPolicyPayload(form);
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executeSubcontractPolicyRegistration",
          args: [proposalId, payload.policyHash, payload.maxDepth, payload.complianceCredentialType, payload.processCredentialType],
        });
      } else if (
        executionType === governanceProposalTypes.emergencyPause ||
        executionType === governanceProposalTypes.emergencyUnpause
      ) {
        const target = emergencyTarget(form);
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executeEmergencyControl",
          args: [proposalId, target],
        });
      } else if (
        executionType === governanceProposalTypes.credentialSuspension ||
        executionType === governanceProposalTypes.credentialRestore
      ) {
        const id = credentialId(form);
        const newStatus = executionType === governanceProposalTypes.credentialSuspension ? 2 : 1;
        txHash = await context.wallet.writeContract({
          account: context.account,
          chain: null,
          address: charterAddress,
          abi: threadProofCharterAbi,
          functionName: "executeCredentialStatus",
          args: [proposalId, id, newStatus],
        });
      } else {
        throw new Error("Unsupported Charter execution type. Factory onboarding uses the dedicated governed onboarding console.");
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
      <p className="muted">These controls write directly to ThreadProofCharter with the connected wallet. The contract re-checks the wallet&apos;s current Registry organization, active status, constituency, threshold, action hash and timelock. Supabase membership and the proposal read model never grant governance authority.</p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}

      <form className="stack-form" onSubmit={createProposal}>
        <span className="kicker">CREATE</span>
        <label>Proposal type<select value={proposalType} onChange={(event) => setProposalType(Number(event.target.value))} disabled={busy !== null}>
          <GovernanceActionOptions />
        </select></label>

        <GovernanceActionFields actionType={proposalType} organizations={organizations} disabled={busy !== null} />
        <label>Public metadata hash <span className="muted">(optional)</span><input name="metadataHash" className="mono" placeholder="0x…; leave blank for zero hash" disabled={busy !== null} /></label>
        <div className="callout"><strong>Do not put confidential evidence here</strong><span>Metadata, protected-subject references and evidence are hashes or opaque references only. Protected identities, audit documents, private capacity values and signer material remain off-chain.</span></div>
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
          <GovernanceActionOptions />
        </select></label>
        <GovernanceActionFields actionType={executionType} organizations={organizations} disabled={busy !== null} />
        <div className="callout"><strong>Execution is fail-closed</strong><span>The action parameters must reproduce the proposal&apos;s committed action hash. A wrong target, changed account, changed verifier provenance, changed policy or premature execution reverts on-chain.</span></div>
        <div className="form-actions"><button className="button primary" type="submit" disabled={busy !== null}>{busy === "execute" ? "Executing…" : "Execute approved Charter action"}</button></div>
      </form>
    </section>
  );
}

function GovernanceActionOptions() {
  return <>
    <option value={governanceProposalTypes.organizationSuspension}>Organization emergency suspension</option>
    <option value={governanceProposalTypes.organizationRestore}>Restore suspended organization</option>
    <option value={governanceProposalTypes.primaryAccountRotation}>Primary account recovery / rotation</option>
    <option value={governanceProposalTypes.protectedIdentityDisclosure}>Protected identity disclosure authorization</option>
    <option value={governanceProposalTypes.charterPolicyUpdate}>Charter policy update</option>
    <option value={governanceProposalTypes.protocolRoleUpdate}>Delegate / revoke operational protocol role</option>
    <option value={governanceProposalTypes.verifierRegistration}>Register versioned ZK verifier provenance</option>
    <option value={governanceProposalTypes.subcontractPolicyRegistration}>Register subcontract policy</option>
    <option value={governanceProposalTypes.emergencyPause}>Emergency pause critical protocol path</option>
    <option value={governanceProposalTypes.emergencyUnpause}>Recover / unpause critical protocol path</option>
    <option value={governanceProposalTypes.credentialSuspension}>Emergency credential suspension</option>
    <option value={governanceProposalTypes.credentialRestore}>Restore suspended credential</option>
  </>;
}

function GovernanceActionFields({
  actionType,
  organizations,
  disabled,
}: {
  actionType: number;
  organizations: GovernanceTargetOrganization[];
  disabled: boolean;
}) {
  const organizationAction =
    actionType === governanceProposalTypes.organizationSuspension ||
    actionType === governanceProposalTypes.organizationRestore ||
    actionType === governanceProposalTypes.primaryAccountRotation;
  const emergencyAction =
    actionType === governanceProposalTypes.emergencyPause ||
    actionType === governanceProposalTypes.emergencyUnpause;
  const credentialAction =
    actionType === governanceProposalTypes.credentialSuspension ||
    actionType === governanceProposalTypes.credentialRestore;

  return <>
    {organizationAction ? <OrganizationSelect organizations={organizations} name="targetOrganizationId" disabled={disabled} /> : null}
    {actionType === governanceProposalTypes.primaryAccountRotation ? <label>Replacement EVM account<input name="newAccount" className="mono" required placeholder="0x…" disabled={disabled} /></label> : null}
    {actionType === governanceProposalTypes.protectedIdentityDisclosure ? <DisclosureFields disabled={disabled} /> : null}
    {actionType === governanceProposalTypes.charterPolicyUpdate ? <PolicyFields disabled={disabled} /> : null}
    {actionType === governanceProposalTypes.protocolRoleUpdate ? <ProtocolRoleFields disabled={disabled} /> : null}
    {actionType === governanceProposalTypes.verifierRegistration ? <VerifierFields disabled={disabled} /> : null}
    {actionType === governanceProposalTypes.subcontractPolicyRegistration ? <SubcontractPolicyFields disabled={disabled} /> : null}
    {emergencyAction ? <EmergencyFields disabled={disabled} /> : null}
    {credentialAction ? <CredentialFields disabled={disabled} /> : null}
  </>;
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

function ProtocolRoleFields({ disabled }: { disabled: boolean }) {
  return <><div className="field-grid three"><label>Operational role<select name="operationalRole" required disabled={disabled}><option value={governanceOperationalRoles.credentialIssuer}>Credential issuer</option><option value={governanceOperationalRoles.capacityCertifier}>Capacity certifier</option><option value={governanceOperationalRoles.capacityRelayer}>Capacity transaction relayer</option></select></label><label>Operation<select name="roleOperation" required disabled={disabled}><option value="grant">Grant role</option><option value="revoke">Revoke role</option></select></label><label>Account<input name="roleAccount" className="mono" required placeholder="0x…" disabled={disabled} /></label></div><p className="muted">The Charter deliberately refuses to delegate admin, pauser, verifier-admin, policy-admin, registrar or suspender roles to raw accounts. Issuer/certifier grants also require an active auditor or independent organization account.</p></>;
}

function VerifierFields({ disabled }: { disabled: boolean }) {
  return <><div className="field-grid two"><label>Circuit version<input name="circuitVersion" type="number" min="1" max="4294967295" required disabled={disabled} /></label><label>Verifier contract<input name="verifierAddress" className="mono" required placeholder="0x…" disabled={disabled} /></label></div><div className="field-grid two"><label>Circuit artifact hash<input name="circuitArtifactHash" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={disabled} /></label><label>Verification-key hash<input name="verificationKeyHash" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={disabled} /></label></div><p className="muted">A verifier registration is immutable for its circuit version. The CapacityVault also binds deployed bytecode provenance; this form never accepts proving keys or witness material.</p></>;
}

function SubcontractPolicyFields({ disabled }: { disabled: boolean }) {
  return <><div className="field-grid two"><label>Policy hash<input name="subcontractPolicyHash" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={disabled} /></label><label>Maximum subcontract depth<input name="maxSubcontractDepth" type="number" min="1" max="8" required defaultValue="2" disabled={disabled} /></label></div><div className="field-grid two"><label>Compliance credential type hash<input name="complianceCredentialType" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={disabled} /></label><label>Process credential type hash<input name="processCredentialType" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={disabled} /></label></div></>;
}

function EmergencyFields({ disabled }: { disabled: boolean }) {
  return <><label>Critical protocol target<select name="emergencyTarget" required disabled={disabled}><option value={governanceEmergencyTargets.capacityVault}>CapacityVault — new certification/spend operations</option><option value={governanceEmergencyTargets.subcontractGovernor}>SubcontractGovernor — new subcontract authorizations</option></select></label><p className="muted">Pause preserves historical reads and finalized state. Unpause is a separate governed recovery action with its own threshold and timelock.</p></>;
}

function CredentialFields({ disabled }: { disabled: boolean }) {
  return <label>Credential id<input name="credentialId" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={disabled} /></label>;
}

function PolicyFields({ disabled }: { disabled: boolean }) {
  return <><div className="field-grid three"><label>Target proposal type<select name="targetProposalType" required disabled={disabled}><option value="1">Organization suspension</option><option value="2">Organization restore</option><option value="3">Account rotation</option><option value="4">Protected disclosure</option><option value="5">Charter policy update</option><option value="6">Factory onboarding</option><option value="7">Operational role update</option><option value="8">Verifier registration</option><option value="9">Subcontract policy registration</option><option value="10">Emergency pause</option><option value="11">Emergency unpause</option><option value="12">Credential suspension</option><option value="13">Credential restore</option></select></label><label>Threshold<input name="threshold" type="number" min="1" max="5" defaultValue="4" required disabled={disabled} /></label><label>Eligible constituency mask<input name="eligibleMask" type="number" min="1" max="31" defaultValue="31" required disabled={disabled} /></label></div><div className="field-grid three"><label>Required constituency mask<input name="requiredMask" type="number" min="0" max="31" defaultValue="0" required disabled={disabled} /></label><label>Timelock seconds<input name="timelockSeconds" type="number" min="0" max="31536000" defaultValue="86400" required disabled={disabled} /></label><label>Voting period seconds<input name="votingPeriodSeconds" type="number" min="1" max="31536000" defaultValue="604800" required disabled={disabled} /></label></div><p className="muted">Mask bits: buyer 1, factory/industry 2, auditor/independent 4, regulator 8, labor 16. The contract rejects impossible thresholds or required roles outside the eligible mask.</p></>;
}
