"""Local contract/privacy tests. Linux runtime coverage is explicitly separate."""
import copy
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

    def summary(self, tag=2, ident=None, default=True):
        _, entries = self.entries(tag, ident)
        with patch.object(driver, 'CONTROL', self.control):
            return driver.acl_failure_evidence(self.here, self.workspace, self.info,
                'system.posix_acl_default' if default else 'system.posix_acl_access', entries, 7)

    def prepare_snapshot(self, tag=2, ident=None, mask=7, default=True):
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

    def test_trusted_named_user_still_blocked_with_evidence(self):
        for uid in (0, os.getuid()):
            with self.subTest(uid=uid):
                error = self.prepare_snapshot(ident=uid)
                self.assertIsNotNone(error)
                row = error.preparation_evidence['preparation_failure']
                self.assertEqual(row['principal_id'], uid)
                self.assertTrue(row['principal_class'].startswith('TRUSTED_'))

    def test_approved_named_group_still_blocked(self):
        with patch.object(driver, 'acl_principal_class', return_value='TRUSTED_APPROVED_GROUP'):
            error = self.prepare_snapshot(tag=8, ident=os.getgid())
            self.assertEqual(error.preparation_evidence['preparation_failure']['principal_class'], 'TRUSTED_APPROVED_GROUP')

    def test_untrusted_named_user_still_blocked(self):
        error = self.prepare_snapshot(ident=24001)
        self.assertEqual(error.preparation_evidence['preparation_failure']['principal_class'], 'UNTRUSTED_NAMED_USER')

    def test_untrusted_named_group_still_blocked(self):
        error = self.prepare_snapshot(tag=8, ident=24001)
        self.assertEqual(error.preparation_evidence['preparation_failure']['principal_class'], 'UNTRUSTED_NAMED_GROUP')

    def test_masked_write_acl_decision_unchanged(self):
        self.assertIsNone(self.prepare_snapshot(ident=24001, mask=5))

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

    def test_false_effective_write_or_masked_rejection_evidence_rejected(self):
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
        _, entries = self.entries()
        with patch.object(driver, 'CONTROL', self.control):
            value = driver.acl_failure_evidence(self.here / 'run.py', self.workspace, info,
                                               'system.posix_acl_access', entries, 7)
        self.assertEqual(value['preparation_failure']['file_type'], 'REGULAR_FILE')
        self.assertEqual(value['preparation_failure']['mode'], '0644')
        self.assertEqual(value['preparation_failure']['path'], 'ci/pilot-network-diagnostic/run.py')

    def test_builder_rejects_unsupported_acl_source_and_file_type(self):
        _, entries = self.entries()
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



if __name__=='__main__':
    unittest.main()
