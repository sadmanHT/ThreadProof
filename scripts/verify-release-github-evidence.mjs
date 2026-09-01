#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  THREADPROOF_REPOSITORY,
  verifyCanonicalWorkflowEvidence,
} from "./release-github-evidence.mjs";

function fail(message) {
  console.error(`Production GitHub evidence verification failed: ${message}`);
  process.exit(1);
}

const manifestPath = path.resolve(
  process.cwd(),
  process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json",
);

if (!existsSync(manifestPath)) {
  fail(`missing ${path.relative(process.cwd(), manifestPath)}.`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`release manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const sourceDevelopCommit = manifest?.release?.sourceDevelopCommit;
const cleanStateRunUrl = manifest?.evidence?.cleanStateRunUrl;
const qbftFaultRunUrl = manifest?.evidence?.qbftFaultRunUrl;
const repository = process.env.GITHUB_REPOSITORY ?? THREADPROOF_REPOSITORY;

if (repository !== THREADPROOF_REPOSITORY) {
  fail(`release verification must run in ${THREADPROOF_REPOSITORY}, received ${repository}.`);
}

const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
const token = process.env.GITHUB_TOKEN?.trim();
const [owner, repo] = repository.split("/");
const workflowRuns = [];
let page = 1;
let totalCount = Number.POSITIVE_INFINITY;

while (workflowRuns.length < totalCount) {
  if (page > 10) fail("workflow-run pagination exceeded the safety limit.");

  const url = new URL(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`);
  url.searchParams.set("head_sha", sourceDevelopCommit ?? "");
  url.searchParams.set("event", "push");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ThreadProof-production-readiness",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    fail(`GitHub Actions API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    fail(`GitHub Actions API returned HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    fail(`GitHub Actions API response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(payload?.workflow_runs) || !Number.isInteger(payload?.total_count)) {
    fail("GitHub Actions API response did not contain workflow_runs and total_count.");
  }

  totalCount = payload.total_count;
  workflowRuns.push(...payload.workflow_runs);
  if (payload.workflow_runs.length === 0) break;
  page += 1;
}

let verified;
try {
  verified = verifyCanonicalWorkflowEvidence({
    workflowRuns,
    sourceDevelopCommit,
    repository,
    cleanStateRunUrl,
    qbftFaultRunUrl,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`Verified ${verified.length} canonical develop push workflows for ${sourceDevelopCommit}.`);
for (const item of verified) {
  console.log(`- ${item.name}: ${item.url}`);
}
