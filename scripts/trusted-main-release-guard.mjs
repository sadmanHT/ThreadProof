#!/usr/bin/env node

const CANONICAL_REPOSITORY = "sadmanHT/ThreadProof";
const REQUIRED_WORKFLOWS = Object.freeze([
  ["ThreadProof CI", ".github/workflows/ci.yml"],
  ["ThreadProof Endgame Scorecard", ".github/workflows/endgame-scorecard.yml"],
  ["ThreadProof Live Pilot", ".github/workflows/pilot-live.yml"],
  ["ThreadProof Live PoFC", ".github/workflows/pofc-live.yml"],
  ["ThreadProof Live Subcontract", ".github/workflows/subcontract-live.yml"],
  ["ThreadProof Live Capacity Release", ".github/workflows/capacity-release-live.yml"],
  ["ThreadProof Clean-State Endgame", ".github/workflows/clean-state-endgame.yml"],
  ["ThreadProof Release Policy", ".github/workflows/release-policy.yml"],
  ["ThreadProof QBFT Fault Resilience", ".github/workflows/qbft-fault-resilience.yml"],
]);
const ALLOWED_RELEASE_DELTA = [
  /^release\/production-release\.json$/,
  /^CHANGELOG\.md$/,
  /^docs\/releases\/.+/,
];
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_20 = /^0x[0-9a-fA-F]{40}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FORBIDDEN_TEXT = /(todo|tbd|placeholder|replace[-_ ]?me|example|dummy|changeme)/i;

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function cleanText(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  requireValue(!FORBIDDEN_TEXT.test(value), `${label} contains placeholder text.`);
  return value.trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireHash32(value, label) {
  requireValue(typeof value === "string" && HEX_32.test(value), `${label} must be a 32-byte 0x-prefixed hash.`);
  requireValue(!/^0x0{64}$/i.test(value), `${label} must not be zero.`);
}

function requireSha256(value, label) {
  requireValue(typeof value === "string" && SHA256.test(value), `${label} must be a 64-character SHA-256 digest.`);
  requireValue(!/^0{64}$/i.test(value), `${label} must not be zero.`);
}

function requireAddress(value, label) {
  requireValue(typeof value === "string" && HEX_20.test(value), `${label} must be an EVM address.`);
  requireValue(!/^0x0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}

function requireHttpsUrl(value, label) {
  const text = cleanText(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${label} must be a valid URL.`);
  }
  requireValue(url.protocol === "https:", `${label} must use https.`);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function requireIsoDate(value, label) {
  const text = cleanText(value, label);
  requireValue(Number.isFinite(Date.parse(text)), `${label} must be an ISO-8601 timestamp.`);
}

function canonicalRunUrl(runId) {
  return `https://github.com/${CANONICAL_REPOSITORY}/actions/runs/${runId}`;
}

function validateManifest(manifest) {
  requireValue(isRecord(manifest), "release manifest must be a JSON object.");
  requireValue(manifest.schemaVersion === 1, "schemaVersion must equal 1.");

  const release = manifest.release;
  requireValue(isRecord(release), "release section is required.");
  const releaseVersion = cleanText(release.version, "release.version");
  requireValue(VERSION.test(releaseVersion), "release.version must be semantic version text such as v1.0.0.");
  requireValue(typeof release.sourceDevelopCommit === "string" && GIT_SHA.test(release.sourceDevelopCommit), "release.sourceDevelopCommit must be a full 40-character Git SHA.");
  requireValue(!/^0{40}$/i.test(release.sourceDevelopCommit), "release.sourceDevelopCommit must not be zero.");
  requireIsoDate(release.preparedAt, "release.preparedAt");
  cleanText(release.preparedBy, "release.preparedBy");

  const chain = manifest.chain;
  requireValue(isRecord(chain), "chain section is required.");
  requireValue(chain.chainId === 2026, "chain.chainId must equal 2026.");
  requireValue(Number.isInteger(chain.validatorCount) && chain.validatorCount >= 5, "chain.validatorCount must be at least 5.");
  cleanText(chain.networkName, "chain.networkName");
  requireHash32(chain.genesisHash, "chain.genesisHash");

  const requiredContracts = ["Registry", "CredentialRegistry", "OrderRegistry", "CapacityVault", "SubcontractGovernor", "ThreadProofCharter"];
  requireValue(Array.isArray(manifest.contracts), "contracts must be an array.");
  const contractNames = new Set();
  const contractAddresses = new Set();
  for (const contract of manifest.contracts) {
    requireValue(isRecord(contract), "every contract entry must be an object.");
    const name = cleanText(contract.name, "contracts[].name");
    requireValue(!contractNames.has(name), `contract ${name} is duplicated.`);
    const address = requireAddress(contract.address, `contract ${name} address`);
    requireValue(!contractAddresses.has(address), `contract address ${address} is reused.`);
    requireHash32(contract.runtimeCodeHash, `contract ${name} runtimeCodeHash`);
    contractNames.add(name);
    contractAddresses.add(address);
  }
  for (const name of requiredContracts) requireValue(contractNames.has(name), `required contract ${name} is missing.`);

  requireValue(isRecord(manifest.verifiers), "verifiers section is required.");
  for (const key of ["capacitySpend", "capacityRelease"]) {
    const verifier = manifest.verifiers[key];
    requireValue(isRecord(verifier), `verifiers.${key} is required.`);
    requireValue(Number.isInteger(verifier.circuitVersion) && verifier.circuitVersion >= 1, `verifiers.${key}.circuitVersion must be positive.`);
    requireAddress(verifier.address, `verifiers.${key}.address`);
    requireHash32(verifier.circuitArtifactHash, `verifiers.${key}.circuitArtifactHash`);
    requireHash32(verifier.verificationKeyHash, `verifiers.${key}.verificationKeyHash`);
    requireHash32(verifier.runtimeCodeHash, `verifiers.${key}.runtimeCodeHash`);
    requireValue(verifier.setup === "production-ceremony", `verifiers.${key}.setup must equal production-ceremony.`);
    requireHttpsUrl(verifier.ceremonyEvidenceUrl, `verifiers.${key}.ceremonyEvidenceUrl`);
    requireHash32(verifier.ceremonyEvidenceSha256, `verifiers.${key}.ceremonyEvidenceSha256`);
  }

  requireValue(isRecord(manifest.signing), "signing section is required.");
  requireValue(manifest.signing.mode === "remote-web3signer", "signing.mode must equal remote-web3signer.");
  requireValue(manifest.signing.kmsOrHsmBacked === true, "signing.kmsOrHsmBacked must be true.");
  cleanText(manifest.signing.keyCustodyDescription, "signing.keyCustodyDescription");

  const evidence = manifest.evidence;
  requireValue(isRecord(evidence), "evidence section is required.");
  requireHttpsUrl(evidence.cleanStateRunUrl, "evidence.cleanStateRunUrl");
  requireHttpsUrl(evidence.qbftFaultRunUrl, "evidence.qbftFaultRunUrl");
  requireSha256(evidence.qbftFaultEvidenceSha256, "evidence.qbftFaultEvidenceSha256");
  requireHttpsUrl(evidence.benchmarkBundleUrl, "evidence.benchmarkBundleUrl");
  requireSha256(evidence.benchmarkBundleSha256, "evidence.benchmarkBundleSha256");
  requireHttpsUrl(evidence.deploymentEvidenceUrl, "evidence.deploymentEvidenceUrl");
  requireSha256(evidence.deploymentManifestSha256, "evidence.deploymentManifestSha256");

  const controls = manifest.externalControls;
  requireValue(isRecord(controls), "externalControls section is required.");
  requireValue(controls.developBranchProtectionVerified === true, "develop branch protection/ruleset must be attested true.");
  requireValue(controls.mainBranchProtectionVerified === true, "main branch protection/ruleset must be attested true.");
  requireValue(controls.supabaseLeakedPasswordProtectionVerified === true, "Supabase leaked-password protection must be attested true.");
  requireIsoDate(controls.verifiedAt, "externalControls.verifiedAt");
  cleanText(controls.verifiedBy, "externalControls.verifiedBy");

  const approval = manifest.approval;
  requireValue(isRecord(approval), "approval section is required.");
  requireValue(approval.productionReleaseApproved === true, "approval.productionReleaseApproved must be true.");
  cleanText(approval.changeReference, "approval.changeReference");
  cleanText(approval.approvedBy, "approval.approvedBy");
  requireIsoDate(approval.approvedAt, "approval.approvedAt");

  return {
    sourceDevelopCommit: release.sourceDevelopCommit.toLowerCase(),
    cleanStateRunUrl: requireHttpsUrl(evidence.cleanStateRunUrl, "evidence.cleanStateRunUrl"),
    qbftFaultRunUrl: requireHttpsUrl(evidence.qbftFaultRunUrl, "evidence.qbftFaultRunUrl"),
  };
}

const repository = process.env.GITHUB_REPOSITORY?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const headSha = process.env.THREADPROOF_RELEASE_HEAD_SHA?.trim();
const baseSha = process.env.THREADPROOF_RELEASE_BASE_SHA?.trim();
const headRepo = process.env.THREADPROOF_RELEASE_HEAD_REPOSITORY?.trim();
const headRef = process.env.THREADPROOF_RELEASE_HEAD_REF?.trim();
const prNumber = Number(process.env.THREADPROOF_RELEASE_PR_NUMBER);
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

requireValue(repository === CANONICAL_REPOSITORY, `trusted guard must run in ${CANONICAL_REPOSITORY}.`);
requireValue(Boolean(token), "GITHUB_TOKEN is required.");
requireValue(typeof headSha === "string" && GIT_SHA.test(headSha), "release PR head SHA must be a full 40-character Git SHA.");
requireValue(typeof baseSha === "string" && GIT_SHA.test(baseSha), "release PR base SHA must be a full 40-character Git SHA.");
requireValue(headRepo === CANONICAL_REPOSITORY, "production release PR must originate from the canonical repository, not a fork.");
requireValue(typeof headRef === "string" && /^release\/[A-Za-z0-9._/-]+$/.test(headRef), "production release branch must use the release/ prefix.");
requireValue(Number.isSafeInteger(prNumber) && prNumber > 0, "release PR number is invalid.");

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ThreadProof-trusted-main-release-guard",
};

async function github(path) {
  const response = await fetch(`${apiBase}${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    fail(`GitHub API ${path} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function fetchCandidateManifest() {
  const payload = await github(`/repos/${CANONICAL_REPOSITORY}/contents/release/production-release.json?ref=${encodeURIComponent(headSha)}`);
  requireValue(payload?.type === "file" && payload?.encoding === "base64" && typeof payload?.content === "string", "release candidate manifest could not be read as a file at the exact PR head SHA.");
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8"));
  } catch (error) {
    fail(`release candidate manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return manifest;
}

async function compare(base, head, label) {
  const payload = await github(`/repos/${CANONICAL_REPOSITORY}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  requireValue(["ahead", "identical"].includes(payload?.status), `${label} must be an ancestor of or equal to ${head}; GitHub compare status was ${payload?.status ?? "missing"}.`);
  return payload;
}

async function fetchCanonicalRuns(sourceCommit) {
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await github(`/repos/${CANONICAL_REPOSITORY}/actions/runs?head_sha=${sourceCommit}&event=push&per_page=100&page=${page}`);
    requireValue(Number.isInteger(payload?.total_count) && Array.isArray(payload?.workflow_runs), "GitHub Actions response is malformed.");
    runs.push(...payload.workflow_runs);
    if (runs.length >= payload.total_count || payload.workflow_runs.length === 0) return runs;
  }
  fail("GitHub Actions evidence pagination exceeded 10 pages.");
}

function verifyCanonicalRuns(runs, sourceCommit, cleanStateRunUrl, qbftFaultRunUrl) {
  const selected = new Map();
  const usedIds = new Set();
  for (const [name, path] of REQUIRED_WORKFLOWS) {
    const candidates = runs
      .filter((run) =>
        run?.name === name &&
        run?.path === path &&
        run?.head_sha?.toLowerCase() === sourceCommit &&
        run?.head_branch === "develop" &&
        run?.event === "push" &&
        run?.status === "completed" &&
        run?.conclusion === "success" &&
        run?.repository?.full_name === CANONICAL_REPOSITORY,
      )
      .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
    requireValue(candidates.length > 0, `${name} has no successful canonical develop push run for ${sourceCommit}.`);
    const run = candidates[0];
    requireValue(Number.isSafeInteger(run.id) && run.id > 0, `${name} returned an invalid run id.`);
    requireValue(!usedIds.has(run.id), `workflow run ${run.id} is reused across evidence requirements.`);
    const expectedUrl = canonicalRunUrl(run.id);
    requireValue(requireHttpsUrl(run.html_url, `${name} html_url`) === expectedUrl, `${name} does not resolve to its canonical GitHub Actions URL.`);
    selected.set(name, run);
    usedIds.add(run.id);
  }
  requireValue(cleanStateRunUrl === canonicalRunUrl(selected.get("ThreadProof Clean-State Endgame").id), "manifest clean-state URL is not the canonical successful run for release.sourceDevelopCommit.");
  requireValue(qbftFaultRunUrl === canonicalRunUrl(selected.get("ThreadProof QBFT Fault Resilience").id), "manifest QBFT fault URL is not the canonical successful run for release.sourceDevelopCommit.");
  return selected;
}

try {
  const manifest = await fetchCandidateManifest();
  const { sourceDevelopCommit, cleanStateRunUrl, qbftFaultRunUrl } = validateManifest(manifest);

  await compare(sourceDevelopCommit, "develop", "release.sourceDevelopCommit");
  const releaseDelta = await compare(sourceDevelopCommit, headSha, "release.sourceDevelopCommit");
  requireValue(Array.isArray(releaseDelta.files), "GitHub compare did not return the release delta file list.");
  requireValue(releaseDelta.files.length < 300, "release delta reached GitHub's 300-file compare limit and cannot be proven complete.");
  requireValue(releaseDelta.files.length > 0, "release PR must contain a release-specific delta after the tested develop source.");
  for (const file of releaseDelta.files) {
    requireValue(typeof file?.filename === "string", "release delta contains a file without a filename.");
    requireValue(ALLOWED_RELEASE_DELTA.some((pattern) => pattern.test(file.filename)), `untested production delta after ${sourceDevelopCommit}: ${file.filename}`);
  }
  requireValue(releaseDelta.files.some((file) => file.filename === "release/production-release.json"), "release PR must add release/production-release.json after the tested develop source.");

  const mainBranch = await github(`/repos/${CANONICAL_REPOSITORY}/branches/main`);
  requireValue(mainBranch?.commit?.sha?.toLowerCase() === baseSha.toLowerCase(), "main moved during trusted release verification; rerun against the current target is required.");

  const pr = await github(`/repos/${CANONICAL_REPOSITORY}/pulls/${prNumber}`);
  requireValue(pr?.head?.sha?.toLowerCase() === headSha.toLowerCase(), "pull request head moved during trusted release verification; rerun is required.");
  requireValue(pr?.base?.ref === "main", "trusted release guard only accepts PRs targeting main.");
  requireValue(pr?.base?.sha?.toLowerCase() === baseSha.toLowerCase(), "pull request base moved during trusted release verification; rerun is required.");
  requireValue(pr?.draft === false, "production release PR must be marked ready for review.");
  requireValue(pr?.head?.repo?.full_name === CANONICAL_REPOSITORY, "release PR head repository changed or is not canonical.");
  requireValue(pr?.head?.ref === headRef, "release PR head ref changed during verification.");

  const runs = await fetchCanonicalRuns(sourceDevelopCommit);
  const selected = verifyCanonicalRuns(runs, sourceDevelopCommit, cleanStateRunUrl, qbftFaultRunUrl);

  console.log(`Trusted main release guard passed for PR #${prNumber}.`);
  console.log(`Release head: ${headSha}`);
  console.log(`Tested develop source: ${sourceDevelopCommit}`);
  console.log(`Verified canonical workflows: ${selected.size}`);
  console.log(`Release-only changed files: ${releaseDelta.files.length}`);
} catch (error) {
  console.error(`THREADPROOF_TRUSTED_MAIN_RELEASE_GUARD_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
