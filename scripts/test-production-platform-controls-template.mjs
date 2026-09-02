#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const template = path.join(root, "release/production-platform-controls-evidence.example.json");
const validator = path.join(root, "scripts/production-platform-controls-evidence.mjs");

let parsed;
try {
  parsed = JSON.parse(readFileSync(template, "utf8"));
} catch (error) {
  throw new Error(`Production platform-controls evidence example must remain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const serialized = JSON.stringify(parsed);
if (!serialized.includes("REPLACE_ME")) {
  throw new Error("Production platform-controls evidence example must retain explicit REPLACE_ME placeholders.");
}

const result = spawnSync(process.execPath, [validator, template], {
  cwd: root,
  encoding: "utf8",
});
if (result.status === 0) {
  throw new Error("Production platform-controls evidence example unexpectedly passed the production validator.");
}
const output = `${result.stdout}\n${result.stderr}`;
if (!/placeholder|must equal pass|must be semantic version/i.test(output)) {
  throw new Error(`Production platform-controls evidence example failed for an unexpected reason.\n${output}`);
}

console.log("Production platform-controls evidence example is valid JSON and intentionally non-runnable.");
