"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getBlockchainStatus } from "@/lib/blockchain";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { analyzeOrderDocument } from "@/lib/ai/order-intelligence.server";
import { answerAuditQuestion } from "@/lib/ai/audit-copilot.server";
import { buildAuditEvidenceBundle } from "@/lib/ai/evidence.server";
import {
  assertAiDataClassAllowed,
  assertOrderDocumentAiAllowed,
  getAiModel,
  getAiThinkingLevel,
} from "@/lib/ai/policy.server";
import {
  assertAiRateLimit,
  completeAiRun,
  failAiRun,
  recordAiFindings,
  sha256,
  startAiRun,
} from "@/lib/ai/audit.server";

function failRedirect(message: string): never {
  redirect(`/app/intelligence?error=${encodeURIComponent(message.slice(0, 500))}`);
}

function selectedMembership(
  viewer: Awaited<ReturnType<typeof requireConsortiumViewer>>,
  organizationId: string,
) {
  return viewer.memberships.find((membership) => membership.organization_id === organizationId && membership.active) ?? null;
}

const organizationSchema = z.string().uuid();

export async function runOrderIntelligenceAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const organizationId = organizationSchema.safeParse(formData.get("organizationId"));
  if (!organizationId.success) failRedirect("Select a valid organization.");
  const membership = selectedMembership(viewer, organizationId.data);
  if (!membership || !hasOperationalRole(membership)) failRedirect("An active operator/admin/signer membership is required.");

  const syntheticDemo = formData.get("syntheticDemo") === "true";
  try {
    assertOrderDocumentAiAllowed(syntheticDemo);
    await assertAiRateLimit(viewer.userId);
  } catch (error) {
    failRedirect(error instanceof Error ? error.message : "AI processing is unavailable.");
  }

  const sourceText = String(formData.get("sourceText") ?? "").trim();
  if (sourceText.length > 30_000) failRedirect("Pasted order text is too large. Keep it under 30,000 characters.");

  const fileValue = formData.get("document");
  const file = fileValue instanceof File && fileValue.size > 0 ? fileValue : null;
  if (!sourceText && !file) failRedirect("Paste order text or attach a PDF.");
  if (file && file.type !== "application/pdf") failRedirect("Only PDF document uploads are supported in this AI workflow.");
  if (file && file.size > 4_500_000) failRedirect("PDF is too large for the web intelligence endpoint. Keep it under 4.5 MB.");

  const purchaseOrderIdRaw = String(formData.get("purchaseOrderId") ?? "").trim();
  const purchaseOrderId = purchaseOrderIdRaw ? z.string().uuid().safeParse(purchaseOrderIdRaw) : null;
  if (purchaseOrderId && !purchaseOrderId.success) failRedirect("Invalid comparison order.");

  const supabase = await createClient();
  let baseline: {
    external_reference: string;
    title: string | null;
    product_category: string | null;
    quantity: number | null;
    unit: string | null;
    requested_delivery_date: string | null;
  } | undefined;

  if (purchaseOrderId?.success) {
    if (syntheticDemo) failRedirect("Do not compare a synthetic/free-tier document against a real stored order. Use a synthetic pasted/PDF input with no stored-order baseline.");
    const { data: order, error } = await supabase
      .from("purchase_orders")
      .select("id,buyer_organization_id,factory_organization_id,external_reference,title,product_category,quantity,unit,requested_delivery_date")
      .eq("id", purchaseOrderId.data)
      .maybeSingle();
    if (error || !order) failRedirect("The selected order is not visible to your session.");
    if (![order.buyer_organization_id, order.factory_organization_id].includes(organizationId.data)) {
      failRedirect("The selected order does not belong to the chosen organization relationship.");
    }
    baseline = {
      external_reference: order.external_reference,
      title: order.title,
      product_category: order.product_category,
      quantity: order.quantity,
      unit: order.unit,
      requested_delivery_date: order.requested_delivery_date,
    };
  }

  const fileBytes = file ? new Uint8Array(await file.arrayBuffer()) : undefined;
  const references = [
    ...(fileBytes ? [sha256(fileBytes)] : []),
    ...(baseline ? [sha256(JSON.stringify(baseline))] : []),
  ];
  const inputHash = sha256(JSON.stringify({
    sourceTextHash: sourceText ? sha256(sourceText) : null,
    fileHash: fileBytes ? sha256(fileBytes) : null,
    baselineHash: baseline ? sha256(JSON.stringify(baseline)) : null,
    syntheticDemo,
  }));
  const promptTemplateHash = sha256("threadproof:gemini:order-intelligence:v2:evidenced-pressure");
  const model = getAiModel();
  const thinkingLevel = getAiThinkingLevel();

  let runId: string | null = null;
  try {
    runId = await startAiRun({
      organizationId: organizationId.data,
      createdBy: viewer.userId,
      taskType: "order_intelligence",
      modelName: model,
      promptTemplateHash,
      inputHash,
      inputReferenceHashes: references,
      subjectType: purchaseOrderId?.success ? "purchase_order" : "document",
      subjectId: purchaseOrderId?.success ? purchaseOrderId.data : null,
      dataClass: "counterparty_confidential",
      metadata: {
        intelligence_version: 2,
        thinking_level: thinkingLevel,
        synthetic_demo: syntheticDemo,
        source_text_present: Boolean(sourceText),
        file_name: file?.name ?? null,
        file_size: file?.size ?? null,
        file_mime_type: file?.type ?? null,
      },
    });

    const analysis = await analyzeOrderDocument({
      ...(sourceText ? { sourceText } : {}),
      ...(fileBytes ? { document: { bytes: fileBytes, mimeType: "application/pdf" as const } } : {}),
      ...(baseline ? { baseline } : {}),
    });

    await completeAiRun({ runId, output: analysis.result, providerResponseId: analysis.id });
    const evidenceRefs = [
      ...references,
      ...analysis.result.field_evidence.map((evidence) => ({
        field: evidence.field,
        source_locator: evidence.source_locator,
        excerpt_hash: sha256(evidence.excerpt),
      })),
    ];
    const findings = [
      ...analysis.result.risk_flags.map((flag) => ({
        severity: flag.severity,
        type: flag.code,
        explanation: flag.explanation,
      })),
      ...analysis.result.deterministic_checks.map((check) => ({
        severity: check.severity,
        type: check.code,
        explanation: check.explanation,
      })),
    ];
    try {
      await recordAiFindings(runId, organizationId.data, findings.map((finding) => ({
        ...finding,
        subjectType: purchaseOrderId?.success ? "purchase_order" : "document",
        subjectId: purchaseOrderId?.success ? purchaseOrderId.data : null,
        evidenceRefs,
      })));
    } catch {
      // The primary input/output audit record is already complete; secondary finding rows are best-effort.
    }
  } catch (error) {
    if (runId) await failAiRun(runId, "ORDER_INTELLIGENCE_FAILED", error instanceof Error ? error.message : "Unknown AI failure");
    failRedirect(error instanceof Error ? error.message : "Order intelligence failed.");
  }

  redirect(`/app/intelligence?run=${runId}&message=${encodeURIComponent("Order intelligence completed. Review the evidence-backed extraction and deterministic pressure signals before using any value in a business workflow.")}`);
}

