import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
os.umask(0o022)
if len(sys.argv) != 3 or sys.argv[1] != '--approved-frozen-__PKT_LABEL__-packet' or os.getuid() != 0 or socket.gethostname() != '__PKT_HOSTNAME__':
    raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_EXPLICIT_TARGET_REQUIRED')
packet = Path(sys.argv[2])
if packet.resolve() != packet or packet.is_symlink():
    raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_PACKET_UNSAFE')
for parent, directories, filenames in os.walk(packet):
    for name in directories + filenames:
        current = Path(parent) / name
        if current.is_symlink() or current.resolve() != current:
            raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_PACKET_MEMBER_UNSAFE')
manifest = json.loads((packet / 'freeze-manifest.json').read_text())
binding = json.loads((packet / 'inputs/bindings.json').read_text())
if manifest.get('status') != 'frozen-approved' or binding.get('status') != 'frozen-approved' or not binding['approvals']['packageRef'] or manifest['approvalRef'] != binding['approvals']['packageRef']:
    raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_UNFROZEN')
expected_members = {entry['path'] for entry in manifest['files']}
actual_members = {str(current.relative_to(packet)) for current in packet.rglob('*') if current.is_file() and current.relative_to(packet) != Path('freeze-manifest.json')}
if len(expected_members) != len(manifest['files']) or actual_members != expected_members:
    raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_FROZEN_MEMBER_SET_CHANGED')
