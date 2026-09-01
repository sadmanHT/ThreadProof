"use client";

import { useState, type FormEvent } from "react";
import { createWalletClient, custom } from "viem";
import {
  prepareSubcontractAuthorizationAction,
  submitSubcontractSignatureAction,
} from "@/app/app/subcontract-actions";
import { buildSubcontractTypedData } from "@/lib/subcontract-eip712";

type ParentOrderOption = {
  id: string;
  reference: string;
  title: string | null;
  chainOrderId: string;
};

type Props = { parentOrders: ParentOrderOption[] };
type Stage = "idle" | "preparing" | "wallet" | "validating" | "signed";
type InjectedProvider = Parameters<typeof custom>[0];

export function SubcontractAuthorizationForm({ parentOrders }: Props) {
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
      const prepared = await prepareSubcontractAuthorizationAction({
        parentOrderId: String(form.get("parentOrderId") ?? ""),
        childOrderChainId: String(form.get("childOrderChainId") ?? ""),
        capacityAllocationChainId: String(form.get("capacityAllocationChainId") ?? ""),
        complianceCredentialChainId: String(form.get("complianceCredentialChainId") ?? ""),
        processCredentialChainId: String(form.get("processCredentialChainId") ?? ""),
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
        throw new Error(`Wallet is on chain ${walletChainId}. Switch to ThreadProof chain ${prepared.authorization.chainId} before signing.`);
      }

      const signature = await wallet.signTypedData({
        account,
        ...buildSubcontractTypedData(prepared.authorization),
      });

      setStage("validating");
      const stored = await submitSubcontractSignatureAction({
        jobId: prepared.authorization.jobId,
        signature,
      });
      if (!stored.ok) throw new Error(stored.error);
      setSigner(stored.signer);
      setStage("signed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to authorize this subcontract relationship.");
      setStage("idle");
    }
  }

  const busy = stage !== "idle" && stage !== "signed";
  const buttonLabel = stage === "preparing"
    ? "Verifying canonical context…"
    : stage === "wallet"
      ? "Confirm in factory wallet…"
      : stage === "validating"
        ? "Simulating authorization…"
        : stage === "signed"
          ? "Subcontract queued"
          : "Prepare & sign subcontract";

  if (!parentOrders.length) {
    return (
      <section className="panel form-panel">
        <div className="panel-heading"><div><span className="kicker">PARENT FACTORY</span><h2>Authorize a subcontract path</h2></div></div>
        <div className="empty-state">
          <strong>No eligible parent orders</strong>
          <span>Your active factory context needs a current buyer-authorized parent order before it can sign a child production relationship.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel form-panel">
      <div className="panel-heading">
        <div><span className="kicker">PARENT FACTORY AUTHORIZATION</span><h2>Bind a child order to this production path</h2></div>
      </div>
      <p className="muted">
        Buyer consent is already embodied in the current parent and child OrderRegistry states. This step adds the parent factory&apos;s EIP-712 consent to the exact child order, subcontractor, current version hashes, policy, scoped credentials, capacity allocation, sequence, nonce, and deadline.
      </p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {stage === "signed" ? <div className="alert alert-success">Canonical preflight and contract simulation passed. The parent-factory signature is queued for relay{signer ? <> from <span className="mono">{signer}</span></> : null}.</div> : null}
      <form className="stack-form" onSubmit={authorize}>
        <label>
          Parent order
          <select name="parentOrderId" required disabled={busy} defaultValue="">
            <option value="" disabled>Select a current order</option>
            {parentOrders.map((order) => <option key={order.id} value={order.id}>{order.reference}{order.title ? ` · ${order.title}` : ""}</option>)}
          </select>
        </label>
        <div className="field-grid two">
          <label>
            Child canonical order ID
            <input name="childOrderChainId" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={busy} />
          </label>
          <label>
            Child capacity allocation ID
            <input name="capacityAllocationChainId" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={busy} />
          </label>
        </div>
        <div className="field-grid two">
          <label>
            Compliance credential ID
            <input name="complianceCredentialChainId" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={busy} />
          </label>
          <label>
            Process credential ID
            <input name="processCredentialChainId" className="mono" required pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" disabled={busy} />
          </label>
        </div>
        <div className="callout">
          <strong>Privacy boundary</strong>
          <span>These are canonical protocol references, not private child-factory commercial data. The server resolves hidden operational rows internally and returns only the exact public authorization tuple that SubcontractGovernor will verify.</span>
        </div>
        <div className="callout">
          <strong>Fail-closed before relay</strong>
          <span>The server re-reads both orders, policy, credentials, allocation, parent-factory nonce and prior child authorization from Besu. After wallet signing it simulates authorizeSubcontract; any stale dependency, depth/cycle violation or revoked authorization blocks queueing.</span>
        </div>
        <div className="form-actions"><button className="button primary" type="submit" disabled={busy || stage === "signed"}>{buttonLabel}</button></div>
      </form>
    </section>
  );
}
