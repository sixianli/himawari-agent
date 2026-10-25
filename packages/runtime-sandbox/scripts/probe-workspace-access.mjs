// Synthetic current-directory access checks through the installed Job Host.
// Passing this probe does not issue a production qualification.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1") throw new Error("LIVE_PROBE_OPT_IN_REQUIRED");
const runtime = await realpath(process.env.HIMAWARI_PROBE_RUNTIME ?? "dist/node-runtime");
const { compileSandboxPolicy, prepareSandboxJobHost } = await import(
  pathToFileURL(path.join(runtime, "node_modules/@himawari-agent/runtime-sandbox/dist/index.js"))
);
const parent = process.platform === "linux" ? process.env.HIMAWARI_PROBE_SCRATCH : "/tmp";
if (!parent || (process.platform === "linux" && !parent.startsWith("/data/")))
  throw new Error("PROBE_REQUIRES_DATA_SCRATCH");
const root = await realpath(await mkdtemp(path.join(parent, "p4-")));
const executable = await realpath(process.execPath);
const reports = [];
let hits = 0;
const server = createServer((socket) => {
  hits++;
  socket.destroy();
});
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const accepted = new Promise((resolve) => server.once("connection", resolve));
  const positive = createConnection(server.address().port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    positive.once("connect", resolve);
    positive.once("error", reject);
  });
  await accepted;
  positive.destroy();
  assert.equal(hits, 1);
  hits = 0;
  const hostNetworkNamespace =
    process.platform === "linux" ? await readlink("/proc/self/ns/net") : null;
  const selected = process.env.HIMAWARI_PROBE_MODE;
  if (selected && !["read", "write", "private"].includes(selected))
    throw new Error("INVALID_PROBE_MODE");
  for (const mode of selected ? [selected] : ["read", "write", "private"]) {
    const base = path.join(root, mode);
    const workspace = path.join(base, "workspace");
    const scratch = path.join(base, "private");
    const outside = path.join(base, "outside");
    const control = path.join(base, "control");
    for (const dir of [workspace, scratch, outside, control])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    const input = path.join(workspace, "input.txt");
    const secret = path.join(outside, "secret.txt");
    await writeFile(input, "current uncommitted input");
    await writeFile(secret, "synthetic outside input");
    await symlink(outside, path.join(workspace, "escape"));
    const toolchains = [
      ...new Set(
        await Promise.all(
          [
            "/usr/bin",
            "/bin",
            "/usr/lib",
            "/dev",
            path.dirname(executable),
            ...(process.platform === "darwin"
              ? ["/System"]
              : [
                  "/lib",
                  "/lib64",
                  "/proc",
                  path.join(runtime, "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp"),
                ]),
          ].map((entry) => realpath(entry)),
        ),
      ),
    ];
    const policy = {
      workspace: mode === "private" ? null : workspace,
      writable: mode === "write",
      privateDirectory: scratch,
      protectedPaths: [],
      allowedDomains: [],
      readOnlyToolchainPaths: toolchains,
    };
    const compiled = await compileSandboxPolicy(policy);
    const task = `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
const check=f=>{try{f();return 'allowed'}catch(e){return e.code}};
const facts={networkNamespace:process.platform==='linux'?fs.readlinkSync('/proc/self/ns/net'):null,cwd:process.cwd(),read:check(()=>fs.readFileSync(${JSON.stringify(input)})),
write:check(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, "new.txt"))},'task output')),
outsideRead:check(()=>fs.readFileSync(${JSON.stringify(secret)})),
outsideWrite:check(()=>fs.writeFileSync(${JSON.stringify(path.join(outside, "new.txt"))},'forbidden')),
symlinkRead:check(()=>fs.readFileSync(${JSON.stringify(path.join(workspace, "escape/secret.txt"))})),
symlinkWrite:check(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, "escape/new.txt"))},'forbidden'))};
fs.writeFileSync(${JSON.stringify(path.join(scratch, "result.txt"))},'private output');
facts.childRead=cp.execFileSync(process.execPath,['-e',${JSON.stringify(`try{require('node:fs').readFileSync(${JSON.stringify(secret)});process.stdout.write('allowed')}catch(e){process.stdout.write(e.code)}`)}],{encoding:'utf8'});
const socket=net.connect(${server.address().port},'127.0.0.1');
socket.setTimeout(2000,()=>{facts.network='timeout';socket.destroy()});
socket.on('connect',()=>{facts.network='allowed';socket.destroy()});
socket.on('error',e=>{facts.network=e.code});
socket.on('close',()=>console.log(JSON.stringify(facts)));`;
    const launchStartedAt = Date.now();
    const host = prepareSandboxJobHost(
      {
        jobId: `access-${mode}`,
        attemptId: "attempt",
        policy,
        policyDigest: compiled.policyDigest,
        executable,
        args: ["-e", task],
        deadlineAt: new Date(Date.now() + 20000).toISOString(),
        maxOutputBytes: 8192,
        cleanupTimeoutMs: 2000,
      },
      control,
    );
    try {
      await host.ready;
      host.start();
      const result = await host.result;
      const record = {
        mode,
        reason: result.reason,
        elapsedMs: Date.now() - launchStartedAt,
        policyDigest: compiled.policyDigest,
        exitCode: result.exitCode,
        taskTreeCleanup: result.taskTreeCleanup,
        stdout: Buffer.from(result.stdout).toString(),
        stderr: Buffer.from(result.stderr).toString(),
      };
      reports.push(record);
      assert.equal(result.exitCode, 0, record.stderr);
      const facts = JSON.parse(record.stdout.trim());
      assert.equal(facts.cwd, mode === "private" ? scratch : workspace);
      for (const field of [
        "outsideRead",
        "outsideWrite",
        "symlinkRead",
        "symlinkWrite",
        "childRead",
      ])
        assert(
          ["EPERM", "EACCES", "ENOENT"].includes(facts[field]),
          `${mode}/${field}: ${facts[field]}`,
        );
      if (mode === "private") assert(["EPERM", "EACCES", "ENOENT"].includes(facts.read));
      else assert.equal(facts.read, "allowed");
      if (mode === "write") {
        assert.equal(facts.write, "allowed");
        assert.equal(await readFile(path.join(workspace, "new.txt"), "utf8"), "task output");
      } else {
        assert(["EPERM", "EACCES", "ENOENT", "EROFS"].includes(facts.write));
        await assert.rejects(readFile(path.join(workspace, "new.txt")), { code: "ENOENT" });
      }
      assert(
        (process.platform === "linux"
          ? ["EPERM", "EACCES", "ENETUNREACH", "ECONNREFUSED"]
          : ["EPERM", "EACCES"]
        ).includes(facts.network),
        `network: ${facts.network}`,
      );
      if (process.platform === "linux") {
        assert.match(facts.networkNamespace, /^net:\[[0-9]+\]$/);
        assert.notEqual(facts.networkNamespace, hostNetworkNamespace);
      }
      record.hostNetworkNamespace = hostNetworkNamespace;
      record.hostListenerPositiveControl = true;
      assert.equal(hits, 0);
      assert.equal(await readFile(secret, "utf8"), "synthetic outside input");
      assert.equal(await readFile(input, "utf8"), "current uncommitted input");
      assert.equal(await readFile(path.join(scratch, "result.txt"), "utf8"), "private output");
      await assert.rejects(readFile(path.join(outside, "new.txt")), { code: "ENOENT" });
      record.passed = true;
    } finally {
      host.cancel();
      await host.result;
    }
  }
} catch (error) {
  reports.push({ error: String(error), passed: false });
  process.exitCode = 1;
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        productionQualified: false,
        ownedTemporaryFilesRemoved: true,
        reports,
      },
      null,
      2,
    ),
  );
}
