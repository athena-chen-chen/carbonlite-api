"""Entry/source identity gate. Standard library only; no diagnostic imports."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

PREFIX = 'ci/pilot-checkpoint-ab/'
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



def verify(workspace, env, approved):
    require(env.get('GITHUB_REPOSITORY') == approved['repository'])
    require(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch')
    require(env.get('GITHUB_REF') == 'refs/heads/' + approved['branch'])
    sha, tree, index = (env.get(k, '') for k in ('ENTRY_SHA','ENTRY_TREE','ENTRY_INDEX_SHA256'))
    require(re.fullmatch(r'[0-9a-f]{40}', sha) is not None)
    require(re.fullmatch(r'[0-9a-f]{40}', tree) is not None)
    require(re.fullmatch(r'[0-9a-f]{64}', index) is not None)
    require(sha == env.get('GITHUB_SHA') == env.get('INVOKING_WORKFLOW_SHA'))
    entry, control, api = [workspace / p for p in ('entry','control','carbonlite-api')]
    roots = [p.resolve(strict=True) for p in (entry,control,api)]
    require(len(set(roots)) == 3 and all(p.parent == workspace.resolve() for p in roots))
    checkout(entry, sha, tree, approved['baseline'], approved['files'], approved['repository'])
    data = regular(entry, INDEX)
    require(digest(data) == index)
    files = index_files(data)
    require(set(files) == set(approved['files']) - {INDEX})
    hashes(entry, files)
    checkout(control, approved['control_commit'], approved['control_tree'], approved['control_commit'], [], approved['repository'])
    data = regular(control, 'SHA256SUMS.txt')
    require(digest(data) == approved['control_index_sha256'])
    files = index_files(data); require(len(files) == 15); hashes(control, files)
    b = approved['backend']
    checkout(api, b['expected_commit'], b['expected_tree'], b['baseline'], b['files'], b['repository'])
    hashes(api,b['files'])
    return {'entry_commit':sha,'entry_tree':tree,'backend_commit':b['expected_commit'],
            'backend_tree':b['expected_tree'],'control_commit':approved['control_commit'],
            'control_tree':approved['control_tree']}


def audit_permissions(workspace):
    # Same root/verified Runner trust semantics as the pinned permission guard.
    import importlib.util, pwd, grp, errno, stat, sys
    require(sys.platform == 'linux' and os.getuid() not in {0,24001})
    runner = os.getuid(); gid = pwd.getpwuid(runner).pw_gid
    trusted = {0,runner}
    spec = importlib.util.spec_from_file_location('reviewed_permissions', workspace/'control/ci/pilot-exact-pair/runner-permissions.py')
    guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    guard.verify(workspace,runner,gid)
    def group_ok(value):
        if value not in {0,gid}: return False
        group=grp.getgrgid(value)
        members={pwd.getpwnam(name).pw_uid for name in group.gr_mem}
        members.update(p.pw_uid for p in pwd.getpwall() if p.pw_gid==value)
        return members <= trusted
    entry=workspace/'entry'
    approval=json.loads(regular(entry,PREFIX+'approved.json'))
    paths={entry,*entry.parents}
    for name in approval['files']:
        p=entry/name; paths.update([p,*p.parents])
    for p in paths:
        info=p.lstat(); directory=stat.S_ISDIR(info.st_mode)
        require(directory or stat.S_ISREG(info.st_mode))
        require(info.st_uid in trusted and not info.st_mode & stat.S_IWOTH)
        require(not info.st_mode & stat.S_IWGRP or group_ok(info.st_gid))
        names=os.listxattr(p,follow_symlinks=False)
        require(not any('acl' in n.lower() and n not in {'system.posix_acl_access','system.posix_acl_default'} for n in names))
        for attr in ('system.posix_acl_access','system.posix_acl_default'):
            try:data=os.getxattr(p,attr,follow_symlinks=False)
            except OSError as error:
                if error.errno==errno.ENODATA:continue
                raise ValueError('ACL_INSPECTION') from None
            require(directory or not attr.endswith('default'))
            for tag,perms,ident in guard.acl_entries(data):
                if not perms & 2 or tag==16:continue
                allowed=(info.st_uid in trusted if tag==1 else ident in trusted if tag==2 else
                         group_ok(info.st_gid) if tag==4 else group_ok(ident) if tag==8 else False)
                require(allowed)  # Masked untrusted writes are still prohibited.
        result=subprocess.run(['sudo','-u','clpairtest','test','-w',str(p)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        require(result.returncode==1)


def main():
    root=Path(os.environ['GITHUB_WORKSPACE'])
    a=json.loads(regular(root/'entry',PREFIX+'approved.json'))
    verify(root,os.environ,a)
    print('CHECKPOINT_AB_IDENTITY: PASS')


if __name__=='__main__':
    try:main()
    except Exception:
        print('CHECKPOINT_AB_IDENTITY: BLOCKED')
        raise SystemExit(1)
