#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const COMPETITION_DEPLOYMENT_FORMAT = "threadproof-competition-deployment/v1";
export const COMPETITION_CHAIN_ID = 2026;

const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]+$/;
const PLACEHOLDER = /(replace[_ -]?me|placeholder|changeme|dummy|\btbd\b|\btodo\b)/i;

const COMMON_WORKER = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "THREADPROOF_RPC_URL",
  "THREADPROOF_CHAIN_ID",
  "THREADPROOF_DEPLOYMENT_ENV",
];
const WORKER_OPTIONAL = [
  "THREADPROOF_WORKER_LEASE_SECONDS",
  "THREADPROOF_WORKER_HEARTBEAT_SECONDS",
  "THREADPROOF_WORKER_HEARTBEAT_INTERVAL_MS",
  "SENTRY_DSN",
];
const REMOTE_SIGNER = [
  "THREADPROOF_SIGNER_MODE",
  "THREADPROOF_SIGNER_URL",
  "THREADPROOF_RELAYER_ADDRESS",
];
const DISABLED_SIGNER = ["THREADPROOF_SIGNER_MODE"];
const CAPACITY_PROVER = [
  "THREADPROOF_CAPACITY_VAULT_ADDRESS",
  "THREADPROOF_CAPACITY_WASM_PATH",
  "THREADPROOF_CAPACITY_ZKEY_PATH",
  "THREADPROOF_DATA_KEY_BASE64",
  "THREADPROOF_FACTORY_SECRETS_JSON",
];
const CAPACITY_PROVER_OPTIONAL = ["THREADPROOF_CAPACITY_VKEY_PATH"];
const ALL_CONTRACTS = [
  "THREADPROOF_REGISTRY_ADDRESS",
  "THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS",
  "THREADPROOF_ORDER_REGISTRY_ADDRESS",
  "THREADPROOF_CAPACITY_VAULT_ADDRESS",
  "THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS",
  "THREADPROOF_CHARTER_ADDRESS",
];
const WEB_REQUIRED = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "THREADPROOF_RPC_URL",
  "THREADPROOF_CHAIN_ID",
  "NEXT_PUBLIC_THREADPROOF_CHAIN_ID",
  ...ALL_CONTRACTS,
];
const WEB_OPTIONAL = [
  "THREADPROOF_WS_URL",
  "THREADPROOF_CONFIRMATIONS",
  "THREADPROOF_CAPACITY_SPEND_VERIFIER_ADDRESS",
  "GEMINI_API_KEY",
  "THREADPROOF_AI_MODEL",
  "THREADPROOF_AI_THINKING_LEVEL",
  "THREADPROOF_AI_PROVIDER_TIER",
  "THREADPROOF_AI_MAX_RUNS_PER_MINUTE",
  "THREADPROOF_AI_ALLOW_CONFIDENTIAL",
  "SENTRY_DSN",
];

function profile({ hostClass, command, signerMode, required, optional = [] }) {
  return Object.freeze({
    hostClass,
    command,
    signerMode,
    requiredEnv: Object.freeze([...new Set(required)]),
    allowedEnv: Object.freeze([...new Set([...required, ...optional])]),
  });
}

