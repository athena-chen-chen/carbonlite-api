CarbonLite isolated hosted migration network diagnostic — LOCAL CANDIDATE

This is not Exact-Pair validation, deployment authorization or a hosted PASS.
The existing Exact-Pair bundle and application candidates are unchanged.
All seven new files require independent security review before publication.
No publication or execution has been performed.

Immutable backend: e424c567d43c0086e0dc01b86e48cb648c114078
Tree: f4e02d756dc14c0df638d7086b483566e7efeca5; eight-file reviewed manifest.
Unchanged frontend: 760b583c4091329c05d41349a7e257f6c6e5b3cd (not checked out).
Original bundle checksum index:
7c2fcda616101ccd1296544743145e4b3ec1a95e5627eea408acda94dc530ed5
New checksum index is ci/pilot-network-diagnostic/SHA256SUMS.txt, with six
repository-relative payload entries; it intentionally excludes itself.
The new files must be added alongside the unchanged published control bundle,
not used as a replacement for it. Local directory is a publication-shaped overlay.

Method and privilege boundary
trace-connect.c uses Linux x86_64 native ptrace and process_vm_readv on its own
children only, under UID 24001. It requires parent-child ptrace permission, not
root, CAP_SYS_PTRACE, BPF, audit administration, kernel changes or installation.
It follows fork/vfork/clone/exec/exit events and syscall stops, retaining detached
descendants until reaped. It captures AF_INET/AF_INET6 connect sockaddr data only
at syscall entry. It does not collect read/write/send buffers, AF_UNIX names,
argv, environ, syscall text or stack frames. Child stdin/stdout/stderr are /dev/null.
Executables are emitted as kernel device/inode identities, then verified against
a fixed-label, precomputed executable hash table and rehashed after observation.
PID/TID are separate. The original root task has a separate identity tag and a
single-assignment result bound to its original start time. Reused numeric PIDs
cannot overwrite that result; identity conflicts and tracing failure stay BLOCKED.
Parent start time is marked verified only for a known
observer/registered traced parent; an adopted external parent stays unverified.
Timestamps are UTC nanoseconds plus monotonic nanoseconds. A connect entry is
an attempted syscall, not proof of a delivered packet or completed connection.

The trusted normal runner retains existing sudo permissions for creating the
test UID, reviewed path access repair, firewall installation/counters and service
management. Docker access is root-equivalent, confined to the normal runner;
UID 24001 does not join the Docker group. No application process runs as root.
The C observer has no privilege changes, kernel writes or tracing fallback.
Unsupported architecture, tracing denial, syscall ABI mismatch, unreadable
metadata, non-leader thread exec, unknown executable and lost observation block.
Non-leader exec is conservatively rejected, not silently dropped. Extra ordinary
SIGSTOP/SIGTRAP is also rejected. This changes diagnostic scheduling; it cannot
prove identical timing to the historical run or production behavior.

Bounds and privacy
180-second observer deadline, 256 concurrent task slots, 2048 emitted events and
512 KiB trace output, reserving space for lifecycle acknowledgements. On failure
the observer kills descendants and drains the kernel wait set to ECHILD, including
attached children whose fork event was pending registration. EXITKILL remains
required for unexpected observer death. The observer monitors the original
driver's PID/start-time/liveness and sets its own per-process parent-death signal;
neither operation changes global kernel or security configuration.
The Python driver handles SIGINT/SIGTERM/SIGHUP, KeyboardInterrupt, SystemExit and
timeout through one finally cleanup path. Supported signals are atomically masked
during bounded cleanup and restored afterward. It requests unprivileged process
group termination, waits/reaps its sudo proxy, validates the observer completion
acknowledgement, and checks that the original observer identity is settled.
Missing acknowledgements, a surviving observer or an incomplete wait drain BLOCK.
Deleting metadata is not cleanup evidence. Bounded cleanup evidence is included
in existing JSON artifacts; no workflow or artifact-path changes are needed.
Hosted tests must still verify real cancellation forwarding and cleanup.
C ignores all runtime
text except fixed stage arguments and reads bounded proc metadata fields only.
run.py accepts only strict-schema metadata and canonical IP addresses, rejects
unknown/duplicate fields, and never serializes exception text. No raw logs are
uploaded. Output artifacts are explicit structured JSON paths with seven-day
retention. A malformed/oversized stream blocks, never truncates to a PASS.
Source outputs are 0600, directories restrictive, control inputs non-writable
by UID 24001. Extended write ACLs and unsafe control ancestors fail closed.

