import hashlib,importlib.util,json,os,pathlib,sqlite3,tempfile,types,unittest
from unittest.mock import patch
SCRIPT=pathlib.Path(__file__).resolve().parents[4]/'scripts/operations/hermes-e2e-fixes-cutover.py'
class CutoverTest(unittest.TestCase):
 def scenario(self,fail=None):
  spec=importlib.util.spec_from_file_location('candidate_cutover',SCRIPT);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  with tempfile.TemporaryDirectory(prefix='himawari-cutover-test-') as d:
   r=pathlib.Path(d);m.R=r;m.B=r/'build';m.Q=r/'qualified';m.W=r/'evidence';m.CURRENT=r/'current';m.CANDIDATE=r/'candidate';m.ARCHIVE=r/'archive';m.STATE=r/'state';m.CONFIG=r/'config.json';m.UNIT=r/'service';m.AUTH=r/'authority';m.CANDIDATE_AUTH=r/'candidate-auth';m.RUNTIME=m.CURRENT/'lib/himawari-agent';m.ATTESTATION=m.STATE/'deployment/startup-attestation.json';m.OLD_START=r/'old-start'
   for p in [m.B,m.Q,m.CURRENT,m.CANDIDATE,m.STATE/'deployment',m.STATE/'data',r/'logs']:p.mkdir(parents=True)
   (m.CURRENT/'old-marker').write_text('old');(m.CANDIDATE/'new-marker').write_text('new')
   m.CONFIG.write_text('old-config');m.AUTH.write_text(json.dumps({'runtimeDigest':m.EXPECTED_CURRENT_RUNTIME}));m.ATTESTATION.write_text('old-attestation');m.UNIT.write_text('ExecStart='+str(m.RUNTIME/'pi-tools/bin/node')+' '+str(m.OLD_START))
   receipt=b'fixture-receipt';m.EXPECTED_RECEIPT=hashlib.sha256(receipt).hexdigest();(m.Q/'installation-receipt.json').write_bytes(receipt)
   (m.Q/'status.json').write_text(json.dumps({'passed':True}))
   (m.Q/'result.json').write_text(json.dumps({'passed':True,'runtimeDigest':'runtime','receiptDigest':m.EXPECTED_RECEIPT}))
   m.CANDIDATE_AUTH.write_text(json.dumps({'runtimeDigest':'runtime'}))
   helper=m.B/'hermes-protected-registered.mjs';helper.write_text('fixture helper');m.INPUTS={helper.name:hashlib.sha256(helper.read_bytes()).hexdigest()}
   startup=m.Q/'hermes-e2e-fixes-start.mjs';startup.write_text('fixture startup')
   for name in ['agent','worker']:(r/'logs'/f'{name}.log').write_text('')
   dbpath=m.STATE/'data/product.sqlite'
   with sqlite3.connect(dbpath) as db:db.execute('CREATE TABLE authority_leases(expires_at TEXT)')
   original_db=dbpath.read_bytes();calls=[];checks=[];realsha=m.sha;realread=pathlib.Path.read_text
   def command(args,timeout=90):
    args=list(map(str,args));calls.append(('command',args))
    if args[:2]==['findmnt','-no']:return types.SimpleNamespace(stdout='/data\n')
    if args[0]=='systemd-analyze' and fail=='unit-verify':raise RuntimeError('TEST_UNIT_VERIFY_FAILED')
    if args[0]=='systemd-run' and fail=='observer':raise RuntimeError('TEST_OBSERVER_FAILED')
    if args[:2]==['systemctl','is-active']:return types.SimpleNamespace(stdout='active\n')
    if args[:2]==['systemctl','show']:
     return types.SimpleNamespace(stdout='himawari\n' if 'User' in args else '0\n' if not (m.CURRENT/'new-marker').exists() else 'fixture-pid\n')
    if args[:2]==['systemctl','start'] and (m.CURRENT/'new-marker').exists():
     if fail=='new-start':raise RuntimeError('TEST_NEW_START_FAILED')
     for name in ['agent','worker']:(r/'logs'/f'{name}.log').write_text('{"event":"service.ready"}\n')
    return types.SimpleNamespace(stdout='')
   def invoke(phase,args,candidate_view=False,protected=True):
    calls.append(('invoke',phase));
    if phase==fail:raise RuntimeError('TEST_PHASE_FAILED')
    if phase.startswith('backup-'):return {'backupId':m.BACKUP_ID,'schemaVersion':'32','fullIntegrityCheck':'ok'}
    if phase=='prepare':
     (m.STATE/'deployment/production-prepared.json').write_text('new-config');m.ATTESTATION.write_text('new-attestation');return {'preparing':True,'runtimeDigest':'runtime'}
    if phase=='registered':return {'registeredCapabilitiesUnchanged':True}
    raise AssertionError('Unexpected invoke '+phase)
   def read(path,*args,**kwargs):
    if str(path)=='/proc/fixture-pid/status':return 'Uid:\t998\t998\t998\t998\nNoNewPrivs:\t1\n'
    return realread(path,*args,**kwargs)
   def sha(p):return '18a8d1732b2cdd834f84ff9f8ffe65b85b8f42d79a3811c5738c15a05ba0130e' if p==startup else realsha(p)
   with patch.object(m,'command',command),patch.object(m,'invoke',invoke),patch.object(m,'database_check',lambda n:checks.append(n)),patch.object(m,'plain',lambda p:types.SimpleNamespace(st_uid=0)),patch.object(m,'sha',sha),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'chown'),patch.object(m.os,'fchown'),patch.object(m.os,'umask'),patch.object(m.socket,'gethostname',return_value='hermes-home'),patch.object(m.shutil,'disk_usage',return_value=types.SimpleNamespace(free=100*1024**3)),patch.object(m.sys,'argv',['fixture','--apply']),patch.dict(os.environ,{'INVOCATION_ID':'fixture'}),patch.object(pathlib.Path,'read_text',read):
    if fail and fail!='observer':
     with self.assertRaises(RuntimeError):m.main()
    else:m.main()
   self.assertEqual(dbpath.read_bytes(),original_db,'Cutover must never import, migrate or restore database')
   self.assertTrue(all(n==32 for n in checks))
   phases=[v for k,v in calls if k=='invoke'];self.assertNotIn('migrate',phases);self.assertNotIn('import',phases);self.assertNotIn('rollback',phases)
   if not fail or fail=='observer':
    self.assertTrue((m.ARCHIVE/'old-marker').exists());self.assertTrue((m.CURRENT/'new-marker').exists());self.assertTrue(json.loads((m.W/'result.json').read_text())['passed'])
   elif fail=='new-start':
    report=json.loads((m.W/'exception.json').read_text());self.assertFalse(report['rollback']['completed']);self.assertTrue((m.CURRENT/'new-marker').exists())
   else:
    self.assertTrue((m.CURRENT/'old-marker').exists());self.assertEqual(m.CONFIG.read_text(),'old-config');self.assertEqual(m.ATTESTATION.read_text(),'old-attestation');self.assertTrue(json.loads((m.W/'exception.json').read_text())['rollback']['completed'])
 def test_observer_failure_does_not_stop_healthy_service(self):self.scenario('observer')
 def test_failure_after_swap_restores_old_installation(self):self.scenario('unit-verify')
 def test_success_keeps_schema32_database(self):self.scenario()
 def test_backup_failure_restores_service(self):self.scenario('backup-verify')
 def test_candidate_prepare_failure_restores_service(self):self.scenario('prepare')
 def test_capability_mismatch_restores_attestation_and_service(self):self.scenario('registered')
 def test_new_start_failure_preserves_post_start_data(self):self.scenario('new-start')
if __name__=='__main__':unittest.main()
