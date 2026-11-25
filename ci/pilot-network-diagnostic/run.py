"""Isolated metadata-only diagnostic. Never import application code in this driver."""
import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import contextlib
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
CONTROL = HERE.parents[1]
MAX_BYTES = 512 * 1024
CANARY = "PRIVATE_CANARY_do_not_record"
STAGES = {"capability", "arm-A-migrate", "arm-B-migrate"}
CAP_LIMIT = "Failed-connect coverage; interrupted EINTR outcome is not established merely by a timer."
ARM_LIMIT = "Executable and stage attribution only; no JavaScript module, provider or historical PID claim."
FAILURE_CODES = {'CAPABILITY_MISMATCH', 'CAPABILITY_DENIAL_COUNTER', 'CAPABILITY_EVIDENCE',
                 'CAPABILITY_CLEANUP', 'DENIAL_CALIBRATION', 'TRACE_TIMEOUT', 'TRACE_LIMIT',
                 'TRACE_SCHEMA', 'TRACE_NUMBER', 'TRACE_IDENTITY', 'TRACE_PID', 'TRACE_PARENT',
                 'TRACE_DESTINATION', 'TRACE_KIND', 'UNKNOWN_EXECUTABLE', 'EMPTY_TRACE',
                 'EXECUTABLE_CHANGED', 'OUTPUT_LIMIT', 'COUNTER_UNAVAILABLE', 'COUNTER_STATUS',
                 'COUNTER_INTEGRITY', 'PRISMA_VERSION', 'DIRTY_COUNTER', 'DATABASE_IDENTITY',
                 'MIGRATION_FAILURE', 'DISPOSABLE_RESET', 'CONTAINER_IDENTITY', 'FRESH_HOME',
                 'DISPOSABLE_DIRECTORY', 'RUNNER_IDENTITY', 'CONTROL_INDEX', 'PAYLOAD_IDENTITY',
                 'CONTROL_PERMISSIONS', 'CONTROL_TYPE', 'CONTROL_ACL', 'COMPILER', 'ACTUAL_USER_ACCESS'}
FAILURE_CODES.update({'CANCELLED','CLEANUP_UNVERIFIED','LIFECYCLE_INVALID','TRACE_INCOMPLETE',
                     'CALIBRATION_UNEXPECTED','CALIBRATION_AMBIGUOUS','KERNEL_EVIDENCE'})
RAW_KEYS = {"kind", "stage", "utc_ns", "monotonic_ns", "uid", "pid", "tid",
            "start_ticks", "ppid", "parent_start_ticks", "parent_verified",
            "exe_dev", "exe_ino", "destination", "port", "socket_family", "socket_fd"}
CLEANUP_REPORTS = []
CASES = {'direct','grandchild','short','detached','ipv6','ipv6-loopback','thread','interrupted','unreadable-detached'}


class Blocked(Exception):
    """Only fixed codes may cross the diagnostic error boundary."""


def failure_code(error):
    return error.args[0] if (isinstance(error, Blocked) and len(error.args) == 1 and
                            type(error.args[0]) is str and
                            error.args[0] in FAILURE_CODES) else 'DIAGNOSTIC_FAILURE'


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise Blocked("DUPLICATE_FIELD")
        obj[key] = value
    return obj


def sha(path):
    path = Path(path)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 128 * 1024 * 1024:
        raise Blocked("FILE_IDENTITY")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    data = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    if len(data) > MAX_BYTES:
        raise Blocked("OUTPUT_LIMIT")
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def command(args, *, cwd=None, env=None, timeout=180):
    """No raw command stdout/stderr is retained, printed or uploaded."""
    return subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          timeout=timeout, check=False).returncode


