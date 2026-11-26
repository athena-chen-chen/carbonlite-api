CARBONLITE MANUAL EXACT-PAIR WORKFLOW — LOCAL PREPARATION ONLY

Proposed hosting repository: athena-chen-chen/carbonlite-api
Hosting branch: ci/pilot-exact-pair-final (published baseline 1861c7b3975b056cd7f677a5fcbbc8acece88161; this branch-guard correction is NOT published)
Prepared workflow: .github/workflows/nightly-e2e.yml
Supporting published paths: ci/pilot-exact-pair/{approved.json,verify.py,run.py,network.sh,type_debt.py,runner-access.sh,runner-permissions.py}
Local tests: ci/pilot-exact-pair/test_local.py and test_runner_access.sh / test_runner_permissions.py (disposable Linux only)
Do not copy these files into either application candidate or its release branch.

CURRENT APPROVAL AND HISTORICAL NOTES — FINAL LOCAL CANDIDATE
The IDENTITIES section and ci/pilot-exact-pair/approved.json define the active pair.
The final rebinding section at the end records the current cumulative patch identity.
Earlier dated correction/review sections retain superseded identity/test evidence as
historical context only. They do not authorize execution of a previous Backend pair.
No future CI commit SHA is assigned; publication and dispatch need separate authorization.

DISPATCHABILITY
GitHub requires the workflow path to exist on the default branch. Read-only inspection
confirmed .github/workflows/nightly-e2e.yml exists on API main and supports workflow_dispatch.
Therefore the proposed isolated CI branch uses that existing registered PATH, with a
manual-only branch-specific definition. It does not add a new unregistered workflow path.
The existing main/release definitions, including main's schedule, remain unchanged.
The branch-specific workflow rejects every event/ref except workflow_dispatch on
refs/heads/ci/pilot-exact-pair-final. A future dispatch must select that ref explicitly.
Do not dispatch main. No workflow has been published or dispatched in preparation.

IDENTITIES
Frontend baseline: 3b69611d80d3f9a11712069bca2fd4eb72f51e15
Frontend approved commit: 1b822f9437ac164c538222ef9d51a4a2f2d663d7
Frontend expected candidate tree: cfc181616b2fd12e4acc16d81ecdbb885ba6997a (53 changed files)
Backend baseline: 1b38e3054be9da4a5935c1802a9a9389becf37a9
Backend approved commit: 188e62b21fc1069d461bf440fbc62b5b48e70f0c
Backend expected candidate tree: 527afe06335da3a391fe87ff91d6a58de1a41a4d (9 changed files)
Both approved commit/tree identities were independently read from GitHub; no future SHA is invented.
The workflow takes exactly two full lowercase 40-hex candidate commit inputs.
Control checkout is bound to github.workflow_sha, separately from both applications.
The final Backend and unchanged Frontend approvals are verified using clean immutable
Git checkouts, exact cumulative file manifests and per-file hashes; no commits made.

GATES BEFORE INSTALLATION
Fixed repository URLs, full SHA inputs, exact HEAD/tree, baseline ancestry, exact changed
file sets, clean checkouts, normal file types and reviewed per-file SHA-256 values.
Identity is rechecked after dependency installation and again after test execution.
Any other application changes, including vercel.json or workflow files, fail the trees.
The original application source checkouts were not modified by this preparation task.

RUNTIME
Ubuntu 24.04 hosted disposable runner; Node 20; pnpm 10.17.0; Python 3; Bash; Git;
Docker/group docker; sudo; useradd/usermod; iptables/ip6tables owner match support.
PostgreSQL postgres:16 (existing tag; runtime version may move) and existing digest-pinned
PgBouncer image. Docker's per-service IPv4 must be in 172/8 or the job stops safely.
The selected Node patch must satisfy the unchanged lockfiles; any install failure stops.
No PostgreSQL binaries are installed on the host; Prisma verifies direct/pooled identity.
Dependency/engine downloads occur before test egress is closed, without provider secrets.
Actual Linux firewall/ownership, service networking and hosted Actions parsing have NOT
been executed locally. Failure of any prerequisite must fail the future job; do not relax it.

OUTBOUND AND CREDENTIAL BOUNDARY
Test commands run as ephemeral UID 24001 with an explicit synthetic-only environment.
No provider API keys or inherited GitHub/runner credentials enter that environment.
IPv4/IPv6 OUTPUT rules apply only to that UID; loopback and the two inspected disposable
service IPv4 endpoints on TCP 5432 are allowed. An intentional reserved-address probe
must be rejected before tests. Its counters are then zeroed. Any later blocked packets
fail a separate always-run step even if a test caught the network error.
Actions control/artifact transport retains networking. Existing E2E mocks reject provider
requests. The workflow never restores test egress; the hosted runner is destroyed.
The existing Control E2E requires docker exec, so the test UID joins docker. Docker access
is privileged: this is trusted, hash-approved synthetic code validation, NOT a security
sandbox for arbitrary malicious commits/dependencies. Never run fork-supplied code or
supply live credentials. Only database service containers should be present.

