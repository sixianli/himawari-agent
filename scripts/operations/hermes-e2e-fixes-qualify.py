#!/usr/bin/python3
"""Qualify the native-history candidate in a private view; keep the live service untouched."""
import argparse,runpy,fcntl,hashlib,json,os,pathlib,pwd,re,shutil,socket,stat,subprocess,sys,time
R=pathlib.Path('/data/hermes/himawari')
B=R/'builds/2026-09-12-e2e-fixes'
Q=R/'qualifications/2026-09-12-e2e-fixes-installation'
CANDIDATE=R/'releases/2026-09-12-e2e-fixes'
CURRENT=R/'releases/2026-09-11-control-center'
RUNTIME=CURRENT/'lib/himawari-agent'
AUTH=pathlib.Path('/etc/himawari/runtime.json')
CANDIDATE_AUTH=pathlib.Path('/etc/himawari/e2e-fixes-candidate.json')
SCRATCH=pathlib.Path('/data/himawari-r8-protected')
HERE=pathlib.Path(__file__).resolve().parent
INPUTS={'e2e-readonly-observer.py': 'a34fb86bbf078d4634106c2a9cc390267909a4a58a4d5485b5db306879c66762', 'hermes-e2e-fixes-seal.mjs': '8f24a33b0e4696da1f4a3cd89f56d205003f42d0f874ec0c27c3e22fb9dfbbc9', 'hermes-e2e-fixes-start.mjs': '18a8d1732b2cdd834f84ff9f8ffe65b85b8f42d79a3811c5738c15a05ba0130e', 'probe-protected-runtime.mjs': '8d3c6cc8270dc79d14c1fb97988f1f0dcba97572b623ca49e6cbe1233b92d4de'}
EXTRA_SOURCE_SHA='42c27ad0d395f09c1203b39685002a8238f7ad6d96cf53604e45af92a78c5744'
PROBES=[('pi-installed',['packages/runtime-pi/scripts/probe-foreground.mjs']),('composition-installed',['packages/runtime-sandbox/scripts/qualify-production.mjs','--v2']),('network-installed',['packages/runtime-sandbox/scripts/probe-authorized-network.mjs']),('boundary-installed',['packages/runtime-sandbox/scripts/probe-network-boundary.mjs']),('worker-loss-installed',['packages/runtime-sandbox/scripts/probe-linux-worker-loss.mjs']),('web-search-installed',['packages/runtime-sandbox/scripts/probe-public-search.mjs'])]

def plain(p):
 s=p.lstat();assert not p.is_symlink() and p.resolve()==p,'UNSAFE_PATH';return s

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def publish(name,value):
 p=Q/name;temp=p.with_name(p.name+'.next');temp.write_text(json.dumps(value,indent=2));temp.chmod(0o644);os.replace(temp,p)
def status(phase,passed=None):
 publish('status.json',{'phase':phase,'passed':passed,'at':time.time(),'productionServiceChanged':False,'productionDatabaseWritten':False})
 print(phase,flush=True)
def protect_tree(root,allow_links=False):
 for parent,dirs,files in os.walk(root,followlinks=False):
  for p in [pathlib.Path(parent),*(pathlib.Path(parent)/n for n in files+dirs)]:
   s=p.lstat()
   if stat.S_ISLNK(s.st_mode):
    assert allow_links and p.resolve().is_relative_to(root),'UNSAFE_SOURCE_LINK'
    os.chown(p,0,0,follow_symlinks=False);continue
   assert stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode),'UNSAFE_FILE_TYPE'
   if stat.S_ISREG(s.st_mode):assert s.st_nlink==1,'UNEXPECTED_HARDLINK'
   os.chown(p,0,998);p.chmod(0o755 if stat.S_ISDIR(s.st_mode) or s.st_mode&0o111 else 0o644)

def run_user(name,phase,args,env=None,signer_view=False):
 properties=['User='+name,'Group='+name,'NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=',
  'UMask=0077','RuntimeMaxSec=900','WorkingDirectory='+str(Q/'probe-source'),
  'TemporaryFileSystem=/data/hermes:ro,mode=0755',
  'BindPaths='+str(R)+' '+str(CANDIDATE)+':'+str(CURRENT)]
 if signer_view:
  # Expose only the real workspace directory identity. Its 0700 contents remain private.
  properties[properties.index('TemporaryFileSystem=/data/hermes:ro,mode=0755')]+=' '+str(R/'workspaces')+':ro,mode=0755'
  properties[-1]+=' '+str(R/'workspaces/default')+':'+str(R/'workspaces/default')
 if CANDIDATE_AUTH.exists():properties[-1]+=' '+str(CANDIDATE_AUTH)+':'+str(AUTH)
 cmd=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=himawari-e2e-qualify-'+phase]
 for prop in properties:cmd+=['--property='+prop]
 environment={'PATH':str(RUNTIME/'pi-tools/bin')+':/usr/bin:/bin','HOME':str(SCRATCH),'TMPDIR':str(SCRATCH),'LANG':'C.UTF-8',**(env or {})}
 cmd+=['/usr/bin/env','-i',*[k+'='+v for k,v in environment.items()],*map(str,args)]
 with (Q/'private-output'/(phase+'.stdout')).open('x') as out,(Q/'private-output'/(phase+'.stderr')).open('x') as err:
  result=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=out,stderr=err,timeout=930)
 if result.returncode:
  error=(Q/'private-output'/(phase+'.stderr')).read_text(errors='replace')
  publish('failure.json',{'phase':phase,'exitCode':result.returncode,'errorTypes':sorted(set(re.findall(r'\b(?:[A-Za-z]+Error|Error)(?=[:\[])',error))),'errorCodes':sorted(set(re.findall(r"\bcode:\s*['\"]([A-Z][A-Z0-9_]+)['\"]|\b((?:SANDBOX|SRT|IMPORT|REHEARSAL)_[A-Z0-9_]+)\b",error)))})
  raise RuntimeError('QUALIFICATION_CHILD_FAILED')
 return json.loads((Q/'private-output'/(phase+'.stdout')).read_text())

