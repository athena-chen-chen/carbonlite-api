"""No-new-diagnostics policy. Raw tsc failures remain failures, never typecheck PASS."""
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile


class DebtBlocked(ValueError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse(text, exit_code, roots=()):
    """Keep file/code/full-message identity and multiplicity; ignore line/column only."""
    if exit_code not in (0, 2):
        raise DebtBlocked('Compiler invocation failed')
    for root, label in sorted(roots, key=lambda item: len(str(item[0])), reverse=True):
        text = text.replace(str(root), label)
    diagnostics, current = [], None
    for line in text.splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)', line)
        if match:
            current = [match[1], match[4], match[5]]
            diagnostics.append(current)
        elif current is not None and line.startswith((' ', '\t')):
            current[2] += '\n' + line  # Preserve the complete nested diagnostic.
        else:
            raise DebtBlocked('Unrecognized compiler output')
    if (exit_code == 0) != (not diagnostics):
        raise DebtBlocked('Compiler status/output disagreement')
    return Counter(tuple(item) for item in diagnostics)


def compare(baseline, candidate):
    if baseline is None or candidate is None:
        raise DebtBlocked('Missing baseline or candidate evidence')
    if baseline['toolchain'] != candidate['toolchain']:
        raise DebtBlocked('Toolchain identity mismatch')
    old = parse(baseline['output'], baseline['exit_code'], baseline.get('roots', ()))
    new = parse(candidate['output'], candidate['exit_code'], candidate.get('roots', ()))
    added = new - old
    def rows(counter):
        return [{'file': key[0], 'code': key[1], 'message': key[2], 'count': count}
                for key, count in sorted(counter.items())]
    return {'policy': 'BLOCKED' if added else 'PASS',
            'raw_candidate_typecheck': 'FAIL — HISTORICAL DEBT' if new else 'PASS',
            'baseline_count': sum(old.values()), 'candidate_count': sum(new.values()),
            'added_or_increased': rows(added), 'removed_or_decreased': rows(old - new),
            'baseline_diagnostics': rows(old), 'candidate_diagnostics': rows(new)}


def git(root, *args):
    return subprocess.check_output(['git', '-c', 'safe.directory=' + str(root), '-C', str(root), *args])


def checked(command, cwd, env):
    return subprocess.check_output(command, cwd=cwd, env=env, stderr=subprocess.STDOUT, timeout=120).decode()


def snapshot(root):
    return {str(p.relative_to(root)): sha(p.read_bytes()) for p in root.rglob('*')
            if p.is_file() and 'node_modules' not in p.relative_to(root).parts}