VALIDATION INCLUDED
- Prisma generation; exact disposable direct/pooled identity and empty schema checks.
- Existing migrations and seed against carbonlite_ci_test only.
- Backend full Jest units, application TypeScript and production build.
- Existing pinned immutable prior artifact builder (fixture only; no old app deployment).
- Full backend E2E against direct PostgreSQL, including dedicated Control/PgBouncer tests.
- Six relevant app E2E suites also against PgBouncer: reporting scope, organization profile,
  tenant isolation, calculation current state, activity calculation fields, authorization.
  Direct-port-specific suites are not incorrectly rerun as generic pooled suites.
- Frontend script tests and full Vitest, including authorization/governance/import/reporting.
- Frontend application TypeScript and production build.
- Baseline and candidate test-TypeScript output/exit status retained separately; strict no-new-diagnostics gate.
No production/preview browser smoke or external endpoints. No test rerun/retry wrapper.
Service health polling is startup readiness only, not retrying failed tests or CI runs.

TEST-TYPES: RAW FAILURE AND SEPARATE NO-NEW-DIAGNOSTICS POLICY
Founder authorization permits this explicit policy; no compiler errors are suppressed.
Recorded 293 comparable baseline / 291 candidate counts are reference only. Those logs
predate the calendar correction and are NOT accepted as the hosted baseline evidence.

At validation time, type_debt.py rebuilds the approved frontend RC baseline from local
Git archive (no fetch, reset, commit or dependency installation). Archive SHA-256, commit
and Git tree are recorded. Only regular files/directories are accepted during extraction.
The source snapshot is temporary and removed on exit. It is never an application server.

The sole comparable-baseline adjustment is the already reviewed tsconfig.spec.json
addition of @testing-library/jest-dom/vitest to compilerOptions.types. It must be exactly
that addition; any other config difference blocks. Other tsconfig*.json files and both
package.json/pnpm-lock.yaml must match exactly. No strictness option is relaxed. This
matcher-type overlay is recorded with original and comparable configuration checksums.

Both compilations use the identical physical node_modules installation, same Node/tsc
binary, arguments, environment allowlist, and exact backend candidate source. A sibling
carbonlite-api link preserves relative test imports; both runs also retain the identical
CARBONLITE_API_DIR/SOURCE_DIR environment bindings. Effective compiler options must match.
Node/TypeScript versions, TypeScript file hashes, installed/source lockfile hashes,
configuration hashes, dependency location, backend tree and environment hash are recorded.
Baseline source and compiler/installed lock identity are rechecked after compilation.

Direct tsc --noEmit --pretty false -p tsconfig.spec.json preserves complete UTF-8 output
and actual exit status. Exit 0 requires no diagnostics; exit 2 requires parsed diagnostics.
Other exits, timeouts, missing output/evidence, invalid encoding, unrecognized lines,
global/config errors, or parsing/status disagreements BLOCK. Compiler crashes are never
converted into debt. Whenever diagnostics remain the log prints exactly:
TEST TYPECHECK: FAIL — HISTORICAL DEBT
This raw result is never relabelled PASS. New diagnostics are separately labelled as a
policy regression; the historical-debt status is not a waiver of those new diagnostics.

Diagnostic identity = file + TS code + COMPLETE message (including nested continuations).
Only verified absolute frontend/backend root prefixes and source line/column locations
are normalized. No messages, properties, types, paths within messages or error codes
are dropped to manufacture parity. Multiplicities are compared as a multiset: any new
identity or increased count BLOCKS, even if the total diagnostic count falls. Removed
identities/decreases pass. Expanded type previews can legitimately trigger a BLOCKED
result requiring review; no automatic equivalence or count-only allowance exists.

A policy PASS permits the overall functional validation job to succeed ONLY if all
other checks also pass. Raw typecheck still reports FAIL — HISTORICAL DEBT and its exit
code. No standalone passing Test-TypeScript check is claimed. Any prior failure prevents
an overall PASS. A clean candidate reports raw PASS only when tsc actually exits zero
with zero diagnostics. All baseline/candidate diagnostic identities, counts, additions,
removals, toolchain evidence and raw output checksums are retained in type-debt-policy.json.

LOCAL VERIFICATION
29 synthetic tests pass: 12 existing identity tests, 13 diagnostic-policy cases and four
execution/evidence tests. No actual application compiler run, hosted run, database or
provider access occurred. Synthetic execution tests stub the compiler and Git archive;
they prove control flow/artifact behavior, not the real hosted diagnostic comparison.

ARTIFACTS
Upload ONLY identity.json, sanitized counts/suite-status tests.json, complete baseline and
candidate compiler diagnostics, type-debt-policy.json and network guard summaries. Raw test logs/JSON, fixture documents, database data and
local environment files are deliberately excluded. Test-TypeScript diagnostics contain
reviewed source/type details only. Retention: seven days.
The identity file stays outside the test-owned writable subdirectory. Full candidate
hashes/trees and workflow revision are recorded. No diagnostic file is called a pass
unless its command succeeded. No browser-acceptance claim is made by this workflow.

