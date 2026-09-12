#!/usr/bin/python3
"""Reviewed, single-deployment Hermes migration. Never install a sudoers rule.
--check is read-only; --apply continues the verified rolled-back v4 attempt.
All source/qualification programs execute as a non-root user, not root.
"""
import argparse, hashlib, json, os, pathlib, pwd, shutil, socket, sqlite3, stat, subprocess, sys, time, uuid, re, fcntl, signal
R=pathlib.Path('/data/hermes/himawari')
PREVIOUS=R/'qualifications/2026-09-11-protected'
Q=PREVIOUS/'attempt-v5'
SCRIPTS=pathlib.Path(__file__).resolve().parent
B=R/'builds/2026-09-11-experience'
CURRENT=R/'releases/2026-09-11-control-center'
CANDIDATE=R/'releases/2026-09-11-protected'
ARCHIVE=R/'releases/2026-09-11-control-center-before-protected'
RUNTIME=CURRENT/'lib/himawari-agent'
CONFIG=R/'config/production.json'
AUTH=pathlib.Path('/etc/himawari/runtime.json')
UNIT=pathlib.Path('/etc/systemd/system/himawari.service')
OLDUNIT=pathlib.Path('/home/andy/.config/systemd/user/himawari.service')
ANDY=None # Resolved only by the host entrypoint, never while importing tests.
INPUT_DIGESTS={'hermes-protected-registered.mjs': '7904085d39a50e3d2bbab9547ed2e230cc96a9d2592556d8bb5db722b8f6aaa8', 'hermes-protected-seal.mjs': '6298f67ea19680e977a1529c3ea8568c87bd4fdbd564587c50a7ab9d6cc803e4', 'hermes-protected-start.mjs': '03cf3ea57209293a3045d8d553d34431a9d046937ec7de9544e74e4b5e4eec88'}
MUTABLE=['state','config','jobs','logs','workspaces']
PROBES=[('pi-installed',['packages/runtime-pi/scripts/probe-foreground.mjs']),('composition-installed',['packages/runtime-sandbox/scripts/qualify-production.mjs','--v2']),('network-installed',['packages/runtime-sandbox/scripts/probe-authorized-network.mjs']),('boundary-installed',['packages/runtime-sandbox/scripts/probe-network-boundary.mjs']),('worker-loss-installed',['packages/runtime-sandbox/scripts/probe-linux-worker-loss.mjs']),('web-search-installed',['packages/runtime-sandbox/scripts/probe-public-search.mjs'])]

def run(cmd, **kw): return subprocess.run([str(x) for x in cmd],check=True,timeout=kw.pop('timeout',600),**kw)
def plain(p):
 s=p.lstat(); assert not p.is_symlink() and p.resolve()==p, 'UNSAFE_PATH';return s

def inventory(p):
 # Do not follow a symlink during privileged ownership changes.
 yield p
 if p.is_dir() and not p.is_symlink():
  for base,dirs,files in os.walk(p,followlinks=False):
   for name in dirs+files:yield pathlib.Path(base)/name

NS_PROPERTIES=['TemporaryFileSystem=/data/hermes:ro,mode=0755','BindPaths='+str(R)]

