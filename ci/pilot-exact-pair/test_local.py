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
        self.approved = {'repository': 'athena-chen-chen/carbonlite-api', 'expected_tree': 'b' * 40,
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

    def test_rejects_branch_or_injection_instead_of_sha(self):
        for value in ['main', 'a' * 39, 'a' * 41, 'A' * 40, '$(echo unsafe)']:
            with self.assertRaises(ValueError):
                module.verify(self.root, value, self.approved)

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


if __name__ == '__main__':
    unittest.main()
