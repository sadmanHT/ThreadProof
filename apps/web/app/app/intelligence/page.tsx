import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { confidentialAiEnabled, getAiModel, getAiProviderTier } from "@/lib/ai/policy.server";
import { formatDate, titleCase } from "@/lib/format";
import { runAuditCopilotAction, runOrderIntelligenceAction } from "@/app/app/intelligence/actions";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export const dynamic = "force-dynamic";

type AiRun = {
  id: string;
  organization_id: string;
  task_type: "order_intelligence" | "audit_copilot";
  model_provider: string;
  model_name: string;
  data_class: string;
  status: string;
  output_json: unknown;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  completed_at: string | null;
};

type AiFinding = {
  id: string;
  severity: string;
  finding_type: string;
  explanation: string;
  created_at: string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function ResultPanel({ run, findings }: { run: AiRun; findings: AiFinding[] }) {
  const output = asObject(run.output_json);
  if (!output) {
    return (
      <section className="panel">
        <div className="panel-heading"><div><span className="kicker">AI RUN</span><h2>{titleCase(run.task_type)}</h2></div><span className="badge neutral">{titleCase(run.status)}</span></div>
        <div className="empty-state"><strong>No completed output</strong><span>{run.error_code ? `${run.error_code}: ${run.error_detail ?? "Run failed."}` : "The run has not produced a result."}</span></div>
      </section>
    );
  }

  if (run.task_type === "audit_copilot") {
    const evidence = Array.isArray(output.evidence) ? output.evidence : [];
    return (
      <section className="panel">
        <div className="panel-heading"><div><span className="kicker">READ-ONLY COPILOT</span><h2>Audit answer</h2></div><span className="badge neutral">{String(output.confidence ?? "unknown")} confidence</span></div>
        <div className="callout"><strong>Advisory explanation</strong><span>{String(output.answer ?? "")}</span></div>
        {evidence.length ? <div className="record-list">{evidence.map((item, index) => {
          const evidenceItem = asObject(item);
          return <div className="record-row" key={`${index}-${String(evidenceItem?.reference ?? "evidence")}`}><div><strong>{String(evidenceItem?.source ?? "Evidence")}: {String(evidenceItem?.reference ?? "")}</strong><span>{String(evidenceItem?.fact ?? "")}</span></div></div>;
        })}</div> : null}
        {stringArray(output.limitations).length ? <div className="callout"><strong>Limitations</strong><span>{stringArray(output.limitations).join(" · ")}</span></div> : null}
        {stringArray(output.recommended_next_checks).length ? <div className="callout"><strong>Recommended checks</strong><span>{stringArray(output.recommended_next_checks).join(" · ")}</span></div> : null}
      </section>
    );
  }

  const deterministic = Array.isArray(output.deterministic_checks) ? output.deterministic_checks : [];
  return (
    <section className="panel">
      <div className="panel-heading"><div><span className="kicker">ORDER INTELLIGENCE</span><h2>Extracted order facts</h2></div><span className="badge neutral">{Math.round(Number(output.confidence ?? 0) * 100)}% model confidence</span></div>
      <div className="detail-grid">
        <div><span>Document type</span><strong>{titleCase(String(output.document_type ?? "unknown"))}</strong></div>
        <div><span>External reference</span><strong>{String(output.external_reference ?? "Not extracted")}</strong></div>
        <div><span>Quantity</span><strong>{output.quantity == null ? "Not extracted" : `${String(output.quantity)} ${String(output.unit ?? "")}`}</strong></div>
        <div><span>SMV</span><strong>{output.smv_minutes == null ? "Not extracted" : `${String(output.smv_minutes)} min`}</strong></div>
        <div><span>Deterministic workload</span><strong>{output.computed_workload_minutes == null ? "Unavailable" : `${Number(output.computed_workload_minutes).toLocaleString()} min`}</strong></div>
        <div><span>Requested delivery</span><strong>{String(output.requested_delivery_date ?? "Not extracted")}</strong></div>
      </div>
      <div className="callout"><strong>Trust boundary</strong><span>Gemini extracted fields; ThreadProof recomputed workload deterministically. This result does not authorize the order and does not prove capacity. A buyer signature and PoFC/CapacityVault validation are still required.</span></div>
      {findings.length ? <div className="record-list">{findings.map((finding) => <div className="record-row" key={finding.id}><div><strong>{finding.finding_type}</strong><span>{finding.explanation}</span></div><span className={`badge ${finding.severity === "high" ? "danger" : finding.severity === "medium" ? "warning" : "neutral"}`}>{titleCase(finding.severity)}</span></div>)}</div> : null}
      {!findings.length && deterministic.length ? <div className="record-list">{deterministic.map((item, index) => {
        const check = asObject(item);
        return <div className="record-row" key={`${index}-${String(check?.code ?? "check")}`}><div><strong>{String(check?.code ?? "Check")}</strong><span>{String(check?.explanation ?? "")}</span></div></div>;
      })}</div> : null}
    </section>
  );
}

export default async function IntelligencePage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const params = await searchParams;
  const runId = typeof params.run === "string" ? params.run : null;
  const message = typeof params.message === "string" ? params.message : null;
  const error = typeof params.error === "string" ? params.error : null;
  const confidentialEnabled = confidentialAiEnabled();
  const model = getAiModel();
  const providerTier = getAiProviderTier();
  const supabase = await createClient();
  const aiSupabase = supabase as any;

  const [{ data: orders }, { data: recentRuns }] = await Promise.all([
    supabase.from("purchase_orders").select("id,external_reference,title,buyer_organization_id,factory_organization_id,status,updated_at").order("updated_at", { ascending: false }).limit(50),
    aiSupabase.from("ai_runs").select("id,organization_id,task_type,model_provider,model_name,data_class,status,output_json,error_code,error_detail,created_at,completed_at").order("created_at", { ascending: false }).limit(12),
  ]);

  let selectedRun: AiRun | null = null;
  let findings: AiFinding[] = [];
  if (runId) {
    const [{ data: run }, { data: findingRows }] = await Promise.all([
      aiSupabase.from("ai_runs").select("id,organization_id,task_type,model_provider,model_name,data_class,status,output_json,error_code,error_detail,created_at,completed_at").eq("id", runId).maybeSingle(),
      aiSupabase.from("ai_findings").select("id,severity,finding_type,explanation,created_at").eq("ai_run_id", runId).order("created_at", { ascending: true }),
    ]);
    selectedRun = (run ?? null) as AiRun | null;
    findings = (findingRows ?? []) as AiFinding[];
  }

  return (
    <div className="workspace-page">
      <header className="page-header"><div><span className="kicker">THREADPROOF INTELLIGENCE</span><h1>AI that cannot override the protocol</h1><p>Gemini extracts and explains. Besu, signatures, credentials, PoFC and governance remain authoritative.</p></div><div className="chain-pill online"><span />Gemini · {model}</div></header>
      {message ? <div className="alert alert-success">{message}</div> : null}
      {error ? <div className="alert alert-error">{error}</div> : null}

      <section className="protocol-banner"><div><span className="kicker">PRIVACY MODE</span><h2>{providerTier === "free" ? "Free-tier guard enabled" : titleCase(providerTier)}</h2></div><p>{confidentialEnabled ? "Counterparty-confidential processing has been explicitly enabled. Use this only with synthetic demo material or a provider tier approved for confidential commercial data." : "Counterparty-confidential documents are blocked. Audit Copilot uses only sanitized consortium-visible read-model fields; ZK-private and governance-protected data are never sent to the model."}</p></section>

      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-heading"><div><span className="kicker">DOCUMENT INTELLIGENCE</span><h2>Order / amendment extraction</h2></div><span className={`badge ${confidentialEnabled ? "success" : "warning"}`}>{confidentialEnabled ? "Enabled" : "Confidential mode off"}</span></div>
          <form className="stack-form" action={runOrderIntelligenceAction}>
            <label>Organization<select name="organizationId" required>{viewer.memberships.map((membership) => <option key={membership.organization_id} value={membership.organization_id}>{membership.organization.display_name} · {titleCase(membership.organization.role)}</option>)}</select></label>
            <label>Compare against an existing visible order <span className="optional">optional</span><select name="purchaseOrderId" defaultValue=""><option value="">No comparison baseline</option>{(orders ?? []).map((order) => <option key={order.id} value={order.id}>{order.external_reference}{order.title ? ` · ${order.title}` : ""} · {titleCase(order.status)}</option>)}</select></label>
            <label>Paste PO/amendment text <span className="optional">optional if PDF attached</span><textarea name="sourceText" rows={9} placeholder="Paste purchase-order or amendment text. Instructions embedded in documents are treated as untrusted content." /></label>
            <label>PDF document <span className="optional">max 4.5 MB</span><input name="document" type="file" accept="application/pdf,.pdf" /></label>
            <div className="callout"><strong>Human review is mandatory</strong><span>Extracted quantity, dates, SMV and amendments are suggestions. The application recomputes workload; it never accepts an AI feasibility judgment.</span></div>
            <button className="button primary" disabled={!confidentialEnabled}>Analyze document with Gemini</button>
          </form>
        </article>

        <article className="panel">
          <div className="panel-heading"><div><span className="kicker">READ-ONLY CONTEXT</span><h2>Protocol Audit Copilot</h2></div><span className="badge success">Free-tier safe context</span></div>
          <form className="stack-form" action={runAuditCopilotAction}>
            <label>Organization<select name="organizationId" required>{viewer.memberships.map((membership) => <option key={membership.organization_id} value={membership.organization_id}>{membership.organization.display_name} · {titleCase(membership.organization.role)}</option>)}</select></label>
            <label>Ask about visible protocol state<textarea name="question" required rows={8} maxLength={2000} placeholder="Why was the latest capacity transaction rejected? Which credentials appear revoked? What should I verify directly on-chain before approving this workflow?" /></label>
            <div className="callout"><strong>Sanitized context only</strong><span>The copilot receives recent chain events, credential metadata/status, canonical-order references, proof-job status metadata and governance read models. It never receives private capacity openings, ZK witnesses, encrypted supplier identities or full confidential order payloads.</span></div>
            <button className="button primary">Ask Audit Copilot</button>
          </form>
        </article>
      </section>

      {selectedRun ? <ResultPanel run={selectedRun} findings={findings} /> : null}

      <section className="panel">
        <div className="panel-heading"><div><span className="kicker">AUDIT TRAIL</span><h2>Recent AI runs</h2></div><span className="footnote">Outputs are advisory records, never canonical protocol state.</span></div>
        {(recentRuns ?? []).length ? <div className="record-list">{(recentRuns ?? []).map((run: AiRun) => <a className="record-row" href={`/app/intelligence?run=${run.id}`} key={run.id}><div><strong>{titleCase(run.task_type)}</strong><span>{run.model_provider} · {run.model_name} · {formatDate(run.created_at)} · {titleCase(run.data_class)}</span></div><span className={`badge ${run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "neutral"}`}>{titleCase(run.status)}</span></a>)}</div> : <div className="empty-state"><strong>No AI runs yet</strong><span>Ask the Audit Copilot or analyze a synthetic/approved order document to create the first organization-scoped intelligence record.</span></div>}
      </section>
    </div>
  );
}
