#!/usr/bin/python3
"""Restore the previous installation after a failed startup; never restore the database."""
import fcntl,hashlib,json,os,pathlib,runpy,shutil,socket,sqlite3,stat,subprocess,sys,time

R=pathlib.Path('/data/hermes/himawari')
B=R/'builds/2026-09-12-three-fixes'
W=R/'qualifications/2026-09-12-three-fixes-cutover'
RECOVERY=R/'qualifications/2026-09-12-three-fixes-recovery'
EXPECTED='a83239f95583c9c82264059c40e9f59bfddc5355017caedb62affedf4b441a56'
CUTOVER_SHA='cf84158fea5d0c000c7ac3d841b540612664b5ac825b8fbf11b9bbf248777235'

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def command(args):return subprocess.check_output(list(map(str,args)),text=True,stderr=subprocess.STDOUT,timeout=90)
def publish(name,value):
 p=RECOVERY/name
 with p.open('x') as f:json.dump(value,f,indent=2);f.write('\n');os.fchmod(f.fileno(),0o644)

def main():
 assert os.geteuid()==0 and sys.flags.optimize==0 and sys.argv[1:]==['--restore-installation-only']
 assert socket.gethostname()=='hermes-home' and os.environ.get('INVOCATION_ID')
 assert command(['findmnt','-no','TARGET','--target',R]).strip()=='/data'
 assert not RECOVERY.exists()
 assert sha(B/'hermes-three-fixes-cutover.py')==CUTOVER_SHA
 assert sha(B/'hermes-three-fixes-startup-diagnostic.py')=='345add3651f891630ce80930649ef8da87eee31892aa93c26bdde662054fb179'
 q=runpy.run_path(str(B/'hermes-three-fixes-cutover.py'))
 assert json.loads((W/'exception.json').read_text())['messageCode']=='CUTOVER_SERVICE_NOT_READY'
 assert json.loads((W/'status.json').read_text())['phase']=='cutover_failed_review_preserved_evidence'
 assert json.loads(q['AUTH'].read_text())['runtimeDigest']==EXPECTED
 assert json.loads((W/'private/authority-before.json').read_text())['runtimeDigest']==q['EXPECTED_CURRENT_RUNTIME']
 assert q['plain'](q['ARCHIVE']).st_uid==0 and q['plain'](q['CURRENT']).st_uid==0
 q['database_check'](32)
 with sqlite3.connect('file:'+str(q['STATE']/'data/product.sqlite')+'?mode=ro',uri=True) as db:
  assert db.execute('SELECT count(*) FROM runs WHERE created_at>=?',('2026-09-12T12:04:51.000Z',)).fetchone()[0]==0,'NEW_RUNS_REQUIRE_REVIEW'
 os.umask(0o077);RECOVERY.mkdir(mode=0o711);RECOVERY.chmod(0o711);(RECOVERY/'private').mkdir(mode=0o700)
 try:
  command(['systemctl','stop','himawari.service'])
  assert command(['systemctl','show','himawari.service','-p','MainPID','--value']).strip()=='0'
  q['database_check'](32)
  # Capture the failed startup before restarting; only the fixed redacted reader runs.
  diagnostic=runpy.run_path(str(B/'hermes-three-fixes-startup-diagnostic.py'))
  original_argv=sys.argv;sys.argv=[original_argv[0],'--read-startup-errors']
  try:diagnostic['main']()
  finally:sys.argv=original_argv
  for key in ('CONFIG','UNIT','AUTH','ATTESTATION'):
   source=q[key];shutil.copy2(source,RECOVERY/'private'/source.name)
  q['CURRENT'].rename(RECOVERY/'failed-installation');q['ARCHIVE'].rename(q['CURRENT'])
  for name,key in (('production-before.json','CONFIG'),('unit-before.service','UNIT'),('authority-before.json','AUTH'),('attestation-before.json','ATTESTATION')):
   q['restore_file'](name,q[key])
  offsets={name:(R/'logs'/(name+'.log')).stat().st_size for name in ('agent','worker')}
  command(['systemctl','daemon-reload']);command(['systemctl','start','himawari.service'])
  ready=set();deadline=time.time()+300
  while time.time()<deadline:
   for name,offset in offsets.items():
    with (R/'logs'/(name+'.log')).open('rb') as f:f.seek(offset);data=f.read(1024*1024)
    if b'"event":"service.ready"' in data or b'"event": "service.ready"' in data:ready.add(name)
   if len(ready)==2:break
   time.sleep(1)
  assert ready=={'agent','worker'},'PREVIOUS_SERVICE_NOT_READY'
  assert command(['systemctl','is-active','himawari.service']).strip()=='active'
  publish('result.json',{'passed':True,'previousInstallationRestored':True,'databaseRestored':False,'schemaSequence':32,'ready':sorted(ready),'modelCalls':0,'failedInstallationPreserved':True})
 except BaseException as error:
  publish('exception.json',{'type':type(error).__name__});raise

if __name__=='__main__':
 assert os.geteuid()==0 and sys.flags.optimize==0
 fd=os.open('/run/himawari-three-fixes-cutover.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 assert os.fstat(fd).st_uid==0 and stat.S_ISREG(os.fstat(fd).st_mode)
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 main()