def integrity():
    approved = json.loads((HERE / "approved.json").read_text())
    old = CONTROL / "ci/pilot-exact-pair"
    index = CONTROL / "SHA256SUMS.txt"
    # The previous index is kept at repository root by the published bundle.
    if sha(index) != approved["control_index_sha256"]:
        raise Blocked("CONTROL_INDEX")
    for index_path, expected_key in ((CONTROL / "SHA256SUMS.txt", "control_payloads"),
                                     (HERE / "SHA256SUMS.txt", "payloads")):
        base = CONTROL
        lines = index_path.read_text().splitlines()
        seen = set()
        for line in lines:
            if not re.fullmatch(r"[0-9a-f]{64}  [A-Za-z0-9_./-]+", line):
                raise Blocked("INDEX_FORMAT")
            digest, rel = line.split("  ")
            q = Path(rel)
            if q.is_absolute() or ".." in q.parts or rel in seen:
                raise Blocked("INDEX_PATH")
            seen.add(rel)
            target = base / q
            if target.resolve() != target.absolute() or sha(target) != digest:
                raise Blocked("PAYLOAD_IDENTITY")
        expected = set(approved[expected_key])
        if seen != expected:
            raise Blocked("INDEX_MANIFEST")
    # Imported only after source bytes and index have been verified.
    spec = importlib.util.spec_from_file_location("reviewed_verify", old / "verify.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return approved, module


def identity(workspace):
    approved, verifier = integrity()
    return verifier.verify(workspace / "carbonlite-api", approved["backend"]["expected_commit"], approved["backend"])


def prepare(workspace):
    """Normal trusted runner only; no privilege/ACL repair in this helper."""
    if sys.platform != "linux" or os.getuid() in {0, 24001}:
        raise Blocked("RUNNER_IDENTITY")
    identity(workspace)
    spec = importlib.util.spec_from_file_location("reviewed_permissions", CONTROL / "ci/pilot-exact-pair/runner-permissions.py")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    paths = {CONTROL, HERE, *HERE.parents}
    for rel in json.loads((HERE / "approved.json").read_text())["payloads"]:
        p=CONTROL/rel
        paths.update({p,*p.parents})
    for p in paths:
        s = p.lstat()
        if stat.S_ISLNK(s.st_mode) or s.st_uid not in {0, os.getuid()} or s.st_mode & 0o022:
            raise Blocked("CONTROL_PERMISSIONS")
        if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)):
            raise Blocked("CONTROL_TYPE")
        names = os.listxattr(p, follow_symlinks=False)  # Unsupported inspection fails closed.
        for key in ("system.posix_acl_access", "system.posix_acl_default"):
            if key in names:
                entries = guard.acl_entries(os.getxattr(p, key, follow_symlinks=False))
                mask = next((e[1] for e in entries if e[0] == 16), 7)
                if any(tag in {2, 8} and perms & mask & 2 for tag, perms, _ in entries):
                    raise Blocked("CONTROL_ACL")
    output = workspace / "diagnostic-bin"
    output.mkdir(mode=0o755, exist_ok=False)
    if command(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", str(HERE / "trace-connect.c"), "-o", str(output / "trace-connect")], env={"PATH": os.environ["PATH"]}):
        raise Blocked("COMPILER")
    output.chmod(0o755)
    (output / 'trace-connect').chmod(0o755)
    for p in [HERE / "run.py", HERE / "approved.json", output / "trace-connect"]:
        if command(["sudo", "-u", "clpairtest", "test", "-r", str(p)]) or command(["sudo", "-u", "clpairtest", "test", "-w", str(p)]) == 0:
            raise Blocked("ACTUAL_USER_ACCESS")


def executables(api):
    paths = {"PYTHON": Path(sys.executable).resolve()}
    for label, name in (("NODE", "node"), ("ENV", "env"), ("SH", "sh"), ("BASH", "bash")):
        found = shutil.which(name)
        if not found:
            raise Blocked("EXECUTABLE_MISSING")
        paths[label] = Path(found).resolve()
    # Fixed tools used by the pinned get-platform implementation; no executable
    # is trusted based on an arbitrary tracee-supplied name or path.
    for name in ("openssl", "ldconfig", "sed", "grep", "sort", "head", "uname"):
        found = shutil.which(name)
        if found:
            paths[name.upper()] = Path(found).resolve()
    engine = api / "node_modules/.pnpm/@prisma+engines@6.19.3/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x"
    if engine.is_file():
        paths["PRISMA_SCHEMA_ENGINE"] = engine.resolve()
    table = {}
    for label, path in paths.items():
        info = path.stat()
        key = (info.st_dev, info.st_ino)
        # Aliases of one inode have one stable label.
        if key not in table:
            table[key] = {"label": label, "sha256": sha(path), "path": path}
    return table


def validate(data, stage, table):
    if len(data) > MAX_BYTES or stage not in STAGES:
        raise Blocked("TRACE_LIMIT")
    records = []
    for line in data.splitlines():
        if len(records) >= 2048:
            raise Blocked("TRACE_LIMIT")
        item = json.loads(line, object_pairs_hook=unique_object)
        if not isinstance(item, dict) or set(item) != RAW_KEYS or item["stage"] != stage:
            raise Blocked("TRACE_SCHEMA")
        for k in RAW_KEYS - {"kind", "stage", "destination", "parent_verified"}:
            if type(item[k]) is not int or not 0 <= item[k] < 2**64:
                raise Blocked("TRACE_NUMBER")
        if item["uid"] != 24001 or min(item["pid"], item["tid"], item["start_ticks"], item["utc_ns"], item["monotonic_ns"]) < 1:
            raise Blocked("TRACE_IDENTITY")
        if max(item["pid"], item["tid"], item["ppid"]) > 2**31 - 1:
            raise Blocked("TRACE_PID")
        if type(item["parent_verified"]) is not bool or item["parent_verified"] != (item["parent_start_ticks"] > 0):
            raise Blocked("TRACE_PARENT")
        if item["kind"] == "connect":
            if not isinstance(item["destination"], str) or not re.fullmatch(r"[0-9A-Fa-f:.]+", item["destination"]) or not 0 < item["port"] < 65536:
                raise Blocked("TRACE_DESTINATION")
            item["destination"] = str(ipaddress.ip_address(item["destination"]))
            if item['socket_family'] not in {2,10} or item['socket_fd']>2**31-1:
                raise Blocked('TRACE_KIND')
        elif item["kind"] != "exec" or item["destination"] != "" or item["port"] != 0 or item['socket_family'] or item['socket_fd']:
            raise Blocked("TRACE_KIND")
        exe = table.get((item.pop("exe_dev"), item.pop("exe_ino")))
        if not exe or not re.fullmatch(r"[A-Z_]+", exe["label"]) or not re.fullmatch(r"[0-9a-f]{64}", exe["sha256"]):
            raise Blocked("UNKNOWN_EXECUTABLE")
        item["executable"] = {"label": exe["label"], "sha256": exe["sha256"]}
        item["confidence"] = "STOPPED_THREAD_EXECUTABLE_AND_DESTINATION"
        records.append(item)
    if not records:
        raise Blocked("EMPTY_TRACE")
    if any(sha(exe["path"]) != exe["sha256"] for exe in table.values()):
        raise Blocked("EXECUTABLE_CHANGED")
    if len(json.dumps(records).encode()) > MAX_BYTES:
        raise Blocked("OUTPUT_LIMIT")
    return records


def counters(control):
    # The reviewed check always prints exactly one counter line, including when
    # the nonzero counter correctly makes it exit 1. No rule changes here.
    r = subprocess.run(["bash", str(control / "ci/pilot-exact-pair/network.sh"), "check"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
    if len(r.stdout) > 128 or not re.fullmatch(rb"BLOCKED_EXTERNAL_PACKETS: [0-9]+\n", r.stdout):
        raise Blocked("COUNTER_UNAVAILABLE")
    n = int(r.stdout.split()[-1])
    if r.returncode != (0 if n == 0 else 1):
        raise Blocked("COUNTER_STATUS")
    return n


def policy(before, after):
    if type(before) is not int or type(after) is not int or before < 0 or after < before:
        raise Blocked("COUNTER_INTEGRITY")
    return "PASS" if after == before else "BLOCKED"


def environment(api, home, opt_out=False):
    result = {"PATH": os.environ["PATH"], "CI": "true", "APP_ENV": "test", "NODE_ENV": "test",
              "HOME": str(home), "XDG_CACHE_HOME": str(home / "cache"), "XDG_CONFIG_HOME": str(home / "config"),
              "DATABASE_URL": "postgresql://postgres:postgres@127.0.0.1:55447/carbonlite_ci_test"}
    if opt_out:
        result["CHECKPOINT_DISABLE"] = "1"
    return result


class Cancelled(BaseException):
    pass


@contextlib.contextmanager
def cancellation_handlers():
    signals = (signal.SIGINT,signal.SIGTERM,signal.SIGHUP)
    old = {s:signal.getsignal(s) for s in signals}
    old_mask=None
    def stop(*_): raise Cancelled()
    def quiet():
        nonlocal old_mask
        old_mask=signal.pthread_sigmask(signal.SIG_BLOCK,signals)
        for s in signals:signal.signal(s,signal.SIG_IGN)
    try:
        for s in signals:signal.signal(s,stop)
        yield quiet
    finally:
        for s,handler in old.items():signal.signal(s,handler)
        if old_mask is not None:signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)


def process_birth(pid):
    fields=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
    if fields[0] in {'Z','X'}:raise Blocked('LIFECYCLE_INVALID')
    value=int(fields[19])
    if value<1:raise Blocked('LIFECYCLE_INVALID')
    return value


def lifecycle_evidence(data, stage, driver_id):
    if len(data)>MAX_BYTES:raise Blocked('TRACE_LIMIT')
    rows=[json.loads(line,object_pairs_hook=unique_object) for line in data.splitlines()]
    begin_keys={'kind','stage','uid','pid','start_ticks','driver_pid','driver_start_ticks'}
    end_keys=begin_keys|{'root_pid','root_start_ticks','root_exit_code','root_latched','trace_complete',
                        'cleanup_complete','remaining_tasks','reaped_tasks'}
    if len(rows)<2 or not isinstance(rows[0],dict) or not isinstance(rows[-1],dict):raise Blocked('LIFECYCLE_INVALID')
    begin,end=rows[0],rows[-1]
    if set(begin)!=begin_keys or set(end)!=end_keys or begin['kind']!='observer' or end['kind']!='completion':raise Blocked('LIFECYCLE_INVALID')
    for r in (begin,end):
        for k in r.keys()-{'kind','stage','root_latched','trace_complete','cleanup_complete'}:
            if type(r[k]) is not int or not 0<=r[k]<2**64:raise Blocked('LIFECYCLE_INVALID')
        if r['stage']!=stage or r['uid']!=24001 or r['pid']<1 or r['pid']>2**31-1 or r['start_ticks']<1:
            raise Blocked('LIFECYCLE_INVALID')
        if (r['driver_pid'],r['driver_start_ticks'])!=driver_id:raise Blocked('LIFECYCLE_INVALID')
    if (begin['pid'],begin['start_ticks'])!=(end['pid'],end['start_ticks']):raise Blocked('LIFECYCLE_INVALID')
    if any(type(end[k]) is not bool for k in ('root_latched','trace_complete','cleanup_complete')):raise Blocked('LIFECYCLE_INVALID')
    if end['root_exit_code']>255 or end['remaining_tasks']>256 or end['reaped_tasks']>1000000:raise Blocked('LIFECYCLE_INVALID')
    if end['root_pid']>2**31-1:raise Blocked('LIFECYCLE_INVALID')
    if end['trace_complete'] and (not end['root_latched'] or not end['root_start_ticks'] or not end['root_pid']):raise Blocked('LIFECYCLE_INVALID')
    if end['cleanup_complete'] and (end['remaining_tasks'] or end['reaped_tasks']<1):raise Blocked('LIFECYCLE_INVALID')
    return b'\n'.join(json.dumps(r).encode() for r in rows[1:-1]),end


def observe(workspace, stage, argv, env, table, expected_failure=False):
    binary = workspace / "diagnostic-bin/trace-connect"
    result_root = workspace / "diagnostic-results"
    # Normal runner captures metadata only; tracees cannot write this directory.
    fd, name = tempfile.mkstemp(prefix="trace-", dir=result_root)
    proc=None; code=None; failure=None; report={'stage':stage,'cleanup_complete':False,'proxy_reaped':False,'observer_settled':False}
    driver_id=None
    try:
      with os.fdopen(fd, "wb") as sink, cancellation_handlers() as quiet_signals:
        try:
            driver_id=(os.getpid(),process_birth(os.getpid()))
            cmd = ["sudo", "-u", "clpairtest", "env", "-i", *[k + "=" + v for k, v in env.items()],
                   str(binary), stage, "--driver", str(driver_id[0])+':'+str(driver_id[1]), "--", *argv]
            proc = subprocess.Popen(cmd, cwd=workspace / "carbonlite-api", stdin=subprocess.DEVNULL,
                                    stdout=sink, stderr=subprocess.DEVNULL, start_new_session=True)
            code = proc.wait(timeout=190)
        except BaseException as error:
            failure=error
        finally:
            # Additional cancellation cannot bypass the bounded cleanup handshake.
            quiet_signals()
            if proc is not None:
                try:
                    if failure is not None or proc.poll() is None:
                        try:os.killpg(proc.pid,signal.SIGTERM)
                        except ProcessLookupError:pass
                    code=proc.wait(timeout=8)
                    report['proxy_reaped']=True
                except BaseException:
                    try:os.killpg(proc.pid,signal.SIGKILL)
                    except (ProcessLookupError,PermissionError):pass
                    try:code=proc.wait(timeout=5);report['proxy_reaped']=True
                    except BaseException:pass
            sink.flush()
            try:
                if Path(name).stat().st_size>MAX_BYTES:raise Blocked('TRACE_LIMIT')
                raw,end=lifecycle_evidence(Path(name).read_bytes(),stage,driver_id)
                deadline=time.monotonic()+2
                while not settled(end['pid'],end['start_ticks']) and time.monotonic()<deadline:time.sleep(.01)
                report.update({'pid':end['pid'],'start_ticks':end['start_ticks'],'root_pid':end['root_pid'],
                               'root_start_ticks':end['root_start_ticks'],'root_exit_code':end['root_exit_code'],
                               'root_latched':end['root_latched'],'trace_complete':end['trace_complete'],
                               'remaining_tasks':end['remaining_tasks'],'reaped_tasks':end['reaped_tasks'],
                               'observer_settled':settled(end['pid'],end['start_ticks'])})
                report['cleanup_complete']=bool(end['cleanup_complete'] and not end['remaining_tasks'] and
                                               report['proxy_reaped'] and report['observer_settled'])
            except BaseException:
                report['cleanup_complete']=False
            if len(CLEANUP_REPORTS)>=16:raise Blocked('CLEANUP_UNVERIFIED')
            CLEANUP_REPORTS.append(report)
      if not report['cleanup_complete']:raise Blocked('CLEANUP_UNVERIFIED')
      if failure is not None:
        raise Blocked('TRACE_TIMEOUT' if isinstance(failure,subprocess.TimeoutExpired) else 'CANCELLED')
      if not end['trace_complete']:
        if not expected_failure or code!=125:raise Blocked('TRACE_INCOMPLETE')
      elif code!=end['root_exit_code'] or not end['root_latched']:
        raise Blocked('TRACE_INCOMPLETE')
      records=validate(raw,stage,table)
      return code,records
    finally:
        Path(name).unlink(missing_ok=True)


def fixture(case, destination):
    """Linux-only synthetic children; never send a payload or contact historical IPs."""
    dest = Path(destination)
    if case not in {"direct", "grandchild", "short", "detached", "ipv6", "ipv6-loopback", "thread", "interrupted", "unreadable-detached"}:
        return 78
    def attempt():
        family, host = (socket.AF_INET6, "::ffff:192.0.2.1") if case == "ipv6" else (socket.AF_INET, "192.0.2.1")
        port = 443
        listener = None
        if case == 'ipv6-loopback':
            family,host=socket.AF_INET6,'::1'
            listener=socket.socket(family,socket.SOCK_STREAM)
            listener.bind((host,0));listener.listen(1)
            port=listener.getsockname()[1]
        # Expected identities recorded independently by the synthetic caller.
        import threading
        value = {"pid": os.getpid(), "tid": threading.get_native_id(), "ppid": os.getppid(), "uid": os.getuid(), "destination": str(ipaddress.ip_address(host)), "port": port,
                 "start_ticks": int(Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19])}
        with socket.socket(family, socket.SOCK_STREAM) as s:
            value.update(socket_family=family,socket_fd=s.fileno(),socket_type=s.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE),
                         protocol=s.getsockopt(socket.SOL_SOCKET,socket.SO_PROTOCOL))
            write(dest,value)
            if case == 'unreadable-detached':
                import ctypes
                if ctypes.CDLL(None).prctl(4,0,0,0,0):return 1
            s.settimeout(2)
            if case == "interrupted":
                signal.signal(signal.SIGALRM, lambda *_: None)
                signal.setitimer(signal.ITIMER_REAL, 0.001)
            try:
                s.connect((host, port))
            except OSError:
                if listener is not None:return 1
            else:
                if listener is None:return 1
                connection,_=listener.accept();connection.close()
            finally:
                if case == "interrupted":
                    signal.setitimer(signal.ITIMER_REAL, 0)
                if listener is not None:listener.close()
        return 0
    if case == "thread":
        import threading
        status = []
        t = threading.Thread(target=lambda: status.append(attempt()))
        t.start(); t.join()
        return status[0]
    if case in {"grandchild", "short", "detached", "unreadable-detached"}:
        detached = case in {"detached", "unreadable-detached"}
        read_fd, write_fd = os.pipe() if detached else (-1, -1)
        child = os.fork()
        if not child:
            if detached:
                os.close(write_fd)
                os.setsid()
                grandchild = os.fork()
                if grandchild:
                    os._exit(0)
                # EOF proves the launched root has exited and closed its only
                # write end. No timing-based sleep or payload exchange.
                if os.read(read_fd, 1) != b'':
                    os._exit(1)
                os.close(read_fd)
            os._exit(attempt())
        if detached:
            os.close(read_fd)
            os._exit(0)  # Observer must continue after this launched root exits.
        _, status = os.waitpid(child, 0)
        return os.waitstatus_to_exitcode(status)
    return attempt()


