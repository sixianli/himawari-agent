#!/usr/bin/python3
"""Qualify the provider-independent harness lifecycle candidate in a private view; keep the live service untouched."""
import runpy,fcntl,hashlib,json,os,pathlib,pwd,re,shutil,socket,stat,subprocess,sys,time
R=pathlib.Path('/data/hermes/himawari')
B=R/'builds/2026-09-13-search-time'
Q=R/'qualifications/2026-09-13-search-time-installation'
CANDIDATE=R/'releases/2026-09-13-search-time'
CURRENT=R/'releases/2026-09-11-control-center'
RUNTIME=CURRENT/'lib/himawari-agent'
AUTH=pathlib.Path('/etc/himawari/runtime.json')
CANDIDATE_AUTH=pathlib.Path('/etc/himawari/search-time-candidate.json')
SCRATCH=pathlib.Path('/data/himawari-r8-protected')
HERE=pathlib.Path(__file__).resolve().parent
INPUTS={'hermes-search-time-observer.py': '203eba47bbd4e11f2d694d842743d2ee34c2e1f0239427d056a534148f67bc9e', 'hermes-search-time-seal.mjs': 'c06cf470044f851331660d730e3a0fe9c0306b2ca19de7dceec69ca7ef84fb06', 'hermes-search-time-start.mjs': '32abd1350081c14e6a9937dc293aa9a0359c81646743f534d8b2e3f59581c817', 'probe-protected-runtime.mjs': '8d3c6cc8270dc79d14c1fb97988f1f0dcba97572b623ca49e6cbe1233b92d4de', 'hermes-harness-web-probe.mjs': 'f1bac69509ce6e06460978a603412ef6b2b7376c89021413557383ac2c099b5b'}
EXTRA_SOURCE_SHA='42c27ad0d395f09c1203b39685002a8238f7ad6d96cf53604e45af92a78c5744'
PROBES=[('pi-installed',['packages/runtime-pi/scripts/probe-foreground.mjs']),('composition-installed',['packages/runtime-sandbox/scripts/qualify-production.mjs','--v2']),('network-installed',['packages/runtime-sandbox/scripts/probe-authorized-network.mjs']),('boundary-installed',['packages/runtime-sandbox/scripts/probe-network-boundary.mjs']),('worker-loss-installed',['packages/runtime-sandbox/scripts/probe-linux-worker-loss.mjs']),('web-search-installed',['packages/runtime-sandbox/scripts/probe-public-search.mjs'])]

def plain(p):
 s=p.lstat();assert not p.is_symlink() and p.resolve()==p,'UNSAFE_PATH';return s

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def localize_workspace_links(source,build):
 # Validate the complete plan before changing links. Only known workspace
 # packages may be relocated; arbitrary external dependencies remain rejected.
 changes=[]
 for p in source.rglob('*'):
  if not p.is_symlink() or p.resolve().is_relative_to(source):continue
  relative=p.relative_to(source)
  assert len(relative.parts)==3 and relative.parts[:2]==('node_modules','@himawari-agent'),'UNSAFE_SOURCE_LINK'
  original=p.readlink();assert original.is_absolute() and original.is_relative_to(build),'UNSAFE_SOURCE_LINK'
  target_relative=original.relative_to(build)
  # Vitest links workspaces to build/source; packaging uses build directly.
  # Both layouts must still resolve to one named product workspace below.
  if target_relative.parts[:1]==('source',):target_relative=pathlib.Path(*target_relative.parts[1:])
  assert len(target_relative.parts)==2 and target_relative.parts[0] in ('packages','apps'),'UNSAFE_SOURCE_LINK'
  target=source/target_relative
  assert plain(target) and json.loads((target/'package.json').read_text())['name']=='@himawari-agent/'+p.name,'WORKSPACE_LINK_MISMATCH'
  changes.append((p,os.path.relpath(target,p.parent)))
 for p,target in changes:p.unlink();p.symlink_to(target,target_is_directory=True)
 return len(changes)