APPROVAL GATES
1. Independent review of this prepared bundle and its checksums.
2. Separate approval for publishing the two exact application candidates and the isolated
   validation branch. Reconfirm Vercel Preview holds/Render Auto-Deploy and PR Previews Off
   immediately before any push. Inspect existing hooks/workflows again; no implicit PR.
3. Record actual candidate commit SHAs, exact trees and CI-hosting commit SHA.
4. Separate one-run workflow-dispatch approval with those immutable identities.
5. Observe all results; no automatic rerun. Review the raw typecheck failure and no-new-diagnostics evidence explicitly; no automatic debt equivalence.
Merge, deployment, Preview-hold restoration and real customer activation remain separate.

RUNNER ACCESS P1 CORRECTION — LOCAL ONLY
The prior effective-access-only check could accept world-writable paths under POSIX
owner/group precedence. Global metadata safety is now established BEFORE any chmod,
then rechecked after repair. No hosted run has been performed with this correction.

The workflow binds the trusted runner role with the current invoking UID and primary
GID via quoted id output. Only root or that bound UID may invoke the metadata guard;
UID 24001 is never a trusted control owner. The declared GID must be the runner account's
actual primary GID. Legitimate root-/Actions-runner-owned workspace ancestors remain
allowed; an untrusted owner is rejected even if the current mode is read-only, because
that owner could chmod it. No arbitrary supplementary/Docker group is implicitly trusted.

runner-permissions.py inspects every path from / through GITHUB_WORKSPACE, then control/,
control/ci/ and control/ci/pilot-exact-pair/, and every immediate control-module file.
Required runtime files include run.py, type_debt.py, approved.json, runner-access.sh,
runner-permissions.py, verify.py and network.sh. Symlinks, nonregular files, missing
helpers, unexpected subdirectories and noncanonical redirection fail closed.

Independent of clpairtest's effective access, world-write bits ALWAYS block, including
0757 precedence cases, files, ancestors and sticky/world-writable temporary roots.
Group-write bits are allowed ONLY for this explicit role-bound whitelist: GID 0 and the
bound Actions runner primary GID, with all enumerated primary/supplementary members
restricted to root and the bound runner UID. Missing/unverifiable account/group metadata
blocks. Docker, clpairtest and other untrusted membership cause rejection even if the
GID otherwise matches the whitelist. Other owning groups may be read-only, never writable.
This policy requires review approval; an unexpected hosted group must not be auto-waived.

Linux access/default POSIX ACL xattrs are inspected directly using Python's standard
library. Known Linux version-2 encodings are parsed with strict entry/tag/identity checks.
Any untrusted owner/named-user/owning-group/named-group/other write entry is rejected;
masked-out untrusted writes are conservatively rejected too. Trusted ACL writes require
the same UID/group policy as modes. Unrecognized ACL mechanisms, invalid encodings,
unsupported inspection and read failures BLOCK. ENODATA alone establishes ACL absence.
No getfacl/setfacl installation, ACL modification or package dependency is introduced.

The guard returns a fingerprint of path device/inode/owner/group and control-file bytes.
The helper checks it again after the existing minimum POSIX read/search repairs, so
namespace, ownership or content changes during repair block. Only root/the trusted runner
may mutate the inspected namespace; this does not defend against a malicious trusted
root/runner, privileged Docker control or untrusted install hooks. Those remain existing
trusted-code/disposable-host assumptions, not an untrusted-code security sandbox.

Read/search repairs remain restricted to the actual governing POSIX class: +x on exact
ancestors/control directories and +r on the four public runtime files consumed by run.py.
They add no write or directory-list bits. Actual reads as clpairtest and rejection of its
write access to all ancestors/control files remain. The Python guard and sudo chmod run
as the trusted setup identity; application tests continue only as clpairtest. Existing
identity, network, database-isolation and no-new-diagnostics checks are unchanged.

LOCAL VALIDATION
- Existing bundle tests: 29/29 PASS.
- Updated Linux permission suite: 25/25 PASS, including real 0777/0757 directories,
  untrusted group writes, unsafe scripts/ancestors/owners, file/directory symlinks,
  required-helper absence, approved runner owners/groups, untrusted group members,
  safe read-only paths, idempotence and actual UID 24001 reads without control writes.
- Real Linux access/default ACLs exercised. Named user/group write grants were proven
  with successful kernel write-opens under the untrusted UID (no bytes modified), then
  rejected by the guard. Malformed-encoding and ACL-read-failure cases are simulated.
- Cached dpage/pgadmin4:latest used ONLY as an available Python/Linux fixture with entry
  point overridden to bash, --user 0 for synthetic setup, --network none and --rm.
  No pgAdmin/database/application service started. Bundle mounted read-only; users/files
  created only in container-local disposable paths. A fixture-only runuser launcher
  performs real initgroups/setgid/setuid before executing commands; it is not a stubbed
  permission result. No host account or permission changes and no software installation.
- Bash/YAML/Python syntax and complete payload checksum verification PASS.

Example local regression command:
docker run --rm --network none --user 0 \
  --env RUNNER_ACCESS_DISPOSABLE_FIXTURE=synthetic-only \
  --env PYTHONDONTWRITEBYTECODE=1 \
  --mount type=bind,source=<absolute-bundle-path>,target=/reviewed,readonly \
  --entrypoint bash dpage/pgadmin4:latest /reviewed/ci/pilot-exact-pair/test_runner_access.sh /reviewed