export const COMPETITION_SERVICE_POLICIES = Object.freeze({
  "web-api": profile({
    hostClass: "web-serverless",
    command: "pnpm --filter @threadproof/web start",
    signerMode: "none",
    required: WEB_REQUIRED,
    optional: WEB_OPTIONAL,
  }),
  "event-indexer": profile({
    hostClass: "long-running-node",
    command: "pnpm --filter @threadproof/worker index",
    signerMode: "disabled",
    required: [...COMMON_WORKER, ...ALL_CONTRACTS, ...DISABLED_SIGNER],
    optional: [
      ...WORKER_OPTIONAL,
      "THREADPROOF_CONFIRMATIONS",
      "THREADPROOF_INDEXER_START_BLOCK",
      "THREADPROOF_INDEXER_BLOCK_BATCH",
    ],
  }),
  "order-relayer": profile({
    hostClass: "long-running-node",
    command: "pnpm --filter @threadproof/worker relay:orders",
    signerMode: "remote",
    required: [
      ...COMMON_WORKER,
      "THREADPROOF_REGISTRY_ADDRESS",
      "THREADPROOF_ORDER_REGISTRY_ADDRESS",
      ...REMOTE_SIGNER,
    ],
    optional: WORKER_OPTIONAL,
  }),
  "subcontract-relayer": profile({
    hostClass: "long-running-node",
    command: "pnpm --filter @threadproof/worker relay:subcontracts",
    signerMode: "remote",
    required: [
      ...COMMON_WORKER,
      "THREADPROOF_REGISTRY_ADDRESS",
      "THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS",
      "THREADPROOF_ORDER_REGISTRY_ADDRESS",
      "THREADPROOF_CAPACITY_VAULT_ADDRESS",
      "THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS",
      ...REMOTE_SIGNER,
    ],
    optional: WORKER_OPTIONAL,
  }),
  "capacity-spend-proof-generator": profile({
    hostClass: "long-running-node",
    command: "pnpm --filter @threadproof/worker proof",
    signerMode: "disabled",
    required: [...COMMON_WORKER, ...CAPACITY_PROVER, ...DISABLED_SIGNER],
    optional: [...WORKER_OPTIONAL, ...CAPACITY_PROVER_OPTIONAL],
  }),
  "capacity-spend-submitter": profile({
    hostClass: "long-running-node",
    command: "pnpm --filter @threadproof/worker submit:proofs",
    signerMode: "remote",
    required: [...COMMON_WORKER, "THREADPROOF_CAPACITY_VAULT_ADDRESS", ...REMOTE_SIGNER],
    optional: WORKER_OPTIONAL,
  }),
  "capacity-release-proof-generator": profile({
    hostClass: "long-running-node",
    command: "pnpm --filter @threadproof/worker release:proof",
    signerMode: "disabled",
    required: [...COMMON_WORKER, ...CAPACITY_PROVER, ...DISABLED_SIGNER],
    optional: [...WORKER_OPTIONAL, ...CAPACITY_PROVER_OPTIONAL],
  }),
  "capacity-release-submitter": profile({
    hostClass: "long-running-node",
    command: "pnpm --filter @threadproof/worker submit:releases",
    signerMode: "remote",
    required: [...COMMON_WORKER, "THREADPROOF_CAPACITY_VAULT_ADDRESS", ...REMOTE_SIGNER],
    optional: WORKER_OPTIONAL,
  }),
});

const REQUIRED_SERVICE_IDS = Object.freeze(Object.keys(COMPETITION_SERVICE_POLICIES));
const WITNESS_ENV = new Set(["THREADPROOF_DATA_KEY_BASE64", "THREADPROOF_FACTORY_SECRETS_JSON"]);
const WITNESS_ROLES = new Set(["capacity-spend-proof-generator", "capacity-release-proof-generator"]);
const FORBIDDEN_ALL_ROLES = new Set([
  "PRIVATE_DATA_ENCRYPTION_KEY",
  "IDENTITY_ENCRYPTION_KEY",
  "SENTRY_AUTH_TOKEN",
]);

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, allowed, label) {
  const keys = Object.keys(value);
  for (const key of keys) requireValue(allowed.has(key), `${label}.${key} is not allowed.`);
}

function scanPlaceholders(value, path = "plan") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPlaceholders(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) scanPlaceholders(child, `${path}.${key}`);
    return;
  }
  if (typeof value === "string") requireValue(!PLACEHOLDER.test(value), `${path} contains placeholder text.`);
}

function validateEnvironmentNames(service, policy) {
  requireValue(Array.isArray(service.environmentNames), `${service.id}.environmentNames must be an array.`);
  const names = new Set();
  for (const name of service.environmentNames) {
    requireValue(typeof name === "string" && ENV_NAME.test(name), `${service.id} contains invalid environment variable name ${String(name)}.`);
    requireValue(!names.has(name), `${service.id} duplicates environment variable ${name}.`);
    requireValue(!/_PRIVATE_KEY$/.test(name), `${service.id} must never receive raw private-key environment variable ${name}.`);
    requireValue(!FORBIDDEN_ALL_ROLES.has(name), `${service.id} must not receive ${name}; that secret belongs outside the competition service profile.`);
    if (WITNESS_ENV.has(name)) {
      requireValue(WITNESS_ROLES.has(service.id), `${name} may only be assigned to proof-generator roles.`);
    }
    requireValue(policy.allowedEnv.includes(name), `${service.id} is not permitted to receive environment variable ${name}.`);
    names.add(name);
  }
  for (const required of policy.requiredEnv) {
    requireValue(names.has(required), `${service.id} is missing required environment variable ${required}.`);
  }
  return names;
}