def main():
 assert sys.argv[1:]==['--qualify'] and os.geteuid()==0 and socket.gethostname()=='hermes-home'
 assert os.environ.get('INVOCATION_ID') and not os.isatty(0),'DETACHED_SYSTEMD_REQUIRED'
 assert subprocess.check_output(['findmnt','-no','TARGET','--target',str(R)],text=True).strip()=='/data'
 assert shutil.disk_usage(R).free>10*1024**3
 assert not Q.exists() and not CANDIDATE.exists() and not CANDIDATE_AUTH.exists(),'QUALIFICATION_ALREADY_EXISTS'
 assert json.loads((R/'qualifications/2026-09-11-native-history-rehearsal-v3/summary.json').read_text())['passed']
 assert json.loads((B/'status.json').read_text())['passed']
 assert subprocess.check_output(['systemctl','is-active','himawari.service'],text=True).strip()=='active'
 assert subprocess.check_output(['systemctl','show','himawari.service','-p','User','--value'],text=True).strip()=='himawari'
 assert plain(AUTH).st_uid==0 and plain(AUTH.parent).st_uid==0
 assert plain(SCRATCH).st_uid==998 and stat.S_IMODE(SCRATCH.stat().st_mode)==0o700
 assert pwd.getpwnam('himawari').pw_uid==998 and pwd.getpwnam('andy').pw_uid==1000
 original_pid=subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True).strip()
 original_identity=(plain(CURRENT).st_dev,plain(CURRENT).st_ino)
 original_auth=sha(AUTH);original_config=sha(R/'config/production.json')
 for name,digest in INPUTS.items():assert sha(HERE/name)==digest,'REVIEWED_SCRIPT_CHANGED'
 manifest=json.loads((B/'himawari-e2e-fixes-source.json').read_text())
 assert manifest['archiveSha256']=='762c50fd231ef53163e686d83d03b4810fea790c9d47df94c49c49b03ae13c2a'
 for entry in manifest['files']:assert sha(B/'source'/entry['path'])==entry['sha256'],'REVIEWED_SOURCE_CHANGED'
 extra=B/'source/test/qualification/sandbox-production-mac-probe.ts';assert sha(extra)==EXTRA_SOURCE_SHA
 os.umask(0o077);Q.mkdir(mode=0o711);Q.chmod(0o711);(Q/'private-output').mkdir(mode=0o700)
 try:
  status('copying_candidate_without_stopping_service')
  shutil.copytree(B/'prefix',CANDIDATE,symlinks=True)
  for p in (CANDIDATE/'bin').iterdir():p.write_text(p.read_text().replace(str(B/'prefix'),str(CURRENT)))
  sentinel=CANDIDATE/'protection-probe';sentinel.mkdir();(sentinel/'sentinel.txt').write_text('himawari-protection-probe\n')
  protect_tree(CANDIDATE)
  source=Q/'probe-source'
  shutil.copytree(B/'source',source,symlinks=True,ignore=shutil.ignore_patterns('node_modules','dist','.ci-output','.git'))
  shutil.copytree(B/'source/node_modules',source/'node_modules',symlinks=True,ignore=lambda p,n: {'.vite','.vite-temp'}&set(n) if pathlib.Path(p)==B/'source/node_modules' else set())
  protect_tree(source,allow_links=True)
  for name in ['.vite','.vite-temp']:
   cache=source/'node_modules'/name;cache.mkdir(mode=0o700);os.chown(cache,998,998)
  for name in INPUTS:shutil.copyfile(HERE/name,Q/name);(Q/name).chmod(0o644)
  digest_script=Q/'runtime-digest.mjs'
  digest_script.write_text('import { createRequire } from "node:module";\nconst require=createRequire('+json.dumps(str(RUNTIME/'package.json'))+');\nconst {digestSandboxRuntime}=require("@himawari-agent/platform-node");\nconsole.log(JSON.stringify({runtimeDigest:await digestSandboxRuntime('+json.dumps(str(RUNTIME))+')}));\n');digest_script.chmod(0o644)
  status('verifying_signer_access_without_exposing_workspace_contents')
  signer=run_user('andy','signer-preflight',[RUNTIME/'pi-tools/bin/node',Q/'hermes-e2e-fixes-seal.mjs','--preflight'],signer_view=True)
  workspace=plain(R/'workspaces/default')
  assert signer['passed'] and signer['signerUid']==1000 and signer['workspaceDevice']==str(workspace.st_dev) and signer['workspaceInode']==str(workspace.st_ino),'SIGNER_WORKSPACE_IDENTITY_MISMATCH'
  publish('signer-preflight.json',signer)
  status('verifying_runtime_account_and_candidate_digest')
  digest=run_user('himawari','digest',[RUNTIME/'pi-tools/bin/node',digest_script])['runtimeDigest'];assert re.fullmatch('[0-9a-f]{64}',digest)
  CANDIDATE_AUTH.write_text(json.dumps({'schemaVersion':'protected-runtime.v1','runtimeRoot':str(RUNTIME),'runtimeDigest':digest,'runtimeUid':998,'deploymentUid':1000})+'\n');CANDIDATE_AUTH.chmod(0o644)
  env={'HIMAWARI_RUNTIME_PROTECTION_FILE':str(AUTH),'HIMAWARI_LIVE_SANDBOX_PROBE':'1','HIMAWARI_PROBE_RUNTIME':str(RUNTIME),'HIMAWARI_QUALIFY_INSTALLED_RUNTIME':str(RUNTIME),'HIMAWARI_PROBE_SCRATCH':str(SCRATCH)}
  protection=run_user('himawari','protection',[RUNTIME/'pi-tools/bin/node',Q/'probe-protected-runtime.mjs',AUTH,CURRENT/'protection-probe',SCRATCH],env)
  assert protection['passed'] and protection['fullAudits']==1;publish('protected-runtime-probe.json',protection)
  seal=Q/'seal-stage';seal.mkdir(mode=0o700);os.chown(seal,1000,1000)
  for name,args in PROBES:
   status('qualifying_'+name)
   probe_env=dict(env)
   if name=='composition-installed':probe_env.pop('HIMAWARI_RUNTIME_PROTECTION_FILE',None)
   observation=run_user('himawari',name,[RUNTIME/'pi-tools/bin/node',*args],probe_env)
   target=seal/(name+'.json');shutil.copyfile(Q/'private-output'/(name+'.stdout'),target);os.chown(target,1000,1000);target.chmod(0o600)
  for entry in manifest['files']:
   target=source/entry['path']
   if target.exists():assert sha(target)==entry['sha256'],'QUALIFICATION_SOURCE_CHANGED'
  assert sha(source/'test/qualification/sandbox-production-mac-probe.ts')==EXTRA_SOURCE_SHA
  status('signing_qualified_candidate')
  result=run_user('andy','seal',[RUNTIME/'pi-tools/bin/node',Q/'hermes-e2e-fixes-seal.mjs'],signer_view=True)
  assert result['runtimeDigest']==digest
  names=[name+'.json' for name,_ in PROBES]+['installation-receipt.json','installation-receipt.sig','host-qualification-public-key.pem','pi-runner.sig','search-runner.sig']
  for name in names:shutil.copyfile(seal/name,Q/name);(Q/name).chmod(0o644)
  assert subprocess.check_output(['systemctl','is-active','himawari.service'],text=True).strip()=='active'
  assert subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True).strip()==original_pid,'LIVE_SERVICE_PID_CHANGED'
  assert (plain(CURRENT).st_dev,plain(CURRENT).st_ino)==original_identity and sha(AUTH)==original_auth and sha(R/'config/production.json')==original_config,'LIVE_INSTALLATION_CHANGED'
  publish('result.json',{'passed':True,'candidatePrefix':str(CANDIDATE),'qualifiedRuntimePath':str(RUNTIME),'runtimeDigest':digest,'receiptDigest':result['receiptDigest'],'runtimeUid':998,'productionServiceChanged':False,'productionDatabaseWritten':False,'modelCalls':0,'next':'verified backup and schema-32 installation switch still required; do not import legacy history again'})
  reader=runpy.run_path(str(Q/'e2e-readonly-observer.py'))
  report=reader['observe'](R/'state/data/product.sqlite');report['files']=reader['file_facts']()
  publish('e2e-observation.json',report)
  status('candidate_qualified_live_service_unchanged',True)
 except BaseException as error:
  status('qualification_failed_live_service_unchanged',False)
  publish('exception.json',{'exceptionType':type(error).__name__});raise

if __name__=='__main__':
 assert sys.flags.optimize==0
 fd=os.open('/run/himawari-e2e-fixes-qualification.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 assert os.fstat(fd).st_uid==0 and stat.S_ISREG(os.fstat(fd).st_mode)
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 main()
