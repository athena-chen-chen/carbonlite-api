"""Fail-closed identity gate; standard library only, before dependency installation."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def git(root, *args):
    return subprocess.check_output(['git', '-c', 'safe.directory=' + str(root), '-C', str(root), *args], text=True).strip()


def verify(root, sha, approved):
    if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Full lowercase commit SHA required')
    approved_commit_sha = approved.get('expected_commit')
    if not isinstance(approved_commit_sha, str) or not re.fullmatch(r'[0-9a-f]{40}', approved_commit_sha):
        raise ValueError('Missing or malformed approved commit pin')
    if sha != approved_commit_sha:
        raise ValueError('Commit differs from immutable approved candidate')
    remote = git(root, 'remote', 'get-url', 'origin').removesuffix('.git')
    if remote != 'https://github.com/' + approved['repository']:
        raise ValueError('Repository mismatch')
    if git(root, 'rev-parse', 'HEAD') != sha:
        raise ValueError('HEAD mismatch')
    tree = git(root, 'rev-parse', 'HEAD^{tree}')
    if tree != approved['expected_tree']:
        raise ValueError('Tree mismatch')
    subprocess.run(['git', '-c', 'safe.directory=' + str(root), '-C', str(root), 'merge-base', '--is-ancestor', approved['baseline'], sha], check=True)
    paths = set(git(root, 'diff', '--no-renames', '--name-only', approved['baseline'], sha).splitlines())
    if paths != set(approved['files']):
        raise ValueError('Changed-file manifest mismatch')
    if git(root, 'status', '--porcelain', '--untracked-files=all'):
        raise ValueError('Checkout not clean')
    for name, expected_file_sha256 in approved['files'].items():
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Unexpected file type')
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected_file_sha256:
            raise ValueError('File hash mismatch')
    return {'repository': approved['repository'], 'commit': sha, 'approved_commit': approved_commit_sha, 'tree': tree,
            'baseline': approved['baseline'], 'changed_files': sorted(paths),
            'reviewed_file_sha256': approved['files'], 'reviewed_patch_sha256': approved['reviewed_patch_sha256'],
            'identity': 'PASS'}


def main():
    workspace = Path(os.environ['GITHUB_WORKSPACE'])
    approved = json.loads((Path(__file__).parent / 'approved.json').read_text())
    control = workspace / 'control'
    if git(control, 'remote', 'get-url', 'origin').removesuffix('.git') != 'https://github.com/athena-chen-chen/carbonlite-api':
        raise ValueError('Workflow repository mismatch')
    if git(control, 'rev-parse', 'HEAD') != os.environ['WORKFLOW_SHA']:
        raise ValueError('Workflow commit mismatch')
    result = {'workflow_commit': os.environ['WORKFLOW_SHA']}
    for kind, directory, variable in [('frontend', 'carbonlite-web', 'FRONTEND_SHA'), ('backend', 'carbonlite-api', 'BACKEND_SHA')]:
        result[kind] = verify(workspace / directory, os.environ[variable], approved[kind])
    output = workspace / 'pair-results'
    output.mkdir(exist_ok=True)
    (output / 'identity.json').write_text(json.dumps(result, indent=2))
    print('EXACT_PAIR_IDENTITY: PASS')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('EXACT_PAIR_IDENTITY: BLOCKED')
        raise SystemExit(1)
