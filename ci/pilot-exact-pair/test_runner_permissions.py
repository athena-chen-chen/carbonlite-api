"""Disposable Linux-only regressions. No database, providers or live files."""
import importlib.util
import os
from pathlib import Path
import pwd
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REVIEWED = Path(sys.argv.pop(1)).resolve()
MODULE = REVIEWED / 'ci/pilot-exact-pair'
GUARD_SPEC = importlib.util.spec_from_file_location('permission_guard', MODULE / 'runner-permissions.py')
guard = importlib.util.module_from_spec(GUARD_SPEC)
GUARD_SPEC.loader.exec_module(guard)
REQUIRED = ['run.py', 'type_debt.py', 'approved.json', 'runner-access.sh',
            'runner-permissions.py', 'verify.py', 'network.sh']


def drop_user(name='clpairtest'):
    p = pwd.getpwnam(name)
    os.initgroups(p.pw_name, p.pw_gid)
    os.setgid(p.pw_gid)
    os.setuid(p.pw_uid)


def acl(named_tag=2, named_id=24003, mask=6):
    entries = [(1, 6, 0xffffffff), (named_tag, 6, named_id),
               (4, 0, 0xffffffff), (16, mask, 0xffffffff), (32, 0, 0xffffffff)]
    entries.sort(key=lambda x: (x[0], x[2]))
    return struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)


class PermissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='runner-access-fixture.', dir='/')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'home/runner/work/api/api'
        self.control = self.workspace / 'control/ci/pilot-exact-pair'
        self.control.mkdir(parents=True)
        for name in REQUIRED:
            shutil.copyfile(MODULE / name, self.control / name)
        self.app = self.workspace / 'carbonlite-api'
        self.app.mkdir()
        os.chown(self.app, 24001, 24001)
        for p in self.root.rglob('*'):
            p.chmod(0o700 if p.is_dir() else 0o600)
        self.root.chmod(0o700)
        self.env = {'PATH': os.environ['PATH'], 'PYTHONDONTWRITEBYTECODE': '1'}

    def target(self, *command, user='clpairtest'):
        return subprocess.run(command, preexec_fn=lambda: drop_user(user), stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def helper(self):
        return subprocess.run(['bash', str(MODULE / 'runner-access.sh'), str(self.workspace), '24002', '24002'],
                              env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def safe(self):
        result = self.helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode() + result.stdout.decode())
        self.assertIn(b'RUNNER_ACCESS: PASS', result.stdout)
        return result

    def blocked(self, reason):
        modes = {str(p): stat.S_IMODE(p.lstat().st_mode) for p in [self.root, *self.root.rglob('*')]}
        result = self.helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b'RUNNER_ACCESS: PASS', result.stdout)
        self.assertIn(reason.encode(), result.stderr.decode(errors='replace').encode() + result.stdout)
        self.assertEqual(modes, {str(p): stat.S_IMODE(p.lstat().st_mode) for p in [self.root, *self.root.rglob('*')]})

    def test_denial_and_actual_uid_read_with_no_control_writes(self):
        before = {n: (self.control / n).read_bytes() for n in REQUIRED}
        denied = self.target('cat', str(self.control / 'run.py'))
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn(b'Permission denied', denied.stderr)
        result = self.safe()
        self.assertIn(b'MISSING_SEARCH', result.stdout)
        self.assertIn(b'MISSING_READ', result.stdout)
        self.assertEqual(self.target('id', '-u').stdout.strip(), b'24001')
        for name in ['run.py', 'type_debt.py', 'approved.json']:
            self.assertEqual(self.target('cat', str(self.control / name)).returncode, 0)
            self.assertEqual(self.target('test', '-w', str(self.control / name)).returncode, 1)
        self.assertEqual(before, {n: (self.control / n).read_bytes() for n in REQUIRED})
        self.assertEqual(self.target('test', '-w', str(self.app)).returncode, 0)
        self.assertEqual(self.target('test', '-w', str(self.workspace)).returncode, 1)

    def test_idempotent_safe_paths(self):
        self.safe()
        before = {str(p): p.stat().st_mode for p in self.root.rglob('*')}
        result = self.safe()
        self.assertNotIn(b'MISSING_', result.stdout)
        self.assertEqual(before, {str(p): p.stat().st_mode for p in self.root.rglob('*')})

    def test_world_writable_directory_0777(self):
        self.control.chmod(0o777)
        self.blocked('world-writable')

    def test_world_writable_precedence_0757(self):
        self.safe()
        os.chown(self.control, 0, 24001)
        self.control.chmod(0o757)
        self.assertEqual(self.target('test', '-x', str(self.control)).returncode, 0)
        self.assertEqual(self.target('test', '-w', str(self.control)).returncode, 1)
        self.blocked('world-writable')

    def test_untrusted_group_write(self):
        os.chown(self.control, 0, 24003)
        self.control.chmod(0o770)
        self.blocked('untrusted group-writable')

    def test_world_writable_script(self):
        (self.control / 'run.py').chmod(0o606)
        self.blocked('world-writable')

    def test_untrusted_writable_ancestor(self):
        parent = self.root / 'home/runner'
        parent.chmod(0o702)
        self.blocked('world-writable')

    def test_untrusted_owner_even_if_currently_read_only(self):
        os.chown(self.control / 'run.py', 24003, 24003)
        (self.control / 'run.py').chmod(0o444)
        self.blocked('untrusted owner')

    def test_required_file_symlink(self):
        file = self.control / 'type_debt.py'
        file.rename(self.control / 'saved.py')
        file.symlink_to('saved.py')
        self.blocked('nonregular or redirected')

    def test_directory_symlink(self):
        parent = self.workspace / 'control/ci'
        parent.rename(self.workspace / 'control/real-ci')
        parent.symlink_to('real-ci')
        self.blocked('symlink')

    def test_missing_helper(self):
        (self.control / 'type_debt.py').unlink()
        self.blocked('required control helper missing')

    def test_safe_approved_runner_owner(self):
        for p in [self.root, *self.root.rglob('*')]:
            if p != self.app:
                os.chown(p, 24002, 24002)
        self.safe()

    def test_safe_read_only_control_files(self):
        for file in self.control.iterdir():
            file.chmod(0o444)
        self.safe()

    def test_trusted_group_with_untrusted_member_rejected(self):
        subprocess.run(['usermod', '-a', '-G', 'runnerfixture', 'untrustedfixture'], check=True)
        self.addCleanup(lambda: subprocess.run(['usermod', '-G', '', 'untrustedfixture'], check=True))
        os.chown(self.control, 0, 24002)
        self.control.chmod(0o770)
        self.blocked('untrusted group-writable')

    def test_trusted_runner_group_write(self):
        os.chown(self.control, 0, 24002)
        self.control.chmod(0o770)
        self.safe()
        self.assertEqual(stat.S_IMODE(self.control.stat().st_mode), 0o771)
        self.assertEqual(self.target('test', '-w', str(self.control)).returncode, 1)

    def test_owning_group_read_precedence_repair(self):
        file = self.control / 'approved.json'
        os.chown(file, 24002, 24001)
        file.chmod(0o600)
        self.safe()
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o640)

    def test_acl_named_user_write(self):
        self.safe()
        file = self.control / 'run.py'
        os.chown(file, 0, 24002)
        os.setxattr(file, 'system.posix_acl_access', acl())
        self.assertEqual(os.getxattr(file, 'system.posix_acl_access'), acl())
        self.assertEqual(self.target(sys.executable, '-c', 'import os,sys; fd=os.open(sys.argv[1],os.O_WRONLY); os.close(fd)', str(file), user='untrustedfixture').returncode, 0)
        self.blocked('untrusted ACL write entry')

    def test_acl_named_group_write(self):
        self.safe()
        file = self.control / 'run.py'
        os.chown(file, 0, 24002)
        os.setxattr(file, 'system.posix_acl_access', acl(8))
        self.assertEqual(self.target(sys.executable, '-c', 'import os,sys; fd=os.open(sys.argv[1],os.O_WRONLY); os.close(fd)', str(file), user='untrustedfixture').returncode, 0)
        self.blocked('untrusted ACL write entry')

    def test_masked_acl_write_also_rejected(self):
        file = self.control / 'run.py'
        os.setxattr(file, 'system.posix_acl_access', acl(mask=4))
        self.blocked('untrusted ACL write entry')

    def test_default_acl_write_rejected(self):
        os.chown(self.control, 0, 24002)
        os.setxattr(self.control, 'system.posix_acl_default', acl())
        self.blocked('untrusted ACL write entry')

    def test_trusted_acl_write_is_approved(self):
        file = self.control / 'run.py'
        os.chown(file, 0, 24002)
        os.setxattr(file, 'system.posix_acl_access', acl(named_id=24002))
        self.safe()

    def test_unknown_acl_mechanism_rejected(self):
        os.setxattr(self.control, 'user.unrecognized_acl', b'synthetic')
        self.blocked('unrecognized ACL mechanism')

    def test_acl_inspection_failure_closed(self):
        with patch.object(guard.os, 'getxattr', side_effect=PermissionError()):
            with self.assertRaises(guard.Unsafe):
                guard.verify(str(self.workspace), 24002, 24002)

    def test_invalid_acl_encoding_rejected(self):
        for value in [b'', b'\x03\0\0\0', struct.pack('<IHHI', 2, 999, 7, 0xffffffff)]:
            with self.assertRaises(guard.Unsafe): guard.acl_entries(value)

    def test_runner_identity_cannot_be_test_user(self):
        with self.assertRaises(guard.Unsafe): guard.verify(str(self.workspace), 24001, 24001)


