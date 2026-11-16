# Evidence HMAC key management v0.1

## Purpose and incident-derived requirement

Real-data authorization evidence stores an HMAC digest and the exact
`hmacKeyVersion` used to create it. Historical verification therefore depends
on retaining the original version-specific key without modifying or replacing
it. A prior Preview configuration incident demonstrated that editing one atomic
keyring during rotation can make historical verification unavailable.

This contract separates immutable legacy history from additive signer keys.
It does not authorize real-customer-data processing, change evidence rows, or
replace legal, privacy, security, and go/no-go approvals.

## Environment contract

### Active version

`REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION` is mandatory. It names exactly one
version in the merged in-memory key map. New evidence is signed only with this
version. The runtime never guesses a latest version and never falls back to a
different signer.

Version labels are trimmed, case-sensitive, limited to 64 characters, and may
contain letters, numbers, `.`, `_`, and `-`. A label must begin with a letter or
number. Labels are immutable and must never be reused for different key
material.

### Legacy immutable source

`REAL_DATA_EVIDENCE_HMAC_KEYRING` remains supported with its existing JSON-array
serialization:

```text
[{"version":"legacy-v1","key":"base64:<secret>"}]
```

It is a legacy and immutable historical key source. Once evidence depends on a
version in this source, do not edit or remove that entry except through a
separately reviewed recovery procedure.

### Additive source

`REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS` is a JSON object mapping a version to
one independently managed key:

```text
{"rc-v1":"base64:<secret>"}
```

This source lets an operator add a fresh signer without rewriting the legacy
array. A clean RC environment may omit the legacy source entirely and configure
only one additive key plus the matching active version.

Every key must be canonical Base64 with the `base64:` prefix and decode to at
least 32 bytes. Do not log, commit, copy between environments, or include real
key material in operational evidence.

## Merge and fail-closed behavior

At service startup the backend:

1. validates the explicit active version;
2. parses the legacy source when present;
3. parses the additive source when present;
4. normalizes version labels and merges both sources in memory;
5. rejects duplicate versions within a source or across sources;
6. validates canonical Base64 and minimum decoded length for every key;
7. rejects an empty merged key map; and
8. rejects an active version that is absent from the merged map.

Invalid JSON, blank or malformed versions, unexpected fields, non-string
additive values, duplicate definitions, malformed/non-canonical Base64,
short keys, and missing active keys fail with
`REAL_DATA_EVIDENCE_CONFIGURATION_INVALID`. No source overrides another.

Safe startup diagnostics may report only the active version label, loaded
version labels, key count, and whether each source is present. They must never
include encoded or decoded key material.

## Signing and historical verification

New evidence uses only the explicit active version. Historical evidence uses
only the key named by its stored `hmacKeyVersion`. An unavailable historical
version fails with `REAL_DATA_EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`.

There is no fallback to the active key, no automatic re-signing, no hash
rewriting, and no schema migration. The existing `hmacKeyVersion` column is
sufficient for version-specific verification.

## Rotation procedure

1. Generate a fresh, environment-specific key through the approved secret
   management workflow.
2. Assign a new version label that has never been used.
3. Add the new independent entry to the additive source.
4. Set `REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION` to the new label.
5. Deploy through the controlled release path.
6. Confirm startup diagnostics show the intended active and retained labels.
7. Verify representative historical evidence using each retained version.
8. Verify new synthetic evidence records the new active version.
9. Retain old keys for the approved evidence-retention period.

Never redefine an existing label, remove a key still required by evidence, or
copy a key between Preview, RC, and Production.

## Environment separation and naming

- Replacement Phase 2 RC: begin with a fresh label such as `rc-v1`.
- Future Production: use an independent namespace such as `prod-v1`.
- Do not use `preview-v1` through `preview-v5` in the replacement environment.
- Do not inherit the legacy Preview keyring in clean RC or Production.
- Do not accept real customer data until the exact environment completes its
  approved go/no-go process.

## Frozen legacy Preview rule

`carbonlite-rc2-invitation-preview` is a
`FROZEN HISTORICAL EVIDENCE VERIFIER`. It may be used only for health checks,
read-only historical verification, and forensic/reference inspection. It must
not receive this code, ordinary deployments, environment edits, new signing
work, real customer data, or further functional testing.

This additive architecture is intended for a separate clean RC service.

## Operational verification checklist

- Active label equals the approved environment-specific version.
- Loaded labels contain every required historical version and no unexpected
  version.
- Legacy/additive source-presence metadata matches the environment design.
- Representative historical evidence verifies with its stored version.
- New synthetic evidence records the active version.
- No secret material appears in logs or evidence packages.
- Database schema and existing evidence rows remain unchanged.
