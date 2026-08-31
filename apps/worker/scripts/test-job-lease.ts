import assert from "node:assert/strict";
import {
  WorkerClaimLostError,
  staleClaimCutoffIso,
  startClaimLease,
} from "../src/job-lease.js";

assert.equal(
  staleClaimCutoffIso(60, Date.parse("2026-09-01T00:01:00.000Z")),
  "2026-09-01T00:00:00.000Z",
);
assert.throws(() => staleClaimCutoffIso(0), /positive integer/);

let renewals = 0;
const owned = startClaimLease({
  heartbeatSeconds: 60,
  label: "proof job test",
  renew: async () => {
    renewals += 1;
    return true;
  },
});
await owned.renewNow();
owned.assertOwned();
assert.equal(renewals, 1);
owned.stop();
assert.throws(() => owned.assertOwned(), WorkerClaimLostError);

const lost = startClaimLease({
  heartbeatSeconds: 60,
  label: "lost job test",
  renew: async () => false,
});
await assert.rejects(() => lost.renewNow(), WorkerClaimLostError);
assert.throws(() => lost.assertOwned(), /no longer owned/);
lost.stop();

const failed = startClaimLease({
  heartbeatSeconds: 60,
  label: "database failure test",
  renew: async () => {
    throw new Error("database unavailable");
  },
});
await assert.rejects(() => failed.renewNow(), /could not be renewed safely/);
assert.throws(() => failed.assertOwned(), /database unavailable/);
failed.stop();

console.log("ThreadProof renewable worker claim lease checks passed");
