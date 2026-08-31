import { readFile } from "node:fs/promises";

const productionSubmitters = [
  "apps/worker/src/order-relayer.ts",
  "apps/worker/src/proof-submitter.ts",
];

for (const path of productionSubmitters) {
  const source = await readFile(path, "utf8");
  if (/privateKeyToAccount|THREADPROOF_RELAYER_PRIVATE_KEY/.test(source)) {
    throw new Error(`${path} must not load or derive an in-process relayer private key`);
  }
}

const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
const hostedPassword = ciWorkflow.match(/^\s*THREADPROOF_E2E_DEMO_PASSWORD:\s*(.+)$/m)?.[1]?.trim();
if (hostedPassword && !/^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/.test(hostedPassword)) {
  throw new Error("Hosted authenticated E2E passwords must be supplied through GitHub Actions secrets, never workflow literals");
}

const envSource = await readFile("apps/worker/src/env.ts", "utf8");
for (const required of [
  "Production workers must never receive a raw relayer private key",
  "proof generator must have transaction signing disabled",
]) {
  if (!envSource.toLowerCase().includes(required.toLowerCase())) {
    throw new Error(`Worker environment policy is missing required boundary: ${required}`);
  }
}

const signerSource = await readFile("apps/worker/src/signer.ts", "utf8");
for (const required of ["eth_chainId", "getAddresses", "Remote signer downstream chain ID"]) {
  if (!signerSource.includes(required)) {
    throw new Error(`Remote signer guard is missing ${required}`);
  }
}

const proofSubmitterSource = await readFile("apps/worker/src/proof-submitter.ts", "utf8");
for (const forbidden of ["private_capacity_openings", "capacity_allocations", "proof_job_private_state"]) {
  if (proofSubmitterSource.includes(forbidden)) {
    throw new Error(`Proof submitter must not directly finalize private mirror table ${forbidden}`);
  }
}
if (!proofSubmitterSource.includes("waiting for canonical event indexing")) {
  throw new Error("Proof submitter must leave successful spend reconciliation to canonical event indexing");
}

const compose = await readFile("infrastructure/besu/production/docker-compose.yml", "utf8");
for (const required of [
  "hyperledger/besu:26.8.0",
  "consensys/web3signer:26.4.2-distroless",
  "127.0.0.1:8545:8545",
  "127.0.0.1:8546:8546",
  "127.0.0.1:9000:9000",
]) {
  if (!compose.includes(required)) throw new Error(`Production Compose boundary is missing ${required}`);
}

const permissionsMount = /^\s*-\s+\$\{THREADPROOF_BESU_PERMISSIONS_PATH:-\.\/permissions_config\.toml\}:\/etc\/besu\/permissions_config\.toml:ro\s*$/m;
if (!permissionsMount.test(compose)) {
  throw new Error(
    "Production Compose must mount THREADPROOF_BESU_PERMISSIONS_PATH (default ./permissions_config.toml) read-only at /etc/besu/permissions_config.toml",
  );
}

if (/image:\s*[^\n]+:latest\b/.test(compose)) {
  throw new Error("Production blockchain images must never use a latest tag");
}

const besuConfig = await readFile("infrastructure/besu/production/besu-config.toml", "utf8");
for (const required of [
  "discovery-enabled=false",
  "permissions-nodes-config-file-enabled=true",
  'permissions-nodes-config-file="/etc/besu/permissions_config.toml"',
]) {
  if (!besuConfig.includes(required)) throw new Error(`Besu peer-admission boundary is missing ${required}`);
}

const kmsExample = await readFile(
  "infrastructure/besu/production/web3signer/aws-kms-key.example.yaml",
  "utf8",
);
for (const required of ['type: "aws-kms"', 'authenticationMode: "ENVIRONMENT"', "kmsKeyId:", "region:"]) {
  if (!kmsExample.includes(required)) throw new Error(`AWS KMS signer example is missing ${required}`);
}
if (/accessKeyId\s*:|secretAccessKey\s*:|sessionToken\s*:/.test(kmsExample)) {
  throw new Error("AWS KMS signer example must not encourage static cloud credentials");
}

const infraFiles = [
  "infrastructure/besu/production/docker-compose.yml",
  "infrastructure/besu/production/besu-config.toml",
  "infrastructure/besu/production/static-nodes.json",
  "infrastructure/besu/production/permissions_config.toml",
  "infrastructure/besu/production/web3signer/aws-kms-key.example.yaml",
];
for (const path of infraFiles) {
  const source = await readFile(path, "utf8");
  if (/0x[0-9a-fA-F]{64}/.test(source)) {
    throw new Error(`${path} contains a 32-byte hex literal; production infrastructure templates must not carry key material`);
  }
}

console.log("Production signing, spend recovery, Besu, and hosted E2E boundary checks passed");
