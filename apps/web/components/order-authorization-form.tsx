"use client";

import { useState, type FormEvent } from "react";
import { createWalletClient, custom } from "viem";
import {
  prepareOrderAuthorizationAction,
  submitOrderSignatureAction,
} from "@/app/app/order-authorization-actions";
import { buildOrderTypedData } from "@/lib/order-eip712";

type Props = {
  orderId: string;
  nextVersion: number;
};

type Stage = "idle" | "preparing" | "wallet" | "storing" | "signed";

type InjectedProvider = Parameters<typeof custom>[0];

export function OrderAuthorizationForm({ orderId, nextVersion }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [signer, setSigner] = useState<string | null>(null);

  async function authorize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSigner(null);
    const form = new FormData(event.currentTarget);

    try {
      setStage("preparing");
      const prepared = await prepareOrderAuthorizationAction({
        orderId,
        orderWorkload: String(form.get("orderWorkload") ?? ""),
        policyHash: String(form.get("policyHash") ?? ""),
        productionPeriodStart: String(form.get("productionPeriodStart") ?? ""),
        productionPeriodEnd: String(form.get("productionPeriodEnd") ?? ""),
      });
      if (!prepared.ok) throw new Error(prepared.error);

      const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
      if (!provider) throw new Error("No injected EVM wallet was found. Install or enable your consortium signing wallet.");

      setStage("wallet");
      const wallet = createWalletClient({ transport: custom(provider) });
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("No wallet account was selected.");
      const walletChainId = await wallet.getChainId();
      if (walletChainId !== prepared.authorization.chainId) {
        throw new Error(`Wallet is on chain ${walletChainId}. Switch it to ThreadProof chain ${prepared.authorization.chainId} before signing.`);
      }

      const signature = await wallet.signTypedData({
        account,
        ...buildOrderTypedData(prepared.authorization),
      });

      setStage("storing");
      const stored = await submitOrderSignatureAction({
        jobId: prepared.authorization.jobId,
        signature,
      });
      if (!stored.ok) throw new Error(stored.error);

      setSigner(stored.signer);
      setStage("signed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to authorize this order version.");
      setStage("idle");
    }
  }

  const busy = stage !== "idle" && stage !== "signed";
  const buttonLabel = stage === "preparing"
    ? "Preparing commitment…"
    : stage === "wallet"
      ? "Confirm in wallet…"
      : stage === "storing"
        ? "Validating signer…"
        : stage === "signed"
          ? "Authorization queued"
          : `Sign version ${nextVersion}`;

  return (
    <section className="panel form-panel">
      <div className="panel-heading">
        <div>
          <span className="kicker">BUYER AUTHORIZATION</span>
          <h2>Commit private workload and sign version {nextVersion}</h2>
        </div>
      </div>
      <p className="muted">
        Workload and commitment randomness are encrypted before storage. Your wallet signs only the OrderRegistry EIP-712 authorization; the relayer cannot change its buyer, factory, version, commitment, policy, nonce, or deadline.
      </p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {stage === "signed" ? (
        <div className="alert alert-success">
          Signature validated against the on-chain buyer organization and queued for relay{signer ? <> from <span className="mono">{signer}</span></> : null}.
        </div>
      ) : null}
      <form className="stack-form" onSubmit={authorize}>
        <div className="field-grid two">
          <label>
            Confidential workload
            <input name="orderWorkload" inputMode="numeric" pattern="[0-9]+" required placeholder="e.g. 540000" disabled={busy} />
          </label>
          <label>
            Consortium policy hash
            <input name="policyHash" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={busy} />
          </label>
        </div>
        <div className="field-grid two">
          <label>
            Production period start <span className="optional">optional</span>
            <input name="productionPeriodStart" type="date" disabled={busy} />
          </label>
          <label>
            Production period end <span className="optional">optional</span>
            <input name="productionPeriodEnd" type="date" disabled={busy} />
          </label>
        </div>
        <div className="callout">
          <strong>Fail-closed signing</strong>
          <span>The server reads the current buyer nonce from Besu, verifies any prior mirrored order version against OrderRegistry, and rejects a wallet that is not currently mapped to the buyer organization.</span>
        </div>
        <div className="form-actions">
          <button className="button primary" type="submit" disabled={busy || stage === "signed"}>{buttonLabel}</button>
        </div>
      </form>
    </section>
  );
}
