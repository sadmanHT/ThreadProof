#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const wrapper = path.join(root, "scripts", "production-recovery-verify.mjs");
const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

function run(args) {
  return spawnSync(process.execPath, [wrapper, ...args], { cwd: root, encoding: "utf8" });
}

const mismatch = run(["--source-commit", "d".repeat(40)]);
assert.notEqual(mismatch.status, 0);
assert.match(mismatch.stderr, /source commit does not match the checked-out Git HEAD/i);

const matching = run(["--source-commit", gitHead]);
assert.notEqual(matching.status, 0);
assert.doesNotMatch(matching.stderr, /does not match the checked-out Git HEAD/i);
assert.match(matching.stderr, /--backup-dir is required/i);

const workspace = mkdtempSync(path.join(tmpdir(), "threadproof-recovery-source-"));
try {
  const realBackup = path.join(workspace, "real-backup");
  const backupLink = path.join(workspace, "backup-link");
  const restored = path.join(workspace, "restored");
  mkdirSync(realBackup);
  mkdirSync(restored);
  symlinkSync(realBackup, backupLink);

  const symlinkRoot = run([
    "--source-commit",
    gitHead,
    "--backup-dir",
    backupLink,
    "--restored-private-dir",
    restored,
  ]);
  assert.notEqual(symlinkRoot.status, 0);
  assert.match(symlinkRoot.stderr, /--backup-dir must not be a symbolic link/i);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log("THREADPROOF_PRODUCTION_RECOVERY_SOURCE_BINDING_TESTS_PASS");
