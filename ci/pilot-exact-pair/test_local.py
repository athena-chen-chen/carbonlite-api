"""Synthetic verifier tests only; no commits, network, Docker or databases."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pair_verify', Path(__file__).with_name('verify.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IdentityGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'sample.txt').write_bytes(b'synthetic only\n')
        self.sha = 'a' * 40
        self.approved = {'repository': 'athena-chen-chen/carbonlite-api', 'expected_commit': self.sha, 'expected_tree': 'b' * 40,
                         'baseline': 'c' * 40, 'reviewed_patch_sha256': 'd' * 64, 'files': {'sample.txt': hashlib.sha256(b'synthetic only\n').hexdigest()}}
        self.responses = {('remote', 'get-url', 'origin'): 'https://github.com/athena-chen-chen/carbonlite-api.git',
                          ('rev-parse', 'HEAD'): self.sha, ('rev-parse', 'HEAD^{tree}'): 'b' * 40,
                          ('diff', '--no-renames', '--name-only', 'c' * 40, self.sha): 'sample.txt',
                          ('status', '--porcelain', '--untracked-files=all'): ''}
        self.git_patch = patch.object(module, 'git', side_effect=lambda root, *args: self.responses[args])
        self.run_patch = patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0))
        self.git_patch.start()
        self.runner = self.run_patch.start()
        self.addCleanup(self.git_patch.stop)
        self.addCleanup(self.run_patch.stop)

    def verify(self):
        return module.verify(self.root, self.sha, self.approved)

    def test_matching_identity(self):
        self.assertEqual(self.verify()['identity'], 'PASS')
        self.assertTrue(self.runner.call_args.kwargs['check'])

    def test_returned_approved_commit_is_exact_pin_not_file_digest(self):
        result = self.verify()
        self.assertEqual(result['approved_commit'], self.approved['expected_commit'])
        self.assertEqual(result['approved_commit'], result['commit'])
        self.assertRegex(result['approved_commit'], r'^[0-9a-f]{40}$')
        self.assertNotIn(result['approved_commit'], self.approved['files'].values())

    def test_both_published_approval_pins_are_reported_exactly(self):
        import json
        approvals = json.loads(Path(__file__).with_name('approved.json').read_text())
        for kind in ('backend', 'frontend'):
            with self.subTest(candidate=kind):
                approval = dict(approvals[kind], files=self.approved['files'])
                commit = approvals[kind]['expected_commit']
                self.responses[('remote', 'get-url', 'origin')] = 'https://github.com/' + approval['repository']
                self.responses[('rev-parse', 'HEAD')] = commit
                self.responses[('rev-parse', 'HEAD^{tree}')] = approval['expected_tree']
                self.responses[('diff', '--no-renames', '--name-only', approval['baseline'], commit)] = 'sample.txt'
                result = module.verify(self.root, commit, approval)
                self.assertEqual(result['approved_commit'], approvals[kind]['expected_commit'])
                self.assertEqual(result['approved_commit'], commit)
                self.assertRegex(result['approved_commit'], r'^[0-9a-f]{40}$')
                self.assertNotIn(result['approved_commit'], approval['files'].values())

    def test_rejects_branch_or_injection_instead_of_sha(self):
        for value in ['main', 'a' * 39, 'a' * 41, 'A' * 40, '$(echo unsafe)']:
            with self.assertRaises(ValueError):
                module.verify(self.root, value, self.approved)

    def test_different_commit_with_same_tree_rejected(self):
        other = 'e' * 40
        self.responses[('rev-parse', 'HEAD')] = other
        with self.assertRaises(ValueError):
            module.verify(self.root, other, self.approved)

    def test_missing_commit_pin_rejected(self):
        del self.approved['expected_commit']
        with self.assertRaises(ValueError): self.verify()

    def test_malformed_commit_pin_rejected(self):
        for value in [None, 'main', 'a' * 39, 'A' * 40]:
            self.approved['expected_commit'] = value
            with self.assertRaises(ValueError): self.verify()

    def test_superseded_backend_commit_rejected(self):
        self.approved['expected_commit'] = '188e62b21fc1069d461bf440fbc62b5b48e70f0c'
        for stale in ('e424c567d43c0086e0dc01b86e48cb648c114078',
                      'b1cc0c810c46669003d00d18d18349b6944fbf0a'):
            with self.subTest(commit=stale), self.assertRaisesRegex(ValueError, 'Commit differs'):
                module.verify(self.root, stale, self.approved)

    def test_rebound_backend_rejects_mixed_head_and_tree_identities(self):
        commit = '188e62b21fc1069d461bf440fbc62b5b48e70f0c'
        tree = '527afe06335da3a391fe87ff91d6a58de1a41a4d'
        previous_commit = 'e424c567d43c0086e0dc01b86e48cb648c114078'
        previous_tree = 'f4e02d756dc14c0df638d7086b483566e7efeca5'
        self.approved.update(expected_commit=commit, expected_tree=tree)
        self.responses[('diff', '--no-renames', '--name-only', 'c' * 40, commit)] = 'sample.txt'
        for head, actual_tree in ((previous_commit, tree), (commit, previous_tree),
                                  (previous_commit, previous_tree)):
            self.responses[('rev-parse', 'HEAD')] = head
            self.responses[('rev-parse', 'HEAD^{tree}')] = actual_tree
            with self.subTest(head=head, tree=actual_tree), self.assertRaises(ValueError):
                module.verify(self.root, commit, self.approved)
        self.responses[('rev-parse', 'HEAD')] = commit
        self.responses[('rev-parse', 'HEAD^{tree}')] = tree
        self.assertEqual(module.verify(self.root, commit, self.approved)['identity'], 'PASS')

    def test_superseded_frontend_commit_rejected(self):
        self.approved['expected_commit'] = '41a80df3462956b276dc0854c8e5c00571bcf04a'
        for stale in ('1b822f9437ac164c538222ef9d51a4a2f2d663d7',
                      '760b583c4091329c05d41349a7e257f6c6e5b3cd'):
            with self.subTest(commit=stale), self.assertRaisesRegex(ValueError, 'Commit differs'):
                module.verify(self.root, stale, self.approved)

    def test_frontend_successor_rejects_mixed_head_and_tree(self):
        commit = '41a80df3462956b276dc0854c8e5c00571bcf04a'
        tree = 'f8ca553b7f1523512a1b665ef1902c4c55e87f5e'
        self.approved.update(expected_commit=commit, expected_tree=tree)
        self.responses[('diff', '--no-renames', '--name-only', 'c' * 40, commit)] = 'sample.txt'
        for old_commit, old_tree in (
                ('1b822f9437ac164c538222ef9d51a4a2f2d663d7', 'cfc181616b2fd12e4acc16d81ecdbb885ba6997a'),
                ('760b583c4091329c05d41349a7e257f6c6e5b3cd', '3885eef878844d9050a2022b0086301ce9e95176')):
            for head, actual_tree in ((old_commit, tree), (commit, old_tree), (old_commit, old_tree)):
                with self.subTest(head=head, tree=actual_tree):
                    self.responses[('rev-parse', 'HEAD')] = head
                    self.responses[('rev-parse', 'HEAD^{tree}')] = actual_tree
                    with self.assertRaises(ValueError):
                        module.verify(self.root, commit, self.approved)
        self.responses[('rev-parse', 'HEAD')] = commit
        self.responses[('rev-parse', 'HEAD^{tree}')] = tree
        self.assertEqual(module.verify(self.root, commit, self.approved)['identity'], 'PASS')

    def test_old_typescript_fixture_hashes_rejected(self):
        for stale in ('4ca545919811f681dc3d704efada0dddb537e3a26094fb7f6d9018f814e22957',
                      '9c69f3063c61f782537d98158b551425d4f451d922ae14ca82558de3cbe09b01'):
            self.approved['files']['sample.txt'] = stale
            with self.subTest(hash=stale), self.assertRaisesRegex(ValueError, 'File hash mismatch'):
                self.verify()

    def test_superseded_frontend_fixture_hash_rejected(self):
        self.approved['files']['sample.txt'] = '0446cb7bd7f681cbeaf06b53f39800979dc25ac66dbe6b931e170dee2d663b94'
        with self.assertRaisesRegex(ValueError, 'File hash mismatch'):
            self.verify()

    def test_wrong_repository(self):
        self.responses[('remote', 'get-url', 'origin')] = 'https://github.com/example/wrong'
        with self.assertRaises(ValueError): self.verify()

    def test_wrong_head(self):
        self.responses[('rev-parse', 'HEAD')] = 'd' * 40
        with self.assertRaises(ValueError): self.verify()

    def test_wrong_tree(self):
        self.responses[('rev-parse', 'HEAD^{tree}')] = 'd' * 40
        with self.assertRaises(ValueError): self.verify()

    def test_missing_baseline_ancestry(self):
        self.runner.side_effect = subprocess.CalledProcessError(1, ['git'])
        with self.assertRaises(subprocess.CalledProcessError): self.verify()

    def test_extra_changed_file(self):
        self.responses[('diff', '--no-renames', '--name-only', 'c' * 40, self.sha)] = 'sample.txt\nextra.txt'
        with self.assertRaises(ValueError): self.verify()

    def test_missing_changed_file(self):
        self.responses[('diff', '--no-renames', '--name-only', 'c' * 40, self.sha)] = ''
        with self.assertRaises(ValueError): self.verify()

    def test_dirty_checkout(self):
        self.responses[('status', '--porcelain', '--untracked-files=all')] = '?? unreviewed.txt'
        with self.assertRaises(ValueError): self.verify()

    def test_altered_bytes(self):
        (self.root / 'sample.txt').write_bytes(b'deliberately altered')
        with self.assertRaises(ValueError): self.verify()

    def test_missing_file(self):
        (self.root / 'sample.txt').unlink()
        with self.assertRaises(ValueError): self.verify()

    def test_symlink_rejected(self):
        (self.root / 'sample.txt').unlink()
        (self.root / 'sample.txt').symlink_to('missing.txt')
        with self.assertRaises(ValueError): self.verify()





import sys
sys.path.insert(0, str(Path(__file__).parent))
from type_debt import compare, parse, DebtBlocked


class WorkflowBranchGuardTests(unittest.TestCase):
    """Execute only the actual first-step Bash guard, without checkouts or services."""
    def setUp(self):
        import json
        import os
        import textwrap
        source = (Path(__file__).parents[2] / '.github/workflows/nightly-e2e.yml').read_text()
        start = source.index('          set -euo pipefail\n')
        end = source.index('      - name: Check out the exact validation workflow revision', start)
        self.guard = textwrap.dedent(source[start:end])
        approved = json.loads(Path(__file__).with_name('approved.json').read_text())
        self.environment = {'PATH': os.environ['PATH'],
                            'GITHUB_REPOSITORY': 'athena-chen-chen/carbonlite-api',
                            'GITHUB_EVENT_NAME': 'workflow_dispatch',
                            'GITHUB_REF': 'refs/heads/ci/pilot-exact-pair-final',
                            'FRONTEND_SHA': approved['frontend']['expected_commit'],
                            'BACKEND_SHA': approved['backend']['expected_commit']}

    def invoke(self, changes=None, missing=None):
        environment = {**self.environment, **(changes or {})}
        if missing:
            environment.pop(missing)
        return subprocess.run(['bash', '-c', self.guard], env=environment,
                              capture_output=True).returncode

    def test_manual_exact_final_branch_accepted(self):
        self.assertEqual(self.invoke(), 0)

    def test_old_and_arbitrary_refs_rejected(self):
        for ref in ('refs/heads/ci/pilot-exact-pair-validation', 'refs/heads/main',
                    'refs/heads/arbitrary', 'refs/heads/ci/pilot-exact-pair-final-extra',
                    'refs/tags/ci/pilot-exact-pair-final', 'refs/pull/1/merge', ''):
            with self.subTest(ref=ref):
                self.assertNotEqual(self.invoke({'GITHUB_REF': ref}), 0)

    def test_nonmanual_events_rejected(self):
        for event in ('push', 'pull_request', 'schedule', 'repository_dispatch', ''):
            with self.subTest(event=event):
                self.assertNotEqual(self.invoke({'GITHUB_EVENT_NAME': event}), 0)

    def test_other_repository_rejected(self):
        for repository in ('example/carbonlite-api', 'athena-chen-chen/carbonlite-web', ''):
            with self.subTest(repository=repository):
                self.assertNotEqual(self.invoke({'GITHUB_REPOSITORY': repository}), 0)

    def test_missing_inputs_rejected(self):
        for key in self.environment.keys() - {'PATH'}:
            with self.subTest(missing=key):
                self.assertNotEqual(self.invoke(missing=key), 0)

    def test_malformed_inputs_rejected_with_hosted_compatible_bash(self):
        major = int(subprocess.check_output(
            ['bash', '-c', 'printf "%s" "${BASH_VERSINFO[0]}"'],
            env={'PATH': self.environment['PATH']}))
        if major < 4:
            self.skipTest('Bash 3.2 ignores intermediate [[ ]] failures under errexit; Bash 4+ required')
        for key in ('FRONTEND_SHA', 'BACKEND_SHA'):
            for value in ('main', 'a' * 39, 'a' * 41, 'A' * 40, '$(echo unsafe)', ''):
                with self.subTest(key=key, value=value):
                    self.assertNotEqual(self.invoke({key: value}), 0)


class TypeDebtTests(unittest.TestCase):
    diagnostic = "src/example.test.ts(12,3): error TS2345: Synthetic contract mismatch.\n  Missing property 'value'.\n"

    def record(self, text=None, exit_code=2, version='5.synthetic'):
        return {'toolchain': {'typescript': version, 'lockfile': 'same', 'config': 'same', 'environment': 'same'},
                'output': self.diagnostic if text is None else text, 'exit_code': exit_code}

    def test_identical_debt_passes_policy_not_typecheck(self):
        result = compare(self.record(), self.record())
        self.assertEqual(result['policy'], 'PASS')
        self.assertEqual(result['raw_candidate_typecheck'], 'FAIL — HISTORICAL DEBT')
        self.assertEqual(result['candidate_count'], 1)

    def test_fewer_diagnostics(self):
        result = compare(self.record(self.diagnostic * 2), self.record())
        self.assertEqual(result['policy'], 'PASS')
        self.assertEqual(result['removed_or_decreased'][0]['count'], 1)

    def test_new_diagnostic(self):
        result = compare(self.record(), self.record(self.diagnostic.replace('TS2345', 'TS9999')))
        self.assertEqual(result['policy'], 'BLOCKED')

    def test_increased_duplicate(self):
        self.assertEqual(compare(self.record(), self.record(self.diagnostic * 2))['policy'], 'BLOCKED')

    def test_missing_baseline(self):
        with self.assertRaises(DebtBlocked): compare(None, self.record())

    def test_invalid_output(self):
        for text in ['node: compiler missing', 'unexpected banner\n' + self.diagnostic, 'error TS9999: global error']:
            with self.assertRaises(DebtBlocked): compare(self.record(), self.record(text))

    def test_toolchain_mismatch(self):
        with self.assertRaises(DebtBlocked): compare(self.record(), self.record(version='different'))
        for key in ['lockfile', 'config', 'environment']:
            candidate = self.record()
            candidate['toolchain'][key] = 'different'
            with self.assertRaises(DebtBlocked): compare(self.record(), candidate)

    def test_invocation_failure(self):
        for code in [-9, 1, 127]:
            with self.assertRaises(DebtBlocked): compare(self.record(), self.record(exit_code=code))

    def test_status_output_mismatch(self):
        for text, code in [('', 2), (self.diagnostic, 0)]:
            with self.assertRaises(DebtBlocked): parse(text, code)

    def test_nested_message_change_is_new(self):
        self.assertEqual(compare(self.record(), self.record(self.diagnostic.replace("'value'", "'different'")))['policy'], 'BLOCKED')

    def test_line_movement_does_not_change_identity(self):
        self.assertEqual(compare(self.record(), self.record(self.diagnostic.replace('(12,3)', '(99,4)')))['policy'], 'PASS')

    def test_clean_candidate(self):
        result = compare(self.record(), self.record('', 0))
        self.assertEqual(result['policy'], 'PASS')
        self.assertEqual(result['candidate_count'], 0)

    def test_only_known_absolute_root_normalized(self):
        a, b = self.record('/tmp/a/' + self.diagnostic), self.record('/tmp/b/' + self.diagnostic)
        a['roots'], b['roots'] = [('/tmp/a', '<frontend>')], [('/tmp/b', '<frontend>')]
        self.assertEqual(compare(a, b)['policy'], 'PASS')





import contextlib
import io
import json
import tarfile
import type_debt


class DebtExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.web, self.api, self.output = [self.root / name for name in ['web', 'api', 'results']]
        for folder in [self.web, self.api, self.output]: folder.mkdir()
        self.config = {'compilerOptions': {'types': ['vitest']}}
        self.files = {'package.json': '{}', 'pnpm-lock.yaml': 'synthetic lock',
                      'tsconfig.spec.json': json.dumps(self.config), 'tsconfig.json': '{}',
                      'src/example.test.ts': 'synthetic only'}
        for name, text in self.files.items():
            path = self.web / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        comparable = {'compilerOptions': {'types': ['vitest', '@testing-library/jest-dom/vitest']}}
        (self.web / 'tsconfig.spec.json').write_text(json.dumps(comparable))
        for name, text in {'typescript/package.json': '{"version":"synthetic"}',
                           'typescript/lib/tsc.js': '// synthetic compiler', '.pnpm/lock.yaml': 'synthetic installed lock'}.items():
            path = self.web / 'node_modules' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for name, text in self.files.items():
                data = text.encode()
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        self.archive = buffer.getvalue()

    def invoke(self, baseline_output=None, candidate_output=None):
        diagnostic = TypeDebtTests.diagnostic.encode()
        outputs = iter([diagnostic if baseline_output is None else baseline_output,
                        diagnostic if candidate_output is None else candidate_output])
        def fake_git(root, *args):
            return self.archive if args[0] == 'archive' else b'synthetic-tree'
        def fake_checked(command, cwd, env):
            if '--showConfig' in command: return '{"compilerOptions":{"strict":true}}'
            if '--version' in command: return 'v20.synthetic'
            return '/synthetic/node'
        def fake_run(*args, **kwargs):
            output = next(outputs)
            return subprocess.CompletedProcess(args, 2 if output else 0, output)
        with patch.object(type_debt, 'git', side_effect=fake_git), \
             patch.object(type_debt, 'checked', side_effect=fake_checked), \
             patch.object(type_debt.subprocess, 'run', side_effect=fake_run), \
             contextlib.redirect_stdout(io.StringIO()) as captured:
            try:
                result = type_debt.execute(self.web, self.api, self.output, {'CI': 'synthetic'},
                                           {'frontend': {'baseline': 'a' * 40}})
            except DebtBlocked:
                result = json.loads((self.output / 'type-debt-policy.json').read_text())
        return result, captured.getvalue()

    def test_full_evidence_and_raw_failure_preserved(self):
        report, output = self.invoke()
        self.assertEqual(report['policy'], 'PASS')
        self.assertEqual(report['candidate_compiler']['exit_code'], 2)
        self.assertIn('TEST TYPECHECK: FAIL — HISTORICAL DEBT', output)
        self.assertEqual((self.output / 'test-types-baseline.txt').read_text(), TypeDebtTests.diagnostic)
        self.assertEqual((self.output / 'test-types-candidate.txt').read_text(), TypeDebtTests.diagnostic)
        self.assertIn('matcher_overlay', report)
        self.assertFalse([p for p in self.output.glob('type-debt-*') if p.is_dir()])

    def test_execution_new_error_blocks_and_retains_evidence(self):
        report, _ = self.invoke(candidate_output=TypeDebtTests.diagnostic.replace('TS2345', 'TS9999').encode())
        self.assertEqual(report['policy'], 'BLOCKED')
        self.assertEqual(report['added_or_increased'][0]['code'], 'TS9999')

    def test_unreviewed_config_overlay_blocks(self):
        (self.web / 'tsconfig.spec.json').write_text('{"compilerOptions":{"strict":false}}')
        report, _ = self.invoke()
        self.assertEqual(report['policy'], 'BLOCKED')
        self.assertIn('Matcher overlay', report['reason'])

    def test_lockfile_mismatch_blocks(self):
        (self.web / 'pnpm-lock.yaml').write_text('different')
        report, _ = self.invoke()
        self.assertEqual(report['policy'], 'BLOCKED')
        self.assertIn('lockfile mismatch', report['reason'])


class PublishedPairMetadataTests(unittest.TestCase):
    def test_backend_pin_and_nine_file_manifest(self):
        import json
        data = json.loads(Path(__file__).with_name('approved.json').read_text())['backend']
        self.assertEqual(data['expected_commit'], '188e62b21fc1069d461bf440fbc62b5b48e70f0c')
        self.assertEqual(data['expected_tree'], '527afe06335da3a391fe87ff91d6a58de1a41a4d')
        self.assertEqual(data['baseline'], '1b38e3054be9da4a5935c1802a9a9389becf37a9')
        self.assertEqual(set(data['files']), {'src/common/security/recovery-control-store.spec.ts', 'src/metrics/calculation-quality.service.spec.ts', 'src/metrics/calculation-quality.service.ts', 'src/organizations/organizations.service.spec.ts', 'src/organizations/organizations.service.ts', 'test/document-resource-limits.e2e-spec.ts', 'test/mutation-outcomes.e2e-spec.ts', 'test/organization-profile.e2e-spec.ts', 'test/pilot-reporting-scope.e2e-spec.ts'})

    def test_new_test_hashes(self):
        import json
        files = json.loads(Path(__file__).with_name('approved.json').read_text())['backend']['files']
        self.assertEqual(files['src/common/security/recovery-control-store.spec.ts'], '4898bfa1874ca1bac35aa09440cf97da5dd3516886fc1b9c2f27d2105313cbe9')
        self.assertEqual(files['test/document-resource-limits.e2e-spec.ts'], '737c4bef9ac0ed29b578fc95964ef6ff951415f628a3c9e165da25394805c9c2')
        self.assertEqual(files['test/mutation-outcomes.e2e-spec.ts'], 'c46d6829a5b18dd48195a1e6b363985e29154633fc1eef54d7b8f78f37693a2e')

    def test_backend_cumulative_patch_identity(self):
        import json
        backend = json.loads(Path(__file__).with_name('approved.json').read_text())['backend']
        self.assertEqual(backend['reviewed_patch_sha256'], '5ebff061189886ab0a251e78ee1c4d17356badbbab39e3a03f0102a3ccf509d0')

    def test_frontend_successor_identity_and_fixture_manifest(self):
        import json
        data = json.loads(Path(__file__).with_name('approved.json').read_text())['frontend']
        self.assertEqual(data['expected_commit'], '41a80df3462956b276dc0854c8e5c00571bcf04a')
        self.assertEqual(data['expected_tree'], 'f8ca553b7f1523512a1b665ef1902c4c55e87f5e')
        self.assertEqual(data['baseline'], '3b69611d80d3f9a11712069bca2fd4eb72f51e15')
        self.assertEqual(len(data['files']), 55)
        self.assertEqual(data['files']['scripts/dev-database.test.mjs'], 'e68cb7444de38b750ad7d286ccd72f2ce9ad62c61aeb8226c807aa9dc0c3c61a')
        self.assertEqual(data['reviewed_patch_sha256'], '8b1f2b9f6daefffb2f0849d21fa40d0c0eecad38a18e40e3ae90ea318034f62e')

        self.assertEqual(data['files']['src/reports/domain/reportSemantics.test.tsx'], 'c619c0970f8633050c4b058d3275613de4c5bbe123025620c0d8b1713b9008a4')
        self.assertEqual(data['files']['src/utils/reportingReadiness.test.ts'], '012e323a69cb23344e0159671bf5f8e0f3e7dff39d610e0cb851a5c28dd2beb8')


class CheckpointScopeTests(unittest.TestCase):
    """Exercise the real stage function without Prisma, Docker or network access."""
    def setUp(self):
        import ast
        self.ast = ast
        self.source = Path(__file__).with_name('run.py').read_text()
        self.tree = ast.parse(self.source)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.calls = []
        self.shared = {'PATH': '/synthetic/bin', 'CI': 'true'}
        self.exit_code = 0
        def capture(command, cwd, environment, raw):
            self.calls.append((command, dict(environment)))
            return {'exit_code': self.exit_code, 'timed_out': False, 'output_limit_exceeded': False}
        stages = {'prisma-generation', 'disposable-migrate', 'disposable-seed',
                  'database-identity', 'backend-units', 'backend-types', 'backend-build',
                  'backend-e2e-postgres', 'backend-e2e-pgbouncer', 'frontend-script-tests',
                  'frontend-vitest', 'frontend-types', 'frontend-build'}
        self.ns = {'env': self.shared, 'output': self.output, 'results': [], 'STAGES': stages,
                   'trusted_files': lambda cwd: set(), 'capture': capture, 'json': json,
                   'time': __import__('time')}
        function = next(n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run')
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'run.py', 'exec'), self.ns)

    def invoke(self, label, command):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.ns['run'](label, command, self.output)

    def test_only_explicit_prisma_stages_receive_optout(self):
        for label, command in [('prisma-generation', ['pnpm', 'exec', 'prisma', 'generate']),
                               ('disposable-migrate', ['pnpm', 'exec', 'prisma', 'migrate', 'deploy'])]:
            with self.subTest(stage=label):
                self.invoke(label, command)
                self.assertEqual(self.calls[-1], (command, {**self.shared, 'CHECKPOINT_DISABLE': '1'}))
        self.assertNotIn('CHECKPOINT_DISABLE', self.shared)

    def test_no_optout_leaks_to_application_or_test_stages(self):
        self.invoke('disposable-migrate', ['pnpm', 'exec', 'prisma', 'migrate', 'deploy'])
        for label in sorted(self.ns['STAGES'] - {'prisma-generation', 'disposable-migrate'}):
            self.invoke(label, ['synthetic-command'])
            self.assertEqual(self.calls[-1][1], self.shared)

    def test_rollback_helper_gets_local_copy_for_nested_prisma_generate(self):
        ast = self.ast
        calls = [n for n in ast.walk(self.tree) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute) and n.func.attr == 'check_output']
        self.assertEqual(len(calls), 1)
        call = calls[0]
        self.assertEqual(ast.literal_eval(call.args[0]), ['node', 'scripts/phase-e-rollback-artifact.mjs'])
        expression = next(k.value for k in call.keywords if k.arg == 'env')
        result = eval(compile(ast.Expression(expression), 'run.py', 'eval'), {'env': self.shared})
        self.assertEqual(result, {**self.shared, 'CHECKPOINT_DISABLE': '1'})
        self.assertNotIn('CHECKPOINT_DISABLE', self.shared)

    def test_inherited_setting_is_not_a_global_test_environment_input(self):
        import types
        ast = self.ast
        assignment = next(n for n in self.tree.body if isinstance(n, ast.Assign)
                          and any(isinstance(t, ast.Name) and t.id == 'env' for t in n.targets))
        incoming = types.SimpleNamespace(environ={'PATH': '/synthetic/bin', 'POSTGRES_CONTAINER': 'synthetic',
                                                 'CHECKPOINT_DISABLE': '0'})
        result = eval(compile(ast.Expression(assignment.value), 'run.py', 'eval'),
                      {'os': incoming, 'output': self.output, 'api': self.output})
        self.assertNotIn('CHECKPOINT_DISABLE', result)

    def test_failed_migration_still_fails_and_retains_result(self):
        self.exit_code = 1
        with self.assertRaises(RuntimeError):
            self.invoke('disposable-migrate', ['pnpm', 'exec', 'prisma', 'migrate', 'deploy'])
        report = json.loads((self.output / 'tests.json').read_text())[-1]
        self.assertEqual((report['status'], report['exit_code']), ('FAIL', 1))

    def test_network_counters_still_block_either_family_and_inspection_failure(self):
        import os
        # Fake only the inspection command: the real reviewed network.sh check runs.
        sudo = self.output / 'sudo'
        sudo.write_text('#!/bin/bash\ncase "$1" in\n'
                        'iptables) n="${TEST_V4:?}";;\n'
                        'ip6tables) n="${TEST_V6:?}";;\n'
                        '*) exit 99;;\nesac\n'
                        '[ "$n" != ERROR ] || exit 1\n'
                        'printf "%s 0 REJECT all -- * * ::/0 ::/0\\n" "$n"\n')
        sudo.chmod(0o700)
        for v4, v6, passes in [('0', '0', True), ('1', '0', False), ('0', '1', False),
                               ('3', '0', False), ('ERROR', '0', False), ('0', 'ERROR', False)]:
            with self.subTest(v4=v4, v6=v6):
                result = subprocess.run(['bash', str(Path(__file__).with_name('network.sh')), 'check'],
                                        env={'PATH': str(self.output) + os.pathsep + os.environ['PATH'],
                                             'TEST_V4': v4, 'TEST_V6': v6}, capture_output=True)
                self.assertEqual(result.returncode == 0, passes)


if __name__ == '__main__':
    unittest.main()
