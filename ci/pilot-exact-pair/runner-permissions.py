"""Linux control-path integrity gate; metadata only, no permission repair or API access."""
import errno
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import struct
import sys


class Unsafe(ValueError):
    pass


def acl_entries(data):
    if len(data) < 4 or (len(data) - 4) % 8 or struct.unpack_from('<I', data)[0] != 2:
        raise Unsafe('unrecognized POSIX ACL encoding')
    entries = [struct.unpack_from('<HHI', data, offset) for offset in range(4, len(data), 8)]
    seen = set()
    for tag, perms, ident in entries:
        key = (tag, ident)
        if tag not in {1, 2, 4, 8, 16, 32} or perms > 7 or key in seen:
            raise Unsafe('invalid POSIX ACL entry')
        if (tag in {2, 8}) == (ident == 0xffffffff):
            raise Unsafe('invalid POSIX ACL identity')
        seen.add(key)
    for tag in (1, 4, 32):
        if sum(entry[0] == tag for entry in entries) != 1:
            raise Unsafe('missing POSIX ACL base entry')
    if sum(entry[0] == 16 for entry in entries) > 1 or (any(e[0] in {2, 8} for e in entries) and not any(e[0] == 16 for e in entries)):
        raise Unsafe('missing/duplicate POSIX ACL mask')
    return entries


def verify(workspace, runner_uid, runner_gid):
    if sys.platform != 'linux' or runner_uid == 24001:
        raise Unsafe('unsupported platform or untrusted runner identity')
    if os.geteuid() not in {0, runner_uid} or pwd.getpwuid(runner_uid).pw_gid != runner_gid:
        raise Unsafe('runner identity binding mismatch')
    trusted_uids = {0, runner_uid}
    # Explicit role-bound whitelist; membership must also be exclusively trusted.
    # Docker, clpairtest and arbitrary supplementary groups are never whitelisted.
    trusted_group_candidates = {0, runner_gid}
    group_cache = {}

    def trusted_group(gid):
        if gid not in group_cache:
            if gid not in trusted_group_candidates:
                group_cache[gid] = False
            else:
                group = grp.getgrgid(gid)
                members = {pwd.getpwnam(name).pw_uid for name in group.gr_mem}
                members.update(p.pw_uid for p in pwd.getpwall() if p.pw_gid == gid)
                group_cache[gid] = members <= trusted_uids
        return group_cache[gid]

    workspace = Path(workspace)
    if not workspace.is_absolute() or str(workspace.resolve(strict=True)) != str(workspace):
        raise Unsafe('noncanonical workspace or symlink redirection')
    paths = list(reversed([workspace, *workspace.parents]))
    control = workspace / 'control'
    module = control / 'ci/pilot-exact-pair'
    paths.extend([control, control / 'ci', module])
    required = {'run.py', 'type_debt.py', 'approved.json', 'runner-access.sh',
                'runner-permissions.py', 'verify.py', 'network.sh'}
    for path in paths:
        if not stat.S_ISDIR(path.lstat().st_mode):
            raise Unsafe('non-directory or symlink in control chain: ' + str(path))
    children = list(module.iterdir())
    if not required <= {p.name for p in children}:
        raise Unsafe('required control helper missing')
    paths.extend(children)
    identities = []
    for path in paths:
        info = path.lstat()
        is_dir = stat.S_ISDIR(info.st_mode)
        if not is_dir and (not stat.S_ISREG(info.st_mode) or path.parent != module):
            raise Unsafe('nonregular or redirected control file: ' + str(path))
        if is_dir and path in children:
            raise Unsafe('unexpected control subdirectory: ' + str(path))
        if info.st_uid not in trusted_uids:
            raise Unsafe('untrusted owner: ' + str(path))
        if info.st_mode & stat.S_IWOTH:
            raise Unsafe('world-writable path: ' + str(path))
        if info.st_mode & stat.S_IWGRP and not trusted_group(info.st_gid):
            raise Unsafe('untrusted group-writable path: ' + str(path))
        names = os.listxattr(path, follow_symlinks=False)
        if any('acl' in name.lower() and name not in {'system.posix_acl_access', 'system.posix_acl_default'} for name in names):
            raise Unsafe('unrecognized ACL mechanism: ' + str(path))
        for attr in ('system.posix_acl_access', 'system.posix_acl_default'):
            try:
                data = os.getxattr(path, attr, follow_symlinks=False)
            except OSError as error:
                if error.errno == errno.ENODATA:
                    continue  # Authoritative absence, not an unavailable inspector.
                raise Unsafe('ACL inspection unavailable: ' + str(path)) from None
            if attr.endswith('default') and not is_dir:
                raise Unsafe('unexpected default ACL on file')
            for tag, perms, ident in acl_entries(data):
                if not perms & 2 or tag == 16:
                    continue
                # Conservative: reject untrusted write entries even when masked out.
                if tag == 1:
                    allowed = info.st_uid in trusted_uids
                elif tag == 2:
                    allowed = ident in trusted_uids
                elif tag == 4:
                    allowed = trusted_group(info.st_gid)
                elif tag == 8:
                    allowed = trusted_group(ident)
                else:
                    allowed = False
                if not allowed:
                    raise Unsafe('untrusted ACL write entry: ' + str(path))
        identities.append([str(path), info.st_dev, info.st_ino, info.st_uid, info.st_gid,
                           None if is_dir else hashlib.sha256(path.read_bytes()).hexdigest()])
    # Only read/search modes may change during repair; content/namespace/owner may not.
    return hashlib.sha256(json.dumps(sorted(identities), separators=(',', ':')).encode()).hexdigest()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise Unsafe('workspace and explicit trusted runner UID/GID required')
        print(verify(sys.argv[1], int(sys.argv[2]), int(sys.argv[3])))
    except Exception as error:
        reason = str(error) if isinstance(error, Unsafe) else 'permission safety could not be established'
        print('RUNNER_PERMISSION_SAFETY: BLOCKED ' + reason, file=sys.stderr)
        raise SystemExit(1)