export async function runAuditCopilotAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const parsed = z.object({
    organizationId: z.string().uuid(),
    question: z.string().trim().min(3).max(2000),
  }).safeParse({
    organizationId: formData.get("organizationId"),
    question: formData.get("question"),
  });
  if (!parsed.success) failRedirect("Choose an organization and enter a concise audit question.");
  const membership = selectedMembership(viewer, parsed.data.organizationId);
  if (!membership) failRedirect("You do not have an active membership in that organization.");

  try {
    assertAiDataClassAllowed("consortium_visible");
    await assertAiRateLimit(viewer.userId);
  } catch (error) {
    failRedirect(error instanceof Error ? error.message : "AI processing is unavailable.");
  }

  const supabase = await createClient();
  const orgId = parsed.data.organizationId;
  const [orders, credentials, proofJobs, events, governance, chainStatus] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id,chain_order_id,buyer_organization_id,factory_organization_id,status,current_version,current_order_commitment,current_policy_hash,updated_at")
      .or(`buyer_organization_id.eq.${orgId},factory_organization_id.eq.${orgId}`)
      .order("updated_at", { ascending: false })
      .limit(25),
    supabase
      .from("credentials")
      .select("id,chain_credential_id,issuer_organization_id,subject_organization_id,credential_type,status,valid_from,valid_until,chain_tx_hash,created_at")
      .or(`issuer_organization_id.eq.${orgId},subject_organization_id.eq.${orgId}`)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("proof_jobs")
      .select("id,factory_organization_id,order_version_id,status,circuit_version,chain_tx_hash,chain_block_number,error_code,created_at,completed_at")
      .eq("factory_organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("chain_events")
      .select("id,event_name,transaction_hash,block_number,contract_address,observed_at")
      .order("block_number", { ascending: false })
      .limit(60),
    supabase
      .from("governance_proposal_read_model")
      .select("chain_proposal_id,proposal_type,state,policy_version,approvals_received,approvals_required,execute_after,executed_tx_hash,last_synced_block,updated_at")
      .order("updated_at", { ascending: false })
      .limit(20),
    getBlockchainStatus(),
  ]);

  const sourceErrors = [orders.error, credentials.error, proofJobs.error, events.error, governance.error]
    .filter(Boolean)
    .map((error) => ({ code: error?.code ?? "QUERY_ERROR" }));
  const bundle = buildAuditEvidenceBundle({
    orders: orders.data ?? [],
    credentials: credentials.data ?? [],
    proof_jobs: proofJobs.data ?? [],
    chain_events: events.data ?? [],
    governance: governance.data ?? [],
    chain_status: chainStatus,
    source_errors: sourceErrors,
  });

  const inputHash = sha256(JSON.stringify({
    question: parsed.data.question,
    evidence: bundle.evidence,
    deterministic_signals: bundle.deterministic_signals,
  }));
  const evidenceHashes = bundle.evidence.slice(0, 80).map((evidence) => sha256(JSON.stringify(evidence)));
  const promptTemplateHash = sha256("threadproof:gemini:audit-copilot:v2:evidence-locked");
  const model = getAiModel();
  const thinkingLevel = getAiThinkingLevel();
  let runId: string | null = null;

  try {
    runId = await startAiRun({
      organizationId: orgId,
      createdBy: viewer.userId,
      taskType: "audit_copilot",
      modelName: model,
      promptTemplateHash,
      inputHash,
      inputReferenceHashes: evidenceHashes,
      dataClass: "consortium_visible",
      metadata: {
        context_version: 2,
        thinking_level: thinkingLevel,
        evidence_count: bundle.evidence.length,
        deterministic_signal_count: bundle.deterministic_signals.length,
        chain_online: chainStatus.online,
      },
    });
    const answer = await answerAuditQuestion({
      question: parsed.data.question,
      organizationName: membership.organization.display_name,
      organizationRole: membership.organization.role,
      evidence: bundle.evidence,
      deterministicSignals: bundle.deterministic_signals,
    });
    const output = {
      ...answer.result,
      deterministic_signals: bundle.deterministic_signals,
      evidence_manifest: bundle.evidence.map((evidence) => ({
        id: evidence.id,
        source: evidence.source,
        reference: evidence.reference,
        observed_at: evidence.observed_at,
      })),
    };
    await completeAiRun({ runId, output, providerResponseId: answer.id });

    try {
      await recordAiFindings(runId, orgId, [
        ...bundle.deterministic_signals.map((signal) => ({
          severity: signal.severity,
          type: `RULE_${signal.code}`,
          explanation: signal.explanation,
          subjectType: "investigation",
          subjectId: null,
          evidenceRefs: signal.evidence_ids,
        })),
        ...answer.result.model_risk_flags.map((flag) => ({
          severity: flag.severity,
          type: `AI_${flag.code}`,
          explanation: flag.explanation,
          subjectType: "investigation",
          subjectId: null,
          evidenceRefs: flag.evidence_ids,
        })),
      ]);
    } catch {
      // The evidence-locked AI run remains auditable even if secondary review rows cannot be created.
    }
  } catch (error) {
    if (runId) await failAiRun(runId, "AUDIT_COPILOT_FAILED", error instanceof Error ? error.message : "Unknown AI failure");
    failRedirect(error instanceof Error ? error.message : "Evidence Investigator failed.");
  }

  redirect(`/app/intelligence?run=${runId}&message=${encodeURIComponent("Evidence Investigator completed. Claims are locked to supplied evidence IDs and verbatim evidence text; critical decisions still require direct contract/proof validation.")}`);
}