for entry in manifest['files']:
    relative = Path(entry['path'])
    if relative.is_absolute() or '..' in relative.parts:
        raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_MANIFEST_PATH_INVALID')
    path = packet / relative
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.resolve() != path or info.st_size != entry['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
        raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_FROZEN_BYTES_CHANGED')
node = Path('/opt/himawari/node/bin/node')
if node.resolve() != node or node.stat().st_uid != 0 or node.stat().st_mode & 0o022 or hashlib.sha256(node.read_bytes()).hexdigest() != binding['host']['nodeSha256']:
    raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_NODE_CHANGED')
for key, value in [('oldPrefix','__PKT_OLD_PREFIX__'),('newPrefix','/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__'),('newOperations','/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__'),('evidenceRoot','/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence')]:
    if binding['paths'][key] != value:
        raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_PATH_CHANGED')
for path, expected in [(Path('/etc/himawari/config.json'),binding['service']['oldConfigSha256']),(Path('/etc/systemd/system/himawari-prod.service'),binding['service']['oldUnitSha256'])]:
    if path.resolve() != path or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_OLD_BINDING_CHANGED')
for directory in ['/opt/himawari/releases','/opt/himawari/operations']:
    path=Path(directory);info=path.lstat()
    if path.resolve()!=path or not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
        raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_PARENT_UNSAFE')
stage=Path('/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__')
operations=Path(binding['paths']['newOperations'])
evidence=Path(binding['paths']['evidenceRoot'])
prefix=Path(binding['paths']['newPrefix'])
for target in [stage,operations,evidence,prefix]:
    if os.path.lexists(target):
        raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_TARGET_NOT_FRESH')
pre_free=shutil.disk_usage('/').free
stage.mkdir(mode=0o750);os.chown(stage,0,__PKT_SERVICE_GID__)
evidence.mkdir(mode=0o700);os.chown(evidence,__PKT_SERVICE_UID__,__PKT_SERVICE_GID__)
stage_identity=stage.lstat()
owned_directories={'schemaVersion':'himawari.__PKT_LABEL__-change-owned-directories.v1','passed':True,'actor':{'uid':0,'hostname':'__PKT_HOSTNAME__'},'directories':[{'path':str(stage),'device':stage_identity.st_dev,'inode':stage_identity.st_ino,'uid':stage_identity.st_uid,'gid':stage_identity.st_gid,'mode':format(stat.S_IMODE(stage_identity.st_mode),'04o')}]}
owned_path=evidence/'s1-owned-directories.json'
owned_bytes=(json.dumps(owned_directories,indent=2)+'\n').encode()
with owned_path.open('xb') as stream:
    stream.write(owned_bytes);stream.flush();os.fsync(stream.fileno());os.fchmod(stream.fileno(),0o640);os.fchown(stream.fileno(),0,__PKT_SERVICE_GID__)
if owned_path.read_bytes()!=owned_bytes:raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_OWNED_IDENTITY_READBACK_FAILED')
acceptance = stage / 'acceptance'; acceptance.mkdir(mode=0o700); os.chown(acceptance,__PKT_SERVICE_UID__,__PKT_SERVICE_GID__)
shutil.copytree(packet,stage/'packet',symlinks=False)
for parent,dirs,files in os.walk(stage/'packet'):
    os.chown(parent,0,__PKT_SERVICE_GID__);os.chmod(parent,0o750)
    for name in files:
        filename=Path(parent)/name;os.chown(filename,0,__PKT_SERVICE_GID__);os.chmod(filename,0o640)
operations.mkdir(mode=0o750);os.chown(operations,0,__PKT_SERVICE_GID__)
for name in ['install','systemd','maintenance','s0-db','inputs','signing','measurement','acceptance','steps']:
    shutil.copytree(stage/'packet'/name,operations/name)
(operations/'materials').mkdir(mode=0o750)
shutil.copyfile(stage/'packet/materials/source-build-inputs.json',operations/'materials/source-build-inputs.json')
for parent,dirs,files in os.walk(operations):
    os.chown(parent,0,__PKT_SERVICE_GID__);os.chmod(parent,0o750)
    for name in files:
        filename=Path(parent)/name;os.chown(filename,0,__PKT_SERVICE_GID__);os.chmod(filename,0o640)
inputs=stage/'input';inputs.mkdir(mode=0o750);os.chown(inputs,0,__PKT_SERVICE_GID__)
material=json.loads((packet/'install/p5-materials.json').read_text())
for entry in material['files']:
    source=packet/'materials'/entry.get('sourceName',entry['name'])
    if hashlib.sha256(source.read_bytes()).hexdigest()!=entry['sha256'] or source.stat().st_size!=entry['bytes']:
        raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_MATERIAL_CHANGED')
    destination=inputs/entry['name'];shutil.copyfile(source,destination);os.chown(destination,0,__PKT_SERVICE_GID__);os.chmod(destination,0o640)
shutil.copyfile(packet/'install/p5-materials.json',inputs/'p5-materials.json');os.chown(inputs/'p5-materials.json',0,__PKT_SERVICE_GID__);os.chmod(inputs/'p5-materials.json',0o640)
report={'schemaVersion':'himawari.__PKT_LABEL__-install.v1','passed':False,'rootFreeBeforeBytes':pre_free,'command':[str(node),'--no-global-search-paths',str(operations/'install/__PKT_LABEL__-artifact-install.mjs'),str(inputs),str(stage/'validation'),str(prefix),str(evidence)]}
try:
    with (evidence/'s1-install.stdout').open('xb') as out,(evidence/'s1-install.stderr').open('xb') as err:
        for stream in [out,err]: os.fchmod(stream.fileno(),0o600);os.fchown(stream.fileno(),__PKT_SERVICE_UID__,__PKT_SERVICE_GID__)
        subprocess.run(report['command'],env={'PATH':'/opt/himawari/node/bin:/usr/bin:/bin','HOME':str(stage),'LANG':'C.UTF-8'},stdout=out,stderr=err,check=True,timeout=900)
    installed=json.loads((evidence/'installed-checker.json').read_text())
    if installed['passed'] is not True or installed['prefix']!=str(prefix):
        raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_INDEPENDENT_READBACK_FAILED')
    for parent,dirs,files in os.walk(prefix):
        info=Path(parent).lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_DIRECTORY_UNSAFE')
        for name in files:
            info=(Path(parent)/name).lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022:
                raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_FILE_UNSAFE')
    os.chmod(stage/'validation',0o750);os.chown(stage/'validation',0,__PKT_SERVICE_GID__)
    for key in ['config','unitFragmentPath']:
        path=Path(binding['paths'][key] if key=='config' else binding['service'][key])
        expected=binding['service']['oldConfigSha256' if key=='config' else 'oldUnitSha256']
        if hashlib.sha256(path.read_bytes()).hexdigest()!=expected: raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_ORIGINAL_CHANGED')
    report['passed']=True;report['runtimeDigest']=installed['digest']
finally:
    for parent, directories, filenames in os.walk(evidence):
        os.chown(parent, __PKT_SERVICE_UID__, __PKT_SERVICE_GID__); os.chmod(parent, 0o700)
        for name in filenames:
            current = Path(parent) / name
            if current.is_symlink() or not current.is_file():
                raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_EVIDENCE_UNSAFE')
            if current == owned_path:
                os.chown(current,0,__PKT_SERVICE_GID__);os.chmod(current,0o640)
            else:
                os.chown(current, __PKT_SERVICE_UID__, __PKT_SERVICE_GID__); os.chmod(current, 0o600)
    report['rootFreeAfterBytes']=shutil.disk_usage('/').free
    output=evidence/'s1-result.json';data=(json.dumps(report,indent=2)+'\n').encode()
    with output.open('xb') as f: f.write(data);f.flush();os.fsync(f.fileno());os.fchmod(f.fileno(),0o600);os.fchown(f.fileno(),__PKT_SERVICE_UID__,__PKT_SERVICE_GID__)
    if output.read_bytes()!=data:raise RuntimeError('__PKT_LABEL_UPPER___INSTALL_EVIDENCE_CHANGED')
print(json.dumps({'passed':True,'evidence':str(output),'runtimeDigest':report['runtimeDigest']}))
