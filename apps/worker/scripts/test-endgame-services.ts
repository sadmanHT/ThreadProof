import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const protectedIdentity = read("apps/worker/src/protected-identity.ts");
const disclosure = read("apps/worker/src/due-process-disclosure.ts");
const credentialPackage = read("apps/worker/src/credential-package.ts");
const identityPrivileges = read("supabase/migrations/20260901144232_threadproof_protected_identity_service_privileges.sql");
const disclosureMigration = read("supabase/migrations/20260901142051_threadproof_due_process_disclosure.sql");
const privateCredentialMigration = read("supabase/migrations/20260901145022_threadproof_private_credential_packages.sql");

assert.match(protectedIdentity, /encryptDetached/);
assert.match(protectedIdentity, /hashProtectedIdentityDisclosureAction/);
assert.match(protectedIdentity, /getProposal/);
assert.match(protectedIdentity, /Number\(proposal\.proposalType\) !== 4/);
assert.match(protectedIdentity, /proposal\.actionHash\.toLowerCase\(\) !== expectedActionHash\.toLowerCase\(\)/);
assert.match(protectedIdentity, /disclosure_policy_hash\.toLowerCase\(\) !== evidenceHash\.toLowerCase\(\)/);
assert.doesNotMatch(protectedIdentity, /console\.log\([^\n]*identity\s*[:=]/i);
assert.doesNotMatch(protectedIdentity, /insert\([\s\S]{0,300}identity\s*:/i);

assert.match(identityPrivileges, /revoke all on table public\.encrypted_supplier_identities from public, anon, authenticated/);
assert.match(identityPrivileges, /grant select, insert, update on table public\.encrypted_supplier_identities to service_role/);
assert.match(identityPrivileges, /revoke delete, truncate on table public\.encrypted_supplier_identities from service_role/);

assert.match(disclosureMigration, /event_name <> 'ProtectedIdentityDisclosureAuthorized'/);
assert.match(disclosureMigration, /GOVERNANCE_ACTION_MISMATCH/);
assert.match(disclosure, /ProtectedIdentityDisclosureAuthorized/);
assert.match(disclosure, /AES-256-GCM\+RSA-OAEP-SHA256/);
assert.match(disclosure, /mode: 0o600/);

assert.match(privateCredentialMigration, /credential_private_packages/);
assert.match(privateCredentialMigration, /revoke all on table public\.credential_private_packages from public, anon, authenticated/);
assert.match(privateCredentialMigration, /grant select, insert, update on table public\.credential_private_packages to service_role/);
assert.match(credentialPackage, /threadproof-private-credential\/v1/);
assert.match(credentialPackage, /encryptEmbedded/);
assert.match(credentialPackage, /decryptEmbedded/);
assert.match(credentialPackage, /assertedBodyDigest/);
assert.match(credentialPackage, /getCredential/);
assert.match(credentialPackage, /isCredentialActive/);
assert.match(credentialPackage, /CredentialIssued/);
assert.match(credentialPackage, /getTransactionReceipt/);
assert.match(credentialPackage, /packageSha256/);
assert.match(credentialPackage, /does not match canonical CredentialRegistry state/);

console.log("ThreadProof endgame service-boundary checks passed.");
