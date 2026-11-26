SIMPLIFIED PRISMA CHECKPOINT A/B — LOCAL PREPARATION ONLY
Repository: athena-chen-chen/carbonlite-api
Proposed isolated branch: ci/pilot-checkpoint-ab
Base/control commit: 472120fc7d27f9b56ed6ae3f1e67d602ca2b1f90
Control tree: 6babc63ebc787687e5f8be29cd28a0af04391f5b
Exact-Pair checksum index: 7c2fcda616101ccd1296544743145e4b3ec1a95e5627eea408acda94dc530ed5
Backend: e424c567d43c0086e0dc01b86e48cb648c114078
Backend tree: f4e02d756dc14c0df638d7086b483566e7efeca5
No frontend checkout, application edits or existing branch changes.

The seven-file overlay replaces nightly-e2e.yml ONLY on a future separately
approved isolated branch. Registered-path branch execution was established by
run 45734292313; registration/permissions and deployment holds must be freshly
verified before any publication/dispatch. No main/default/release change is
proposed. Separate approval is required for publication, then one dispatch.
The future workflow commit/tree are deliberately unknown. External approved
entry_sha/entry_tree/entry_index_sha256 must match the invoking workflow/event
and independently checked-out Git identity. No circular self-hashing.

Two Ubuntu 24.04 matrix jobs (fail-fast:false) have independent runners,
PostgreSQL/PgBouncer service containers, dependency installations and fresh
UID-24001 HOME/cache directories. Both execute exactly:
  pnpm exec prisma migrate deploy
Only Arm B receives CHECKPOINT_DISABLE=1; Arm A omits it. Neither receives
runner credentials or inherited application/provider configuration. Artifact
labels and physically separate resources necessarily differ; normalized
migration inputs, base environment, schema, engine, lockfile, command, OS,
Node/pnpm versions/binaries and resolved DB image identities must match before
comparison can be COMPLETE. Runtime Prisma version must equal 6.19.3, read
from package.json without invoking its CLI. Engine provisioning uses the
previously reviewed non-CLI method. No Prisma CLI warmup or shared HOME.
The PostgreSQL digest is the postgres:16 digest independently recorded in hosted
run 45734292313; both arms pin it, rather than tracking a mutable tag.

Before dependencies and again before/after measurement, standard-library Git
verification checks repository, immutable commit/tree, ancestry, exact manifest,
cleanliness, Git modes, symlink-free paths, approved index and every payload.
The unchanged control checkout is pinned separately. Its checksum index and all
15 payload hashes are verified. New Entry controls are audited with the same
root/verified Runner-only ownership, trusted-exclusive-group and POSIX ACL
semantics as runner-permissions.py. Masked untrusted grants, unknown ACLs,
world writes, symlinks and unavailable inspection fail closed. Actual UID 24001
write access is denied. No ACL repair, elevated tracing, ptrace/eBPF or kernel
changes are used. The original runner-access.sh establishes its reviewed
minimal read/search access only. Normal runner sudo remains limited to the
reviewed UID/service/firewall operations; migration executes as UID 24001.

The reviewed network.sh is executed unchanged. Both IPv4/IPv6 reject counters
must be readable, and their exact exit-status/count contract is checked. No
counter reset, calibration, new exception or allowlist exists. Initial counter
must be zero. Counters are checked after migration, after cleanup and at final
artifact generation. Any denied traffic is a BLOCKED network-security result.
Matrix jobs finish independently even when one fails. All steps preserve their
nonzero status; no continue-on-error or retry masks a failed security gate.

Raw migration stdout/stderr are discarded (not captured or uploaded). Only
schema-validated owner-only JSON (maximum 8 KiB per arm) is uploaded with seven-
day retention. Fixed error categories distinguish migration, infrastructure,
counter, identity, cancellation and cleanup failure. Exceptions, environment
values, connection strings, unrestricted arguments and provider URLs are never
exported. Optional destination metadata is deliberately NOT_COLLECTED, not a
fabricated empty network observation. Counters establish UID-window activity,
not a PID, executable, provider or historical attribution. Existing UID-loopback
and Docker-database exceptions remain unchanged; this is not packet capture.

