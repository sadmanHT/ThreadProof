"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createPublicClient, createWalletClient, custom, isAddress, type Address, type Hex } from "viem";
import { governanceProposalTypes, threadProofCharterAbi } from "@/lib/governance-chain";

type InjectedProvider = Parameters<typeof custom>[0];
type Props = { charterAddress: Address; chainId: number };
type Busy = "create" | "execute" | null;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function hex32(value: FormDataEntryValue | null, label: string, allowEmpty = false): Hex {
  const text = String(value ?? "").trim();
  if (!text && allowEmpty) return `0x${"0".repeat(64)}` as Hex;
  if (!HEX32.test(text)) throw new Error(`${label} must be a canonical 32-byte hash.`);
  return text as Hex;
}

function address(value: FormDataEntryValue | null): Address {
  const text = String(value ?? "").trim();
  if (!isAddress(text)) throw new Error("Verifier address must be a valid EVM address.");
  return text;
}

function version(value: FormDataEntryValue | null) {
  const parsed = Number(String(value ?? ""));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4_294_967_295) {
    throw new Error("Release circuit version must be an unsigned 32-bit integer greater than zero.");
  }
  return parsed;
}

async function walletContext(chainId: number) {
  const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
  if (!provider) throw new Error("No injected governance wallet was found.");
  const wallet = createWalletClient({ transport: custom(provider) });
  const publicClient = createPublicClient({ transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error("No wallet account was selected.");
  const walletChainId = await wallet.getChainId();
  if (walletChainId !== chainId) throw new Error(`Switch the wallet to ThreadProof chain ${chainId}.`);
  return { wallet, publicClient, account };
}

function payload(form: FormData) {
  return {
    circuitVersion: version(form.get("releaseCircuitVersion")),
    verifierAddress: address(form.get("releaseVerifierAddress")),
    circuitArtifactHash: hex32(form.get("releaseCircuitArtifactHash"), "Release circuit artifact hash"),
    verificationKeyHash: hex32(form.get("releaseVerificationKeyHash"), "Release verification-key hash"),
  };
}

export function ReleaseVerifierGovernanceConsole({ charterAddress, chainId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    setMessage(null);
    try {
      const context = await walletContext(chainId);
      const form = new FormData(event.currentTarget);
      const values = payload(form);
      const metadataHash = hex32(form.get("releaseMetadataHash"), "Metadata hash", true);
      const actionHash = await context.publicClient.readContract({
        address: charterAddress,
        abi: threadProofCharterAbi,
        functionName: "hashReleaseVerifierRegistrationAction",
        args: [values.circuitVersion, values.verifierAddress, values.circuitArtifactHash, values.verificationKeyHash],
      });
      const txHash = await context.wallet.writeContract({
        account: context.account,
        chain: null,
        address: charterAddress,
        abi: threadProofCharterAbi,
        functionName: "createProposal",
        args: [governanceProposalTypes.releaseVerifierRegistration, actionHash, metadataHash],
      });
      const receipt = await context.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("Release-verifier proposal transaction reverted.");
      setMessage("Release-verifier proposal created. It still requires 4-of-5 Charter approval, including Auditor and Regulator, plus the one-day timelock.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create release-verifier governance proposal.");
    } finally {
      setBusy(null);
    }
  }

  async function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("execute");
    setError(null);
    setMessage(null);
    try {
      const context = await walletContext(chainId);
      const form = new FormData(event.currentTarget);
      const proposalId = hex32(form.get("releaseProposalId"), "Proposal id");
      const values = payload(form);
      const txHash = await context.wallet.writeContract({
        account: context.account,
        chain: null,
        address: charterAddress,
        abi: threadProofCharterAbi,
        functionName: "executeReleaseVerifierRegistration",
        args: [proposalId, values.circuitVersion, values.verifierAddress, values.circuitArtifactHash, values.verificationKeyHash],
      });
      const receipt = await context.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("Release-verifier execution transaction reverted.");
      setMessage("Release verifier registered through the canonical Charter action. The indexer will reconcile the event-derived audit view.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to execute release-verifier governance proposal.");
    } finally {
      setBusy(null);
    }
  }

  return <section className="panel">
    <div className="panel-heading"><div><span className="kicker">RELEASE VERIFIER GOVERNANCE</span><h2>Register CapacityRelease verifier provenance</h2></div></div>
    <p className="footnote">Spend and release verifiers have separate namespaces and separate Charter actions. A browser form cannot bypass constituency approval, action-hash binding, or the timelock.</p>
    {error ? <div className="alert alert-error">{error}</div> : null}
    {message ? <div className="alert alert-success">{message}</div> : null}
    <div className="detail-grid">
      <form onSubmit={create} className="stack-form">
        <h3>Create type-14 proposal</h3>
        <ReleaseVerifierFields disabled={busy != null} />
        <label>Metadata hash <input name="releaseMetadataHash" className="mono" placeholder="0x… (optional)" disabled={busy != null} /></label>
        <button className="button primary" disabled={busy != null}>{busy === "create" ? "Creating…" : "Create governed registration"}</button>
      </form>
      <form onSubmit={execute} className="stack-form">
        <h3>Execute approved proposal</h3>
        <label>Proposal id <input name="releaseProposalId" className="mono" required placeholder="0x…" disabled={busy != null} /></label>
        <ReleaseVerifierFields disabled={busy != null} />
        <button className="button primary" disabled={busy != null}>{busy === "execute" ? "Executing…" : "Execute after timelock"}</button>
      </form>
    </div>
  </section>;
}

function ReleaseVerifierFields({ disabled }: { disabled: boolean }) {
  return <>
    <label>Release circuit version <input name="releaseCircuitVersion" type="number" min="1" step="1" required disabled={disabled} /></label>
    <label>Verifier address <input name="releaseVerifierAddress" className="mono" required placeholder="0x…" disabled={disabled} /></label>
    <label>Circuit artifact hash <input name="releaseCircuitArtifactHash" className="mono" required placeholder="0x…" disabled={disabled} /></label>
    <label>Verification-key hash <input name="releaseVerificationKeyHash" className="mono" required placeholder="0x…" disabled={disabled} /></label>
  </>;
}
