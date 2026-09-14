// Fault injection selects an occupied loopback port; the OS produces real EADDRINUSE.
// The installed Job Host and egress implementations are not changed.
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.env.HIMAWARI_LIVE_SANDBOX_PROBE, "1");
const parent =
  process.platform === "linux" ? await realpath(process.env.HIMAWARI_PROBE_SCRATCH) : "/tmp";
if (process.platform === "linux") {
  assert.ok(parent.startsWith("/data/himawari-r8-"));
  assert.equal((await lstat(parent)).uid, process.getuid());
}
const root = await realpath(await mkdtemp(path.join(parent, "bind-")));
const server = createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const runtime = await realpath(process.env.HIMAWARI_PROBE_RUNTIME);
const moduleRoot = path.join(runtime, "node_modules/@himawari-agent/runtime-sandbox/dist");
const nativeFork = childProcess.default.fork;
let nativeCollision = false;
try {
  for (const name of ["workspace", "private", "control"])
    await mkdir(path.join(root, name), { mode: 0o700 });
  const hook = path.join(root, "bind-hook.mjs");
  await writeFile(
    hook,
    `import {Server} from 'node:net';const listen=Server.prototype.listen;Server.prototype.listen=function(...args){if(args[0]===0&&args[1]==='127.0.0.1'){args[0]=${server.address().port};this.once('error',error=>{if(error.code==='EADDRINUSE')process.stderr.write('R8_NATIVE_EADDRINUSE\\n')})}return listen.apply(this,args)};`,
    { mode: 0o600 },
  );
  childProcess.default.fork = (file, args, options) => {
    const child = nativeFork(file, args, { ...options, execArgv: ["--import", hook] });
    child.stderr.on("data", (bytes) => {
      if (bytes.toString().includes("R8_NATIVE_EADDRINUSE")) nativeCollision = true;
    });
    return child;
  };
  syncBuiltinESMExports();
  const { compileSandboxPolicy, prepareSandboxJobHost, readJobHostFinalEvidence } = await import(
    pathToFileURL(path.join(moduleRoot, "index.js"))
  );
  const policy = {
    workspace: path.join(root, "workspace"),
    privateDirectory: path.join(root, "private"),
    writable: false,
    allowedDomains: ["registry.npmjs.org:443"],
    protectedPaths: [],
    readOnlyToolchainPaths: [await realpath("/usr/bin")],
  };
  const compiled = await compileSandboxPolicy(policy);
  const host = prepareSandboxJobHost(
    {
      jobId: "bind-failure",
      attemptId: "attempt",
      policy,
      policyDigest: compiled.policyDigest,
      executable: "/bin/echo",
      args: ["must-not-run"],
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      maxOutputBytes: 1024,
      cleanupTimeoutMs: 2000,
    },
    path.join(root, "control"),
  );
  let rejected = false;
  try {
    await host.ready;
  } catch {
    rejected = true;
  } finally {
    host.cancel();
  }
  const result = await host.result;
  const final = await readJobHostFinalEvidence(host.controlBinding);
  const passed =
    nativeCollision &&
    rejected &&
    result.taskStarted === false &&
    final.taskStarted === false &&
    result.network === null;
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        runtime,
        faultInjection: "occupied-loopback-port",
        nativeCollision,
        readyRejected: rejected,
        taskStarted: result.taskStarted,
        network: result.network,
        srtReset: final.srtReset,
        passed,
        productionSuitable: false,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
} finally {
  childProcess.default.fork = nativeFork;
  syncBuiltinESMExports();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
