#!/usr/bin/python3
"""Export error structure and rehearsal progress, never raw logs or payload bodies."""
import json,os,pathlib,re,socket,stat,sys
R=pathlib.Path('/data/hermes/himawari')
OLD=R/'qualifications/2026-09-11-native-history-rehearsal'
OUT=R/'qualifications/2026-09-11-native-history-rehearsal-v2/diagnostic.json'

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

def main():
 assert len(sys.argv)==1 and os.geteuid()==0 and socket.gethostname()=='hermes-home'
 log=OLD/'private.stderr';s=log.lstat()
 assert log.resolve()==log and stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o077 and s.st_size<=65536
 assert OUT.parent.resolve()==OUT.parent and OUT.parent.stat().st_uid==0
 report=summarize(log.read_text(errors='replace'))
 report['logBytes']=s.st_size;report['progress']={}
 for name in ['work/result','work/result/state/product.sqlite','work/result/schema-before.sqlite']:
  p=OLD/name
  try:
   st=p.lstat();report['progress'][name]={'exists':True,'bytes':st.st_size,'type':'directory' if stat.S_ISDIR(st.st_mode) else 'file'}
  except FileNotFoundError:report['progress'][name]={'exists':False}
 fd=os.open(OUT,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as handle:json.dump(report,handle,indent=2)
 OUT.chmod(0o644)
 print('Read-only diagnostic written: '+str(OUT))
if __name__=='__main__':main()