def as_user(user,cmd,env=None,**kw):
 base={'PATH':'/usr/sbin:/usr/bin:/bin','HOME':user.pw_dir,'LANG':'C.UTF-8'}
 if user.pw_uid==ANDY.pw_uid:base['XDG_RUNTIME_DIR']='/run/user/'+str(ANDY.pw_uid)
 if env:base.update(env)
 if user.pw_name=='himawari':
  unit='himawari-qualification-'+uuid.uuid4().hex
  timeout=kw.pop('timeout',600);cwd=kw.pop('cwd',str(R))
  properties=[*NS_PROPERTIES,'User=himawari','Group=himawari','NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','UMask=0077','WorkingDirectory='+str(cwd),'RuntimeMaxSec='+str(timeout)]
  command=['systemd-run','--wait','--pipe','--collect','--quiet','--unit='+unit]
  for prop in properties:command.extend(['--property',prop])
  command.extend(['/usr/bin/env','-i',*[k+'='+v for k,v in base.items()],*map(str,cmd)])
  try:return run(command,timeout=timeout+15,**kw)
  except BaseException as error:
   subprocess.run(['systemctl','stop',unit],check=False,timeout=30)
   codes=[];handle=kw.get('stderr')
   if hasattr(handle,'name') and str(handle.name).startswith(str(Q/'probe-output-v5')+'/'):
    handle.flush();tail=pathlib.Path(handle.name).read_text(errors='replace')[-16384:]
    codes=sorted(set(re.findall(r'\b(?:SANDBOX_[A-Z0-9_]+|SRT_[A-Z0-9_]+|ERR_[A-Z0-9_]+|EACCES|EPERM|ENOENT)\b',tail)))
   report=Q/'failure-summary.json';report.write_text(json.dumps({'command':pathlib.Path(str(cmd[0])).name,'exitCode':getattr(error,'returncode',None),'unit':unit,'errorCodes':codes}));report.chmod(0o644)
   raise
 return run(['/usr/bin/setpriv','--reuid='+str(user.pw_uid),'--regid='+str(user.pw_gid),'--init-groups','--no-new-privs','--bounding-set=-all','/usr/bin/env','-i',*[k+'='+v for k,v in base.items()],*map(str,cmd)],**kw)

def status(state):
 p=Q/('migration-status-'+uuid.uuid4().hex+'.tmp');p.write_text(json.dumps({'state':state,'at':time.time(),'currentPrefix':str(CURRENT),'oldPrefix':str(ARCHIVE)}));os.chown(p,ANDY.pw_uid,ANDY.pw_gid);p.chmod(0o600);os.replace(p,Q/'migration-status.json')
 try:print(state,flush=True)
 except BrokenPipeError:pass

