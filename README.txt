CARBONLITE MANUAL EXACT-PAIR WORKFLOW — LOCAL PREPARATION ONLY

Proposed hosting repository: athena-chen-chen/carbonlite-api
Proposed hosting branch: ci/pilot-exact-pair-validation (NOT CREATED)
Prepared workflow: .github/workflows/nightly-e2e.yml
Supporting published paths: ci/pilot-exact-pair/{approved.json,verify.py,run.py,network.sh,type_debt.py,runner-access.sh,runner-permissions.py}
Local tests: ci/pilot-exact-pair/test_local.py and test_runner_access.sh / test_runner_permissions.py (disposable Linux only)
Do not copy these files into either application candidate or its release branch.

DISPATCHABILITY
GitHub requires the workflow path to exist on the default branch. Read-only inspection
confirmed .github/workflows/nightly-e2e.yml exists on API main and supports workflow_dispatch.
Therefore the proposed isolated CI branch uses that existing registered PATH, with a
manual-only branch-specific definition. It does not add a new unregistered workflow path.
The existing main/release definitions, including main's schedule, remain unchanged.
The branch-specific workflow rejects every event/ref except workflow_dispatch on
refs/heads/ci/pilot-exact-pair-validation. A future dispatch must select that ref explicitly.
Do not dispatch main. No workflow has been published or dispatched in preparation.

IDENTITIES
Frontend baseline: 3b69611d80d3f9a11712069bca2fd4eb72f51e15
Frontend expected candidate tree: 3885eef878844d9050a2022b0086301ce9e95176 (52 changed files)
Backend baseline: 1b38e3054be9da4a5935c1802a9a9389becf37a9
Backend expected candidate tree: a0d2ccacdd55de6c75fbf3f5aec405eb9666de39 (6 changed files)
Future candidate commit SHAs are NOT YET AVAILABLE. No commit SHA is invented here.
The workflow takes exactly two full lowercase 40-hex candidate commit inputs.
Control checkout is bound to github.workflow_sha, separately from both applications.
Both complete expected trees were independently reproduced with Git mktree in temporary
object storage, using approved baseline objects plus reviewed file bytes; no commits made.

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
ancestors/control directories and +r on the three public runtime files consumed by run.py.
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
