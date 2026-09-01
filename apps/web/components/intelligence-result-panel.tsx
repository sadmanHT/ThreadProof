import { reviewAiFindingAction } from "@/app/app/intelligence/actions";
import { formatDate, titleCase } from "@/lib/format";

export type AiRunView = {
  id: string;
  organization_id: string;
  task_type: "order_intelligence" | "audit_copilot";
  model_provider: string;
  model_name: string;
  data_class: string;
  status: string;
  prompt_template_hash: string;
  input_hash: string;
  input_reference_hashes: unknown;
  provider_response_id: string | null;
  metadata: unknown;
  output_json: unknown;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  completed_at: string | null;
};

export type AiFindingView = {
  id: string;
  severity: string;
  finding_type: string;
  explanation: string;
  evidence_refs: unknown;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function objectArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(asObject).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function severityBadge(severity: string) {
  return severity === "high" ? "danger" : severity === "medium" ? "warning" : severity === "low" ? "neutral" : "success";
}

function ReviewableFindings({ run, findings }: { run: AiRunView; findings: AiFindingView[] }) {
  if (!findings.length) return null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <div><span className="kicker">HUMAN REVIEW QUEUE</span><h2>Advisory findings</h2></div>
        <span className="badge neutral">{findings.filter((finding) => finding.status === "open").length} open</span>
      </div>
      <div className="record-list">
        {findings.map((finding) => {
          const evidenceRefs = Array.isArray(finding.evidence_refs) ? finding.evidence_refs : [];
          const reviewNoteId = `review-note-${finding.id}`;
          return (
            <div className="record-row" key={finding.id}>
              <div style={{ flex: 1 }}>
                <strong>{finding.finding_type}</strong>
                <span>{finding.explanation}</span>
                {evidenceRefs.length ? <small className="mono">Evidence: {evidenceRefs.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" · ")}</small> : null}
                {finding.reviewed_at ? <small>Reviewed {formatDate(finding.reviewed_at)}{finding.review_note ? ` · ${finding.review_note}` : ""}</small> : null}
                <form action={reviewAiFindingAction} className="stack-form" style={{ marginTop: 10 }}>
                  <input type="hidden" name="findingId" value={finding.id} />
                  <input type="hidden" name="organizationId" value={run.organization_id} />
                  <input type="hidden" name="runId" value={run.id} />
                  {finding.status === "open" ? (
                    <label htmlFor={reviewNoteId}>
                      Review note <span className="optional">optional</span>
                      <input id={reviewNoteId} name="reviewNote" maxLength={2000} placeholder="Record why this finding was acknowledged, dismissed, or resolved." />
                    </label>
                  ) : null}
                  <div className="button-row">
                    {finding.status === "open" ? (
                      <>
                        <button className="button secondary" name="status" value="acknowledged">Acknowledge</button>
                        <button className="button secondary" name="status" value="dismissed">Dismiss</button>
                        <button className="button primary" name="status" value="resolved">Resolve</button>
                      </>
                    ) : (
                      <button className="button secondary" name="status" value="open">Reopen</button>
                    )}
                  </div>
                </form>
              </div>
              <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                <span className={`badge ${severityBadge(finding.severity)}`}>{titleCase(finding.severity)}</span>
                <span className="badge neutral">{titleCase(finding.status)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="callout"><strong>Review is not authorization</strong><span>Acknowledging, dismissing, or resolving an AI finding records human operational review only. It cannot change OrderRegistry, CredentialRegistry, CapacityVault, SubcontractGovernor, or Charter state.</span></div>
    </section>
  );
}

function ProvenancePanel({ run }: { run: AiRunView }) {
  const metadata = asObject(run.metadata);
  const inputRefs = Array.isArray(run.input_reference_hashes) ? run.input_reference_hashes : [];
  return (
    <section className="panel">
      <div className="panel-heading"><div><span className="kicker">REPRODUCIBILITY</span><h2>AI run provenance</h2></div><span className="badge neutral">{run.model_provider} · {run.model_name}</span></div>
      <div className="detail-grid">
        <div><span>Run ID</span><strong className="mono">{run.id}</strong></div>
        <div><span>Data class</span><strong>{titleCase(run.data_class)}</strong></div>
        <div><span>Thinking level</span><strong>{titleCase(String(metadata?.thinking_level ?? "medium"))}</strong></div>
        <div><span>Evidence/input refs</span><strong>{inputRefs.length}</strong></div>
        <div><span>Created</span><strong>{formatDate(run.created_at)}</strong></div>
        <div><span>Completed</span><strong>{run.completed_at ? formatDate(run.completed_at) : "Not completed"}</strong></div>
      </div>
      <div className="record-list">
        <div className="record-row"><div><strong>Prompt template hash</strong><span className="mono">{run.prompt_template_hash}</span></div></div>
        <div className="record-row"><div><strong>Input manifest hash</strong><span className="mono">{run.input_hash}</span></div></div>
        {run.provider_response_id ? <div className="record-row"><div><strong>Provider response</strong><span className="mono">{run.provider_response_id}</span></div></div> : null}
      </div>
    </section>
  );
}

function AuditResult({ run }: { run: AiRunView }) {
  const output = asObject(run.output_json);
  if (!output) return null;
  const claims = objectArray(output.claims);
  const deterministicSignals = objectArray(output.deterministic_signals);
  const limitations = stringArray(output.limitations);
  const nextChecks = stringArray(output.recommended_next_checks);
  const manifest = objectArray(output.evidence_manifest);

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><span className="kicker">EVIDENCE-LOCKED INVESTIGATOR</span><h2>Protocol investigation brief</h2></div>
        <span className="badge success">{String(output.confidence ?? "unknown")} confidence</span>
      </div>
      <div className="callout"><strong>Evidence-locked answer</strong><span>{String(output.answer ?? "")}</span></div>

      {claims.length ? <div className="record-list">{claims.map((claim, index) => {
        const supports = objectArray(claim.supports);
        return (
          <div className="record-row" key={`${index}-${String(claim.statement ?? "claim")}`}>
            <div style={{ flex: 1 }}>
              <strong>Claim {index + 1} · {titleCase(String(claim.confidence ?? "unknown"))}</strong>
              <span>{String(claim.statement ?? "")}</span>
              {supports.length ? (
                <div className="record-list" style={{ marginTop: 10 }}>
                  {supports.map((support, supportIndex) => (
                    <div className="record-row" key={`${supportIndex}-${String(support.evidence_id ?? "evidence")}`}>
                      <div>
                        <strong>Verbatim support</strong>
                        <span>“{String(support.quote ?? "")}”</span>
                        <small className="mono">{String(support.evidence_id ?? "Unknown evidence")}</small>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <small>No verified support was returned.</small>}
            </div>
          </div>
        );
      })}</div> : <div className="empty-state"><strong>No supported factual claims</strong><span>The supplied evidence was insufficient for a supported conclusion.</span></div>}

      {deterministicSignals.length ? (
        <div className="callout">
          <strong>Deterministic ThreadProof signals</strong>
          <span>{deterministicSignals.map((signal) => `${String(signal.code ?? "SIGNAL")}: ${String(signal.explanation ?? "")}`).join(" · ")}</span>
        </div>
      ) : null}
      {limitations.length ? <div className="callout"><strong>Limitations</strong><span>{limitations.join(" · ")}</span></div> : null}
      {nextChecks.length ? <div className="callout"><strong>Authoritative next checks</strong><span>{nextChecks.join(" · ")}</span></div> : null}
      <div className="callout"><strong>Evidence manifest</strong><span>{manifest.length} sanitized evidence record(s) were available to this run. Every factual claim must cite a supplied evidence ID and quote text that ThreadProof verifies against the corresponding evidence fact before display.</span></div>
    </section>
  );
}

function OrderResult({ run }: { run: AiRunView }) {
  const output = asObject(run.output_json);
  if (!output) return null;
  const evidence = objectArray(output.field_evidence);
  const ambiguities = stringArray(output.ambiguities);
  const changes = objectArray(output.detected_changes);
  const pressureScore = Number(output.production_pressure_score ?? 0);
  const pressureBand = String(output.production_pressure_band ?? "low");

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><span className="kicker">EVIDENCED ORDER INTELLIGENCE</span><h2>Extracted order facts</h2></div>
        <span className={`badge ${pressureBand === "critical" || pressureBand === "high" ? "danger" : pressureBand === "elevated" ? "warning" : "success"}`}>Pressure {pressureScore}/100 · {pressureBand}</span>
      </div>
      <div className="detail-grid">
        <div><span>Document type</span><strong>{titleCase(String(output.document_type ?? "unknown"))}</strong></div>
        <div><span>External reference</span><strong>{String(output.external_reference ?? "Not extracted")}</strong></div>
        <div><span>Quantity</span><strong>{output.quantity == null ? "Not extracted" : `${String(output.quantity)} ${String(output.unit ?? "")}`}</strong></div>
        <div><span>SMV</span><strong>{output.smv_minutes == null ? "Not extracted" : `${String(output.smv_minutes)} min`}</strong></div>
        <div><span>Deterministic workload</span><strong>{output.computed_workload_minutes == null ? "Unavailable" : `${Number(output.computed_workload_minutes).toLocaleString()} min`}</strong></div>
        <div><span>Requested delivery</span><strong>{String(output.requested_delivery_date ?? "Not extracted")}</strong></div>
      </div>
      <div className="callout"><strong>Production-pressure index</strong><span>This 0-100 indicator is calculated by deterministic ThreadProof rules from evidenced amendment conditions such as quantity increases, lead-time compression, missing SMV, and contradictory dates. It is not a capacity verdict and never substitutes for PoFC.</span></div>

      {changes.length ? <div className="record-list">{changes.map((change, index) => <div className="record-row" key={`${index}-${String(change.field ?? "change")}`}><div><strong>{String(change.field ?? "Changed field")}</strong><span>{String(change.previous_value ?? "∅")} → {String(change.new_value ?? "∅")}</span></div><span className="badge neutral">{titleCase(String(change.materiality ?? "unknown"))}</span></div>)}</div> : null}
      {evidence.length ? (
        <div className="record-list">
          {evidence.map((item, index) => (
            <div className="record-row" key={`${index}-${String(item.field ?? "evidence")}`}>
              <div><strong>{String(item.field ?? "Field")} · {String(item.source_locator ?? "source")}</strong><span>“{String(item.excerpt ?? "")}”</span></div>
              <span className="badge neutral">{Math.round(Number(item.confidence ?? 0) * 100)}%</span>
            </div>
          ))}
        </div>
      ) : null}
      {ambiguities.length ? <div className="callout"><strong>Human-resolution queue</strong><span>{ambiguities.join(" · ")}</span></div> : null}
      <div className="callout"><strong>Trust boundary</strong><span>Gemini extracts and cites fields. ThreadProof recomputes workload and pressure rules deterministically. A buyer signature, current credential checks, and PoFC/CapacityVault validation are still required.</span></div>
    </section>
  );
}

export function IntelligenceResultPanel({ run, findings }: { run: AiRunView; findings: AiFindingView[] }) {
  if (!asObject(run.output_json)) {
    return (
      <>
        <section className="panel">
          <div className="panel-heading"><div><span className="kicker">AI RUN</span><h2>{titleCase(run.task_type)}</h2></div><span className="badge neutral">{titleCase(run.status)}</span></div>
          <div className="empty-state"><strong>No completed output</strong><span>{run.error_code ? `${run.error_code}: ${run.error_detail ?? "Run failed."}` : "The run has not produced a result."}</span></div>
        </section>
        <ProvenancePanel run={run} />
      </>
    );
  }

  return (
    <>
      {run.task_type === "audit_copilot" ? <AuditResult run={run} /> : <OrderResult run={run} />}
      <ReviewableFindings run={run} findings={findings} />
      <ProvenancePanel run={run} />
    </>
  );
}
