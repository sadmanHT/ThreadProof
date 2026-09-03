#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const template = path.join(root, "release/production-verifier-governance-evidence.example.json");

let parsed;
try {
  parsed = JSON.parse(readFileSync(template, "utf8"));
} catch (error) {
  throw new Error(`Production verifier-governance evidence example must remain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const serialized = JSON.stringify(parsed);
if (!serialized.includes("REPLACE_ME")) {
  throw new Error("Production verifier-governance evidence example must retain explicit REPLACE_ME placeholders.");
}

const validatorSource = readFileSync(path.join(root, "scripts/production-verifier-governance-evidence.mjs"), "utf8");
if (!validatorSource.includes("threadproof-production-verifier-governance/v1")) {
  throw new Error("Production verifier-governance validator format marker is missing.");
}

console.log("Production verifier-governance evidence example is valid JSON and intentionally non-runnable.");
