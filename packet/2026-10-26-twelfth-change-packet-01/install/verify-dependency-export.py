import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

root = Path(os.environ['HIMAWARI_TEST_TEMP_ROOT']) / 'dependency-export'
root.mkdir(mode=0o700)
extractor = Path(sys.argv[1]).resolve()
results = []
for case, nested, unwanted, expected in [('workspace', True, False, 0), ('outside-lock-root', False, True, 1)]:
    directory = root / case
    source = directory / 'source'
    source.mkdir(parents=True)
    (source / 'packages/platform-node').mkdir(parents=True)
    lock = {'packages': {'node_modules/example': {'version': '1.0.0'}, 'packages/platform-node/node_modules/zod': {'version': '4.4.3'}}}
    lock_bytes = json.dumps(lock).encode()
    (source / 'package-lock.json').write_bytes(lock_bytes)
    entries = [{'path':'node_modules','type':'directory','mode':493}]
    if nested:
        entries += [{'path':'packages/platform-node/node_modules','type':'directory','mode':493}, {'path':'packages/platform-node/node_modules/zod','type':'directory','mode':493}, {'path':'packages/platform-node/node_modules/zod/package.json','type':'file','mode':420,'bytes':19,'sha256':hashlib.sha256(b'{"version":"4.4.3"}').hexdigest()}]
    if unwanted:
        entries += [{'path':'packages/platform-node/src','type':'directory','mode':493}]
    record = {'schemaVersion':2,'scope':'whole-locked-node-modules','sourceHead':'470b6d30a8664d5f85da2a8b261b59a4f5f18704','lockCheck':{'exitCode':0},'packageLockSha256':hashlib.sha256(lock_bytes).hexdigest(),'dependencyRoots':['node_modules','packages/platform-node/node_modules'],'entries':entries}
    archive = directory / 'modules.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        for entry in entries:
            item=tarfile.TarInfo(entry['path']);item.mode=entry['mode']
            if entry['type']=='directory': item.type=tarfile.DIRTYPE;tar.addfile(item)
            else:
                data=b'{"version":"4.4.3"}';item.size=len(data);tar.addfile(item,io.BytesIO(data))
    proof=directory/'proof.json';proof.write_text(json.dumps(record))
    run=subprocess.run(['/usr/bin/python3','-I',str(extractor),str(archive),str(proof),str(source)],capture_output=True,text=True)
    valid = (run.returncode == 0) == (expected == 0)
    if valid and nested:
        valid=json.loads((source/'packages/platform-node/node_modules/zod/package.json').read_text())['version']=='4.4.3'
    results.append({'case':case,'passed':valid,'exitCode':run.returncode,'stdout':run.stdout,'stderr':run.stderr})
print(json.dumps({'passed':all(item['passed'] for item in results),'cases':results},indent=2))
sys.exit(0 if all(item['passed'] for item in results) else 1)
