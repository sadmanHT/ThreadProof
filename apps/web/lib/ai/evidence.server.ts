export type AuditEvidenceSource =
  | "network_status"
  | "chain_event"
  | "credential"
  | "order"
  | "proof_job"
  | "governance"
  | "system";

export type AuditEvidence = {
  id: string;
  source: AuditEvidenceSource;
  reference: string;
  observed_at: string | null;
  fact: string;
  attributes: Record<string, string | number | boolean | null>;
};

export type DeterministicInvestigationSignal = {
  severity: "info" | "low" | "medium" | "high";
  code: string;
  explanation: string;
  evidence_ids: string[];
};

export type AuditEvidenceContext = {
  orders?: unknown[];
  credentials?: unknown[];
  proof_jobs?: unknown[];
  chain_events?: unknown[];
  governance?: unknown[];
  chain_status?: unknown;
  source_errors?: unknown[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function safeId(value: unknown, fallback: string) {
  const raw = String(value ?? fallback).replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 160);
  return raw || fallback;
}

function timestamp(value: unknown) {
  const candidate = text(value);
  if (!candidate) return null;
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function daysUntil(value: string | null, now: Date) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.ceil((parsed - now.getTime()) / 86_400_000);
}

function pushUniqueSignal(
  signals: DeterministicInvestigationSignal[],
  signal: DeterministicInvestigationSignal,
) {
  const key = `${signal.code}:${signal.evidence_ids.join(",")}`;
  if (!signals.some((candidate) => `${candidate.code}:${candidate.evidence_ids.join(",")}` === key)) {
    signals.push(signal);
  }
}

export function buildAuditEvidenceBundle(context: AuditEvidenceContext, now = new Date()) {
  const evidence: AuditEvidence[] = [];
  const signals: DeterministicInvestigationSignal[] = [];

  const chainStatus = asObject(context.chain_status);
  if (chainStatus) {
    const online = booleanValue(chainStatus.online);
    const configured = booleanValue(chainStatus.configured);
    const chainId = numberValue(chainStatus.chainId);
    const blockNumber = numberValue(chainStatus.blockNumber);
    evidence.push({
      id: "network:rpc",
      source: "network_status",
      reference: chainId == null ? "configured RPC" : `chain:${chainId}`,
      observed_at: now.toISOString(),
      fact: configured === false
        ? "The ThreadProof application has no consortium RPC configured."
        : online
          ? `The configured consortium RPC responded${chainId == null ? "" : ` for chain ${chainId}`}${blockNumber == null ? "" : ` at block ${blockNumber}`}.`
          : "The configured consortium RPC did not respond to the application health check.",
      attributes: {
        configured,
        online,
        chain_id: chainId,
        block_number: blockNumber,
      },
    });
    if (configured === false || online === false) {
      pushUniqueSignal(signals, {
        severity: "high",
        code: configured === false ? "CHAIN_RPC_NOT_CONFIGURED" : "CHAIN_RPC_UNREACHABLE",
        explanation: "New protocol-critical authorization must fail closed until direct consortium-chain validation is available.",
        evidence_ids: ["network:rpc"],
      });
    }
  }

  for (const [index, row] of (context.orders ?? []).entries()) {
    const order = asObject(row);
    if (!order) continue;
    const id = safeId(order.id, String(index));
    const evidenceId = `order:${id}`;
    const chainOrderId = text(order.chain_order_id);
    const status = text(order.status) ?? "unknown";
    const version = numberValue(order.current_version);
    evidence.push({
      id: evidenceId,
      source: "order",
      reference: chainOrderId ?? id,
      observed_at: timestamp(order.updated_at),
      fact: `Visible order ${chainOrderId ?? id} is projected as ${status}${version == null ? "" : ` at version ${version}`}.`,
      attributes: {
        status,
        current_version: version,
        chain_order_id: chainOrderId,
        current_order_commitment: text(order.current_order_commitment),
        current_policy_hash: text(order.current_policy_hash),
      },
    });
  }

  for (const [index, row] of (context.credentials ?? []).entries()) {
    const credential = asObject(row);
    if (!credential) continue;
    const id = safeId(credential.id, String(index));
    const evidenceId = `credential:${id}`;
    const chainCredentialId = text(credential.chain_credential_id);
    const status = text(credential.status) ?? "unknown";
    const credentialType = text(credential.credential_type) ?? "credential";
    const validUntil = timestamp(credential.valid_until);
    evidence.push({
      id: evidenceId,
      source: "credential",
      reference: chainCredentialId ?? id,
      observed_at: timestamp(credential.created_at),
      fact: `Visible ${credentialType} ${chainCredentialId ?? id} is projected as ${status}${validUntil ? ` with validity ending ${validUntil}` : ""}.`,
      attributes: {
        status,
        credential_type: credentialType,
        chain_credential_id: chainCredentialId,
        valid_from: timestamp(credential.valid_from),
        valid_until: validUntil,
        chain_tx_hash: text(credential.chain_tx_hash),
      },
    });

    if (status === "revoked" || status === "suspended" || status === "expired") {
      pushUniqueSignal(signals, {
        severity: "high",
        code: `CREDENTIAL_${status.toUpperCase()}`,
        explanation: `A visible ${credentialType} is projected as ${status}. Any new authorization depending on it requires direct CredentialRegistry validation and must not rely on a cached badge.`,
        evidence_ids: [evidenceId],
      });
    } else if (status === "active") {
      const remainingDays = daysUntil(validUntil, now);
      if (remainingDays != null && remainingDays >= 0 && remainingDays <= 30) {
        pushUniqueSignal(signals, {
          severity: remainingDays <= 7 ? "high" : "medium",
          code: "CREDENTIAL_EXPIRING_SOON",
          explanation: `A visible active credential reaches its recorded validity end in ${remainingDays} day(s). Re-check current registry status before a new production authorization.`,
          evidence_ids: [evidenceId],
        });
      }
    }
  }

  for (const [index, row] of (context.proof_jobs ?? []).entries()) {
    const proof = asObject(row);
    if (!proof) continue;
    const id = safeId(proof.id, String(index));
    const evidenceId = `proof:${id}`;
    const status = text(proof.status) ?? "unknown";
    const errorCode = text(proof.error_code);
    evidence.push({
      id: evidenceId,
      source: "proof_job",
      reference: id,
      observed_at: timestamp(proof.completed_at) ?? timestamp(proof.created_at),
      fact: `Proof job ${id} is recorded as ${status}${errorCode ? ` with error code ${errorCode}` : ""}. This is workflow metadata, not independent proof validity.`,
      attributes: {
        status,
        circuit_version: numberValue(proof.circuit_version),
        chain_tx_hash: text(proof.chain_tx_hash),
        chain_block_number: numberValue(proof.chain_block_number),
        error_code: errorCode,
      },
    });
    if (status === "failed" || status === "stale") {
      pushUniqueSignal(signals, {
        severity: "high",
        code: status === "failed" ? "PROOF_JOB_FAILED" : "PROOF_JOB_STALE",
        explanation: `A proof workflow is ${status}${errorCode ? ` (${errorCode})` : ""}. Diagnose the workflow and validate current CapacityVault/order/credential state before retrying.`,
        evidence_ids: [evidenceId],
      });
    }
  }

  for (const [index, row] of (context.chain_events ?? []).entries()) {
    const event = asObject(row);
    if (!event) continue;
    const id = safeId(event.id, String(index));
    const evidenceId = `event:${id}`;
    const eventName = text(event.event_name) ?? "UnknownEvent";
    const txHash = text(event.transaction_hash);
    const block = numberValue(event.block_number);
    evidence.push({
      id: evidenceId,
      source: "chain_event",
      reference: txHash ?? id,
      observed_at: timestamp(event.observed_at),
      fact: `The indexer observed ${eventName}${block == null ? "" : ` at block ${block}`}${txHash ? ` in transaction ${txHash}` : ""}.`,
      attributes: {
        event_name: eventName,
        block_number: block,
        transaction_hash: txHash,
        contract_address: text(event.contract_address),
      },
    });
  }

  for (const [index, row] of (context.governance ?? []).entries()) {
    const proposal = asObject(row);
    if (!proposal) continue;
    const id = safeId(proposal.chain_proposal_id, String(index));
    const evidenceId = `governance:${id}`;
    const state = text(proposal.state) ?? "unknown";
    const received = numberValue(proposal.approvals_received);
    const required = numberValue(proposal.approvals_required);
    evidence.push({
      id: evidenceId,
      source: "governance",
      reference: id,
      observed_at: timestamp(proposal.updated_at),
      fact: `Governance proposal ${id} is projected as ${state}${received == null || required == null ? "" : ` with ${received}/${required} approvals`}.`,
      attributes: {
        proposal_type: text(proposal.proposal_type),
        state,
        approvals_received: received,
        approvals_required: required,
        execute_after: timestamp(proposal.execute_after),
        executed_tx_hash: text(proposal.executed_tx_hash),
        last_synced_block: numberValue(proposal.last_synced_block),
      },
    });
    if (required != null && received != null && received < required && !["executed", "cancelled", "expired"].includes(state)) {
      pushUniqueSignal(signals, {
        severity: "medium",
        code: "GOVERNANCE_THRESHOLD_PENDING",
        explanation: `A governance proposal has ${received}/${required} recorded approvals. The application must not treat it as executed until the Charter records execution after all threshold/timelock conditions are satisfied.`,
        evidence_ids: [evidenceId],
      });
    }
  }

  for (const [index, row] of (context.source_errors ?? []).entries()) {
    const error = asObject(row);
    const code = text(error?.code) ?? "QUERY_ERROR";
    const evidenceId = `system:source-error-${index + 1}`;
    evidence.push({
      id: evidenceId,
      source: "system",
      reference: code,
      observed_at: now.toISOString(),
      fact: `An authorized context query failed with code ${code}; the evidence bundle is incomplete.`,
      attributes: { code },
    });
    pushUniqueSignal(signals, {
      severity: "high",
      code: "INCOMPLETE_EVIDENCE_CONTEXT",
      explanation: "One or more authorized evidence queries failed. AI conclusions should be treated as incomplete until the missing source is restored.",
      evidence_ids: [evidenceId],
    });
  }

  return {
    evidence: evidence.slice(0, 140),
    deterministic_signals: signals.slice(0, 40),
  };
}