def check(require_validation=True):
 assert socket.gethostname()=='hermes-home' and sys.platform=='linux'
 for p,expected in [(B/'source/packages/runtime-sandbox/scripts/qualify-production.mjs','dc72634b8617e7421f676361b38c535f7850e17154f68e50a6a4e4d18e1c9d3c')]:
  plain(p);assert hashlib.sha256(p.read_bytes()).hexdigest()==expected,'REVIEWED_CORRECTION_CHANGED'
 mount=subprocess.check_output(['findmnt','-no','TARGET','--target','/data'],text=True).strip();assert mount=='/data'
 assert shutil.disk_usage('/data').free>5*1024**3
 for p in [R,PREVIOUS,B,CURRENT,CANDIDATE,CONFIG,OLDUNIT]:plain(p)
 assert not ARCHIVE.exists() and not AUTH.exists() and not UNIT.exists()
 assert not Q.exists(),'ATTEMPT_ALREADY_EXISTS_REVIEW_REQUIRED'
 for name,expected in INPUT_DIGESTS.items():
  assert hashlib.sha256((SCRIPTS/name).read_bytes()).hexdigest()==expected,'REVIEWED_INPUT_CHANGED'
 assert not subprocess.check_output(['systemctl','list-units','himawari-qualification-*','--plain','--no-legend'],text=True).strip(),'QUALIFICATION_STILL_RUNNING'
 assert json.loads((PREVIOUS/'migration-status.json').read_text())['state']=='migration_failed_original_service_restarted'
 assert plain(PREVIOUS/'probe-source').st_uid==pwd.getpwnam('himawari').pw_uid
 assert ANDY.pw_uid==1000 and plain(R).st_uid==ANDY.pw_uid
 c=json.loads(CONFIG.read_text());assert c['ownerId']=='owner-james-26b80231-cdeb-4ad9-bb02-850541005fff'
 assert c['agentId']=='agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3' and c['deploymentId']=='deployment-hermes-9e8dc197-146e-4465-bbd1-4246eb2fc96f'
 with sqlite3.connect('file:'+str(R/'state/data/product.sqlite')+'?mode=ro',uri=True) as db:
  assert db.execute("select count(*) from runs where status not in ('completed','failed','cancelled')").fetchone()[0]==0,'ACTIVE_RUNS'
  assert db.execute('pragma quick_check').fetchone()[0]=='ok'
  assert db.execute('select max(sequence) from schema_migration_ledger').fetchone()[0]==31
 assert json.loads((PREVIOUS/'build-ready.json').read_text())['installedProtectionModule']
 validation_ready=(PREVIOUS/'local-validation.json').exists() and json.loads((PREVIOUS/'local-validation.json').read_text())['passed']
 if require_validation:assert validation_ready, 'LOCAL_CHECKS_NOT_FINISHED'
 for rel,digest in json.loads((PREVIOUS/'migration-inputs.json').read_text()).items():
  p=PREVIOUS/rel;assert p.resolve().is_relative_to(PREVIOUS);assert p.is_file() and not p.is_symlink()
  assert hashlib.sha256(p.read_bytes()).hexdigest()==digest,'MIGRATION_INPUT_CHANGED'
 for _,args in PROBES:
  installed=PREVIOUS/'probe-source'/args[0];source=B/'source'/args[0]
  plain(installed);plain(source)
  assert hashlib.sha256(installed.read_bytes()).digest()==hashlib.sha256(source.read_bytes()).digest(),'PROBE_SOURCE_CHANGED'
 for p in inventory(CANDIDATE):
  s=p.lstat();assert stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode),'NONREGULAR_INSTALLATION'
  assert s.st_uid==0 and not s.st_mode&0o022
  if stat.S_ISREG(s.st_mode):assert s.st_nlink==1,'LINKED_INSTALLATION_FILE'
 for name in MUTABLE:
  for p in inventory(R/name):
   s=p.lstat();assert not stat.S_ISLNK(s.st_mode),'MUTABLE_SYMLINK_REQUIRES_REVIEW'
   assert s.st_uid==ANDY.pw_uid,'UNEXPECTED_DATA_OWNER'
   if stat.S_ISREG(s.st_mode):assert s.st_nlink==1,'LINKED_DATA_FILE_REQUIRES_REVIEW'
 try:
  user=pwd.getpwnam('himawari');assert user.pw_shell in ['/usr/sbin/nologin','/sbin/nologin'] and user.pw_uid!=ANDY.pw_uid and user.pw_uid>0
  assert os.getgrouplist('himawari',user.pw_gid)==[user.pw_gid],'PRIVILEGED_GROUP'
 except KeyError:pass
 print(json.dumps({'preflight':True,'host':'hermes-home','candidate':str(CANDIDATE),'activeRuns':0,'localValidationReady':validation_ready,'dataDiskFreeBytes':shutil.disk_usage('/data').free,'operation':'separate runtime account, protect installation, qualify, preserve backup, replace systemd unit'}),flush=True)

def handoff_runtime_data(user, sign_installation):
 # The signer remains the deployment user. Private data cannot change owner
 # until it has consumed and signed every directory identity it needs.
 workspace=R/'workspaces/default'
 before=plain(workspace)
 identity=(before.st_dev,before.st_ino,stat.S_IMODE(before.st_mode))
 def unchanged():
  current=plain(workspace)
  assert (current.st_dev,current.st_ino,stat.S_IMODE(current.st_mode))==identity,'WORKSPACE_IDENTITY_CHANGED'
 sign_installation()
 unchanged()
 for name in MUTABLE:
  for p in inventory(R/name):os.chown(p,user.pw_uid,user.pw_gid,follow_symlinks=False)
 unchanged()

def protect_tree(p,gid):
 for item in inventory(p):
  s=item.lstat();assert stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)
  os.chown(item,0,gid,follow_symlinks=False)
  item.chmod(0o755 if stat.S_ISDIR(s.st_mode) or s.st_mode&0o111 else 0o644)

