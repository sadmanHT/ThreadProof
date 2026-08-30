"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createPublicClient, createWalletClient, custom, type Hex } from "viem";
import {
  credentialRegistryLifecycleAbi,
  type CredentialLifecycleItem,
  type CredentialLifecycleConfig,
} from "@/lib/credential-lifecycle-chain";

type InjectedProvider = Parameters<typeof custom>[0];
type Props = CredentialLifecycleConfig & { credentials: CredentialLifecycleItem[] };
type BusyAction = "revoke" | "status" | null;

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

function credentialIdFrom(form: FormData): Hex {
  const value = String(form.get("credentialId") ?? "").trim();
  if (!HEX_32.test(value)) throw new Error("Select a valid 32-byte credential id.");
  return value as Hex;
}

export function CredentialLifecycleConsole({ credentialRegistryAddress, chainId, credentials }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
    setMessage(`${success} The chain event is mined; this table updates after the ThreadProof indexer reconciles it.`);
    router.refresh();
  }

  async function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("revoke");
    setError(null);
    setMessage(null);
    try {
      const context = await walletContext();
      const credentialId = credentialIdFrom(new FormData(event.currentTarget));
      const txHash = await context.wallet.writeContract({
        account: context.account,
        chain: null,
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "revokeCredential",
        args: [credentialId],
      });
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

      const txHash = await context.wallet.writeContract({
        account: context.account,
        chain: null,
        address: credentialRegistryAddress,
        abi: credentialRegistryLifecycleAbi,
        functionName: "setCredentialStatus",
        args: [credentialId, newStatus],
      });
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
      <div className="panel-heading"><div><span className="kicker">CREDENTIAL LIFECYCLE</span><h2>Suspend or revoke without database authority</h2></div></div>
      <p className="muted">The connected wallet submits directly to CredentialRegistry. Issuer organizations may revoke their own credentials; suspension/restoration requires the on-chain SUSPENDER_ROLE. Revocation is terminal and cannot be restored.</p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}

      <div className="field-grid two">
        <form className="stack-form" onSubmit={revoke}>
          <span className="kicker">ISSUER REVOCATION</span>
          <CredentialSelect credentials={credentials} disabled={busy !== null} />
          <div className="callout"><strong>Irreversible</strong><span>CredentialRegistry checks that this wallet represents the credential's issuer organization or holds SUSPENDER_ROLE. A revoked credential can never return to active.</span></div>
          <button className="button primary" type="submit" disabled={busy !== null}>{busy === "revoke" ? "Revoking…" : "Revoke credential"}</button>
        </form>

        <form className="stack-form" onSubmit={setStatus}>
          <span className="kicker">PRIVILEGED STATUS CONTROL</span>
          <CredentialSelect credentials={credentials} disabled={busy !== null} />
          <label>New status<select name="newStatus" required disabled={busy !== null}><option value="2">Suspended</option><option value="1">Active (restore suspension)</option><option value="3">Revoked (terminal)</option></select></label>
          <div className="callout"><strong>Requires SUSPENDER_ROLE</strong><span>The browser checks the role before sending, and the contract checks it again. Restoring a revoked credential still reverts even for a privileged wallet.</span></div>
          <button className="button secondary" type="submit" disabled={busy !== null}>{busy === "status" ? "Submitting status…" : "Submit status transition"}</button>
        </form>
      </div>
    </section>
  );
}

function CredentialSelect({ credentials, disabled }: { credentials: CredentialLifecycleItem[]; disabled: boolean }) {
  return <label>Credential<select name="credentialId" required disabled={disabled}><option value="">Select credential</option>{credentials.map((credential) => <option value={credential.credentialId} key={credential.credentialId}>{credential.label} · {credential.subjectName} · {credential.status} · issuer {credential.issuerName}</option>)}</select></label>;
}