REMAINING HOSTED GATES
Original blocked component/mode, actual hosted UID/GID ownership, account/group enumeration,
ACL/filesystem inspection support and executable paths are not proven by this fixture.
Unexpected metadata must block, without broad chmod or automatic group approval. Full
hosted network/Docker/application/type-debt validation remains outstanding. Review this
new checksum-bound bundle, then obtain separate publication and one-run permissions.
No publication, dispatch, application modification or cloud operation occurred here.

HOSTED E2E DIAGNOSTICS CORRECTION — LOCAL ONLY, 2026-11-25
Run 45638411608 retained only suite summaries, so its exact assertion identities and
six blocked-packet destinations cannot be recovered. A local reproduction using the
same configured-storage override reproduced six ENOENT assertions in F08/F09. The
correction uses DOCUMENT_STORAGE.exists/read with documentStorageKey(fileUrl), leaving
logical URLs, production storage and fault injection unchanged. A real missing-source
control proves existence/read assertions reject a deleted source. Two test files change;
no application source changes. Full suites: before 36 PASS/6 FAIL; after 43/43 direct
PostgreSQL 16.10 and 43/43 PgBouncer 1.24.1, with a deliberately separate storage root.

DIAGNOSTIC PRIVACY AND BOUNDS
New diagnostics.py captures raw command stdout/stderr to owner-only (0600) local files,
maximum 16 MiB; overflow/1800-second timeout kills the command group and blocks validation.
Raw Jest JSON is produced under child umask 077, bounded to 16 MiB for parsing; it is
never uploaded. The existing runner/artifact account can read sanitized files, not raw
logs. Sanitized *.failures.json preserves suite statuses, failed test/file names,
matcher/numeric Expected/Received structure, error codes and relevant stack frames.
Quoted literals, arbitrary thrown prose, source snippets, dumped objects, sensitive
fields, URLs, emails and opaque values are omitted. It intentionally does NOT retain
unsanitized customer/request content. This is synthetic-only evidence, not a generic
safe logging mechanism for customer workloads. Each artifact is <=512 KiB, <=128 failures,
<=8 messages/failure, <=8192 characters/message with visible truncation markers. Count,
parse or size failures block; raw command exit and FAIL stage are saved first. Missing
Jest output produces a fixed BLOCKED artifact plus bounded sanitized error/frame fallback.
No failed test becomes PASS. Artifact upload remains the explicit allowlist, seven-day
retention, repository-controlled Actions download access; no public link or raw upload.
Founder must maintain repository/artifact access restrictions. Logs expire with the runner.

NETWORK ATTRIBUTION — DENY POLICY UNCHANGED
The UID-24001 allow rules and unconditional IPv4/IPv6 REJECT remain. Immediately before
REJECT, header-only kernel LOG rules record a maximum 30/minute, burst 20. They include UID,
IP/port/protocol; no request, header, DNS-name, SNI or payload content. New validation
stage intervals permit timestamp overlap attribution to a stage, NEVER a particular test.
After the existing preflight, counters reset and a microsecond UTC capture marker is saved.
The always-run check preserves the blocking counter result independently of diagnostics.
Root journalctl reads only kernel records since this window, at most 2048 records; the
unprivileged Actions controller parses at most 16 MiB and emits <=128 matching records.
Only CLPAIR_DENY records for UID 24001 enter the sanitized artifact. IPv4/IPv6 destination,
port, protocol, UTC timestamp and DNS-vs-other classification are retained. IP/443 alone
DOES NOT prove external-provider access. PID/executable/test identity remain unavailable;
we report reliable UID attribution only. Allowed loopback/disposable TCP/5432 bypass LOG;
correctness of those paths is tested through real successful socket connections.
Counter/event counts are compared. Rate limiting, kernel log loss, unrelated journal
volume and hosted journal availability can make attribution PARTIAL/UNAVAILABLE; never
interpret missing journal records as zero packets. Any blocked packet still fails. Parser,
journal-command or counter inspection errors fail. The pre-existing privileged Docker
trust boundary is unchanged. Do not disable the guard to diagnose these packets.

LOCAL TESTS AND HOSTED GATES
- 29 existing bundle tests; 20 new diagnostic tests; 25 Linux permission tests PASS.
- Real container-local iptables: allowed loopback, PostgreSQL and PgBouncer sockets,
  zero initial denied packets; denied TCP/443 and UDP/53; counter=2 and check failed.
  Both IPv4/IPv6 rule order verified. Actual IPv6 packet delivery and hosted journal
  availability are NOT proven by this Linux fixture. Synthetic journal parsing covers
  IPv6, DNS classification, time-window/UID filtering, stage overlap and payload exclusion.
- A one-case exploratory invocation omitted required synthetic evidence-HMAC configuration
  and failed app startup. Final full-suite runs use the unchanged approved synthetic
  keyring contract and pass. No production authorization relaxation was made.
- Application TypeScript and focused ESLint pass. No cloud access/dispatch/publication.

