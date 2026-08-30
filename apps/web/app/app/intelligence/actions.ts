"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { analyzeOrderDocument } from "@/lib/ai/order-intelligence.server";
import { answerAuditQuestion } from "@/lib/ai/audit-copilot.server";
import { assertAiDataClassAllowed, getAiModel } from "@/lib/ai/policy.server";
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

  try {
    assertAiDataClassAllowed("counterparty_confidential");
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
  }));
  const promptTemplateHash = sha256("threadproof:gemini:order-intelligence:v1");
  const model = getAiModel();

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
        evidenceRefs: references,
      })));
    } catch {
      // The primary input/output audit record is already complete; secondary finding rows are best-effort.
    }
  } catch (error) {
    if (runId) await failAiRun(runId, "ORDER_INTELLIGENCE_FAILED", error instanceof Error ? error.message : "Unknown AI failure");
    failRedirect(error instanceof Error ? error.message : "Order intelligence failed.");
  }

  revalidatePath("/app/intelligence");
  redirect(`/app/intelligence?run=${runId}&message=${encodeURIComponent("Order intelligence completed. Review all extracted values before using them in a business workflow.")}`);
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
  const [orders, credentials, proofJobs, events, governance] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id,chain_order_id,buyer_organization_id,factory_organization_id,status,current_version,current_order_commitment,current_policy_hash,updated_at")
      .or(`buyer_organization_id.eq.${orgId},factory_organization_id.eq.${orgId}`)
      .order("updated_at", { ascending: false })
      .limit(25),
    supabase
      .from("credentials")
      .select("id,chain_credential_id,issuer_organization_id,subject_organization_id,credential_type,digest,scope_hash,status,valid_from,valid_until,chain_tx_hash,created_at")
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
      .select("id,event_name,transaction_hash,block_number,contract_address,indexed_values,data,observed_at")
      .order("block_number", { ascending: false })
      .limit(40),
    supabase
      .from("governance_proposal_read_model")
      .select("chain_proposal_id,proposal_type,state,policy_version,approvals_received,approvals_required,execute_after,executed_tx_hash,last_synced_block,updated_at")
      .order("updated_at", { ascending: false })
      .limit(20),
  ]);

  const context = {
    orders: orders.data ?? [],
    credentials: credentials.data ?? [],
    proof_jobs: proofJobs.data ?? [],
    chain_events: events.data ?? [],
    governance: governance.data ?? [],
    source_errors: [orders.error, credentials.error, proofJobs.error, events.error, governance.error]
      .filter(Boolean)
      .map((error) => ({ code: error?.code ?? "QUERY_ERROR" })),
  };
  const inputHash = sha256(JSON.stringify({ question: parsed.data.question, context }));
  const promptTemplateHash = sha256("threadproof:gemini:audit-copilot:v1");
  const model = getAiModel();
  let runId: string | null = null;

  try {
    runId = await startAiRun({
      organizationId: orgId,
      createdBy: viewer.userId,
      taskType: "audit_copilot",
      modelName: model,
      promptTemplateHash,
      inputHash,
      dataClass: "consortium_visible",
      metadata: { context_version: 1 },
    });
    const answer = await answerAuditQuestion({
      question: parsed.data.question,
      organizationName: membership.organization.display_name,
      organizationRole: membership.organization.role,
      context,
    });
    await completeAiRun({ runId, output: answer.result, providerResponseId: answer.id });
  } catch (error) {
    if (runId) await failAiRun(runId, "AUDIT_COPILOT_FAILED", error instanceof Error ? error.message : "Unknown AI failure");
    failRedirect(error instanceof Error ? error.message : "Audit Copilot failed.");
  }

  revalidatePath("/app/intelligence");
  redirect(`/app/intelligence?run=${runId}&message=${encodeURIComponent("Audit Copilot completed. Its answer is advisory; critical protocol decisions still require direct contract/proof validation.")}`);
}
