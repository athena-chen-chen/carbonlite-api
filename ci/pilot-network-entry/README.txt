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

D2 IDENTITY REBINDING — LOCAL ONLY, 2026-11-25
--------------------------------------------
This section supersedes all previous D publication/binding statements above.
Baseline Entry W is the published commit 330d5a70d53505b589916c19efda5951034a4ed2,
tree 3dff30401f37f07b40341db6676e88f2504780a1; its index is ee68336b...88197a.
W remains published unchanged; this separate local candidate has no future Entry
commit SHA or tree identity invented, embedded or precomputed.

The sole active Source approval is now published immutable D2:
commit 1c81536c44612d02aeb1e79d5e216ab0420f9b2e
tree ad8693a2fd66733f36d5197bfa5655266c3642ef
index 63ed0fc0e82fa2565bf46b40fa85782dbdc12c0e6c3456cb22a5a56972660444.
All seven files and their six payload hashes/index were freshly read back from
GitHub and matched before this rebinding. approved.json updates only Source
commit/tree and the four changed Source-file hashes. The backend approval and
all other metadata remain byte-equivalent. The workflow changes only its two
Source guard literals and literal control checkout ref. No source branch HEAD
is substituted for the immutable commit. Required diagnostic inputs are still
confirmations; old D, mixed D2/old-tree and malformed identities fail closed.

verify.py is BYTE-IDENTICAL to W. The same verifier enforces the new metadata,
entry/source/backend checkouts stay separate, and SHA/tree/ancestry/cleanliness/
manifest/file checks run before dependencies and at the existing later gates.
All runtime/security steps are unchanged: no ACL, firewall, ptrace, privacy,
cleanup, deployment, artifact allowlist or retention changes. D2's reviewed
preparation-failure evidence reaches the existing summary.json upload path.

Tests include explicit D2 acceptance using simulated Git checkout evidence and
old-D rejection even when that simulated checkout matches the old identity.
They are separate from real GitHub commit/tree/seven-file verification, and do
not establish a new hosted run or actual Linux behavior. After separately
authorized publication, independently read back the actual new Entry commit/tree
and checksum outside its own tree; obtain separate immutable dispatch approval.
This preserves external Entry identity verification without circular self-hashing.
No publication or dispatch occurs as part of local rebinding.


D3 IMMUTABLE REBINDING — LOCAL ONLY
This section supersedes the previous active D2 source binding in historical notes.
Published D3 commit: 0cb2c241a7f260c5c71156c01d11b0fc4d53d739
Published D3 tree: a9c2057d29435de47b805a9ea2f3618daac5f883
D3 index: da6c8f05752637c967726568e85b12cb9e42627bc912e52e8af448e3bbe29c65
All seven published D3 files were independently read back and matched byte-for-byte;
all six source payload hashes and the index verified before rebinding.

Only immutable source references, source hash metadata, corresponding regression
expectations, this documentation and Entry checksums change. verify.py remains
byte-identical. D2 is rejected by both the early shell guard and verifier, including
when a synthetic checkout matches the superseded D2 commit/tree. D3 acceptance
uses synthetic checkout fixtures, not a claim of Linux-hosted execution.

Backend remains e424c567d43c0086e0dc01b86e48cb648c114078, tree
f4e02d756dc14c0df638d7086b483566e7efeca5, with the exact eight-file manifest.
Future Entry commit/tree are intentionally unknown: separately approved immutable
inputs must match invocation GITHUB_SHA/workflow SHA and independent checkout Git
identities. No future SHA is invented or embedded in its own checksum index.

The manual-only registered-path workflow, read-only permissions, separate checkouts,
UID 24001 safeguards, firewall, ACL/tracing/cleanup/Prisma behavior, diagnostic-only
scope, sanitized artifact restrictions and seven-day retention remain unchanged.
No publication, dispatch, Source D3 or application modification occurred.


D4 IMMUTABLE REBINDING — LOCAL ONLY
This section supersedes earlier active D3 source references in historical notes.
Published Source D4: 0f7131300c3be37692bc55453fd7af7faad45599
Git tree: 66a771505ec092f71247b43e50d5339891da25db
Source index: 39cc5aa0acf71b0db33a3a26d6f796e47cd8804b29d19e588522ae49c1795a0b
All seven published D4 files and the six payload hashes were independently read
and matched before changing the Entry. The Source itself is unchanged.

Only workflow source pins, approval metadata, corresponding regression expectations,
this review documentation and Entry checksums change. verify.py remains byte-identical.
The Entry accepts immutable D4 and rejects superseded D3 before checkout verification,
even when a synthetic checkout agrees with old D3. The shell guard also rejects D3.
Existing independently supplied Entry SHA/tree/index checks, invocation SHA binding,
separate entry/control/backend checkouts and cleanliness/manifests remain unchanged.
No future Entry SHA or tree is invented or self-hashed.

Backend remains e424c567d43c0086e0dc01b86e48cb648c114078 with tree
f4e02d756dc14c0df638d7086b483566e7efeca5 and the same eight reviewed files.
Manual-only/read-only execution, firewall, ACL, calibration, tracing, cleanup and
Prisma behavior, bounded sanitized upload paths and seven-day retention are unchanged.
D4's reviewed calibration-evidence behavior is selected solely by immutable identity.
Actual Linux execution is NOT RUN by this local rebinding. No publication or dispatch.


D5 IMMUTABLE REBINDING — LOCAL ONLY
This section supersedes earlier active D4 source references in historical notes.
Published Source D5: 835d44eeb21870171373c446b40833395888f4ed
Git tree: eee5affc5ba59d69cb1f3ee75b1f06d91913dca8
Source index: 9fe699eea724bcb641a344319c384a290d5f1d01ee2ae508256f91184abb87e0
All seven published Source files, six payload hashes and checksum index were
independently read back and verified before rebinding. D5 itself is unchanged.

Only source commit/tree references, source hash approval metadata, corresponding
identity tests, this documentation and Entry checksums change. verify.py is
byte-identical. D5 is accepted and superseded D4 rejected before Git verification,
even when synthetic checkout metadata matches old D4. The shell guard rejects D4.
Separate Entry/control/backend directories, immutable identity/manifests/cleanliness,
read-only/manual-only operation and diagnostic-only scope remain unchanged.

Backend stays e424c567d43c0086e0dc01b86e48cb648c114078 with tree
f4e02d756dc14c0df638d7086b483566e7efeca5 and the exact existing eight-file manifest.
No future Entry SHA/tree is invented: separately approved immutable inputs must
match the workflow invocation SHA and independently checked-out Git identities.
The index excludes itself; identity checks do not rely on circular self-hashing.

No ACL, tracing, calibration, firewall, cleanup, privacy, upload or Prisma behavior
changes. Existing Exact-Pair and application candidates are unchanged. D5's reviewed
stat-fixture correction is selected solely through the immutable source binding.
Hosted Linux/Python 3.12 execution is NOT RUN by this task; no Hosted PASS claimed.
No publication, dispatch, PR creation or deployment occurred.
