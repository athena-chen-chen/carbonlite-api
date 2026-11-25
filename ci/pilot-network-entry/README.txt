Isolated registered-path network diagnostic entry — LOCAL PREPARATION ONLY

This six-file overlay targets athena-chen-chen/carbonlite-api at
472120fc7d27f9b56ed6ae3f1e67d602ca2b1f90. It is NOT applied to the
existing ci/pilot-exact-pair-validation branch. Its nightly-e2e.yml is an
alternative definition on ci/pilot-network-attribution-entry only; main,
release branches, and the existing Exact-Pair bundle remain unchanged.

Identity approval contract
--------------------------
There are no future commit placeholders or invented commit SHAs in this bundle.
Before a separately authorized dispatch, independently approve and supply:
 entry_sha, entry_tree: actual published entry commit/tree;
 entry_index_sha256: this separately reviewed entry checksum index;
 diagnostic_sha, diagnostic_tree: confirmation of the fixed source pins below.
All commit/tree inputs require full lowercase 40-character Git identities.
The index requires 64 lowercase hex characters. The entry SHA must equal both
GitHub's invoking workflow SHA and event SHA, from the expected repository and
refs/heads/ci/pilot-network-attribution-entry, with workflow_dispatch only.
Inputs are approval bindings, not substitutes for independent founder approval.
An operator must not provide a newly changed/unreviewed entry SHA just because
it is the current branch HEAD. A checksum index alone does not establish Git identity.

Three separate immutable checkouts: entry/, control/, carbonlite-api/.
Before dependencies or diagnostic code execution, verify.py checks exact HEAD,
tree, baseline ancestry, repository URL, cleanliness, regular Git file modes,
symlink-free paths, and exact baseline-relative changed-file sets. Entry's own
five payloads are checked against its independently approved checksum index.
The source must have EXACTLY the seven reviewed changes above the CI base;
all seven byte hashes are pinned in approved.json, including index ea094ad9...
The source's existing Exact-Pair index 7c2fcda6... and all 15 payloads are also
checked without executing them. The eight-file backend is pinned to e424c567...
and tree f4e02d75..., with each reviewed file hash. No frontend checkout is used.
The checked source's own run.py then repeats its existing verification.
Identities are rechecked after dependency setup and at finalization. Final
source execution/upload is conditional on successful final identity verification.
Failure prints a fixed marker, never raw Git exceptions or environment values.

Execution and security
----------------------
Only the reviewed diagnostic runs: local helper regressions, capability and
strict calibration/cleanup tests, disposable migration A, migration B with
CHECKPOINT_DISABLE=1 applied solely by the unchanged reviewed driver, independent
counter reconciliation, schema-validated metadata artifacts, and cleanup.
No full Exact-Pair suite, deployment, dispatch, branch writes or PR actions.
Read-only contents token; pinned actions; no persisted checkout credentials;
no secret references. Node 20/pnpm 10.17.0 and frozen backend dependencies are
provisioned before isolation, as in the reviewed diagnostic workflow. No live
credentials or provider environment are supplied. Images/actions are inherited
from that reviewed workflow; postgres:16 and Node20 retain upstream patch drift.
Application/tracer execution remains UID 24001 without elevated tracing caps.
Existing normal-runner sudo operations are limited to UID provisioning,
ownership/access setup, firewall/counter inspection and disposable DB control;
application/tracing runs are not elevated. No CAP_SYS_PTRACE/sysctl/install step.
Original IPv4/IPv6 network.sh is executed from verified control source, unchanged.
Any unexpected denied packet, incomplete trace/calibration/cleanup, or migration
failure remains BLOCKED. Six explicit sanitized JSON files only, seven-day
retention, no raw log upload. Job-owned service containers are removed always;
runner teardown removes firewall rules, never reopening test UID egress.
GitHub creates service containers before steps; no live database is referenced.

Registration and publication ordering (NOT AUTHORIZED HERE)
-----------------------------------------------------------
nightly-e2e.yml is the existing registered path. A prior branch-specific manual
run demonstrates selecting an isolated version of this path. No change to main
is proposed. Actual future registration/dispatch availability and permissions
must be reconfirmed before dispatch; no new filename registration is assumed.
1. Separately authorize publishing ONLY the seven immutable source files to
   ci/pilot-network-attribution based on the approved existing CI commit.
2. Independently read back the real source commit/tree and exact seven-file
   delta/checksums. No diagnostic execution yet.
