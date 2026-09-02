#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const FORMAT = "threadproof-production-recovery-evidence/v1";
const DEFAULT_CHAIN_ID = "2026";

function fail(message) {
  throw new Error(message);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stabilize(value) {
  if (Array.isArray(value)) return value.map(stabilize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stabilize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stabilize(value));
}

function readJson(filePath, label) {
  const raw = readFileSync(filePath);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { raw, value };
}

function readEvents(filePath) {
  const raw = readFileSync(filePath);
  const text = raw.toString("utf8").trim();
  if (!text) fail("canonical event archive is empty");

  let value;
  try {
    if (text.startsWith("[")) {
      value = JSON.parse(text);
    } else {
      value = text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  } catch {
    fail("canonical event archive is not valid JSON or JSONL");
  }

  if (!Array.isArray(value) || value.length === 0) {
    fail("canonical event archive must contain at least one event");
  }
  return { raw, value };
}

function field(value, snake, camel = snake) {
  return value?.[snake] ?? value?.[camel];
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null;
  return requiredString(value, label);
}

function exactHex(value, bytes, label) {
  const text = requiredString(value, label);
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (!pattern.test(text)) fail(`${label} has invalid hex encoding`);
  return text.toLowerCase();
}

function uintString(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer or decimal string`);
    return String(value);
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    fail(`${label} must be a non-negative integer`);
  }
  return BigInt(value).toString(10);
}

function smallInt(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = uintString(value, label);
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail(`${label} is outside its allowed range`);
  }
  return number;
}

function isoTimestamp(value, label) {
  if (value === null || value === undefined) return null;
  const text = requiredString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) fail(`${label} must be an ISO timestamp`);
  return new Date(ms).toISOString();
}

function unixSecondsTimestamp(value, label) {
  const seconds = uintString(value, label);
  const numeric = Number(seconds);
  if (!Number.isSafeInteger(numeric)) fail(`${label} exceeds supported timestamp range`);
  const date = new Date(numeric * 1000);
  if (!Number.isFinite(date.getTime())) fail(`${label} is not a valid timestamp`);
  return date.toISOString();
}

function normalizeEvent(row, expectedChainId) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("canonical event row must be an object");
  const chainId = uintString(field(row, "chain_id", "chainId"), "event chain id");
  if (chainId !== expectedChainId) fail("canonical event archive contains an unexpected chain id");

  const data = field(row, "data");
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("canonical event data must be an object");

  return {
    chainId,
    blockNumber: uintString(field(row, "block_number", "blockNumber"), "event block number"),
    blockHash: exactHex(field(row, "block_hash", "blockHash"), 32, "event block hash"),
    transactionHash: exactHex(field(row, "transaction_hash", "transactionHash"), 32, "event transaction hash"),
    logIndex: smallInt(field(row, "log_index", "logIndex"), "event log index"),
    contractAddress: exactHex(field(row, "contract_address", "contractAddress"), 20, "event contract address"),
    eventName: requiredString(field(row, "event_name", "eventName"), "event name"),
    data,
  };
}

function sortAndValidateEvents(rows, chainId) {
  const events = rows.map((row) => normalizeEvent(row, chainId));
  events.sort((a, b) => {
    const blockDelta = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    if (blockDelta !== 0n) return blockDelta < 0n ? -1 : 1;
    if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
    return a.transactionHash.localeCompare(b.transactionHash);
  });

  const seen = new Set();
  for (const event of events) {
    const identity = `${event.chainId}:${event.transactionHash}:${event.logIndex}`;
    if (seen.has(identity)) fail("canonical event archive contains a duplicate transaction/log identity");
    seen.add(identity);
  }
  return events;
}

function proposalTypeLabel(value) {
  switch (smallInt(value, "proposal type", { min: 1 })) {
    case 1:
      return "organization_suspension";
    case 2:
      return "organization_restore";
    case 3:
      return "primary_account_rotation";
    case 4:
      return "protected_identity_disclosure";
    case 5:
      return "charter_policy_update";
    default:
      return "unknown";
  }
}

function normalizeProposalId(value) {
  return exactHex(value, 32, "proposal id");
}

function replayGovernance(events) {
  const rows = new Map();
  let relevantEvents = 0;

  for (const event of events) {
    if (![
      "ProposalCreated",
      "ProposalApprovalRecorded",
      "ProposalThresholdReached",
      "ProposalCancelled",
      "ProposalExecuted",
    ].includes(event.eventName)) {
      continue;
    }
    relevantEvents += 1;

    const proposalId = normalizeProposalId(event.data.proposalId);
    const existing = rows.get(proposalId);

    if (event.eventName === "ProposalCreated") {
      const created = {
        chain_proposal_id: proposalId,
        proposal_type: proposalTypeLabel(event.data.proposalType),
        proposer_chain_organization_id: exactHex(event.data.proposerOrganizationId, 32, "proposal organization id"),
        policy_version: optionalString(event.data.policyVersion, "proposal policy version"),
        approvals_required: smallInt(event.data.approvalsRequired, "proposal approvals required", { min: 1, max: 31 }),
        approvals_received: existing?.approvals_received ?? 0,
        state: existing?.state ?? "pending",
        execute_after: existing?.execute_after ?? null,
        executed_tx_hash: existing?.executed_tx_hash ?? null,
        last_synced_block:
          existing && BigInt(existing.last_synced_block) > BigInt(event.blockNumber)
            ? existing.last_synced_block
            : event.blockNumber,
        action_hash: exactHex(event.data.actionHash, 32, "proposal action hash"),
        metadata_hash: exactHex(event.data.metadataHash, 32, "proposal metadata hash"),
        approval_mask: existing?.approval_mask ?? 0,
        expires_at: unixSecondsTimestamp(event.data.expiresAt, "proposal expiry"),
        approved_at: existing?.approved_at ?? null,
      };
      rows.set(proposalId, created);
      continue;
    }

    if (!existing) fail("governance replay encountered an event before ProposalCreated");

    if (event.eventName === "ProposalApprovalRecorded") {
      existing.approvals_received = smallInt(event.data.approvalsReceived, "proposal approvals received", { max: 31 });
      existing.approvals_required = smallInt(event.data.approvalsRequired, "proposal approvals required", { min: 1, max: 31 });
      existing.approval_mask = smallInt(event.data.approvalMask, "proposal approval mask", { max: 31 });
      existing.last_synced_block = event.blockNumber;
    } else if (event.eventName === "ProposalThresholdReached") {
      existing.state = "timelocked";
      existing.approved_at = unixSecondsTimestamp(event.data.approvedAt, "proposal approval time");
      existing.execute_after = unixSecondsTimestamp(event.data.executeAfter, "proposal execute-after time");
      existing.last_synced_block = event.blockNumber;
    } else if (event.eventName === "ProposalCancelled") {
      existing.state = "cancelled";
      existing.last_synced_block = event.blockNumber;
    } else if (event.eventName === "ProposalExecuted") {
      existing.state = "executed";
      existing.executed_tx_hash = event.transactionHash;
      existing.last_synced_block = event.blockNumber;
    }
  }

  return {
    rows: [...rows.values()].sort((a, b) => a.chain_proposal_id.localeCompare(b.chain_proposal_id)),
    relevantEvents,
  };
}

function replayVerifierProvenance(events) {
  const rows = new Map();
  let relevantEvents = 0;

  for (const event of events) {
    if (event.eventName !== "VerifierProvenanceRegistered") continue;
    relevantEvents += 1;

    const circuitVersion = smallInt(event.data.circuitVersion, "verifier circuit version", { min: 1 });
    const next = {
      chain_id: event.chainId,
      circuit_version: circuitVersion,
      verifier_address: exactHex(event.data.verifier, 20, "verifier address"),
      circuit_artifact_hash: exactHex(event.data.circuitArtifactHash, 32, "circuit artifact hash"),
      verification_key_hash: exactHex(event.data.verificationKeyHash, 32, "verification key hash"),
      verifier_code_hash: exactHex(event.data.verifierCodeHash, 32, "verifier code hash"),
      registration_tx_hash: event.transactionHash,
      contract_address: event.contractAddress,
      registered_block: event.blockNumber,
    };

    const key = `${event.chainId}:${circuitVersion}`;
    const existing = rows.get(key);
    if (existing && canonicalJson(existing) !== canonicalJson(next)) {
      fail("canonical event archive contains conflicting verifier provenance for one circuit version");
    }
    if (!existing) rows.set(key, next);
  }

  return {
    rows: [...rows.values()].sort((a, b) => {
      const chainDelta = BigInt(a.chain_id) - BigInt(b.chain_id);
      if (chainDelta !== 0n) return chainDelta < 0n ? -1 : 1;
      return a.circuit_version - b.circuit_version;
    }),
    relevantEvents,
  };
}

function normalizeRestoredGovernanceRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("restored governance row must be an object");
  return {
    chain_proposal_id: normalizeProposalId(field(row, "chain_proposal_id", "chainProposalId")),
    proposal_type: requiredString(field(row, "proposal_type", "proposalType"), "restored proposal type"),
    proposer_chain_organization_id: exactHex(
      field(row, "proposer_chain_organization_id", "proposerChainOrganizationId"),
      32,
      "restored proposal organization id",
    ),
    policy_version: optionalString(field(row, "policy_version", "policyVersion"), "restored proposal policy version"),
    approvals_required: smallInt(field(row, "approvals_required", "approvalsRequired"), "restored approvals required", { min: 1, max: 31 }),
    approvals_received: smallInt(field(row, "approvals_received", "approvalsReceived"), "restored approvals received", { max: 31 }),
    state: requiredString(field(row, "state"), "restored proposal state"),
    execute_after: isoTimestamp(field(row, "execute_after", "executeAfter"), "restored execute-after timestamp"),
    executed_tx_hash:
      field(row, "executed_tx_hash", "executedTxHash") == null
        ? null
        : exactHex(field(row, "executed_tx_hash", "executedTxHash"), 32, "restored execution transaction hash"),
    last_synced_block: uintString(field(row, "last_synced_block", "lastSyncedBlock"), "restored proposal block"),
    action_hash: exactHex(field(row, "action_hash", "actionHash"), 32, "restored proposal action hash"),
    metadata_hash: exactHex(field(row, "metadata_hash", "metadataHash"), 32, "restored proposal metadata hash"),
    approval_mask: smallInt(field(row, "approval_mask", "approvalMask"), "restored approval mask", { max: 31 }),
    expires_at: isoTimestamp(field(row, "expires_at", "expiresAt"), "restored proposal expiry"),
    approved_at: isoTimestamp(field(row, "approved_at", "approvedAt"), "restored proposal approval time"),
  };
}

function normalizeRestoredVerifierRow(row, expectedChainId) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("restored verifier row must be an object");
  const chainId = uintString(field(row, "chain_id", "chainId"), "restored verifier chain id");
  if (chainId !== expectedChainId) fail("restored verifier snapshot contains an unexpected chain id");
  return {
    chain_id: chainId,
    circuit_version: smallInt(field(row, "circuit_version", "circuitVersion"), "restored circuit version", { min: 1 }),
    verifier_address: exactHex(field(row, "verifier_address", "verifierAddress"), 20, "restored verifier address"),
    circuit_artifact_hash: exactHex(field(row, "circuit_artifact_hash", "circuitArtifactHash"), 32, "restored artifact hash"),
    verification_key_hash: exactHex(field(row, "verification_key_hash", "verificationKeyHash"), 32, "restored verification-key hash"),
    verifier_code_hash: exactHex(field(row, "verifier_code_hash", "verifierCodeHash"), 32, "restored verifier-code hash"),
    registration_tx_hash: exactHex(field(row, "registration_tx_hash", "registrationTxHash"), 32, "restored registration transaction hash"),
    contract_address: exactHex(field(row, "contract_address", "contractAddress"), 20, "restored verifier contract address"),
    registered_block: uintString(field(row, "registered_block", "registeredBlock"), "restored verifier block"),
  };
}

function normalizeRestoredReadModel(value, chainId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("restored read-model snapshot must be a JSON object");
  const governanceInput = value.governanceProposals ?? value.governance_proposal_read_model;
  const verifierInput = value.verifierProvenance ?? value.verifier_provenance_read_model;
  if (!Array.isArray(governanceInput)) fail("restored read-model snapshot is missing governance proposals");
  if (!Array.isArray(verifierInput)) fail("restored read-model snapshot is missing verifier provenance");

  const governance = governanceInput.map(normalizeRestoredGovernanceRow);
  governance.sort((a, b) => a.chain_proposal_id.localeCompare(b.chain_proposal_id));

  const verifier = verifierInput.map((row) => normalizeRestoredVerifierRow(row, chainId));
  verifier.sort((a, b) => {
    const chainDelta = BigInt(a.chain_id) - BigInt(b.chain_id);
    if (chainDelta !== 0n) return chainDelta < 0n ? -1 : 1;
    return a.circuit_version - b.circuit_version;
  });

  return { governance, verifier };
}

function walkPrivateTree(root) {
  const absoluteRoot = path.resolve(root);
  const rootStat = statSync(absoluteRoot);
  if (!rootStat.isDirectory()) fail("private backup path must be a directory");

  const entries = [];
  function visit(directory, prefix) {
    const children = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail("private backup tree must not contain symbolic links");
      if (metadata.isDirectory()) {
        visit(absolute, relative);
      } else if (metadata.isFile()) {
        const bytes = readFileSync(absolute);
        entries.push({ relative, size: bytes.length, sha256: sha256Bytes(bytes) });
      } else {
        fail("private backup tree contains an unsupported filesystem entry");
      }
    }
  }
  visit(absoluteRoot, "");
  if (entries.length === 0) fail("private backup tree must contain at least one encrypted backup artifact");

  const digestMaterial = entries.map((entry) => `${entry.relative}\0${entry.size}\0${entry.sha256}\n`).join("");
  return {
    entries,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    treeSha256: sha256Bytes(Buffer.from(digestMaterial, "utf8")),
  };
}

function comparePrivateTrees(backup, restored) {
  if (canonicalJson(backup.entries) !== canonicalJson(restored.entries)) {
    fail("restored private backup tree is not byte-identical to the source backup");
  }
}

function parseArgs(argv) {
  const result = {
    chainId: DEFAULT_CHAIN_ID,
    output: "artifacts/production-recovery-evidence.json",
  };
  const allowed = new Set([
    "--events",
    "--restored-read-model",
    "--backup-dir",
    "--restored-private-dir",
    "--source-commit",
    "--chain-id",
    "--output",
  ]);

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!allowed.has(key)) fail(`unknown argument: ${key ?? "<missing>"}`);
    if (index + 1 >= argv.length) fail(`${key} requires a value`);
    const value = argv[index + 1];
    if (key === "--events") result.events = value;
    else if (key === "--restored-read-model") result.restoredReadModel = value;
    else if (key === "--backup-dir") result.backupDir = value;
    else if (key === "--restored-private-dir") result.restoredPrivateDir = value;
    else if (key === "--source-commit") result.sourceCommit = value;
    else if (key === "--chain-id") result.chainId = value;
    else if (key === "--output") result.output = value;
  }

  for (const [name, value] of [
    ["--events", result.events],
    ["--restored-read-model", result.restoredReadModel],
    ["--backup-dir", result.backupDir],
    ["--restored-private-dir", result.restoredPrivateDir],
    ["--source-commit", result.sourceCommit],
  ]) {
    if (!value) fail(`${name} is required`);
  }

  result.chainId = uintString(result.chainId, "chain id");
  if (!/^[0-9a-fA-F]{40}$/.test(result.sourceCommit) || /^0{40}$/.test(result.sourceCommit)) {
    fail("source commit must be a non-zero 40-character Git SHA");
  }
  result.sourceCommit = result.sourceCommit.toLowerCase();
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventsInput = readEvents(args.events);
  const restoredInput = readJson(args.restoredReadModel, "restored read-model snapshot");

  const events = sortAndValidateEvents(eventsInput.value, args.chainId);
  const governance = replayGovernance(events);
  const verifier = replayVerifierProvenance(events);
  const restored = normalizeRestoredReadModel(restoredInput.value, args.chainId);

  if (canonicalJson(governance.rows) !== canonicalJson(restored.governance)) {
    fail("restored governance read model does not match deterministic canonical-event replay");
  }
  if (canonicalJson(verifier.rows) !== canonicalJson(restored.verifier)) {
    fail("restored verifier provenance read model does not match deterministic canonical-event replay");
  }

  const backup = walkPrivateTree(args.backupDir);
  const restoredPrivate = walkPrivateTree(args.restoredPrivateDir);
  comparePrivateTrees(backup, restoredPrivate);

  const semanticProjection = {
    governance: governance.rows,
    verifier: verifier.rows,
  };
  const evidence = {
    format: FORMAT,
    generatedAt: new Date().toISOString(),
    sourceCommit: args.sourceCommit,
    chainId: args.chainId,
    result: "pass",
    canonicalEventArchive: {
      sha256: sha256Bytes(eventsInput.raw),
      eventCount: events.length,
      governanceEventCount: governance.relevantEvents,
      verifierEventCount: verifier.relevantEvents,
    },
    restoredReadModel: {
      sha256: sha256Bytes(restoredInput.raw),
      governanceRows: restored.governance.length,
      verifierRows: restored.verifier.length,
      semanticProjectionSha256: sha256Bytes(Buffer.from(canonicalJson(semanticProjection), "utf8")),
    },
    privateBackup: {
      sourceTreeSha256: backup.treeSha256,
      restoredTreeSha256: restoredPrivate.treeSha256,
      fileCount: backup.fileCount,
      totalBytes: backup.totalBytes,
      byteIdentical: true,
    },
    assertions: [
      "restored governance projection equals deterministic canonical-event replay",
      "restored verifier provenance equals deterministic canonical-event replay",
      "restored private backup artifacts are byte-identical to the encrypted source backup",
    ],
    limitations: [
      "Private capacity openings are restored from encrypted backup material; they are not reconstructed from chain events.",
      "This evidence verifies recovery integrity and projection consistency; it does not prove the truth of physical-world audit inputs.",
    ],
  };

  const outputPath = path.resolve(args.output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const outputBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  writeFileSync(outputPath, outputBytes, { mode: 0o600 });
  const outputSha256 = sha256Bytes(outputBytes);
  writeFileSync(`${outputPath}.sha256`, `${outputSha256}\n`, { mode: 0o600 });

  console.log(
    JSON.stringify({
      format: FORMAT,
      result: "pass",
      output: outputPath,
      sha256: outputSha256,
      eventCount: events.length,
      privateBackupFiles: backup.fileCount,
    }),
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`THREADPROOF_PRODUCTION_RECOVERY_FAIL: ${message}`);
  process.exitCode = 1;
}
