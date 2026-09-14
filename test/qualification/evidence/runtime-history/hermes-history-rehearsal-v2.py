#!/usr/bin/python3
"""Rehearse schema/history on an isolated copy. Never change product database or service."""
import hashlib,json,os,pathlib,pwd,re,shutil,socket,subprocess,sys
R=pathlib.Path('/data/hermes/himawari')
B=R/'builds/2026-09-11-native-history'
PREVIOUS=R/'qualifications/2026-09-11-native-history-rehearsal'
Q=R/'qualifications/2026-09-11-native-history-rehearsal-v2'
C=R/'qualifications/2026-09-11-protected/attempt-v5/native-history-import-candidate.json'
MODULE=pathlib.Path(__file__).with_name('rehearse-legacy-history-v2.mjs')
MODULE_SHA='5540cffea2277be964bdbf190bbe9d53c88e656d3b0971b4335548dff59cf0cc'
ARCHIVE_SHA='8c55f24545a717065632a17efd1f4aed9af264811cf98f505883b0c01f3fda8a'
NODE_SOURCE='''
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {rehearseLegacyHistory} from '/data/hermes/himawari/qualifications/2026-09-11-native-history-rehearsal-v2/rehearse-legacy-history-v2.mjs';
const root='/data/hermes/himawari', q=root+'/qualifications/2026-09-11-native-history-rehearsal-v2';
const runtime='/opt/himawari-native-history/lib/himawari-agent';
const require=createRequire(runtime+'/package.json');
const {EnvelopePayloadProtector,SystemdCredentialSecretSource}=require('@himawari-agent/platform-node');
const config=JSON.parse(await readFile(root+'/config/production.json','utf8'));
assert.equal(config.ownerId,'owner-james-26b80231-cdeb-4ad9-bb02-850541005fff');
assert.equal(config.agentId,'agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3');
assert.equal(config.deploymentId,'deployment-hermes-9e8dc197-146e-4465-bbd1-4246eb2fc96f');
assert.equal(config.stateRoot,root+'/state');
const keys=config.secretReferences.filter(x=>x.purpose==='payload-encryption');assert.equal(keys.length,1);
const protector=new EnvelopePayloadProtector({keys:new SystemdCredentialSecretSource(root+'/state/secrets'),activeKey:{keyRef:keys[0].ref,kekVersion:keys[0].version,dekVersion:'dek-v1'}});
const sealed=JSON.parse(await readFile(q+'/work/candidate.json','utf8'));
console.log(JSON.stringify(await rehearseLegacyHistory({runtime,sourceState:config.stateRoot,work:q+'/work/result',config,sealed,protector})));
'''

def main():
 assert len(sys.argv)==1 and os.geteuid()==0 and socket.gethostname()=='hermes-home'
 assert subprocess.check_output(['findmnt','-no','TARGET','--target',str(R)],text=True).strip()=='/data'
 assert shutil.disk_usage(R).free>8*1024**3
 assert not Q.exists(),'REHEARSAL_ALREADY_EXISTS'
 assert C.resolve()==C and C.is_file() and C.stat().st_uid==0 and not C.stat().st_mode&0o077
 assert MODULE.is_file() and not MODULE.is_symlink() and hashlib.sha256(MODULE.read_bytes()).hexdigest()==MODULE_SHA
 ready=json.loads((B/'status.json').read_text());assert ready['phase']=='candidate-built' and ready['passed'] and ready['sourceArchiveSha256']==ARCHIVE_SHA
 tested=json.loads((B/'rehearsal-self-test-v2.json').read_text());assert tested['testsPassed']==3 and tested['positive']['passed'] and tested['sourceSchemaUnchanged']
 assert subprocess.check_output(['systemctl','show','himawari.service','-p','User','--value'],text=True).strip()=='himawari'
 user=pwd.getpwnam('himawari');assert user.pw_uid==998 and user.pw_gid==998
 os.umask(0o077)
 previous_error=PREVIOUS/'private.stderr'
 assert previous_error.resolve()==previous_error and previous_error.stat().st_uid==0 and not previous_error.stat().st_mode&0o077
 old_codes=sorted(set(re.findall(r'\b(?:ERR_[A-Z_]+|IMPORT_[A-Z_]+|REHEARSAL_[A-Z_]+|SQLITE_[A-Z_]+|EACCES|EPERM|ENOENT)\b',previous_error.read_text(errors='replace'))))
 Q.mkdir(mode=0o711);Q.chmod(0o711)
 (Q/'previous-error-summary.json').write_text(json.dumps({'errorCodes':old_codes}));(Q/'previous-error-summary.json').chmod(0o644)
 if old_codes != ['ERR_INPUT_TYPE_NOT_ALLOWED']:
  (Q/'summary.json').write_text(json.dumps({'passed':False,'reason':'PREVIOUS_FAILURE_NOT_MATCHED','errorCodes':old_codes}));(Q/'summary.json').chmod(0o644)
  print('Previous failure differs; see '+str(Q/'previous-error-summary.json'));return
 entry=Q/'entry.mjs';entry.write_text(NODE_SOURCE);entry.chmod(0o644)
 shutil.copyfile(MODULE,Q/MODULE.name);(Q/MODULE.name).chmod(0o644)
 work=Q/'work';work.mkdir(mode=0o700);os.chown(work,user.pw_uid,user.pw_gid)
 shutil.copyfile(C,work/'candidate.json');os.chown(work/'candidate.json',user.pw_uid,user.pw_gid);(work/'candidate.json').chmod(0o600)
 command=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=himawari-native-history-rehearsal-v2-child',
 '--property=User=himawari','--property=Group=himawari','--property=NoNewPrivileges=yes','--property=CapabilityBoundingSet=',
 '--property=PrivateNetwork=yes','--property=ProtectSystem=strict','--property=PrivateTmp=yes','--property=UMask=0077',
 '--property=RuntimeMaxSec=600','--property=WorkingDirectory=/',
 '--property=TemporaryFileSystem=/data/hermes:ro,mode=0755',
 '--property=BindReadOnlyPaths='+str(R),
 '--property=BindReadOnlyPaths='+str(B/'prefix')+':/opt/himawari-native-history',
 '--property=ReadWritePaths='+str(work),
 str(R/'releases/2026-09-11-control-center/lib/himawari-agent/pi-tools/bin/node'),str(entry)]
 with (Q/'private.stderr').open('x') as error:
  result=subprocess.run(command,stdin=subprocess.DEVNULL,text=True,stdout=subprocess.PIPE,stderr=error,timeout=630)
 if result.returncode:
  private=(Q/'private.stderr').read_text(errors='replace')
  report={'passed':False,'exitCode':result.returncode,'errorCodes':sorted(set(re.findall(r'\b(?:ERR_[A-Z_]+|IMPORT_[A-Z_]+|REHEARSAL_[A-Z_]+|SQLITE_[A-Z_]+|EACCES|EPERM|ENOENT)\b',private)))}
 else:
  report=json.loads(result.stdout);assert report['scope']=='isolated database rehearsal only' and report['modelCalls']==0 and report['productionDatabaseWritten']==False
 (Q/'summary.json').write_text(json.dumps(report,indent=2));(Q/'summary.json').chmod(0o644)
 print('Rehearsal summary written: '+str(Q/'summary.json'))
if __name__=='__main__':main()
