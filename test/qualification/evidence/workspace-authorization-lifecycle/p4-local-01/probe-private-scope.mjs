import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.argv[2];
const { compileSandboxPolicy, prepareSandboxJobHost } = await import(pathToFileURL(path.join(repo, 'node_modules/@himawari-agent/runtime-sandbox/dist/index.js')));
const root = await realpath(await mkdtemp('/tmp/hp4-'));
let host;
let server;
let hits = 0;
const report = { platform: process.platform, architecture: process.arch, node: process.version, sourceBuildProbe: true, productionQualified: false };
try {
  const scratch = path.join(root, 'private');
  const outside = path.join(root, 'user');
  const control = path.join(root, 'control');
  for (const entry of [scratch, outside, control]) await mkdir(entry, {mode:0o700});
  const original = path.join(outside, 'original.txt');
  const forbidden = path.join(outside, 'forbidden.txt');
  await writeFile(original, 'synthetic private workspace marker');
  server = createServer(socket => { hits++; socket.destroy(); });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const executable = await realpath(process.execPath);
  const policy = { workspace:null, writable:false, privateDirectory:scratch, protectedPaths:[], allowedDomains:[], readOnlyToolchainPaths: [...new Set(await Promise.all(['/usr/bin','/bin','/usr/lib','/dev','/System',path.dirname(executable)].map(p => realpath(p))))] };
  const compiled = await compileSandboxPolicy(policy);
  const task = `const fs=require('node:fs'), cp=require('node:child_process'), net=require('node:net');
const r={cwd:process.cwd(),outsideRead:null,outsideWrite:null,childRead:null,network:null};
fs.writeFileSync('result.txt','private output');
try{fs.readFileSync(${JSON.stringify(original)});r.outsideRead='allowed'}catch(e){r.outsideRead=e.code}
try{fs.writeFileSync(${JSON.stringify(forbidden)},'forbidden');r.outsideWrite='allowed'}catch(e){r.outsideWrite=e.code}
try{r.childRead=cp.execFileSync(process.execPath,['-e',${JSON.stringify(`try{require('node:fs').readFileSync(${JSON.stringify(original)});process.stdout.write('allowed')}catch(e){process.stdout.write(e.code)}`)}],{encoding:'utf8'}).trim()}catch(e){r.childRead=e.code}
const s=net.connect(${server.address().port},'127.0.0.1');s.on('connect',()=>{r.network='allowed';s.destroy()});s.on('error',e=>{r.network=e.code});s.on('close',()=>console.log(JSON.stringify(r)));`;
  host = prepareSandboxJobHost({jobId:'private-probe',attemptId:'attempt',policy,policyDigest:compiled.policyDigest,executable,args:['-e',task],deadlineAt:new Date(Date.now()+20000).toISOString(),maxOutputBytes:8192,cleanupTimeoutMs:2000},control);
  await host.ready;
  host.start();
  const result = await host.result;
  report.result = { reason:result.reason,exitCode:result.exitCode,taskProcessExited:result.taskProcessExited,taskTreeCleanup:result.taskTreeCleanup,network:result.network };
  report.stdout=Buffer.from(result.stdout).toString();
  report.stderr=Buffer.from(result.stderr).toString();
  assert.equal(result.exitCode,0);
  const facts=JSON.parse(report.stdout.trim());
  report.facts=facts;
  assert.equal(facts.cwd,scratch);
  for(const key of ['outsideRead','outsideWrite','childRead','network']) assert(['EPERM','EACCES'].includes(facts[key]),`${key}: ${facts[key]}`);
  assert.equal(hits,0);
  assert.equal(await readFile(original,'utf8'),'synthetic private workspace marker');
  assert.equal(await readFile(path.join(scratch,'result.txt'),'utf8'),'private output');
  await assert.rejects(readFile(forbidden),{code:'ENOENT'});
  report.passed=true;
} catch(error) {report.passed=false;report.error=String(error);process.exitCode=1;}
finally {if(host){host.cancel();await host.result;}if(server) await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});report.ownedTemporaryFilesRemoved=true;process.stdout.write(JSON.stringify(report,null,2)+'\n');}
