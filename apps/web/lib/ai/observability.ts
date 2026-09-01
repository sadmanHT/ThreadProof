import type { GeminiObservability } from "@/lib/ai/gemini.server";

export type AiRunObservability = {
  version: 1;
  provider: {
    latency_ms: number;
    cached_tokens: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    thought_tokens: number | null;
    tool_use_tokens: number | null;
    total_tokens: number | null;
  };
  evaluation: Record<string, number | boolean | string | null>;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function objectArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(asObject).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function roundRatio(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function average(values: number[]) {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

const orderExtractableFields = [
  "external_reference",
  "title",
  "product_category",
  "quantity",
  "unit",
  "smv_minutes",
  "requested_delivery_date",
  "production_period_start",
  "production_period_end",
  "buyer_name",
  "factory_name",
] as const;

export function deriveAiEvaluationMetrics(output: unknown) {
  const result = asObject(output);
  if (!result) return { output_shape: "non_object" };

  if (Array.isArray(result.field_evidence)) {
    const evidence = objectArray(result.field_evidence);
    const extractableFieldCount = orderExtractableFields.filter((field) => result[field] != null).length;
    const evidencedFields = new Set(
      evidence
        .map((item) => typeof item.field === "string" ? item.field : null)
        .filter((field): field is string => Boolean(field)),
    );
    const confidenceValues = evidence
      .map((item) => typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : null)
      .filter((value): value is number => value != null && value >= 0 && value <= 1);
    const evidencedFieldCount = orderExtractableFields.filter((field) => result[field] != null && evidencedFields.has(field)).length;
    return {
      output_shape: "order_intelligence",
      extractable_field_count: extractableFieldCount,
      evidenced_field_count: evidencedFieldCount,
      field_evidence_count: evidence.length,
      evidence_coverage_ratio: roundRatio(evidencedFieldCount, extractableFieldCount),
      average_evidence_confidence: average(confidenceValues),
      model_risk_flag_count: Array.isArray(result.risk_flags) ? result.risk_flags.length : 0,
      deterministic_check_count: Array.isArray(result.deterministic_checks) ? result.deterministic_checks.length : 0,
      requires_human_review: result.requires_human_review === true,
    };
  }

  if (Array.isArray(result.claims)) {
    const claims = objectArray(result.claims);
    const supports = claims.flatMap((claim) => objectArray(claim.supports));
    const citedIds = new Set(
      supports
        .map((support) => typeof support.evidence_id === "string" ? support.evidence_id : null)
        .filter((id): id is string => Boolean(id)),
    );
    const supportedClaims = claims.filter((claim) => objectArray(claim.supports).length > 0).length;
    const lowConfidenceClaims = claims.filter((claim) => claim.confidence === "low").length;
    return {
      output_shape: "audit_copilot",
      claim_count: claims.length,
      supported_claim_count: supportedClaims,
      supported_claim_ratio: roundRatio(supportedClaims, claims.length),
      support_count: supports.length,
      average_supports_per_claim: roundRatio(supports.length, claims.length),
      unique_evidence_cited_count: citedIds.size,
      evidence_manifest_count: Array.isArray(result.evidence_manifest) ? result.evidence_manifest.length : 0,
      low_confidence_claim_count: lowConfidenceClaims,
      model_risk_flag_count: Array.isArray(result.model_risk_flags) ? result.model_risk_flags.length : 0,
      deterministic_signal_count: Array.isArray(result.deterministic_signals) ? result.deterministic_signals.length : 0,
    };
  }

  return { output_shape: "unknown_object" };
}

export function buildAiRunObservability(provider: GeminiObservability, output: unknown): AiRunObservability {
  return {
    version: 1,
    provider: {
      latency_ms: provider.providerLatencyMs,
      cached_tokens: provider.usage.cachedTokens,
      input_tokens: provider.usage.inputTokens,
      output_tokens: provider.usage.outputTokens,
      thought_tokens: provider.usage.thoughtTokens,
      tool_use_tokens: provider.usage.toolUseTokens,
      total_tokens: provider.usage.totalTokens,
    },
    evaluation: deriveAiEvaluationMetrics(output),
  };
}
