import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL("../supabase/migrations/20260831171800_threadproof_capacity_allocation_event_binding.sql", import.meta.url),
  "utf8",
);
const workerChain = await readFile(new URL("../apps/worker/src/chain.ts", import.meta.url), "utf8");
const databaseTypes = await readFile(new URL("../apps/web/lib/database.types.ts", import.meta.url), "utf8");
const capacityPage = await readFile(new URL("../apps/web/app/app/capacity/[id]/page.tsx", import.meta.url), "utf8");

const requiredMigrationFragments = [
  "CapacityAllocationRecorded",
  "chain_allocation_id",
  "ca.chain_tx_hash = new.transaction_hash",
  "ca.nullifier = event_nullifier",
  "lower(opening.chain_state_key) = lower(event_state_key)",
  "lower(po.chain_order_id) = lower(event_order_id)",
  "lower(factory.chain_organization_id) = lower(event_factory_organization_id)",
];

for (const fragment of requiredMigrationFragments) {
  if (!migration.includes(fragment)) {
    throw new Error(`Capacity allocation event binding is missing required invariant: ${fragment}`);
  }
}

if (!workerChain.includes("event CapacityAllocationRecorded(")) {
  throw new Error("Worker protocol ABI no longer decodes CapacityAllocationRecorded.");
}

if (!databaseTypes.includes("chain_allocation_id: string | null;")) {
  throw new Error("Web database types no longer expose canonical capacity allocation ids.");
}

if (!capacityPage.includes("chain_allocation_id") || !capacityPage.includes("CapacityAllocationRecorded event binding")) {
  throw new Error("Capacity evidence UI no longer surfaces canonical allocation event binding state.");
}

console.log("Capacity allocation canonical-event binding guard passed.");
