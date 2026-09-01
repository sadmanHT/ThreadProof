import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { confidentialAiEnabled, getAiModel, getAiProviderTier, getAiThinkingLevel } from "@/lib/ai/policy.server";
import { formatDate, titleCase } from "@/lib/format";
import { runAuditCopilotAction, runOrderIntelligenceAction } from "@/app/app/intelligence/actions";
import {
  IntelligenceResultPanel,
  type AiFindingView,
  type AiRunView,
} from "@/components/intelligence-result-panel";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export const dynamic = "force-dynamic";

type RecentAiRun = Pick<AiRunView,
  "id" | "organization_id" | "task_type" | "model_provider" | "model_name" | "data_class" | "status" | "created_at" | "completed_at"
>;

export default async function IntelligencePage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const params = await searchParams;
  const runId = typeof params.run === "string" ? params.run : null;
  const message = typeof params.message === "string" ? params.message : null;
  const error = typeof params.error === "string" ? params.error : null;
  const confidentialEnabled = confidentialAiEnabled();
  const model = getAiModel();
  const thinkingLevel = getAiThinkingLevel();
  const providerTier = getAiProviderTier();
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const supabase = await createClient();
  const aiSupabase = supabase as any;

  const [{ data: orders }, { data: recentRuns }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id,external_reference,title,buyer_organization_id,factory_organization_id,status,updated_at")
      .order("updated_at", { ascending: false })
      .limit(50),
    aiSupabase
      .from("ai_runs")
      .select("id,organization_id,task_type,model_provider,model_name,data_class,status,created_at,completed_at")
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  let selectedRun: AiRunView | null = null;
  let findings: AiFindingView[] = [];
  if (runId) {
    const [{ data: run }, { data: findingRows }] = await Promise.all([
      aiSupabase
        .from("ai_runs")
        .select("id,organization_id,task_type,model_provider,model_name,data_class,status,prompt_template_hash,input_hash,input_reference_hashes,provider_response_id,metadata,output_json,error_code,error_detail,created_at,completed_at")
        .eq("id", runId)
        .maybeSingle(),
      aiSupabase
        .from("ai_findings")
        .select("id,severity,finding_type,explanation,evidence_refs,status,reviewed_by,reviewed_at,review_note,created_at")
        .eq("ai_run_id", runId)
        .order("created_at", { ascending: true }),
    ]);
    selectedRun = (run ?? null) as AiRunView | null;
    findings = (findingRows ?? []) as AiFindingView[];
  }

  return (
    <div className="workspace-page">
      <header className="page-header">
        <div>
          <span className="kicker">THREADPROOF INTELLIGENCE</span>
          <h1>Evidence-grounded AI. Protocol-enforced truth.</h1>
          <p>Gemini extracts, investigates, and explains. Deterministic rules score operational pressure. Humans review findings. Besu, signatures, credentials, PoFC, and Charter execution remain authoritative.</p>
        </div>
        <div className={`chain-pill ${geminiConfigured ? "online" : "offline"}`}>
          <span />
          {geminiConfigured ? `${model} · ${thinkingLevel} reasoning` : "Gemini key not configured"}
        </div>
      </header>

      {message ? <div className="alert alert-success">{message}</div> : null}
      {error ? <div className="alert alert-error">{error}</div> : null}
      {!geminiConfigured ? <div className="alert alert-error">Set <span className="mono">GEMINI_API_KEY</span> in the server/deployment secret environment to enable ThreadProof Intelligence. Never expose the key through a <span className="mono">NEXT_PUBLIC_</span> variable.</div> : null}

      <section className="protocol-banner">
        <div><span className="kicker">PRIVACY MODE</span><h2>{providerTier === "free" ? "Free-tier guard enabled" : titleCase(providerTier)}</h2></div>
        <p>{confidentialEnabled ? "Approved counterparty-confidential processing is enabled for this deployment." : "Real counterparty-confidential documents are blocked in free-tier mode. Synthetic competition/demo documents are allowed only after explicit confirmation. Evidence Investigator receives minimized consortium-visible metadata; private capacity openings, proof witnesses, encryption secrets, and protected supplier identities never go to Gemini."}</p>
      </section>

      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-heading">
            <div><span className="kicker">DOCUMENT INTELLIGENCE</span><h2>Evidenced order / amendment extraction</h2></div>
            <span className={`badge ${confidentialEnabled ? "success" : "warning"}`}>{confidentialEnabled ? "Confidential mode approved" : "Synthetic demo only"}</span>
          </div>
          <form className="stack-form" action={runOrderIntelligenceAction}>
            <label>Organization<select name="organizationId" required>{viewer.memberships.map((membership) => <option key={membership.organization_id} value={membership.organization_id}>{membership.organization.display_name} · {titleCase(membership.organization.role)}</option>)}</select></label>
            <label>Compare against an existing visible order <span className="optional">approved confidential mode only</span><select name="purchaseOrderId" defaultValue=""><option value="">No comparison baseline</option>{(orders ?? []).map((order) => <option key={order.id} value={order.id}>{order.external_reference}{order.title ? ` · ${order.title}` : ""} · {titleCase(order.status)}</option>)}</select></label>
            <label>Paste PO/amendment text <span className="optional">optional if PDF attached</span><textarea name="sourceText" rows={9} placeholder="Paste purchase-order or amendment text. Instructions embedded in documents are treated as untrusted content." /></label>
            <label>PDF document <span className="optional">max 4.5 MB</span><input name="document" type="file" accept="application/pdf,.pdf" /></label>
            {!confidentialEnabled ? <label><span>Free-tier data confirmation</span><span className="form-help"><input name="syntheticDemo" type="checkbox" value="true" required style={{ width: "auto" }} /> I confirm that this input is synthetic/demo data and contains no real confidential commercial information.</span></label> : null}
            <div className="callout"><strong>What makes this different</strong><span>Every extracted field must carry source evidence. Pasted-text excerpts are checked against the actual input. ThreadProof then computes workload and a transparent production-pressure index outside the model.</span></div>
            <button className="button primary" disabled={!geminiConfigured}>Analyze with Gemini</button>
          </form>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div><span className="kicker">EVIDENCE INVESTIGATOR</span><h2>Ask the protocol what needs attention</h2></div>
            <span className="badge success">Evidence locked</span>
          </div>
          <form className="stack-form" action={runAuditCopilotAction}>
            <label>Organization<select name="organizationId" required>{viewer.memberships.map((membership) => <option key={membership.organization_id} value={membership.organization_id}>{membership.organization.display_name} · {titleCase(membership.organization.role)}</option>)}</select></label>
            <label>Investigation question<textarea name="question" required rows={8} maxLength={2000} placeholder="What currently needs human attention before the next authorization? Why did a recent proof workflow fail? Which visible credentials require direct registry re-checking?" /></label>
            <div className="callout"><strong>No free-form citations</strong><span>ThreadProof builds a minimized evidence manifest first. Gemini must cite exact evidence IDs from that manifest; invented IDs are rejected server-side. Direct RPC health and deterministic rule signals remain distinguishable from read-model observations.</span></div>
            <button className="button primary" disabled={!geminiConfigured}>Run Evidence Investigator</button>
          </form>
        </article>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="kicker">AI SAFETY ARCHITECTURE</span><h2>Four layers, four different authorities</h2></div><span className="badge neutral">Non-authoritative by design</span></div>
        <div className="detail-grid">
          <div><span>1 · Gemini</span><strong>Extract + explain</strong><small>Multimodal document understanding and evidence-grounded synthesis.</small></div>
          <div><span>2 · ThreadProof rules</span><strong>Compute + flag</strong><small>Workload, production-pressure indicators, expiry/failure signals, citation validation.</small></div>
          <div><span>3 · Human reviewer</span><strong>Acknowledge + investigate</strong><small>Review state and rationale are attributable operational evidence.</small></div>
          <div><span>4 · Protocol</span><strong>Authorize + finalize</strong><small>EIP-712, registries, PoFC/CapacityVault, SubcontractGovernor, and Charter remain decisive.</small></div>
        </div>
      </section>

      {selectedRun ? <IntelligenceResultPanel run={selectedRun} findings={findings} /> : null}

      <section className="panel">
        <div className="panel-heading"><div><span className="kicker">AUDIT TRAIL</span><h2>Recent AI runs</h2></div><span className="footnote">Outputs and review states are advisory records, never canonical protocol state.</span></div>
        {(recentRuns ?? []).length ? <div className="record-list">{(recentRuns as RecentAiRun[]).map((run) => <a className="record-row" href={`/app/intelligence?run=${run.id}`} key={run.id}><div><strong>{run.task_type === "audit_copilot" ? "Evidence Investigator" : "Order Intelligence"}</strong><span>{run.model_provider} · {run.model_name} · {formatDate(run.created_at)} · {titleCase(run.data_class)}</span></div><span className={`badge ${run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "neutral"}`}>{titleCase(run.status)}</span></a>)}</div> : <div className="empty-state"><strong>No AI runs yet</strong><span>Run the Evidence Investigator or analyze a synthetic/approved order document to create the first organization-scoped intelligence record.</span></div>}
      </section>
    </div>
  );
}
