#!/usr/bin/python3
"""Export bounded, redacted startup errors; never change service or product state."""
import hashlib,json,os,pathlib,re,socket,stat,subprocess,sys

ROOT=pathlib.Path('/data/hermes/himawari')
OUTPUT=ROOT/'qualifications/2026-09-12-three-fixes-cutover/startup-diagnostic-v2.json'

def redact(text):
 text=re.sub(r'(?i)(authorization|api[_-]?key|password|secret|token)(["\s]*[:=]["\s]*)([^,\s}\]]+)',r'\1\2[redacted]',text)
 return re.sub(r'\b[A-Za-z0-9_+/=-]{40,}\b',lambda m:m[0] if re.fullmatch('[A-Z_]+',m[0]) else '[redacted]',text)[:1600]

def main():
 assert os.geteuid()==0 and sys.flags.optimize==0 and sys.argv[1:]==['--read-startup-errors']
 assert socket.gethostname()=='hermes-home'
 assert not OUTPUT.exists(),'DIAGNOSTIC_ALREADY_EXISTS'
 report={'readOnly':True,'modelCalls':0,'logs':{}}
 for name in ('supervisor','agent','worker'):
  path=ROOT/'logs'/(name+'.log')
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  with os.fdopen(fd,'rb') as stream:
   info=os.fstat(stream.fileno());assert stat.S_ISREG(info.st_mode)
   offset=max(0,info.st_size-65536);stream.seek(offset);data=stream.read(65536)
  lines=data.decode(errors='replace').splitlines()
  if offset:lines=lines[1:]
  errors=[redact(line) for line in lines if re.search(r'Error|error|EACCES|ENOENT|MODULE_NOT_FOUND|startup.failed|service.ready|installation-verified',line)]
  report['logs'][name]={'bytes':info.st_size,'sampleSha256':hashlib.sha256(data).hexdigest(),'matchingLines':errors[-16:],
    'recentLines':[redact(line) for line in lines[-12:]]}
 report['service']=subprocess.check_output(['systemctl','show','himawari.service','-p','ActiveState','-p','SubState','-p','MainPID','-p','ExecMainStatus'],text=True).splitlines()
 fd=os.open(OUTPUT,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
 with os.fdopen(fd,'w') as stream:json.dump(report,stream,indent=2);stream.write('\n');os.fchmod(stream.fileno(),0o644)
 print('Startup diagnostic written; product state unchanged')

if __name__=='__main__':main()
