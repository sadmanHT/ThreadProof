#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PILOT_DIR = join(REPO_ROOT, "infrastructure", "besu", "pilot");
const COMPOSE_FILE = join(PILOT_DIR, "docker-compose.yml");
const EVIDENCE_PATH = join(PILOT_DIR, "runtime", "qbft-fault-resilience.json");
const EVIDENCE_CHECKSUM_PATH = `${EVIDENCE_PATH}.sha256`;
const RPC_URL = "http://127.0.0.1:8545";
const EXPECTED_CHAIN_ID = 2026;
const EXPECTED_VALIDATORS = 5;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.${detail}`);
  }
  return result.stdout ?? "";
}

function compose(...args) {
  return run("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: PILOT_DIR,
    capture: true,
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function blockNumber() {
  return Number(BigInt(await rpc("eth_blockNumber")));
}

async function assertPilotIdentity() {
  const chainId = Number(BigInt(await rpc("eth_chainId")));
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Fault harness connected to chain ${chainId}; expected ${EXPECTED_CHAIN_ID}.`);
  }
  const validators = await rpc("qbft_getValidatorsByBlockNumber", ["latest"]);
  if (!Array.isArray(validators) || validators.length !== EXPECTED_VALIDATORS) {
    throw new Error(
      `QBFT reports ${Array.isArray(validators) ? validators.length : "invalid"} validators; expected ${EXPECTED_VALIDATORS}.`,
    );
  }
  return { chainId, validatorCount: validators.length };
}

async function waitForAdvance(fromBlock, minimumDelta, timeoutMs, label) {
  const startedAt = Date.now();
  let latest = fromBlock;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await blockNumber();
    if (latest >= fromBlock + minimumDelta) {
      return { fromBlock, toBlock: latest, elapsedMs: Date.now() - startedAt };
    }
    await sleep(1_000);
  }
  throw new Error(
    `${label} did not advance by ${minimumDelta} block(s) within ${timeoutMs}ms; ` +
      `started at ${fromBlock}, latest ${latest}.`,
  );
}

async function proveStall(settleMs = 12_000, observationMs = 20_000) {
  // Let any already-prepared round finish before measuring the no-quorum window.
  await sleep(settleMs);
  const stalledAt = await blockNumber();
  const chainIdDuringStall = Number(BigInt(await rpc("eth_chainId")));
  const startedAt = Date.now();
  await sleep(observationMs);
  const observedAt = await blockNumber();
  if (observedAt !== stalledAt) {
    throw new Error(
      `Expected QBFT to stop without quorum, but height advanced from ${stalledAt} to ${observedAt} ` +
        `during the ${observationMs}ms observation window.`,
    );
  }
  return {
    settleMs,
    observationMs: Date.now() - startedAt,
    stalledBlock: stalledAt,
    observedBlock: observedAt,
    rpcResponsive: chainIdDuringStall === EXPECTED_CHAIN_ID,
  };
}

async function persistEvidence(evidence) {
  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(EVIDENCE_PATH, bytes, { mode: 0o644 });
  await writeFile(EVIDENCE_CHECKSUM_PATH, `${sha256}  ${basename(EVIDENCE_PATH)}\n`, { mode: 0o644 });
  return sha256;
}

async function main() {
  const identity = await assertPilotIdentity();
  const stopped = new Set();
  const evidence = {
    format: "threadproof-qbft-fault-resilience/v1",
    chainId: identity.chainId,
    configuredValidatorCount: identity.validatorCount,
    sourceCommit: process.env.GITHUB_SHA || null,
    startedAt: new Date().toISOString(),
    faultModel: {
      oneValidatorUnavailable: "network must remain live with 4/5 validators",
      twoValidatorsUnavailable: "network must fail closed with 3/5 validators while RPC may remain responsive",
      recovery: "restoring quorum must resume canonical block finalization",
    },
    observations: {},
  };

  try {
    const baseline = await blockNumber();
    evidence.observations.baseline = await waitForAdvance(baseline, 2, 30_000, "Healthy five-validator network");

    compose("stop", "validator5");
    stopped.add("validator5");
    const oneDownStart = await blockNumber();
    evidence.observations.oneValidatorDown = {
      stopped: ["validator5"],
      ...(await waitForAdvance(oneDownStart, 2, 45_000, "Four-of-five QBFT quorum")),
    };

    compose("stop", "validator4");
    stopped.add("validator4");
    evidence.observations.twoValidatorsDown = {
      stopped: ["validator4", "validator5"],
      ...(await proveStall()),
    };
    if (!evidence.observations.twoValidatorsDown.rpcResponsive) {
      throw new Error("Expected validator1 JSON-RPC to remain responsive during the no-quorum observation.");
    }

    compose("start", "validator4");
    stopped.delete("validator4");
    const recoveryStart = await blockNumber();
    evidence.observations.quorumRestored = {
      restarted: ["validator4"],
      ...(await waitForAdvance(recoveryStart, 2, 60_000, "QBFT recovery after quorum restoration")),
    };

    compose("start", "validator5");
    stopped.delete("validator5");
    const fullRecoveryStart = await blockNumber();
    evidence.observations.fullRecovery = {
      restarted: ["validator5"],
      ...(await waitForAdvance(fullRecoveryStart, 2, 45_000, "Five-validator recovery")),
    };

    evidence.completedAt = new Date().toISOString();
    evidence.result = "pass";
    const evidenceSha256 = await persistEvidence(evidence);
    console.log(`THREADPROOF_QBFT_FAULT_RESILIENCE ${JSON.stringify({ result: "pass", evidencePath: EVIDENCE_PATH, evidenceSha256, observations: evidence.observations })}`);
  } catch (error) {
    evidence.completedAt = new Date().toISOString();
    evidence.result = "fail";
    evidence.failure = error instanceof Error ? error.message : String(error);
    try {
      await persistEvidence(evidence);
    } catch (persistError) {
      console.error(`Could not persist failed fault-resilience evidence: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
    }
    throw error;
  } finally {
    // Never leave the disposable pilot intentionally degraded if an assertion fails.
    for (const validator of ["validator4", "validator5"]) {
      if (!stopped.has(validator)) continue;
      try {
        compose("start", validator);
      } catch (error) {
        console.error(`Could not restart ${validator} during fault-harness cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
