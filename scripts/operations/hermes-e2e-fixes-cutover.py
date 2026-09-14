#!/usr/bin/python3
"""Schema-32 installation-only cutover; preserve all history and bounded pre-start rollback."""
import fcntl,hashlib,json,os,pathlib,re,shutil,socket,sqlite3,stat,subprocess,sys,tempfile,time
R=pathlib.Path('/data/hermes/himawari')
B=R/'builds/2026-09-12-e2e-fixes'
Q=R/'qualifications/2026-09-12-e2e-fixes-installation'
W=R/'qualifications/2026-09-12-e2e-fixes-cutover'
CURRENT=R/'releases/2026-09-11-control-center'
CANDIDATE=R/'releases/2026-09-12-e2e-fixes'
ARCHIVE=R/'releases/2026-09-12-before-e2e-fixes'
RUNTIME=CURRENT/'lib/himawari-agent'
CONFIG=R/'config/production.json'
STATE=R/'state'
UNIT=pathlib.Path('/etc/systemd/system/himawari.service')
AUTH=pathlib.Path('/etc/himawari/runtime.json')
CANDIDATE_AUTH=pathlib.Path('/etc/himawari/e2e-fixes-candidate.json')
BACKUP_ID='before-e2e-fixes-2026-09-12'
ATTESTATION=STATE/'deployment/startup-attestation.json'
OLD_START=R/'qualifications/2026-09-11-native-history-installation/hermes-native-history-start.mjs'
EXPECTED_RECEIPT='1d1a69538209797e91e3be28f935ac5e78b49c480097cf906fa8bb3c99cdd975'
EXPECTED_CURRENT_RUNTIME='2aa0cd9f40f257788a5c96557e97b519da7ca520a6a378883a90a2c7e3b513b6'
INPUTS={'hermes-e2e-fixes-observer.py': 'a5d3347cd40f2466d64809c280de5b495efbb5e4224de4362da7f6dc0304f61f', 'hermes-protected-registered.mjs': '7904085d39a50e3d2bbab9547ed2e230cc96a9d2592556d8bb5db722b8f6aaa8'}

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def plain(p):
 s=p.lstat();assert not p.is_symlink() and p.resolve()==p,'UNSAFE_PATH';return s
def publish(name,value):
 p=W/name;t=p.with_name(p.name+'.next');t.write_text(json.dumps(value,indent=2)+'\n');t.chmod(0o644);os.replace(t,p)
def status(phase):publish('status.json',{'phase':phase,'at':time.time()});print(phase,flush=True)
def command(args,timeout=90):return subprocess.run(list(map(str,args)),check=True,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout)
def invoke(phase,args,candidate_view=False,protected=True):
 props=['User=himawari','Group=himawari','NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','UMask=0077','RuntimeMaxSec=900','WorkingDirectory='+str(R),'TemporaryFileSystem=/data/hermes:ro,mode=0755','BindPaths='+str(R)]
 if candidate_view:props[-1]+=' '+str(CANDIDATE)+':'+str(CURRENT)+' '+str(CANDIDATE_AUTH)+':'+str(AUTH)
 cmd=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=himawari-e2e-cutover-'+phase]
 for p in props:cmd+=['--property='+p]
 env={'PATH':str(RUNTIME/'pi-tools/bin')+':/usr/bin:/bin','HOME':str(STATE),'LANG':'C.UTF-8'}
 if protected:env['HIMAWARI_RUNTIME_PROTECTION_FILE']=str(AUTH)
 cmd+=['/usr/bin/env','-i',*[k+'='+v for k,v in env.items()],*map(str,args)]
 with (W/'private'/(phase+'.stdout')).open('x') as out,(W/'private'/(phase+'.stderr')).open('x') as err:
  result=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=out,stderr=err,timeout=930)
 if result.returncode:
  error=(W/'private'/(phase+'.stderr')).read_text(errors='replace')
  publish('failure.json',{'phase':phase,'exitCode':result.returncode,'codes':sorted(set(re.findall(r'\b(?:IMPORT|CUTOVER|SANDBOX|RECOVERY_POINT|ADMIN_CLI|PORT)_[A-Z0-9_]+\b',error)))})
  raise RuntimeError('CUTOVER_CHILD_FAILED')
 lines=(W/'private'/(phase+'.stdout')).read_text().splitlines()
 values=[json.loads(line) for line in lines if line.strip()]
 assert values,'MISSING_OPERATION_RESULT';return values[-1]