Migration is bounded to 180 seconds. Cancellation/timeout triggers UID-only
termination as that UID and launcher wait. ps UID/PID inventory must show no
remaining UID-24001 tasks (including zombies). No metadata deletion is accepted
as process-exit proof. Service removal always targets only the two job-created
container IDs; final docker inventory verifies absence. Runner destruction
removes remaining disposable files/firewall rules; egress is never reopened.

Three independent outcomes:
- Migration: NOT_STARTED / SUCCESS / FAIL / TIMEOUT / INFRA_FAILURE, with exit status where available.
- Network security: PASS only with verified zero counters; otherwise BLOCKED.
- Comparison: COMPLETE only with two successful migrations, matching identities
  and profiles, complete evidence and verified cleanup. A denied packet does
  not prevent B from running or erase evidence, but the overall run still fails.
A denied/B clean supports setting dependence, never historical causation.
Both denied means opt-out insufficient; neither denied means not reproduced.
B-only traffic, toolchain drift, migration/setup failure, missing artifacts or
required evidence means INCONCLUSIVE/BLOCKED. No full Exact-Pair result is claimed.

Hosted-only unknowns: UID/ACL checks, firewall availability, actual package/engine
layout, signal/process reaping, Docker services and Prisma traffic. Local mocked
regressions do not establish Hosted Linux PASS. STOP PTRACE remains final.


LOCAL P1/P2 CORRECTION — not published or hosted-validated
Blocked preparation baseline index:
21ffcf8c1a30255a938f9d4b50443c00d892f1e8f12330003d2fa92571f6b225
Only run.py, its regression tests, this README and checksum index change.
Workflow, verifier, approval pins and all existing controls stay byte-identical.

HOME remains UID 24001, exact mode 0700. Normal Runner validates canonical
workspace/parent and directory metadata without enumerating private HOME.
A fixed isolated Python probe runs as UID 24001 with a scrubbed environment;
it uses O_DIRECTORY/O_NOFOLLOW, checks descriptor owner/mode/inode binding,
checks emptiness and emits only HOME_EMPTY: VERIFIED. No directory entries,
paths or arbitrary exceptions are exported. Nonempty, symlinked, noncanonical,
wrong-owner/mode or unreadable HOME fails closed. Arm isolation is unchanged.

Migration outcome is owned by arm() and updated independently of cleanup.
Launcher evidence records only spawned-handle state, numeric PID/start ticks,
actual child wait result and verified reaping. The original Popen handle is
retained in memory across exceptions. Only successful Popen.wait establishes
reaped=true; a missing handle, missing process or empty UID inventory never
does. Partial/missing identity explicitly blocks eligibility. TIMEOUT remains
TIMEOUT even if cleanup later reaps the child with a signal exit status; that
wait status is kept separately in launcher evidence. A completed success or
failure is likewise not overwritten by cleanup failure. Infrastructure/launch
failure is explicit, distinct from NOT_STARTED before migration was attempted.

UID-only termination, child wait and remaining-process inspection are attempted
independently, so one inspection failure does not suppress an available wait.
Unknown cleanup remains BLOCKED. Separate finalization cannot establish a new
launcher reaping fact; it preserves the verified original receipt. Sanitized
owner-only artifacts remain available for modeled timeout/cleanup exceptions
and preparation failure, without raw exception text. No artifact deletion is
used as exit proof. Real Linux permissions, /proc identity and actual reaping
remain unverified locally; mocked syscall tests do not establish Hosted PASS.

No Checkpoint A/B input, counter, firewall allowance, migration command,
container image, identity pin, privileged execution, deployment behavior,
artifact bound or seven-day retention changes are introduced. STOP PTRACE.
