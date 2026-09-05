"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createWalletClient, custom } from "viem";
import {
  prepareOrderCancellationAction,
  submitOrderCancellationSignatureAction,
} from "@/app/app/order-cancellation-actions";
import { buildCancelOrderTypedData } from "@/lib/order-eip712";

type Props = {
  orderId: string;
  currentVersion: number;
};

type Stage = "idle" | "preparing" | "wallet" | "storing" | "signed";
type InjectedProvider = Parameters<typeof custom>[0];

export function OrderCancellationForm({ orderId, currentVersion }: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [signer, setSigner] = useState<string | null>(null);

  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSigner(null);
    const form = new FormData(event.currentTarget);
    if (String(form.get("confirmation") ?? "").trim().toUpperCase() !== "CANCEL") {
      setError("Type CANCEL exactly to confirm this irreversible on-chain action.");
      return;
    }

    try {
      setStage("preparing");
      const prepared = await prepareOrderCancellationAction({ orderId });
      if (!prepared.ok) throw new Error(prepared.error);

      const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
      if (!provider) throw new Error("No injected EVM wallet was found. Install or enable your consortium signing wallet.");

      setStage("wallet");
      const wallet = createWalletClient({ transport: custom(provider) });
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("No wallet account was selected.");
      const walletChainId = await wallet.getChainId();
      if (walletChainId !== prepared.cancellation.chainId) {
        throw new Error(`Wallet is on chain ${walletChainId}. Switch it to ThreadProof chain ${prepared.cancellation.chainId} before signing.`);
      }

      const signature = await wallet.signTypedData({
        account,
        ...buildCancelOrderTypedData(prepared.cancellation),
      });

      setStage("storing");
      const stored = await submitOrderCancellationSignatureAction({
        jobId: prepared.cancellation.jobId,
        signature,
      });
      if (!stored.ok) throw new Error(stored.error);

      setSigner(stored.signer);
      setStage("signed");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to cancel this order.");
      setStage("idle");
    }
  }

  const busy = stage !== "idle" && stage !== "signed";
  const locked = busy || stage === "signed";
  const buttonLabel = stage === "preparing"
    ? "Checking canonical order…"
    : stage === "wallet"
      ? "Confirm cancellation in wallet…"
      : stage === "storing"
        ? "Validating signer…"
        : stage === "signed"
          ? "Cancellation queued"
          : `Cancel anchored version ${currentVersion}`;

  return (
    <section className="panel form-panel danger-panel">
      <div className="panel-heading">
        <div>
          <span className="kicker">BUYER CANCELLATION</span>
          <h2>Cancel this OrderRegistry order</h2>
        </div>
      </div>
      <p className="muted">
        Cancellation is not a database status change. Your wallet signs a nonce- and version-bound EIP-712 cancellation, the relayer submits it, and this page changes to cancelled only after the OrderCancelled event is indexed from Besu.
      </p>
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
      {stage === "signed" ? (
        <div className="alert alert-success" role="status">
          Cancellation signature validated and queued for relay{signer ? <> from <span className="mono">{signer}</span></> : null}. The order remains active until the chain event confirms it; the timeline is refreshing now.
        </div>
      ) : null}
      <form className="stack-form" onSubmit={cancel} aria-busy={busy || undefined}>
        <label>
          Type <span className="mono">CANCEL</span> to confirm
          <input name="confirmation" autoComplete="off" required disabled={locked} placeholder="CANCEL" />
        </label>
        <div className="callout">
          <strong>Fail-closed cancellation</strong>
          <span>The server verifies the mirrored version, version hash, commitment, policy, buyer mapping and buyer nonce against OrderRegistry before asking your wallet to sign. A concurrent version authorization is blocked at the database transaction boundary.</span>
        </div>
        <div className="form-actions">
          <button className="button danger" type="submit" disabled={locked} aria-busy={busy || undefined}>{buttonLabel}</button>
        </div>
      </form>
    </section>
  );
}