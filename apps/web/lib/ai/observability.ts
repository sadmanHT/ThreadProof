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

function roundRatio(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function baseProvider(provider: GeminiObservability): AiRunObservability["provider"] {
  return {
    latency_ms: provider.providerLatencyMs,
    cached_tokens: provider.usage.cachedTokens,
    input_tokens: provider.usage.inputTokens,
    output_tokens: provider.usage.outputTokens,
    thought_tokens: provider.usage.thoughtTokens,
    tool_use_tokens: provider.usage.toolUseTokens,
    total_tokens: provider.usage.totalTokens,
  };
}

export function buildOrderAiObservability(input: {
  provider: GeminiObservability;
  extractableFieldCount: number;
  evidencedFieldCount: number;
  fieldEvidenceCount: number;
  averageEvidenceConfidence: number | null;
  modelRiskFlagCount: number;
  deterministicCheckCount: number;
  requiresHumanReview: boolean;
}) : AiRunObservability {
  return {
    version: 1,
    provider: baseProvider(input.provider),
    evaluation: {
      extractable_field_count: input.extractableFieldCount,
      evidenced_field_count: input.evidencedFieldCount,
      field_evidence_count: input.fieldEvidenceCount,
      evidence_coverage_ratio: roundRatio(input.evidencedFieldCount, input.extractableFieldCount),
      average_evidence_confidence: input.averageEvidenceConfidence,
      model_risk_flag_count: input.modelRiskFlagCount,
      deterministic_check_count: input.deterministicCheckCount,
      requires_human_review: input.requiresHumanReview,
    },
  };
}

export function buildAuditAiObservability(input: {
  provider: GeminiObservability;
  claimCount: number;
  supportCount: number;
  uniqueEvidenceCitedCount: number;
  evidenceManifestCount: number;
  lowConfidenceClaimCount: number;
  modelRiskFlagCount: number;
  deterministicSignalCount: number;
}) : AiRunObservability {
  return {
    version: 1,
    provider: baseProvider(input.provider),
    evaluation: {
      claim_count: input.claimCount,
      support_count: input.supportCount,
      supported_claim_ratio: input.claimCount === 0 ? null : roundRatio(input.claimCount, input.claimCount),
      average_supports_per_claim: roundRatio(input.supportCount, input.claimCount),
      unique_evidence_cited_count: input.uniqueEvidenceCitedCount,
      evidence_manifest_count: input.evidenceManifestCount,
      low_confidence_claim_count: input.lowConfidenceClaimCount,
      model_risk_flag_count: input.modelRiskFlagCount,
      deterministic_signal_count: input.deterministicSignalCount,
    },
  };
}