Workflow and experiment
New workflow_dispatch-only workflow, ubuntu-24.04, 20-minute job limit,
contents: read, immutable SHA checkout and persist-credentials: false.
Same concurrency group as Exact-Pair. No deployments, PR events, secrets,
dispatch chaining, retries or application modifications. No full test suite.
The workflow verifies backend and control identities before/after dependency
setup and after observation. Fixed setup-node/pnpm/action revisions are reused.
The kernel/image label is not immutable; actual hosted capabilities remain unknown.
Normal runner installs frozen dependencies and provisions the pinned schema engine
through @prisma/engines + @prisma/fetch-engine before restriction. It does NOT run
the optional-telemetry CLI before the experiment. No generated Prisma client is
required: disposable database metadata is checked through container-local psql.
the experiment child receives only a synthetic allowlisted environment.
Existing network.sh installs unchanged IPv4/IPv6 rules for UID 24001. Only existing
loopback/disposable-database exceptions apply. No historical IP is probed.
The observer never bypasses or edits firewall rules or counters.

Before Prisma, deterministic fixtures exercise direct, grandchild, short-lived,
detached double-fork, AF_INET6 IPv4-mapped, native IPv6 loopback, threaded and
failed/alarm-interrupted connect attempts. Every denied fixture must have exactly
one expected TCP connect, one root Python exec, the expected sockaddr family and
descriptor, and kernel SO_TYPE/SO_PROTOCOL values recorded by the controlled
caller. Extra connects, destinations, ports, type mismatches or execs are rejected.
Its counter delta must be exactly one, matching exactly one independently read
CLPAIR_DENY kernel TCP header for the expected UID/destination/port. Native IPv6
loopback uses only the existing exception and must leave the counter unchanged.
Mapped IPv6 exercises sockaddr_in6 and IPv4 denial without requiring an external
IPv6 route. Native external IPv6 packet denial remains unverified by that fixture;
both IPv4/IPv6 rule families and counters must still be inspectable. No route,
firewall exception or kernel setting is added. The alarm verifies failed-connect capture; it
does not establish a genuine EINTR merely because an alarm was configured.
An unreadable-memory detached negative disables only its own dumpability and
must cause observer failure with no running original caller. Process birth identity
distinguishes PID reuse, and a zombie is classified settled (cannot write), not
falsely reported as a still-running writer. The observer reaps its trace wait
statuses; adopted zombies may await the runner's init. Pipe EOF, rather than a
sleep, ensures the detached test caller waits until its launched root has exited.
No kernel policy changes. CLONE_UNTRACED, ptrace, namespace escape, io_uring and
unsupported syscall ABI attempts block before execution; no tracing fallback.
Unsupported-stage and stream limits have local contract tests; no Linux runtime
coverage is claimed from mocks or a macOS build.

A and B are fixed, intentional comparison arms, not retries. Each gets a fresh
synthetic HOME/cache/config path and a freshly recreated carbonlite_ci_test database
in the single known job-owned PostgreSQL service. Image and database identity are
checked before reset, and identity/public-table emptiness afterward. Only the
hardcoded disposable database is dropped; no caller-supplied SQL/name is accepted.
A executes pnpm exec prisma migrate deploy with the existing synthetic environment.
B differs only by CHECKPOINT_DISABLE=1 and its fresh home. Prisma must be 6.19.3.
Do not permanently adopt that variable into Exact-Pair. Keep both arm records even
if A's denied optional traffic is the observation of interest. Trace/integrity or
migration failure stops further execution. Unexpected arm denial yields a final
BLOCKED/nonzero result even if B has no packets. Calibration counter increments
are recorded separately; counters stay monotonic and are never reset or suppressed.
The driver reads only bounded CLPAIR_DENY kernel journal records and parses fixed
header metadata. Raw journal content is never uploaded. This requires the runner's
existing sudo journal-read privilege, not privileged process killing. Missing
journal access, missing/rate-limited headers, extra packets, timing ambiguity or
unexplained increments BLOCK before Prisma. There is no catch-all allowance.
Between-case counters must be continuous. The final gate revalidates all nine
receipts and exactly seven expected denied packets, rather than trusting an
arbitrary summary total. Even a calibration TCP retransmission blocks as ambiguous.
Native loopback and the intentional unreadable-memory negative require zero denies.
Calibration denial is not a clean Exact-Pair network PASS.
Migration-arm connection records and packet counts are not necessarily one-to-one. UID, destination, time
and stage correlate evidence; ambiguous events must not be assigned speculatively.
Node executable identity does not identify a JavaScript module/provider. An A/B
difference alone cannot prove Checkpoint or attribute historical packets.