def database_check(sequence):
 with sqlite3.connect('file:'+str(STATE/'data/product.sqlite')+'?mode=ro',uri=True) as db:
  assert db.execute('SELECT max(sequence) FROM schema_migration_ledger').fetchone()[0]==sequence
  assert db.execute("SELECT count(*) FROM runs WHERE status NOT IN ('completed','failed','cancelled')").fetchone()[0]==0,'CUTOVER_ACTIVE_RUNS'
  assert db.execute('SELECT count(*) FROM built_in_accounts').fetchone()[0]==0,'CUTOVER_IDENTITY_SCOPE_CHANGED'
  assert not db.execute('PRAGMA foreign_key_check').fetchall(),'CUTOVER_FOREIGN_KEY_FAILURE'
  for (value,) in db.execute('SELECT facts_json FROM sandbox_execution_records'):
   facts=json.loads(value);resource=facts.get('resource',{})
   assert resource.get('cleanup')=='confirmed' and resource.get('supervision')=='released','CUTOVER_SANDBOX_UNRESOLVED'
  for (value,) in db.execute('SELECT observation_json FROM sandbox_jobs'):
   observed=json.loads(value);assert observed.get('state') in ('completed','failed') and observed.get('cleanup')=='confirmed','CUTOVER_LEGACY_SANDBOX_UNRESOLVED'
def restore_file(name,destination):
 source=W/'private'/name;info=source.stat();fd,filename=tempfile.mkstemp(prefix='.native-history-restore-',dir=destination.parent)
 with os.fdopen(fd,'wb') as out,source.open('rb') as incoming:
  shutil.copyfileobj(incoming,out);out.flush();os.fchown(out.fileno(),info.st_uid,info.st_gid);os.fchmod(out.fileno(),stat.S_IMODE(info.st_mode));os.fsync(out.fileno())
 os.replace(filename,destination)
def private_copy(source,destination,uid=998,gid=998):
 incoming=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
 assert stat.S_ISREG(os.fstat(incoming).st_mode),'COPY_SOURCE_NOT_REGULAR'
 fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(incoming,'rb') as src,os.fdopen(fd,'wb') as out:
  shutil.copyfileobj(src,out);out.flush();os.fchown(out.fileno(),uid,gid);os.fsync(out.fileno())
