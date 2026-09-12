#!/usr/bin/python3
"""Complete the missing web artifact and preflight it before another cutover."""
import fcntl,hashlib,importlib.util,json,os,pathlib,shutil,socket,stat,subprocess,sys

R=pathlib.Path('/data/hermes/himawari')
B=R/'builds/2026-09-12-three-fixes'
RECOVERY=R/'qualifications/2026-09-12-three-fixes-recovery'
PREFLIGHT=R/'qualifications/2026-09-12-three-fixes-static-preflight'
FILES={
 'index.html':'207a5f17812b13459dafde85e818d56a8558d6c98b866aade1f6fbf15665055a',
 'assets/ja-CYkHIGdT.js':'aef85dc5ccad117f59f2ee9e49c13f56904c2c11863ebae70d30e83a00315c8a',
 'assets/index-BQ7wuh-9.js':'0333ebae59b5d0001b007d134fe3a48f2b0e44aabba77e2aeb553246c15e1817',
 'assets/index-B32F2PDK.css':'e5f55053f721233e9110ae1dcb1b80bf1740492bd95d39973ce8218f0caaec1d',
 'assets/logo-symbol-light-DDULTiXD.png':'62ae5ef7b6cf6fb98cea007bfaba986d9b62f2745b7a579c26977b4ecc11015b',
 'assets/en-BGDC4yOB.js':'c15a0296a871960ae8f61498c9082559ea298424b197bee6f8e9a9ee31ab7bb5',
}

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def verify_web(root):
 assert root.is_dir() and root.resolve()==root,'STATIC_ROOT_MISSING_OR_LINKED'
 assert {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}==set(FILES),'STATIC_FILE_SET_CHANGED'
 for name,digest in FILES.items():
  p=root/name;info=p.lstat()
  assert p.resolve()==p and stat.S_ISREG(info.st_mode) and info.st_nlink==1,'STATIC_FILE_UNSAFE'
  assert sha(p)==digest,'STATIC_FILE_CHANGED'

def main():
 assert os.geteuid()==0 and sys.flags.optimize==0 and sys.argv[1:]==['--apply','--receipt','07c87d57b8a86f4c2a68c17cdf8678dbb36851f89273588914deeb0db92f38c1']
 assert socket.gethostname()=='hermes-home' and os.environ.get('INVOCATION_ID')
 assert subprocess.check_output(['findmnt','-no','TARGET','--target',str(R)],text=True).strip()=='/data'
 assert not PREFLIGHT.exists(),'STATIC_PREFLIGHT_ALREADY_ATTEMPTED'
 assert json.loads((RECOVERY/'result.json').read_text())['previousInstallationRestored'] is True
 frozen=B/'hermes-three-fixes-cutover.py'
 assert sha(frozen)=='cf84158fea5d0c000c7ac3d841b540612664b5ac825b8fbf11b9bbf248777235'
 spec=importlib.util.spec_from_file_location('frozen_cutover',frozen);q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
 q.W=R/'qualifications/2026-09-12-three-fixes-cutover-attempt-v2'
 q.CANDIDATE=RECOVERY/'failed-installation'
 q.BACKUP_ID='before-three-fixes-2026-09-12-v2'
 assert not q.W.exists() and not q.ARCHIVE.exists()
 assert q.plain(q.CANDIDATE).st_uid==0
 static_root=q.CURRENT/'share/control-center'
 assert json.loads(q.CONFIG.read_text())['http']['staticRoot']==str(static_root),'STATIC_ROOT_CONFIGURATION_CHANGED'
 verify_web(B/'apps/control-center/dist');verify_web(static_root)
 assert not (q.CANDIDATE/'share').exists(),'CANDIDATE_STATIC_ALREADY_PRESENT'
 original_pid=subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True).strip()
 assert original_pid!='0'
 os.umask(0o077);PREFLIGHT.mkdir(mode=0o711);PREFLIGHT.chmod(0o711)
 (q.CANDIDATE/'share').mkdir(mode=0o755);(q.CANDIDATE/'share').chmod(0o755)
 target=q.CANDIDATE/'share/control-center';shutil.copytree(B/'apps/control-center/dist',target)
 verify_web(target)
 for p in [target,*target.rglob('*')]:
  os.chown(p,0,998);p.chmod(0o755 if p.is_dir() else 0o644)
 source=r'''import assert from "node:assert/strict";
import {readFile,realpath,lstat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
const [root,runtime,files]=JSON.parse(process.argv[2]);
assert.equal(process.getuid(),998); assert.equal(await realpath(root),root);
for(const [name,digest] of Object.entries(files)) {
 const p=root+"/"+name; assert.equal(await realpath(p),p); assert((await lstat(p)).isFile());
 assert.equal(createHash("sha256").update(await readFile(p)).digest("hex"),digest);
}
const html=await readFile(root+"/index.html","utf8");
for(const match of html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)) assert(files[match[1].slice(1)]);
const require=createRequire(runtime+"/package.json");
const {digestSandboxRuntime}=require("@himawari-agent/platform-node");
const runtimeDigest=await digestSandboxRuntime(runtime);
assert.equal(runtimeDigest,"a83239f95583c9c82264059c40e9f59bfddc5355017caedb62affedf4b441a56");
console.log(JSON.stringify({passed:true,runtimeUid:process.getuid(),runtimeDigest,staticFiles:Object.keys(files).length}));
'''
 script=PREFLIGHT/'verify.mjs';script.write_text(source);script.chmod(0o644)
 args=['systemd-run','--quiet','--wait','--pipe','--collect','--unit=himawari-three-fixes-static-check',
  '--property=User=himawari','--property=Group=himawari','--property=NoNewPrivileges=yes','--property=CapabilityBoundingSet=',
  '--property=AmbientCapabilities=','--property=RuntimeMaxSec=120','--property=TemporaryFileSystem=/data/hermes:ro,mode=0755',
  '--property=BindPaths='+str(R)+' '+str(q.CANDIDATE)+':'+str(q.CURRENT),
  str(q.RUNTIME/'pi-tools/bin/node'),str(script),json.dumps([str(static_root),str(q.RUNTIME),FILES])]
 with (PREFLIGHT/'private.stderr').open('x') as errors:
  result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=errors,text=True,timeout=150)
 assert result.returncode==0,'CANDIDATE_STATIC_PREFLIGHT_FAILED'
 report=json.loads(result.stdout);assert report['passed'] is True
 assert subprocess.check_output(['systemctl','show','himawari.service','-p','MainPID','--value'],text=True).strip()==original_pid,'LIVE_SERVICE_CHANGED_DURING_PREFLIGHT'
 p=PREFLIGHT/'result.json';p.write_text(json.dumps(report,indent=2)+'\n');p.chmod(0o644)
 print('Static artifact and unchanged signed runtime verified before stopping service',flush=True)
 q.main()

if __name__=='__main__':
 assert os.geteuid()==0 and sys.flags.optimize==0
 fd=os.open('/run/himawari-three-fixes-cutover.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 assert os.fstat(fd).st_uid==0 and stat.S_ISREG(os.fstat(fd).st_mode)
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 main()
