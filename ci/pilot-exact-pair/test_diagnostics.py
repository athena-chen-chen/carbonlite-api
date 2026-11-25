"""Synthetic-only redaction, failure preservation and packet metadata tests."""
import json
import ast
import time
import diagnostics
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from diagnostics import capture, jest_evidence, network_evidence, sanitize, failure_text, safe_counts, suite_summaries, REDACTED

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        fixture = self.root / 'test/synthetic.e2e-spec.ts'
        fixture.parent.mkdir()
        fixture.write_text(('// Synthetic trusted source location fixture.\n') * 60)
        self.source = self.root / 'jest.json'
        self.output = self.root / 'safe.json'
        self.data = {'numFailedTests': 1, 'testResults': [{'name': str(self.root / 'test/synthetic.e2e-spec.ts'), 'status': 'failed', 'message': '', 'assertionResults': [{'fullName': 'retains source after rollback', 'status': 'failed', 'failureMessages': ['Error: ENOENT\nExpected: 201\nReceived: 500\n at Object.<anonymous> (/home/runner/work/carbonlite-api/carbonlite-api/test/synthetic.e2e-spec.ts:42:7)']}]}]}
    def run_evidence(self):
        if self.data['testResults'][0].get('assertionResults'):
            self.data['testResults'][0]['assertionResults'][0]['failureMessages'] = [m.replace('/home/runner/work/carbonlite-api/carbonlite-api/', str(self.root) + '/') if isinstance(m,str) else m for m in self.data['testResults'][0]['assertionResults'][0]['failureMessages']]
        self.source.write_text(json.dumps(self.data))
        return jest_evidence(self.source, self.output, self.root, {'test/synthetic.e2e-spec.ts'})
    def test_failed_identity_assertion_stack(self):
        result = self.run_evidence()
        failure = result['failures'][0]
        self.assertEqual(failure['file'], 'test/synthetic.e2e-spec.ts')
        self.assertEqual(failure['name'], REDACTED)
        self.assertEqual(failure['identity'], {'assertion_index':1})
        self.assertEqual(failure['messages'][0]['assertions'], [{'field':'Expected','value':201},{'field':'Received','value':500}])
        self.assertEqual(failure['messages'][0]['source_locations'], [{'file':'test/synthetic.e2e-spec.ts','line':42,'column':7}])
        self.assertEqual(result['suites'][0]['status'], 'failed')
    def test_credentials_payload_and_headers_removed(self):
        text = '''authorization: Bearer fake-token
password=do-not-retain
postgresql://someone:fakepass@127.0.0.1/test
email: private@example.test
Expected: "Customer confidential record"
> 42 | password = 'bad-value'
 {"customer":"private"}
'''
        safe = sanitize(text)
        for value in ['fake-token','do-not-retain','fakepass','private@example.test','Customer confidential record','bad-value','"customer"']:
            self.assertNotIn(value, safe)
    def assert_private(self, payload, canary='FAKECANARYVALUE123'):
        self.data['testResults'][0]['message']=payload
        self.data['testResults'][0]['assertionResults'][0]['failureMessages']=[payload]
        result=self.run_evidence()
        decoded=json.dumps(result,ensure_ascii=False)
        self.assertNotIn(canary,decoded)
        self.assertNotIn(canary,self.output.read_text())
        return result
    def test_short_unquoted_expected_received(self):
        for field in ['Expected:','Received:','Expected length:']:
            with self.subTest(field=field):self.assert_private(field+' FAKECANARYVALUE123')
    def test_matcher_error_free_text(self):
        self.assert_private('Matcher error: FAKECANARYVALUE123')
    def test_stack_free_text(self):
        self.assert_private('at FAKECANARYVALUE123')
    def test_dynamic_parameterized_names_never_retained(self):
        test=self.data['testResults'][0]['assertionResults'][0]
        test.update(fullName='rejects FAKECANARYVALUE123',title='FAKECANARYVALUE123',ancestorTitles=['FAKECANARYVALUE123'])
        result=self.assert_private('Expected: true')
        self.assertEqual(result['failures'][0]['identity'],{'assertion_index':1})
    def test_nested_error_details_and_causes_never_copied(self):
        test=self.data['testResults'][0]['assertionResults'][0]
        test['failureDetails']=[{'cause':{'message':'FAKECANARYVALUE123'}}]
        test['cause']={'Expected:':'FAKECANARYVALUE123'}
        self.assert_private({'message':'FAKECANARYVALUE123','cause':{'message':'FAKECANARYVALUE123'}})
    def test_multiline_assertions(self):
        self.assert_private('Expected: 201\nFAKECANARYVALUE123\nReceived: false\nMatcher error: FAKECANARYVALUE123')
    def test_escaped_json_content(self):
        self.assert_private('Received: '+json.dumps({'cause':{'data':'FAKECANARYVALUE123'}}))
        self.assert_private('Expected: \"FAKECANARYVALUE123\"')
    def test_unicode_and_control_variants(self):
        escaped = json.loads('"Expected: \\u0046AKECANARYVALUE123"')
        self.assert_private(escaped)

        for payload in ['Expected: FAKECANARYVALUE123\u202e','at FAKECANARYVALUE123\x00','Received: \x1b[31mFAKECANARYVALUE123\x1b[0m','Matcher error: FAKECANARYVALUE123\rExpected: 1']:
            with self.subTest(payload=repr(payload)):self.assert_private(payload)
    def test_stack_retains_only_trusted_location(self):
        result=self.assert_private(f'at FAKECANARYVALUE123(args) ({self.root}/test/synthetic.e2e-spec.ts:19:3)')
        fields=result['failures'][0]['messages'][0]
        self.assertEqual(fields['source_locations'],[{'file':'test/synthetic.e2e-spec.ts','line':19,'column':3}])
        self.assertNotIn(str(self.root),json.dumps(result))
    def test_untrusted_or_traversal_locations_excluded(self):
        for path in ['/FAKECANARYVALUE123.ts','test/FAKECANARYVALUE123.ts',f'{self.root}/../FAKECANARYVALUE123.ts']:
            with self.subTest(path=path):
                result=self.assert_private('at '+path+':1:2')
                self.assertEqual(result['failures'][0]['messages'][0]['source_locations'],[])
    def test_safe_values_matcher_and_error_code(self):
        for suffix in [':999999:1',':1:99999']:
            fields=failure_text(f'at {self.root}/test/synthetic.e2e-spec.ts'+suffix,self.root,{'test/synthetic.e2e-spec.ts'})
            self.assertEqual(fields['source_locations'],[])

        text='Expected: 519.4\nReceived: 0\nExpected: true\nReceived: null\nexpect(received).toBe(expected)\nError: ENOENT: FAKECANARYVALUE123'
        result=self.assert_private(text)
        fields=result['failures'][0]['messages'][0]
        self.assertEqual([x['value'] for x in fields['assertions']],[519.4,0,True,None])
        self.assertEqual(fields['matchers'],[{'category':'toBe','modifier':None}])
        self.assertEqual(fields['error_codes'],['ENOENT'])
    def test_unknown_suite_identity_and_status_fail_closed(self):
        self.data['testResults'][0]['name']=str(self.root/'test/FAKECANARYVALUE123.ts')
        with self.assertRaises(ValueError):self.run_evidence()
        self.assertFalse(self.output.exists())
    def test_count_payloads_fail_closed(self):
        data={key:0 for key in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numFailedTestSuites']}
        data['numFailedTests']={'nested':'FAKECANARYVALUE123'}
        with self.assertRaises(ValueError):safe_counts(data)
    def test_summary_file_paths_and_status_are_validated(self):
        self.data['testResults'][0]['status']='FAKECANARYVALUE123'
        with self.assertRaises(ValueError):suite_summaries(self.data,self.root,{'test/synthetic.e2e-spec.ts'})
    def test_infrastructure_and_test_failures_distinct(self):
        self.data['testResults'][0]['assertionResults']=[]
        self.data['numFailedTests']=0
        result=self.run_evidence()
        self.assertEqual(result['suites'][0]['outcome_kind'],'TEST_INFRASTRUCTURE_FAILURE')
    def test_message_unsupported_types_fixed_redaction(self):
        for value in [None,{'nested':'FAKECANARYVALUE123'},['FAKECANARYVALUE123']]:
            self.assertEqual(failure_text(value)['redacted'],1)
            self.assertEqual(sanitize(value),REDACTED)
    def test_missing_json_blocks(self):
        with self.assertRaises(FileNotFoundError):jest_evidence(self.source,self.output)
    def test_invalid_json_blocks(self):
        self.source.write_text('broken')
        with self.assertRaises(ValueError):jest_evidence(self.source,self.output)
    def test_count_mismatch_blocks(self):
        self.data['numFailedTests']=2
        with self.assertRaises(ValueError):self.run_evidence()
    def test_missing_assertions_blocks(self):
        del self.data['testResults'][0]['assertionResults']
        with self.assertRaises(ValueError):self.run_evidence()
    def test_message_and_artifact_bounds(self):
        self.data['testResults'][0]['assertionResults'][0]['failureMessages']=['x '*100000]
        self.run_evidence()
        self.assertLess(self.output.stat().st_size,512*1024)
        self.assertIn('truncated',self.output.read_text())
    def test_oversize_input_blocks(self):
        with patch('diagnostics.MAX_INPUT',1):
            with self.assertRaises(ValueError):self.run_evidence()
    def test_network_cli_counter_and_redaction(self):
        counter=self.root/'counter';counter.write_text('BLOCKED_EXTERNAL_PACKETS: 1\n')
        raw=json.dumps({'__REALTIME_TIMESTAMP':'200','MESSAGE':'CLPAIR_DENY DST=192.0.2.1 PROTO=UDP DPT=53 UID=24001 PAYLOAD=never-retain'})+'\n'
        r=subprocess.run([sys.executable,str(Path(__file__).with_name('diagnostics.py')),'network','100',str(self.output),str(self.root/'absent-stages'),str(counter)],input=raw,text=True,capture_output=True)
        self.assertEqual(r.returncode,0)
        data=json.loads(self.output.read_text())
        self.assertEqual(data['blocked_packet_count'],1)
        self.assertEqual(data['logged_event_count'],1)
        self.assertNotIn('never-retain',self.output.read_text())
    def test_network_cli_missing_counter_fails(self):
        r=subprocess.run([sys.executable,str(Path(__file__).with_name('diagnostics.py')),'network','100',str(self.output),str(self.root/'absent-stages'),str(self.root/'absent-counter')],input='',text=True,capture_output=True)
        self.assertNotEqual(r.returncode,0)
        self.assertIn('BLOCKED',r.stderr)
        self.assertFalse(self.output.exists())
    def test_failed_exit_preserved(self):
        result=capture([sys.executable,'-c','print("synthetic assertion");raise SystemExit(7)'],self.root,dict(os.environ),self.root/'raw')
        self.assertEqual(result['exit_code'],7)
        self.assertFalse(result['output_limit_exceeded'])
        self.assertEqual((self.root/'raw').stat().st_mode & 0o777,0o600)
    def test_output_overflow_fails(self):
        result=capture([sys.executable,'-c','print("x"*10000)'],self.root,dict(os.environ),self.root/'raw',limit=100)
        self.assertTrue(result['output_limit_exceeded'])
        self.assertLessEqual((self.root/'raw').stat().st_size,100)
    def test_timeout_fails(self):
        result=capture([sys.executable,'-c','import time;time.sleep(10)'],self.root,dict(os.environ),self.root/'raw',timeout=0.05)
        self.assertTrue(result['timed_out'])

class RunnerPrivacyTests(unittest.TestCase):
    setUp = EvidenceTests.setUp
    # Reuse fixture only; inherited tests also exercise this fixture independently.
    def invoke(self, data, *, command='jest', timed_out=False):
        tree=ast.parse(Path(__file__).with_name('run.py').read_text())
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
        allowed={'test/synthetic.e2e-spec.ts'}
        def fake_capture(args,cwd,env,raw):
            Path(raw).write_text('Error: ENOENT: FAKECANARYVALUE123\nat FAKECANARYVALUE123\n')
            output=next(x.split('=',1)[1] for x in args if x.startswith('--outputFile='))
            Path(output).write_text(json.dumps(data) if data is not None else 'invalid')
            return {'exit_code':1,'timed_out':timed_out,'output_limit_exceeded':False}
        scope=dict(vars(diagnostics),env={},output=self.root,results=[],time=time,
                   trusted_files=lambda _:allowed,capture=fake_capture)
        exec(compile(ast.Module(body=[function],type_ignores=[]),'run.py','exec'),scope)
        with self.assertRaises(RuntimeError):scope['run']('backend-e2e-postgres',[command],self.root,test_json=True)
        # The allowlisted uploadable diagnostic outputs; raw logs/JSON excluded.
        for path in self.root.glob('*.json'):
            if not path.name.endswith('.raw.json'):
                self.assertNotIn('FAKECANARYVALUE123',path.read_text())
        return json.loads((self.root/'tests.json').read_text())[-1]
    def valid_data(self):
        self.data.update(numTotalTests=1,numPassedTests=0,numPendingTests=0,numFailedTestSuites=1)
        self.data['testResults'][0]['assertionResults'][0].update(fullName='FAKECANARYVALUE123',failureMessages=['Expected: FAKECANARYVALUE123\nReceived: 500'])
        return self.data
    def test_runner_failure_all_uploadable_outputs_private(self):
        item=self.invoke(self.valid_data())
        self.assertEqual(item['exit_code'],1)
        self.assertEqual(item['status'],'FAIL')
        result=json.loads((self.root/'backend-e2e-postgres.failures.json').read_text())
        self.assertEqual(result['failures'][0]['outcome_kind'],'TEST_FAILURE')
    def test_runner_diagnostic_failure_distinct(self):
        item=self.invoke(None)
        self.assertEqual(item['diagnostics'],'FAIL')
        result=json.loads((self.root/'backend-e2e-postgres.failures.json').read_text())
        self.assertEqual(result['outcome_kind'],'DIAGNOSTIC_FAILURE')
    def test_runner_infrastructure_failure_distinct(self):
        item=self.invoke(None,timed_out=True)
        self.assertEqual(item['outcome_kind'],'TEST_INFRASTRUCTURE_FAILURE')
        self.assertEqual(item['exit_code'],1)
    def test_runner_vitest_counts_reject_nested_payload(self):
        data=self.valid_data();data['numFailedTests']={'cause':'FAKECANARYVALUE123'}
        self.assertEqual(self.invoke(data,command='vitest')['diagnostics'],'FAIL')
    def test_runner_rejects_untrusted_suite_filename(self):
        data=self.valid_data();data['testResults'][0]['name']=str(self.root/'FAKECANARYVALUE123.ts')
        self.assertEqual(self.invoke(data)['diagnostics'],'FAIL')
    def test_runner_unknown_summary_status_excluded(self):
        data=self.valid_data();data['testResults'][0]['status']='FAKECANARYVALUE123'
        self.assertEqual(self.invoke(data,command='vitest')['diagnostics'],'FAIL')


class NetworkTests(unittest.TestCase):
    def event(self,message,time=200):return json.dumps({'__REALTIME_TIMESTAMP':str(time),'MESSAGE':message})
    def test_dns_attribution_is_uid_only(self):
        r=network_evidence([self.event('CLPAIR_DENY DST=192.168.65.7 PROTO=UDP DPT=53 UID=24001')],100)
        e=r['events'][0]
        self.assertEqual(e['classification'],'DNS_ATTEMPT')
        self.assertIn('unavailable',e['process'])
        self.assertIn('UNVERIFIED',e['provider'])
    def test_excludes_unrelated_uid_and_prior_window(self):
        r=network_evidence([self.event('CLPAIR_DENY DST=192.0.2.1 UID=24002'),self.event('CLPAIR_DENY DST=192.0.2.1 UID=24001',50)],100)
        self.assertEqual(r['events'],[])
    def test_stage_overlap_is_not_test_attribution(self):
        r=network_evidence([self.event('CLPAIR_DENY DST=192.0.2.1 PROTO=TCP DPT=443 UID=24001')],100,[{'stage':'backend-e2e-postgres','started_us':150,'finished_us':250}])
        self.assertEqual(r['events'][0]['overlapping_stages'],['backend-e2e-postgres'])
        self.assertNotIn('test',r['events'][0])
    def test_ipv6_and_payload_exclusion(self):
        r=network_evidence([self.event('CLPAIR_DENY DST=2001:db8::1 PROTO=TCP DPT=443 UID=24001 PAYLOAD=secret')],100)
        self.assertEqual(r['events'][0]['destination'],'2001:db8::1')
        self.assertNotIn('secret',json.dumps(r))
    def test_malformed_evidence_blocks(self):
        with self.assertRaises(ValueError):network_evidence(['bad'],100)
        with self.assertRaises(ValueError):network_evidence([self.event('CLPAIR_DENY DST=invalid UID=24001')],100)
    def test_untrusted_stage_label_fails_closed(self):
        with self.assertRaises(ValueError):
            network_evidence([self.event('CLPAIR_DENY DST=192.0.2.1 UID=24001')],100,[{'stage':'FAKECANARYVALUE123','started_us':100}])
    def test_event_overflow_blocks(self):
        with self.assertRaises(ValueError):network_evidence([self.event('CLPAIR_DENY DST=192.0.2.1 UID=24001')]*129,100)
    def test_https_is_not_claimed_provider_access(self):
        r=network_evidence([self.event('CLPAIR_DENY DST=1.1.1.1 PROTO=TCP DPT=443 UID=24001')],100)
        self.assertEqual(r['events'][0]['classification'],'OTHER_BLOCKED_DESTINATION')

if __name__=='__main__':unittest.main()
