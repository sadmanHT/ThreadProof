#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { validateCompetitionDeploymentPlan } from "./competition-deployment-preflight.mjs";

const COMMON = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "THREADPROOF_RPC_URL",
  "THREADPROOF_CHAIN_ID",
  "THREADPROOF_DEPLOYMENT_ENV",
];
const CONTRACTS = [
  "THREADPROOF_REGISTRY_ADDRESS",
  "THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS",
  "THREADPROOF_ORDER_REGISTRY_ADDRESS",
  "THREADPROOF_CAPACITY_VAULT_ADDRESS",
  "THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS",
  "THREADPROOF_CHARTER_ADDRESS",
];
const REMOTE = ["THREADPROOF_SIGNER_MODE", "THREADPROOF_SIGNER_URL", "THREADPROOF_RELAYER_ADDRESS"];
const PROVER = [
  "THREADPROOF_CAPACITY_VAULT_ADDRESS",
  "THREADPROOF_CAPACITY_WASM_PATH",
  "THREADPROOF_CAPACITY_ZKEY_PATH",
  "THREADPROOF_DATA_KEY_BASE64",
  "THREADPROOF_FACTORY_SECRETS_JSON",
  "THREADPROOF_SIGNER_MODE",
];

function service(id, hostClass, command, signerMode, environmentNames) {
  return { id, hostClass, command, deploymentEnvironment: "staging", signerMode, environmentNames };
}

function validPlan() {
  return {
    format: "threadproof-competition-deployment/v1",
    deploymentClass: "competition-demo",
    sourceCommit: "1234567890abcdef1234567890abcdef12345678",
    chain: { chainId: 2026, consensus: "qbft", deployment: "disposable-demo", canonicalAuthority: "on-chain" },
    services: [
      service("web-api", "web-serverless", "pnpm --filter @threadproof/web start", "none", [
        "NEXT_PUBLIC_APP_URL",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "THREADPROOF_RPC_URL",
        "THREADPROOF_CHAIN_ID",
        "NEXT_PUBLIC_THREADPROOF_CHAIN_ID",
        ...CONTRACTS,
      ]),
      service("event-indexer", "long-running-node", "pnpm --filter @threadproof/worker index", "disabled", [
        ...COMMON,
        ...CONTRACTS,
        "THREADPROOF_SIGNER_MODE",
      ]),
      service("order-relayer", "long-running-node", "pnpm --filter @threadproof/worker relay:orders", "remote", [
        ...COMMON,
        "THREADPROOF_REGISTRY_ADDRESS",
        "THREADPROOF_ORDER_REGISTRY_ADDRESS",
        ...REMOTE,
      ]),
      service("subcontract-relayer", "long-running-node", "pnpm --filter @threadproof/worker relay:subcontracts", "remote", [
        ...COMMON,
        "THREADPROOF_REGISTRY_ADDRESS",
        "THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS",
        "THREADPROOF_ORDER_REGISTRY_ADDRESS",
        "THREADPROOF_CAPACITY_VAULT_ADDRESS",
        "THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS",
        ...REMOTE,
      ]),
      service("capacity-spend-proof-generator", "long-running-node", "pnpm --filter @threadproof/worker proof", "disabled", [
        ...COMMON,
        ...PROVER,
      ]),
      service("capacity-spend-submitter", "long-running-node", "pnpm --filter @threadproof/worker submit:proofs", "remote", [
        ...COMMON,
        "THREADPROOF_CAPACITY_VAULT_ADDRESS",
        ...REMOTE,
      ]),
      service("capacity-release-proof-generator", "long-running-node", "pnpm --filter @threadproof/worker release:proof", "disabled", [
        ...COMMON,
        ...PROVER,
      ]),
      service("capacity-release-submitter", "long-running-node", "pnpm --filter @threadproof/worker submit:releases", "remote", [
        ...COMMON,
        "THREADPROOF_CAPACITY_VAULT_ADDRESS",
        ...REMOTE,
      ]),
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

function byId(plan, id) {
  return plan.services.find((serviceProfile) => serviceProfile.id === id);
}

function expectFailure(name, mutate, expectedText) {
  const plan = clone(validPlan());
  mutate(plan);
  let error;
  try {
    validateCompetitionDeploymentPlan(plan);
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(`${name}: expected validation to fail.`);
  if (!String(error.message).includes(expectedText)) {
    throw new Error(`${name}: expected error containing ${JSON.stringify(expectedText)}, got ${JSON.stringify(error.message)}.`);
  }
}

const positive = validateCompetitionDeploymentPlan(validPlan());
if (positive.services.length !== 8 || positive.chainId !== 2026) throw new Error("positive competition deployment fixture did not validate as expected.");

expectFailure("web witness secret", (plan) => {
  byId(plan, "web-api").environmentNames.push("THREADPROOF_DATA_KEY_BASE64");
}, "may only be assigned to proof-generator roles");

expectFailure("generator signing authority", (plan) => {
  const generator = byId(plan, "capacity-spend-proof-generator");
  generator.signerMode = "remote";
  generator.environmentNames.push("THREADPROOF_SIGNER_URL", "THREADPROOF_RELAYER_ADDRESS");
}, "signerMode must equal disabled");

expectFailure("submitter raw private key", (plan) => {
  byId(plan, "capacity-spend-submitter").environmentNames.push("THREADPROOF_RELAYER_PRIVATE_KEY");
}, "must never receive raw private-key");

expectFailure("wrong chain", (plan) => {
  plan.chain.chainId = 1;
}, "pin chainId 2026");

expectFailure("missing order contract", (plan) => {
  const relayer = byId(plan, "order-relayer");
  relayer.environmentNames = relayer.environmentNames.filter((name) => name !== "THREADPROOF_ORDER_REGISTRY_ADDRESS");
}, "missing required environment variable THREADPROOF_ORDER_REGISTRY_ADDRESS");

expectFailure("placeholder source", (plan) => {
  plan.sourceCommit = "REPLACE_ME_WITH_SOURCE_COMMIT";
}, "contains placeholder text");

expectFailure("identity key on release generator", (plan) => {
  byId(plan, "capacity-release-proof-generator").environmentNames.push("IDENTITY_ENCRYPTION_KEY");
}, "must not receive IDENTITY_ENCRYPTION_KEY");

expectFailure("unknown host variable", (plan) => {
  byId(plan, "event-indexer").environmentNames.push("UNREVIEWED_HOST_SECRET");
}, "is not permitted to receive environment variable UNREVIEWED_HOST_SECRET");

expectFailure("missing role", (plan) => {
  plan.services.pop();
}, "services must contain exactly 8 role profiles");

expectFailure("production label", (plan) => {
  plan.chain.deployment = "production";
}, "disposable-demo");

const example = JSON.parse(await readFile("deployment/competition-deployment.example.json", "utf8"));
let exampleFailed = false;
try {
  validateCompetitionDeploymentPlan(example);
} catch {
  exampleFailed = true;
}
if (!exampleFailed) throw new Error("competition deployment example must remain intentionally non-runnable until operators replace placeholders.");

console.log("Competition deployment preflight policy and adversarial regressions passed");