IMPORTANT IDENTITY GATE
approved.json and verify.py are UNCHANGED. The old backend commit does NOT contain the
two corrected E2E files. The new local test-only delta requires independent review and
separately authorized candidate publication and identity-manifest rebinding before a
hosted run can exercise it. Do not dispatch the old pair and claim these fixes were tested.
Nothing in this package authorizes a push, dispatch, PR, deployment or real-data activation.

STRICT DIAGNOSTIC PRIVACY P1 CORRECTION — LOCAL ONLY, 2026-11-25
Supersedes the earlier free-text sanitization/name-retention description above.
The eced5888... bundle allowed short unquoted values after Expected:, Matcher error:
and at prefixes. All three synthetic canaries reproduced before this correction.

No input diagnostic line, dynamic test name or nested exception structure is now copied.
Format 2 exposes parsed fields only: finite numeric/boolean/null assertion values,
fixed matcher categories/modifiers, enumerated error codes, and validated source locations.
Unknown values are replaced with [REDACTED] or counted as redacted. Unicode/non-color
controls, JSON dumps, arbitrary error prose, function labels/arguments and causes are
excluded. Conventional ANSI color codes may be removed, but never make payload text safe.
A stack location must map to an actual tracked source-file path from the identity-verified
checkout, with positive bounded line/column numbers verified against source line lengths
(UTF-16 columns). Symlink redirection is rejected. Absolute paths never enter output.
The source catalog is read using git ls-files by UID 24001; no external parser/dependency
or source modification is introduced. Unverifiable suite path/status/count evidence blocks.

Parameterized titles, fullName and ancestorTitles are omitted even when short. Failed-test
identity is the trusted repository-relative file + assertion ordinal, bound to the exact
candidate SHA/tree in the existing identity artifact. This deliberately loses human-readable
runtime test names and parameter values; locate the assertion in the pinned source using
its ordinal and retained source locations. It is not a claim to recover all hidden inputs.

The run.py summary/fallback paths use the same parsed-field policy. Counts are validated
nonnegative integers, suite statuses are fixed enums, and stage labels are fixed approved
constants. Nested count/status/path payloads block instead of being copied into tests.json.
Network stage labels are also checked against the fixed stage enum before output; IP/port,
UID and UTC fields remain parsed, without arbitrary request content. The firewall script
and workflow (including raw-log exclusions and seven-day retention) are byte-unchanged.

Outcome kinds distinguish TEST_FAILURE reported by Jest, TEST_INFRASTRUCTURE_FAILURE
(suite-load failure without failed assertions, capture timeout/overflow), and DIAGNOSTIC_FAILURE
(invalid/missing/unverifiable evidence). A Jest-reported assertion failure does not establish
whether its root cause was product behavior or setup. Raw command exit status stays visible;
parsing/redaction failure blocks the overall runner even when the command itself exited zero.

Existing size/count/retention bounds remain unchanged: 16 MiB input/raw log cap, 8192
characters/message with an explicit truncation boolean, 128 failures, eight messages/failure,
512 KiB sanitized artifact, seven-day upload retention. No raw logs/JSON added to uploads.
Identity/tree gates, approved.json and type_debt.py remain byte-unchanged. Historical compiler
evidence is still governed by the existing separate type-debt policy; this correction does
not claim a new general-purpose scrubber for arbitrary compiler/customer workloads.

LOCAL VALIDATION
- 29 existing bundle tests PASS.
- 43 diagnostic tests PASS: original 20 adapted for format 2 plus 23 privacy/integration
  regressions. Short unquoted canaries, dynamic names, nested causes/details, multiline,
  JSON-escaped, Unicode/control, trusted/untrusted frames and unknown summary metadata tested.
- Six runner-level tests exercise the real run() function with synthetic command output,
  verify all its uploadable diagnostic JSON files exclude the canary, preserve raw failures
  and distinguish infrastructure from diagnostic failure. Raw fixture output is intentionally
  excluded exactly as in the workflow; no hosted run or database access is performed.
- Existing 25 Linux mode/owner/ACL/UID permission regressions PASS in --network none --rm.
- Python/YAML/Bash syntax, application-candidate no-change inventory and checksums verified.
Separate independent review/publication/identity-rebinding/dispatch approvals still required.

EXACT-PAIR IMMUTABLE IDENTITY REBINDING — LOCAL ONLY, 2026-11-25
This section supersedes earlier historical six-file/unpublished-candidate statements.
Input bundle checksum-index: 9f529cf9e065f755adb3cf2f72c979102e17f6d5113196ab0cdf626dd3667f54.
GitHub commit objects, branch refs and baseline comparisons were freshly read without
publication or dispatch. Backend e424c567d43c0086e0dc01b86e48cb648c114078 has tree
f4e02d756dc14c0df638d7086b483566e7efeca5 and parent b1cc0c810c46669003d00d18d18349b6944fbf0a.
Frontend remains 760b583c4091329c05d41349a7e257f6c6e5b3cd, tree
3885eef878844d9050a2022b0086301ce9e95176, based on 3b69611d80d3f9a11712069bca2fd4eb72f51e15.

