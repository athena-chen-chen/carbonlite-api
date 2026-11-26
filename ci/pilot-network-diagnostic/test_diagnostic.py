"""Local contract/privacy tests. Linux runtime coverage is explicitly separate."""
import copy
import ast
import contextlib
import io
import stat
import struct
import types
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("isolated_diagnostic", HERE / "run.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.exe = Path(self.temp.name) / "verified-executable"
        self.exe.write_bytes(b"synthetic executable identity\n")
        self.table = {(5, 6): {"label": "NODE", "sha256": driver.sha(self.exe), "path": self.exe}}
        self.row = {"kind": "connect", "stage": "capability", "utc_ns": 100, "monotonic_ns": 200,
                    "uid": 24001, "pid": 300, "tid": 301, "start_ticks": 20, "ppid": 299,
                    "parent_start_ticks": 19, "parent_verified": True, "exe_dev": 5, "exe_ino": 6,
                    "destination": "192.0.2.1", "port": 443, 'socket_family':2, 'socket_fd':3}

    def parse(self, row=None):
        return driver.validate(json.dumps(self.row if row is None else row).encode() + b"\n", "capability", self.table)

    def test_ipv4_metadata_and_executable_hash(self):
        result = self.parse()[0]
        self.assertEqual(result["destination"], "192.0.2.1")
        self.assertEqual(result["executable"]["sha256"], driver.sha(self.exe))
        self.assertNotIn("path", result["executable"])

    def test_ipv6(self):
        self.row["destination"] = "2001:db8::1"
        self.assertEqual(self.parse()[0]["destination"], "2001:db8::1")

    def test_mapped_ipv6_canonicalized(self):
        self.row['destination']='::ffff:192.0.2.1'
        self.assertEqual(self.parse()[0]['destination'],'::ffff:c000:201')

    def test_duplicate_fields_rejected(self):
        with self.assertRaises(driver.Blocked):
            driver.validate(b'{"kind":"exec","kind":"connect"}', 'capability', self.table)

    def test_unknown_parent_is_explicit(self):
        self.row.update(parent_start_ticks=0, parent_verified=False)
        self.assertFalse(self.parse()[0]["parent_verified"])

    def test_exec_record_has_no_args(self):
        self.row.update(kind="exec", destination="", port=0,socket_family=0,socket_fd=0)
        self.assertEqual(self.parse()[0]["kind"], "exec")

    def test_extra_sensitive_fields_rejected(self):
        for key in ("argv", "environ", "payload", "stack", "message"):
            row = dict(self.row, **{key: driver.CANARY})
            with self.subTest(key=key), self.assertRaises(driver.Blocked): self.parse(row)

    def test_canary_in_any_string_field_rejected(self):
        for key in ("kind", "stage", "destination"):
            row = dict(self.row, **{key: driver.CANARY})
            with self.subTest(key=key), self.assertRaises((driver.Blocked, ValueError)): self.parse(row)

    def test_unicode_control_and_json_escapes_rejected(self):
        for text in ("192.0.2.1\nPRIVATE", "\u202ePRIVATE", "\u0000PRIVATE", "\\u0050RIVATE"):
            with self.subTest(text=text), self.assertRaises((driver.Blocked, ValueError)):
                self.parse(dict(self.row, destination=text))

    def test_nested_values_rejected(self):
        for key in ("pid", "destination", "parent_verified"):
            with self.subTest(key=key), self.assertRaises((driver.Blocked, ValueError)):
                self.parse(dict(self.row, **{key: {"secret": driver.CANARY}}))

    def test_invalid_numbers_and_booleans(self):
        for key, val in (("pid", True), ("pid", -1), ("pid", 2**31), ("uid", 0), ("port", 65536),
                         ("port", 0), ("utc_ns", 0), ("start_ticks", 0), ("exe_ino", 2**64)):
            with self.subTest(key=key, val=val), self.assertRaises(driver.Blocked):
                self.parse(dict(self.row, **{key: val}))

    def test_parent_confidence_cannot_be_forged(self):
        self.row["parent_verified"] = False
        with self.assertRaises(driver.Blocked): self.parse()

    def test_untrusted_executable_rejected(self):
        self.row["exe_ino"] = 7
        with self.assertRaises(driver.Blocked): self.parse()

    def test_executable_tamper_rejected(self):
        self.exe.write_text("changed")
        with self.assertRaises(driver.Blocked): self.parse()

    def test_empty_and_malformed_output_rejected(self):
        for raw in (b"", b"garbage", b"[]", b"null", b'{"secret":"PRIVATE"}'):
            with self.subTest(raw=raw), self.assertRaises((driver.Blocked, ValueError, TypeError)):
                driver.validate(raw, "capability", self.table)

    def test_limits_rejected(self):
        with self.assertRaises(driver.Blocked): driver.validate(b" " * (driver.MAX_BYTES + 1), "capability", self.table)
        row = json.dumps(self.row).encode() + b"\n"
        with self.assertRaises(driver.Blocked): driver.validate(row * 2049, "capability", self.table)

    def test_bounded_write_and_no_overwrite(self):
        dest = Path(self.temp.name) / "safe.json"
        driver.write(dest, {"result": "BLOCKED"})
        self.assertEqual(dest.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError): driver.write(dest, {})
        with self.assertRaises(driver.Blocked): driver.write(Path(self.temp.name) / "large", "x" * driver.MAX_BYTES)

    def test_symlink_output_rejected(self):
        dest = Path(self.temp.name) / "link"
        dest.symlink_to(self.exe)
        with self.assertRaises(OSError): driver.write(dest, {})


class PolicyTests(unittest.TestCase):
    def setUp(self):
        driver.CLEANUP_REPORTS.clear()

    def receipt(self):
        rows=[];before=0
        for name in ('direct','grandchild','short','detached','ipv6','ipv6-loopback','thread','interrupted','unreadable-detached'):
            addr='::ffff:c000:201' if name=='ipv6' else '::1' if name=='ipv6-loopback' else '192.0.2.1'
            expected={'pid':300,'tid':300,'ppid':299,'uid':24001,'start_ticks':20,
                      'destination':addr,'port':12345 if name=='ipv6-loopback' else 443,
                      'socket_family':10 if name.startswith('ipv6') else 2,'socket_fd':3,'socket_type':1,'protocol':6}
            exe={'kind':'exec','pid':300,'executable':{'label':'PYTHON'}}
            event={k:v for k,v in expected.items() if k not in {'socket_type','protocol'}}
            event['kind']='connect';event['executable']={'label':'PYTHON'}
            negative=name=='unreadable-detached';denied=name not in {'unreadable-detached','ipv6-loopback'}
            packets=[{'uid':24001,'destination':'192.0.2.1','port':443,'protocol':'TCP','utc_us':123}] if denied else []
            rows.append({'case':name,'expected':expected,'events':[exe]+([] if negative else [event]),
                         'counter_before':before,'counter_after':before+int(denied),'firewall':packets,
                         'cleanup':{'cleanup_complete':True,'proxy_reaped':True,'observer_settled':True,'remaining_tasks':0}})
            before+=int(denied)
        return {'cases':rows,'denied_calibration_packets':before}

    def test_expected_plus_unexpected_connection_is_blocked(self):
        r=self.receipt()['cases'][0]
        r['events'].append(dict(r['events'][1],destination='198.51.100.2'))
        r['firewall'].append(dict(r['firewall'][0],destination='198.51.100.2'))
        with self.assertRaises(driver.Blocked):driver.calibration(r['case'],r['expected'],r['events'],0,2,r['firewall'])

    def test_all_exact_calibrations_reconcile(self):
        for r in self.receipt()['cases']:
            with self.subTest(case=r['case']):
                self.assertTrue(driver.calibration(r['case'],r['expected'],r['events'],r['counter_before'],r['counter_after'],r['firewall']))

    def test_wrong_destination_port_protocol_or_missing_header_blocks(self):
        for change in ('destination','port','protocol','missing','extra-counter','wrong-type'):
            r=copy.deepcopy(self.receipt()['cases'][0])
            if change=='missing':r['firewall']=[]
            elif change=='extra-counter':r['counter_after']=2
            elif change=='wrong-type':r['expected']['socket_type']=2
            else:r['firewall'][0][change]={'destination':'198.51.100.2','port':80,'protocol':'UDP'}[change]
            with self.subTest(change=change),self.assertRaises(driver.Blocked):
                driver.calibration(r['case'],r['expected'],r['events'],r['counter_before'],r['counter_after'],r['firewall'])

    def test_invalid_golden_identity_is_rejected_before_process_lookup(self):
        for value in ('../../PRIVATE',-1,True):
            r=self.receipt()['cases'][0];r['expected']['pid']=value
            with self.subTest(value=value),self.assertRaises(driver.Blocked):driver.expected_calibration('direct',r['expected'])

    def test_kernel_parser_retains_only_tcp_header_metadata(self):
        raw=json.dumps({'__REALTIME_TIMESTAMP':'100','MESSAGE':'CLPAIR_DENY DST=192.0.2.1 DPT=443 PROTO=TCP UID=24001'}).encode()
        out=driver.kernel_events(raw,90,110)
        self.assertEqual(out,[{'utc_us':100,'uid':24001,'destination':'192.0.2.1','port':443,'protocol':'TCP'}])
        for text in ('CLPAIR_DENY DST=192.0.2.1 DPT=443 PROTO=UDP UID=24001','CLPAIR_DENY DST=PRIVATE DPT=443 PROTO=TCP UID=24001'):
            with self.assertRaises((driver.Blocked,ValueError)):
                driver.kernel_events(json.dumps({'__REALTIME_TIMESTAMP':'100','MESSAGE':text}).encode(),90,110)

    def test_missing_kernel_coverage_cannot_waive_counter(self):
        r=subprocess.CompletedProcess([],0,stdout=b'')
        with patch.object(driver.subprocess,'run',return_value=r),patch.object(driver,'counters',return_value=1), \
             patch.object(driver.time,'monotonic',side_effect=[0,3]),patch.object(driver.time,'time_ns',return_value=100000):
            with self.assertRaises(driver.Blocked):driver.read_kernel(90,1,1)

    def test_exception_codes_are_fixed_allowlist_only(self):
        self.assertEqual(driver.failure_code(driver.Blocked('TRACE_SCHEMA')),'TRACE_SCHEMA')
        for err in (ValueError(driver.CANARY),driver.Blocked(driver.CANARY),driver.Blocked({'secret':driver.CANARY})):
            self.assertEqual(driver.failure_code(err),'DIAGNOSTIC_FAILURE')

    def test_complete_overlay_checksum_and_control_identity(self):
        original=driver.CONTROL
        if not (original/'SHA256SUMS.txt').exists():
            original=HERE.parents[2]/'exact-pair-ci-preparation'
        if not (original/'SHA256SUMS.txt').exists():self.skipTest('Reviewed original control bundle unavailable')
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve()/'control';root.mkdir()
            approval=json.loads((HERE/'approved.json').read_text())
            for rel in approval['control_payloads']+['SHA256SUMS.txt']:
                dest=root/rel;dest.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(original/rel,dest)
            for rel in approval['payloads']+['ci/pilot-network-diagnostic/SHA256SUMS.txt']:
                dest=root/rel;dest.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(driver.CONTROL/rel,dest)
            with patch.object(driver,'CONTROL',root),patch.object(driver,'HERE',root/'ci/pilot-network-diagnostic'):
                found,_=driver.integrity()
                self.assertEqual(found['backend']['expected_commit'],approval['backend']['expected_commit'])
                (root/'ci/pilot-network-diagnostic/trace-connect.c').write_text('unexpected')
                with self.assertRaises(driver.Blocked):driver.integrity()

    def test_export_rejects_nested_private_text(self):
        for value in ({'message':driver.CANARY}, {'events':[{'destination':'::1%'+driver.CANARY}]}, {'reason':driver.CANARY}):
            with self.subTest(value=value),self.assertRaises((driver.Blocked,ValueError)):
                driver.export_schema(value)

    def test_export_accepts_only_safe_fixed_failure(self):
        driver.export_schema({'status':'BLOCKED','reason':'TRACE_OR_DIAGNOSTIC_FAILURE','no_retry':True})

    def test_final_counter_cannot_hide_post_arm_packets(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p=root/'diagnostic-results/published';p.mkdir(parents=True)
            driver.write(p/'summary.json',{'status':'PASS','arms_completed':2,'calibration_packets':7,'final_packets':7})
            with patch.object(driver,'counters',return_value=8):
                self.assertEqual(driver.final_counter(root),1)
            self.assertEqual(json.loads((p/'network.json').read_text())['status'],'BLOCKED')

    def test_final_counter_missing_summary_is_blocked(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(driver,'counters',return_value=0):
            self.assertEqual(driver.final_counter(Path(temp)),1)

    def test_final_counter_calibration_only_is_not_exact_pair_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p=root/'diagnostic-results/published';p.mkdir(parents=True)
            driver.write(p/'summary.json',{'status':'PASS','arms_completed':2,'calibration_packets':7,'final_packets':7})
            driver.write(p/'capability.json',self.receipt())
            with patch.object(driver,'counters',return_value=7):self.assertEqual(driver.final_counter(root),0)

    def test_former_final_gate_counterexample_without_receipt_blocks(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p=root/'diagnostic-results/published';p.mkdir(parents=True)
            driver.write(p/'summary.json',{'status':'PASS','arms_completed':2,'calibration_packets':2,'final_packets':2})
            with patch.object(driver,'counters',return_value=2):self.assertEqual(driver.final_counter(root),1)

    def test_observer_timeout_fails_and_requests_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'diagnostic-results').mkdir()
            with patch.object(driver.subprocess,'Popen') as popen,patch.object(driver.os,'killpg') as kill,patch.object(driver,'process_birth',return_value=10):
                proc=popen.return_value;proc.pid=123;proc.wait.side_effect=[subprocess.TimeoutExpired('observer',190),125]
                with self.assertRaises(driver.Blocked):driver.observe(root,'capability',['true'],{}, {})
                kill.assert_called_once_with(123,driver.signal.SIGTERM)
                self.assertEqual(list((root/'diagnostic-results').iterdir()),[])

    def run_interrupt(self, error, ack=True, observer_settled=True, normal_code=None):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'diagnostic-results').mkdir()
            exe=Path(sys.executable).resolve();s=exe.stat()
            table={(s.st_dev,s.st_ino):{'label':'PYTHON','sha256':driver.sha(exe),'path':exe}}
            begin={'kind':'observer','stage':'capability','uid':24001,'pid':77,'start_ticks':11,
                   'driver_pid':os.getpid(),'driver_start_ticks':10}
            end=dict(begin,kind='completion',root_pid=300,root_start_ticks=20,root_exit_code=normal_code or 0,root_latched=True,
                     trace_complete=normal_code is not None,cleanup_complete=True,remaining_tasks=0,reaped_tasks=3)
            event={'kind':'exec','stage':'capability','utc_ns':100,'monotonic_ns':200,'uid':24001,'pid':300,'tid':300,
                   'start_ticks':20,'ppid':77,'parent_start_ticks':11,'parent_verified':True,'exe_dev':s.st_dev,'exe_ino':s.st_ino,
                   'destination':'','port':0,'socket_family':0,'socket_fd':0}
            def launch(*args,**kwargs):
                for row in [begin,event]+([end] if ack else []):kwargs['stdout'].write(json.dumps(row).encode()+b'\n')
                kwargs['stdout'].flush()
                return proc
            from unittest.mock import MagicMock
            proc=MagicMock();proc.pid=123;proc.wait.side_effect=[error,125] if normal_code is None else [normal_code,normal_code]
            proc.poll.return_value=normal_code
            with patch.object(driver.subprocess,'Popen',side_effect=launch),patch.object(driver.os,'killpg') as kill, \
                 patch.object(driver,'process_birth',return_value=10),patch.object(driver,'settled',return_value=observer_settled), \
                 patch.object(driver.time,'monotonic',side_effect=[0,3]):
                if normal_code is None:
                    with self.assertRaises(driver.Blocked) as caught:driver.observe(root,'capability',['true'],{},table)
                    self.assertEqual(kill.call_args_list[0].args,(123,driver.signal.SIGTERM))
                else:
                    result=driver.observe(root,'capability',['true'],{},table)
                    self.assertEqual(result[0],normal_code);kill.assert_not_called()
                self.assertEqual(driver.CLEANUP_REPORTS[-1]['cleanup_complete'],ack and observer_settled)
                self.assertEqual(list((root/'diagnostic-results').iterdir()),[])
                return caught.exception if normal_code is None else result

    def test_keyboard_interrupt_terminates_reaps_and_verifies_ack(self):
        self.assertEqual(str(self.run_interrupt(KeyboardInterrupt())),'CANCELLED')
        self.assertTrue(driver.CLEANUP_REPORTS[-1]['proxy_reaped'])

    def test_sigterm_path_requests_and_verifies_cleanup(self):
        self.assertEqual(str(self.run_interrupt(driver.Cancelled())),'CANCELLED')

    def test_system_exit_zero_cannot_bypass_cleanup_or_report_pass(self):
        self.assertEqual(str(self.run_interrupt(SystemExit(0))),'CANCELLED')

    def test_normal_nonzero_migration_status_is_preserved(self):
        self.assertEqual(self.run_interrupt(None,normal_code=7)[0],7)

    def test_missing_ack_or_live_observer_never_claims_cleanup(self):
        for ack,settled in ((False,True),(True,False)):
            driver.CLEANUP_REPORTS.clear()
            self.assertEqual(str(self.run_interrupt(KeyboardInterrupt(),ack,settled)),'CLEANUP_UNVERIFIED')

    def test_signal_handlers_restore_and_raise_supported_cancellation(self):
        for sig in (driver.signal.SIGINT,driver.signal.SIGTERM,driver.signal.SIGHUP):
            old=driver.signal.getsignal(sig)
            with self.assertRaises(driver.Cancelled):
                with driver.cancellation_handlers():driver.signal.getsignal(sig)(sig,None)
            self.assertEqual(driver.signal.getsignal(sig),old)

    def test_artifact_allowlist_no_raw_logs(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p=root/'diagnostic-results/published';p.mkdir(parents=True)
            driver.write(p/'summary.json',{'status':'BLOCKED','reason':'TRACE_OR_DIAGNOSTIC_FAILURE'})
            driver.export_check(root)
            (p/'raw.log').write_text(driver.CANARY)
            with self.assertRaises(driver.Blocked):driver.export_check(root)

    def test_counter_zero_delta_only_passes(self):
        self.assertEqual(driver.policy(10, 10), "PASS")
        self.assertEqual(driver.policy(10, 11), "BLOCKED")

    def test_counter_regression_missing_or_invalid_blocked(self):
        for a,b in ((3,2),(None,2),(0,None),(-1,0),(True,1)):
            with self.subTest(a=a,b=b),self.assertRaises(driver.Blocked): driver.policy(a,b)

    def test_counter_command_failure_or_malformed_output_blocks(self):
        for raw, code in ((b"",1),(b"BLOCKED_EXTERNAL_PACKETS: 3\n",0),(b"PRIVATE",1)):
            with patch.object(driver.subprocess, "run", return_value=subprocess.CompletedProcess([], code, stdout=raw)):
                with self.assertRaises(driver.Blocked): driver.counters(Path("/synthetic"))

    def test_nonzero_counter_retains_failure(self):
        with patch.object(driver.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, stdout=b"BLOCKED_EXTERNAL_PACKETS: 3\n")):
            self.assertEqual(driver.counters(Path("/synthetic")), 3)

    def test_two_arm_environments_differ_only_opt_out_and_home(self):
        a=driver.environment(Path('/synthetic'),Path('/synthetic/A'))
        b=driver.environment(Path('/synthetic'),Path('/synthetic/A'),True)
        self.assertEqual({k:v for k,v in b.items() if k!='CHECKPOINT_DISABLE'},a)
        self.assertEqual(b['CHECKPOINT_DISABLE'],'1')

    def test_ambient_credentials_not_inherited(self):
        with patch.dict(os.environ, {'GITHUB_TOKEN':driver.CANARY,'AWS_SECRET_ACCESS_KEY':driver.CANARY,'CHECKPOINT_DISABLE':'1'}):
            env=driver.environment(Path('/synthetic'),Path('/synthetic'))
            self.assertNotIn(driver.CANARY,json.dumps(env))
            self.assertNotIn('CHECKPOINT_DISABLE',env)

    def test_application_output_discarded(self):
        with patch.object(driver.subprocess,'run',return_value=subprocess.CompletedProcess([],1)) as run:
            self.assertEqual(driver.command(['false']),1)
            self.assertEqual(run.call_args.kwargs['stdout'],subprocess.DEVNULL)
            self.assertEqual(run.call_args.kwargs['stderr'],subprocess.DEVNULL)

    def test_control_pin_and_candidate_identity(self):
        a=json.loads((HERE/'approved.json').read_text())
        self.assertEqual(a['backend']['expected_commit'],'e424c567d43c0086e0dc01b86e48cb648c114078')
        self.assertEqual(a['backend']['expected_tree'],'f4e02d756dc14c0df638d7086b483566e7efeca5')
        self.assertEqual(len(a['backend']['files']),8)
        self.assertEqual(len(a['control_payloads']),15)
        self.assertEqual(len(a['payloads']),6)

    def test_non_linux_experiment_fails_before_sudo(self):
        with patch.object(driver.sys,'platform','darwin'),patch.object(driver.subprocess,'run') as run:
            with self.assertRaises(driver.Blocked):driver.experiment(Path('/synthetic'))
            run.assert_not_called()

    def test_driver_never_weakens_firewall_or_enables_trace_privileges(self):
        source=(HERE/'run.py').read_text()
        self.assertNotIn('CAP_SYS_PTRACE',source)
        self.assertNotIn('ptrace_scope',source)
        self.assertNotIn('iptables',source)
        self.assertNotIn('setcap',source)


class CContractTests(unittest.TestCase):
    def test_root_pid_reuse_and_failure_status_in_actual_C_helper(self):
        compiler=shutil.which('clang') or shutil.which('gcc')
        if not compiler:self.skipTest('No existing C compiler')
        with tempfile.TemporaryDirectory() as temp:
            binary=Path(temp)/'root-selftest'
            subprocess.run([compiler,'-std=c11','-Wall','-Wextra','-Werror','-DCL_ROOT_SELFTEST',str(HERE/'trace-connect.c'),'-o',str(binary)],check=True)
            r=subprocess.run([str(binary)],capture_output=True,timeout=5)
            self.assertEqual(r.returncode,0)
            self.assertEqual(r.stdout,b'ROOT_IDENTITY_SELFTEST: PASS\n')

    def test_linux_branch_typechecks_without_runtime_claim(self):
        compiler=shutil.which('clang')
        if not compiler:self.skipTest('No existing clang')
        subprocess.run([compiler,'-std=c11','-Wall','-Wextra','-Werror','-fsyntax-only','-DCL_SYNTAX_ONLY',str(HERE/'trace-connect.c')],check=True)

    def test_native_portability_build_and_unavailable_platform(self):
        compiler=shutil.which('clang') or shutil.which('gcc')
        if not compiler:self.skipTest('No existing C compiler')
        with tempfile.TemporaryDirectory() as temp:
            binary=Path(temp)/'observer'
            subprocess.run([compiler,'-std=c11','-Wall','-Wextra','-Werror',str(HERE/'trace-connect.c'),'-o',str(binary)],check=True)
            if sys.platform!='linux':
                r=subprocess.run([str(binary)],capture_output=True)
                self.assertEqual(r.returncode,78)
                self.assertEqual(r.stdout,b'')

    def test_no_payload_or_argument_syscall_logging(self):
        c=(HERE/'trace-connect.c').read_text()
        self.assertNotIn('/environ',c)
        self.assertNotIn('/cmdline',c)
        self.assertNotIn('strace',c)
        self.assertIn('PT_GETINFO',c)
        self.assertIn('0x100000',c)
        self.assertIn('2048',c)
        self.assertRegex(c,r'512\s*\*\s*1024')
        self.assertRegex(c,r'dup2\(nullfd,\s*1\)')

    @unittest.skipUnless(sys.platform=='linux' and os.getuid()==24001,'NOT RUN: requires isolated Linux UID 24001, deny rules, compiled observer')
    def test_runtime_unsupported_stage_has_no_child_output(self):
        binary=os.environ.get('CLPAIR_OBSERVER')
        if not binary:self.skipTest('No precompiled isolated observer supplied')
        r=subprocess.run([binary,'unsupported','--','/bin/true'],capture_output=True,timeout=5)
        self.assertEqual(r.returncode,78)
        self.assertEqual(r.stdout,b'')

class PreparationEvidenceTests(unittest.TestCase):
    """Mocked ACL snapshots plus real owner-only temporary artifact I/O, not Linux ACL installation."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name).resolve()
        (self.workspace / 'diagnostic-results').mkdir(mode=0o700)
        self.control = self.workspace / 'control'
        self.here = self.control / 'ci/pilot-network-diagnostic'
        self.here.mkdir(parents=True)
        (self.here / 'approved.json').write_text(json.dumps({'payloads': []}))
        self.info = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755,
                                          st_uid=os.getuid(), st_gid=os.getgid())
        self.guard_path = driver.CONTROL / 'ci/pilot-exact-pair/runner-permissions.py'
        if not self.guard_path.is_file():
            self.guard_path = HERE.parents[2] / 'exact-pair-ci-preparation/ci/pilot-exact-pair/runner-permissions.py'
        self.guard_spec = importlib.util.spec_from_file_location('evidence_test_guard', self.guard_path)
        self.guard = importlib.util.module_from_spec(self.guard_spec)
        self.guard_spec.loader.exec_module(self.guard)

    def entries(self, tag=2, ident=None, perms=7, mask=7):
        ident = os.getuid() if ident is None else ident
        values = [(1, 7, 0xffffffff), (4, 5, 0xffffffff), (32, 5, 0xffffffff)]
        if tag is not None:
            values += [(tag, perms, ident), (16, mask, 0xffffffff)]
        data = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *v) for v in values)
        return data, self.guard.acl_entries(data)

    def summary(self, tag=2, ident=24001, default=True):
        _, entries = self.entries(tag, ident)
        with patch.object(driver, 'CONTROL', self.control):
            return driver.acl_failure_evidence(self.here, self.workspace, self.info,
                'system.posix_acl_default' if default else 'system.posix_acl_access', entries, 7)

    def prepare_snapshot(self, tag=2, ident=24001, mask=7, default=True):
        data, _ = self.entries(tag, ident, mask=mask)
        attr = 'system.posix_acl_default' if default else 'system.posix_acl_access'
        class CompilerReached(Exception): pass
        with patch.object(driver, 'CONTROL', self.control), patch.object(driver, 'HERE', self.here), \
             patch.object(driver, 'identity', return_value={}), patch.object(driver.sys, 'platform', 'linux'), \
             patch.object(driver.importlib.util, 'spec_from_file_location', return_value=self.guard_spec), \
             patch.object(Path, 'lstat', return_value=self.info), \
             patch.object(driver.os, 'listxattr', side_effect=lambda path, **kw: [attr] if path == self.here else [], create=True), \
             patch.object(driver.os, 'getxattr', return_value=data, create=True), \
             patch.object(driver, 'command', side_effect=CompilerReached):
            try:
                driver.prepare(self.workspace)
            except CompilerReached:
                return None  # No ACL rejection; no compiler/process was executed.
            except driver.Blocked as error:
                self.assertEqual(driver.failure_code(error), 'CONTROL_ACL')
                return error
        self.fail('Expected ACL decision or compiler sentinel')

    def invoke_failure(self, error):
        output = io.StringIO()
        with patch.object(driver, 'main', side_effect=error), \
             patch.object(driver.sys, 'argv', ['run.py', 'prepare', str(self.workspace)]), \
             contextlib.redirect_stderr(output):
            status = driver.entrypoint()
        self.assertEqual(status, 1)
        self.assertIn('HOSTED_NETWORK_DIAGNOSTIC: BLOCKED CONTROL_ACL', output.getvalue())
        self.assertNotIn(driver.CANARY, output.getvalue())
        return output.getvalue()

    def test_trusted_owner_only_acl_still_not_rejected(self):
        self.assertIsNone(self.prepare_snapshot(tag=None))

    def test_trusted_named_users_allowed_for_access_and_default(self):
        for uid in (0, os.getuid()):
            for default in (True, False):
                with self.subTest(uid=uid, default=default):
                    # Each successful sentinel creates diagnostic-bin; use a fresh snapshot directory.
                    out = self.workspace / 'diagnostic-bin'
                    if out.exists(): out.rmdir()
                    self.assertIsNone(self.prepare_snapshot(ident=uid, default=default))

    def test_approved_named_group_allowed(self):
        with patch.object(driver, 'trusted_acl_group', return_value=True):
            self.assertIsNone(self.prepare_snapshot(tag=8, ident=os.getgid()))

    def test_untrusted_named_user_still_blocked(self):
        error = self.prepare_snapshot(ident=24001)
        self.assertEqual(error.preparation_evidence['preparation_failure']['principal_class'], 'UNTRUSTED_NAMED_USER')

    def test_untrusted_named_group_still_blocked(self):
        error = self.prepare_snapshot(tag=8, ident=24001)
        self.assertEqual(error.preparation_evidence['preparation_failure']['principal_class'], 'UNTRUSTED_NAMED_GROUP')

    def test_masked_untrusted_write_is_rejected_with_accurate_evidence(self):
        for tag in (2, 8):
            error = self.prepare_snapshot(tag=tag, ident=24001, mask=5)
            row = error.preparation_evidence['preparation_failure']
            self.assertFalse(row['mask_effective_write'])
            self.assertEqual(row['acl_mask'], 5)

    def test_default_acl_records_only_inheritance_potential(self):
        row = self.summary()['preparation_failure']
        self.assertEqual(row['acl_type'], 'DEFAULT')
        self.assertEqual(row['write_effect'], 'POTENTIAL_INHERITED_WRITE')
        self.assertEqual(row['current_object_write'], 'NOT_GRANTED_BY_DEFAULT_ACL')
        self.assertIs(row['mask_effective_write'], True)

    def test_access_acl_mask_does_not_claim_proven_current_access(self):
        row = self.summary(default=False)['preparation_failure']
        self.assertEqual(row['write_effect'], 'ACCESS_MASK_PERMITS_WRITE')
        self.assertEqual(row['current_object_write'], 'NOT_ESTABLISHED')

    def test_record_path_is_allowlisted_relative_path(self):
        row = self.summary()['preparation_failure']
        self.assertEqual((row['path_class'], row['path']), ('CONTROL_RELATIVE', 'ci/pilot-network-diagnostic'))
        self.assertEqual(row['mode'], '0755')
        self.assertEqual(row['file_type'], 'DIRECTORY')

    def test_workspace_ancestors_are_fixed_classifications_only(self):
        with patch.object(driver, 'CONTROL', self.control):
            self.assertEqual(driver.preparation_path(self.workspace, self.workspace), ('WORKSPACE_ROOT', '', 0))
            self.assertEqual(driver.preparation_path(self.workspace.parent, self.workspace), ('WORKSPACE_ANCESTOR', '', 1))
            result = driver.preparation_path(Path('/'), self.workspace)
            self.assertEqual(result[0:2], ('FILESYSTEM_ROOT', ''))
            self.assertGreater(result[2], 0)

    def test_unallowlisted_path_is_not_serialized(self):
        with patch.object(driver, 'CONTROL', self.control):
            for path in (self.control / driver.CANARY, self.workspace / driver.CANARY):
                with self.subTest(path_kind='synthetic'), self.assertRaises(driver.Blocked):
                    driver.preparation_path(path, self.workspace)

    def test_missing_or_malformed_record_fails_schema(self):
        for value in (None, {}, [], {'status': 'BLOCKED', 'preparation_failure': None}):
            with self.subTest(kind=type(value).__name__), self.assertRaises(driver.Blocked):
                driver.preparation_schema(value)
        value = self.summary(); del value['preparation_failure']['acl_mask']
        with self.assertRaises(driver.Blocked): driver.preparation_schema(value)

    def test_invalid_principal_owner_and_mode_fields_fail_closed(self):
        for key, bad in [('principal_id', -1), ('principal_id', True), ('principal_id', 0xffffffff),
                         ('owner_uid', driver.CANARY), ('owner_gid', None), ('mode', '0777'),
                         ('mode', '0755\n'), ('principal_class', 'TRUSTED_ROOT_USER')]:
            value = self.summary(ident=24001); value['preparation_failure'][key] = bad
            with self.subTest(key=key, bad_type=type(bad).__name__), self.assertRaises(driver.Blocked):
                driver.preparation_schema(value)

    def test_invalid_path_and_nested_sensitive_values_rejected(self):
        for key in driver.PREPARATION_KEYS:
            value = self.summary(); value['preparation_failure'][key] = {'secret': driver.CANARY}
            with self.subTest(key=key), self.assertRaises(driver.Blocked): driver.export_schema(value)
        for bad in ('../' + driver.CANARY, '/private/' + driver.CANARY, '\u202e' + driver.CANARY,
                    'ci/pilot-network-diagnostic\n' + driver.CANARY, '\\u0050' + driver.CANARY):
            value = self.summary(); value['preparation_failure']['path'] = bad
            with self.subTest(kind='synthetic private path'), self.assertRaises(driver.Blocked): driver.export_schema(value)

    def test_arbitrary_extra_names_and_exception_messages_rejected(self):
        for key in ('username', 'acl_dump', 'environ', 'exception', 'absolute_path'):
            value = self.summary(); value['preparation_failure'][key] = driver.CANARY
            with self.subTest(key=key), self.assertRaises(driver.Blocked): driver.export_schema(value)
        value = self.summary(); value['status'] = 'PASS'
        with self.assertRaises(driver.Blocked): driver.export_schema(value)

    def test_inconsistent_effective_write_and_metadata_rejected(self):
        for key, val in [('mask_effective_write', False), ('entry_permissions', 5), ('acl_mask', 5),
                         ('acl_type', 'OTHER'), ('current_object_write', 'CONFIRMED')]:
            value = self.summary(); value['preparation_failure'][key] = val
            with self.subTest(key=key), self.assertRaises(driver.Blocked): driver.export_schema(value)

    def test_valid_artifact_available_but_preparation_exit_remains_nonzero(self):
        error = self.prepare_snapshot(ident=24001)
        self.invoke_failure(error)
        path = self.workspace / 'diagnostic-results/published/summary.json'
        value = json.loads(path.read_text())
        self.assertEqual(value, error.preparation_evidence)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertNotIn(driver.CANARY, path.read_text())
        driver.export_check(self.workspace)  # Safe upload eligibility, not a successful preparation.

    def test_real_python_exit_nonzero_with_valid_synthetic_failure_artifact(self):
        code = '''import importlib.util,json,sys
s=importlib.util.spec_from_file_location("driver",sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
e=d.Blocked("CONTROL_ACL");e.preparation_evidence=json.loads(sys.stdin.read())
def blocked():raise e
d.main=blocked;sys.argv=["run.py","prepare",sys.argv[2]]
sys.exit(d.entrypoint())
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, str(HERE / 'run.py'), str(self.workspace)],
                                input=json.dumps(self.summary()), text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn('HOSTED_NETWORK_DIAGNOSTIC: BLOCKED CONTROL_ACL', result.stderr)
        self.assertNotIn(driver.CANARY, result.stdout + result.stderr)
        driver.export_check(self.workspace)

    def test_regular_file_snapshot_has_no_unrestricted_path(self):
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=os.getuid(), st_gid=os.getgid())
        _, entries = self.entries(ident=24001)
        with patch.object(driver, 'CONTROL', self.control):
            value = driver.acl_failure_evidence(self.here / 'run.py', self.workspace, info,
                                               'system.posix_acl_access', entries, 7)
        self.assertEqual(value['preparation_failure']['file_type'], 'REGULAR_FILE')
        self.assertEqual(value['preparation_failure']['mode'], '0644')
        self.assertEqual(value['preparation_failure']['path'], 'ci/pilot-network-diagnostic/run.py')

    def test_builder_rejects_unsupported_acl_source_and_file_type(self):
        _, entries = self.entries(ident=24001)
        with patch.object(driver, 'CONTROL', self.control):
            with self.assertRaises(driver.Blocked):
                driver.acl_failure_evidence(self.here, self.workspace, self.info, driver.CANARY, entries, 7)
            info = types.SimpleNamespace(st_mode=stat.S_IFIFO | 0o600, st_uid=os.getuid(), st_gid=os.getgid())
            with self.assertRaises(driver.Blocked):
                driver.acl_failure_evidence(self.here, self.workspace, info, 'system.posix_acl_default', entries, 7)

    def test_missing_evidence_never_turns_preparation_into_pass(self):
        message = self.invoke_failure(driver.Blocked('CONTROL_ACL'))
        self.assertIn('PREPARATION_EVIDENCE: BLOCKED', message)
        self.assertFalse((self.workspace / 'diagnostic-results/published/summary.json').exists())
        with self.assertRaises(driver.Blocked): driver.export_check(self.workspace)

    def test_invalid_capture_never_writes_private_artifact(self):
        error = driver.Blocked('CONTROL_ACL')
        error.preparation_evidence = {'message': driver.CANARY}
        message = self.invoke_failure(error)
        self.assertIn('PREPARATION_EVIDENCE: BLOCKED', message)
        self.assertFalse((self.workspace / 'diagnostic-results/published/summary.json').exists())

    def test_tampered_artifact_prevents_export(self):
        error = self.prepare_snapshot()
        self.invoke_failure(error)
        path = self.workspace / 'diagnostic-results/published/summary.json'
        value = json.loads(path.read_text()); value['preparation_failure']['username'] = driver.CANARY
        path.write_text(json.dumps(value))
        with self.assertRaises(driver.Blocked): driver.export_check(self.workspace)

    def test_existing_summary_is_not_overwritten(self):
        error = self.prepare_snapshot()
        self.invoke_failure(error)
        path = self.workspace / 'diagnostic-results/published/summary.json'; before = path.read_bytes()
        self.assertIn('PREPARATION_EVIDENCE: BLOCKED', self.invoke_failure(error))
        self.assertEqual(path.read_bytes(), before)

    def test_symlink_directory_cannot_redirect_capture(self):
        elsewhere = self.workspace / 'unrelated'; elsewhere.mkdir()
        (self.workspace / 'diagnostic-results/published').symlink_to(elsewhere, target_is_directory=True)
        self.assertIn('PREPARATION_EVIDENCE: BLOCKED', self.invoke_failure(self.prepare_snapshot()))
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_classifier_trusted_group_requires_exclusively_trusted_members(self):
        with patch.object(driver.os, 'getuid', return_value=1001), patch.object(driver.os, 'getgid', return_value=1001), \
             patch.object(driver.pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_gid=1001)), \
             patch.object(driver.grp, 'getgrgid', return_value=types.SimpleNamespace(gr_mem=['PRIVATE_USERNAME'])), \
             patch.object(driver.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=1001)), \
             patch.object(driver.pwd, 'getpwall', return_value=[types.SimpleNamespace(pw_uid=1001, pw_gid=1001)]):
            self.assertEqual(driver.acl_principal_class(8, 1001), 'TRUSTED_APPROVED_GROUP')
            with patch.object(driver.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=24001)):
                self.assertEqual(driver.acl_principal_class(8, 1001), 'UNTRUSTED_NAMED_GROUP')
            with patch.object(driver.grp, 'getgrgid', side_effect=KeyError(driver.CANARY)):
                self.assertEqual(driver.acl_principal_class(8, 1001), 'UNVERIFIED_GROUP')

    def test_capture_generation_failure_does_not_change_acl_rejection(self):
        with patch.object(driver, 'acl_failure_evidence', side_effect=ValueError(driver.CANARY)):
            error = self.prepare_snapshot()
        self.assertEqual(driver.failure_code(error), 'CONTROL_ACL')
        self.assertIn('PREPARATION_EVIDENCE: BLOCKED', self.invoke_failure(error))


class ACLPolicyTests(unittest.TestCase):
    setUp = PreparationEvidenceTests.setUp

    def raw(self, entries):
        return struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *e) for e in entries)

    def entries(self, tag=2, ident=24001, mask=7):
        return [(1, 7, 0xffffffff), (tag, 7, ident), (4, 5, 0xffffffff),
                (16, mask, 0xffffffff), (32, 5, 0xffffffff)]

    def check(self, entries=None, default=True, info=None, names=None):
        attr = 'system.posix_acl_default' if default else 'system.posix_acl_access'
        with patch.object(Path, 'lstat', return_value=info or self.info), \
             patch.object(driver, 'CONTROL', self.control), \
             patch.object(driver.os, 'listxattr', return_value=[attr] if names is None else names, create=True), \
             patch.object(driver.os, 'getxattr', return_value=self.raw(entries or self.entries()), create=True):
            return driver.check_control_path(self.here, self.workspace, self.guard)

    def test_hosted_counterexample_accepts_verified_runner_not_fixed_uid(self):
        for uid in (1001, 1201):
            with patch.object(driver.os, 'getuid', return_value=uid), \
                 patch.object(driver.os, 'geteuid', return_value=uid), \
                 patch.object(driver.os, 'getgid', return_value=uid), \
                 patch.object(driver.pwd, 'getpwuid', side_effect=lambda x: types.SimpleNamespace(pw_gid=0 if x==0 else uid)):
                info = types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0)
                self.check(self.entries(ident=uid), info=info)
                with self.assertRaises(driver.Blocked): self.check(self.entries(ident=24001), info=info)

    def test_runner_binding_mismatch_and_test_uid_rejected(self):
        for uid in (0, 24001):
            with patch.object(driver.os, 'getuid', return_value=uid), self.assertRaises(driver.Blocked):
                driver.runner_trust()
        with patch.object(driver.os, 'geteuid', return_value=24001), self.assertRaises(driver.Blocked):
            driver.runner_trust()
        with patch.object(driver.pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_gid=424242)), self.assertRaises(driver.Blocked):
            driver.runner_trust()

    def test_untrusted_named_writes_rejected_even_masked_both_acl_types(self):
        for default in (True,False):
            for tag in (2,8):
                for mask in (0,5,7):
                    with self.subTest(default=default,tag=tag,mask=mask), self.assertRaises(driver.Blocked) as caught:
                        self.check(self.entries(tag,24001,mask),default)
                    record=caught.exception.preparation_evidence
                    self.assertEqual(record['status'],'BLOCKED')
                    self.assertEqual(record['preparation_failure']['mask_effective_write'],bool(mask & 2))
                    driver.preparation_schema(record)

    def test_default_other_write_rejected_with_safe_evidence(self):
        entries=[(1,7,0xffffffff),(4,5,0xffffffff),(32,7,0xffffffff)]
        with self.assertRaises(driver.Blocked) as caught: self.check(entries)
        row=caught.exception.preparation_evidence['preparation_failure']
        self.assertEqual(row['entry_category'],'OTHER')
        self.assertEqual(row['principal_class'],'UNTRUSTED_OTHER')
        self.assertEqual(row['principal_id'],0xffffffff)
        driver.preparation_schema(caught.exception.preparation_evidence)

    def test_default_owning_group_write_needs_trust_even_when_masked(self):
        info=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=os.getuid(),st_gid=24001)
        entries=[(1,7,0xffffffff),(4,7,0xffffffff),(16,5,0xffffffff),(32,5,0xffffffff)]
        with self.assertRaises(driver.Blocked) as caught: self.check(entries,info=info)
        row=caught.exception.preparation_evidence['preparation_failure']
        self.assertEqual(row['entry_category'],'OWNING_GROUP')
        self.assertEqual(row['principal_id'],24001)
        self.assertFalse(row['mask_effective_write'])

    def test_untrusted_owner_world_write_and_symlink_modes_rejected(self):
        for uid,mode in [(24001,stat.S_IFDIR|0o755),(os.getuid(),stat.S_IFDIR|0o757),
                         (os.getuid(),stat.S_IFREG|0o666),(os.getuid(),stat.S_IFLNK|0o755)]:
            info=types.SimpleNamespace(st_mode=mode,st_uid=uid,st_gid=os.getgid())
            with self.assertRaises(driver.Blocked): self.check(info=info,names=[])

    def test_group_mode_alignment_requires_verified_approved_group(self):
        info=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o775,st_uid=os.getuid(),st_gid=os.getgid())
        with patch.object(driver,'trusted_acl_group',return_value=True): self.check(info=info,names=[])
        with patch.object(driver,'trusted_acl_group',return_value=False),self.assertRaises(driver.Blocked):
            self.check(info=info,names=[])

    def test_real_group_lookup_whitelist_and_exclusive_membership(self):
        uid=os.getuid();gid=os.getgid()
        with patch.object(driver.grp,'getgrgid',return_value=types.SimpleNamespace(gr_mem=['SYNTHETIC'])), \
             patch.object(driver.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=uid)), \
             patch.object(driver.pwd,'getpwall',return_value=[types.SimpleNamespace(pw_uid=uid,pw_gid=gid)]):
            self.assertTrue(driver.trusted_acl_group(gid))
            self.assertFalse(driver.trusted_acl_group(24001))
            with patch.object(driver.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=24001)):
                self.assertFalse(driver.trusted_acl_group(gid))
            with patch.object(driver.pwd,'getpwall',return_value=[types.SimpleNamespace(pw_uid=24001,pw_gid=gid)]):
                self.assertFalse(driver.trusted_acl_group(gid))
            with patch.object(driver.grp,'getgrgid',side_effect=KeyError(driver.CANARY)), self.assertRaises(driver.Blocked):
                driver.trusted_acl_group(gid)

    def test_unknown_acl_mechanism_rejected(self):
        with self.assertRaises(driver.Blocked): self.check(names=['user.unknown_acl'])

    def test_malformed_and_unavailable_acl_rejected(self):
        for raw in (b'', b'PRIVATE', self.raw([(2,7,24001)])):
            with patch.object(driver.os,'getxattr',return_value=raw,create=True):
                with patch.object(Path,'lstat',return_value=self.info), \
                     patch.object(driver.os,'listxattr',return_value=['system.posix_acl_default'],create=True), \
                     self.assertRaises(driver.Blocked):
                    driver.check_control_path(self.here,self.workspace,self.guard)
        with patch.object(driver.os,'listxattr',side_effect=OSError(driver.CANARY),create=True), self.assertRaises(OSError):
            driver.check_control_path(self.here,self.workspace,self.guard)
        with patch.object(driver.os,'listxattr',return_value=['system.posix_acl_access'],create=True), \
             patch.object(driver.os,'getxattr',side_effect=OSError(driver.CANARY),create=True), self.assertRaises(driver.Blocked):
            driver.check_control_path(self.here,self.workspace,self.guard)

    def test_default_acl_on_regular_file_rejected(self):
        info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=os.getuid(),st_gid=os.getgid())
        with self.assertRaises(driver.Blocked): self.check(info=info)

    def test_acl_entry_decisions_match_published_exact_pair_policy(self):
        # Execute the actual reviewed reference loop, not a rewritten expectation table.
        tree=ast.parse(self.guard_path.read_text())
        verify=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='verify')
        loop=next(n for n in ast.walk(verify) if isinstance(n,ast.For) and isinstance(n.iter,ast.Call)
                  and isinstance(n.iter.func,ast.Name) and n.iter.func.id=='acl_entries')
        code=compile(ast.fix_missing_locations(ast.Module(body=[loop],type_ignores=[])), 'reviewed-acl-policy', 'exec')
        uid=os.getuid();gid=os.getgid()
        for tag in (1,2,4,8,32):
            for ident in (0,uid,24001):
                for mask in (0,5,7):
                    entries=[(1,7,0xffffffff),(4,5,0xffffffff),(32,5,0xffffffff)]
                    if tag in (2,8): entries += [(tag,7,ident),(16,mask,0xffffffff)]
                    else: entries=[(t,7 if t==tag else p,i) for t,p,i in entries]
                    info=types.SimpleNamespace(st_uid=ident if tag==1 else uid,st_gid=ident if tag==4 else gid)
                    allowed_group=lambda g:g in {0,gid}
                    scope={'acl_entries':lambda data:entries,'data':None,'info':info,'trusted_uids':{0,uid},
                           'trusted_group':allowed_group,'Unsafe':self.guard.Unsafe,'path':'synthetic'}
                    try: exec(code,scope);reference_allowed=True
                    except self.guard.Unsafe: reference_allowed=False
                    with patch.object(driver,'trusted_acl_group',side_effect=allowed_group):
                        self.assertEqual(driver.rejected_acl_entry(entries,info) is None,reference_allowed,
                                         (tag,ident,mask))

    def test_prepare_checks_new_output_controls_and_retains_actual_user_nonwrite(self):
        seen=[];commands=[]
        def command(args,**kw):
            commands.append(args)
            if args[0]=='gcc': Path(args[-1]).write_bytes(b'synthetic observer')
            return int('-w' in args)
        with patch.object(driver,'CONTROL',self.control),patch.object(driver,'HERE',self.here), \
             patch.object(driver,'identity',return_value={}),patch.object(driver.sys,'platform','linux'), \
             patch.object(driver.importlib.util,'spec_from_file_location',return_value=self.guard_spec), \
             patch.object(driver,'check_control_path',side_effect=lambda p,*args:seen.append(p)), \
             patch.object(driver,'command',side_effect=command):
            driver.prepare(self.workspace)
        self.assertIn(self.workspace/'diagnostic-bin',seen)
        self.assertIn(self.workspace/'diagnostic-bin/trace-connect',seen)
        self.assertEqual(sum('-w' in args for args in commands),3)
        self.assertTrue(all(args[:3]==['sudo','-u','clpairtest'] for args in commands if '-w' in args))

    def test_prepare_blocks_unsafe_inherited_output_before_test_execution(self):
        commands=[]
        def command(args,**kw):
            commands.append(args)
            if args[0]=='gcc': Path(args[-1]).write_bytes(b'synthetic observer')
            return 0
        def check(path,*args):
            if path==self.workspace/'diagnostic-bin/trace-connect': raise driver.Blocked('CONTROL_ACL')
        with patch.object(driver,'CONTROL',self.control),patch.object(driver,'HERE',self.here), \
             patch.object(driver,'identity',return_value={}),patch.object(driver.sys,'platform','linux'), \
             patch.object(driver.importlib.util,'spec_from_file_location',return_value=self.guard_spec), \
             patch.object(driver,'check_control_path',side_effect=check), \
             patch.object(driver,'command',side_effect=command),self.assertRaises(driver.Blocked):
            driver.prepare(self.workspace)
        self.assertEqual(len(commands),1)  # Compiler stub only; no observer or migration launched.

    def test_inherited_child_snapshot_cannot_introduce_untrusted_writer(self):
        # Deterministic inheritance model; kernel inheritance is a separate Linux test below.
        for named_uid in (os.getuid(),24001):
            inherited=self.entries(ident=named_uid)
            inherited=[(t,(p & 5 if t==16 else p),i) for t,p,i in inherited]
            for default in (True,False):
                if named_uid==24001:
                    with self.assertRaises(driver.Blocked): self.check(inherited,default)
                else: self.check(inherited,default)

    @unittest.skipUnless(sys.platform=='linux', 'Real Linux ACL inheritance NOT RUN on this platform')
    def test_linux_kernel_inherited_children_checked_without_host_acl_changes(self):
        # ACLs are installed only on this test-owned disposable directory, never host ancestors.
        parent=self.workspace/'inheritance';parent.mkdir(mode=0o700)
        entries=[(1,7,0xffffffff),(2,7,os.getuid()),(4,0,0xffffffff),(16,7,0xffffffff),(32,0,0xffffffff)]
        os.setxattr(parent,'system.posix_acl_default',self.raw(entries))
        child=parent/'control.py'
        fd=os.open(child,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
        info=child.lstat()
        access=self.guard.acl_entries(os.getxattr(child,'system.posix_acl_access'))
        self.assertIsNone(driver.rejected_acl_entry(access,info))
        self.assertFalse(stat.S_IMODE(info.st_mode)&0o022)
        # Named user 24001 is not trusted even if a child creation mask removes its write.
        entries[1]=(2,7,24001)
        os.setxattr(parent,'system.posix_acl_default',self.raw(entries))
        bad=parent/'untrusted.py';bad.touch(mode=0o600)
        bad_acl=self.guard.acl_entries(os.getxattr(bad,'system.posix_acl_access'))
        self.assertIsNotNone(driver.rejected_acl_entry(bad_acl,bad.lstat()))


class ObserverOutputEvidenceTests(unittest.TestCase):
    setUp = PreparationEvidenceTests.setUp
    invoke_failure = PreparationEvidenceTests.invoke_failure

    def output(self, file=False):
        out=self.workspace/'diagnostic-bin'
        out.mkdir(mode=0o755,exist_ok=True)
        target=out/'trace-connect'
        if file and not target.exists(): target.write_bytes(b'synthetic observer')
        return target if file else out

    def rejection(self, file=False):
        target=self.output(file)
        attr='system.posix_acl_access' if file else 'system.posix_acl_default'
        entries=[(1,7,0xffffffff),(2,7,24001),(4,5,0xffffffff),(16,5,0xffffffff),(32,5,0xffffffff)]
        raw=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in entries)
        with patch.object(driver,'CONTROL',self.control), \
             patch.object(driver.os,'listxattr',return_value=[attr],create=True), \
             patch.object(driver.os,'getxattr',return_value=raw,create=True):
            with self.assertRaises(driver.Blocked) as caught:
                driver.check_control_path(target,self.workspace,self.guard)
        return caught.exception

    def test_output_directory_acl_retains_fixed_sanitized_record(self):
        error=self.rejection();row=error.preparation_evidence['preparation_failure']
        self.assertEqual(driver.failure_code(error),'CONTROL_ACL')
        self.assertEqual((row['path_class'],row['path'],row['file_type']),('OBSERVER_OUTPUT_DIRECTORY','','DIRECTORY'))
        self.assertEqual(row['acl_type'],'DEFAULT')
        self.assertEqual(row['principal_id'],24001)
        self.assertFalse(row['mask_effective_write'])
        driver.preparation_schema(error.preparation_evidence)

    def test_observer_file_acl_retains_fixed_sanitized_record(self):
        error=self.rejection(True);row=error.preparation_evidence['preparation_failure']
        self.assertEqual((row['path_class'],row['path'],row['file_type']),('OBSERVER_OUTPUT_FILE','','REGULAR_FILE'))
        self.assertEqual(row['acl_type'],'ACCESS')
        self.assertEqual(row['write_effect'],'ACCESS_WRITE_MASKED')
        driver.preparation_schema(error.preparation_evidence)

    def test_both_failures_keep_exit_one_and_owner_only_uploadable_artifact(self):
        for file in (False,True):
            error=self.rejection(file)
            self.invoke_failure(error)
            artifact=self.workspace/'diagnostic-results/published/summary.json'
            value=json.loads(artifact.read_text())
            self.assertEqual(value['status'],'BLOCKED')
            self.assertEqual(value['preparation_failure']['principal_id'],24001)
            self.assertEqual(stat.S_IMODE(artifact.stat().st_mode),0o600)
            self.assertLessEqual(artifact.stat().st_size,8192)
            self.assertNotIn(str(self.workspace),artifact.read_text())
            self.assertNotIn(driver.CANARY,artifact.read_text())
            driver.export_check(self.workspace)
            artifact.unlink()  # Only this test-created synthetic artifact.

    def test_unknown_output_paths_and_traversal_rejected(self):
        self.output(True)
        targets=[self.workspace/'diagnostic-bin/unknown',self.workspace/'diagnostic-bin/trace-connect/extra',
                 self.workspace/'diagnostic-bin/../diagnostic-bin/trace-connect',
                 self.workspace/'diagnostic-bin/TRACE-CONNECT',Path('/unapproved/trace-connect')]
        with patch.object(driver,'CONTROL',self.control):
            for path in targets:
                with self.subTest(kind='unapproved'),self.assertRaises(driver.Blocked):
                    driver.preparation_path(path,self.workspace)
            for text in (str(self.workspace/'diagnostic-bin'),str(self.workspace/'diagnostic-bin//trace-connect'),
                         str(self.workspace/'diagnostic-bin/./trace-connect')):
                with self.assertRaises(driver.Blocked):driver.preparation_path(text,self.workspace)

    def test_symlink_output_directory_and_file_rejected(self):
        elsewhere=self.workspace/'elsewhere';elsewhere.mkdir()
        out=self.workspace/'diagnostic-bin';out.symlink_to(elsewhere,target_is_directory=True)
        with self.assertRaises(driver.Blocked):driver.preparation_path(out,self.workspace)
        out.unlink();out.mkdir();target=out/'trace-connect';target.symlink_to(elsewhere)
        with self.assertRaises(driver.Blocked):driver.preparation_path(target,self.workspace)

    def test_symlink_workspace_and_noncanonical_workspace_rejected(self):
        self.output(True)
        alias=self.workspace/'workspace-alias';alias.symlink_to(self.workspace,target_is_directory=True)
        with self.assertRaises(driver.Blocked):driver.preparation_path(alias/'diagnostic-bin',alias)
        uncanonical=self.workspace/'diagnostic-bin/..'
        with self.assertRaises(driver.Blocked):driver.preparation_path(uncanonical/'diagnostic-bin',uncanonical)
        with self.assertRaises(driver.Blocked):driver.preparation_path(Path('diagnostic-bin'),Path('.'))

    def test_wrong_actual_file_type_rejected(self):
        out=self.workspace/'diagnostic-bin';out.write_bytes(b'synthetic')
        with self.assertRaises(driver.Blocked):driver.preparation_path(out,self.workspace)
        out.unlink();out.mkdir();target=out/'trace-connect';target.mkdir()
        with self.assertRaises(driver.Blocked):driver.preparation_path(target,self.workspace)

    def test_malformed_record_type_depth_path_and_private_metadata_rejected(self):
        for file in (False,True):
            original=self.rejection(file).preparation_evidence
            for key,value in [('file_type','DIRECTORY' if file else 'REGULAR_FILE'),('ancestor_depth',1),
                              ('path',str(self.workspace)),('path_class','OBSERVER_OUTPUT_UNKNOWN'),
                              ('principal_id',driver.CANARY),('entry_permissions',{'secret':driver.CANARY})]:
                row=copy.deepcopy(original);row['preparation_failure'][key]=value
                with self.assertRaises(driver.Blocked):driver.export_schema(row)

    def test_classification_failure_preserves_original_block_without_artifact(self):
        with patch.object(driver,'preparation_path',side_effect=driver.Blocked('PREPARATION_EVIDENCE')):
            error=self.rejection(True)
        self.assertEqual(driver.failure_code(error),'CONTROL_ACL')
        self.assertFalse(hasattr(error,'preparation_evidence'))
        self.assertIn('PREPARATION_EVIDENCE: BLOCKED',self.invoke_failure(error))
        self.assertFalse((self.workspace/'diagnostic-results/published/summary.json').exists())

    def test_parent_failure_record_is_not_replaced_by_later_observer_rejection(self):
        first=self.rejection(False);self.invoke_failure(first)
        path=self.workspace/'diagnostic-results/published/summary.json';before=path.read_bytes()
        self.assertIn('PREPARATION_EVIDENCE: BLOCKED',self.invoke_failure(self.rejection(True)))
        self.assertEqual(path.read_bytes(),before)


class CalibrationFailureEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.published=self.root/'diagnostic-results/published';self.published.mkdir(parents=True,mode=0o700)
        self.path=self.published/'capability.json'
        self.clean={'cleanup_complete':True,'proxy_reaped':True,'observer_settled':True,'remaining_tasks':0}
        self.expected={'pid':100,'tid':100,'ppid':99,'uid':24001,'destination':'192.0.2.1','port':443,'start_ticks':20,'socket_family':2,'socket_fd':3,'socket_type':1,'protocol':6}
        connect={k:v for k,v in self.expected.items() if k not in {'socket_type','protocol'}}
        self.records=[{'kind':'exec','executable':{'label':'PYTHON'}},{'kind':'connect',**connect}]
        self.packets=[{'uid':24001,'destination':'192.0.2.1','port':443,'protocol':'TCP'}]

    def receipt(self,case='direct',status='PASS',predicate='VALIDATED',before=0,after=1):
        return driver.calibration_receipt(case,status,predicate,self.expected,self.records,before,after,self.packets,self.clean)

    def mismatch(self,kind,category):
        e=copy.deepcopy(self.expected);r=copy.deepcopy(self.records);p=copy.deepcopy(self.packets);after=4
        if kind in {'ppid','pid','tid'}:r[1][kind]+=1
        elif kind=='executable':r[0]['executable']['label']='NODE'
        elif kind=='missing':r.pop()
        elif kind=='extra':r.append(copy.deepcopy(r[1]))
        elif kind=='family':r[1]['socket_family']=10
        elif kind=='destination':r[1]['destination']='192.0.2.2'
        elif kind=='kernel':p[0]['port']=444
        elif kind=='counter':after=5
        with self.assertRaises(driver.Blocked) as caught:driver.calibration('detached',e,r,3,after,p)
        self.assertEqual(caught.exception.calibration_predicate,category)
        row=driver.calibration_receipt('detached','BLOCKED',category,e,r,3,after,p,self.clean)
        self.assertEqual(row['case'],'detached');self.assertEqual(row['predicate'],category)
        driver.receipt_schema(row)
        return row

    def test_detached_ppid_mismatch(self):
        row=self.mismatch('ppid','TRACER_IDENTITY')
        self.assertEqual(row['expected_identity']['ppid'],99);self.assertEqual(row['observed_identity']['ppid'],100)
    def test_pid_tid_mismatch(self):
        for key in ('pid','tid'):self.mismatch(key,'TRACER_IDENTITY')
    def test_executable_classification(self):self.mismatch('executable','EXECUTABLE_CLASSIFICATION')
    def test_missing_connect(self):self.mismatch('missing','CONNECT_EVENT_COUNT')
    def test_extra_connect(self):self.mismatch('extra','CONNECT_EVENT_COUNT')
    def test_socket_family(self):self.mismatch('family','CONNECTION_METADATA')
    def test_destination(self):self.mismatch('destination','CONNECTION_METADATA')
    def test_kernel_tuple(self):self.mismatch('kernel','KERNEL_PACKET_TUPLE')
    def test_counter(self):self.mismatch('counter','COUNTER_RECONCILIATION')

    def test_fixture_and_kernel_parser_categories(self):
        e=copy.deepcopy(self.expected);e['uid']=24002
        with self.assertRaises(driver.Blocked) as c:driver.expected_calibration('detached',e)
        self.assertEqual(c.exception.calibration_predicate,'FIXTURE_IDENTITY')
        with self.assertRaises(driver.Blocked) as c:driver.expected_calibration('detached',{})
        self.assertEqual(c.exception.calibration_predicate,'FIXTURE_SCHEMA')
        raw=json.dumps({'__REALTIME_TIMESTAMP':'10','MESSAGE':'CLPAIR_DENY DST=192.0.2.1 DPT=443 PROTO=UDP UID=24001'}).encode()
        with self.assertRaises(driver.Blocked) as c:driver.kernel_events(raw,0,20)
        self.assertEqual(c.exception.calibration_predicate,'KERNEL_HEADER')

    def test_progress_is_immediate_and_keeps_three_successes_after_failure(self):
        rows=[]
        for n,case in enumerate(('direct','grandchild','short')):
            self.assertTrue(driver.calibration(case,self.expected,self.records,n,n+1,self.packets))
            rows.append(self.receipt(case,before=n,after=n+1))
            driver.publish_calibration(self.path,{'completed':rows,'failure':None})
            self.assertEqual(len(json.loads(self.path.read_text())['calibration_evidence']['completed']),n+1)
        failure=self.mismatch('ppid','TRACER_IDENTITY')
        driver.publish_calibration(self.path,{'completed':rows,'failure':failure})
        value=json.loads(self.path.read_text());driver.export_schema(value)
        self.assertEqual(value['status'],'BLOCKED');self.assertEqual(value['calibration_evidence']['failure']['case'],'detached')
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode),0o600)
        driver.write(self.published/'summary.json',{'status':'BLOCKED','reason':'TRACE_OR_DIAGNOSTIC_FAILURE','no_retry':True})
        driver.export_check(self.root)
        with patch.object(driver,'counters',return_value=4):self.assertEqual(driver.final_counter(self.root),1)

    def test_full_receipt_still_requires_independent_counter_revalidation(self):
        old=PolicyTests().receipt();rows=[]
        for r in old['cases']:
            self.assertTrue(driver.calibration(r['case'],r['expected'],r['events'],r['counter_before'],r['counter_after'],r['firewall']))
            rows.append(driver.calibration_receipt(r['case'],'PASS','VALIDATED',r['expected'],r['events'],r['counter_before'],r['counter_after'],r['firewall'],r['cleanup']))
        complete={**old,'limitations':driver.CAP_LIMIT}
        driver.publish_calibration(self.path,{'completed':rows,'failure':None},complete)
        driver.export_schema(json.loads(self.path.read_text()))
        driver.write(self.published/'summary.json',{'status':'PASS','arms_completed':2,'calibration_packets':7,'final_packets':7})
        with patch.object(driver,'counters',return_value=7):self.assertEqual(driver.final_counter(self.root),0)
        (self.published/'network.json').unlink()
        with patch.object(driver,'counters',return_value=8):self.assertEqual(driver.final_counter(self.root),1)

    def test_evidence_cannot_replace_existing_symlink_or_untrusted_output(self):
        other=self.root/'unrelated';other.write_bytes(b'synthetic unrelated')
        self.path.symlink_to(other)
        with self.assertRaises(driver.Blocked):driver.publish_calibration(self.path,{'completed':[self.receipt()],'failure':None})
        self.assertEqual(other.read_bytes(),b'synthetic unrelated')

    def test_evidence_failure_is_nonzero_and_cannot_remove_existing_file(self):
        temporary=self.path.with_name('capability.next');temporary.write_bytes(b'synthetic existing')
        with self.assertRaises(driver.Blocked):driver.publish_calibration(self.path,{'completed':[self.receipt()],'failure':None})
        self.assertEqual(temporary.read_bytes(),b'synthetic existing')
        self.assertFalse(self.path.exists())
        with patch.object(driver,'main',side_effect=driver.Blocked('CALIBRATION_EVIDENCE')),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(driver.entrypoint(),1)

    def test_sensitive_record_fields_rejected_and_raw_input_not_projected(self):
        row=self.receipt()
        for key in row:
            bad=copy.deepcopy(row);bad[key]=driver.CANARY
            with self.subTest(key=key),self.assertRaises((driver.Blocked,TypeError)):driver.receipt_schema(bad)
        for field in ('args','environment','raw_trace','username','path','exception'):
            bad=copy.deepcopy(row);bad[field]=driver.CANARY
            with self.assertRaises(driver.Blocked):driver.receipt_schema(bad)
        e={**self.expected,'password':driver.CANARY};records=copy.deepcopy(self.records);records[1]['args']=driver.CANARY
        projected=driver.calibration_receipt('detached','BLOCKED','CONNECTION_METADATA',e,records,3,4,self.packets,self.clean)
        self.assertNotIn(driver.CANARY,json.dumps(projected))
        self.assertNotIn('password',json.dumps(projected))

    def test_malformed_receipts_and_oversized_evidence_block(self):
        for field,value in [('counter_after',-1),('observed_delta',False),('observed_exec_count',2049),('kernel_port',65536)]:
            row=self.receipt();row[field]=value
            with self.assertRaises(driver.Blocked):driver.receipt_schema(row)
        row=self.receipt();row['observed_identity']['pid']=2**31
        with self.assertRaises(driver.Blocked):driver.receipt_schema(row)
        with self.assertRaises(driver.Blocked):driver.calibration_evidence_schema({'completed':[self.receipt()]*10,'failure':None})

    def test_regressed_counter_retains_nonnegative_evidence_and_failure(self):
        row=driver.calibration_receipt('detached','BLOCKED','COUNTER_RECONCILIATION',self.expected,self.records,3,2,self.packets,self.clean)
        self.assertEqual(row['counter_before'],3);self.assertEqual(row['counter_after'],2)
        self.assertIsNone(row['observed_delta'])
        driver.receipt_schema(row)

    def test_cleanup_failure_has_no_false_completion(self):
        row=driver.calibration_receipt('detached','BLOCKED','CLEANUP_FAILURE',None,None,None,None,None,None)
        self.assertTrue(all(v is None for v in row['cleanup'].values()))
        driver.receipt_schema(row)

    def fixture_stat(self,path,sandbox,original_stat,*args,**kwargs):
        actual=original_stat(path,*args,**kwargs)
        if path!=sandbox:
            return actual
        values=list(actual)
        values[stat.ST_UID]=24001
        # Preserve fractional/nanosecond timestamps and platform-specific named fields too.
        attributes={k:getattr(actual,k) for k in dir(actual) if k.startswith('st_') and k!='st_uid'}
        return os.stat_result(values,attributes)

    def test_fixture_stat_preserves_every_field_except_synthetic_uid(self):
        sandbox=self.root/'stat-fixture';sandbox.mkdir(mode=0o700)
        real_stat=Path.stat;actual=real_stat(sandbox)
        with patch.object(Path,'stat',lambda path,*a,**kw:self.fixture_stat(path,sandbox,real_stat,*a,**kw)):
            result=sandbox.stat()
            self.assertIsInstance(result,os.stat_result)
            self.assertEqual(result.st_uid,24001)
            for name in dir(actual):
                if name.startswith('st_') and name!='st_uid':self.assertEqual(getattr(result,name),getattr(actual,name),name)
            expected=list(actual);expected[stat.ST_UID]=24001
            self.assertEqual(list(result),expected)
            self.assertEqual(stat.S_IMODE(result.st_mode),stat.S_IMODE(actual.st_mode))
            self.assertTrue(sandbox.is_dir());self.assertFalse(sandbox.is_symlink())
            self.assertEqual(self.root.stat(),real_stat(self.root))

    def test_python312_lstat_delegation_preserves_symlink_and_permission_metadata(self):
        sandbox=self.root/'stat-fixture';sandbox.mkdir(mode=0o700)
        # Reproduce Python 3.12's lstat -> stat(follow_symlinks=False) protocol
        # using real os.stat metadata on older interpreters, without claiming 3.12 execution.
        def fake_stat(path,*args,**kwargs):return self.fixture_stat(path,sandbox,os.stat,*args,**kwargs)
        def delegated_lstat(path):return path.stat(follow_symlinks=False)
        with patch.object(Path,'stat',fake_stat),patch.object(Path,'lstat',delegated_lstat):
            self.assertEqual(sandbox.stat().st_uid,24001)
            self.assertFalse(sandbox.is_symlink())
            self.assertTrue(stat.S_ISDIR(sandbox.lstat().st_mode))
            self.assertEqual(stat.S_IMODE(sandbox.stat().st_mode),0o700)
        sandbox.rmdir();sandbox.symlink_to(self.root,target_is_directory=True)
        with patch.object(Path,'stat',fake_stat),patch.object(Path,'lstat',delegated_lstat):
            self.assertTrue(sandbox.is_symlink())
            self.assertTrue(stat.S_ISLNK(sandbox.lstat().st_mode))
            self.assertTrue(stat.S_ISDIR(sandbox.stat().st_mode))
            self.assertEqual(sandbox.lstat().st_uid,24001)

    def run_mocked_experiment(self,fail_evidence=False):
        from unittest.mock import MagicMock
        workspace=self.root/'experiment';workspace.mkdir()
        (workspace/'carbonlite-api').mkdir()
        sandbox=workspace/'diagnostic-results/disposable';sandbox.mkdir(parents=True)
        current={};original_stat=Path.stat
        def fake_stat(path,*args,**kwargs):
            return self.fixture_stat(path,sandbox,original_stat,*args,**kwargs)
        def observe(w,stage,argv,*args,**kwargs):
            case=argv[3];e=copy.deepcopy(self.expected);records=copy.deepcopy(self.records)
            if case=='detached':records[1]['ppid']+=1
            current['expected']=e
            driver.CLEANUP_REPORTS.append(dict(self.clean,stage='capability'))
            return 0,records
        proc=MagicMock();proc.stdout.read.side_effect=lambda n:json.dumps(current['expected']).encode();proc.wait.return_value=0;proc.poll.return_value=0
        driver.CLEANUP_REPORTS.clear()
        with contextlib.ExitStack() as stack:
            for obj,key,value in [(driver.sys,'platform','linux'),(driver,'integrity',lambda:({},None)),
                                  (driver,'identity',lambda w:{}),(driver,'executables',lambda api:{}),
                                  (driver,'command',lambda *a,**k:0),(driver,'environment',lambda *a,**k:{}),
                                  (driver,'observe',observe),(driver.subprocess,'Popen',lambda *a,**k:proc),
                                  (driver,'read_kernel',lambda *a:self.packets),(Path,'stat',fake_stat)]:
                stack.enter_context(patch.object(obj,key,value))
            stack.enter_context(patch.object(driver,'counters',side_effect=[0,0,1,1,2,2,3,3,4]))
            if fail_evidence:stack.enter_context(patch.object(driver,'publish_calibration',side_effect=driver.Blocked('CALIBRATION_EVIDENCE')))
            with self.assertRaises(driver.Blocked) as caught:driver.experiment(workspace)
        return workspace,caught.exception

    def test_experiment_persists_detached_failure_and_prior_completed_cases(self):
        workspace,error=self.run_mocked_experiment()
        self.assertEqual(driver.failure_code(error),'CALIBRATION_UNEXPECTED')
        value=json.loads((workspace/'diagnostic-results/published/capability.json').read_text())
        evidence=value['calibration_evidence']
        self.assertEqual([r['case'] for r in evidence['completed']],['direct','grandchild','short'])
        self.assertEqual(evidence['failure']['predicate'],'TRACER_IDENTITY')
        self.assertEqual(evidence['failure']['observed_identity']['ppid'],100)
        self.assertEqual(evidence['failure']['expected_identity']['ppid'],99)
        driver.export_schema(value)
        with patch.object(driver,'main',side_effect=error), \
             patch.object(driver.sys,'argv',['run.py','experiment',str(workspace)]),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(driver.entrypoint(),1)
        driver.export_check(workspace)
        with patch.object(driver,'counters',return_value=4):self.assertEqual(driver.final_counter(workspace),1)

    def test_experiment_evidence_failure_never_reports_pass(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            workspace,error=self.run_mocked_experiment(True)
        self.assertEqual(driver.failure_code(error),'CALIBRATION_EVIDENCE')
        self.assertIn('CALIBRATION_EVIDENCE: BLOCKED',err.getvalue())
        self.assertNotIn(driver.CANARY,err.getvalue())
        self.assertFalse((workspace/'diagnostic-results/published/capability.json').exists())

    def test_same_acceptance_predicates_as_D3(self):
        # Remove only evidence wrappers; compare every acceptance If expression and loop in key validators.
        baseline=HERE.parents[2]/'network-diagnostic-observer-evidence/ci/pilot-network-diagnostic/run.py'
        if not baseline.is_file():self.skipTest('D3 comparison overlay unavailable')
        old=ast.parse(baseline.read_text());new=ast.parse((HERE/'run.py').read_text())
        for name in ('expected_calibration','calibration','kernel_events','read_kernel','final_counter'):
            a=next(n for n in old.body if isinstance(n,ast.FunctionDef) and n.name==name)
            b=next(n for n in new.body if isinstance(n,ast.FunctionDef) and n.name==name)
            predicates=lambda n:[ast.dump(x.test) for x in ast.walk(n) if isinstance(x,ast.If)]
            self.assertEqual(predicates(a),predicates(b),name)




# Self-contained evidence derived from independently retrieved immutable D5 bytes.
# Empty Python 3.12 type_params fields are normalized away; nonempty fields are not.
D5_PROTECTED_EVIDENCE = {'commit': '835d44eeb21870171373c446b40833395888f4ed', 'run_source_sha256': '73cf62f54f727ee94c28a6c61152e24afe02f74d1a788952426b21b6da82d411', 'protected_ast_sha256': 'dcb49a681fb010a5f324c7d107de6908cbf20ae25ba9948984b2303592c62c19', 'unchanged_payloads': {'ci/pilot-network-diagnostic/trace-connect.c': '3cebc1a5be7fd147e41edf0727acc081217f60d29328f43aca8af521b7c49d90', '.github/workflows/pilot-network-attribution.yml': '4149fcbe304e5e1687eb3f0f65b77c20739996fe1b15591891b005400dd2c472', 'ci/pilot-network-diagnostic/approved.json': 'ef75dce1d125c0c43144b12fea14dabf93776c3f75d7b6512150e9ee13cff427'}}
D5_EVIDENCE_SHA256 = '39c03454676acc0321a222e4a361aebb5435957d85de285cf6cf8cdd2a503632'
FIXTURE_ONLY_FUNCTIONS = frozenset({'fixture','fixture_pidfd','fixture_pidfd_events',
                                     'fixture_wait_terminated','fixture_parent_guard'})


def normalized_source_ast(value):
    if isinstance(value,bytes): return ["bytes",value.hex()]
    if isinstance(value, ast.AST):
        return [type(value).__name__, [[key, normalized_source_ast(item)]
                for key, item in ast.iter_fields(value)
                if not (key == 'type_params' and item == [])]]
    if isinstance(value, list): return [normalized_source_ast(item) for item in value]
    return value


def verify_d5_protected_source(root, evidence):
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',',':')).encode()
    if type(evidence) is not dict or hashlib.sha256(canonical(evidence)).hexdigest() != D5_EVIDENCE_SHA256:
        raise ValueError('D5_EVIDENCE_IDENTITY')
    source = ast.parse((root/'ci/pilot-network-diagnostic/run.py').read_text())
    body = [node for node in source.body if not
            (isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in FIXTURE_ONLY_FUNCTIONS)]
    if hashlib.sha256(canonical(normalized_source_ast(body))).hexdigest() != evidence['protected_ast_sha256']:
        raise ValueError('D5_PROTECTED_SOURCE')
    for path, expected in evidence['unchanged_payloads'].items():
        if hashlib.sha256((root/path).read_bytes()).hexdigest() != expected:
            raise ValueError('D5_PAYLOAD_IDENTITY')


class DetachedLifecycleTests(unittest.TestCase):
    """Deterministic syscall models, not a claim of Linux ptrace execution."""
    class Exited(BaseException):
        def __init__(self, code): self.code = code

    def test_pidfd_is_bound_before_use(self):
        with patch.object(driver.sys, 'platform', 'linux'), \
             patch.object(driver.os, 'pidfd_open', return_value=31, create=True) as opening, \
             patch.object(driver, 'process_birth', side_effect=[12,12]), \
             patch.object(Path, 'read_text', return_value='Pid:\t3812\n'), \
             patch.object(driver.os, 'close') as close:
            self.assertEqual(driver.fixture_pidfd(3812), (31,12))
            opening.assert_called_once_with(3812,0)
            close.assert_not_called()

    def test_pid_reuse_or_wrong_pidfd_is_rejected_and_closed(self):
        for births, info in (([12,13], 'Pid:\t3812\n'), ([12], 'Pid:\t999\n'),
                             ([12], 'Pid:\t-1\n'), ([12], 'Pid:\t3812\nPid:\t3812\n')):
            with self.subTest(info=info), patch.object(driver.sys,'platform','linux'), \
                 patch.object(driver.os,'pidfd_open',return_value=31,create=True), \
                 patch.object(driver,'process_birth',side_effect=births), \
                 patch.object(Path,'read_text',return_value=info), patch.object(driver.os,'close') as close:
                with self.assertRaises(driver.Blocked): driver.fixture_pidfd(3812)
                close.assert_called_once_with(31)

    def test_unsupported_pidfd_is_blocked(self):
        with patch.object(driver.sys,'platform','darwin'):
            with self.assertRaises(driver.Blocked): driver.fixture_pidfd(3812)
        with patch.object(driver.sys,'platform','linux'), patch.object(driver,'process_birth',return_value=12), \
             patch.object(driver.os,'pidfd_open',side_effect=OSError('unsupported'),create=True):
            with self.assertRaises(OSError): driver.fixture_pidfd(3812)

    def test_bounded_wait_and_timeout(self):
        with patch.object(driver,'fixture_pidfd_events',return_value=True) as event:
            driver.fixture_wait_terminated(31); event.assert_called_once_with(31,5000)
        with patch.object(driver,'fixture_pidfd_events',return_value=False):
            with self.assertRaises(driver.Blocked): driver.fixture_wait_terminated(31)

    def test_poll_rejects_errors_and_unrelated_descriptors(self):
        import select
        for events in ([(31,select.POLLERR)],[(32,select.POLLIN)],[(31,select.POLLNVAL)]):
            with self.subTest(events=events),patch.object(select,'poll') as poll:
                poll.return_value.poll.return_value=events
                with self.assertRaises(driver.Blocked): driver.fixture_pidfd_events(31,5000)
        for mask in (select.POLLIN,select.POLLHUP):
            with patch.object(select,'poll') as poll:
                poll.return_value.poll.return_value=[(31,mask)]
                self.assertTrue(driver.fixture_pidfd_events(31,5000))

    def test_stable_parent_is_not_hardcoded_to_one(self):
        for parent in (1,777):
            with self.subTest(parent=parent),patch.object(driver.os,'getppid',return_value=parent), \
                 patch.object(driver.os,'getpid',return_value=3813), \
                 patch.object(driver,'process_birth',side_effect=[11549,88]), \
                 patch.object(driver,'fixture_pidfd_events',return_value=False):
                driver.fixture_parent_guard(parent,88,33,11549)

    def test_changed_parent_lifetime_or_process_identity_is_blocked(self):
        for ppids,births,dead in (([777],[],False),([1,777],[11549,88],False),
                                 ([1],[999],False),([1],[11549],True),([1],[11549,99],False)):
            with self.subTest(ppids=ppids,births=births,dead=dead), \
                 patch.object(driver.os,'getppid',side_effect=ppids),patch.object(driver.os,'getpid',return_value=3813), \
                 patch.object(driver,'process_birth',side_effect=births), \
                 patch.object(driver,'fixture_pidfd_events',return_value=dead):
                with self.assertRaises(driver.Blocked): driver.fixture_parent_guard(1,88,33,11549)

    def model(self, case='detached', wait_error=False, adopter=777, attempt_error=False, late_transition=False):
        timeline=[]; metadata=[]; count=iter([3790,3812])
        def pid(): return next(count,3813)
        def leave(code): raise self.Exited(code)
        def wait(fd):
            timeline.append(('terminated',fd))
            if wait_error and fd==32: raise driver.Blocked('CAPABILITY_MISMATCH')
        def capture(path,value):
            self.assertIn(('terminated',31),timeline);self.assertIn(('terminated',32),timeline)
            timeline.append(('capture',value['ppid']));metadata.append(value)
        fake=unittest.mock.MagicMock();fake.__enter__.return_value=fake;fake.fileno.return_value=3
        fake.getsockopt.side_effect=[driver.socket.SOCK_STREAM,driver.socket.IPPROTO_TCP]
        fake.connect.side_effect=OSError('synthetic denial')
        real_read=Path.read_text
        def read(path,*a,**kw):
            if str(path)=='/proc/self/stat': return '3813 (python) S '+' '.join(['0']*18+['11549'])
            return real_read(path,*a,**kw)
        with contextlib.ExitStack() as stack:
            for obj,name,kw in ((driver.os,'getpid',{'side_effect':pid}),
                (driver.os,'getppid',{'side_effect':([adopter]*8+[adopter+1]) if late_transition else None,'return_value':adopter}), (driver.os,'getuid',{'return_value':24001}), (driver.os,'fork',{'side_effect':[0,0]}),
                (driver.os,'setsid',{}), (driver.os,'_exit',{'side_effect':leave}),
                (driver,'fixture_pidfd',{'side_effect':[(31,10),(32,11),(33,88)]}),
                (driver,'fixture_wait_terminated',{'side_effect':wait}),
                (driver,'process_birth',{'side_effect':lambda pid:11549 if pid==3813 else 88}),
                (driver,'fixture_pidfd_events',{'return_value':False}),
                (driver,'write',{'side_effect':capture}), (Path,'read_text',{'new':read})):
                stack.enter_context(patch.object(obj,name,**kw))
            close=stack.enter_context(patch.object(driver.os,'close'))
            stack.enter_context(patch.object(driver.socket,'socket',return_value=fake))
            stack.enter_context(patch.object(driver.socket,'SO_PROTOCOL',38,create=True))
            import ctypes
            libc=stack.enter_context(patch.object(ctypes,'CDLL')).return_value;libc.prctl.return_value=0
            if attempt_error: fake.getsockopt.side_effect=RuntimeError('synthetic failure')
            with self.assertRaises(self.Exited) as exit: driver.fixture(case,'synthetic.json')
        return exit.exception.code,metadata,close,fake,libc,timeline

    def test_detached_capture_after_both_ancestors_terminate(self):
        code,rows,close,sock,libc,timeline=self.model()
        self.assertEqual(code,0);self.assertEqual(rows[0]['ppid'],777)
        self.assertEqual(rows[0]['start_ticks'],11549);self.assertEqual(rows[0]['uid'],24001)
        sock.connect.assert_called_once_with(('192.0.2.1',443))
        self.assertCountEqual([c.args[0] for c in close.call_args_list],[31,32,33])
        libc.prctl.assert_not_called()

    def test_intermediate_timeout_prevents_capture_and_network(self):
        code,rows,close,sock,_,_=self.model(wait_error=True)
        self.assertEqual(code,1);self.assertEqual(rows,[]);sock.connect.assert_not_called()
        self.assertCountEqual([c.args[0] for c in close.call_args_list],[31,32])

    def test_incomplete_reparenting_remains_blocked(self):
        code,rows,close,sock,_,_=self.model(adopter=3812)
        self.assertEqual(code,1);self.assertEqual(rows,[]);sock.connect.assert_not_called()
        self.assertCountEqual([c.args[0] for c in close.call_args_list],[31,32])

    def test_unreadable_negative_control_still_sets_dumpability(self):
        code,rows,close,sock,libc,_=self.model(case='unreadable-detached')
        self.assertEqual(code,0);self.assertEqual(len(rows),1)
        libc.prctl.assert_called_once_with(4,0,0,0,0)
        sock.connect.assert_called_once_with(('192.0.2.1',443))
        self.assertCountEqual([c.args[0] for c in close.call_args_list],[31,32,33])

    def test_parent_change_after_metadata_prevents_connect(self):
        code,rows,close,sock,_,_=self.model(late_transition=True)
        self.assertEqual(code,1);self.assertEqual(len(rows),1);sock.connect.assert_not_called()
        self.assertCountEqual([c.args[0] for c in close.call_args_list],[31,32,33])

    def test_attempt_failure_closes_handles_and_exits_nonzero(self):
        code,rows,close,sock,_,_=self.model(attempt_error=True)
        self.assertEqual(code,1);sock.connect.assert_not_called()
        self.assertCountEqual([c.args[0] for c in close.call_args_list],[31,32,33])

    def test_nonfixture_runtime_functions_and_tracer_remain_identical_to_D5(self):
        verify_d5_protected_source(HERE.parents[1], D5_PROTECTED_EVIDENCE)


class HostedLayoutEvidenceTests(unittest.TestCase):
    def checkout(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        workspace = Path(temp.name)/'work/carbonlite-api/carbonlite-api'
        root = workspace/'control'; root.mkdir(parents=True)
        source = HERE.parents[1]
        paths = [line.split('  ')[1] for line in (HERE/'SHA256SUMS.txt').read_text().splitlines()]
        paths += ['ci/pilot-network-diagnostic/SHA256SUMS.txt']
        for path in paths:
            dest = root/path; dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source/path,dest)
        return root

    def test_hosted_checkout_without_historical_siblings(self):
        root=self.checkout()
        self.assertEqual({p.name for p in root.parent.iterdir()}, {'control'})
        verify_d5_protected_source(root,D5_PROTECTED_EVIDENCE)

    def test_incorrect_immutable_identity_is_rejected(self):
        root=self.checkout(); evidence=copy.deepcopy(D5_PROTECTED_EVIDENCE)
        evidence['commit']='0'*40
        with self.assertRaisesRegex(ValueError,'D5_EVIDENCE_IDENTITY'):
            verify_d5_protected_source(root,evidence)

    def test_missing_or_modified_approved_evidence_is_rejected(self):
        root=self.checkout()
        for evidence in (None,{},dict(D5_PROTECTED_EVIDENCE,run_source_sha256='0'*64)):
            with self.subTest(evidence=type(evidence)),self.assertRaisesRegex(ValueError,'D5_EVIDENCE_IDENTITY'):
                verify_d5_protected_source(root,evidence)

    def test_missing_required_source_is_rejected(self):
        root=self.checkout(); (root/'ci/pilot-network-diagnostic/run.py').unlink()
        with self.assertRaises(FileNotFoundError):verify_d5_protected_source(root,D5_PROTECTED_EVIDENCE)

    def test_strict_ppid_matching_change_is_rejected(self):
        root=self.checkout(); path=root/'ci/pilot-network-diagnostic/run.py'
        old=path.read_text(); new=old.replace("('pid','tid','ppid','uid','start_ticks')", "('pid','tid','uid','start_ticks')")
        self.assertNotEqual(old,new);path.write_text(new)
        with self.assertRaisesRegex(ValueError,'D5_PROTECTED_SOURCE'):
            verify_d5_protected_source(root,D5_PROTECTED_EVIDENCE)

    def test_modified_tracer_and_missing_payload_are_rejected(self):
        root=self.checkout(); path=root/'ci/pilot-network-diagnostic/trace-connect.c'
        path.write_text('synthetic unapproved source')
        with self.assertRaisesRegex(ValueError,'D5_PAYLOAD_IDENTITY'):
            verify_d5_protected_source(root,D5_PROTECTED_EVIDENCE)
        path.unlink()
        with self.assertRaises(FileNotFoundError):verify_d5_protected_source(root,D5_PROTECTED_EVIDENCE)

    def test_python312_empty_fields_normalize_without_hiding_type_parameters(self):
        node=ast.parse('def example(): pass').body[0]
        original=normalized_source_ast(node)
        node._fields=(*node._fields,'type_params') if 'type_params' not in node._fields else node._fields
        node.type_params=[];self.assertEqual(original,normalized_source_ast(node))
        node.type_params=[ast.Name(id='Unapproved',ctx=ast.Load())]
        self.assertNotEqual(original,normalized_source_ast(node))


if __name__=='__main__':
    unittest.main()