Local checks
 PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ci/pilot-network-diagnostic -p test_diagnostic.py -v
 clang -std=c11 -Wall -Wextra -Werror -fsyntax-only -DCL_SYNTAX_ONLY ci/pilot-network-diagnostic/trace-connect.c
 clang -std=c11 -Wall -Wextra -Werror ci/pilot-network-diagnostic/trace-connect.c -o /tmp/local-observer
CL_SYNTAX_ONLY typechecks the Linux branch against local POSIX declarations; it
is NOT Linux compilation, linking, kernel execution or capability evidence.
macOS native compilation builds only the explicit unsupported-platform stub.
Hosted GCC compilation and all guarded Linux capability cases remain mandatory.

Publication/execution blockers
The new workflow filename may not be registered on the backend default branch.
GitHub requires workflow_dispatch workflows to exist on the default branch.
No registration or default-branch change is authorized. Resolve registration in
a separately reviewed publication plan before any isolated dispatch is claimed
executable. No future workflow commit SHA has been invented. Independently bind
the eventual reviewed workflow commit and this checksum index before dispatch.
Runner ptrace/process_vm_readv/Yama/seccomp, actual GCC diagnostics, IPv6 routing,
extended ACL visibility, process cleanup and Prisma helper executable coverage
are hosted-only unknowns. Missing tools or permissions cause BLOCKED; no installs.
Estimated hosted usage: one Ubuntu job, PostgreSQL/PgBouncer service containers,
roughly 5–15 runner minutes, maximum 20. Actual price/account allowance unverified.

Primary references
https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html
https://www.prisma.io/docs/orm/v6/tools/prisma-cli
https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow

Local validation results (2026-11-25)
- Corrected helper suite: 54 PASS, 1 Linux-only SKIPPED (55 total).
- The former expected-plus-unexpected calibration counterexample is BLOCKED.
  Exact valid calibration receipts pass; wrong destinations/ports/types, missing
  kernel evidence, unexplained increments and the former summary-only waiver fail.
- KeyboardInterrupt, supported signal cancellation and SystemExit injection tests
  request termination and verify proxy reaping, completion acknowledgement and
  observer settlement. Missing acknowledgement or a live observer is BLOCKED.
- Compiled C root-result self-test: PASS. It executes the same production latch
  helper with original failure, reused PID, mismatched identity and duplicate exit
  events; tracing failure remains 125. This is not Linux PID-allocation evidence.
- Native macOS unsupported-platform C stub compilation: PASS, exits 78.
- Linux-branch host-header typecheck and Clang static analysis: PASS, no findings.
  These are not Linux compilation/linking/kernel capability evidence.
- Python AST syntax, YAML parsing, shell syntax and workflow structure: PASS.
- Existing unchanged CI bundle tests: 38/38 PASS.
- Existing unchanged diagnostic/privacy tests: 43/43 PASS.
- Linux permission/firewall/tracer runtime tests: NOT RUN. Docker socket connect
  is denied with operation not permitted. No installation or permission change.
- Application candidate files and original 15-payload CI bundle remain unchanged.
- Default-branch registration, native external IPv6 denial, actual executable
  coverage and end-to-end descendant cleanup remain explicitly unverified.

P1/P2 correction scope
Only trace-connect.c, run.py, test_diagnostic.py, this README and SHA256SUMS.txt
change from diagnostic index c908a7c6d33f1e5a964f0e41dde05ef989925b40f0ec2c121b39018dd54d4b8b.
The diagnostic workflow and approved.json are unchanged. Existing Exact-Pair,
firewall files, application candidates and recovery fixture are unchanged.
Regression evidence distinguishes mocked signal/acknowledgement tests and parser
counterexamples from the compiled portable C root-latch self-test. No Linux kernel
tracing, real cancellation forwarding or live journal/firewall regression is
claimed from those local tests. No historical destinations are contacted.

CONTROL_ACL PREPARATION EVIDENCE — LOCAL-ONLY CORRECTION, 2026-11-25
Baseline: published source D 48d41a7958666c27283aa1d9588a3205ca529764,
index ea094ad9c0f758b7e4a853f4d102682a95947c9e0c618cde6dfc5a8e3f0910fa.
The original published source overlay remains unchanged. This separate candidate
changes run.py, test_diagnostic.py, this README and the diagnostic checksum index.
No workflow, tracer C, approval pins, Entry W or Exact-Pair file changes.

