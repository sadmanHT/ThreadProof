#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKFLOW_DIR = resolve(REPO_ROOT, ".github", "workflows");

const requiredMajors = new Map([
  ["actions/checkout", "v7"],
  ["actions/setup-node", "v7"],
  ["actions/upload-artifact", "v7"],
  ["pnpm/action-setup", "v6"],
]);

const workflowFiles = (await readdir(WORKFLOW_DIR))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const violations = [];
const seen = new Set();

for (const file of workflowFiles) {
  const source = await readFile(resolve(WORKFLOW_DIR, file), "utf8");
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)) {
    const ref = match[1];
    const at = ref.lastIndexOf("@");
    if (at <= 0) continue;
    const action = ref.slice(0, at);
    const version = ref.slice(at + 1);
    const expectedMajor = requiredMajors.get(action);
    if (!expectedMajor) continue;
    seen.add(action);
    if (version !== expectedMajor) {
      violations.push(`${file}: ${action}@${version} must use ${action}@${expectedMajor}`);
    }
  }
}

for (const action of requiredMajors.keys()) {
  if (!seen.has(action)) {
    violations.push(`No workflow references guarded action ${action}; update this policy if the action was intentionally removed.`);
  }
}

if (violations.length > 0) {
  console.error("GitHub Action runtime policy failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `GitHub Action runtime policy passed across ${workflowFiles.length} workflow file(s): ` +
    [...requiredMajors.entries()].map(([action, major]) => `${action}@${major}`).join(", "),
);