def main():
 assert os.geteuid()==0 and sys.flags.optimize==0 and sys.argv[1:]==['--apply']
 assert socket.gethostname()=='hermes-home' and os.environ.get('INVOCATION_ID')
 assert command(['findmnt','-no','TARGET','--target',R]).stdout.strip()=='/data'
 assert shutil.disk_usage(R).free>10*1024**3
 assert not W.exists() and not ARCHIVE.exists(),'CUTOVER_ALREADY_ATTEMPTED'
 assert not (STATE/'deployment/production-prepared.json').exists(),'STALE_PREPARED_CONFIG'
 assert re.fullmatch('[0-9a-f]{64}',EXPECTED_RECEIPT),'QUALIFICATION_NOT_BOUND'
 assert command(['systemctl','is-active','himawari.service']).stdout.strip()=='active'
 assert command(['systemctl','show','himawari.service','-p','User','--value']).stdout.strip()=='himawari'
 qualified=json.loads((Q/'result.json').read_text());assert qualified['passed'] and json.loads((Q/'status.json').read_text())['passed'] is True
 assert sha(Q/'installation-receipt.json')==qualified['receiptDigest']==EXPECTED_RECEIPT
 assert json.loads(CANDIDATE_AUTH.read_text())['runtimeDigest']==qualified['runtimeDigest']
 assert plain(CANDIDATE).st_uid==0 and plain(CANDIDATE_AUTH).st_uid==0 and plain(AUTH).st_uid==0
 assert json.loads(AUTH.read_text())['runtimeDigest']==EXPECTED_CURRENT_RUNTIME,'CURRENT_INSTALLATION_CHANGED'
 for name,digest in INPUTS.items():assert sha(B/name)==digest,'REVIEWED_HELPER_CHANGED'
 assert sha(Q/'hermes-e2e-fixes-start.mjs')=='18a8d1732b2cdd834f84ff9f8ffe65b85b8f42d79a3811c5738c15a05ba0130e'
 original_unit=UNIT.read_text();old_exec='ExecStart='+str(RUNTIME/'pi-tools/bin/node')+' '+str(OLD_START)
 assert original_unit.count(old_exec)==1,'UNEXPECTED_SERVICE_UNIT'
 database_check(32)
 os.umask(0o077);W.mkdir(mode=0o711);W.chmod(0o711);(W/'private').mkdir(mode=0o700)
 for name,digest in INPUTS.items():
  shutil.copyfile(B/name,W/name);(W/name).chmod(0o644);assert sha(W/name)==digest,'COPIED_HELPER_CHANGED'
 for source,name in [(CONFIG,'production-before.json'),(UNIT,'unit-before.service'),(AUTH,'authority-before.json'),(ATTESTATION,'attestation-before.json')]:
  target=W/'private'/name;shutil.copy2(source,target);os.chown(target,source.stat().st_uid,source.stat().st_gid)
 stopped=False;swapped=False;new_started=False
 node=RUNTIME/'pi-tools/bin/node'
 common=['--config',CONFIG,'--secret-dir',STATE/'secrets']
 try:
  status('stopping_idle_service_for_verified_backup');stopped=True;command(['systemctl','stop','himawari.service'],90)
  assert command(['systemctl','show','himawari.service','-p','MainPID','--value']).stdout.strip()=='0'
  database_check(32)
  for action,option in [('create','--backup-id'),('verify','--backup')]:
   result=invoke('backup-'+action,[CURRENT/'bin/himawari','backup',action,*common,option,BACKUP_ID])
   assert result['backupId']==BACKUP_ID and result['schemaVersion']=='32' and result['fullIntegrityCheck']=='ok';publish('backup-'+action+'.json',result)
  # Let a normally stopped service's authority expire naturally if its lease has not been released.
  deadline=time.time()+125
  while True:
   with sqlite3.connect('file:'+str(STATE/'data/product.sqlite')+'?mode=ro',uri=True) as db:
    active=db.execute("SELECT count(*) FROM authority_leases WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')").fetchone()[0]
   if not active:break
   assert time.time()<deadline,'CUTOVER_AUTHORITY_NOT_RELEASED';time.sleep(1)
  status('preparing_qualified_startup_after_verified_backup')
  prepared=STATE/'deployment/production-prepared.json';private_copy(CONFIG,prepared)
  startup=invoke('prepare',[node,Q/'hermes-e2e-fixes-start.mjs','--prepare',prepared],True);assert startup['preparing'];assert startup['runtimeDigest']==qualified['runtimeDigest']
  registry=invoke('registered',[node,W/'hermes-protected-registered.mjs'],True);assert registry['registeredCapabilitiesUnchanged'];publish('registered-preflight.json',registry)
  database_check(32)
  status('switching_verified_installation')
  CURRENT.rename(ARCHIVE);swapped=True;CANDIDATE.rename(CURRENT)
  authority_next=AUTH.with_name('runtime.e2e-fixes-next.json');shutil.copyfile(CANDIDATE_AUTH,authority_next);authority_next.chmod(0o644);os.replace(authority_next,AUTH)
  os.replace(prepared,CONFIG)
  next_unit=UNIT.with_name('himawari.service.e2e-fixes-next');next_unit.write_text(original_unit.replace(old_exec,'ExecStart='+str(node)+' '+str(Q/'hermes-e2e-fixes-start.mjs')));next_unit.chmod(0o644);os.replace(next_unit,UNIT)
  command(['systemd-analyze','verify',UNIT]);command(['systemctl','daemon-reload'])
  offsets={name:(R/'logs'/f'{name}.log').stat().st_size for name in ['agent','worker']}
  status('starting_e2e_fixes_service');new_started=True;command(['systemctl','start','himawari.service'])
  ready=set();deadline=time.time()+300
  while time.time()<deadline:
   for name,offset in offsets.items():
    with (R/'logs'/f'{name}.log').open('rb') as f:f.seek(offset);data=f.read(4*1024*1024)
    if b'"event":"service.ready"' in data or b'"event": "service.ready"' in data:ready.add(name)
   if len(ready)==2:break
   time.sleep(1)
  assert ready=={'agent','worker'},'CUTOVER_SERVICE_NOT_READY'
  assert command(['systemctl','is-active','himawari.service']).stdout.strip()=='active'
  pid=command(['systemctl','show','himawari.service','-p','MainPID','--value']).stdout.strip();process_status=pathlib.Path('/proc')/pid/'status'
  live_process=process_status.read_text();assert re.search(r'^Uid:\s+998\s+998\s+998\s+998$',live_process,re.M) and re.search(r'^NoNewPrivs:\s+1$',live_process,re.M)
  publish('result.json',{'passed':True,'deploymentComplete':True,'schemaSequence':32,'historyReimported':False,'runtimeDigest':qualified['runtimeDigest'],'receiptDigest':EXPECTED_RECEIPT,'ready':sorted(ready),'runtimeUid':998,'backupId':BACKUP_ID,'modelCalls':0,'realModelAcceptance':'pending'})
  try:
   command(['systemd-run','--unit=himawari-e2e-fixes-live-observer','--property=RuntimeMaxSec=3700','/usr/bin/python3','-I',W/'hermes-e2e-fixes-observer.py'])
   publish('observer-start.json',{'started':True})
  except Exception as observer_error:
   publish('observer-start.json',{'started':False,'exceptionType':type(observer_error).__name__})
  status('deployment_completed_real_model_acceptance_pending')
 except BaseException as error:
  rollback={'attempted':False,'completed':False,'newServiceStartAttempted':new_started}
  try:
   if not new_started:restore_file('attestation-before.json',ATTESTATION)
   if new_started:
    command(['systemctl','stop','himawari.service'],90)
    rollback['reason']='preserve_post_start_data_for_diagnosis'
   elif stopped:
    rollback['attempted']=True
    prepared=STATE/'deployment/production-prepared.json'
    if prepared.exists():prepared.rename(W/'private/failed-prepared.json')
    if swapped:
     if CURRENT.exists():CURRENT.rename(W/'failed-installation')
     ARCHIVE.rename(CURRENT)
    restore_file('production-before.json',CONFIG);restore_file('unit-before.service',UNIT);restore_file('authority-before.json',AUTH)
    command(['systemctl','daemon-reload'])
    command(['systemctl','start','himawari.service'])
    rollback['originalServiceStarted']=True;rollback['completed']=True
  except BaseException as recovery_error:rollback['errorType']=type(recovery_error).__name__
  publish('exception.json',{'exceptionType':type(error).__name__,'messageCode':str(error) if re.fullmatch('[A-Z_]+',str(error)) else None,'rollback':rollback})
  status('cutover_failed_review_preserved_evidence');raise

if __name__=='__main__':
 assert os.geteuid()==0 and sys.flags.optimize==0
 fd=os.open('/run/himawari-e2e-fixes-cutover.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 assert os.fstat(fd).st_uid==0 and stat.S_ISREG(os.fstat(fd).st_mode)
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 main()
