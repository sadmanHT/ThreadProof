import { z } from "zod";
import { AI_TRUST_BOUNDARY } from "@/lib/ai/policy.server";
import { runGeminiStructured } from "@/lib/ai/gemini.server";

const evidenceSchema = z.object({
  source: z.enum(["chain_event", "credential", "order", "proof_job", "governance"]),
  reference: z.string().min(1).max(220),
  fact: z.string().min(1).max(1200),
});

export const auditCopilotResultSchema = z.object({
  answer: z.string().min(1).max(8000),
  evidence: z.array(evidenceSchema).max(20),
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
    evidence: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", enum: ["chain_event", "credential", "order", "proof_job", "governance"] },
          reference: { type: "string" },
          fact: { type: "string" },
        },
        required: ["source", "reference", "fact"],
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    limitations: { type: "array", maxItems: 12, items: { type: "string" } },
    recommended_next_checks: { type: "array", maxItems: 12, items: { type: "string" } },
  },
  required: ["answer", "evidence", "confidence", "limitations", "recommended_next_checks"],
} as const;

export async function answerAuditQuestion(input: {
  question: string;
  organizationName: string;
  organizationRole: string;
  context: unknown;
}) {
  const prompt = `${AI_TRUST_BOUNDARY}\n\nTASK: Answer a ThreadProof protocol/audit question using ONLY the supplied authorized read-model context.\n- The context is an off-chain index/read model. Describe indexed observations as such; do not pretend they are direct contract reads.\n- Never infer exact remaining capacity, private workloads, prices, hidden counterparties, witness values, or protected identities.\n- A proof-job status in Supabase does not independently prove a Groth16 proof is valid.\n- A credential row is a read model; canonical status for a critical authorization must be checked against CredentialRegistry.\n- A purchase-order row is operational/read-model state; canonical buyer authorization must be checked against OrderRegistry.\n- Chain events are evidence of indexed finalized activity, but critical writes should still validate current contract state directly.\n- If the evidence does not support the answer, say so plainly.\n- Give concise, operationally useful next checks rather than inventing facts.\n\nREQUESTING ORGANIZATION: ${input.organizationName} (${input.organizationRole})\nQUESTION: ${input.question}\n\nAUTHORIZED SANITIZED CONTEXT:\n${JSON.stringify(input.context)}`;

  const response = await runGeminiStructured<unknown>({ prompt, schema: auditJsonSchema });
  return {
    id: response.id,
    model: response.model,
    result: auditCopilotResultSchema.parse(response.value),
  };
}