if __name__ == '__main__':
    if os.geteuid() != 0 or os.environ.get('RUNNER_ACCESS_DISPOSABLE_FIXTURE') != 'synthetic-only':
        raise SystemExit('Disposable root Linux fixture required')
    for uid, name in [(24001, 'clpairtest'), (24002, 'runnerfixture'), (24003, 'untrustedfixture')]:
        subprocess.run(['useradd', '--uid', str(uid), '--user-group', '--no-create-home', name], check=True)
    # The cached image has Python but not runuser. This fixture-only launcher
    # performs real initgroups/setgid/setuid, then execs the requested command.
    with tempfile.TemporaryDirectory(prefix='runner-fixture-tools.', dir='/') as directory:
        tools = Path(directory)
        tools.chmod(0o755)
        launcher = tools / 'runuser'
        launcher.write_text('#!/usr/bin/python3\nimport os,pwd,sys\nassert sys.argv[1:4] == ["-u","clpairtest","--"]\np=pwd.getpwnam("clpairtest")\nos.initgroups(p.pw_name,p.pw_gid)\nos.setgid(p.pw_gid)\nos.setuid(p.pw_uid)\nos.execvp(sys.argv[4],sys.argv[4:])\n')
        launcher.chmod(0o755)
        os.environ['PATH'] = str(tools) + ':' + os.environ['PATH']
        unittest.main()