approved.json now includes an explicit expected_commit for BOTH candidates. verify.py
rejects missing/malformed pins and any different input commit, even a different commit
with the same tree. HEAD, complete tree, approved baseline ancestry, exact changed-file
set, clean checkout, normal file types and per-file SHA-256 checks remain mandatory.
The identity artifact records both the observed and approved commit. The unchanged
workflow requires full SHA inputs and calls verify.py before dependency installation,
after installation and after validation. No workflow edit is necessary to enforce pins.

Backend cumulative manifest against 1b38e3054be9da4a5935c1802a9a9389becf37a9:
  src/metrics/calculation-quality.service.spec.ts
  src/metrics/calculation-quality.service.ts
  src/organizations/organizations.service.spec.ts
  src/organizations/organizations.service.ts
  test/document-resource-limits.e2e-spec.ts
  test/mutation-outcomes.e2e-spec.ts
  test/organization-profile.e2e-spec.ts
  test/pilot-reporting-scope.e2e-spec.ts
Original six file hashes and Git blobs are unchanged. The new published test hashes:
  document-resource-limits: 737c4bef9ac0ed29b578fc95964ef6ff951415f628a3c9e165da25394805c9c2
  mutation-outcomes: c46d6829a5b18dd48195a1e6b363985e29154633fc1eef54d7b8f78f37693a2e
Frontend repository, base, tree, all 52 paths/hashes and reviewed patch hash are unchanged;
its already-published exact commit is now explicitly pinned instead of only input/HEAD bound.

Backend cumulative patch SHA-256: 1c47279835406536ccb6efdbfe17330b75588916cae5572ab9dce016bd5b182a.
Reproduce with Git diff --binary --full-index --no-ext-diff --no-textconv --no-renames
--no-color --src-prefix=a/ --dst-prefix=b/ between the approved RC base and e424c567... .
This digest describes the complete eight-file immutable diff; it is not the historical
six-file 7e6432a2... patch. Pin/tree/file checks are authoritative, not patch text alone.

LOCAL VERIFICATION
- 36 identity/bundle tests PASS: original 29 plus seven new pin/manifest regressions.
- 43 diagnostic/privacy tests PASS; 25 disposable Linux permission tests PASS.
- Actual clean disposable checkouts of both published commits pass the real verifier:
  backend eight-file hashes and frontend 52-file hashes, exact trees and ancestry.
  Superseded backend b1cc0c8... is rejected. No mocks substitute for these Git checks.
- Read-only GitHub evidence independently confirms both commits/trees, backend manifest,
  original six blob identities and new test byte hashes, and unchanged frontend blobs.
- Diagnostic privacy implementation, runner access/ACL guards, network-deny script,
  workflow/upload restrictions, deployment policy and historical type-debt gate unchanged.
- Python/YAML/Bash syntax and full checksum verification PASS. Neither application
  candidate was edited. Temporary Git checkouts and Linux container are disposed.

This bundle is LOCAL and awaits independent publication review. Existing remote workflow
0a0d72fd... is not updated by this task and must not be dispatched as the corrected bundle.
No new candidate commits, push, PR, workflow execution, deployment or provider-setting
changes occurred. Future publication and one-run dispatch require separate authorization.
Hosted journal availability, IPv6 packet behavior and actual full exact-pair CI outcome
remain unverified; historical frontend test-TypeScript debt is not converted into PASS.

IDENTITY EVIDENCE P2 CORRECTION — LOCAL ONLY, 2026-11-25
Input bundle checksum-index: 66e583edb0693d75624e38f3350f51b8f005598d3c933a128e4362eed514102b.
The verifier correctly enforced the commit pin but reused its local variable in the
per-file digest loop, so approved_commit in its returned artifact was a file digest.
The earlier real-checkout evidence confirms backend approved_commit was
88122ffbc1a27d95995703a0f94288f3f668854aab012b145bbd26bac859ee39,
and frontend approved_commit was
c920a9bf1de2ddb44fdcbad40212553764785c86cc646cebeb85ec9544aaa103.
These are 64-character file hashes, not approved Git commits. Earlier acceptance checks
passed but did not assert the returned field; those records remain historical evidence.

Only variable names and the returned approval field change in verify.py:
approved_commit_sha holds the original approved commit; expected_file_sha256 is used
only inside file verification. All acceptance predicates, checked paths and execution
order remain unchanged. approved.json and both application candidates are byte-unchanged.
New regressions require returned approval == approved.json pin == observed commit,
exactly 40 lowercase hex characters, and not any per-file digest. The same assertions
run against both real disposable candidate checkouts, not just synthetic Git mocks.

Verified resulting approved_commit values:
  Backend: e424c567d43c0086e0dc01b86e48cb648c114078
  Frontend: 760b583c4091329c05d41349a7e257f6c6e5b3cd
Trees remain f4e02d756dc14c0df638d7086b483566e7efeca5 and
3885eef878844d9050a2022b0086301ce9e95176 respectively. Backend eight-file and frontend
52-file hashes/ancestry/cleanliness pass; superseded backend remains rejected.

