export type EvidenceLockRecord = {
  id: string;
  fact: string;
};

export type EvidenceLockSupport = {
  evidence_id: string;
  quote: string;
};

export type EvidenceLockClaim = {
  statement: string;
  supports: EvidenceLockSupport[];
};

export type EvidenceLockRiskFlag = {
  evidence_ids: string[];
};

export type EvidenceLockResult = {
  claims: EvidenceLockClaim[];
  model_risk_flags: EvidenceLockRiskFlag[];
};

function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

const FORBIDDEN_CLAIM_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\b(?:remaining|available|unused)\s+capacity\b[\s\S]{0,48}\b(?:is|equals?|=|:)\s*[-+]?\d/i,
    message: "AI must not infer or disclose exact remaining capacity.",
  },
  {
    pattern: /\b(?:nullifier\s+secret|commitment\s+randomness|opening\s+randomness|encryption\s+key|private\s+zk\s+witness|protected\s+supplier\s+identity)\b[\s\S]{0,48}\b(?:is|equals?|=|:)\s*\S+/i,
    message: "AI must not disclose ThreadProof private protocol secrets or protected identities.",
  },
  {
    pattern: /\b(?:i|threadproof\s+ai|gemini|the\s+ai)\s+(?:hereby\s+)?(?:authorize|approve|accept|confirm)\b/i,
    message: "AI must not represent itself as protocol or business authority.",
  },
];

export function assertEvidenceLockedResult(result: EvidenceLockResult, evidence: EvidenceLockRecord[]) {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const cited = [
    ...result.claims.flatMap((claim) => claim.supports.map((support) => support.evidence_id)),
    ...result.model_risk_flags.flatMap((flag) => flag.evidence_ids),
  ];
  const unknown = [...new Set(cited.filter((id) => !byId.has(id)))];
  if (unknown.length) {
    throw new Error(`Gemini cited evidence that was not supplied by ThreadProof: ${unknown.slice(0, 5).join(", ")}`);
  }

  for (const claim of result.claims) {
    for (const forbidden of FORBIDDEN_CLAIM_PATTERNS) {
      if (forbidden.pattern.test(claim.statement)) throw new Error(forbidden.message);
    }

    for (const support of claim.supports) {
      const evidenceItem = byId.get(support.evidence_id);
      if (!evidenceItem) continue;
      const fact = normalized(evidenceItem.fact);
      const quote = normalized(support.quote);
      if (!quote || !fact.includes(quote)) {
        throw new Error(`Gemini returned a supporting quote that is not present in evidence ${support.evidence_id}.`);
      }
    }
  }
}

export function materializeEvidenceLockedAnswer(result: EvidenceLockResult) {
  const statements = result.claims.map((claim) => normalized(claim.statement)).filter(Boolean);
  if (!statements.length) {
    return "No evidence-backed factual claim can be made from the supplied ThreadProof evidence bundle.";
  }
  return statements.join(" ");
}