def execute(web, api, output, env, approved):
    report = {'policy': 'BLOCKED', 'recorded_counts_reference_only': {'baseline': 293, 'candidate': 291}}
    evidence_path = output / 'type-debt-policy.json'
    try:
        # Build trusted baseline source from the verified repository; never fetch/install.
        commit = approved['frontend']['baseline']
        archive = git(web, 'archive', '--format=tar', commit)
        report['baseline'] = {'commit': commit,
                              'tree': git(web, 'rev-parse', commit + '^{tree}').decode().strip(),
                              'archive_sha256': sha(archive)}
        with tempfile.TemporaryDirectory(prefix='type-debt-', dir=output) as directory:
            pair = Path(directory)
            baseline = pair / 'carbonlite-web'
            baseline.mkdir()
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                for member in tar.getmembers():
                    name = Path(member.name)
                    if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                        raise DebtBlocked('Unsafe baseline archive member')
                tar.extractall(baseline)
            # Identical physical dependencies and API source resolution on both sides.
            (baseline / 'node_modules').symlink_to((web / 'node_modules').resolve(), target_is_directory=True)
            (pair / 'carbonlite-api').symlink_to(api.resolve(), target_is_directory=True)
            for name in ('package.json', 'pnpm-lock.yaml'):
                if (baseline / name).read_bytes() != (web / name).read_bytes():
                    raise DebtBlocked('Dependency/lockfile mismatch')
            configs = {p.name for p in baseline.glob('tsconfig*.json')} | {p.name for p in web.glob('tsconfig*.json')}
            for name in configs:
                old, new = (baseline / name).read_bytes(), (web / name).read_bytes()
                if old != new:
                    if name != 'tsconfig.spec.json':
                        raise DebtBlocked('Unreviewed test configuration difference')
                    a, b = json.loads(old), json.loads(new)
                    expected = json.loads(old)
                    expected['compilerOptions']['types'].append('@testing-library/jest-dom/vitest')
                    if b != expected:
                        raise DebtBlocked('Matcher overlay differs from reviewed addition')
                    (baseline / name).write_bytes(new)
                    report['matcher_overlay'] = {'path': name, 'baseline_sha256': sha(old), 'comparable_sha256': sha(new)}
            before = snapshot(baseline)
            node = checked(['node', '-p', 'process.execPath'], web, env).strip()
            tsroot = (web / 'node_modules/typescript').resolve()
            compiler = tsroot / 'lib/tsc.js'
            toolchain = {'node': checked([node, '--version'], web, env).strip(),
                         'typescript': json.loads((tsroot / 'package.json').read_text())['version'],
                         'typescript_files_sha256': sha(json.dumps(snapshot(tsroot), sort_keys=True).encode()),
                         'lockfile_sha256': sha((web / 'pnpm-lock.yaml').read_bytes()),
                         'installed_lockfile_sha256': sha((web / 'node_modules/.pnpm/lock.yaml').read_bytes()),
                         'environment_sha256': sha(json.dumps(env, sort_keys=True).encode()),
                         'api_tree': git(api, 'rev-parse', 'HEAD^{tree}').decode().strip(),
                         'shared_node_modules': str((web / 'node_modules').resolve()),
                         'configs': {name: sha((web / name).read_bytes()) for name in sorted(configs)}}
            records = []
            for label, root in [('baseline', baseline), ('candidate', web)]:
                if (root / 'node_modules').resolve() != (web / 'node_modules').resolve():
                    raise DebtBlocked('Dependency resolution mismatch')
                # ShowConfig verifies effective options, including inherited configuration.
                config = json.loads(checked([node, str(compiler), '--showConfig', '-p', 'tsconfig.spec.json'], root, env))
                options = json.dumps(config['compilerOptions'], sort_keys=True).replace(str(root), '<frontend>')
                fingerprint = dict(toolchain, effective_options=options)
                command = [node, str(compiler), '--noEmit', '--pretty', 'false', '-p', 'tsconfig.spec.json']
                try:
                    result = subprocess.run(command, cwd=root, env=env, stdout=subprocess.PIPE,
                                            stderr=subprocess.STDOUT, timeout=1800)
                except subprocess.TimeoutExpired as error:
                    (output / ('test-types-' + label + '.txt')).write_bytes(error.stdout or b'')
                    report[label + '_compiler'] = {'exit_code': None, 'invocation': 'TIMEOUT'}
                    raise DebtBlocked('Compiler invocation timed out')
                (output / ('test-types-' + label + '.txt')).write_bytes(result.stdout)
                report[label + '_compiler'] = {'exit_code': result.returncode, 'output_sha256': sha(result.stdout)}
                text = result.stdout.decode('utf-8', errors='strict')
                # Complete output and actual exit code remain auditable; no suppression.
                (output / ('test-types-' + label + '.txt')).write_text(text)
                print('TEST TYPECHECK ' + label.upper() + ' EXIT: ' + str(result.returncode), flush=True)
                print(text, flush=True)
                if re.search(r'error TS\d+:', text):
                    print('TEST TYPECHECK: FAIL — HISTORICAL DEBT', flush=True)
                records.append({'toolchain': fingerprint, 'exit_code': result.returncode, 'output': text,
                                'roots': [(root, '<frontend>'), (api, '<backend>')]})
                report[label + '_compiler'] = {'exit_code': result.returncode, 'output_sha256': sha(result.stdout)}
            if before != snapshot(baseline):
                raise DebtBlocked('Baseline source/configuration changed during compilation')
            # Recompute dependency/compiler identity to catch toolchain changes during execution.
            if (sha(json.dumps(snapshot(tsroot), sort_keys=True).encode()) != toolchain['typescript_files_sha256']
                    or sha((web / 'node_modules/.pnpm/lock.yaml').read_bytes()) != toolchain['installed_lockfile_sha256']):
                raise DebtBlocked('Toolchain changed during compilation')
            report['toolchain'] = toolchain
            report.update(compare(*records))
    except Exception as error:
        report['policy'] = 'BLOCKED'
        report['reason'] = str(error) if isinstance(error, DebtBlocked) else 'Baseline/compiler evidence unavailable or invocation failed'
    finally:
        evidence_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print('NO-NEW-DIAGNOSTICS POLICY: ' + report['policy'], flush=True)
    if report['policy'] != 'PASS':
        raise DebtBlocked('No-new-diagnostics gate blocked')
    return report