3. Separately authorize publishing this reviewed six-file entry overlay to
   ci/pilot-network-attribution-entry from that same existing CI base; read back
   real entry SHA/tree/index and manifest. Do not overwrite source control files.
4. Separately authorize ONE diagnostic dispatch with those approved real values.
Reconfirm no branch-push deployment triggers or conflicting work; existing
Render/Vercel holds are historical context, not freshly verified by this local
preparation. No publication or execution is authorized by this document.

Local evidence boundaries
-------------------------
Entry identity tests use temporary file fixtures and simulated Git responses:
they test failure behavior without creating commits or branches. D now exists
and was independently verified; W requires independent remote verification after
publication, then separate immutable dispatch approval. Workflow parsing/static review
is not hosted execution. Linux ptrace/Yama support, descendant reaping, kernel
journal visibility, firewall/IPv6 behavior, and Docker networking remain hosted
unknowns; all are guarded by the unchanged source's capability/fail-closed tests.
Estimate: one Ubuntu24.04 job, maximum20 minutes plus teardown/artifact handling.
If any identity, capability, privilege, network, privacy or cleanup check fails,
stop; do not retry, weaken isolation or claim Checkpoint historical attribution.

Local preparation review results
--------------------------------
The first shell guard uses explicit exits for SHA/index regex rejection; it does
not depend on Bash errexit behavior. Its live local shell regression includes
valid context plus nine invalid-context/identity probes. Second-pass comparison
confirmed disposable services, timeout/runtime, UID/access setup, network enable,
experiment, upload allowlist/retention and container cleanup match the reviewed
diagnostic workflow. Only checkout/identity wiring and conditional safe final
verification were adapted. No confirmed remaining P0/P1 found in this entry's
local/static scope; actual hosted executability remains unverified.

FINAL IMMUTABLE SOURCE BINDING — 2026-11-25
------------------------------------------
This section supersedes the earlier source-publication planning text. D has been
published and freshly read back from GitHub: commit
48d41a7958666c27283aa1d9588a3205ca529764, tree
17f62f117866fa180ebb57c11d79ea0f4ca02c3f. All seven files match the reviewed
source byte-for-byte and the diagnostic index remains ea094ad9...0910fa.
approved.json pins D commit/tree; verify.py rejects any other source inputs
before Git access. The workflow's first guard checks the same literals before
checkout, and control checkout ref is the literal D SHA, never a branch/input.
Source inputs remain required confirmations, not selectable revisions.
The backend pin, source file hashes, Exact-Pair protections and diagnostic
runtime/security steps are unchanged. No source bundle or application files changed.

No W commit/tree is stored inside its own tree. The later dispatch must supply
the independently read-back published W commit/tree and this reviewed checksum
index; W's HEAD/tree must match those separately approved values and GitHub's
invocation identities. This avoids circular self-hashing. A caller's assertion
is not independent approval: verify the published Git commit/tree and all six
payloads remotely, record them outside W, then obtain separate dispatch approval.
Do not dispatch during publication. Actual Linux/hosted capability is not proven
by local fixtures, syntax checks or remote Git verification.

BOUNDING REVIEW AND LOCAL VALIDATION
------------------------------------
The binding-only second-pass review found no new P0/P1 in the reviewed scope.
The verifier adds only exact D commit/tree equality; all prior commit/tree,
ancestry, manifest, cleanliness, hash and symlink checks remain. The workflow
adds the same fixed equality checks before checkout and uses literal D as ref.
Every runtime/security step other than the guard and source checkout matches the
previously reviewed entry. No deployment, extra trigger or full-suite step added.
29/29 entry tests pass, including wrong but syntactically valid source SHA/tree
rejection before Git access and eleven negative shell-guard probes. Existing
diagnostic tests: 54 PASS / 1 Linux-only SKIP. YAML/Python/11 shell-step syntax
and whitespace checks pass. Real Linux tracing/cleanup remains NOT RUN locally.

W intentionally replaces nightly-e2e.yml ONLY on the isolated entry branch.
Its inherited repository-root Exact-Pair index describes the older workflow,
not this entry: never use that root index to validate W. W uses the separate
ci/pilot-network-entry/SHA256SUMS.txt and independently approved W commit/tree.
The original Exact-Pair index and all payloads are checked in control D, where
that original workflow remains byte-identical, and on the unchanged existing
ci/pilot-exact-pair-validation branch. Neither main nor release is changed.