def rehearse_handoff(user):
 # Exercise real UID changes against disposable data before stopping production.
 global R
 original_root=R
 fixture=Q/'handoff-rehearsal'
 fixture.mkdir(mode=0o711);fixture.chmod(0o711)
 for name in MUTABLE:
  directory=fixture/name;directory.mkdir(mode=0o700);os.chown(directory,ANDY.pw_uid,ANDY.pw_gid)
 workspace=fixture/'workspaces/default'
 workspace.mkdir(mode=0o700);os.chown(workspace,ANDY.pw_uid,ANDY.pw_gid)
 marker=workspace/'preserve.txt';marker.write_text('synthetic handoff verification\n');marker.chmod(0o600);os.chown(marker,ANDY.pw_uid,ANDY.pw_gid)
 before=plain(workspace)
 code="import json,os,pathlib,sys;p=pathlib.Path(sys.argv[1]);s=p.stat();assert (p/'preserve.txt').read_text()=='synthetic handoff verification\\n';print(json.dumps({'uid':os.getuid(),'device':s.st_dev,'inode':s.st_ino,'mode':s.st_mode&511}))"
 observations=[]
 def read_as(account):
  result=as_user(account,['/usr/bin/python3','-I','-c',code,workspace],capture_output=True,text=True,timeout=60)
  value=json.loads(result.stdout);assert (value['device'],value['inode'],value['mode'])==(before.st_dev,before.st_ino,0o700)
  observations.append(value)
 try:
  R=fixture
  handoff_runtime_data(user,lambda:read_as(ANDY))
  read_as(user)
  try:
   read_as(ANDY)
   raise AssertionError('OLD_ACCOUNT_RETAINS_PRIVATE_ACCESS')
  except subprocess.CalledProcessError as error:
   assert 'PermissionError' in error.stderr,'UNEXPECTED_REHEARSAL_FAILURE'
  assert plain(workspace).st_uid==user.pw_uid
 finally:R=original_root
 report=Q/'handoff-rehearsal.json';report.write_text(json.dumps({'passed':True,'observations':observations,'oldAccountDeniedAfterHandoff':True,'productionDataTouched':False}));report.chmod(0o644)