def verify_copied_candidate(prepared):
 expected={entry['path'] for entry in prepared['prefixFiles']}|{'protection-probe/sentinel.txt'}
 assert {str(p.relative_to(CANDIDATE)) for p in CANDIDATE.rglob('*') if p.is_file()}==expected,'COPIED_CANDIDATE_FILE_SET_CHANGED'
 for entry in prepared['prefixFiles']:
  target=CANDIDATE/entry['path'];assert plain(target).st_uid==0 and target.stat().st_nlink==1
  data=(B/'prefix'/entry['path']).read_bytes()
  if pathlib.Path(entry['path']).parent==pathlib.Path('bin'):data=data.replace(str(B/'prefix').encode(),str(CURRENT).encode())
  assert target.read_bytes()==data,'COPIED_CANDIDATE_CHANGED'
 assert (CANDIDATE/'protection-probe/sentinel.txt').read_text()=='himawari-protection-probe\n'
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
 cmd=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=himawari-search-time-qualify-'+phase]
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
 assert sys.argv[1:] in (['--qualify'],['--resume-links']) and os.geteuid()==0 and socket.gethostname()=='hermes-home'
 resume=sys.argv[1:] == ['--resume-links']
 assert os.environ.get('INVOCATION_ID') and not os.isatty(0),'DETACHED_SYSTEMD_REQUIRED'
 assert subprocess.check_output(['findmnt','-no','TARGET','--target',str(R)],text=True).strip()=='/data'
 assert shutil.disk_usage(R).free>10*1024**3
 assert not CANDIDATE_AUTH.exists(),'QUALIFICATION_ALREADY_HAS_RUNTIME_AUTH'
 if resume:
  assert plain(Q).st_uid==0 and plain(CANDIDATE).st_uid==0
  assert {p.name for p in Q.iterdir()}=={'status.json','exception.json','private-output','probe-source'},'RESUME_STAGE_CHANGED'
  assert not list((Q/'private-output').iterdir()),'PROBES_ALREADY_STARTED'
  assert json.loads((Q/'status.json').read_text())['phase']=='qualification_failed_live_service_unchanged'
  assert json.loads((Q/'exception.json').read_text())=={'exceptionType':'AssertionError'}
 else:assert not Q.exists() and not CANDIDATE.exists(),'QUALIFICATION_ALREADY_EXISTS'
 assert json.loads((R/'qualifications/2026-09-13-loop-identity-cutover/result.json').read_text())['deploymentComplete']
 assert json.loads(AUTH.read_text())['runtimeDigest']=='4c2ffd5de278c5b294860dcae87cbd64a826990a8cd596cb9ed16e84246ceb13','CURRENT_INSTALLATION_CHANGED'
 assert sha(B/'preparation.json')=='0f391d4b6ed0227c54c5570a9a1fe8557eeb3cc58721eaf735c448939ab29e80','PREPARATION_CHANGED'
 prepared=json.loads((B/'preparation.json').read_text())
 assert prepared['buildPassed'] and prepared['sourceArchiveSha256']=='167d968b6ecfb68f01fd8b12c04eae95f3895fc451c7b4d78083737ba1b9f3d3'
 assert {str(p.relative_to(B/'prefix')) for p in (B/'prefix').rglob('*') if p.is_file()}=={entry['path'] for entry in prepared['prefixFiles']},'CANDIDATE_FILE_SET_CHANGED'
 for entry in prepared['prefixFiles']:
  target=B/'prefix'/entry['path'];assert plain(target).st_nlink==1 and sha(target)==entry['sha256'],'CANDIDATE_BYTES_CHANGED'
 assert subprocess.check_output(['systemctl','is-active','himawari.service'],text=True).strip()=='active'
 assert subprocess.check_output(['systemctl','show','himawari.service','-p','User','--value'],text=True).strip()=='himawari'
 assert plain(AUTH).st_uid==0 and plain(AUTH.parent).st_uid==0
 assert plain(SCRATCH).st_uid==998 and stat.S_IMODE(SCRATCH.stat().st_mode)==0o700
 assert pwd.getpwnam('himawari').pw_uid==998 and pwd.getpwnam('andy').pw_uid==1000
 original_pid=subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True).strip()
 original_identity=(plain(CURRENT).st_dev,plain(CURRENT).st_ino)
 original_auth=sha(AUTH);original_config=sha(R/'config/production.json')
 for name,digest in INPUTS.items():assert sha(HERE/name)==digest,'REVIEWED_SCRIPT_CHANGED'
 assert sha(B/'himawari-search-time-source.json')=='1b4eb24e5134201ae272224decf3938623b37de8b046fbab66e08b0ef35a37fb','SOURCE_MANIFEST_CHANGED'
 manifest=json.loads((B/'himawari-search-time-source.json').read_text())
 assert sha(B/'himawari-search-time-source.tar.gz')==manifest['archiveSha256'],'SOURCE_ARCHIVE_CHANGED'
 assert manifest['archiveSha256']=='167d968b6ecfb68f01fd8b12c04eae95f3895fc451c7b4d78083737ba1b9f3d3'
 for entry in manifest['files']:assert sha(B/'source'/entry['path'])==entry['sha256'],'REVIEWED_SOURCE_CHANGED'
 extra=B/'source/test/qualification/sandbox-production-mac-probe.ts';assert sha(extra)==EXTRA_SOURCE_SHA
 os.umask(0o077)
 if resume:
  verify_copied_candidate(prepared)
  for entry in manifest['files']:
   target=Q/'probe-source'/entry['path']
   if target.exists():assert sha(target)==entry['sha256'],'COPIED_SOURCE_CHANGED'
  assert sha(Q/'probe-source/test/qualification/sandbox-production-mac-probe.ts')==EXTRA_SOURCE_SHA
  for name in ('status.json','exception.json'):shutil.copyfile(Q/name,Q/('attempt-1-'+name));(Q/('attempt-1-'+name)).chmod(0o644)
 else:Q.mkdir(mode=0o711);Q.chmod(0o711);(Q/'private-output').mkdir(mode=0o700)
 try:
  status('copying_candidate_without_stopping_service')
  if not resume:
   shutil.copytree(B/'prefix',CANDIDATE,symlinks=True)
   for entry in prepared['prefixFiles']:assert sha(CANDIDATE/entry['path'])==entry['sha256'],'COPIED_CANDIDATE_CHANGED'
   for p in (CANDIDATE/'bin').iterdir():p.write_text(p.read_text().replace(str(B/'prefix'),str(CURRENT)))
   sentinel=CANDIDATE/'protection-probe';sentinel.mkdir();(sentinel/'sentinel.txt').write_text('himawari-protection-probe\n')
  protect_tree(CANDIDATE)
  source=Q/'probe-source'
  if not resume:
   shutil.copytree(B/'source',source,symlinks=True,ignore=lambda directory,names: set(names)&({'node_modules','dist','.ci-output','.git'} if pathlib.Path(directory)==B/'source' else {'dist','.ci-output','.git'}))
   shutil.copytree(B/'source/node_modules',source/'node_modules',symlinks=True,ignore=lambda p,n: {'.vite','.vite-temp'}&set(n) if pathlib.Path(p)==B/'source/node_modules' else set())
  assert json.loads((source/'packages/platform-node/node_modules/zod/package.json').read_text())['version']=='4.4.3','WORKSPACE_DEPENDENCY_LAYOUT_INCOMPLETE'
  relocated=localize_workspace_links(source,B)
  publish('workspace-links.json',{'relocated':relocated,'resumedBeforeAnyProbe':resume})
  protect_tree(source,allow_links=True)
  for name in ['.vite','.vite-temp']:
   cache=source/'node_modules'/name;cache.mkdir(mode=0o700);os.chown(cache,998,998)
  for name in INPUTS:
   shutil.copyfile(HERE/name,Q/name);(Q/name).chmod(0o644);assert sha(Q/name)==INPUTS[name],'COPIED_SCRIPT_CHANGED'
  shutil.copyfile(B/'himawari-search-time-source.json',Q/'source-manifest.json');(Q/'source-manifest.json').chmod(0o644)
  digest_script=Q/'runtime-digest.mjs'
  digest_script.write_text('import { createRequire } from "node:module";\nconst require=createRequire('+json.dumps(str(RUNTIME/'package.json'))+');\nconst {digestSandboxRuntime}=require("@himawari-agent/platform-node");\nconsole.log(JSON.stringify({runtimeDigest:await digestSandboxRuntime('+json.dumps(str(RUNTIME))+')}));\n');digest_script.chmod(0o644)
  status('verifying_signer_access_without_exposing_workspace_contents')
  signer=run_user('andy','signer-preflight',[RUNTIME/'pi-tools/bin/node',Q/'hermes-search-time-seal.mjs','--preflight'],signer_view=True)
  workspace=plain(R/'workspaces/default')
  assert signer['passed'] and signer['signerUid']==1000 and signer['workspaceDevice']==str(workspace.st_dev) and signer['workspaceInode']==str(workspace.st_ino),'SIGNER_WORKSPACE_IDENTITY_MISMATCH'
  publish('signer-preflight.json',signer)
  status('verifying_browser_artifact_as_runtime_account')
  web=run_user('himawari','web-static',[RUNTIME/'pi-tools/bin/node',Q/'hermes-harness-web-probe.mjs'])
  assert web['passed'] and web['staticFiles']==6 and web['runtimeUid']==998
  publish('web-static-installed.json',web)
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
  result=run_user('andy','seal',[RUNTIME/'pi-tools/bin/node',Q/'hermes-search-time-seal.mjs'],signer_view=True)
  assert result['runtimeDigest']==digest
  names=[name+'.json' for name,_ in PROBES]+['installation-receipt.json','installation-receipt.sig','host-qualification-public-key.pem','pi-runner.sig','search-runner.sig']
  for name in names:shutil.copyfile(seal/name,Q/name);(Q/name).chmod(0o644)
  assert subprocess.check_output(['systemctl','is-active','himawari.service'],text=True).strip()=='active'
  assert subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True).strip()==original_pid,'LIVE_SERVICE_PID_CHANGED'
  assert (plain(CURRENT).st_dev,plain(CURRENT).st_ino)==original_identity and sha(AUTH)==original_auth and sha(R/'config/production.json')==original_config,'LIVE_INSTALLATION_CHANGED'
  publish('result.json',{'passed':True,'candidatePrefix':str(CANDIDATE),'qualifiedRuntimePath':str(RUNTIME),'runtimeDigest':digest,'receiptDigest':result['receiptDigest'],'runtimeUid':998,'productionServiceChanged':False,'productionDatabaseWritten':False,'modelCalls':0,'next':'verified backup and schema-32 installation switch still required; do not import legacy history again'})
  reader=runpy.run_path(str(Q/'hermes-search-time-observer.py'))
  report=reader['observe'](R/'state/data/product.sqlite');report['files']=reader['file_facts']()
  configuration=json.loads((R/'config/production.json').read_text())
  assert configuration['ownerId']==reader['OWNER'] and configuration['agentId']==reader['AGENT']
  report['configuredModelBudget']={key:configuration['budgets'][key] for key in ('globalCostMicros','perRunCostMicros','perClassificationCostMicros')}
  publish('e2e-observation.json',report)
  subprocess.run(['systemd-run','--unit=himawari-search-time-live-observer','--property=RuntimeMaxSec=3700','/usr/bin/python3','-I',Q/'hermes-search-time-observer.py'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  status('candidate_qualified_live_service_unchanged',True)
 except BaseException as error:
  status('qualification_failed_live_service_unchanged',False)
  publish('exception.json',{'exceptionType':type(error).__name__});raise

if __name__=='__main__':
 assert sys.flags.optimize==0 and os.geteuid()==0 and sys.argv[1:] in (['--qualify'],['--resume-links'])
 fd=os.open('/run/himawari-three-fixes-qualification.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 assert os.fstat(fd).st_uid==0 and stat.S_ISREG(os.fstat(fd).st_mode)
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 main()
