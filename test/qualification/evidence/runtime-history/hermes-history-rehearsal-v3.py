#!/usr/bin/python3
"""Validate the actual account/namespace before rehearsing a protected database copy."""
import hashlib,json,os,pathlib,pwd,re,shutil,socket,stat,subprocess,sys
R=pathlib.Path('/data/hermes/himawari')
B=R/'builds/2026-09-11-native-history'
Q=R/'qualifications/2026-09-11-native-history-rehearsal-v3'
C=R/'qualifications/2026-09-11-protected/attempt-v5/native-history-import-candidate.json'
RUNTIME=B/'prefix/lib/himawari-agent'
INPUTS={'rehearse-legacy-history.mjs': '5540cffea2277be964bdbf190bbe9d53c88e656d3b0971b4335548dff59cf0cc', 'test-rehearse-legacy-history.mjs': '7fee852e3e90f787880686882018ed38770d90ac027b1e3865fe22baffaca237'}
NODE_SOURCE="\nimport assert from 'node:assert/strict';\nimport {readFile} from 'node:fs/promises';\nimport {createRequire} from 'node:module';\nimport {rehearseLegacyHistory} from '/data/hermes/himawari/qualifications/2026-09-11-native-history-rehearsal-v3/rehearse-legacy-history.mjs';\nconst root='/data/hermes/himawari', q=root+'/qualifications/2026-09-11-native-history-rehearsal-v3';\nconst runtime='/opt/himawari-native-history';\nconst require=createRequire(runtime+'/package.json');\nconst {EnvelopePayloadProtector,SystemdCredentialSecretSource}=require('@himawari-agent/platform-node');\nconst config=JSON.parse(await readFile(root+'/config/production.json','utf8'));\nassert.equal(config.ownerId,'owner-james-26b80231-cdeb-4ad9-bb02-850541005fff');\nassert.equal(config.agentId,'agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3');\nassert.equal(config.deploymentId,'deployment-hermes-9e8dc197-146e-4465-bbd1-4246eb2fc96f');\nassert.equal(config.stateRoot,root+'/state');\nconst keys=config.secretReferences.filter(x=>x.purpose==='payload-encryption');assert.equal(keys.length,1);\nconst protector=new EnvelopePayloadProtector({keys:new SystemdCredentialSecretSource(root+'/state/secrets'),activeKey:{keyRef:keys[0].ref,kekVersion:keys[0].version,dekVersion:'dek-v1'}});\nconst sealed=JSON.parse(await readFile(q+'/work/candidate.json','utf8'));\nconsole.log(JSON.stringify(await rehearseLegacyHistory({runtime,sourceState:config.stateRoot,work:q+'/work/result',config,sealed,protector})));\n"

def summarize(text):
 result={'lineCount':len(text.splitlines()),'errorTypes':sorted(set(re.findall(r'\b(?:[A-Za-z]+Error|Error)(?=[:\[])',text))),
  'codes':sorted(set(re.findall(r"\bcode:\s*['\"]([A-Z][A-Z0-9_]{1,79})['\"]",text))),
  'patterns':[],'stackFrames':[],'modulePaths':[],'sourceLocations':[]}
 patterns={'module_not_found':r'Cannot find (?:module|package)','readonly_filesystem':r'EROFS|read-only file system','readonly_database':r'readonly database','permission_denied':r'Permission denied|permission denied|EACCES','invalid_input_type':r'ERR_INPUT_TYPE_NOT_ALLOWED','syntax_error':r'SyntaxError','not_a_function':r'not a function','assertion':r'AssertionError','missing_file':r'ENOENT','invalid_json':r'JSON at position|in JSON|Unexpected token'}
 for label,pattern in patterns.items():
  if re.search(pattern,text):result['patterns'].append(label)
 for line in text.splitlines():
  m=re.search(r'(?:file://)?((?:/[^\s():]+|node:[^\s()]+)):(\d+):(\d+)\)?$',line)
  if m and line.lstrip().startswith('at '):
   filename=m[1].split('/')[-1]
   if re.fullmatch(r'[A-Za-z0-9_.:-]+',filename):result['stackFrames'].append({'file':filename,'line':int(m[2]),'column':int(m[3])})
 for line in text.splitlines():
  m=re.fullmatch(r'(?:file://)?(/[^\s:]+):(\d+)(?::(\d+))?',line.strip())
  if m:
   filename=m[1].split('/')[-1]
   if re.fullmatch(r'[A-Za-z0-9_.-]+',filename):result['sourceLocations'].append({'file':filename,'line':int(m[2])})
 for value in re.findall(r"Cannot find (?:module|package) ['\"]([^'\"\n]+)['\"]",text):
  if (value.startswith(('@himawari-agent/','@earendil-works/','/opt/himawari-native-history/')) and re.fullmatch(r'[A-Za-z0-9@/_.:-]+',value)):
   result['modulePaths'].append(value)
 return result


def publish(name,value):
 p=Q/name
 with p.open('x') as handle:json.dump(value,handle,indent=2)
 p.chmod(0o644)

