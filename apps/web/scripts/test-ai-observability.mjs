import assert from "node:assert/strict";
import {
  buildAiRunObservability,
  deriveAiEvaluationMetrics,
  normalizeGeminiTokenCount,
  normalizeGeminiUsage,
} from "../lib/ai/observability.ts";

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

check("provider token counts accept only non-negative safe integers", () => {
  assert.equal(normalizeGeminiTokenCount(0), 0);
  assert.equal(normalizeGeminiTokenCount(123), 123);
  assert.equal(normalizeGeminiTokenCount(-1), null);
  assert.equal(normalizeGeminiTokenCount(1.5), null);
  assert.equal(normalizeGeminiTokenCount(Number.NaN), null);
  assert.equal(normalizeGeminiTokenCount("12"), null);
});

check("missing or malformed usage fields fail closed to null", () => {
  assert.deepEqual(normalizeGeminiUsage(undefined), {
    cachedTokens: null,
    inputTokens: null,
    outputTokens: null,
    thoughtTokens: null,
    toolUseTokens: null,
    totalTokens: null,
  });
  assert.deepEqual(normalizeGeminiUsage({
    total_input_tokens: 100,
    total_output_tokens: 20,
    total_thought_tokens: 30,
    total_tokens: 150,
    total_cached_tokens: -5,
  }), {
    cachedTokens: null,
    inputTokens: 100,
    outputTokens: 20,
    thoughtTokens: 30,
    toolUseTokens: null,
    totalTokens: 150,
  });
});

const orderOutput = {
  quantity: 1000,
  unit: "pieces",
  smv_minutes: 18,
  external_reference: "PO-TEST",
  title: null,
  product_category: null,
  requested_delivery_date: null,
  production_period_start: null,
  production_period_end: null,
  buyer_name: null,
  factory_name: null,
  field_evidence: [
    { field: "quantity", confidence: 0.9, excerpt: "PRIVATE QUOTE 1000" },
    { field: "unit", confidence: 0.8, excerpt: "PRIVATE QUOTE pieces" },
    { field: "smv_minutes", confidence: 1, excerpt: "PRIVATE QUOTE 18" },
    { field: "external_reference", confidence: 0.7, excerpt: "PRIVATE QUOTE PO-TEST" },
  ],
  risk_flags: [{ code: "MODEL_FLAG" }],
  deterministic_checks: [{ code: "RULE_FLAG" }, { code: "RULE_FLAG_2" }],
  requires_human_review: true,
};

check("order evaluation measures evidence coverage without copying evidence text", () => {
  const metrics = deriveAiEvaluationMetrics(orderOutput);
  assert.equal(metrics.output_shape, "order_intelligence");
  assert.equal(metrics.extractable_field_count, 4);
  assert.equal(metrics.evidenced_field_count, 4);
  assert.equal(metrics.evidence_coverage_ratio, 1);
  assert.equal(metrics.model_risk_flag_count, 1);
  assert.equal(metrics.deterministic_check_count, 2);
  assert.equal(metrics.requires_human_review, true);
  assert.equal(JSON.stringify(metrics).includes("PRIVATE QUOTE"), false);
});

const auditOutput = {
  answer: "Derived display answer",
  claims: [
    { statement: "Claim A", confidence: "high", supports: [{ evidence_id: "order:a", quote: "PRIVATE FACT A" }] },
    { statement: "Claim B", confidence: "low", supports: [{ evidence_id: "network:b", quote: "PRIVATE FACT B" }, { evidence_id: "order:a", quote: "PRIVATE FACT A" }] },
  ],
  model_risk_flags: [{ code: "MODEL_RISK" }],
  deterministic_signals: [{ code: "RULE_1" }, { code: "RULE_2" }],
  evidence_manifest: [{ id: "order:a" }, { id: "network:b" }, { id: "credential:c" }],
};

check("investigator evaluation measures grounding density and rule/model separation", () => {
  const metrics = deriveAiEvaluationMetrics(auditOutput);
  assert.equal(metrics.output_shape, "audit_copilot");
  assert.equal(metrics.claim_count, 2);
  assert.equal(metrics.supported_claim_count, 2);
  assert.equal(metrics.supported_claim_ratio, 1);
  assert.equal(metrics.support_count, 3);
  assert.equal(metrics.average_supports_per_claim, 1.5);
  assert.equal(metrics.unique_evidence_cited_count, 2);
  assert.equal(metrics.evidence_manifest_count, 3);
  assert.equal(metrics.low_confidence_claim_count, 1);
  assert.equal(metrics.model_risk_flag_count, 1);
  assert.equal(metrics.deterministic_signal_count, 2);
  assert.equal(JSON.stringify(metrics).includes("PRIVATE FACT"), false);
});

check("complete observability payload remains text-free and bounded to metrics", () => {
  const telemetry = buildAiRunObservability({
    providerLatencyMs: 1234,
    usage: {
      cachedTokens: 5,
      inputTokens: 100,
      outputTokens: 20,
      thoughtTokens: 30,
      toolUseTokens: 0,
      totalTokens: 150,
    },
  }, auditOutput);
  assert.equal(telemetry.version, 1);
  assert.equal(telemetry.provider.latency_ms, 1234);
  assert.equal(telemetry.provider.total_tokens, 150);
  const serialized = JSON.stringify(telemetry);
  for (const forbidden of ["PRIVATE FACT", "Claim A", "Derived display answer", "order:a"]) {
    assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}`);
  }
});

console.log(JSON.stringify({
  threadproof_ai_observability_tests: "PASS",
  checks: checks.length,
  names: checks,
}));