export async function reviewAiFindingAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const parsed = z.object({
    findingId: z.string().uuid(),
    organizationId: z.string().uuid(),
    runId: z.string().uuid().optional(),
    status: z.enum(["open", "acknowledged", "dismissed", "resolved"]),
    reviewNote: z.string().trim().max(2000).optional(),
  }).safeParse({
    findingId: formData.get("findingId"),
    organizationId: formData.get("organizationId"),
    runId: String(formData.get("runId") ?? "") || undefined,
    status: formData.get("status"),
    reviewNote: String(formData.get("reviewNote") ?? "") || undefined,
  });
  if (!parsed.success) failRedirect("Invalid AI finding review request.");
  const membership = selectedMembership(viewer, parsed.data.organizationId);
  if (!membership || !hasOperationalRole(membership)) failRedirect("An active operator/admin/signer membership is required to review AI findings.");

  const supabase = await createClient();
  const { error: reviewError } = await supabase.rpc("review_ai_finding", {
    target_finding_id: parsed.data.findingId,
    target_organization_id: parsed.data.organizationId,
    new_status: parsed.data.status,
    new_review_note: parsed.data.reviewNote ?? null,
  });
  if (reviewError) failRedirect("Unable to update the AI finding review state.");

  const query = new URLSearchParams();
  if (parsed.data.runId) query.set("run", parsed.data.runId);
  query.set("message", `AI finding marked ${parsed.data.status}. This review is operational only and does not authorize protocol state.`);
  redirect(`/app/intelligence?${query.toString()}`);
}
