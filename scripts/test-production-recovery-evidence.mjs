#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "production-recovery-evidence.mjs");
const workspace = mkdtempSync(path.join(tmpdir(), "threadproof-recovery-evidence-"));

const h32 = (char) => `0x${char.repeat(64)}`;
const h20 = (char) => `0x${char.repeat(40)}`;

const proposalId = h32("1");
const proposer = h32("2");
const actionHash = h32("3");
const metadataHash = h32("4");
const verifier = h20("5");
const circuitArtifactHash = h32("6");
const verificationKeyHash = h32("7");
const verifierCodeHash = h32("8");
const charterAddress = h20("9");
const vaultAddress = h20("a");

function event({ block, txChar, logIndex = 0, contractAddress = charterAddress, eventName, data }) {
  return {
    chain_id: 2026,
    block_number: block,
    block_hash: h32(String((block % 8) + 1)),
    transaction_hash: h32(txChar),
    log_index: logIndex,
    contract_address: contractAddress,
    event_name: eventName,
    data,
    observed_at: "2026-09-02T00:00:00.000Z",
  };
}

const events = [
  event({
    block: 100,
    txChar: "b",
    eventName: "ProposalCreated",
    data: {
      proposalId,
      proposalType: 5,
      proposerOrganizationId: proposer,
      policyVersion: "policy-v1",
      approvalsRequired: 2,
      actionHash,
      metadataHash,
      expiresAt: "1700001000",
    },
  }),
  event({
    block: 101,
    txChar: "c",
    eventName: "ProposalApprovalRecorded",
    data: {
      proposalId,
      approvalsReceived: 2,
      approvalsRequired: 2,
      approvalMask: 3,
    },
  }),
  event({
    block: 102,
    txChar: "d",
    eventName: "ProposalThresholdReached",
    data: {
      proposalId,
      approvedAt: "1700000200",
      executeAfter: "1700000300",
    },
  }),
  event({
    block: 103,
    txChar: "e",
    contractAddress: vaultAddress,
    eventName: "VerifierProvenanceRegistered",
    data: {
      circuitVersion: 1,
      verifier,
      circuitArtifactHash,
      verificationKeyHash,
      verifierCodeHash,
    },
  }),
  event({
    block: 104,
    txChar: "f",
    eventName: "ProposalExecuted",
    data: { proposalId },
  }),
];

const restoredReadModel = {
  format: "threadproof-restored-read-model/v1",
  governanceProposals: [
    {
      chain_proposal_id: proposalId,
      proposal_type: "charter_policy_update",
      proposer_chain_organization_id: proposer,
      policy_version: "policy-v1",
      approvals_required: 2,
      approvals_received: 2,
      state: "executed",
      execute_after: "2023-11-14T22:18:20.000Z",
      executed_tx_hash: h32("f"),
      last_synced_block: 104,
      action_hash: actionHash,
      metadata_hash: metadataHash,
      approval_mask: 3,
      expires_at: "2023-11-14T22:30:00.000Z",
      approved_at: "2023-11-14T22:16:40.000Z",
      updated_at: "2099-01-01T00:00:00.000Z",
      executed_at: "2099-01-01T00:00:00.000Z",
    },
  ],
  verifierProvenance: [
    {
      chain_id: 2026,
      circuit_version: 1,
      verifier_address: verifier,
      circuit_artifact_hash: circuitArtifactHash,
      verification_key_hash: verificationKeyHash,
      verifier_code_hash: verifierCodeHash,
      registration_tx_hash: h32("e"),
      contract_address: vaultAddress,
      registered_block: 103,
      observed_at: "2099-01-01T00:00:00.000Z",
    },
  ],
};

const eventsPath = path.join(workspace, "events.json");
const restoredPath = path.join(workspace, "restored-read-model.json");
const backupDir = path.join(workspace, "backup");
const restoredPrivateDir = path.join(workspace, "restored-private");
mkdirSync(path.join(backupDir, "openings"), { recursive: true });
mkdirSync(path.join(restoredPrivateDir, "openings"), { recursive: true });

const privateSentinel = "SUPER-PRIVATE-CAPACITY-123";
writeFileSync(path.join(backupDir, "openings", "capacity.enc"), Buffer.from(privateSentinel));
writeFileSync(path.join(restoredPrivateDir, "openings", "capacity.enc"), Buffer.from(privateSentinel));
writeFileSync(path.join(backupDir, "credential-package.enc"), Buffer.from("ciphertext-credential-package"));
writeFileSync(path.join(restoredPrivateDir, "credential-package.enc"), Buffer.from("ciphertext-credential-package"));
writeFileSync(eventsPath, `${JSON.stringify(events, null, 2)}\n`);
writeFileSync(restoredPath, `${JSON.stringify(restoredReadModel, null, 2)}\n`);