export function validateCompetitionDeploymentPlan(plan) {
  requireValue(isRecord(plan), "competition deployment plan must be a JSON object.");
  requireExactKeys(plan, new Set(["format", "deploymentClass", "sourceCommit", "chain", "services"]), "plan");
  scanPlaceholders(plan);

  requireValue(plan.format === COMPETITION_DEPLOYMENT_FORMAT, `format must equal ${COMPETITION_DEPLOYMENT_FORMAT}.`);
  requireValue(plan.deploymentClass === "competition-demo", "deploymentClass must equal competition-demo.");
  requireValue(typeof plan.sourceCommit === "string" && GIT_SHA.test(plan.sourceCommit) && !/^0{40}$/i.test(plan.sourceCommit), "sourceCommit must be a non-zero full 40-character Git SHA.");

  requireValue(isRecord(plan.chain), "chain is required.");
  requireExactKeys(plan.chain, new Set(["chainId", "consensus", "deployment", "canonicalAuthority"]), "chain");
  requireValue(plan.chain.chainId === COMPETITION_CHAIN_ID, `competition deployment must pin chainId ${COMPETITION_CHAIN_ID}.`);
  requireValue(plan.chain.consensus === "qbft", "competition chain consensus must equal qbft.");
  requireValue(plan.chain.deployment === "disposable-demo", "competition plan must describe the chain as disposable-demo, not production.");
  requireValue(plan.chain.canonicalAuthority === "on-chain", "canonicalAuthority must equal on-chain.");

  requireValue(Array.isArray(plan.services), "services must be an array.");
  requireValue(plan.services.length === REQUIRED_SERVICE_IDS.length, `services must contain exactly ${REQUIRED_SERVICE_IDS.length} role profiles.`);

  const seen = new Set();
  const summaries = [];
  for (const service of plan.services) {
    requireValue(isRecord(service), "each service profile must be an object.");
    requireExactKeys(service, new Set(["id", "hostClass", "command", "deploymentEnvironment", "signerMode", "environmentNames"]), "service");
    requireValue(typeof service.id === "string" && COMPETITION_SERVICE_POLICIES[service.id], `unknown competition service id ${String(service.id)}.`);
    requireValue(!seen.has(service.id), `service ${service.id} is duplicated.`);
    seen.add(service.id);

    const policy = COMPETITION_SERVICE_POLICIES[service.id];
    requireValue(service.hostClass === policy.hostClass, `${service.id}.hostClass must equal ${policy.hostClass}.`);
    requireValue(service.command === policy.command, `${service.id}.command must equal the audited package command.`);
    requireValue(service.deploymentEnvironment === "staging", `${service.id}.deploymentEnvironment must equal staging for the competition deployment.`);
    requireValue(service.signerMode === policy.signerMode, `${service.id}.signerMode must equal ${policy.signerMode}.`);
    const envNames = validateEnvironmentNames(service, policy);

    if (service.signerMode === "remote") {
      requireValue(envNames.has("THREADPROOF_SIGNER_URL") && envNames.has("THREADPROOF_RELAYER_ADDRESS"), `${service.id} remote signing requires signer URL and public relayer address.`);
    } else {
      requireValue(!envNames.has("THREADPROOF_SIGNER_URL") && !envNames.has("THREADPROOF_RELAYER_ADDRESS"), `${service.id} must not receive remote transaction-signer authority.`);
    }

    if (WITNESS_ROLES.has(service.id)) {
      requireValue(envNames.has("THREADPROOF_DATA_KEY_BASE64") && envNames.has("THREADPROOF_FACTORY_SECRETS_JSON"), `${service.id} must explicitly declare its private witness inputs.`);
      requireValue(service.signerMode === "disabled", `${service.id} must have transaction signing disabled.`);
    } else {
      for (const witnessName of WITNESS_ENV) requireValue(!envNames.has(witnessName), `${service.id} must not receive ${witnessName}.`);
    }

    summaries.push({ id: service.id, hostClass: service.hostClass, signerMode: service.signerMode, envCount: envNames.size });
  }

  for (const requiredId of REQUIRED_SERVICE_IDS) requireValue(seen.has(requiredId), `services is missing required role ${requiredId}.`);

  return {
    format: plan.format,
    deploymentClass: plan.deploymentClass,
    sourceCommit: plan.sourceCommit.toLowerCase(),
    chainId: plan.chain.chainId,
    services: summaries,
  };
}

async function runCli() {
  const input = process.argv[2];
  requireValue(Boolean(input), "usage: node scripts/competition-deployment-preflight.mjs <sanitized-plan.json>");
  const absolute = resolve(input);
  const plan = JSON.parse(await readFile(absolute, "utf8"));
  const summary = validateCompetitionDeploymentPlan(plan);
  console.log(JSON.stringify(summary, null, 2));
  console.log("Competition deployment preflight passed. This validates role/secret boundaries only; it does not prove hosting, validator independence, production ceremony, or production readiness.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`THREADPROOF_COMPETITION_DEPLOYMENT_PREFLIGHT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