Validation: 38 identity/bundle tests PASS (36 existing + two returned-evidence regressions),
43 diagnostic/privacy tests PASS, 25 disposable Linux permission tests PASS, both actual
candidate checks PASS, syntax/checksums PASS. Diagnostic privacy, workflow, network denial,
runner/ACL safeguards, type-debt logic and immutable approval metadata remain unchanged.
No app source, commit, push, dispatch, PR, provider setting or deployment changed.
This local correction awaits independent publication review. Hosted-only unknowns remain.

DISPOSABLE PRISMA CHECKPOINT OPT-OUT — LOCAL PROPOSAL, 2026-11-25
Published baseline: 472120fc7d27f9b56ed6ae3f1e67d602ca2b1f90.
Verified baseline checksum index: 7c2fcda616101ccd1296544743145e4b3ec1a95e5627eea408acda94dc530ed5.
The workflow, all 15 payloads and checksum index were independently read from
that immutable GitHub commit and matched the baseline local Git blob identities.

Scope: run.py adds CHECKPOINT_DISABLE=1 only to fresh environment copies for:
1. prisma-generation: pnpm exec prisma generate, before network denial.
2. disposable-migrate: pnpm exec prisma migrate deploy, under network denial.
3. node scripts/phase-e-rollback-artifact.mjs, the immutable rollback fixture
   helper. It runs pnpm exec prisma generate --schema <disposable legacy schema>
   and then compiles that fixture. Its children inherit the helper-local opt-out.
The published candidate helper was read from immutable backend e424c567d43c0086e0dc01b86e48cb648c114078.
This helper does not deploy an application or migrate a live database.
Only item 2 is a migration CLI invocation in the reviewed Exact-Pair driver.
Backend build is nest build; seed is tsx prisma/seed.ts, not a Prisma CLI command.

A workflow-only setting would be discarded by env -i and the driver's explicit
allowlist. Both explicit CLI generation paths are included because the Prisma
v6 CLI can use Checkpoint outside migrate too. Installed Prisma 6.19.3 source
checks CHECKPOINT_DISABLE before spawning its optional unreferenced Checkpoint
child. Pre-guard generation receives the same invocation-local opt-out to avoid
optional setup CLI activity carrying into guarded stages. This does not prove
any historical packet attribution. Reference: https://www.prisma.io/docs/orm/v6/tools/prisma-cli

No global environment, workflow env, application tests/builds, seed, type-debt
checks or production setting changes. The base env dictionary remains unchanged;
subsequent stages never inherit CHECKPOINT_DISABLE from a preceding stage.
The rollback helper's own generation/build subprocess chain receives the local
copy only. No helper source, Prisma schema, migrations or dependencies change.

Evidence interpretation is preserved: A/B run 45738953943 had successful
migrations and verified cleanup in both arms, A denied 3 packets, B denied 0.
Different runner image revisions and OS fingerprints keep the automated
comparison INCONCLUSIVE. Qualified setting-dependence support only, not causal
or historical process/provider attribution. Investigation CLOSED WITH
QUALIFICATIONS. STOP PTRACE. No new tracing or diagnostic subsystem.

The firewall script, IPv4/IPv6 denial, independent final counter gate, existing
preflight, UID 24001, ACL safeguards, identity verifier, approved candidate
pins, database services, all test commands, no-new-diagnostics policy and
sanitized upload allowlist/7-day retention are byte-identical to baseline.
Any unexpected denied packet remains a workflow failure. Opt-out is not a
network exemption and is not a guarantee that all future stages will pass.

Separate Recovery Control fixture: deliberately excluded. Its existing local
correction remains unpublished and untouched. A separately authorized backend
test-only publication must establish the eventual immutable backend commit and
tree; a separate Exact-Pair identity-manifest rebinding/review must then pin
that identity before the final full Hosted run. No future SHA is invented.

Proposed publication sequence (separate approvals required): publish/reverify
this checksum-bound CI-only proposal; publish/reverify the already prepared
Recovery fixture correction separately; prepare/review/publish Exact-Pair
identity rebinding to that eventual backend identity; only then authorize a
full Hosted Exact-Pair run. No action in this sequence is performed here.

FINAL BACKEND SUCCESSOR REBINDING — LOCAL ONLY
CI baseline commit: 472120fc7d27f9b56ed6ae3f1e67d602ca2b1f90.
CI baseline tree: 6babc63ebc787687e5f8be29cd28a0af04391f5b.
Backend approved commit: 188e62b21fc1069d461bf440fbc62b5b48e70f0c.
Backend approved tree: 527afe06335da3a391fe87ff91d6a58de1a41a4d.
Its immediate parent e424c567d43c0086e0dc01b86e48cb648c114078 is superseded as
an execution input. The cumulative Backend baseline stays
1b38e3054be9da4a5935c1802a9a9389becf37a9; the eight previous file hashes stay unchanged.
The ninth manifest entry is src/common/security/recovery-control-store.spec.ts,
SHA-256 4898bfa1874ca1bac35aa09440cf97da5dd3516886fc1b9c2f27d2105313cbe9.
It explicitly chmods the disposable negative fixture to 0644 and asserts its mode;
production recovery code and the rejection assertion are unchanged.
Cumulative Backend patch SHA-256:
5ebff061189886ab0a251e78ee1c4d17356badbbab39e3a03f0102a3ccf509d0
computed using git diff --binary --full-index --no-color --src-prefix=a/
--dst-prefix=b/ from the unchanged cumulative baseline to the approved successor.

