import { z } from "zod";
import { AI_TRUST_BOUNDARY } from "@/lib/ai/policy.server";
import { runGeminiStructured } from "@/lib/ai/gemini.server";
import { assertEvidenceLockedResult } from "@/lib/ai/evidence-lock";
import type { AuditEvidence, DeterministicInvestigationSignal } from "@/lib/ai/evidence.server";

const evidenceSupportSchema = z.object({
  evidence_id: z.string().min(1).max(180),
  quote: z.string().min(1).max(600),
});

const claimSchema = z.object({
  statement: z.string().min(1).max(1800),
  supports: z.array(evidenceSupportSchema).min(1).max(8),
  confidence: z.enum(["low", "medium", "high"]),
});

const modelRiskSchema = z.object({
  severity: z.enum(["info", "low", "medium", "high"]),
  code: z.string().min(1).max(100),
  explanation: z.string().min(1).max(1600),
  evidence_ids: z.array(z.string().min(1).max(180)).min(1).max(8),
});

export const auditCopilotResultSchema = z.object({
  answer: z.string().min(1).max(8000),
  claims: z.array(claimSchema).max(16),
  model_risk_flags: z.array(modelRiskSchema).max(12),
  confidence: z.enum(["low", "medium", "high"]),
  limitations: z.array(z.string().max(1200)).max(12),
  recommended_next_checks: z.array(z.string().max(1200)).max(12),
});

export type AuditCopilotResult = z.infer<typeof auditCopilotResultSchema>;

const auditJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    claims: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: { type: "string" },
          supports: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                evidence_id: { type: "string" },
                quote: { type: "string" },
              },
              required: ["evidence_id", "quote"],
            },
          },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["statement", "supports", "confidence"],
      },
    },
    model_risk_flags: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["info", "low", "medium", "high"] },
          code: { type: "string" },
          explanation: { type: "string" },
          evidence_ids: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
        },
        required: ["severity", "code", "explanation", "evidence_ids"],
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    limitations: { type: "array", maxItems: 12, items: { type: "string" } },
    recommended_next_checks: { type: "array", maxItems: 12, items: { type: "string" } },
  },
  required: ["answer", "claims", "model_risk_flags", "confidence", "limitations", "recommended_next_checks"],
} as const;

export async function answerAuditQuestion(input: {
  question: string;
  organizationName: string;
  organizationRole: string;
  evidence: AuditEvidence[];
  deterministicSignals: DeterministicInvestigationSignal[];
}) {
  const prompt = `${AI_TRUST_BOUNDARY}\n\nTASK: Act as the ThreadProof Evidence Investigator. Answer the user's protocol/audit question using ONLY the evidence bundle supplied below.\n- Each factual claim must include one or more supports. Each support contains an exact evidence_id and a short VERBATIM quote copied from that evidence record's fact field. Never invent, paraphrase, or transform the supporting quote or evidence id.\n- The final answer must be a concise synthesis of the structured claims; do not add uncited factual assertions in prose.\n- Deterministic signals were produced by ThreadProof rules, not by AI. You may explain them, but do not elevate them into canonical protocol decisions.\n- network_status evidence is a direct application RPC health observation. Other evidence entries are authorized read-model/index observations unless the fact explicitly says otherwise.\n- A proof-job status does not independently prove a Groth16 proof is valid.\n- A credential projection does not override CredentialRegistry.\n- An order projection does not override OrderRegistry or buyer EIP-712 authority.\n- A governance projection does not mean execution occurred unless canonical Charter execution is directly verified.\n- Never infer exact remaining capacity, private workloads, prices, hidden counterparties, witness values, nullifier secrets, encryption keys, or protected identities.\n- If evidence is incomplete or contradictory, lower confidence and say exactly what is missing.\n- Recommended checks should name the authoritative contract/proof/read that an operator should perform next.\n\nREQUESTING ORGANIZATION: ${input.organizationName} (${input.organizationRole})\nQUESTION: ${input.question}\n\nTHREADPROOF EVIDENCE BUNDLE:\n${JSON.stringify({ evidence: input.evidence, deterministic_signals: input.deterministicSignals })}`;

  const response = await runGeminiStructured<unknown>({ prompt, schema: auditJsonSchema });
  const result = auditCopilotResultSchema.parse(response.value);
  assertEvidenceLockedResult(result, input.evidence);
  return {
    id: response.id,
    model: response.model,
    result,
  };
}
