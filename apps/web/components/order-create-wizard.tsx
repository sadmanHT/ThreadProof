"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { createOrderAction } from "@/app/app/actions";

type OrganizationOption = { id: string; displayName: string; detail?: string };
type Props = { buyers: OrganizationOption[]; factories: OrganizationOption[] };

const steps = [
  ["01", "Counterparties", "Choose the buyer and primary factory."],
  ["02", "Order details", "Describe the commercial commitment."],
  ["03", "Quantity & delivery", "Set the requested production outcome."],
  ["04", "Review", "Confirm the private draft before creation."],
] as const;

type Draft = {
  buyerOrganizationId: string;
  factoryOrganizationId: string;
  externalReference: string;
  title: string;
  productCategory: string;
  quantity: string;
  unit: string;
  requestedDeliveryDate: string;
};

export function OrderCreateWizard({ buyers, factories }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({
    buyerOrganizationId: buyers[0]?.id ?? "",
    factoryOrganizationId: "",
    externalReference: "",
    title: "",
    productCategory: "",
    quantity: "",
    unit: "pieces",
    requestedDeliveryDate: "",
  });

  const buyerName = useMemo(() => buyers.find((item) => item.id === draft.buyerOrganizationId)?.displayName ?? "Buyer", [buyers, draft.buyerOrganizationId]);
  const factoryName = useMemo(() => factories.find((item) => item.id === draft.factoryOrganizationId)?.displayName ?? "Not selected", [factories, draft.factoryOrganizationId]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function validateCurrentStep() {
    const form = formRef.current;
    if (!form) return false;
    const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-order-step="${step}"] input, [data-order-step="${step}"] select`));
    for (const control of controls) {
      if (!control.checkValidity()) {
        control.reportValidity();
        return false;
      }
    }
    return true;
  }

  function next() {
    if (!validateCurrentStep()) return;
    setStep((value) => Math.min(steps.length - 1, value + 1));
  }

  return <div className="order-wizard-shell">
    <aside className="order-wizard-steps" aria-label="Order creation progress">
      <div className="wizard-steps-head"><span className="kicker">CREATE ORDER</span><strong>Private draft</strong><p>Nothing becomes canonical until a later buyer-signed OrderRegistry authorization is finalized.</p></div>
      <ol>{steps.map(([number, title, description], index) => <li className={`${index === step ? "active" : ""} ${index < step ? "complete" : ""}`} key={title} aria-current={index === step ? "step" : undefined}><span>{index < step ? "✓" : number}</span><div><strong>{title}</strong><small>{description}</small></div></li>)}</ol>
      <div className="wizard-trust-note"><span className="privacy-chip private">Private to counterparties</span><p>Draft metadata is application workflow state. Capacity feasibility is evaluated only after a signed version is anchored.</p></div>
    </aside>

    <form ref={formRef} className="order-wizard-form" action={createOrderAction}>
      <div className="wizard-progress-mobile" aria-hidden="true"><span style={{ width: `${((step + 1) / steps.length) * 100}%` }} /></div>
      <div className="wizard-form-head"><span className="kicker">STEP {steps[step]?.[0]}</span><h1>{steps[step]?.[1]}</h1><p>{steps[step]?.[2]}</p></div>

      <section data-order-step="0" className={`wizard-step-panel ${step === 0 ? "visible" : ""}`} aria-hidden={step !== 0}>
        <div className="selection-grid">
          <label className="selection-field"><span>Buyer organization</span><select name="buyerOrganizationId" required value={draft.buyerOrganizationId} onChange={(event) => update("buyerOrganizationId", event.target.value)}>{buyers.map((buyer) => <option key={buyer.id} value={buyer.id}>{buyer.displayName}</option>)}</select><small>The organization whose wallet will later authorize the immutable order version.</small></label>
          <label className="selection-field"><span>Primary factory</span><select name="factoryOrganizationId" required value={draft.factoryOrganizationId} onChange={(event) => update("factoryOrganizationId", event.target.value)}><option value="" disabled>Select an active factory</option>{factories.map((factory) => <option key={factory.id} value={factory.id}>{factory.displayName}{factory.detail ? ` · ${factory.detail}` : ""}</option>)}</select><small>The factory expected to prove feasibility for the production commitment.</small></label>
        </div>
        <div className="relationship-preview"><div><span className="relationship-orb">B</span><strong>{buyerName}</strong><small>Buyer</small></div><i>→</i><div><span className="relationship-orb factory">F</span><strong>{factoryName}</strong><small>Primary factory</small></div></div>
      </section>

      <section data-order-step="1" className={`wizard-step-panel ${step === 1 ? "visible" : ""}`} aria-hidden={step !== 1}>
        <div className="field-grid two"><label>External reference<input name="externalReference" required placeholder="PO-2026-1042" value={draft.externalReference} onChange={(event) => update("externalReference", event.target.value)} /></label><label>Order title<input name="title" required placeholder="30,000 polo shirts" value={draft.title} onChange={(event) => update("title", event.target.value)} /></label></div>
        <label>Product or style category<input name="productCategory" placeholder="Polo shirt" value={draft.productCategory} onChange={(event) => update("productCategory", event.target.value)} /><span className="field-note">Use a concise operational description. Commercial attachments and sensitive specifications belong in permission-scoped workflow storage.</span></label>
        <div className="wizard-context-card"><span className="context-icon">01</span><div><strong>This is still a private draft.</strong><p>Creating it does not claim capacity, authorize production or mutate the consortium chain.</p></div></div>
      </section>

      <section data-order-step="2" className={`wizard-step-panel ${step === 2 ? "visible" : ""}`} aria-hidden={step !== 2}>
        <div className="field-grid two"><label>Quantity<input name="quantity" type="number" min="0.001" step="0.001" required placeholder="30000" value={draft.quantity} onChange={(event) => update("quantity", event.target.value)} /></label><label>Unit<input name="unit" required value={draft.unit} onChange={(event) => update("unit", event.target.value)} /></label></div>
        <label>Requested delivery date<input name="requestedDeliveryDate" type="date" value={draft.requestedDeliveryDate} onChange={(event) => update("requestedDeliveryDate", event.target.value)} /></label>
        <div className="wizard-context-card privacy"><span className="context-icon">ZK</span><div><strong>Feasibility comes later.</strong><p>The signed order version will bind the production-period and workload commitments used by Proof-of-Feasible-Capacity. The buyer never needs access to the factory's remaining capacity.</p></div></div>
      </section>

      <section data-order-step="3" className={`wizard-step-panel ${step === 3 ? "visible" : ""}`} aria-hidden={step !== 3}>
        <div className="review-sheet"><div className="review-title"><span className="kicker">PRIVATE ORDER SUMMARY</span><h2>{draft.title || "Untitled order"}</h2><p>{draft.externalReference || "No external reference"}</p></div><dl className="review-grid"><div><dt>Buyer</dt><dd>{buyerName}</dd></div><div><dt>Primary factory</dt><dd>{factoryName}</dd></div><div><dt>Quantity</dt><dd>{draft.quantity ? `${Number(draft.quantity).toLocaleString()} ${draft.unit}` : "—"}</dd></div><div><dt>Product</dt><dd>{draft.productCategory || "Not specified"}</dd></div><div><dt>Requested delivery</dt><dd>{draft.requestedDeliveryDate || "Not specified"}</dd></div><div><dt>Protocol authority</dt><dd>Not yet anchored</dd></div></dl></div>
        <div className="callout"><strong>What happens after creation?</strong><span>You can refine the private draft. When ready, the buyer prepares and signs an immutable EIP-712 order version. Only the indexed OrderRegistry event changes canonical order authorization.</span></div>
      </section>

      <div className="wizard-actions"><div>{step > 0 ? <button type="button" className="button ghost" onClick={() => setStep((value) => Math.max(0, value - 1))}>Back</button> : <Link className="button ghost" href="/app/orders">Cancel</Link>}</div><div><span className="wizard-step-count">{step + 1} of {steps.length}</span>{step < steps.length - 1 ? <button type="button" className="button primary" onClick={next}>Continue</button> : <button className="button primary">Create private draft</button>}</div></div>
    </form>
  </div>;
}