Frontend stays 760b583c4091329c05d41349a7e257f6c6e5b3cd, tree
3885eef878844d9050a2022b0086301ce9e95176, with all 52 manifest entries unchanged.
The approved Checkpoint run.py is byte-identical to the reviewed local opt-out bundle
with checksum index f31c1ebeebd454992beb8c674106e65c52e22329314cb8e6d169f303a1ef7d9c.
That old index identifies the input bundle, not this rebound final candidate.
Only fresh invocation-local environments receive CHECKPOINT_DISABLE=1 for the two
explicit Prisma stages and rollback fixture helper. No global or application setting.
Workflow, verify.py, ACL/UID safeguards, firewall/counters, privacy, cleanup, service
isolation and type-debt code remain byte-identical to the published CI baseline.
Any unexpected denied packet or failed inspection still blocks the future Hosted run.

A future authorized dispatch takes only frontend_sha and backend_sha, selecting
ci/pilot-exact-pair-final after its final reviewed publication. Use the exact
approved Frontend and successor Backend commit above; stale or mixed identities block.
Actual Hosted Linux, disposable services and complete application suites are NOT RUN
in this local rebinding task. Local modeled regressions are not Hosted CI success.

FINAL ISOLATED BRANCH ALIGNMENT — LOCAL ONLY
Published baseline: 1861c7b3975b056cd7f677a5fcbbc8acece88161, tree
42fee9693af432e667dd092ae514aca4bd81cd9c; baseline checksum index
8dbe17f17a54fe6b38091c3b13cc6ed0f98979f066e7e42c841ba279d64b36d5.
The first workflow step now requires exactly refs/heads/ci/pilot-exact-pair-final.
The former branch, other branches, tags, pull refs and all non-manual events reject.
Repository equality, full commit input validation and separate immutable checkout
verification are unchanged. No other helper contains a branch-name execution check.
The three current dispatch/hosting instructions above use the same final branch.
Backend/Frontend identities and all Checkpoint, UID, ACL, firewall/counter, service,
privacy, cleanup and type-debt payloads remain byte-identical to this published baseline.
No future CI commit is assigned. Publication and any Hosted run require separate approval.

FRONTEND JWT FIXTURE SUCCESSOR REBINDING — LOCAL ONLY
Current CI baseline: 53f4d6e7b9ab9d2add516e7e34efc9296c158510,
tree a02f2bd2e727f55ad4bf2fb84de2492ce039dcdd. This section supersedes
historical Frontend execution pins above; historical evidence is not rewritten.
Approved Frontend: 1b822f9437ac164c538222ef9d51a4a2f2d663d7,
tree cfc181616b2fd12e4acc16d81ecdbb885ba6997a. Its immediate parent is
760b583c4091329c05d41349a7e257f6c6e5b3cd, now rejected as an execution input.
The cumulative baseline remains 3b69611d80d3f9a11712069bca2fd4eb72f51e15.
All previous 52 Frontend file hashes remain identical. The 53rd entry is
scripts/dev-database.test.mjs, SHA-256
e68cb7444de38b750ad7d286ccd72f2ce9ad62c61aeb8226c807aa9dc0c3c61a.
Cumulative Frontend patch SHA-256:
62c44a7153c0cd0836587007a9144b4b0dd871e928e2d4f74cd10630a04b3ed5.
Reproduce with git diff --binary --full-index --no-ext-diff --no-textconv
--no-renames --no-color --src-prefix=a/ --dst-prefix=b/ between the cumulative
Frontend baseline and successor. Exact commit/tree/file hashes remain authoritative.
Backend 188e62b21fc1069d461bf440fbc62b5b48e70f0c, tree
527afe06335da3a391fe87ff91d6a58de1a41a4d and its entire approval remain unchanged.
Workflow, branch/manual guards, UID/ACL, IPv4/IPv6 denial, counters, Checkpoint opt-out,
PostgreSQL/PgBouncer, privacy/artifacts, cleanup and type-debt gates are byte-identical.
Only approval metadata, associated regression tests, documentation and checksum index change.
No application files or the JWT fixture are modified by this rebinding.
Stale Frontend commits, mixed trees and the old fixture hash must fail closed.
No future CI commit is assigned. Publication and any Hosted execution require
separate authorization. Actual Hosted execution is NOT RUN for this candidate.

Local rebinding validation: Exact-Pair 54 PASS / 1 existing Mac Bash 3.2 SKIP;
Privacy 43/43 PASS. Real successor (53 cumulative files) and Backend (nine files)
pass the unchanged verifier. Old Frontend commit, old tree, stale HEAD and old
fixture hash reject. Backend approval and prior 52 Frontend hashes are unchanged.
No Hosted result is claimed; remaining Frontend/build/type-debt gates require
separately authorized execution after publication.
