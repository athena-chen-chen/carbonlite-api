"""Two disposable migration arms. Metadata only; no tracing and no raw logs."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('checkpoint_identity', HERE/'verify.py')
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
COMMAND = ['pnpm','exec','prisma','migrate','deploy']
MAX_BYTES = 8192
CODES = {'IDENTITY','PREPARATION','PROFILE','DATABASE','COUNTER','DIRTY_COUNTER','MIGRATION',
         'TIMEOUT','CANCELLED','CLEANUP','SERVICES','EVIDENCE','NOT_STARTED'}
HASH = re.compile(r'[0-9a-f]{64}')
PROFILE_KEYS = {'lock_sha256','migration_sha256','engines_sha256','environment_sha256','command_sha256',
                'node_binary_sha256','pnpm_binary_sha256','os_sha256','postgres_image_id',
                'prisma_version','node_version','pnpm_version','postgres_image'}
IDENTITY_KEYS = {'entry_commit','entry_tree','backend_commit','backend_tree','control_commit','control_tree'}


def require(ok):
    if not ok: raise ValueError('EVIDENCE')


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def environment(workspace, arm):
    require(arm in {'A','B'})
    home=workspace/'checkpoint-disposable/home'
    env={'PATH':os.environ['PATH'],'CI':'true','APP_ENV':'test','NODE_ENV':'test',
         'HOME':str(home),'XDG_CACHE_HOME':str(home/'cache'),'XDG_CONFIG_HOME':str(home/'config'),
         'DATABASE_URL':'postgresql://postgres:postgres@127.0.0.1:55447/carbonlite_ci_test'}
    if arm=='B': env['CHECKPOINT_DISABLE']='1'
    return env



# Fixed owner-authorized probe: no names or directory contents are exported.
HOME_PROBE = """import os,stat,sys
from pathlib import Path
p=Path(sys.argv[1])
assert os.getuid()==24001 and p.is_absolute() and p.resolve(strict=True)==p
fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 info=os.fstat(fd); current=p.lstat()
 assert stat.S_ISDIR(info.st_mode) and info.st_uid==24001 and stat.S_IMODE(info.st_mode)==0o700
 assert (current.st_dev,current.st_ino)==(info.st_dev,info.st_ino)
 assert not os.listdir(fd)
