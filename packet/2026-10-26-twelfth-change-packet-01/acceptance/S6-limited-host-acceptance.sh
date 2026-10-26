#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
test "$#" -eq 1
test "$1" = --approved-r2l13-twelfth-deployment-qualification
test "$(hostname)" = vmi3618928
test "$(id -u)" -eq 0
test "$(id -u himawari-prod)" -eq 999
test "$(id -g himawari-prod)" -eq 988
stage=/var/tmp/himawari-twelfth-20261026
base=$stage/packet/acceptance/cloud
evidence=/var/lib/himawari/twelfth-20261026-evidence
qualification=/var/lib/himawari/qualification/twelfth-20261026
test "$(systemctl show himawari-prod.service --property=MainPID --value)" = 0
state=$(systemctl show himawari-prod.service --property=ActiveState --value)
test "$state" = inactive || test "$state" = failed
test "$(realpath -e -- "$base")" = "$base"
test "$(stat -c '%u:%g:%a' "$base")" = 0:988:750
test "$(stat -c '%u:%g:%a' "$evidence")" = 999:988:700
test ! -e "$evidence/s6-orchestration.started"
test ! -L "$evidence/s6-orchestration.started"
test ! -e "$base/cloud-inputs.json"
test ! -L "$base/cloud-inputs.json"
test ! -e "$qualification"
test ! -L "$qualification"
test "$(realpath -e -- /var/lib/himawari/qualification)" = /var/lib/himawari/qualification
test "$(stat -c %u /var/lib/himawari/qualification)" = 0
cd "$stage/packet/acceptance"
sha256sum --check --strict OWNED-SHA256SUMS
set -C
/usr/bin/python3 -I "$stage/packet/acceptance/helpers/verify-frozen-packet.py" --approved-twelfth-frozen-packet-readback > "$evidence/s6-frozen-packet-readback.json"
/usr/bin/python3 -I "$stage/packet/acceptance/helpers/observe-production-npm.py" --approved-twelfth-production-npm-readonly-observation --expected "$stage/packet/inputs/npm-observed.json" > "$evidence/s6-npm-observation.json" 2> "$evidence/s6-npm-observation.stderr"
set -C
date --iso-8601=seconds > "$evidence/s6-orchestration.started"
mkdir -- "$qualification"
chown root:himawari-prod "$qualification"
chmod 0750 "$qualification"
test "$(stat -c '%u:%g:%a' "$qualification")" = 0:988:750
df -B1 / > "$evidence/s6-root-space-before.txt"
/bin/bash "$base/run-question12-downloads.sh" --approved-s6-reference-downloads
/usr/bin/python3 -I "$base/prepare-runtime-tools.py" --approved-s6-tool-preparation "$stage/acceptance/question-12-downloads" > "$stage/acceptance/runtime-tool-preparation.json"
chown root:himawari-prod "$stage/acceptance/runtime-tool-preparation.json"
chmod 0640 "$stage/acceptance/runtime-tool-preparation.json"
/usr/bin/python3 -I "$base/finalize-cloud-inputs.py" --approved-s6-manifest-publication > "$stage/acceptance/manifest-publication.json"
chown root:himawari-prod "$stage/acceptance/manifest-publication.json"
chmod 0640 "$stage/acceptance/manifest-publication.json"
/bin/bash "$base/run-cloud-acceptance.sh" --approved-s6-limited-host-acceptance
/usr/bin/python3 -I - "$stage/acceptance/run-01" "$evidence/s6-qualification-readback.json" <<'PY'
import hashlib,json,os,pathlib,stat,sys
source,output=map(pathlib.Path,sys.argv[1:])
run=json.loads((source/'run-report.json').read_text())
acceptance=json.loads((source/'acceptance-report.json').read_text())
if run['passed'] is not True or run['profile']!='cloud-twelfth-change' or run['acceptanceUid']!=999 or run['hostname']!='vmi3618928' or run['scratchCleanupPending'] is not False or run['runnerErrors'] or acceptance['passed'] is not True or acceptance['productionQualificationIssued'] is not False:
    raise RuntimeError('COMPLETE_S6_INDEPENDENT_READBACK_FAILED')
required=['pi-installed.json','composition-installed.json','network-installed.json','boundary-installed.json','worker-loss-installed.json','web-search-installed.json','r2l6-installed.json']
files=[]
for name in required+['run-report.json','acceptance-report.json']:
    path=source/name
    info=path.lstat()
    if path.resolve()!=path or not stat.S_ISREG(info.st_mode) or info.st_uid!=999 or info.st_mode&0o022:
        raise RuntimeError('S6_REPORT_UNSAFE:'+name)
    data=path.read_bytes()
    files.append({'name':name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
payload=(json.dumps({'schema':'himawari-twelfth-s6-readback.v1','passed':True,'productionQualificationIssued':False,'source':str(source),'reports':files,'scratchDeleted':run['scratchDeleted'],'rootFreeBeforeBytes':run['rootFreeBeforeBytes'],'rootLowestFreeBytes':run['rootLowestFreeBytes'],'rootFreeAfterCleanupBytes':run['rootFreeAfterCleanupBytes'],'scratchPeakBytes':run['scratchPeakBytes']},indent=2)+'\n').encode()
with output.open('xb') as f:
    f.write(payload);f.flush();os.fsync(f.fileno())
output.chmod(0o600)
if output.read_bytes()!=payload:
    raise RuntimeError('S6_RECEIPT_READBACK_FAILED')
print(json.dumps({'passed':True,'receipt':str(output),'sha256':hashlib.sha256(payload).hexdigest()}))
PY
df -B1 / > "$evidence/s6-root-space-after.txt"