def settled(pid, start):
    try:
        fields = Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
        return int(fields[19]) != start or fields[0] in {'Z', 'X'}
    except FileNotFoundError:
        return True
    except Exception:
        return False


def kernel_events(data, begin_us, end_us):
    """Only existing CLPAIR_DENY kernel headers; no raw journal uploads."""
    if len(data)>65536:raise Blocked('KERNEL_EVIDENCE')
    result=[]
    for line in data.splitlines():
        r=json.loads(line,object_pairs_hook=unique_object)
        if not isinstance(r,dict) or not isinstance(r.get('MESSAGE'),str):raise Blocked('KERNEL_EVIDENCE')
        message=r['MESSAGE']; stamp=r.get('__REALTIME_TIMESTAMP','')
        if not isinstance(stamp,str) or not re.fullmatch(r'[0-9]{1,20}',stamp):raise Blocked('KERNEL_EVIDENCE')
        stamp=int(stamp)
        if not begin_us<=stamp<=end_us:continue
        if len(message)>4096 or message.count('CLPAIR_DENY ')!=1 or any(ord(c)<32 or ord(c)>126 for c in message):
            raise Blocked('KERNEL_EVIDENCE')
        pairs=re.findall(r'\b(DST|DPT|PROTO|UID)=([^\s]+)',message)
        f=dict(pairs)
        if len(f)!=len(pairs) or set(f)!={'DST','DPT','PROTO','UID'} or f['UID']!='24001' or f['PROTO']!='TCP':
            raise Blocked('CALIBRATION_UNEXPECTED')
        if not re.fullmatch(r'[0-9a-fA-F:.]+',f['DST']) or not re.fullmatch(r'[0-9]{1,5}',f['DPT']):raise Blocked('KERNEL_EVIDENCE')
        address=str(ipaddress.ip_address(f['DST']));port=int(f['DPT'])
        if not 0<port<65536:raise Blocked('KERNEL_EVIDENCE')
        result.append({'utc_us':stamp,'uid':24001,'destination':address,'port':port,'protocol':'TCP'})
        if len(result)>16:raise Blocked('KERNEL_EVIDENCE')
    return result