def apply():
 assert os.geteuid()==0,'ADMINISTRATOR_AUTHENTICATION_REQUIRED'
 assert os.environ.get('INVOCATION_ID') and not os.isatty(0),'DETACHED_SYSTEMD_REQUIRED'
 check();os.umask(0o077)
 Q.mkdir(mode=0o711);Q.chmod(0o711)
 for name in ['hermes-protected-start.mjs','hermes-protected-registered.mjs','hermes-protected-seal.mjs']:
  shutil.copyfile(SCRIPTS/name,Q/name);os.chown(Q/name,0,0);(Q/name).chmod(0o644)
 shutil.copyfile(PREVIOUS/'probe-protected-runtime.mjs',Q/'probe-protected-runtime.mjs');(Q/'probe-protected-runtime.mjs').chmod(0o644)
 user=pwd.getpwnam('himawari');assert user.pw_uid==998 and user.pw_gid==998
 assert os.getgrouplist('himawari',user.pw_gid)==[user.pw_gid]
 # The other Hermes Agent owns /data/hermes and keeps it 0700. Leave its
 # protection intact; systemd exposes only this product in a private mount view.
 original=json.loads((PREVIOUS/'original-parent-permissions.json').read_text())['/data/hermes']
 assert original['uid']==ANDY.pw_uid and original['gid']==ANDY.pw_gid and original['mode']==0o700
 assert plain(pathlib.Path('/data/hermes')).st_uid==original['uid']
 assert stat.S_IMODE(pathlib.Path('/data/hermes').stat().st_mode)==original['mode']
 source=PREVIOUS/'probe-source'
 assert source.stat().st_uid==user.pw_uid and stat.S_IMODE(source.stat().st_mode)==0o700
 output=Q/'probe-output-v5';output.mkdir(mode=0o700);os.chown(output,user.pw_uid,user.pw_gid)
 seal=Q/'seal-stage-v5';seal.mkdir(mode=0o700);os.chown(seal,ANDY.pw_uid,ANDY.pw_gid)
 probe_code="""import json,os,pathlib,stat,subprocess,sys
root=pathlib.Path(sys.argv[1]);parent=root.parent
assert os.getuid()==998
assert parent.stat().st_uid==0 and stat.S_IMODE(parent.stat().st_mode)==0o755
assert sorted(p.name for p in parent.iterdir())==['himawari']
assert str(root.stat().st_dev)==sys.argv[2] and str(root.stat().st_ino)==sys.argv[3]
node=root/'releases/2026-09-11-protected/lib/himawari-agent/pi-tools/bin/node'
version=subprocess.check_output([str(node),'--version'],text=True).strip();assert version=='v22.22.3'
print(json.dumps({'passed':True,'runtimeUid':os.getuid(),'privateParentUid':parent.stat().st_uid,'privateParentMode':oct(stat.S_IMODE(parent.stat().st_mode)),'visibleChildren':['himawari'],'sameProductDirectoryIdentity':True,'nodeVersion':version}))
"""
 try:
  with open(Q/'namespace-preflight-v5.json','x') as out:
   as_user(user,['/usr/bin/python3','-I','-c',probe_code,R,str(R.stat().st_dev),str(R.stat().st_ino)],stdout=out,stderr=subprocess.STDOUT,timeout=60)
 finally:(Q/'namespace-preflight-v5.json').chmod(0o644)
 status('private_mount_view_verified_original_service_still_running')
 rehearse_handoff(user)
 status('real_account_handoff_rehearsal_passed_original_service_still_running')
 # Same real deployment identity as final signing, before any service disruption.
 with open(Q/'signer-preflight.json','x') as out,open(Q/'signer-preflight.log','x') as err:
  as_user(ANDY,[CANDIDATE/'lib/himawari-agent/pi-tools/bin/node',Q/'hermes-protected-seal.mjs','--preflight'],stdout=out,stderr=err,timeout=60)
 (Q/'signer-preflight.json').chmod(0o644)
 # No ownership changes to live state until the old service is stopped and backed up.
 with sqlite3.connect('file:'+str(R/'state/data/product.sqlite')+'?mode=ro',uri=True) as db:
  assert db.execute("select count(*) from runs where status not in ('completed','failed','cancelled')").fetchone()[0]==0,'NEW_ACTIVE_RUNS'
 status('preparation_complete_stopping_idle_service')
 as_user(ANDY,['systemctl','--user','stop','himawari.service'],timeout=65)
 old_stopped=True;switched=False;migrated=False;new_started=False
 try:
  shutil.copy2(CONFIG,Q/'production-before-v5.json');shutil.copy2(OLDUNIT,Q/'unit-before-v5.service')
  status('creating_verified_backup')
  old_env={'PATH':str(CURRENT/'lib/himawari-agent/pi-tools/bin')+':/usr/bin:/bin'}
  for action,opt in [('create','--backup-id'),('verify','--backup')]:
   with open(Q/('backup-'+action+'-v5.json'),'x') as out:
    as_user(ANDY,[CURRENT/'bin/himawari','backup',action,'--config',CONFIG,'--secret-dir',R/'state/secrets',opt,'before-protected-2026-09-11-v5'],env=old_env,stdout=out,stderr=subprocess.STDOUT,timeout=300)
  status('backup_verified_switching_installation')
  CURRENT.rename(ARCHIVE);switched=True;CANDIDATE.rename(CURRENT)
  for p in (CURRENT/'bin').iterdir():p.write_text(p.read_text().replace(str(CANDIDATE),str(CURRENT)));p.chmod(0o755)
  sentinel=CURRENT/'protection-probe';sentinel.mkdir(mode=0o755,exist_ok=True);(sentinel/'sentinel.txt').write_text('himawari-protection-probe\n')
  protect_tree(CURRENT,user.pw_gid)
  scratch=pathlib.Path('/data/himawari-r8-protected')
  assert plain(scratch).st_uid==user.pw_uid and stat.S_IMODE(scratch.stat().st_mode)==0o700
  node=RUNTIME/'pi-tools/bin/node'
  env={'PATH':str(RUNTIME/'pi-tools/bin')+':/usr/bin:/bin','HOME':str(scratch),'HIMAWARI_LIVE_SANDBOX_PROBE':'1','HIMAWARI_PROBE_RUNTIME':str(RUNTIME),'HIMAWARI_QUALIFY_INSTALLED_RUNTIME':str(RUNTIME),'HIMAWARI_PROBE_SCRATCH':str(scratch)}
  status('qualifying_final_readonly_installation_as_runtime_user')
  results=[]
  for name,args in PROBES:
   with open(output/(name+'.json'),'x') as out,open(output/(name+'.log'),'x') as err:
    as_user(user,[node,*args],env=env,cwd=source,stdout=out,stderr=err,timeout=600)
   results.append({'probe':name,'exitCode':0,'runtimeUid':user.pw_uid,'noNewPrivs':True})
   (Q/'probe-results.json').write_text(json.dumps(results));status('qualified_'+name)
   dst=seal/(name+'.json');shutil.copyfile(output/(name+'.json'),dst);os.chown(dst,ANDY.pw_uid,ANDY.pw_gid);dst.chmod(0o600)
  def sign_installation():
   status('signing_before_runtime_data_handoff')
   with open(Q/'seal-result-v5.json','x') as out,open(Q/'seal-error-v5.log','x') as err:
    as_user(ANDY,[node,Q/'hermes-protected-seal.mjs'],env={'PATH':str(RUNTIME/'pi-tools/bin')+':/usr/bin:/bin'},stdout=out,stderr=err)
  migrated=True # Even a partial chown must restore every mutable root on failure.
  handoff_runtime_data(user,sign_installation)
  status('signed_workspace_identity_preserved_after_handoff')
  mutable=R/'state/deployment';mutable.mkdir(mode=0o700,exist_ok=True);os.chown(mutable,user.pw_uid,user.pw_gid)
  # Publish only declared signature/evidence files, never the signing private key.
  names=[name+'.json' for name,_ in PROBES]+['installation-receipt.json','installation-receipt.sig','host-qualification-public-key.pem','pi-runner.sig','search-runner.sig']
  for name in names:
   dst=Q/name;shutil.copyfile(seal/name,dst);os.chown(dst,0,0);dst.chmod(0o644)
  receipt=json.loads((Q/'installation-receipt.json').read_text())
  if not AUTH.parent.exists():AUTH.parent.mkdir(mode=0o755);AUTH.parent.chmod(0o755)
  assert plain(AUTH.parent).st_uid==0 and stat.S_IMODE(AUTH.parent.stat().st_mode)==0o755
  with AUTH.open('x') as out:out.write(json.dumps({'schemaVersion':'protected-runtime.v1','runtimeRoot':str(RUNTIME),'runtimeDigest':receipt['runtimeDigest'],'runtimeUid':user.pw_uid,'deploymentUid':ANDY.pw_uid})+'\n')
  AUTH.chmod(0o644)
  protected_env={**env,'HIMAWARI_RUNTIME_PROTECTION_FILE':str(AUTH)}
  status('verifying_denied_writes_and_audit_reuse')
  with open(Q/'protected-runtime-probe.json','x') as out:
   as_user(user,[node,Q/'probe-protected-runtime.mjs',AUTH,sentinel,scratch],env=protected_env,stdout=out,stderr=subprocess.STDOUT)
  (Q/'protected-runtime-probe.json').chmod(0o644)
  prepared=mutable/'production-prepared.json';shutil.copy2(CONFIG,prepared);os.chown(prepared,user.pw_uid,user.pw_gid);prepared.chmod(0o600)
  with open(Q/'prepare-result.log','x') as out:
   as_user(user,[node,Q/'hermes-protected-start.mjs','--prepare',prepared],env=protected_env,stdout=out,stderr=subprocess.STDOUT)
   as_user(user,[node,Q/'hermes-protected-registered.mjs'],env=protected_env,stdout=out,stderr=subprocess.STDOUT)
  os.replace(prepared,CONFIG)
  unit=f'''[Unit]
Description=Himawari Agent (protected installation)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=himawari
Group=himawari
WorkingDirectory={R}
ExecStart={node} {Q}/hermes-protected-start.mjs
Environment=PATH={RUNTIME}/pi-tools/bin:/usr/bin:/bin
Environment=HIMAWARI_RUNTIME_PROTECTION_FILE={AUTH}
TemporaryFileSystem=/data/hermes:ro,mode=0755
BindPaths={R}
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
Restart=on-failure
RestartSec=15
TimeoutStartSec=300
TimeoutStopSec=45
KillMode=mixed
StandardOutput=append:{R}/logs/supervisor.log
StandardError=append:{R}/logs/supervisor.log
[Install]
WantedBy=multi-user.target
'''
  UNIT.write_text(unit);UNIT.chmod(0o644)
  run(['systemd-analyze','verify',UNIT]);run(['systemctl','daemon-reload'])
  offsets={name:(R/'logs'/f'{name}.log').stat().st_size for name in ['agent','worker']}
  new_started=True;status('starting_protected_service')
  run(['systemctl','start','himawari.service'])
  ready=set()
  for _ in range(180):
   for name,offset in offsets.items():
    with open(R/'logs'/f'{name}.log','rb') as f:f.seek(offset);data=f.read()
    if b'"event":"service.ready"' in data or b'"event": "service.ready"' in data:ready.add(name)
   if len(ready)==2:break
   time.sleep(1)
  assert len(ready)==2,'SERVICE_READINESS_NOT_CONFIRMED'
  run(['systemctl','enable','himawari.service'])
  as_user(ANDY,['systemctl','--user','disable','himawari.service'])
  pid=int(subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True))
  proc=pathlib.Path('/proc')/str(pid)/'status';s=proc.read_text();assert f'Uid:\t{user.pw_uid}\t{user.pw_uid}\t{user.pw_uid}\t{user.pw_uid}' in s and 'NoNewPrivs:\t1' in s
  (Q/'migration-result.json').write_text(json.dumps({'passed':True,'runtimeUid':user.pw_uid,'pid':pid,'runtimeDigest':receipt['runtimeDigest'],'realModelAcceptance':'pending','scope':'protected installation, actual permission denials, six sandbox qualification groups, service readiness'}))
  (Q/'migration-result.json').chmod(0o644)
  status('protected_service_ready_browser_acceptance_pending')
 except BaseException as error:
  codes=[]
  for filename in [Q/'seal-error-v5.log',Q/'prepare-result.log']:
   if filename.exists():codes.extend(re.findall(r'\b(?:SANDBOX_[A-Z0-9_]+|SRT_[A-Z0-9_]+|ERR_[A-Z0-9_]+|EACCES|EPERM|ENOENT)\b',filename.read_text(errors='replace')[-16384:]))
  summary=Q/'failure-summary.json';summary.write_text(json.dumps({'exceptionType':type(error).__name__,'exitCode':getattr(error,'returncode',None),'errorCodes':sorted(set(codes))}));summary.chmod(0o644)
  # Before the new service starts, only synthetic probes/preparation ran.
  # Once it starts, preserve the scene: a real user may have submitted work.
  if not new_started:
   if AUTH.exists():AUTH.unlink()
   if switched:
    if CURRENT.exists():
     assert not CANDIDATE.exists();CURRENT.rename(CANDIDATE)
    ARCHIVE.rename(CURRENT)
   if migrated:
    for name in MUTABLE:
     for p in inventory(R/name):os.chown(p,ANDY.pw_uid,ANDY.pw_gid,follow_symlinks=False)
   if (Q/'production-before-v5.json').exists():shutil.copy2(Q/'production-before-v5.json',CONFIG);os.chown(CONFIG,ANDY.pw_uid,ANDY.pw_gid);CONFIG.chmod(0o600)
   if UNIT.exists():UNIT.unlink();run(['systemctl','daemon-reload'])
   as_user(ANDY,['systemctl','--user','start','himawari.service'])
   status('migration_failed_original_service_restarted')
  else:status('new_service_requires_inspection_no_automatic_rollback')
  raise

def interrupted(signum,frame):
 raise InterruptedError('MIGRATION_INTERRUPTED_'+str(signum))

if __name__=='__main__':
 ANDY=pwd.getpwnam('andy')
 parser=argparse.ArgumentParser();mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--check',action='store_true');mode.add_argument('--apply',action='store_true');args=parser.parse_args()
 assert sys.flags.optimize==0,'PYTHON_OPTIMIZATION_FORBIDDEN'
 if args.check:check();sys.exit(0)
 assert os.geteuid()==0,'ADMINISTRATOR_AUTHENTICATION_REQUIRED'
 # The fixed privileged lock is independent of the runtime-writable state root.
 lock=os.open('/run/himawari-protected-migration.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 assert os.fstat(lock).st_uid==0 and stat.S_ISREG(os.fstat(lock).st_mode)
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 signal.signal(signal.SIGHUP,signal.SIG_IGN)
 signal.signal(signal.SIGTERM,interrupted)
 apply()