Before: prepare printed only CONTROL_ACL, and the experiment-only failure
handler could not retain a preparation-failure artifact. Run 45687359144 therefore
contains no offending path, principal or ACL entry. This correction does not
reconstruct that missing historical evidence or establish the hosted ACL cause.

After: at the SAME rejection predicate, prepare attaches one validated failure
record to the original CONTROL_ACL exception. Named writes to trusted principals
still reject. Owner-only and masked-write decisions also remain as before; no
ACL policy alignment or relaxation is performed. If record construction fails,
the original CONTROL_ACL exception still exits nonzero. No trust classification
is used to change acceptance. The group metadata classifier mirrors the existing
role-bound root/runner-primary-group whitelist and checks that membership is
exclusively trusted; unavailable account lookup is explicitly UNVERIFIED_GROUP.
Account names are used internally for lookup only and are never serialized.

Record fields are exact and closed: code; allowlisted CONTROL_RELATIVE path or
WORKSPACE_ROOT/WORKSPACE_ANCESTOR/FILESYSTEM_ROOT plus bounded ancestor depth;
DIRECTORY/REGULAR_FILE; numeric owner UID/GID; four-digit octal mode; ACCESS or
DEFAULT; NAMED_USER/NAMED_GROUP; numeric principal ID and fixed trust class;
entry permission bits and mask; mask_effective_write; fixed write-effect/current
access classifications; and NAMED_WRITE_SURVIVES_MASK_REGARDLESS_OF_TRUST.
No arbitrary paths, user/group names, ACL dump, exception, environment or payload.
UID/GID fields reject booleans, negative IDs and the undefined-ID sentinel.

mask_effective_write means ONLY that the named entry's write bit survives its
ACL mask. ACCESS_MASK_PERMITS_WRITE records that fact without establishing
current-object access, which remains NOT_ESTABLISHED (owner precedence/group
membership can matter). DEFAULT uses POTENTIAL_INHERITED_WRITE and
NOT_GRANTED_BY_DEFAULT_ACL: a default ACL does not grant current-object access,
and creation modes can remove inherited write. These are diagnostic distinctions,
not changes to the existing acceptance decision. A snapshot mismatch can reflect
racing metadata; this task does not claim an atomic Linux ACL/mode snapshot.

Safe persistence and export
The prepare error handler writes status BLOCKED, reason PREPARATION_FAILURE,
error_code CONTROL_ACL, no_retry true and preparation_failure to the existing
summary.json path. It preserves exit status 1; artifact eligibility is NOT a
successful preparation. The summary has an exact schema and an additional
8192-byte bound, within existing 512-KiB/file and 2-MiB total bounds. Other artifact
schemas remain unchanged. Unsupported, nested, duplicated JSON fields, arbitrary
strings, invalid principal/path metadata and contradictory evidence fail closed.
Preparation records use their own strict schema, never the general string allowlist.

The existing reviewed workflow already creates diagnostic-results before prepare.
Persistence anchors directory/file operations with directory FDs and NOFOLLOW,
requires canonical workspace and safe existing directory ownership/modes, creates
only a new owner-only published directory and 0600 summary, and never overwrites
an existing summary. No chmod, ACL repair, sudo or subprocess is added. Unsafe or
unavailable output paths leave the original failure and fixed PREPARATION_EVIDENCE:
BLOCKED marker; missing/invalid artifacts cannot turn the run into PASS.
The existing summary.json upload allowlist and seven-day retention require no
workflow changes. Raw logs remain excluded. No network deny/counter logic changes.

Local verification
82 diagnostic tests: 81 PASS / 1 Linux-only SKIP. This includes 27 new tests for
ACL decisions, metadata/privacy, missing/invalid records, trust classification,
path/symlink restrictions, non-overwrite, safe artifact I/O and a real Python
subprocess exiting 1 with a valid synthetic preparation-failure artifact.
ACL snapshots are mocked parsed POSIX ACLs; no host ACL was installed or changed.
Temporary artifact I/O and the Python exit test are real local checks. They do
not establish actual hosted Linux ACL layout, observer availability or tracing.

Publication/execution boundary
This is unpublished local diagnostic source only. The published D and Entry W
330d5a70d53505b589916c19efda5951034a4ed2 remain unchanged. W intentionally pins
old D and its old bytes and WILL reject this modified source. Independent review,
separate source publication and immutable Entry rebinding approvals are required
before any separately authorized hosted run. No commit, push or dispatch here.
