"""Synthetic contract/privacy tests only. No migration, external calls or Linux claims."""
import copy
import contextlib
import io
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('checkpoint_ab',HERE/'run.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
v=r.v
APPROVED=json.loads((HERE/'approved.json').read_text())


def report(arm='A',packets=0):
    ident={'entry_commit':'1'*40,'entry_tree':'2'*40,'backend_commit':APPROVED['backend']['expected_commit'],
           'backend_tree':APPROVED['backend']['expected_tree'],'control_commit':APPROVED['control_commit'],'control_tree':APPROVED['control_tree']}
    x=r.new_report(arm,ident)
    x['profile']={k:'a'*64 for k in r.PROFILE_KEYS}
    x['profile'].update(prisma_version='6.19.3',node_version='v20.19.0',pnpm_version='10.17.0',postgres_image=APPROVED['postgres_image'])
    x['migration']={'status':'SUCCESS','exit_status':0}
    x['launcher'].update(spawned=True,pid=400,start_ticks=500,reaped=True,wait_exit=0)
    x['network'].update(before=0,after=packets,final=packets,denied=packets,status='BLOCKED' if packets else 'PASS')
    x['cleanup']={k:True for k in x['cleanup']};x['identity_after']=True
    x['comparison_eligible']=bool(r.eligibility(x));return x


class CounterTests(unittest.TestCase):
    def test_exact_counter_status_and_delta(self):
        self.assertEqual(r.parse_counter(0,b'BLOCKED_EXTERNAL_PACKETS: 0\n'),0)
        self.assertEqual(r.parse_counter(1,b'BLOCKED_EXTERNAL_PACKETS: 3\n'),3)
        self.assertEqual(r.delta(2,5),3)
    def test_missing_malformed_or_compiler_error_not_zero(self):
        for code,data in ((0,b''),(1,b'error'),(0,b'BLOCKED_EXTERNAL_PACKETS: 1\n'),(1,b'BLOCKED_EXTERNAL_PACKETS: 0\n'),(2,b'BLOCKED_EXTERNAL_PACKETS: 4\n'),(0,b'BLOCKED_EXTERNAL_PACKETS: -1\n'),(0,b'PRIVATE\nBLOCKED_EXTERNAL_PACKETS: 0\n')):
            with self.subTest(code=code),self.assertRaises(ValueError):r.parse_counter(code,data)
    def test_reset_negative_boolean_or_missing_counter_rejected(self):
        for a,b in ((2,1),(-1,0),(True,1),(0,None)):
            with self.subTest(a=a,b=b),self.assertRaises(ValueError):r.delta(a,b)
    def test_denied_traffic_never_becomes_security_pass(self):
        x=report(packets=3);x['network']['status']='PASS'
        with self.assertRaises(ValueError):r.validate_report(x,APPROVED)
    def test_late_packet_is_inconclusive(self):
        x=report();x['network'].update(final=1,denied=1,status='BLOCKED');x['comparison_eligible']=False
        self.assertEqual(r.compare(x,report('B'),APPROVED)['comparison'],'INCONCLUSIVE')


class ComparisonTests(unittest.TestCase):
    def test_only_intentional_environment_difference(self):
        a=r.environment(Path('/synthetic/workspace'),'A');b=r.environment(Path('/synthetic/workspace'),'B')
        self.assertNotIn('CHECKPOINT_DISABLE',a);self.assertEqual(b.pop('CHECKPOINT_DISABLE'),'1');self.assertEqual(a,b)
        self.assertEqual(r.COMMAND,['pnpm','exec','prisma','migrate','deploy'])
    def test_A_only_supports_dependence_but_security_remains_blocked(self):
        x=r.compare(report(packets=3),report('B'),APPROVED)
        self.assertEqual(x['comparison'],'COMPLETE');self.assertEqual(x['outcome'],'SUPPORTS_SETTING_DEPENDENCE')
        self.assertEqual(x['network_security'],'BLOCKED');self.assertFalse(x['historical_attribution']);self.assertFalse(x['process_attribution'])
    def test_both_optout_insufficient(self):
        self.assertEqual(r.compare(report(packets=3),report('B',1),APPROVED)['outcome'],'OPT_OUT_INSUFFICIENT')
    def test_neither_not_reproduced(self):
        x=r.compare(report(),report('B'),APPROVED);self.assertEqual(x['outcome'],'NOT_REPRODUCED');self.assertEqual(x['network_security'],'PASS')
    def test_B_only_inconclusive(self):
        self.assertEqual(r.compare(report(),report('B',1),APPROVED)['comparison'],'INCONCLUSIVE')
    def test_toolchain_or_identity_difference_blocks_comparison(self):
        for field in ('profile','identity'):
            a=report();b=report('B')
            b[field]['lock_sha256' if field=='profile' else 'entry_tree']='b'*(64 if field=='profile' else 40)
            self.assertEqual(r.compare(a,b,APPROVED)['comparison'],'INCONCLUSIVE')
    def test_migration_failure_inconclusive(self):
        a=report();a['migration']={'status':'FAIL','exit_status':1};a['launcher']['wait_exit']=1;a['comparison_eligible']=False
        self.assertEqual(r.compare(a,report('B'),APPROVED)['comparison'],'INCONCLUSIVE')
    def test_missing_required_identity_or_profile_blocks(self):
        for key in ('identity','profile','network','cleanup'):
            x=report();del x[key]
            with self.subTest(key=key),self.assertRaises(ValueError):r.validate_report(x,APPROVED)


class PrivacyTests(unittest.TestCase):
    def test_raw_messages_and_sensitive_nested_fields_rejected(self):
        for key in ('Expected','Matcher error','at','argv','environment','token','url','message','raw_log'):
            for location in ('top','profile','network','identity','migration','cleanup'):
                x=report();target=x if location=='top' else x[location];target[key]='SHORT_PRIVATE_CANARY'
                with self.subTest(key=key,location=location),self.assertRaises(ValueError):r.validate_report(x,APPROVED)
    def test_scalar_canaries_unicode_controls_and_nested_values_rejected(self):
        for val in ('SHORT_PRIVATE_CANARY','secret\nvalue','\u202esecret','\x00secret',{'cause':'secret'}):
            for group,key in (('profile','prisma_version'),('profile','lock_sha256'),('identity','backend_commit'),('migration','exit_status'),('network','denied')):
                x=report();x[group][key]=val
                with self.subTest(group=group,key=key),self.assertRaises((ValueError,TypeError)):r.validate_report(x,APPROVED)
    def test_error_categories_are_fixed(self):
        x=report();x['errors']=['PRIVATE'];x['comparison_eligible']=False
        with self.assertRaises(ValueError):r.validate_report(x,APPROVED)
    def test_inconsistent_eligibility_rejected(self):
        x=report();x['cleanup']['processes']=False
        with self.assertRaises(ValueError):r.validate_report(x,APPROVED)
    def test_owner_only_bounded_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p=r.result_path(Path(d),'A');r.save(p,report(),APPROVED)
            self.assertEqual(p.stat().st_mode&0o777,0o600);self.assertEqual(p.parent.stat().st_mode&0o777,0o700)
            self.assertEqual(r.load(p,APPROVED),report())
    def test_symlink_or_oversized_artifact_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'arm.json';real=Path(d)/'real';real.write_text(json.dumps(report()));p.symlink_to(real)
            with self.assertRaises(ValueError):r.load(p,APPROVED)
            p.unlink();p.write_bytes(b' '*8193)
            with self.assertRaises(ValueError):r.load(p,APPROVED)
    def test_duplicate_json_keys_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'arm.json';p.write_text('{"arm":"A","arm":"B"}')
            with self.assertRaises(ValueError):r.load(p,APPROVED)


class CleanupTests(unittest.TestCase):
    def context(self):
        proc=MagicMock();proc.pid=400;proc.wait.return_value=0
        evidence=r.launcher_evidence();evidence.update(spawned=True,pid=400,start_ticks=500)
        return {'proc':proc,'evidence':evidence}
    def exercise(self, waits=0, cleanup_error=False, missing_identity=False, spawn_error=False):
        x=report();x['migration']={'status':'NOT_STARTED','exit_status':None};x['launcher']=r.launcher_evidence()
        context={'proc':None,'evidence':x['launcher']};proc=MagicMock();proc.pid=400
        if isinstance(waits,list):proc.wait.side_effect=waits
        elif isinstance(waits,BaseException):proc.wait.side_effect=waits
        else:proc.wait.return_value=waits
        with contextlib.ExitStack() as stack:
            opening=stack.enter_context(patch.object(r.subprocess,'Popen',side_effect=OSError('synthetic launch failure') if spawn_error else None,return_value=proc))
            stack.enter_context(patch.object(r,'process_start',side_effect=OSError('missing identity') if missing_identity else None,return_value=500))
            stack.enter_context(patch.object(r.signal,'signal'))
            stack.enter_context(patch.object(r,'quiet',return_value=0));stack.enter_context(patch.object(r,'uid_processes',return_value=[]))
            if cleanup_error:stack.enter_context(patch.object(r,'cleanup_processes',side_effect=OSError('synthetic cleanup failure')))
            cleanup,errors=r.migration(Path('/synthetic'),{},x['migration'],context)
        x['cleanup']=cleanup;x['errors']=errors;x['comparison_eligible']=False
        r.validate_report(x,APPROVED)
        return x,context,proc,opening
    def test_cleanup_reaps_launcher_and_checks_actual_uid_absence(self):
        context=self.context()
        with patch.object(r,'quiet',return_value=0) as command,patch.object(r,'uid_processes',return_value=[]):c=r.cleanup_processes(context)
        self.assertTrue(c['processes']);self.assertTrue(c['launcher_reaped']);context['proc'].wait.assert_called_once_with(timeout=10)
        self.assertTrue(context['evidence']['reaped']);self.assertEqual(command.call_args.args[0],['sudo','-u','clpairtest','pkill','-KILL','-u','24001'])
    def test_live_descendant_or_unreaped_launcher_blocks(self):
        for live in ([],[99]):
            context=self.context();context['proc'].wait.side_effect=subprocess.TimeoutExpired('synthetic',10)
            with patch.object(r,'quiet',return_value=0),patch.object(r,'uid_processes',return_value=live):c=r.cleanup_processes(context)
            self.assertFalse(c['launcher_reaped']);self.assertEqual(c['processes'],not live)
    def test_migration_timeout_still_cleans_and_cannot_pass(self):
        x,context,proc,_=self.exercise(waits=[subprocess.TimeoutExpired('synthetic',180),-9])
        self.assertEqual(x['migration'],{'status':'TIMEOUT','exit_status':None});self.assertIn('TIMEOUT',x['errors'])
        self.assertTrue(x['launcher']['reaped']);self.assertEqual(x['launcher']['wait_exit'],137)
        self.assertEqual(proc.wait.call_args_list[1].kwargs,{'timeout':10})
    def test_cancellation_cleans_without_turning_success(self):
        x,_,_,_=self.exercise(waits=[KeyboardInterrupt(),-9])
        self.assertEqual(x['migration']['status'],'INFRA_FAILURE');self.assertIn('CANCELLED',x['errors'])
    def test_raw_migration_output_never_captured(self):
        x,_,_,opening=self.exercise()
        self.assertIs(opening.call_args.kwargs['stdout'],subprocess.DEVNULL);self.assertIs(opening.call_args.kwargs['stderr'],subprocess.DEVNULL)
    def test_timeout_then_cleanup_exception_preserves_timeout_and_handle(self):
        x,context,proc,_=self.exercise(waits=subprocess.TimeoutExpired('synthetic',180),cleanup_error=True)
        self.assertEqual(x['migration'],{'status':'TIMEOUT','exit_status':None});self.assertIs(context['proc'],proc)
        self.assertEqual(x['launcher']['pid'],400);self.assertEqual(x['launcher']['start_ticks'],500)
        self.assertFalse(x['launcher']['reaped']);self.assertFalse(x['cleanup']['launcher_reaped'])
        self.assertIn('CLEANUP',x['errors']);self.assertFalse(r.eligibility(x))
    def test_success_then_cleanup_exception_preserves_success_and_real_wait(self):
        x,_,proc,_=self.exercise(cleanup_error=True)
        self.assertEqual(x['migration'],{'status':'SUCCESS','exit_status':0})
        self.assertTrue(x['launcher']['reaped']);self.assertTrue(x['cleanup']['launcher_reaped'])
        proc.wait.assert_called_once_with(timeout=180);self.assertIn('CLEANUP',x['errors']);self.assertFalse(r.eligibility(x))
    def test_unsuccessful_exit_is_not_erased_by_cleanup(self):
        x,_,_,_=self.exercise(waits=17,cleanup_error=True)
        self.assertEqual(x['migration'],{'status':'FAIL','exit_status':17});self.assertEqual(x['launcher']['wait_exit'],17)
    def test_missing_launcher_identity_blocks_without_erasing_known_exit(self):
        x,_,_,_=self.exercise(missing_identity=True)
        self.assertEqual(x['migration']['status'],'SUCCESS');self.assertIsNone(x['launcher']['start_ticks'])
        self.assertIn('IDENTITY',x['errors']);self.assertFalse(r.eligibility(x))
    def test_launch_failure_is_infrastructure_not_success_or_not_started(self):
        x,context,_,_=self.exercise(spawn_error=True)
        self.assertEqual(x['migration']['status'],'INFRA_FAILURE');self.assertFalse(x['launcher']['spawned'])
        self.assertFalse(x['cleanup']['launcher_reaped']);self.assertIsNone(context['proc'])
    def test_pre_migration_cleanup_failure_cannot_invent_reaping(self):
        context={'proc':None,'evidence':r.launcher_evidence()}
        with patch.object(r,'quiet',side_effect=OSError('synthetic')),patch.object(r,'uid_processes',side_effect=OSError('synthetic')):
            c=r.cleanup_processes(context)
        self.assertFalse(c['processes']);self.assertFalse(c['launcher_reaped']);self.assertFalse(context['evidence']['spawned'])
    def test_inventory_failure_does_not_prevent_launcher_wait(self):
        context=self.context()
        with patch.object(r,'quiet',side_effect=OSError('synthetic')),patch.object(r,'uid_processes',side_effect=OSError('synthetic')):
            c=r.cleanup_processes(context)
        self.assertFalse(c['processes']);self.assertTrue(c['launcher_reaped']);context['proc'].wait.assert_called_once()
    def test_no_handle_is_not_reaping_evidence(self):
        with patch.object(r,'quiet',return_value=0),patch.object(r,'uid_processes',return_value=[]):c=r.cleanup_processes(None)
        self.assertTrue(c['processes']);self.assertFalse(c['launcher_reaped'])
    def test_fake_reaping_and_arbitrary_launcher_text_rejected(self):
        for field,value in [('pid','PRIVATE'),('start_ticks',False),('wait_exit','PRIVATE'),('reaped',False)]:
            x=report();x['launcher'][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):r.validate_report(x,APPROVED)


class ArmFailureEvidenceTests(unittest.TestCase):
    def scenario(self, mode):
        with tempfile.TemporaryDirectory() as d,contextlib.ExitStack() as stack:
            workspace=Path(d);ident=report()['identity'];proc=MagicMock();proc.pid=400
            proc.wait.side_effect=subprocess.TimeoutExpired('synthetic',180) if mode=='TIMEOUT' else None
            proc.wait.return_value=0
            stack.enter_context(patch.object(v,'verify',return_value=ident));stack.enter_context(patch.object(v,'audit_permissions'))
            stack.enter_context(patch.object(r,'cancellation',side_effect=contextlib.nullcontext));stack.enter_context(patch.object(r.signal,'signal'))
            home=stack.enter_context(patch.object(r,'inspect_home',side_effect=PermissionError('synthetic owner inspection failure') if mode=='PREPARATION' else None))
            stack.enter_context(patch.object(r,'uid_processes',return_value=[]));stack.enter_context(patch.object(r,'database',return_value='a'*64))
            stack.enter_context(patch.object(r,'profile',return_value=report()['profile']));stack.enter_context(patch.object(r,'quiet',return_value=0))
            stack.enter_context(patch.object(r,'counter',return_value=0));stack.enter_context(patch.object(r,'process_start',return_value=500))
            opening=stack.enter_context(patch.object(r.subprocess,'Popen',return_value=proc))
            stack.enter_context(patch.object(r,'cleanup_processes',side_effect=OSError('PRIVATE_CANARY_cleanup_failure')))
            code=r.arm(workspace,'A',APPROVED)
            path=r.result_path(workspace,'A');text=path.read_text();value=r.load(path,APPROVED)
            self.assertEqual(code,1);self.assertFalse(value['comparison_eligible']);self.assertNotIn('PRIVATE_CANARY',text)
            self.assertEqual(path.stat().st_mode&0o777,0o600);self.assertIn('CLEANUP',value['errors'])
            return value,proc,opening
    def test_timeout_cleanup_exception_retains_available_sanitized_artifact(self):
        value,proc,_=self.scenario('TIMEOUT')
        self.assertEqual(value['migration'],{'status':'TIMEOUT','exit_status':None})
        self.assertEqual(value['launcher']['pid'],400);self.assertFalse(value['launcher']['reaped'])
        self.assertFalse(value['cleanup']['launcher_reaped']);proc.wait.assert_called_once_with(timeout=180)
    def test_success_cleanup_exception_retains_success_but_blocks_gate(self):
        value,proc,_=self.scenario('SUCCESS')
        self.assertEqual(value['migration'],{'status':'SUCCESS','exit_status':0});self.assertTrue(value['launcher']['reaped'])
        proc.wait.assert_called_once_with(timeout=180)
    def test_cleanup_before_migration_keeps_not_started_and_no_reaping_claim(self):
        value,proc,opening=self.scenario('PREPARATION')
        self.assertEqual(value['migration'],{'status':'NOT_STARTED','exit_status':None})
        self.assertFalse(value['launcher']['spawned']);self.assertFalse(value['cleanup']['launcher_reaped']);opening.assert_not_called()


class HomeOwnerTests(unittest.TestCase):
    def home(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);w=Path(temp.name).resolve()
        (w/'checkpoint-disposable').mkdir(mode=0o755);h=w/'checkpoint-disposable/home';h.mkdir(mode=0o700)
        return w,h
    def snapshot(self,home,uid=24001,mode=0o700):
        original=Path.lstat
        def info(path,*a,**kw):
            value=original(path,*a,**kw)
            if path==home:
                values=list(value);values[4]=uid;values[0]=(value.st_mode&~0o777)|mode
                return os.stat_result(values)
            return value
        return info
    def test_original_runner_enumeration_fails_but_owner_probe_succeeds(self):
        w,h=self.home();original=Path.iterdir
        def enumerate(path):
            if path==h:raise PermissionError('synthetic normal Runner denial')
            return original(path)
        with patch.object(Path,'iterdir',new=enumerate),patch.object(Path,'lstat',new=self.snapshot(h)), \
             patch.object(r,'scalar_output',return_value='HOME_EMPTY: VERIFIED') as probe,patch.object(os,'chmod') as chmod:
            with self.assertRaises(PermissionError):list(h.iterdir())
            r.inspect_home(w);chmod.assert_not_called()
        args=probe.call_args.args[0];self.assertEqual(args[:5],['sudo','-u','clpairtest','env','-i'])
        self.assertIn('-I',args);self.assertEqual(args[-1],str(h));self.assertEqual(h.stat().st_mode&0o777,0o700)
    def test_wrong_owner_or_mode_fails_before_owner_command(self):
        for uid,mode in ((9999,0o700),(24001,0o755),(24001,0o750)):
            w,h=self.home()
            with patch.object(Path,'lstat',new=self.snapshot(h,uid,mode)),patch.object(r,'scalar_output') as probe:
                with self.assertRaises(ValueError):r.inspect_home(w)
                probe.assert_not_called()
    def test_symlink_and_noncanonical_workspace_rejected(self):
        w,h=self.home();h.rmdir();h.symlink_to(w)
        with self.assertRaises(ValueError):r.inspect_home(w)
        with self.assertRaises(ValueError):r.inspect_home(Path('relative'))
    def test_owner_probe_failure_or_malformed_marker_blocks(self):
        for value in ('','PRIVATE','HOME_EMPTY: VERIFIED PRIVATE'):
            w,h=self.home()
            with patch.object(Path,'lstat',new=self.snapshot(h)),patch.object(r,'scalar_output',return_value=value):
                with self.assertRaises(ValueError):r.inspect_home(w)
    def test_owner_program_rejects_unexpected_files_and_closes_handle(self):
        w,h=self.home();(h/'unexpected').write_text('synthetic')
        original=os.fstat
        def owned(fd):
            values=list(original(fd));values[4]=24001;return os.stat_result(values)
        output=io.StringIO()
        with patch.object(os,'getuid',return_value=24001),patch.object(os,'fstat',side_effect=owned), \
             patch.object(sys,'argv',['owner_probe',str(h)]),patch.object(os,'close',wraps=os.close) as close, \
             contextlib.redirect_stdout(output):
            with self.assertRaises(AssertionError):exec(r.HOME_PROBE,{})
            fd=close.call_args.args[0]
        self.assertEqual(output.getvalue(),'')
        with self.assertRaises(OSError):os.fstat(fd)
    def test_owner_program_empty_directory_fixed_marker_only(self):
        w,h=self.home();original=os.fstat
        def owned(fd):
            values=list(original(fd));values[4]=24001;return os.stat_result(values)
        output=io.StringIO()
        with patch.object(os,'getuid',return_value=24001),patch.object(os,'fstat',side_effect=owned), \
             patch.object(sys,'argv',['owner_probe',str(h)]),contextlib.redirect_stdout(output):exec(r.HOME_PROBE,{})
        self.assertEqual(output.getvalue(),'HOME_EMPTY: VERIFIED\n')


class FinalizationTests(unittest.TestCase):
    def final(self, services_absent=True, launcher=True, missing_after=False):
        with tempfile.TemporaryDirectory() as d:
            w=Path(d);x=report();x['cleanup']['services']=False;x['cleanup']['launcher_reaped']=launcher
            x['comparison_eligible']=False
            if not launcher:
                x['launcher'].update(reaped=False,wait_exit=None)
                x['migration']={'status':'TIMEOUT','exit_status':None};x['errors']=['TIMEOUT']
            if missing_after:x['network'].update(after=None,status='BLOCKED')
            p=r.result_path(w,'A');r.save(p,x,APPROVED)
            cid=['a'*64,'b'*64]
            with patch.object(v,'verify',return_value=x['identity']), \
                 patch.object(r,'cleanup_processes',return_value={'processes':True,'launcher_reaped':True,'services':False}), \
                 patch.object(r,'container_ids',return_value=cid), \
                 patch.object(r,'scalar_output',return_value='' if services_absent else cid[0]), \
                 patch.object(r,'counter',return_value=0):code=r.finalize(w,'A',APPROVED)
            return code,r.load(p,APPROVED)
    def test_service_cleanup_is_independently_verified(self):
        code,x=self.final();self.assertEqual(code,0);self.assertTrue(x['cleanup']['services'])
        code,x=self.final(False);self.assertEqual(code,1);self.assertIn('SERVICES',x['errors'])
    def test_finalization_cannot_invent_launcher_reaping(self):
        code,x=self.final(launcher=False);self.assertEqual(code,1);self.assertFalse(x['cleanup']['launcher_reaped'])
    def test_missing_post_migration_snapshot_never_becomes_network_pass(self):
        code,x=self.final(missing_after=True);self.assertEqual(code,1)
        self.assertIsNone(x['network']['after']);self.assertEqual(x['network']['status'],'BLOCKED')
    def test_missing_arm_artifact_is_not_comparison_success(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(FileNotFoundError):r.load(Path(d)/'missing.json',APPROVED)


class PermissionPolicyTests(unittest.TestCase):
    def audit(self, entries, default=False, mixed=False, world=False):
        import types,stat,errno,importlib.util
        with tempfile.TemporaryDirectory() as d:
            w=Path(d).resolve();(w/'entry/ci/pilot-checkpoint-ab').mkdir(parents=True)
            (w/'entry/ci/pilot-checkpoint-ab/approved.json').write_text(json.dumps({'files':['ci/pilot-checkpoint-ab/approved.json']}))
            uid=os.getuid();gid=os.getgid();orig=Path.lstat
            guard=types.SimpleNamespace(verify=lambda *a:None,acl_entries=lambda _:entries)
            spec=types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _:None))
            def info(p,*a,**kw):
                o=orig(p,*a,**kw)
                fields=list(o);fields[0]=(o.st_mode&~0o022)|(0o002 if world else 0);fields[4]=uid;fields[5]=gid
                return os.stat_result(fields)
            def acl(p,name,**kw):
                if name==('system.posix_acl_default' if default else 'system.posix_acl_access') and (not default or p.is_dir()):return b'synthetic'
                raise OSError(errno.ENODATA,'absent')
            with patch.object(sys,'platform','linux'),patch.object(importlib.util,'spec_from_file_location',return_value=spec), \
                 patch.object(importlib.util,'module_from_spec',return_value=guard),patch.object(Path,'lstat',new=info), \
                 patch.object(os,'listxattr',return_value=[],create=True),patch.object(os,'getxattr',side_effect=acl,create=True), \
                 patch('pwd.getpwuid',return_value=types.SimpleNamespace(pw_gid=gid)), \
                 patch('grp.getgrgid',return_value=types.SimpleNamespace(gr_mem=[])), \
                 patch('pwd.getpwall',return_value=[types.SimpleNamespace(pw_uid=uid,pw_gid=gid)]+([types.SimpleNamespace(pw_uid=99999,pw_gid=gid)] if mixed else [])), \
                 patch.object(subprocess,'run',return_value=subprocess.CompletedProcess([],1)):
                v.audit_permissions(w)
    def test_trusted_runner_and_root_entries_preserved(self):
        for principal in (0,os.getuid()):
            for default in (False,True):self.audit([(2,2,principal),(16,7,0xffffffff)],default=default)
    def test_untrusted_masked_and_other_writes_rejected(self):
        for entries in ([(2,2,24001),(16,0,0xffffffff)],[(8,2,24001),(16,0,0xffffffff)],[(32,2,0xffffffff)]):
            for default in (False,True):
                with self.subTest(entries=entries,default=default),self.assertRaises(ValueError):self.audit(entries,default=default)
    def test_approved_exclusive_group_and_mixed_group(self):
        self.audit([(8,2,os.getgid()),(16,7,0xffffffff)])
        with self.assertRaises(ValueError):self.audit([(8,2,os.getgid()),(16,7,0xffffffff)],mixed=True)
    def test_world_write_rejected_independently_of_effective_access(self):
        with self.assertRaises(ValueError):self.audit([],world=True)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.w=Path(self.temp.name)
        self.a=copy.deepcopy(APPROVED);self.a['files']=['ci/pilot-checkpoint-ab/approved.json',v.INDEX];self.a['backend']['files']={'source.txt':'x'}
        self.env={'GITHUB_REPOSITORY':self.a['repository'],'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/'+self.a['branch'],
                  'ENTRY_SHA':'1'*40,'ENTRY_TREE':'2'*40,'ENTRY_INDEX_SHA256':'','GITHUB_SHA':'1'*40,'INVOKING_WORKFLOW_SHA':'1'*40}
        for name in ('entry','control','carbonlite-api'):(self.w/name).mkdir()
        f=self.w/'entry/ci/pilot-checkpoint-ab/approved.json';f.parent.mkdir(parents=True);f.write_text('{}')
        index=self.w/'entry'/v.INDEX;index.write_text(v.digest(f.read_bytes())+'  ci/pilot-checkpoint-ab/approved.json\n');self.env['ENTRY_INDEX_SHA256']=v.digest(index.read_bytes())
        lines=[]
        for i in range(15):
            f=self.w/'control'/('payload-'+str(i));f.write_text('approved');lines.append(v.digest(f.read_bytes())+'  '+f.name+'\n')
        index=self.w/'control/SHA256SUMS.txt';index.write_text(''.join(lines));self.a['control_index_sha256']=v.digest(index.read_bytes())
        f=self.w/'carbonlite-api/source.txt';f.write_text('approved backend');self.a['backend']['files']['source.txt']=v.digest(f.read_bytes())
        self.gitpatch=patch.object(v,'git',side_effect=self.git);self.gitpatch.start();self.addCleanup(self.gitpatch.stop)
    def git(self,root,*args):
        k=root.name;b=self.a['backend']
        sha={'entry':self.env['ENTRY_SHA'],'control':self.a['control_commit'],'carbonlite-api':b['expected_commit']}[k]
        tree={'entry':self.env['ENTRY_TREE'],'control':self.a['control_tree'],'carbonlite-api':b['expected_tree']}[k]
        if args==('remote','get-url','origin'):return 'https://github.com/'+self.a['repository']
        if args==('rev-parse','HEAD'):return sha
        if args==('rev-parse','HEAD^{tree}'):return tree
        if args[0]=='merge-base':return args[1]
        if args[0]=='diff':return '\n'.join(self.a['files'] if k=='entry' else [] if k=='control' else b['files'])
        if args[0]=='status':return ''
        if args[0]=='ls-tree':return '100644 blob '+'a'*40
        raise AssertionError(args)
    def test_valid_immutable_identity(self):self.assertEqual(v.verify(self.w,self.env,self.a)['backend_commit'],APPROVED['backend']['expected_commit'])
    def test_wrong_invocation_branch_and_event_rejected(self):
        for key,value in [('GITHUB_SHA','9'*40),('ENTRY_SHA','main'),('GITHUB_REF','refs/heads/main'),('GITHUB_EVENT_NAME','push'),('GITHUB_REPOSITORY','other/repo')]:
            env=dict(self.env,**{key:value})
            with self.subTest(key=key),self.assertRaises(ValueError):v.verify(self.w,env,self.a)
    def test_corrupt_index_source_and_backend_rejected(self):
        for path in ('entry/ci/pilot-checkpoint-ab/approved.json','control/payload-0','carbonlite-api/source.txt'):
            p=self.w/path;old=p.read_bytes();p.write_text('tampered')
            with self.subTest(path=path),self.assertRaises(ValueError):v.verify(self.w,self.env,self.a)
            p.write_bytes(old)
    def test_wrong_tree_and_dirty_checkout_rejected(self):
        original=self.git
        for args,value in [(('rev-parse','HEAD^{tree}'),'0'*40),(('status','--porcelain','--untracked-files=all'),' M unexpected')]:
            with patch.object(v,'git',side_effect=lambda root,*a:value if a==args else original(root,*a)):
                with self.assertRaises(ValueError):v.verify(self.w,self.env,self.a)
    def test_unsafe_index_paths_and_duplicate_keys(self):
        for data in (('a'*64+'  ../secret\n').encode(),('a'*64+'  safe\n'+'a'*64+'  safe\n').encode()):
            with self.assertRaises(ValueError):v.index_files(data)
    def test_symlinked_identity_payload_rejected(self):
        p=self.w/'carbonlite-api/source.txt';p.unlink();p.symlink_to(self.w/'control/payload-0')
        with self.assertRaises(ValueError):v.verify(self.w,self.env,self.a)


