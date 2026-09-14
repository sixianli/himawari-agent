#!/usr/bin/python3
"""Resume candidate qualification in a new evidence directory; never cut over production."""
import fcntl,hashlib,importlib.util,json,os,pathlib,shutil,socket,stat,subprocess,sys
BASE=pathlib.Path('/data/hermes/himawari')
BUILD=BASE/'builds/2026-09-11-native-history'
PREVIOUS=BASE/'qualifications/2026-09-11-native-history-installation'
ATTEMPT=PREVIOUS/'attempt-v2'
FROZEN_SHA='0ea487c3d9f4600abe0f17a5ba2a08df3d36890ca0696c189babea99bbc86481'

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def probe_environment(name,protected_environment):
 env=dict(protected_environment)
 # This one fixture signs its own temporary runtime. Keep full byte verification
 # for that runtime; the separate protection probe qualifies the installed runtime.
 if name=='composition-installed':env.pop('HIMAWARI_RUNTIME_PROTECTION_FILE',None)
 return env

def main():
 assert os.geteuid()==0 and sys.flags.optimize==0 and sys.argv[1:]==['--resume']
 assert socket.gethostname()=='hermes-home' and os.environ.get('INVOCATION_ID')
 frozen=BUILD/'hermes-native-history-qualify.py';assert sha(frozen)==FROZEN_SHA
 spec=importlib.util.spec_from_file_location('frozen_qualification',frozen)
 q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
 assert not ATTEMPT.exists(),'ATTEMPT_ALREADY_EXISTS'
 assert not (PREVIOUS/'result.json').exists(),'QUALIFICATION_ALREADY_COMPLETED'
 diagnostic=json.loads((PREVIOUS/'composition-diagnostic-v1/summary.json').read_text())
 assert diagnostic['originalUnboundErrorConfirmed'] and diagnostic['liveServiceUnchanged']
 assert diagnostic['diagnosticRan'] and diagnostic['exitCode']==1 and diagnostic['errorCodes']==['PORT_CONFLICT']
 def live():
  return {'active':subprocess.check_output(['systemctl','is-active','himawari.service'],text=True).strip(),
   'pid':subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True).strip(),
   'installation':[q.plain(q.CURRENT).st_dev,q.plain(q.CURRENT).st_ino],
   'auth':sha(q.AUTH),'config':sha(BASE/'config/production.json')}
 before=live();assert before['active']=='active'
 assert q.plain(q.CANDIDATE).st_uid==0 and q.plain(q.CANDIDATE_AUTH).st_uid==0
 manifest=json.loads((BUILD/'himawari-native-history-source.json').read_text())
 assert manifest['archiveSha256']=='8c55f24545a717065632a17efd1f4aed9af264811cf98f505883b0c01f3fda8a'
 def verify_source():
  for entry in manifest['files']:
   p=PREVIOUS/'probe-source'/entry['path']
   # Build-only omitted directories are not inputs to these probes.
   if p.exists():assert sha(p)==entry['sha256'],'QUALIFICATION_SOURCE_CHANGED'
  assert sha(PREVIOUS/'probe-source/test/qualification/sandbox-production-mac-probe.ts')==q.EXTRA_SOURCE_SHA
 verify_source()
 for name,digest in q.INPUTS.items():assert sha(PREVIOUS/name)==digest,'REVIEWED_HELPER_CHANGED'
 os.umask(0o077);ATTEMPT.mkdir(mode=0o711);ATTEMPT.chmod(0o711)
 (ATTEMPT/'private-output').mkdir(mode=0o700)
 (ATTEMPT/'probe-source').symlink_to(PREVIOUS/'probe-source',target_is_directory=True)
 q.Q=ATTEMPT
 try:
  stage=ATTEMPT/'seal-stage';stage.mkdir(mode=0o700);os.chown(stage,1000,1000)
  seal_text=(PREVIOUS/'hermes-native-history-seal.mjs').read_text()
  old='/qualifications/2026-09-11-native-history-installation/seal-stage'
  assert seal_text.count(old)==1
  seal_file=ATTEMPT/'hermes-native-history-seal.mjs'
  seal_file.write_text(seal_text.replace(old,old.replace('/seal-stage','/attempt-v2/seal-stage')));seal_file.chmod(0o644)
  q.status('verifying_candidate_and_signer')
  signer=q.run_user('andy','v2-signer-preflight',[q.RUNTIME/'pi-tools/bin/node',seal_file,'--preflight'],signer_view=True)
  workspace=q.plain(BASE/'workspaces/default')
  assert signer['passed'] and signer['workspaceDevice']==str(workspace.st_dev) and signer['workspaceInode']==str(workspace.st_ino)
  q.publish('signer-preflight.json',signer)
  digest=q.run_user('himawari','v2-digest',[q.RUNTIME/'pi-tools/bin/node',PREVIOUS/'runtime-digest.mjs'])['runtimeDigest']
  protection_record=json.loads(q.CANDIDATE_AUTH.read_text())
  assert protection_record['runtimeDigest']==digest and protection_record['runtimeRoot']==str(q.RUNTIME)
  env={'HIMAWARI_RUNTIME_PROTECTION_FILE':str(q.AUTH),'HIMAWARI_LIVE_SANDBOX_PROBE':'1','HIMAWARI_PROBE_RUNTIME':str(q.RUNTIME),'HIMAWARI_QUALIFY_INSTALLED_RUNTIME':str(q.RUNTIME),'HIMAWARI_PROBE_SCRATCH':str(q.SCRATCH)}
  protection=q.run_user('himawari','v2-protection',[q.RUNTIME/'pi-tools/bin/node',PREVIOUS/'probe-protected-runtime.mjs',q.AUTH,q.CURRENT/'protection-probe',q.SCRATCH],env)
  assert protection['passed'] and protection['fullAudits']==1
  q.publish('protected-runtime-probe.json',protection)
  q.publish('probe-environments.json',{name:{'protectedInstallationVerification':name!='composition-installed','temporaryRuntimeFullDigestVerification':name=='composition-installed'} for name,_ in q.PROBES})
  # Run the previously failing case first; retain all six results from this attempt.
  probes=sorted(q.PROBES,key=lambda item:item[0]!='composition-installed')
  for name,args in probes:
   q.status('qualifying_'+name)
   observation=q.run_user('himawari','v2-'+name,[q.RUNTIME/'pi-tools/bin/node',*args],probe_environment(name,env))
   target=stage/(name+'.json');shutil.copyfile(ATTEMPT/'private-output'/('v2-'+name+'.stdout'),target);os.chown(target,1000,1000);target.chmod(0o600)
  verify_source();q.status('signing_qualified_candidate')
  signed=q.run_user('andy','v2-seal',[q.RUNTIME/'pi-tools/bin/node',seal_file],signer_view=True)
  assert signed['runtimeDigest']==digest
  assert live()==before,'LIVE_SERVICE_CHANGED'
  names=[name+'.json' for name,_ in q.PROBES]+['installation-receipt.json','installation-receipt.sig','host-qualification-public-key.pem','pi-runner.sig','search-runner.sig']
  assert all(not (PREVIOUS/name).exists() for name in names),'PUBLISHED_EVIDENCE_ALREADY_EXISTS'
  for name in names:shutil.copyfile(stage/name,PREVIOUS/name);(PREVIOUS/name).chmod(0o644)
  result={'passed':True,'attempt':'attempt-v2','candidatePrefix':str(q.CANDIDATE),'qualifiedRuntimePath':str(q.RUNTIME),'runtimeDigest':digest,'receiptDigest':signed['receiptDigest'],'runtimeUid':998,'productionServiceChanged':False,'productionDatabaseWritten':False,'modelCalls':0,'next':'verified backup, offline migration/import and cutover still required'}
  q.publish('result.json',result);q.status('candidate_qualified_live_service_unchanged',True)
  destination=PREVIOUS/'result.json';destination.write_text(json.dumps(result,indent=2)+'\n');destination.chmod(0o644)
 except BaseException as error:
  q.publish('exception.json',{'exceptionType':type(error).__name__,'liveServiceUnchanged':live()==before})
  q.status('qualification_failed_live_service_unchanged',False);raise

if __name__=='__main__':
 assert os.geteuid()==0 and sys.flags.optimize==0
 fd=os.open('/run/himawari-native-history-qualification.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 assert os.fstat(fd).st_uid==0 and stat.S_ISREG(os.fstat(fd).st_mode)
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 main()