def run_child(phase,argv,work):
 props=['User=himawari','Group=himawari','NoNewPrivileges=yes','CapabilityBoundingSet=',
  'PrivateNetwork=yes','ProtectSystem=strict','PrivateTmp=yes','UMask=0077','RuntimeMaxSec=600','WorkingDirectory=/',
  'TemporaryFileSystem=/data/hermes:ro,mode=0755',
  'BindReadOnlyPaths='+str(R)+' '+str(RUNTIME)+':/opt/himawari-native-history',
  'ReadWritePaths='+str(work)]
 command=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=himawari-history-v3-'+phase]
 for prop in props:command+=['--property='+prop]
 command+=['/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C.UTF-8','HOME='+str(work),'TMPDIR='+str(work),
  '/opt/himawari-native-history/pi-tools/bin/node',*map(str,argv)]
 error=Q/(phase+'.private.stderr')
 with error.open('x') as handle:
  result=subprocess.run(command,stdin=subprocess.DEVNULL,text=True,stdout=subprocess.PIPE,stderr=handle,timeout=630)
 if result.returncode:
  publish('summary.json',{'passed':False,'phase':phase,'exitCode':result.returncode,**summarize(error.read_text(errors='replace'))})
  return None
 try:return json.loads(result.stdout)
 except json.JSONDecodeError:
  # Preserve privately; public output contains no arbitrary process text.
  (Q/(phase+'.private.stdout')).write_text(result.stdout)
  publish('summary.json',{'passed':False,'phase':phase,'reason':'OUTPUT_NOT_JSON'})
  return None

def main():
 assert len(sys.argv)==1 and os.geteuid()==0 and socket.gethostname()=='hermes-home'
 assert subprocess.check_output(['findmnt','-no','TARGET','--target',str(R)],text=True).strip()=='/data'
 assert shutil.disk_usage(R).free>8*1024**3
 assert not Q.exists(),'REHEARSAL_ALREADY_EXISTS'
 assert C.resolve()==C and C.is_file() and C.stat().st_uid==0 and not C.stat().st_mode&0o077
 diagnostic=json.loads((R/'qualifications/2026-09-11-native-history-rehearsal-v2/diagnostic.json').read_text())
 assert diagnostic['codes']==['MODULE_NOT_FOUND'] and diagnostic['modulePaths']==['@himawari-agent/platform-node']
 assert not diagnostic['progress']['work/result']['exists']
 for name,digest in INPUTS.items():
  p=pathlib.Path(__file__).with_name(name)
  assert p.is_file() and not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==digest
 ready=json.loads((B/'status.json').read_text());assert ready['passed'] and ready['phase']=='candidate-built'
 assert ready['sourceArchiveSha256']=='8c55f24545a717065632a17efd1f4aed9af264811cf98f505883b0c01f3fda8a'
 tested=json.loads((B/'namespace-self-test-v2.json').read_text());assert tested['testsPassed']==3 and tested['positive']['passed']
 # The bound root itself must be traversable by the runtime account; do not bind its private parents.
 for p in [RUNTIME,*RUNTIME.rglob('*')]:
  s=p.lstat();assert not stat.S_ISLNK(s.st_mode),'RUNTIME_SYMLINK'
  assert (stat.S_ISDIR(s.st_mode) and s.st_mode&5==5) or (stat.S_ISREG(s.st_mode) and s.st_mode&4==4),'RUNTIME_ACCESS_INVALID'
 assert subprocess.check_output(['systemctl','show','himawari.service','-p','User','--value'],text=True).strip()=='himawari'
 user=pwd.getpwnam('himawari');assert user.pw_uid==998 and user.pw_gid==998
 os.umask(0o077);Q.mkdir(mode=0o711);Q.chmod(0o711)
 for name in INPUTS:
  shutil.copyfile(pathlib.Path(__file__).with_name(name),Q/name);(Q/name).chmod(0o644)
 work=Q/'work';work.mkdir(mode=0o700);os.chown(work,user.pw_uid,user.pw_gid)
 check=run_child('self-test',[Q/'test-rehearse-legacy-history.mjs','/opt/himawari-native-history'],work)
 if check is None:return
 assert check['testsPassed']==3 and check['positive']['passed'] and check['sourceSchemaUnchanged']
 publish('actual-account-self-test.json',check)
 shutil.copyfile(C,work/'candidate.json');os.chown(work/'candidate.json',user.pw_uid,user.pw_gid);(work/'candidate.json').chmod(0o600)
 entry=Q/'entry.mjs';entry.write_text(NODE_SOURCE);entry.chmod(0o644)
 report=run_child('real-copy',[entry],work)
 if report is None:return
 assert report['scope']=='isolated database rehearsal only' and report['modelCalls']==0 and report['productionDatabaseWritten']==False
 publish('summary.json',report)
 print('Rehearsal summary written: '+str(Q/'summary.json'))
if __name__=='__main__':main()
