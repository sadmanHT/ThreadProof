#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lstatSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const engine = path.join(root, "scripts", "production-recovery-evidence.mjs");

function fail(message) {
  console.error(`THREADPROOF_PRODUCTION_RECOVERY_SOURCE_FAIL: ${message}`);
  process.exit(1);
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) fail(`${name} is required`);
  return argv[index + 1];
}

function checkedGit(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    fail("unable to verify the local Git checkout");
  }
}

const argv = process.argv.slice(2);
const sourceCommit = argumentValue(argv, "--source-commit").toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceCommit) || /^0{40}$/.test(sourceCommit)) {
  fail("source commit must be a non-zero 40-character Git SHA");
}

const gitHead = checkedGit(["rev-parse", "HEAD"]).toLowerCase();
if (gitHead !== sourceCommit) {
  fail("source commit does not match the checked-out Git HEAD");
}

const trackedStatus = checkedGit(["status", "--porcelain", "--untracked-files=no"]);
if (trackedStatus) {
  fail("tracked source checkout is not clean");
}

for (const name of ["--backup-dir", "--restored-private-dir"]) {
  const candidate = path.resolve(argumentValue(argv, name));
  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch {
    fail(`${name} does not exist`);
  }
  if (metadata.isSymbolicLink()) fail(`${name} must not be a symbolic link`);
  if (!metadata.isDirectory()) fail(`${name} must be a directory`);
}

const result = spawnSync(process.execPath, [engine, ...argv], {
  cwd: root,
  encoding: "utf8",
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);

const output = path.resolve(argumentValue(argv, "--output"));
try {
  chmodSync(output, 0o600);
  chmodSync(`${output}.sha256`, 0o600);
} catch {
  fail("unable to enforce mode 0600 on recovery evidence output");
}
