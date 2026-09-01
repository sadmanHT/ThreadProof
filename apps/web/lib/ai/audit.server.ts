import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service.server";
import { getAiProviderTier } from "@/lib/ai/policy.server";
import { consumeGeminiObservability } from "@/lib/ai/gemini.server";
import { buildAiRunObservability } from "@/lib/ai/observability";

export function sha256(value: string | Uint8Array) {
  const hash = createHash("sha256");
  hash.update(value);
  return `sha256:${hash.digest("hex")}`;
}

export async function assertAiRateLimit(userId: string) {
  const service = createServiceClient();
  const configured = Number.parseInt(process.env.THREADPROOF_AI_MAX_RUNS_PER_MINUTE ?? "5", 10);
  const limit = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 30) : 5;
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await service
    .from("ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("created_by", userId)
    .gte("created_at", since);

  if (error) throw new Error("Unable to verify AI request rate limit.");
  if ((count ?? 0) >= limit) throw new Error("AI request rate limit reached. Try again in about a minute.");
}

export async function startAiRun(input: {
  organizationId: string;
  createdBy: string;
  taskType: "order_intelligence" | "audit_copilot";
  modelName: string;
  promptTemplateHash: string;
  inputHash: string;
  inputReferenceHashes?: string[];
  subjectType?: string | null;
  subjectId?: string | null;
  dataClass: "consortium_visible" | "counterparty_confidential";
  metadata?: Record<string, unknown>;
}) {
  const service = createServiceClient();
  const { data, error } = await service
    .from("ai_runs")
    .insert({
      organization_id: input.organizationId,
      created_by: input.createdBy,
      task_type: input.taskType,
      model_provider: "gemini",
      model_name: input.modelName,
      prompt_template_hash: input.promptTemplateHash,
      input_hash: input.inputHash,
      input_reference_hashes: input.inputReferenceHashes ?? [],
      subject_type: input.subjectType ?? null,
      subject_id: input.subjectId ?? null,
      data_class: input.dataClass,
      metadata: {
        provider_tier: getAiProviderTier(),
        ...(input.metadata ?? {}),
      },
    })
    .select("id")
    .single();

  if (error || !data?.id) throw new Error("Unable to create AI audit record.");
  return data.id as string;
}

function outputWithObservability(output: unknown, providerResponseId: string | null) {
  const provider = consumeGeminiObservability(providerResponseId);
  if (!provider) return output;
  const base = output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : { result: output };
  return {
    ...base,
    ai_observability: buildAiRunObservability(provider, output),
  };
}

export async function completeAiRun(input: {
  runId: string;
  output: unknown;
  providerResponseId: string | null;
}) {
  const service = createServiceClient();
  const { data, error } = await service
    .from("ai_runs")
    .update({
      status: "completed",
      output_json: outputWithObservability(input.output, input.providerResponseId),
      provider_response_id: input.providerResponseId,
      completed_at: new Date().toISOString(),
      error_code: null,
      error_detail: null,
    })
    .eq("id", input.runId)
    .eq("status", "running")
    .select("id")
    .maybeSingle();
  if (error || !data?.id) {
    throw new Error("AI completed but its running audit record could not be finalized exactly once.");
  }
}

export async function failAiRun(runId: string, code: string, detail: string) {
  const service = createServiceClient();
  await service
    .from("ai_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_code: code.slice(0, 120),
      error_detail: detail.slice(0, 1000),
    })
    .eq("id", runId)
    .eq("status", "running");
}

export async function recordAiFindings(
  runId: string,
  organizationId: string,
  findings: Array<{
    severity: "info" | "low" | "medium" | "high";
    type: string;
    explanation: string;
    subjectType?: string | null;
    subjectId?: string | null;
    evidenceRefs?: unknown[];
  }>,
) {
  if (!findings.length) return;
  const service = createServiceClient();
  const { error } = await service.from("ai_findings").insert(
    findings.slice(0, 20).map((finding) => ({
      ai_run_id: runId,
      organization_id: organizationId,
      subject_type: finding.subjectType ?? null,
      subject_id: finding.subjectId ?? null,
      severity: finding.severity,
      finding_type: finding.type.slice(0, 128),
      explanation: finding.explanation.slice(0, 4000),
      evidence_refs: finding.evidenceRefs ?? [],
    })),
  );
  if (error) throw new Error("AI run completed but findings could not be recorded.");
}