def read_kernel(begin_us, expected_count, after):
    deadline=time.monotonic()+2
    while True:
        end_us=time.time_ns()//1000
        r=subprocess.run(['sudo','journalctl','-k','--no-pager','-o','json','--output-fields=__REALTIME_TIMESTAMP,MESSAGE',
                          '--grep=CLPAIR_DENY ','--since','@'+str(begin_us//1000000)+'.'+str(begin_us%1000000).zfill(6),
                          '--until','@'+str(end_us//1000000)+'.'+str(end_us%1000000).zfill(6),'-n','32'],
                         stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5)
        if r.returncode:raise Blocked('KERNEL_EVIDENCE')
        events=kernel_events(r.stdout,begin_us,end_us)
        if counters(CONTROL)!=after:raise Blocked('CALIBRATION_AMBIGUOUS')
        if len(events)==expected_count:return events
        if len(events)>expected_count or time.monotonic()>=deadline:raise Blocked('CALIBRATION_AMBIGUOUS')
        time.sleep(.05)


def expected_calibration(case, expected):
    if case not in CASES:raise Blocked('CALIBRATION_UNEXPECTED')
    keys={'pid','tid','ppid','uid','destination','port','start_ticks','socket_family','socket_fd','socket_type','protocol'}
    if set(expected)!=keys:raise Blocked('CAPABILITY_EVIDENCE')
    for k in keys-{'destination'}:
        if type(expected[k]) is not int or not 0<=expected[k]<2**64:raise Blocked('CAPABILITY_EVIDENCE')
    if any(expected[k]>=2**31 for k in ('pid','tid','ppid','socket_fd')) or min(expected['pid'],expected['tid'],expected['start_ticks'])<1:
        raise Blocked('CAPABILITY_EVIDENCE')
    if expected['uid']!=24001 or expected['socket_type']!=socket.SOCK_STREAM or expected['protocol']!=socket.IPPROTO_TCP:
        raise Blocked('CALIBRATION_UNEXPECTED')
    # Linux UAPI values, including during a macOS-only parser regression.
    family=10 if case in {'ipv6','ipv6-loopback'} else 2
    address='::ffff:c000:201' if case=='ipv6' else '::1' if case=='ipv6-loopback' else '192.0.2.1'
    if expected['socket_family']!=family or expected['destination']!=address or not 0<expected['port']<65536 or (case!='ipv6-loopback' and expected['port']!=443):
        raise Blocked('CALIBRATION_UNEXPECTED')
    return address


def calibration(case, expected, records, before, after, packets):
    address=expected_calibration(case,expected)
    connects=[r for r in records if r['kind']=='connect'];execs=[r for r in records if r['kind']=='exec']
    negative=case=='unreadable-detached'
    if len(execs)!=1 or execs[0]['executable']['label']!='PYTHON' or len(connects)!=(0 if negative else 1):
        raise Blocked('CALIBRATION_UNEXPECTED')
    if connects and any(connects[0][k]!=v for k,v in expected.items() if k not in {'socket_type','protocol'}):
        raise Blocked('CALIBRATION_UNEXPECTED')
    denied=case not in {'unreadable-detached','ipv6-loopback'}
    if policy(before,after)!=('BLOCKED' if denied else 'PASS') or after-before!=int(denied) or len(packets)!=int(denied):
        raise Blocked('CALIBRATION_AMBIGUOUS')
    if packets:
        ip=ipaddress.ip_address(address);ip=ip.ipv4_mapped if getattr(ip,'ipv4_mapped',None) else ip
        packet=packets[0]
        if (packet['uid'],packet['destination'],packet['port'],packet['protocol'])!=(24001,str(ip),expected['port'],'TCP'):
            raise Blocked('CALIBRATION_UNEXPECTED')
    return True


def export_check(workspace):
    root = workspace / 'diagnostic-results/published'
    allowed = {'capability.json', 'arm-A.json', 'arm-B.json', 'identity.json', 'summary.json', 'network.json'}
    if not root.is_dir() or root.is_symlink():
        raise Blocked('NO_SANITIZED_ARTIFACTS')
    total = 0
    for p in root.iterdir():
        if p.name not in allowed or p.is_symlink() or not p.is_file() or p.stat().st_mode & 0o077:
            raise Blocked('ARTIFACT_MANIFEST')
        total += p.stat().st_size
        if p.stat().st_size > MAX_BYTES or total > 2 * 1024 * 1024:
            raise Blocked('ARTIFACT_LIMIT')
        value = json.loads(p.read_bytes(), object_pairs_hook=unique_object)
        export_schema(value)
    if not (root / 'summary.json').is_file():
        raise Blocked('MISSING_SUMMARY')


def export_schema(value):
    """Second privacy boundary: no unrestricted string/key or scalar output."""
    approved = json.loads((HERE / 'approved.json').read_text())['backend']
    words = set()
    def collect(x):
        if isinstance(x, dict):
            for k,v in x.items(): words.add(k); collect(v)
        elif isinstance(x, list):
            for v in x: collect(v)
        elif isinstance(x, str): words.add(x)
    collect(approved)
    words.update(STAGES)
    words.update(FAILURE_CODES)
    words.update({'kind','exec','connect','stage','utc_ns','monotonic_ns','uid','pid','tid','start_ticks','ppid',
                  'parent_start_ticks','parent_verified','destination','port','executable','label','sha256','confidence',
                  'STOPPED_THREAD_EXECUTABLE_AND_DESTINATION','cases','case','status','events','denied_calibration_packets',
                  'socket_family','socket_fd','socket_type','protocol','TCP','utc_us','firewall','cleanup','expected',
                  'cleanup_complete','proxy_reaped','observer_settled','trace_complete','root_pid','root_start_ticks',
                  'root_exit_code','root_latched','remaining_tasks','reaped_tasks',
                  'limitations','direct','grandchild','short','detached','ipv6','ipv6-loopback','thread','interrupted','unreadable-detached',
                  'PASS','BLOCKED','arm','A','B','checkpoint_disabled','migration_exit','counter_before','counter_after','network',
                  'before','after','commit','tree','changed_files','approved_commit','reviewed_file_sha256','identity',
                  'arms_completed','calibration_packets','final_packets','no_historical_attribution','no_exact_pair_validation_claim',
                  'reason','TRACE_OR_DIAGNOSTIC_FAILURE','DIAGNOSTIC_FAILURE','error_code','no_retry','observed_packets','counter_verified','NODE','PYTHON','ENV','SH','BASH','OPENSSL','LDCONFIG',
                  'SED','GREP','SORT','HEAD','UNAME','PRISMA_SCHEMA_ENGINE',CAP_LIMIT,ARM_LIMIT})
    def check(x, key='', depth=0):
        if depth>12: raise Blocked('ARTIFACT_DEPTH')
        if isinstance(x,dict):
            for k,v in x.items():
                if k not in words: raise Blocked('ARTIFACT_KEY')
                check(v,k,depth+1)
        elif isinstance(x,list):
            for v in x: check(v,key,depth+1)
        elif type(x) is bool:
            return
        elif type(x) is int:
            if not 0<=x<2**64: raise Blocked('ARTIFACT_NUMBER')
        elif isinstance(x,str):
            if key=='destination' and x:
                if not re.fullmatch(r'[0-9a-f:.]+',x): raise Blocked('ARTIFACT_IP')
                ipaddress.ip_address(x)
            elif key=='sha256':
                if not re.fullmatch(r'[0-9a-f]{64}',x): raise Blocked('ARTIFACT_DIGEST')
            elif x not in words and not (key=='destination' and x==''):
                raise Blocked('ARTIFACT_STRING')
        else: raise Blocked('ARTIFACT_SCALAR')
    check(value)


def final_counter(workspace):
    current = counters(CONTROL)
    root = workspace / 'diagnostic-results/published'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    summary_path = root / 'summary.json'
    summary = json.loads(summary_path.read_text()) if summary_path.is_file() else {}
    if not summary:
        summary = {'status': 'BLOCKED', 'reason': 'TRACE_OR_DIAGNOSTIC_FAILURE', 'no_retry': True}
        write(summary_path, summary)
    try:
        receipt=json.loads((root/'capability.json').read_text(),object_pairs_hook=unique_object)
        cases=receipt['cases'];previous=0
        if len(cases)!=len(CASES) or {r['case'] for r in cases}!=CASES:raise Blocked('CALIBRATION_AMBIGUOUS')
        for r in cases:
            if r['counter_before']!=previous:raise Blocked('CALIBRATION_AMBIGUOUS')
            calibration(r['case'],r['expected'],r['events'],r['counter_before'],r['counter_after'],r['firewall'])
            cleanup=r['cleanup']
            if not all(cleanup.get(k) is True for k in ('cleanup_complete','proxy_reaped','observer_settled')) or cleanup.get('remaining_tasks')!=0:
                raise Blocked('CLEANUP_UNVERIFIED')
            previous=r['counter_after']
        ok = (summary.get('status') == 'PASS' and summary.get('arms_completed') == 2 and
              current == summary.get('calibration_packets') == summary.get('final_packets') ==
              receipt['denied_calibration_packets'] == previous == len(CASES)-2)
    except Exception:
        ok=False
    write(root / 'network.json', {'status': 'PASS' if ok else 'BLOCKED', 'observed_packets': current,
                                'counter_verified': True})
    return 0 if ok else 1


def experiment(workspace):
    if sys.platform != "linux" or os.getuid() in {0, 24001}:
        raise Blocked("RUNNER_IDENTITY")
    approved, _ = integrity()
    api = workspace / "carbonlite-api"
    published = workspace / "diagnostic-results/published"
    published.mkdir(mode=0o700, parents=True, exist_ok=False)
    initial = identity(workspace)
    table = executables(api)
    if command(["node", "-e", "if(require('prisma/package.json').version!=='6.19.3')process.exit(1)"], cwd=api, env={"PATH": os.environ["PATH"]}):
        raise Blocked("PRISMA_VERSION")
    baseline = counters(CONTROL)
    if baseline != 0:
        raise Blocked("DIRTY_COUNTER")
    sandbox = workspace / "diagnostic-results/disposable"
    # Made by reviewed workflow and owned exclusively by UID 24001.
    if sandbox.is_symlink() or sandbox.stat().st_uid != 24001:
        raise Blocked("DISPOSABLE_DIRECTORY")
    cases = []
    previous_case=baseline
    for case in ("direct", "grandchild", "short", "detached", "ipv6", "ipv6-loopback", "thread", "interrupted", "unreadable-detached"):
        begin_us=time.time_ns()//1000
        case_before = counters(CONTROL)
        if case_before!=previous_case:raise Blocked('CALIBRATION_AMBIGUOUS')
        golden = sandbox / (case + ".json")
        env = environment(api, sandbox)
        env["CANARY"] = CANARY
        code, records = observe(workspace, "capability", [sys.executable, str(HERE / "run.py"), "fixture", case, str(golden), CANARY], env, table,
                                expected_failure=(case=='unreadable-detached'))
        # Metadata fixture belongs to UID 24001; do not relax directory access.
        r = subprocess.Popen(["sudo", "-u", "clpairtest", "cat", str(golden)],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            data = r.stdout.read(4097)
            code_read = r.wait(timeout=5)
        finally:
            if r.poll() is None:
                r.kill(); r.wait(timeout=5)
        if code_read or len(data) > 4096:
            raise Blocked("CAPABILITY_EVIDENCE")
        expected = json.loads(data)
        expected_calibration(case,expected)
        negative = case == "unreadable-detached"
        if (negative and (code != 125 or not settled(expected['pid'], expected['start_ticks']))) or (not negative and code) or CANARY in json.dumps(records):
            raise Blocked("CAPABILITY_MISMATCH")
        case_after = counters(CONTROL)
        denied = not negative and case != 'ipv6-loopback'
        packets=read_kernel(begin_us,int(denied),case_after)
        calibration(case,expected,records,case_before,case_after,packets)
        previous_case=case_after
        cases.append({"case": case, "status": "PASS", "events": records, 'firewall':packets,
                      'counter_before':case_before,'counter_after':case_after,'cleanup':CLEANUP_REPORTS[-1], 'expected':expected})
        if command(["sudo", "-u", "clpairtest", "rm", "--", str(golden)]):
            raise Blocked("CAPABILITY_CLEANUP")
    calibration_total = counters(CONTROL)
    if calibration_total != previous_case or calibration_total != len(cases)-2:
        raise Blocked("DENIAL_CALIBRATION")
    write(published / "capability.json", {"cases": cases, "denied_calibration_packets": calibration_total,
          "limitations": CAP_LIMIT})
    arms = []
    previous = calibration_total
    for arm, disabled in (("A", False), ("B", True)):
        # A fresh database per arm, only in the known job service container.
        container = os.environ.get("POSTGRES_CONTAINER", "")
        if not re.fullmatch(r"[0-9a-f]{64}", container):
            raise Blocked("CONTAINER_IDENTITY")
        image = subprocess.run(['docker','inspect','--format','{{.Config.Image}}',container],
                               stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
        if image.returncode or image.stdout != b'postgres:16\n':
            raise Blocked('CONTAINER_IDENTITY')
        check_sql = "DO $$ BEGIN IF current_database()<>'carbonlite_ci_test' THEN RAISE EXCEPTION 'identity'; END IF; END $$;"
        if command(['docker','exec',container,'psql','-U','postgres','-d','carbonlite_ci_test','-v','ON_ERROR_STOP=1','-c',check_sql]):
            raise Blocked('DATABASE_IDENTITY')
        if command(["docker", "exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "DROP DATABASE carbonlite_ci_test WITH (FORCE)", "-c", "CREATE DATABASE carbonlite_ci_test"]):
            raise Blocked("DISPOSABLE_RESET")
        home = sandbox / ("arm-" + arm)
        if command(["sudo", "-u", "clpairtest", "mkdir", "-m", "700", str(home)]):
            raise Blocked("FRESH_HOME")
        env = environment(api, home, disabled)
        # Verify the database name and empty public schema; no content exported.
        sql = "DO $$ BEGIN IF current_database()<>'carbonlite_ci_test' OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public') THEN RAISE EXCEPTION 'identity'; END IF; END $$;"
        if command(['docker','exec',container,'psql','-U','postgres','-d','carbonlite_ci_test','-v','ON_ERROR_STOP=1','-c',sql]):
            raise Blocked("DATABASE_IDENTITY")
        code, records = observe(workspace, "arm-" + arm + "-migrate", ["pnpm", "exec", "prisma", "migrate", "deploy"], env, table)
        current = counters(CONTROL)
        result = {"arm": arm, "checkpoint_disabled": disabled, "migration_exit": code,
                  "counter_before": previous, "counter_after": current,
                  "network": policy(previous, current), "events": records,
                  "limitations": ARM_LIMIT, 'cleanup':CLEANUP_REPORTS[-1]}
        write(published / ("arm-" + arm + ".json"), result)
        arms.append(result)
        previous = current
        if code:
            raise Blocked("MIGRATION_FAILURE")
    final = identity(workspace)
    write(published / "identity.json", {"before": initial, "after": final})
    ok = all(a["network"] == "PASS" for a in arms)
    write(published / "summary.json", {"status": "PASS" if ok else "BLOCKED", "arms_completed": len(arms),
         "calibration_packets": calibration_total, "final_packets": previous,
         "no_historical_attribution": True, "no_exact_pair_validation_claim": True,'cleanup':CLEANUP_REPORTS})
    return 0 if ok else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["verify", "prepare", "experiment", "fixture", "export-check", "counter-check"])
    parser.add_argument("args", nargs="*")
    args = parser.parse_args()
    if args.mode == "fixture":
        if sys.platform != "linux" or os.getuid() != 24001 or len(args.args) != 3 or args.args[-1] != CANARY:
            return 78
        return fixture(args.args[0], args.args[1])
    if len(args.args) != 1:
        return 78
    workspace = Path(args.args[0]).resolve(strict=True)
    if args.mode == 'counter-check':
        return final_counter(workspace)
    if args.mode == 'export-check':
        export_check(workspace)
        print('DIAGNOSTIC_EXPORT: PASS')
        return 0
    if args.mode == "prepare":
        prepare(workspace)
        print("DIAGNOSTIC_PREPARATION: PASS")
        return 0
    if args.mode == "verify":
        identity(workspace)
        print("DIAGNOSTIC_IDENTITY: PASS")
        return 0
    return experiment(workspace)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Never stringify exceptions, paths, argv, environment or database errors.
        code = failure_code(error)
        print("HOSTED_NETWORK_DIAGNOSTIC: BLOCKED " + code, file=sys.stderr)
        if len(sys.argv) == 3 and sys.argv[1] == "experiment":
            try:
                target = Path(sys.argv[2]).resolve() / "diagnostic-results/published/summary.json"
                if target.parent.is_dir() and not target.exists():
                    write(target, {"status": "BLOCKED", "reason": "TRACE_OR_DIAGNOSTIC_FAILURE", "error_code": code, "no_retry": True,'cleanup':CLEANUP_REPORTS})
            except Exception:
                pass  # Primary failure remains nonzero; no unsafe fallback text.
        sys.exit(1)
