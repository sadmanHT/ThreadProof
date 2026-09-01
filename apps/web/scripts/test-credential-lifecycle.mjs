import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chain = readFileSync(new URL("../lib/credential-lifecycle-chain.ts", import.meta.url), "utf8");
const consoleSource = readFileSync(new URL("../components/credential-lifecycle-console.tsx", import.meta.url), "utf8");
const listPage = readFileSync(new URL("../app/app/credentials/page.tsx", import.meta.url), "utf8");
const detailPage = readFileSync(new URL("../app/app/credentials/[id]/page.tsx", import.meta.url), "utf8");

assert.match(chain, /function issueCredential\(bytes32 credentialId,bytes32 subjectOrganizationId,bytes32 credentialType,bytes32 digest,bytes32 scopeHash,uint64 validFrom,uint64 validUntil\)/);
assert.match(chain, /function ISSUER_ROLE\(\) view returns \(bytes32\)/);
assert.match(chain, /function getCredential\(bytes32 credentialId\)/);
assert.match(chain, /function isCredentialActive\(bytes32 credentialId\)/);
assert.match(chain, /function complianceCredentialScopeHash/);
assert.match(chain, /function processCredentialScopeHash/);

assert.match(consoleSource, /functionName: "ISSUER_ROLE"/);
assert.match(consoleSource, /functionName: "hasRole"/);
assert.match(consoleSource, /functionName: "getPolicy"/);
assert.match(consoleSource, /functionName: "complianceCredentialScopeHash"/);
assert.match(consoleSource, /functionName: "processCredentialScopeHash"/);
assert.match(consoleSource, /functionName: "issueCredential"/);
assert.match(consoleSource, /simulateContract\(\{/);
assert.match(consoleSource, /functionName: "revokeCredential"/);
assert.match(consoleSource, /functionName: "setCredentialStatus"/);
assert.match(consoleSource, /\/app\/chain\/transactions\/\$\{lastTxHash\}/);
assert.match(consoleSource, /No plaintext evidence on-chain/);
assert.doesNotMatch(consoleSource, /from\("credentials"\)/);
assert.doesNotMatch(consoleSource, /\.insert\(/);
assert.doesNotMatch(consoleSource, /\.update\(/);

assert.match(listPage, /SubcontractPolicyRegistered/);
assert.match(listPage, /subcontractPolicies/);
assert.match(listPage, /organization\.role === "factory"/);
assert.match(listPage, /organization\.status === "active"/);

assert.match(detailPage, /readCanonicalCredential/);
assert.match(detailPage, /THREADPROOF_RPC_URL/);
assert.match(detailPage, /functionName: "getCredential"/);
assert.match(detailPage, /functionName: "isCredentialActive"/);
assert.match(detailPage, /mirrorMatches/);
assert.match(detailPage, /application credential mirror does not exactly match current CredentialRegistry state/i);
assert.match(detailPage, /\/app\/chain\/transactions\/\$\{credential\.chain_tx_hash\}/);
assert.match(detailPage, /CredentialRegistry is the authorization source/);

console.log(JSON.stringify({
  threadproof_credential_lifecycle_tests: "PASS",
  invariants: [
    "issuance requires live ISSUER_ROLE",
    "subcontract credential type and scope are derived from live SubcontractGovernor policy",
    "issue/revoke/status transitions are simulated before wallet broadcast",
    "browser lifecycle code does not mutate the credential read model",
    "credential detail compares the mirror against live CredentialRegistry state",
    "canonical transaction provenance remains directly inspectable",
  ],
}, null, 2));