finally:os.close(fd)
print('HOME_EMPTY: VERIFIED')
"""


def inspect_home(workspace):
    require(workspace.is_absolute() and workspace.resolve(strict=True)==workspace)
    parent=workspace/'checkpoint-disposable';home=parent/'home'
    info=parent.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in {0,os.getuid()} and not info.st_mode&0o022)
    info=home.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid==24001 and stat.S_IMODE(info.st_mode)==0o700)
    require(home.resolve(strict=True)==home)
    # Normal Runner never enumerates the private directory or changes its mode.
    result=scalar_output(['sudo','-u','clpairtest','env','-i','PATH='+os.environ['PATH'],
                          sys.executable,'-I','-c',HOME_PROBE,str(home)],limit=64)
    require(result=='HOME_EMPTY: VERIFIED')


def launcher_evidence():
    return {'spawned':False,'pid':None,'start_ticks':None,'reaped':False,'wait_exit':None}


def process_start(pid):
    require(type(pid) is int and 0<pid<2**31)
    fields=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
    start=int(fields[19]);require(start>0);return start


def verified_wait(context, timeout):
    proc=context['proc'];evidence=context['evidence']
    require(proc is not None and evidence['spawned'])
    code=proc.wait(timeout=timeout)
    require(type(code) is int and -127<=code<=255)
    # The Popen child handle owns the wait; numeric PID observations never imply reaping.
    evidence['wait_exit']=code if code>=0 else 128-code
    evidence['reaped']=True
    return evidence['wait_exit']


def parse_counter(code, data):
    require(len(data)<=128 and re.fullmatch(rb'BLOCKED_EXTERNAL_PACKETS: [0-9]+\n',data) is not None)
    n=int(data.split()[-1]);require(n<2**63 and code==(0 if n==0 else 1))
    return n


def counter(workspace):
    p=subprocess.run(['bash',str(workspace/'control/ci/pilot-exact-pair/network.sh'),'check'],
                     stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15)
    return parse_counter(p.returncode,p.stdout)


def delta(before, after):
    require(type(before) is int and type(after) is int and 0<=before<=after<2**63)
    return after-before


def quiet(args, *, cwd=None, env=None, timeout=30):
    return subprocess.run(args,cwd=cwd,env=env,stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=timeout).returncode


def scalar_output(args, *, cwd=None, env=None, limit=4096):
    # Only predetermined metadata commands; arbitrary application output is never captured.
    with tempfile.TemporaryFile() as sink:
        p=subprocess.run(args,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=sink,stderr=subprocess.DEVNULL,timeout=30)
        require(p.returncode==0);sink.seek(0);data=sink.read(limit+1);require(len(data)<=limit)
    return data.decode('ascii').strip()


def uid_processes():
    data=scalar_output(['ps','-eo','uid=,pid='],limit=32768)
    found=[]
    for line in data.splitlines():
        parts=line.split();require(len(parts)==2 and all(p.isdigit() for p in parts))
        uid,pid=map(int,parts)
        if uid==24001: found.append(pid)
    return found


def cleanup_processes(context):
    # Each operation is independent: failed inspection must not prevent child wait.
    # Never interpret a missing handle as successful reaping.
    evidence=context['evidence'] if context is not None else launcher_evidence()
    killed=False;absent=False
    try:killed=quiet(['sudo','-u','clpairtest','pkill','-KILL','-u','24001']) in {0,1}
    except Exception:pass
    if context is not None and context['proc'] is not None and not evidence['reaped']:
        try:verified_wait(context,10)
        except Exception:pass
    try:absent=not uid_processes()
    except Exception:pass
    return {'processes':killed and absent,'launcher_reaped':evidence['reaped'],'services':False}


def migration(workspace, env, outcome, context):
    errors=[]
    # These structures belong to arm(), so exceptions cannot erase known results
    # or discard the original Popen handle.
    try:
        proc=subprocess.Popen(['sudo','-u','clpairtest','env','-i',*[k+'='+x for k,x in env.items()],*COMMAND],
                              cwd=workspace/'carbonlite-api',stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        context['proc']=proc;context['evidence']['spawned']=True
        try:
            require(type(proc.pid) is int and 0<proc.pid<2**31)
            context['evidence']['pid']=proc.pid
            context['evidence']['start_ticks']=process_start(proc.pid)
        except Exception:errors.append('IDENTITY')
        code=verified_wait(context,180)
        outcome.update(status='SUCCESS' if code==0 else 'FAIL',exit_status=code)
    except subprocess.TimeoutExpired:outcome.update(status='TIMEOUT',exit_status=None);errors.append('TIMEOUT')
    except (KeyboardInterrupt,Cancelled):outcome.update(status='INFRA_FAILURE',exit_status=None);errors.append('CANCELLED')
    except Exception:outcome.update(status='INFRA_FAILURE',exit_status=None);errors.append('MIGRATION')
    finally:
        for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):signal.signal(sig,signal.SIG_IGN)
        try:cleanup=cleanup_processes(context)
        except Exception:
            cleanup={'processes':False,'launcher_reaped':context['evidence']['reaped'],'services':False}
            errors.append('CLEANUP')
    # Only verified_wait can establish this field, never a cleanup fallback.
    cleanup['launcher_reaped']=context['evidence']['reaped']
    if not cleanup['processes'] or not cleanup['launcher_reaped']:errors.append('CLEANUP')
    return cleanup,errors


class Cancelled(BaseException): pass


@contextlib.contextmanager
def cancellation():
    def stop(*_):raise Cancelled()
    previous={s:signal.getsignal(s) for s in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP)}
    try:
        for s in previous:signal.signal(s,stop)
        yield
    finally:
        # Cleanup must not be interrupted by a second cancellation signal.
        for s in previous:signal.signal(s,signal.SIG_IGN)


def tree_hash(root):
    root=Path(root);require(root.is_dir() and not root.is_symlink())
    files=[]
    for p in sorted(root.rglob('*')):
        require(not p.is_symlink())
        if p.is_file():files.append([p.relative_to(root).as_posix(),sha(p)])
        else:require(p.is_dir())
    require(bool(files));return digest(files)


def container_ids():
    values=[os.environ.get(k,'') for k in ('POSTGRES_CONTAINER','POOLER_CONTAINER')]
    require(len(set(values))==2 and all(re.fullmatch(r'[0-9a-f]{64}',s) for s in values))
    return values


def database(workspace, approved):
    pg,pool=container_ids()
    for cid,image in ((pg,approved['postgres_image']),(pool,approved['pooler_image'])):
        require(scalar_output(['docker','inspect','-f','{{.Config.Image}}',cid])==image)
    sql="DO $$ BEGIN IF current_database()<>'carbonlite_ci_test' OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public') THEN RAISE EXCEPTION 'identity'; END IF; END $$;"
    require(quiet(['docker','exec',pg,'psql','-U','postgres','-d','carbonlite_ci_test','-v','ON_ERROR_STOP=1','-c',sql])==0)
    image=scalar_output(['docker','inspect','-f','{{.Image}}',pg])
    require(re.fullmatch(r'sha256:[0-9a-f]{64}',image) is not None)
    return image[7:]


def profile(workspace, approved, image):
    import shutil, platform
    api=workspace/'carbonlite-api'
    script="const{createRequire}=require('module');const r=createRequire(require.resolve('prisma/package.json'));console.log(JSON.stringify({prisma:require('prisma/package.json').version,node:process.version,engines:r.resolve('@prisma/engines/package.json')}))"
    metadata=workspace/'checkpoint-metadata'
    metadata.mkdir(mode=0o700,exist_ok=True)
    require(not metadata.is_symlink() and metadata.stat().st_uid==os.getuid() and not metadata.stat().st_mode&0o077)
    env={'PATH':os.environ['PATH'],'CI':'true','HOME':str(metadata)}
    data=json.loads(scalar_output(['node','-e',script],cwd=api,env=env))
    require(set(data)=={'prisma','node','engines'} and data['prisma']==approved['prisma_version'])
    require(re.fullmatch(r'v20\.[0-9]+\.[0-9]+',data['node']) is not None)
    engine=Path(data['engines']).resolve(strict=True)
    require(engine.is_relative_to((api/'node_modules').resolve(strict=True)))
    package=engine.parent
    require(any(p.is_file() and ('schema-engine' in p.name or p.name.endswith('.node')) for p in package.iterdir()))
    pnpm=scalar_output(['pnpm','--version'],cwd=api,env=env,limit=64);require(pnpm==approved['pnpm_version'])
    return {'prisma_version':data['prisma'],'node_version':data['node'],'pnpm_version':pnpm,
            'lock_sha256':sha(api/'pnpm-lock.yaml'),'migration_sha256':tree_hash(api/'prisma'),
            'engines_sha256':tree_hash(package),'environment_sha256':digest(environment(workspace,'A')),'command_sha256':digest(COMMAND),
            'node_binary_sha256':sha(Path(shutil.which('node')).resolve(strict=True)),
            'pnpm_binary_sha256':sha(Path(shutil.which('pnpm')).resolve(strict=True)),
            'os_sha256':digest([Path('/etc/os-release').read_text(),platform.release(),platform.machine()]),
            'postgres_image_id':image,'postgres_image':approved['postgres_image']}


def new_report(arm, identity):
    require(arm in {'A','B'})
    return {'schema':1,'arm':arm,'checkpoint_disabled':arm=='B','identity':identity,'profile':None,
            'migration':{'status':'NOT_STARTED','exit_status':None},'launcher':launcher_evidence(),
            'network':{'status':'BLOCKED','before':None,'after':None,'final':None,'denied':None,'destination_metadata':'NOT_COLLECTED'},
            'cleanup':{'processes':False,'launcher_reaped':False,'services':False},
            'identity_after':False,'errors':[],'comparison_eligible':False}


def eligibility(report):
    n=report['network'];m=report['migration']
    return (report['profile'] is not None and report['identity_after'] and all(report['cleanup'].values())
            and not report['errors'] and m=={'status':'SUCCESS','exit_status':0}
            and report['launcher']['spawned'] and report['launcher']['pid'] is not None
            and report['launcher']['start_ticks'] is not None and report['launcher']['reaped']
            and report['launcher']['wait_exit']==0
            and n['before']==0 and type(n['after']) is int and type(n['final']) is int
            and n['after']==n['final'] and n['denied']==n['final'])


def validate_report(r, approved):
    require(type(r) is dict and set(r)=={'schema','arm','checkpoint_disabled','identity','profile','migration','launcher','network','cleanup','identity_after','errors','comparison_eligible'})
    require(type(r['schema']) is int and r['schema']==1 and r['arm'] in {'A','B'})
    require(type(r['checkpoint_disabled']) is bool and r['checkpoint_disabled']==(r['arm']=='B'))
    i=r['identity'];require(type(i) is dict and set(i)==IDENTITY_KEYS)
    for value in i.values():require(type(value) is str and re.fullmatch(r'[0-9a-f]{40}',value) is not None)
    for key,expected in [('backend_commit',approved['backend']['expected_commit']),('backend_tree',approved['backend']['expected_tree']),('control_commit',approved['control_commit']),('control_tree',approved['control_tree'])]:require(i[key]==expected)
    p=r['profile']
    if p is not None:
        require(type(p) is dict and set(p)==PROFILE_KEYS)
        for key in PROFILE_KEYS-{'prisma_version','node_version','pnpm_version','postgres_image'}:require(type(p[key]) is str and HASH.fullmatch(p[key]) is not None)
        require(p['prisma_version']==approved['prisma_version'] and p['pnpm_version']==approved['pnpm_version'] and p['postgres_image']==approved['postgres_image'])
        require(type(p['node_version']) is str and re.fullmatch(r'v20\.[0-9]+\.[0-9]+',p['node_version']) is not None)
    m=r['migration'];require(type(m) is dict and set(m)=={'status','exit_status'} and m['status'] in {'NOT_STARTED','SUCCESS','FAIL','TIMEOUT','INFRA_FAILURE'})
    require(m['exit_status'] is None or type(m['exit_status']) is int and 0<=m['exit_status']<=255)
    require(m['status']!='SUCCESS' or m['exit_status']==0)
    require(m['status']!='FAIL' or type(m['exit_status']) is int and m['exit_status']>0)
    require(m['status'] not in {'NOT_STARTED','TIMEOUT','INFRA_FAILURE'} or m['exit_status'] is None)
    launcher=r['launcher']
    require(type(launcher) is dict and set(launcher)=={'spawned','pid','start_ticks','reaped','wait_exit'})
    require(type(launcher['spawned']) is bool and type(launcher['reaped']) is bool)
    require(launcher['pid'] is None or type(launcher['pid']) is int and 0<launcher['pid']<2**31)
    require(launcher['start_ticks'] is None or type(launcher['start_ticks']) is int and 0<launcher['start_ticks']<2**64)
    require(launcher['wait_exit'] is None or type(launcher['wait_exit']) is int and 0<=launcher['wait_exit']<=255)
    require(launcher['reaped']==(launcher['wait_exit'] is not None))
    require(launcher['spawned'] or launcher==launcher_evidence())
    require(m['status'] not in {'SUCCESS','FAIL','TIMEOUT'} or launcher['spawned'])
    require(m['status']!='NOT_STARTED' or not launcher['spawned'])
    require(m['status'] not in {'SUCCESS','FAIL'} or launcher['reaped'] and launcher['wait_exit']==m['exit_status'])
    if launcher['spawned'] and (launcher['pid'] is None or launcher['start_ticks'] is None):
        require('IDENTITY' in r['errors'])
    n=r['network'];require(type(n) is dict and set(n)=={'status','before','after','final','denied','destination_metadata'})
    require(n['status'] in {'PASS','BLOCKED'} and n['destination_metadata']=='NOT_COLLECTED')
    for k in ('before','after','final','denied'):require(n[k] is None or type(n[k]) is int and 0<=n[k]<2**63)
    if n['before'] is not None and n['after'] is not None:delta(n['before'],n['after'])
    if n['after'] is not None and n['final'] is not None:delta(n['after'],n['final'])
    if n['before'] is not None and n['final'] is not None:require(n['denied']==delta(n['before'],n['final']))
    require(n['status']!='PASS' or n['before']==n['after']==n['final']==n['denied']==0)
    require(type(r['cleanup']) is dict and set(r['cleanup'])=={'processes','launcher_reaped','services'} and all(type(x) is bool for x in r['cleanup'].values()))
    require(r['cleanup']['launcher_reaped']==launcher['reaped'])
    require(type(r['identity_after']) is bool and type(r['comparison_eligible']) is bool)
    require(type(r['errors']) is list and len(r['errors'])<=16 and all(type(x) is str and x in CODES for x in r['errors']))
    require(r['comparison_eligible']==bool(eligibility(r)))
    require(len(json.dumps(r).encode())<=MAX_BYTES)


def result_path(workspace, arm):
    require(arm in {'A','B'})
    root=workspace/'checkpoint-results';root.mkdir(mode=0o700,exist_ok=True)
    require(not root.is_symlink() and root.stat().st_uid==os.getuid() and not root.stat().st_mode&0o077)
    return root/('arm-'+arm+'.json')


def save(path, r, approved):
    validate_report(r,approved)
    if path.exists():require(not path.is_symlink() and stat.S_ISREG(path.lstat().st_mode) and path.stat().st_uid==os.getuid() and not path.stat().st_mode&0o077)
    fd,name=tempfile.mkstemp(dir=path.parent,prefix='.bounded-')
    try:
        with os.fdopen(fd,'w') as f:json.dump(r,f,sort_keys=True)
        os.replace(name,path)
    finally:
        Path(name).unlink(missing_ok=True)


def load(path, approved):
    require(not path.is_symlink() and stat.S_ISREG(path.lstat().st_mode) and path.stat().st_size<=MAX_BYTES)
    def unique(pairs):
        d={}
        for k,x in pairs:require(k not in d);d[k]=x
        return d
    r=json.loads(path.read_bytes(),object_pairs_hook=unique);validate_report(r,approved);return r


def arm(workspace, name, approved):
    identity=v.verify(workspace,os.environ,approved);r=new_report(name,identity)
    path=result_path(workspace,name);require(not path.exists())
    enabled=False;proc_cleanup=False;stage='PREPARATION'
    launch={'proc':None,'evidence':r['launcher']}
    try:
        with cancellation():
            v.audit_permissions(workspace)
            require(not uid_processes())
            inspect_home(workspace)
            stage='DATABASE';image=database(workspace,approved)
            stage='PROFILE';r['profile']=profile(workspace,approved,image)
            v.verify(workspace,os.environ,approved)
            stage='COUNTER';require(quiet(['bash',str(workspace/'control/ci/pilot-exact-pair/network.sh'),'enable'])==0);enabled=True
            r['network']['before']=counter(workspace)
            if r['network']['before']!=0:raise ValueError('DIRTY_COUNTER')
            stage='MIGRATION'
            r['cleanup'],migration_errors=migration(workspace,environment(workspace,name),r['migration'],launch)
            r['errors'].extend(migration_errors);proc_cleanup=True
            stage='COUNTER';r['network']['after']=counter(workspace)
            stage='PROFILE';require(profile(workspace,approved,image)==r['profile'])
    except (KeyboardInterrupt,Cancelled):r['errors'].append('CANCELLED')
    except Exception:r['errors'].append(stage if stage in CODES else 'PREPARATION')
    finally:
        for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):signal.signal(sig,signal.SIG_IGN)
        if not proc_cleanup:
            try:r['cleanup']=cleanup_processes(launch)
            except Exception:r['errors'].append('CLEANUP')
        r['cleanup']['launcher_reaped']=r['launcher']['reaped']
        if not r['cleanup']['processes'] or (r['launcher']['spawned'] and not r['launcher']['reaped']):r['errors'].append('CLEANUP')
        if enabled:
            try:
                r['network']['final']=counter(workspace)
                r['network']['denied']=delta(r['network']['before'],r['network']['final'])
                r['network']['status']='PASS' if r['network']['before']==r['network']['after']==r['network']['final']==0 else 'BLOCKED'
            except Exception:r['errors'].append('COUNTER')
        try:v.verify(workspace,os.environ,approved);r['identity_after']=True
        except Exception:r['errors'].append('IDENTITY')
        r['comparison_eligible']=bool(eligibility(r));save(path,r,approved)
    return 0 if not r['errors'] and r['migration']['status']=='SUCCESS' and r['network']['status']=='PASS' and r['cleanup']['processes'] and r['cleanup']['launcher_reaped'] else 1


def finalize(workspace, name, approved):
    identity=v.verify(workspace,os.environ,approved);path=result_path(workspace,name)
    if path.exists():r=load(path,approved);require(r['identity']==identity)
    else:r=new_report(name,identity);r['errors'].append('NOT_STARTED')
    stage='CLEANUP'
    try:
        checked=cleanup_processes(None)
        r['cleanup']['processes']=checked['processes']
        # Separate finalization has no Popen child handle and cannot establish reaping.
        r['cleanup']['launcher_reaped']=r['launcher']['reaped']
        alive=set(scalar_output(['docker','ps','-aq','--no-trunc'],limit=32768).splitlines())
        require(all(re.fullmatch(r'[0-9a-f]{64}',x) for x in alive))
        r['cleanup']['services']=not any(x in alive for x in container_ids())
        if not r['cleanup']['services']:r['errors'].append('SERVICES')
        if r['network']['before'] is not None:
            stage='COUNTER'
            final=counter(workspace);delta(r['network']['final'],final)
            r['network']['final']=final;r['network']['denied']=delta(r['network']['before'],final)
            r['network']['status']='PASS' if r['network']['before']==r['network']['after']==final==0 else 'BLOCKED'
    except Exception:r['errors'].append(stage)
    r['identity_after']=True;r['comparison_eligible']=bool(eligibility(r));save(path,r,approved)
    return 0 if r['comparison_eligible'] and r['network']['status']=='PASS' else 1


def compare(a, b, approved):
    validate_report(a,approved);validate_report(b,approved)
    require(a['arm']=='A' and b['arm']=='B')
    complete=(a['comparison_eligible'] and b['comparison_eligible'] and a['identity']==b['identity'] and a['profile']==b['profile'])
    if not complete:outcome='INCONCLUSIVE'
    elif a['network']['denied'] and not b['network']['denied']:outcome='SUPPORTS_SETTING_DEPENDENCE'
    elif a['network']['denied'] and b['network']['denied']:outcome='OPT_OUT_INSUFFICIENT'
    elif not a['network']['denied'] and not b['network']['denied']:outcome='NOT_REPRODUCED'
    else:outcome='B_ONLY_TRAFFIC_INCONCLUSIVE';complete=False
    return {'comparison':'COMPLETE' if complete else 'INCONCLUSIVE','outcome':outcome,
            'network_security':'PASS' if complete and a['network']['status']==b['network']['status']=='PASS' else 'BLOCKED',
            'historical_attribution':False,'process_attribution':False}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['arm','finalize','export','compare']);parser.add_argument('value')
    args=parser.parse_args();workspace=Path(os.environ['GITHUB_WORKSPACE'])
    approved=json.loads(v.regular(workspace/'entry',v.PREFIX+'approved.json'))
    expected_identity=v.verify(workspace,os.environ,approved)
    if args.mode=='compare':
        root=workspace/'downloaded'
        a=load(root/'checkpoint-A/arm-A.json',approved);b=load(root/'checkpoint-B/arm-B.json',approved)
        require(a['identity']==b['identity']==expected_identity)
        result=compare(a,b,approved);print(json.dumps(result,sort_keys=True))
        return 0 if result['comparison']=='COMPLETE' and result['network_security']=='PASS' else 1
    require(args.value in {'A','B'})
    if args.mode=='arm':return arm(workspace,args.value,approved)
    if args.mode=='finalize':return finalize(workspace,args.value,approved)
    require(load(result_path(workspace,args.value),approved)['identity']==expected_identity);print('CHECKPOINT_AB_ARTIFACT: VALID');return 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print('CHECKPOINT_AB: BLOCKED');raise SystemExit(1)