function run({
  eventsFile = eventsPath,
  restoredFile = restoredPath,
  backup = backupDir,
  restoredPrivate = restoredPrivateDir,
  sourceCommit = "a".repeat(40),
  outputName = "evidence.json",
} = {}) {
  const output = path.join(workspace, outputName);
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--events",
      eventsFile,
      "--restored-read-model",
      restoredFile,
      "--backup-dir",
      backup,
      "--restored-private-dir",
      restoredPrivate,
      "--source-commit",
      sourceCommit,
      "--chain-id",
      "2026",
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );
  return { ...result, output };
}

function expectFailure(result, messagePattern) {
  assert.notEqual(result.status, 0, "recovery verifier unexpectedly succeeded");
  assert.match(result.stderr, /THREADPROOF_PRODUCTION_RECOVERY_FAIL/);
  if (messagePattern) assert.match(result.stderr, messagePattern);
}

try {
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  const evidenceText = readFileSync(valid.output, "utf8");
  const evidence = JSON.parse(evidenceText);
  const checksum = readFileSync(`${valid.output}.sha256`, "utf8").trim();

  assert.equal(evidence.format, "threadproof-production-recovery-evidence/v1");
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.chainId, "2026");
  assert.equal(evidence.canonicalEventArchive.eventCount, 5);
  assert.equal(evidence.canonicalEventArchive.governanceEventCount, 4);
  assert.equal(evidence.canonicalEventArchive.verifierEventCount, 1);
  assert.equal(evidence.restoredReadModel.governanceRows, 1);
  assert.equal(evidence.restoredReadModel.verifierRows, 1);
  assert.equal(evidence.privateBackup.fileCount, 2);
  assert.equal(evidence.privateBackup.byteIdentical, true);
  assert.match(checksum, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(evidenceText, new RegExp(privateSentinel));
  assert.doesNotMatch(evidenceText, /capacity\.enc|credential-package\.enc/);
  assert.match(evidence.limitations.join(" "), /not reconstructed from chain events/i);

  const tamperedReadModelPath = path.join(workspace, "tampered-read-model.json");
  const tamperedReadModel = structuredClone(restoredReadModel);
  tamperedReadModel.governanceProposals[0].state = "timelocked";
  writeFileSync(tamperedReadModelPath, `${JSON.stringify(tamperedReadModel)}\n`);
  expectFailure(
    run({ restoredFile: tamperedReadModelPath, outputName: "tampered-read-model-evidence.json" }),
    /governance read model does not match/i,
  );

  const tamperedVerifierPath = path.join(workspace, "tampered-verifier.json");
  const tamperedVerifier = structuredClone(restoredReadModel);
  tamperedVerifier.verifierProvenance[0].verification_key_hash = h32("0");
  writeFileSync(tamperedVerifierPath, `${JSON.stringify(tamperedVerifier)}\n`);
  expectFailure(
    run({ restoredFile: tamperedVerifierPath, outputName: "tampered-verifier-evidence.json" }),
    /verifier provenance read model does not match/i,
  );

  writeFileSync(path.join(restoredPrivateDir, "openings", "capacity.enc"), Buffer.from("tampered-ciphertext"));
  expectFailure(run({ outputName: "tampered-private-evidence.json" }), /not byte-identical/i);
  writeFileSync(path.join(restoredPrivateDir, "openings", "capacity.enc"), Buffer.from(privateSentinel));

  const incompleteEventsPath = path.join(workspace, "incomplete-events.json");
  writeFileSync(incompleteEventsPath, `${JSON.stringify(events.slice(1))}\n`);
  expectFailure(run({ eventsFile: incompleteEventsPath, outputName: "incomplete-events-evidence.json" }), /before ProposalCreated/i);

  const duplicateEventsPath = path.join(workspace, "duplicate-events.json");
  writeFileSync(duplicateEventsPath, `${JSON.stringify([...events, events[0]])}\n`);
  expectFailure(run({ eventsFile: duplicateEventsPath, outputName: "duplicate-events-evidence.json" }), /duplicate transaction\/log identity/i);

  expectFailure(run({ sourceCommit: "deadbeef", outputName: "bad-source-evidence.json" }), /source commit/i);

  const symlinkBackup = path.join(workspace, "symlink-backup");
  mkdirSync(symlinkBackup, { recursive: true });
  writeFileSync(path.join(symlinkBackup, "real.enc"), Buffer.from("ciphertext"));
  symlinkSync(path.join(symlinkBackup, "real.enc"), path.join(symlinkBackup, "link.enc"));
  expectFailure(run({ backup: symlinkBackup, outputName: "symlink-evidence.json" }), /symbolic links/i);

  const emptyBackup = path.join(workspace, "empty-backup");
  mkdirSync(emptyBackup, { recursive: true });
  expectFailure(run({ backup: emptyBackup, outputName: "empty-backup-evidence.json" }), /at least one encrypted backup artifact/i);

  console.log("THREADPROOF_PRODUCTION_RECOVERY_EVIDENCE_TESTS_PASS");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
