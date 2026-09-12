#!/usr/bin/python3
"""Read failed synthetic qualification and rerun that probe with code-only child diagnostics."""
import hashlib,json,os,pathlib,re,shutil,socket,stat,subprocess,sys
R=pathlib.Path('/data/hermes/himawari')
B=R/'builds/2026-09-11-native-history'
Q=R/'qualifications/2026-09-11-native-history-installation'
D=Q/'composition-diagnostic-v1'
CURRENT=R/'releases/2026-09-11-control-center'
CANDIDATE=R/'releases/2026-09-11-native-history'
RUNTIME=CURRENT/'lib/himawari-agent'
AUTH=pathlib.Path('/etc/himawari/runtime.json')
CANDIDATE_AUTH=pathlib.Path('/etc/himawari/native-history-candidate.json')
OBSERVER_SHA='712c1204d171404a5e490c19314719e595338d12b624521b5c5f4676ab8af2ff'

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def live():
 return {'active':subprocess.check_output(['systemctl','is-active','himawari.service'],text=True).strip(),
 'pid':subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True).strip(),
 'config':sha(R/'config/production.json'),'authority':sha(AUTH),
 'installation':[CURRENT.stat().st_dev,CURRENT.stat().st_ino]}
def main():
 assert os.geteuid()==0 and sys.flags.optimize==0 and sys.argv[1:]==[]
 assert socket.gethostname()=='hermes-home' and os.environ.get('INVOCATION_ID'),'DETACHED_SYSTEMD_REQUIRED'
 assert not D.exists(),'DIAGNOSTIC_ALREADY_EXISTS'
 assert sha(B/'hermes-native-history-qualify.py')=='0ea487c3d9f4600abe0f17a5ba2a08df3d36890ca0696c189babea99bbc86481'
 observer=B/'hermes-job-host-diagnostic.mjs';assert sha(observer)==OBSERVER_SHA
 assert json.loads((Q/'failure.json').read_text())['phase']=='composition-installed'
 original=(Q/'private-output/composition-installed.stderr').read_text(errors='replace')
 before=live();assert before['active']=='active'
 os.umask(0o077);D.mkdir(mode=0o711);D.chmod(0o711)
 summary={'originalUnboundErrorConfirmed':'ApplicationPortError: Sandbox runtime has not been bound' in original,
 'originalErrorCodes':sorted(set(re.findall(r"code:\s*['\"]([A-Z][A-Z0-9_]+)['\"]",original))),
 'productionDatabaseWritten':False,'modelCalls':0,'diagnosticRan':False}
 if summary['originalUnboundErrorConfirmed']:
  for p in (Q,CANDIDATE,CANDIDATE_AUTH):
   s=p.lstat();assert s.st_uid==0 and not stat.S_ISLNK(s.st_mode) and not s.st_mode&0o022
  target=D/observer.name;shutil.copyfile(observer,target);target.chmod(0o644)
  properties=['User=himawari','Group=himawari','NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=',
   'UMask=0077','RuntimeMaxSec=900','WorkingDirectory='+str(Q/'probe-source'),
   'TemporaryFileSystem=/data/hermes:ro,mode=0755',
   'BindPaths='+str(R)+' '+str(CANDIDATE)+':'+str(CURRENT)+' '+str(CANDIDATE_AUTH)+':'+str(AUTH)]
  cmd=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=himawari-history-composition-diagnostic-child']
  for prop in properties:cmd+=['--property='+prop]
  scratch='/data/himawari-r8-protected'
  env={'PATH':str(RUNTIME/'pi-tools/bin')+':/usr/bin:/bin','HOME':scratch,'TMPDIR':scratch,'LANG':'C.UTF-8',
   'HIMAWARI_RUNTIME_PROTECTION_FILE':str(AUTH),'HIMAWARI_LIVE_SANDBOX_PROBE':'1',
   'HIMAWARI_PROBE_RUNTIME':str(RUNTIME),'HIMAWARI_QUALIFY_INSTALLED_RUNTIME':str(RUNTIME),'HIMAWARI_PROBE_SCRATCH':scratch}
  cmd+=['/usr/bin/env','-i',*[k+'='+v for k,v in env.items()],str(RUNTIME/'pi-tools/bin/node'),'--import',str(target),'packages/runtime-sandbox/scripts/qualify-production.mjs','--v2']
  with (D/'stdout.private').open('x') as out,(D/'stderr.private').open('x') as err:
   result=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=out,stderr=err,timeout=930)
  error=(D/'stderr.private').read_text(errors='replace')
  summary.update(diagnosticRan=True,exitCode=result.returncode,
   jobHostCodes=sorted(set(re.findall(r'^QUALIFICATION_DIAGNOSTIC:(JOB_HOST_[A-Z0-9_]+)$',error,re.M))),
   errorCodes=sorted(set(re.findall(r"code:\s*['\"]([A-Z][A-Z0-9_]+)['\"]",error))))
  if result.returncode==0:
   result_json=json.loads((D/'stdout.private').read_text());summary['probePassed']=result_json.get('productionSandboxProbePassed') is True;summary['cleanup']=result_json.get('cleanup')
 summary['liveServiceUnchanged']=live()==before
 p=D/'summary.json';p.write_text(json.dumps(summary,indent=2)+'\n');p.chmod(0o644)
 print('Diagnostic summary: '+str(p),flush=True)
 assert summary['liveServiceUnchanged']
if __name__=='__main__':main()