class StructureTests(unittest.TestCase):
    def test_exact_seven_file_manifest(self):
        self.assertEqual(len(APPROVED['files']),7);self.assertEqual(len(set(APPROVED['files'])),7)
        self.assertEqual(len(APPROVED['backend']['files']),8)
        self.assertEqual(APPROVED['backend']['expected_commit'],'e424c567d43c0086e0dc01b86e48cb648c114078')
    def test_manual_matrix_and_no_deployment_or_tracing(self):
        text=(HERE.parents[1]/'.github/workflows/nightly-e2e.yml').read_text()
        self.assertIn('fail-fast: false',text);self.assertIn('arm: [A, B]',text);self.assertIn('contents: read',text)
        self.assertEqual(text.count('persist-credentials: false'),6)
        self.assertIn('retention-days: 7',text);self.assertIn('needs: migration',text)
        for bad in ('secrets.','continue-on-error','pull_request:','schedule:','push:','workflow_call:','ptrace','eBPF','CAP_SYS_PTRACE','prisma generate','prisma migrate dev'):
            self.assertNotIn(bad,text)
    def test_complete_checksums(self):
        index=HERE/'SHA256SUMS.txt'
        for line in index.read_text().splitlines():
            h,p=line.split('  ');self.assertEqual(r.sha(HERE.parents[1]/p),h)
        self.assertEqual(len(index.read_text().splitlines()),6)


if __name__=='__main__':unittest.main()
