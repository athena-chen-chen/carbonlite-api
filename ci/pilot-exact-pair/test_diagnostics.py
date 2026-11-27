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
        def vitest_extract(source, destination, root, allowed, approved):
            with patch.object(diagnostics.subprocess, 'check_output', side_effect=[
                    approved['expected_commit'].encode(), approved['expected_tree'].encode()]):
                return diagnostics.vitest_evidence(source, destination, root, allowed, approved)
        scope=dict(vars(diagnostics),env={},output=self.root,results=[],time=time,
                   trusted_files=lambda _:allowed,capture=fake_capture, vitest_evidence=vitest_extract)
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


class VitestEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = 'src/synthetic.test.tsx'
        (self.root / 'src').mkdir()
        (self.root / self.file).write_text('expect(result).toBe(true);\n' * 20)
        self.source, self.output = self.root / 'raw.json', self.root / 'safe.json'
        self.approved = {'expected_commit': 'a' * 40, 'expected_tree': 'b' * 40}
        self.test = {'status': 'failed', 'duration': 12.5, 'location': {'line': 2, 'column': 1},
                     'title': 'SECRET_CUSTOMER', 'failureMessages': [
                         'expect(received).toBe(expected)\nExpected: "SECRET_CUSTOMER"\nReceived: true\n'
                         + ' at test (' + str(self.root / self.file) + ':3:1)']}
        self.data = {'numTotalTests': 1, 'numPassedTests': 0, 'numFailedTests': 1,
                     'numPendingTests': 0, 'numFailedTestSuites': 2,
                     'testResults': [{'name': str(self.root / self.file), 'status': 'failed',
                                      'assertionResults': [self.test]}]}
    def extract(self):
        self.source.write_text(json.dumps(self.data))
        def identity(args, **kwargs):
            return (self.approved['expected_tree'] if args[-1] == 'HEAD^{tree}' else self.approved['expected_commit']).encode()
        with patch.object(diagnostics.subprocess, 'check_output', side_effect=identity):
            result = diagnostics.vitest_evidence(self.source, self.output, self.root, {self.file}, self.approved)
        text = self.output.read_text()
        for secret in ['SECRET_CUSTOMER', 'Bearer', 'postgresql://', '<div>', str(self.root), 'rawStack']:
            self.assertNotIn(secret, text)
        return result
    def test_single_assertion(self):
        result = self.extract()
        self.assertEqual(result['frontend_commit'], 'a' * 40)
        failure = result['failures'][0]
        self.assertEqual(failure['assertion_ordinal'], 1)
        self.assertEqual(failure['classification'], 'assertion')
        self.assertEqual(failure['reported_source_locations'], [{'file': self.file, 'line': 3, 'column': 1}])
        self.assertEqual(failure['test_location']['line'], 2)
        self.assertEqual(failure['expected_actual'], 'unavailable')
    def test_passing_report(self):
        self.test.update(status='passed', failureMessages=[])
        self.data.update(numFailedTests=0, numPassedTests=1, numFailedTestSuites=0)
        self.data['testResults'][0]['status'] = 'passed'
        self.assertEqual(self.extract()['failures'], [])
    def test_multiple_assertions(self):
        self.data['testResults'][0]['assertionResults'].append(dict(self.test))
        self.data.update(numTotalTests=2, numFailedTests=2)
        self.assertEqual([x['assertion_ordinal'] for x in self.extract()['failures']], [1, 2])
    def test_enclosing_suites_do_not_duplicate_failure(self):
        self.assertEqual(self.extract()['failed_test_count'], 1)
    def test_explicit_timeout(self):
        self.test['failureMessages'] = ['Error: Test timed out in 5000ms.\nSECRET_CUSTOMER']
        failure = self.extract()['failures'][0]
        self.assertEqual(failure['classification'], 'timeout')
        self.assertEqual(failure['timeout']['limit_ms'], 5000)
    def test_duration_never_implies_timeout(self):
        self.test.update(duration=90000, failureMessages=[])
        self.assertIsNone(self.extract()['failures'][0]['timeout'])
    def test_unhandled_error_not_in_report_cannot_be_invented(self):
        self.data['unhandledErrors'] = [{'rawStack': 'SECRET_CUSTOMER'}]
        self.test['failureMessages'] = ['Unhandled Error: SECRET_CUSTOMER']
        result = self.extract()
        self.assertEqual(result['failures'][0]['classification'], 'unknown')
        self.assertEqual(result['unhandled_error_details'], 'unavailable_in_vitest_4_1_6_json')
    def test_failed_suite_without_failed_assertion(self):
        self.data['testResults'][0].update(assertionResults=[], message='SECRET_CUSTOMER')
        self.data['numFailedTests'] = 0
        result = self.extract()
        self.assertEqual(result['suites'][0]['classification'], 'unknown')
        self.assertEqual(result['failed_test_count'], 0)
    def test_missing_metadata_is_unavailable(self):
        self.test.pop('failureMessages'); self.test.pop('location'); self.test.pop('duration')
        failure = self.extract()['failures'][0]
        self.assertFalse(failure['details_available'])
        self.assertIsNone(failure['test_location'])
    def test_malformed_metadata_blocks(self):
        for value in [None, {}, [42], ['x' * (diagnostics.MAX_TEXT + 1)]]:
            with self.subTest(value_type=type(value).__name__):
                self.test['failureMessages'] = value
                with self.assertRaises(ValueError): self.extract()
    def test_bad_duration_blocks(self):
        for value in [True, -1, float('nan'), float('inf'), 'SECRET_CUSTOMER']:
            self.test['duration'] = value
            with self.assertRaises(ValueError): self.extract()
    def test_invalid_external_and_traversal_paths_block(self):
        for path in ['/outside/synthetic.test.tsx', '../src/synthetic.test.tsx', 'src/unknown.test.tsx']:
            self.data['testResults'][0]['name'] = path
            with self.assertRaises(ValueError): self.extract()
    def test_symlink_boundary_blocks(self):
        (self.root / self.file).unlink()
        (self.root / self.file).symlink_to(Path(__file__).resolve())
        with self.assertRaises(ValueError): self.extract()
    def test_invalid_locations_omitted(self):
        self.test['location'] = {'line': 999, 'column': True}
        self.test['failureMessages'] = [' at test (/outside/source.tsx:1:1)']
        failure = self.extract()['failures'][0]
        self.assertIsNone(failure['test_location']); self.assertEqual(failure['reported_source_locations'], [])
    def test_all_dynamic_payloads_omitted(self):
        self.test.update(title='SECRET_CUSTOMER', ancestorTitles=['Bearer SECRET_CUSTOMER'],
                         fullName='SECRET_CUSTOMER', meta={'rawStack': 'SECRET_CUSTOMER'},
                         expected={'content': '<div>SECRET_CUSTOMER</div>'}, actual='postgresql://SECRET_CUSTOMER')
        self.test['failureMessages'] = ['Expected: 123456789\nReceived: false\nBearer SECRET_CUSTOMER\n<div>SECRET_CUSTOMER</div>\nrawStack']
        result = self.extract()
        self.assertNotIn('123456789', self.output.read_text())
        self.assertNotIn('false', json.dumps(result['failures']))
    def test_count_mismatch_blocks(self):
        self.data['numFailedTests'] = 2
        with self.assertRaises(ValueError): self.extract()
    def test_oversized_input_blocks(self):
        self.data['padding'] = 'x' * 1000
        with patch.object(diagnostics, 'MAX_INPUT', 500):
            with self.assertRaises(ValueError): self.extract()
    def test_output_budget_blocks(self):
        with patch.object(diagnostics, 'MAX_BYTES', 10):
            with self.assertRaises(ValueError): self.extract()
    def test_identity_mismatch_blocks(self):
        self.source.write_text(json.dumps(self.data))
        with patch.object(diagnostics.subprocess, 'check_output', return_value=b'c' * 40):
            with self.assertRaises(ValueError):
                diagnostics.vitest_evidence(self.source, self.output, self.root, {self.file}, self.approved)
    def test_runner_failed_exit_preserved_even_when_report_passes(self):
        self.test.update(status='passed', failureMessages=[])
        self.data.update(numFailedTests=0, numPassedTests=1, numFailedTestSuites=0)
        self.data['testResults'][0]['status'] = 'passed'
        self.runner(exit_code=7)
    def test_runner_zero_exit_cannot_override_failed_report(self):
        self.runner(exit_code=0)
    def test_runner_extraction_failure_preserves_exit(self):
        self.runner(exit_code=9, malformed=True)
    def runner(self, exit_code, malformed=False):
        tree = ast.parse(Path(__file__).with_name('run.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run')
        def fake_capture(args, cwd, env, raw):
            Path(raw).write_text('Error: SECRET_CUSTOMER')
            target = next(x.split('=', 1)[1] for x in args if x.startswith('--outputFile='))
            Path(target).write_text('invalid' if malformed else json.dumps(self.data))
            return {'exit_code': exit_code, 'timed_out': False, 'output_limit_exceeded': False}
        def extractor(source, destination, root, allowed, approved):
            with patch.object(diagnostics.subprocess, 'check_output', side_effect=[b'a'*40, b'b'*40]):
                return diagnostics.vitest_evidence(source, destination, root, allowed, self.approved)
        scope = dict(vars(diagnostics), env={}, output=self.root, results=[], time=time,
                     __file__=str(Path(__file__).with_name('run.py')), capture=fake_capture,
                     trusted_files=lambda _: {self.file}, vitest_evidence=extractor)
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'run.py', 'exec'), scope)
        with self.assertRaises(RuntimeError): scope['run']('frontend-vitest', ['vitest'], self.root, test_json=True)
        item = json.loads((self.root/'tests.json').read_text())[-1]
        self.assertEqual(item['exit_code'], exit_code)
        self.assertEqual(item['status'], 'FAIL')
        for path in self.root.glob('*.json'):
            if not path.name.endswith('.raw.json'):
                self.assertNotIn('SECRET_CUSTOMER', path.read_text())


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
