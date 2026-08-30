"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type Hex,
} from "viem";
import { governanceProposalTypes, threadProofCharterAbi } from "@/lib/governance-chain";

type InjectedProvider = Parameters<typeof custom>[0];

export type FactoryOnboardingReview = {
  id: string;
  legalName: string;
  displayName: string;
  countryCode: string | null;
  notes: string | null;
  primaryAccount: Address;
  proposedChainOrganizationId: Hex;
  metadataHash: Hex;
  actionHash: Hex;
  chainProposalId: Hex | null;
  proposalState: string | null;
};

type Props = {
  charterAddress: Address;
  chainId: number;
  requests: FactoryOnboardingReview[];
};

type BusyAction = { requestId: string; action: "propose" | "approve" | "execute" } | null;

export function FactoryOnboardingConsole({ charterAddress, chainId, requests }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function walletContext() {
    const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
    if (!provider) throw new Error("No injected EVM governance wallet was found.");
    const wallet = createWalletClient({ transport: custom(provider) });
    const publicClient = createPublicClient({ transport: custom(provider) });
    const [account] = await wallet.requestAddresses();
    if (!account) throw new Error("No governance wallet account was selected.");
    const connectedChainId = await wallet.getChainId();
    if (connectedChainId !== chainId) {
      throw new Error(`Wallet is on chain ${connectedChainId}. Switch to ThreadProof chain ${chainId}.`);
    }
    return { wallet, publicClient, account };
  }

  async function propose(request: FactoryOnboardingReview) {
    setBusy({ requestId: request.id, action: "propose" });
    setError(null);
    setMessage(null);
    try {
      const { wallet, publicClient, account } = await walletContext();
      const hash = await wallet.writeContract({
        account,
        chain: null,
        address: charterAddress,
        abi: threadProofCharterAbi,
        functionName: "createProposal",
        args: [governanceProposalTypes.factoryOnboarding, request.actionHash, request.metadataHash],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Factory onboarding proposal transaction reverted.");
      setMessage("Proposal mined. Waiting for the indexer to link the Charter proposal to this signed request.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to open the factory onboarding proposal.");
    } finally {
      setBusy(null);
    }
  }

  async function approve(request: FactoryOnboardingReview) {
    if (!request.chainProposalId) return;
    setBusy({ requestId: request.id, action: "approve" });
    setError(null);
    setMessage(null);
    try {
      const { wallet, publicClient, account } = await walletContext();
      const hash = await wallet.writeContract({
        account,
        chain: null,
        address: charterAddress,
        abi: threadProofCharterAbi,
        functionName: "approveProposal",
        args: [request.chainProposalId],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Charter approval transaction reverted.");
      setMessage("Constituency approval mined. The indexer will refresh the threshold state shortly.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to approve this onboarding proposal.");
    } finally {
      setBusy(null);
    }
  }

  async function execute(request: FactoryOnboardingReview) {
    if (!request.chainProposalId) return;
    setBusy({ requestId: request.id, action: "execute" });
    setError(null);
    setMessage(null);
    try {
      const { wallet, publicClient, account } = await walletContext();
      const state = await publicClient.readContract({
        address: charterAddress,
        abi: threadProofCharterAbi,
        functionName: "getProposalState",
        args: [request.chainProposalId],
      });
      if (Number(state) !== 3) {
        throw new Error("The Charter does not currently consider this proposal executable.");
      }

      const hash = await wallet.writeContract({
        account,
        chain: null,
        address: charterAddress,
        abi: threadProofCharterAbi,
        functionName: "executeFactoryOnboarding",
        args: [
          request.chainProposalId,
          request.proposedChainOrganizationId,
          request.primaryAccount,
          request.metadataHash,
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Factory registration transaction reverted.");
      setMessage("Factory registration mined. Application membership will appear only after the matching OrganizationRegistered event is reconciled.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to execute factory onboarding.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel form-panel">
      <div className="panel-heading"><div><span className="kicker">FACTORY ADMISSION</span><h2>Auditor + industry review queue</h2></div></div>
      <p className="muted">Each request already contains a recovered proof that the applicant controls its proposed primary wallet. Review actions below are direct ThreadProofCharter transactions; no database status change can admit a factory.</p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}
      <div className="record-list">
        {requests.map((request) => {
          const isBusy = busy?.requestId === request.id;
          const canExecute = request.proposalState === "executable";
          return (
            <div className="record-row" key={request.id}>
              <div>
                <strong>{request.displayName}</strong>
                <span>{request.legalName}{request.countryCode ? ` · ${request.countryCode}` : ""}</span>
                <small className="mono">org {request.proposedChainOrganizationId.slice(0, 12)}… · wallet {request.primaryAccount.slice(0, 10)}… · action {request.actionHash.slice(0, 12)}…</small>
                {request.chainProposalId ? <small>Charter: <span className="mono">{request.chainProposalId.slice(0, 12)}…</span> · {request.proposalState ?? "awaiting projection"}</small> : <small>No Charter proposal has been opened yet.</small>}
                {request.notes ? <small>{request.notes}</small> : null}
              </div>
              <div className="form-actions">
                {!request.chainProposalId ? <button className="button secondary small" type="button" disabled={isBusy} onClick={() => propose(request)}>{isBusy ? "Submitting…" : "Open Charter proposal"}</button> : null}
                {request.chainProposalId && request.proposalState !== "executed" ? <button className="button secondary small" type="button" disabled={isBusy || canExecute} onClick={() => approve(request)}>{isBusy ? "Submitting…" : "Cast constituency approval"}</button> : null}
                {request.chainProposalId ? <button className="button primary small" type="button" disabled={isBusy || !canExecute} onClick={() => execute(request)}>{isBusy ? "Executing…" : "Execute registration"}</button> : null}
              </div>
            </div>
          );
        })}
        {!requests.length ? <div className="empty-state"><strong>No signed factory requests awaiting your constituency.</strong><span>Only pending factory requests are visible here, and RLS limits the queue to auditor/independent and factory/industry reviewer constituencies.</span></div> : null}
      </div>
    </section>
  );
}
