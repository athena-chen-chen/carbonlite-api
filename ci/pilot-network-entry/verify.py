"""Entry/source identity gate. Standard library only; no diagnostic imports."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

PREFIX = 'ci/pilot-network-entry/'
INDEX = PREFIX + 'SHA256SUMS.txt'


def require(ok):
    if not ok:
        raise ValueError('Identity evidence mismatch')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output([
        'git', '-c', 'safe.directory=' + str(root), '-c', 'core.fsmonitor=false',
        '-C', str(root), *args], stderr=subprocess.DEVNULL, text=True).strip()


def regular(root, name):
    require(isinstance(name, str) and not name.startswith('/') and
            all(p not in ('', '.', '..') for p in name.split('/')))
    require(not root.is_symlink() and root.is_dir())
    path = root
    for part in name.split('/'):
        path = path / part
        require(not path.is_symlink())
    require(path.is_file())
    return path.read_bytes()


def index_files(data):
    text = data.decode('ascii')
    result = {}
    for line in text.splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_. /-]+)', line)
        require(match is not None)
        sha, name = match.groups()
        require(name not in result)
        require(not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')))
        result[name] = sha
    require(bool(result))
    return result


def hashes(root, files):
    for name, sha in files.items():
        require(re.fullmatch(r'[0-9a-f]{64}', sha) is not None)
        require(digest(regular(root, name)) == sha)


def checkout(root, sha, tree, baseline, files, repository):
    for identity in (sha, tree, baseline):
        require(isinstance(identity, str) and re.fullmatch(r'[0-9a-f]{40}', identity) is not None)
    require(git(root, 'remote', 'get-url', 'origin').removesuffix('.git') ==
            'https://github.com/' + repository)
    require(git(root, 'rev-parse', 'HEAD') == sha)
    require(git(root, 'rev-parse', 'HEAD^{tree}') == tree)
    require(git(root, 'merge-base', baseline, sha) == baseline)
    require(set(git(root, 'diff', '--no-renames', '--name-only', baseline, sha).splitlines()) == set(files))
    require(not git(root, 'status', '--porcelain', '--untracked-files=all'))
    # Reject Git symlinks/submodules even when checkout behavior differs by platform.
    for name in files:
        require(git(root, 'ls-tree', 'HEAD', '--', name).startswith(('100644 blob ', '100755 blob ')))
        regular(root, name)


def context(env, approved):
    require(env.get('GITHUB_REPOSITORY') == approved['repository'])
    require(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch')
    require(env.get('GITHUB_REF') == 'refs/heads/' + approved['entry_branch'])
    for key in ('ENTRY_SHA', 'ENTRY_TREE', 'DIAGNOSTIC_SHA', 'DIAGNOSTIC_TREE'):
        require(re.fullmatch(r'[0-9a-f]{40}', env.get(key, '')) is not None)
    require(re.fullmatch(r'[0-9a-f]{64}', env.get('ENTRY_INDEX_SHA256', '')) is not None)
    require(env['ENTRY_SHA'] == env.get('INVOKING_WORKFLOW_SHA') == env.get('GITHUB_SHA'))
    require(env['ENTRY_SHA'] != env['DIAGNOSTIC_SHA'])
    require(env['DIAGNOSTIC_SHA'] == approved.get('source_commit'))
    require(env['DIAGNOSTIC_TREE'] == approved.get('source_tree'))


def verify(workspace, env, approved):
    context(env, approved)
    entry, control, backend = (workspace / x for x in ('entry', 'control', 'carbonlite-api'))
    roots = [x.resolve(strict=True) for x in (entry, control, backend)]
    require(len(set(roots)) == 3 and all(p.parent == workspace.resolve() for p in roots))
    checkout(entry, env['ENTRY_SHA'], env['ENTRY_TREE'], approved['baseline'],
             approved['entry_files'], approved['repository'])
    entry_index = regular(entry, INDEX)
    require(digest(entry_index) == env['ENTRY_INDEX_SHA256'])
    entry_files = index_files(entry_index)
    require(set(entry_files) == set(approved['entry_files']) - {INDEX})
    hashes(entry, entry_files)
    # Source identity is now immutable policy, not a caller-selected revision.
    checkout(control, approved['source_commit'], approved['source_tree'], approved['baseline'],
             approved['source_files'], approved['repository'])
    hashes(control, approved['source_files'])
    old_index = regular(control, 'SHA256SUMS.txt')
    require(digest(old_index) == approved['exact_pair_index_sha256'])
    old_files = index_files(old_index)
    require(len(old_files) == 15)
    hashes(control, old_files)
    pin = approved['backend']
    checkout(backend, pin['expected_commit'], pin['expected_tree'], pin['baseline'],
             pin['files'], pin['repository'])
    hashes(backend, pin['files'])
    return {'entry_commit': env['ENTRY_SHA'], 'entry_tree': env['ENTRY_TREE'],
            'diagnostic_commit': env['DIAGNOSTIC_SHA'], 'diagnostic_tree': env['DIAGNOSTIC_TREE'],
            'backend_commit': pin['expected_commit'], 'backend_tree': pin['expected_tree']}


def main():
    workspace = Path(os.environ['GITHUB_WORKSPACE'])
    approved = json.loads(regular(workspace / 'entry', PREFIX + 'approved.json'))
    result = verify(workspace, os.environ, approved)
    print('NETWORK_DIAGNOSTIC_ENTRY_IDENTITY: PASS')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never print arbitrary exception text, paths, Git output or environment.
        print('NETWORK_DIAGNOSTIC_ENTRY_IDENTITY: BLOCKED')
        raise SystemExit(1)
