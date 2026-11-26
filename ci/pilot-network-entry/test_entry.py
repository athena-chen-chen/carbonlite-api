"""Synthetic identity fixtures only: no commits, network or Linux runtime claims."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('entry_verify', HERE / 'verify.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class EntryGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name)
        self.env = dict(GITHUB_REPOSITORY='athena-chen-chen/carbonlite-api',
                        GITHUB_EVENT_NAME='workflow_dispatch',
                        GITHUB_REF='refs/heads/ci/pilot-network-attribution-entry',
                        ENTRY_SHA='1'*40, ENTRY_TREE='2'*40, DIAGNOSTIC_SHA='3'*40,
                        DIAGNOSTIC_TREE='4'*40, INVOKING_WORKFLOW_SHA='1'*40, GITHUB_SHA='1'*40)
        self.a = dict(repository=self.env['GITHUB_REPOSITORY'], entry_branch='ci/pilot-network-attribution-entry',
                      baseline='5'*40, entry_files=['entry.txt', v.INDEX],
                      source_commit='3'*40, source_tree='4'*40)
        self.data = {'entry': {'entry.txt': b'entry'},
                     'control': {'diagnostic.txt': b'reviewed source'},
                     'carbonlite-api': {'backend.txt': b'backend'}}
        self.a['source_files'] = {'diagnostic.txt': v.digest(b'reviewed source')}
        self.a['backend'] = dict(repository=self.a['repository'], baseline='6'*40,
                                 expected_commit='7'*40, expected_tree='8'*40,
                                 files={'backend.txt': v.digest(b'backend')})
        old = {f'old/{i}.txt': b'old' for i in range(15)}
        self.data['control'].update(old)
        old_index = ''.join(f'{v.digest(b)}  {n}\n' for n,b in old.items()).encode()
        self.data['control']['SHA256SUMS.txt'] = old_index
        self.a['exact_pair_index_sha256'] = v.digest(old_index)
        index = f'{v.digest(b"entry")}  entry.txt\n'.encode()
        self.data['entry'][v.INDEX] = index
        self.env['ENTRY_INDEX_SHA256'] = v.digest(index)
        for directory, files in self.data.items():
            for name, data in files.items():
                p = self.ws/directory/name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
        self.overrides = {}
        self.mock = patch.object(v, 'git', side_effect=self.git)
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def git(self, root, *args):
        key = (root.name, args)
        if key in self.overrides:
            return self.overrides[key]
        kind = root.name
        pins = {'entry': ('1'*40,'2'*40,'5'*40,self.a['entry_files']),
                'control': ('3'*40,'4'*40,'5'*40,self.a['source_files']),
                'carbonlite-api': ('7'*40,'8'*40,'6'*40,self.a['backend']['files'])}
        sha, tree, base, files = pins[kind]
        if args == ('remote','get-url','origin'): return 'https://github.com/'+self.a['repository']+'.git'
        if args == ('rev-parse','HEAD'): return sha
        if args == ('rev-parse','HEAD^{tree}'): return tree
        if args[0] == 'merge-base': return base
        if args[0] == 'diff': return '\n'.join(files)
        if args[0] == 'status': return ''
        if args[0] == 'ls-tree': return '100644 blob '+('9'*40)+'\t'+args[-1]
        raise AssertionError('Unexpected Git invocation')

    def check(self): return v.verify(self.ws, self.env, self.a)
    def test_valid_pair(self):
        self.assertEqual(self.check()['backend_commit'], '7'*40)
    def test_missing_inputs(self):
        for key in ['ENTRY_SHA','ENTRY_TREE','ENTRY_INDEX_SHA256','DIAGNOSTIC_SHA','DIAGNOSTIC_TREE']:
            with self.subTest(key=key), patch.dict(self.env, {key:''}):
                with self.assertRaises(ValueError): self.check()
    def test_wrong_context(self):
        for key,value in [('GITHUB_REPOSITORY','other/repo'),('GITHUB_EVENT_NAME','push'),
                          ('GITHUB_REF','refs/heads/main'),('INVOKING_WORKFLOW_SHA','9'*40),('GITHUB_SHA','9'*40)]:
            with self.subTest(key=key), patch.dict(self.env,{key:value}):
                with self.assertRaises(ValueError): self.check()
    def test_branch_ref_not_commit(self):
        self.env['DIAGNOSTIC_SHA']='ci/pilot-network-attribution'
        with self.assertRaises(ValueError): self.check()
    def test_same_entry_source_rejected(self):
        self.env['DIAGNOSTIC_SHA']=self.env['ENTRY_SHA']
        with self.assertRaises(ValueError): self.check()
    def test_different_source_commit_rejected_before_git(self):
        self.env['DIAGNOSTIC_SHA']='a'*40
        with self.assertRaises(ValueError): self.check()
        self.assertFalse(v.git.called)
    def test_different_source_tree_rejected_before_git(self):
        self.env['DIAGNOSTIC_TREE']='b'*40
        with self.assertRaises(ValueError): self.check()
        self.assertFalse(v.git.called)
    def test_missing_source_pin_rejected_before_git(self):
        for key in ('source_commit','source_tree'):
            with self.subTest(key=key):
                saved=self.a.pop(key)
                with self.assertRaises(ValueError): self.check()
                self.a[key]=saved
        self.assertFalse(v.git.called)
    def test_immutable_D6_binding_accepted_with_synthetic_checkout_metadata(self):
        source='f1be1028be46243efc40068cbd160def82cee92a'
        tree='4ad3dcc936cadb4f4325a95274ecbc782d67e518'
        self.a.update(source_commit=source,source_tree=tree)
        self.env.update(DIAGNOSTIC_SHA=source,DIAGNOSTIC_TREE=tree)
        self.overrides[('control',('rev-parse','HEAD'))]=source
        self.overrides[('control',('rev-parse','HEAD^{tree}'))]=tree
        result=self.check()
        self.assertEqual(result['diagnostic_commit'],source)
        self.assertEqual(result['diagnostic_tree'],tree)
    def test_superseded_D5_rejected_even_if_checkout_metadata_matches_old_D5(self):
        old='835d44eeb21870171373c446b40833395888f4ed'
        old_tree='eee5affc5ba59d69cb1f3ee75b1f06d91913dca8'
        self.a.update(source_commit='f1be1028be46243efc40068cbd160def82cee92a',
                      source_tree='4ad3dcc936cadb4f4325a95274ecbc782d67e518')
        self.env.update(DIAGNOSTIC_SHA=old,DIAGNOSTIC_TREE=old_tree)
        self.overrides[('control',('rev-parse','HEAD'))]=old
        self.overrides[('control',('rev-parse','HEAD^{tree}'))]=old_tree
        with self.assertRaises(ValueError):self.check()
        self.assertFalse(v.git.called)
    def test_D6_commit_with_superseded_D5_tree_rejected_before_git(self):
        self.a.update(source_commit='f1be1028be46243efc40068cbd160def82cee92a',
                      source_tree='4ad3dcc936cadb4f4325a95274ecbc782d67e518')
        self.env.update(DIAGNOSTIC_SHA=self.a['source_commit'],
                        DIAGNOSTIC_TREE='eee5affc5ba59d69cb1f3ee75b1f06d91913dca8')
        with self.assertRaises(ValueError):self.check()
        self.assertFalse(v.git.called)
    def test_git_identity_mismatches(self):
        for directory in self.data:
            for args, value in [(('rev-parse','HEAD'),'a'*40),(('rev-parse','HEAD^{tree}'),'b'*40),
                                (('remote','get-url','origin'),'https://github.com/other/repo')]:
                with self.subTest(directory=directory,args=args):
                    self.overrides[(directory,args)]=value
                    with self.assertRaises(ValueError): self.check()
                    self.overrides.clear()
    def test_no_ancestry(self):
        self.overrides[('control',('merge-base','5'*40,'3'*40))]='0'*40
        with self.assertRaises(ValueError): self.check()
    def test_extra_changed_file(self):
        self.overrides[('control',('diff','--no-renames','--name-only','5'*40,'3'*40))]='diagnostic.txt\nunreviewed.py'
        with self.assertRaises(ValueError): self.check()
    def test_dirty_source(self):
        self.overrides[('control',('status','--porcelain','--untracked-files=all'))]='?? unreviewed.py'
        with self.assertRaises(ValueError): self.check()
    def test_source_tamper(self):
        (self.ws/'control/diagnostic.txt').write_text('tampered')
        with self.assertRaises(ValueError): self.check()
    def test_entry_tamper(self):
        (self.ws/'entry/entry.txt').write_text('tampered')
        with self.assertRaises(ValueError): self.check()
    def test_backend_tamper(self):
        (self.ws/'carbonlite-api/backend.txt').write_text('tampered')
        with self.assertRaises(ValueError): self.check()
    def test_old_exact_pair_tamper(self):
        (self.ws/'control/old/0.txt').write_text('tampered')
        with self.assertRaises(ValueError): self.check()
    def test_index_tamper(self):
        self.env['ENTRY_INDEX_SHA256']='0'*64
        with self.assertRaises(ValueError): self.check()
    def test_source_symlink(self):
        p=self.ws/'control/diagnostic.txt'; p.unlink();p.symlink_to(self.ws/'entry/entry.txt')
        with self.assertRaises(ValueError): self.check()
    def test_parent_symlink(self):
        p=self.ws/'control/old';p.rename(self.ws/'hidden');p.symlink_to(self.ws/'hidden',target_is_directory=True)
        with self.assertRaises(ValueError): self.check()
    def test_git_symlink_mode(self):
        self.overrides[('control',('ls-tree','HEAD','--','diagnostic.txt'))]='120000 blob '+('0'*40)
        with self.assertRaises(ValueError): self.check()
    def test_index_parser_rejects_unsafe(self):
        for data in [b'',b'secret',('0'*64+'  ../escape\n').encode(),('0'*64+'  /absolute\n').encode(),
                     (('0'*64+'  same\n')*2).encode(),b'\xff']:
            with self.subTest(data=data), self.assertRaises((ValueError,UnicodeError)): v.index_files(data)


class Structure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root=HERE.parents[1]
        cls.yaml=(cls.root/'.github/workflows/nightly-e2e.yml').read_text()
        cls.a=json.loads((HERE/'approved.json').read_text())
    def test_shell_guard_runtime(self):
        guard=self.yaml.split('        run: |\n',1)[1].split('      - name:',1)[0]
        guard='\n'.join(line[10:] for line in guard.splitlines())
        env={**os.environ, 'GITHUB_REPOSITORY':self.a['repository'],
             'GITHUB_EVENT_NAME':'workflow_dispatch',
             'GITHUB_REF':'refs/heads/'+self.a['entry_branch'],
             'ENTRY_SHA':'1'*40,'ENTRY_TREE':'2'*40,'DIAGNOSTIC_SHA':self.a['source_commit'],
             'DIAGNOSTIC_TREE':self.a['source_tree'],'ENTRY_INDEX_SHA256':'5'*64,
             'INVOKING_WORKFLOW_SHA':'1'*40,'GITHUB_SHA':'1'*40}
        def run(values):
            return subprocess.run(['bash','-c',guard], env=values,
                                  stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode
        self.assertEqual(run(env),0)
        for key,value in [('GITHUB_REF','refs/heads/main'),('GITHUB_EVENT_NAME','push'),
                          ('ENTRY_SHA','bad'),('DIAGNOSTIC_SHA','not-a-commit'),
                          ('ENTRY_TREE',''),('DIAGNOSTIC_TREE','bad'),('ENTRY_INDEX_SHA256',''),
                          ('GITHUB_SHA','9'*40),('GITHUB_REPOSITORY','other/repo'),
                          ('DIAGNOSTIC_SHA','a'*40),('DIAGNOSTIC_TREE','b'*40),
                          ('DIAGNOSTIC_SHA','835d44eeb21870171373c446b40833395888f4ed'),
                          ('DIAGNOSTIC_TREE','eee5affc5ba59d69cb1f3ee75b1f06d91913dca8')]:
            with self.subTest(key=key):self.assertNotEqual(run({**env,key:value}),0)
    def test_manifest_exact_six(self):
        actual={str(p.relative_to(self.root)) for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(actual,set(self.a['entry_files']))
    def test_manual_only(self):
        self.assertIn('workflow_dispatch:',self.yaml)
        for forbidden in ['\n  push:', '\n  pull_request:', '\n  schedule:', 'workflow_run:', 'workflow_call:', 'repository_dispatch:', 'secrets.']:
            self.assertNotIn(forbidden,self.yaml)
    def test_readonly_checkouts(self):
        self.assertEqual(self.yaml.count('persist-credentials: false'),3)
        self.assertEqual(self.yaml.count('fetch-depth: 0'),3)
        self.assertIn('contents: read',self.yaml)
        for p in ['path: entry','path: control','path: carbonlite-api']: self.assertIn(p,self.yaml)
    def test_no_full_suite(self):
        for token in ['vitest','test:e2e','test:unit','pair-exact-pair/run.py','pilot-exact-pair/run.py']:
            self.assertNotIn(token,self.yaml)
    def test_diagnostic_only_and_security(self):
        for token in ['run.py prepare','run.py experiment','run.py counter-check','run.py export-check',
                      'network.sh enable','runner-access.sh','--uid 24001','retention-days: 7']:
            self.assertIn(token,self.yaml)
        self.assertNotIn('CHECKPOINT_DISABLE',self.yaml) # reviewed driver alone applies B's environment
    def test_identity_precedes_dependencies(self):
        self.assertLess(self.yaml.index('id: identity'),self.yaml.index('name: Set up pnpm'))
        self.assertLess(self.yaml.index('id: identity'),self.yaml.index('install --frozen-lockfile'))
        self.assertIn("steps.final_identity.outcome == 'success'",self.yaml)
    def test_pins_and_source_index(self):
        self.assertEqual(self.a['source_files']['ci/pilot-network-diagnostic/SHA256SUMS.txt'],
                         '629c2a7f2de19f94730c0410abc4d59ba818b907025ce124264406d1cba5ff5f')
        self.assertEqual(len(self.a['source_files']),7)
        self.assertEqual(self.a['source_commit'],'f1be1028be46243efc40068cbd160def82cee92a')
        self.assertEqual(self.a['source_tree'],'4ad3dcc936cadb4f4325a95274ecbc782d67e518')
        self.assertIn('ref: '+self.a['source_commit'],self.yaml)
        self.assertNotIn('ref: ${{ inputs.diagnostic_sha }}',self.yaml)
        self.assertEqual(self.a['backend']['expected_commit'],'e424c567d43c0086e0dc01b86e48cb648c114078')
        self.assertEqual(len(self.a['backend']['files']),8)


if __name__=='__main__': unittest.main()
