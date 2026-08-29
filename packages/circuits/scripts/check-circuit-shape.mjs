import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../circuits/CapacitySpend.circom", import.meta.url), "utf8");

const requiredFragments = [
  "newCapacity === previousCapacity - orderWorkload",
  "feasible.out === 1",
  "oldCommit.out === oldCapacityCommitment",
  "nextCommit.out === newCapacityCommitment",
  "orderHash.out === orderCommitment",
  "nullifierHash.out === nullifier",
  "component previousBits = Num2Bits(64)",
  "component workloadBits = Num2Bits(64)",
  "component newBits = Num2Bits(64)",
];

const missing = requiredFragments.filter((fragment) => !source.includes(fragment));
if (missing.length > 0) {
  console.error("CapacitySpend circuit is missing required invariant fragments:");
  for (const fragment of missing) console.error(` - ${fragment}`);
  process.exit(1);
}

console.log("CapacitySpend circuit shape check passed.");
