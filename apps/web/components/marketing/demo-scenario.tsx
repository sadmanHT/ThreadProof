"use client";

import { useMemo, useState } from "react";
import { PrivacyLabel } from "./premium-marketing";

type Step = {
  title: string;
  short: string;
  kicker: string;
  body: string;
  rows: readonly (readonly [string, string])[];
  tone?: "success" | "warning" | "neutral";
};

// DEMO MODE ONLY: this centralized scenario is intentionally mock data. It never writes to Supabase or the consortium chain.
const steps: readonly Step[] = [
  { title: "Buyer creates the order", short: "Create order", kicker: "Scenario 01", body: "Buyer North prepares a 30,000-piece order for Factory Alpha. Commercial details are counterparty-confidential until a buyer-signed version is anchored.", rows: [["Order", "TP-24031"], ["Quantity", "30,000 pieces"], ["Production period", "October 2026"], ["Primary factory", "Factory Alpha"]] },
  { title: "Factory proves feasibility", short: "Valid PoFC", kicker: "Scenario 02", body: "Factory Alpha uses its private certified opening to prove that the new workload fits the currently active capacity commitment. Remaining capacity is never disclosed to the buyer.", rows: [["Order commitment", "0x83F…991"], ["Active capacity state", "C₅"], ["Remaining capacity", "Protected by zero-knowledge proof"], ["Proof result", "Verified"]], tone: "success" },
  { title: "Canonical state advances", short: "Advance state", kicker: "Scenario 03", body: "The proof is finalized on the consortium chain. C₅ becomes spent and C₆ becomes the only active state for this factory-period-process key.", rows: [["Previous commitment", "C₅ · spent"], ["New commitment", "C₆ · active"], ["Order status", "Feasible"], ["Finalized block", "#8,421"]], tone: "success" },
  { title: "Old capacity state is reused", short: "Reuse rejected", kicker: "Scenario 04", body: "A competing transition attempts to reuse C₅. The proof may have been generated correctly, but the old state is no longer current, so the transition is rejected.", rows: [["Attempted prior state", "C₅"], ["Current state", "C₆"], ["Result", "Rejected — capacity state already consumed"], ["Private capacity exposed", "No"]], tone: "warning" },
  { title: "A larger order cannot be satisfied", short: "Adjustment", kicker: "Scenario 05", body: "A new order cannot be satisfied under the selected period. The interface does not reveal the factory's remaining capacity; it presents operational next steps instead.", rows: [["Order", "TP-24044"], ["Result", "Requires adjustment"], ["Exact shortage", "Not disclosed"], ["Next actions", "Adjust · Extend period · Subcontract · Decline"]], tone: "warning" },
  { title: "A compliant subcontractor is selected", short: "Authorized path", kicker: "Scenario 06", body: "Factory Beta is proposed. ThreadProof checks the parent authorization, organization status, credential state, authorization depth and Beta's own private capacity proof.", rows: [["Parent", "Factory Alpha"], ["Subcontractor", "Factory Beta"], ["Authorization path", "Buyer → Alpha → Beta"], ["Checks", "Organization · Credentials · Capacity · Depth"]], tone: "success" },
  { title: "An unauthorized factory is rejected", short: "Invalid path", kicker: "Scenario 07", body: "Factory Gamma has no valid parent authorization and one required credential is inactive. The interface explains the reason without exposing unrelated factory data.", rows: [["Proposed factory", "Factory Gamma"], ["Parent authorization", "Missing"], ["Required credential", "Inactive"], ["Result", "Authorization rejected"]], tone: "warning" },
  { title: "Buyer materially amends the order", short: "Amendment", kicker: "Scenario 08", body: "The buyer increases quantity and changes the production window. ThreadProof treats feasibility as a property of the signed order version, so the previous proof cannot silently authorize the amendment.", rows: [["Previous version", "v1 · immutable"], ["New version", "v2 · buyer signed"], ["Material change", "Quantity + production window"], ["Feasibility", "Verification required again"]], tone: "neutral" },
  { title: "Auditor revokes a credential", short: "Credential revoke", kicker: "Scenario 09", body: "An accredited issuer revokes a required credential. Existing history remains attributable, but new authorization attempts that depend on that credential fail.", rows: [["Credential", "Factory Compliance"], ["Issuer", "Independent Auditor"], ["New status", "Revoked"], ["New authorization", "Blocked"]], tone: "warning" },
  { title: "Governance authorizes protected disclosure", short: "Due process", kicker: "Scenario 10", body: "A protected identity remains concealed while independent constituencies approve a parameter-bound proposal. Disclosure becomes executable only after the required threshold and timelock are satisfied.", rows: [["Protected reference", "tp:hidden:7F21"], ["Approvals", "3 / 5 independent constituencies"], ["Timelock", "Satisfied"], ["Result", "Disclosure execution available"]], tone: "success" },
] as const;

export function DemoScenario() {
  const [index, setIndex] = useState(0);
  const step = steps[index] ?? steps[0];
  const progress = useMemo(() => `${String(index + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}`, [index]);

  return <div className="demo-workspace">
    <aside className="demo-steps" aria-label="Demo scenario steps">{steps.map((item, itemIndex) => <button type="button" className={`demo-step-button ${itemIndex === index ? "active" : ""}`} onClick={() => setIndex(itemIndex)} key={item.title} aria-current={itemIndex === index ? "step" : undefined}><i>{String(itemIndex + 1).padStart(2, "0")}</i><span><strong>{item.short}</strong><small>{item.title}</small></span></button>)}</aside>
    <section className="demo-content" aria-live="polite">
      <div><span className="premium-kicker">{step.kicker} · {progress}</span><h2>{step.title}</h2><p>{step.body}</p></div>
      <div className="demo-card"><div style={{marginBottom: 12}}><PrivacyLabel tone={index === 9 ? "protected" : index === 1 || index === 4 ? "private" : "consortium"}>{index === 9 ? "Governance protected" : index === 1 || index === 4 ? "Privacy preserved" : "Demo protocol state"}</PrivacyLabel></div>{step.rows.map(([label, value]) => <div className="demo-card-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="demo-controls"><button className="demo-button" type="button" onClick={() => setIndex((value) => Math.max(0, value - 1))} disabled={index === 0}>Previous</button><button className="demo-button primary" type="button" onClick={() => setIndex((value) => Math.min(steps.length - 1, value + 1))} disabled={index === steps.length - 1}>{index === steps.length - 1 ? "Scenario complete" : "Next scenario"}</button></div>
    </section>
  </div>;
}
