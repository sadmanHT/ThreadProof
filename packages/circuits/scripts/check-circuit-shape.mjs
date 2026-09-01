import { readFile } from "node:fs/promises";

const spendSource = await readFile(new URL("../circuits/CapacitySpend.circom", import.meta.url), "utf8");
const releaseSource = await readFile(new URL("../circuits/CapacityRelease.circom", import.meta.url), "utf8");

const spendFragments = [
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

const releaseFragments = [
  "restoredCapacity === currentCapacity + orderWorkload",
  "oldCommit.out === oldCapacityCommitment",
  "nextCommit.out === newCapacityCommitment",
  "orderHash.out === orderCommitment",
  "nullifierHash.out === nullifier",
  "component currentBits = Num2Bits(64)",
  "component workloadBits = Num2Bits(64)",
  "component restoredBits = Num2Bits(64)",
  "nullifierHash.inputs[3] <== 4",
];

const missingSpend = spendFragments.filter((fragment) => !spendSource.includes(fragment));
const missingRelease = releaseFragments.filter((fragment) => !releaseSource.includes(fragment));
if (missingSpend.length > 0 || missingRelease.length > 0) {
  if (missingSpend.length > 0) {
    console.error("CapacitySpend circuit is missing required invariant fragments:");
    for (const fragment of missingSpend) console.error(` - ${fragment}`);
  }
  if (missingRelease.length > 0) {
    console.error("CapacityRelease circuit is missing required invariant fragments:");
    for (const fragment of missingRelease) console.error(` - ${fragment}`);
  }
  process.exit(1);
}

console.log("CapacitySpend and CapacityRelease circuit shape checks passed.");
