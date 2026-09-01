export type EvidenceRecord = {
  id: string;
  fact: string;
};

export type EvidenceLockedResult = {
  claims: Array<{
    statement: string;
    supports: Array<{
      evidence_id: string;
      quote: string;
    }>;
  }>;
  model_risk_flags: Array<{
    evidence_ids: string[];
  }>;
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

export function assertEvidenceLockedResult(
  result: EvidenceLockedResult,
  evidence: EvidenceRecord[],
) {
  const byId = new Map<string, EvidenceRecord>();
  const duplicates = new Set<string>();

  for (const item of evidence) {
    if (byId.has(item.id)) duplicates.add(item.id);
    byId.set(item.id, item);
  }

  if (duplicates.size) {
    throw new Error(
      `ThreadProof supplied duplicate evidence identifiers: ${[...duplicates].slice(0, 5).join(", ")}`,
    );
  }

  const cited = [
    ...result.claims.flatMap((claim) => claim.supports.map((support) => support.evidence_id)),
    ...result.model_risk_flags.flatMap((flag) => flag.evidence_ids),
  ];
  const unknown = [...new Set(cited.filter((id) => !byId.has(id)))];
  if (unknown.length) {
    throw new Error(
      `Gemini cited evidence that was not supplied by ThreadProof: ${unknown.slice(0, 5).join(", ")}`,
    );
  }

  for (const claim of result.claims) {
    for (const forbidden of FORBIDDEN_CLAIM_PATTERNS) {
      if (forbidden.pattern.test(claim.statement)) {
        throw new Error(forbidden.message);
      }
    }

    for (const support of claim.supports) {
      const evidenceItem = byId.get(support.evidence_id);
      if (!evidenceItem) continue;
      const fact = normalized(evidenceItem.fact);
      const quote = normalized(support.quote);
      if (!quote || !fact.includes(quote)) {
        throw new Error(
          `Gemini returned a supporting quote that is not present in evidence ${support.evidence_id}.`,
        );
      }
    }
  }
}

export function materializeEvidenceLockedAnswer(result: EvidenceLockedResult) {
  const statements = result.claims.map((claim) => normalized(claim.statement)).filter(Boolean);
  if (!statements.length) {
    return "No evidence-backed factual claim can be made from the supplied ThreadProof evidence bundle.";
  }
  return statements.join(" ");
}
