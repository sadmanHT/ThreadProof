# Production platform-controls evidence

ThreadProof production promotion must not reduce GitHub and Supabase security controls to unchecked booleans in `release/production-release.json`. This procedure defines a sanitized evidence record whose exact bytes are bound to the release manifest.

The artifact is **release evidence, not a configuration mechanism**. It does not enable branch protection, change a GitHub ruleset, upgrade a Supabase plan, enable leaked-password protection, or grant authority to any ThreadProof protocol action.

## Release binding

For release version `vX.Y.Z`, commit the reviewed sanitized artifact at exactly:

```text
docs/releases/vX.Y.Z/platform-controls-evidence.json
```

Compute SHA-256 over those exact bytes and store the lowercase 64-character digest in:

```text
release.evidence.platformControlsEvidenceSha256
```

Store the archive/reference URL in:

```text
release.evidence.platformControlsEvidenceUrl
```

The release verifier reads the committed file locally. It does **not** fetch a PR-controlled URL. The URL is archival metadata; the committed bytes and manifest SHA-256 are the CI trust boundary.

Run policy regressions with:

```bash
node scripts/test-production-platform-controls-evidence.mjs
node scripts/test-production-platform-controls-template.mjs
```

A real production release branch additionally runs:

```bash
node scripts/verify-release-platform-controls-evidence.mjs
```

## Evidence format

The format is:

```text
threadproof-production-platform-controls/v1
```

A passing artifact requires:

- `result: "pass"`;
- `environment: "production"`;
- the exact release version;
- the exact tested canonical `develop` source SHA;
- a platform-control observation no more than 24 hours before release preparation.

The observation and review timestamps must not occur after `release.preparedAt`.

## GitHub controls

The evidence is bound to:

```text
sadmanHT/ThreadProof
```

Both `main` and `develop` must be recorded as protected. Both must record:

- force-push disabled;
- branch deletion disabled;
- required status checks enforced;
- reviewer approval enforced;
- an HTTPS sanitized evidence reference and SHA-256.

`main` additionally requires the trusted release check context:

```text
ThreadProof Trusted Main Release Guard / trusted-main-release-guard
```

and an up-to-date-or-merge-queue guarantee. The artifact also records that the relevant ruleset/protection semantics were independently reviewed and commits that review evidence by URL and SHA-256.

This operator evidence is intentionally stronger than merely recording GitHub's `protected: true` flag, but it does not replace the trusted target-side release guard. The trusted `main` workflow independently queries live GitHub branch metadata at release-check time and fails closed unless GitHub itself reports both branches protected.

A passing JSON file therefore cannot make an unprotected branch releasable.

## Supabase control

The evidence records:

- organization `ThreadProof`;
- the exact production Supabase project reference also named in the release manifest;
- `leakedPasswordProtectionEnabled: true`;
- `leakedPasswordWarningAbsent: true`;
- the timestamp of the security-advisor observation;
- an HTTPS sanitized evidence reference and SHA-256.

The security-advisor observation may be at most 24 hours old at the platform-control observation time and must not be from the future.

The current ThreadProof project must not be described as passing this control until the real Supabase setting is enabled and the security advisor no longer reports the warning. The evidence format does not bypass plan availability or Supabase configuration.

## Review separation

The artifact records an opaque operator/executor identifier and at least two distinct reviewer identifiers. With only two reviewers, the executor cannot be one of them. This prevents the minimum review shape from being satisfied by an operator reviewing their own evidence.

`review.approvedAt` must follow the platform observation and occur no later than release preparation.

This is release-operations review evidence unless an actual ThreadProof Charter action separately grants governance authority. It must not be described as Charter approval by implication.

## Secret and privacy boundary

The evidence artifact is deliberately minimal. Store screenshots, ruleset exports, Supabase advisor exports and administrative records in consortium-approved evidence storage; commit only sanitized identifiers, booleans, timestamps and cryptographic digests needed for release verification.

The validator recursively rejects explicit secret-bearing field names such as:

- `password`;
- `privateKey`;
- `mnemonic`;
- `seedPhrase`;
- `accessToken` / `refreshToken`;
- `serviceRoleKey`;
- `apiKey`;
- `clientSecret`;
- `authorizationHeader`.

It also rejects common private-key/bearer-token text patterns and placeholder material.

The scanner intentionally does **not** reject legitimate control names merely because they contain security words. For example, `leakedPasswordProtectionEnabled` is a boolean policy field, not a password value.

## Non-runnable example

`release/production-platform-controls-evidence.example.json` intentionally contains `REPLACE_ME` placeholders and insecure default booleans. A regression test requires the example to remain invalid for production verification.

Never replace example placeholders with real secrets.

## Relationship to issue #23

This evidence answers:

> Which GitHub and Supabase control observations were reviewed for this release, and are those exact reviewed bytes bound to the release manifest?

Issue #23 answers the more fundamental question:

> Are the real external platform controls actually enabled and independently verified?

Issue #23 remains open until the real controls are enabled. Platform-control evidence cannot substitute for configuration.

## Relationship to ThreadProof protocol authority

GitHub and Supabase are operational release dependencies. They are not authoritative for confidential capacity, orders, credentials, subcontract authorization or Charter governance. A passing platform-controls artifact cannot override:

- canonical chain state;
- PoFC/nullifier rules;
- signatures;
- credential status;
- `CapacityVault` state transitions;
- `SubcontractGovernor` authorization;
- `ThreadProofCharter` governance.

The ThreadProof Oracle Boundary remains unchanged.
