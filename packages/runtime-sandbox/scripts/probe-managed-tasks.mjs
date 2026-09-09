import { createHash } from "node:crypto";
import { release } from "node:os";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  compileSandboxPolicy,
  prepareSandboxJobHost,
  queryJobHostControl,
} from "../../../dist/node-runtime/node_modules/@himawari-agent/runtime-sandbox/dist/index.js";

if (process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1") throw new Error("LIVE_PROBE_OPT_IN_REQUIRED");
if (process.platform !== "darwin") throw new Error("THIS_PROBE_REQUIRES_MAC");
const root = await realpath(await mkdtemp("/tmp/r6-"));
const evidence = [];
try {
  for (const scenario of ["task", "service", "readiness-timeout", "readiness-cancel", "flood"]) {
    const base = path.join(root, scenario);
    for (const name of ["workspace", "private", "control"])
      await mkdir(path.join(base, name), { recursive: true, mode: 0o700 });
    const service = scenario === "service" || scenario.startsWith("readiness-");
    const privateDirectory = path.join(base, "private");
    const policy = {
      workspace: path.join(base, "workspace"),
      privateDirectory,
      writable: false,
      allowedDomains: [],
      protectedPaths: [],
      readOnlyToolchainPaths: await Promise.all(
        [
          "/usr/bin",
          "/bin",
          "/usr/lib",
          "/System",
          "/dev",
          path.dirname(await realpath(process.execPath)),
        ].map((p) => realpath(p)),
      ),
      ...(service ? { allowedUnixSockets: [path.join(privateDirectory, "ready.sock")] } : {}),
    };
    const compiled = await compileSandboxPolicy(policy);
    const readiness = {
      kind: "unix_http",
      ref: "test-ready",
      socketName: "ready.sock",
      path: "/ready",
      expectedStatus: 204,
      timeoutMs: 3000,
    };
    const program = service
      ? `const h=require('node:http');const s=h.createServer((q,r)=>{r.writeHead(${scenario === "service" ? 204 : 503});r.end()});setTimeout(()=>s.listen(${JSON.stringify(path.join(privateDirectory, "ready.sock"))}),600);setInterval(()=>process.stdout.write('tick\\n'),150);setTimeout(()=>process.exit(),7000);`
      : scenario === "flood"
        ? "process.stdout.write('x'.repeat(20000));setTimeout(()=>process.exit(),5000)"
        : "setInterval(()=>process.stdout.write('tick\\n'),150);setTimeout(()=>process.exit(),7000)";
    const boundaries =
      scenario === "service"
        ? `const net=require('node:net');
for(const [name,address] of [['tcp',{port:0,host:'127.0.0.1'}],['unix',${JSON.stringify(path.join(privateDirectory, "other.sock"))}]]){
 const server=net.createServer(); server.on('error',()=>process.stdout.write(name+'-denied\\n'));server.listen(address,()=>{process.stdout.write(name+'-allowed\\n');server.close()});}`
        : "";
    const host = prepareSandboxJobHost(
      {
        jobId: scenario,
        attemptId: "attempt",
        policy,
        policyDigest: compiled.policyDigest,
        executable: await realpath(process.execPath),
        args: ["-e", program + boundaries],
        deadlineAt: new Date(Date.now() + 10000).toISOString(),
        maxOutputBytes: 4096,
        cleanupTimeoutMs: 2000,
        resourceLimits: { maxCpuTimeMs: 4000, maxMemoryBytes: 536870912 },
        ...(service ? { readiness } : {}),
      },
      path.join(base, "control"),
    );
    try {
      await host.ready;
      host.start();
      const task = await host.started;
      assert(task.processId > 1);
      if (scenario === "task" || scenario === "service") {
        const until = Date.now() + 5000;
        let observation;
        while (Date.now() < until) {
          observation = await queryJobHostControl(host.controlBinding, "inspect");
          if (host.readOutput(0, 4096).bytes.length && (!service || observation.readiness?.readyAt))
            break;
          await delay(100);
        }
        assert(host.readOutput(0, 4096).bytes.length > 0, "live output must precede completion");
        if (service) {
          assert(observation.readiness?.readyAt, "independent HTTP probe must pass");
          const captured = Buffer.from(host.readOutput(0, 4096).bytes).toString();
          assert(captured.includes("tcp-denied") && captured.includes("unix-denied"));
          assert(!captured.includes("-allowed"));
        }
        const page = host.readOutput(0, 3);
        assert.deepEqual(host.readOutput(0, 3), page);
        assert.equal(page.end, false);
        await queryJobHostControl(host.controlBinding, "stop");
      }
      if (scenario === "readiness-cancel") {
        await delay(100);
        await queryJobHostControl(host.controlBinding, "stop");
      }
      const result = await host.result;
      assert.equal(host.readOutput(0, 1_048_576).end, true);
      assert(host.readOutput(0, 1_048_576).bytes.length <= 4096);
      if (scenario === "readiness-cancel") assert.equal(result.reason, "cancelled");
      if (scenario === "flood") assert.equal(result.reason, "output_limit");
      if (scenario === "readiness-timeout") assert.equal(result.reason, "host_failure");
      assert.equal(result.taskProcessExited, true);
      evidence.push({
        scenario,
        policyDigest: compiled.policyDigest,
        mode: service ? "service" : "background",
        reason: result.reason,
        taskProcessExited: result.taskProcessExited,
        taskTreeCleanup: result.taskTreeCleanup,
        outputBytes: host.readOutput(0, 1_048_576).bytes.length,
      });
    } finally {
      host.cancel();
      await host.result;
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        osRelease: release(),
        architecture: process.arch,
        node: process.version,
        srt: "0.0.75",
        productionSuitable: false,
        jobHostDigest: createHash("sha256")
          .update(
            await readFile(
              new URL(
                "../../../dist/node-runtime/node_modules/@himawari-agent/runtime-sandbox/dist/job-host-main.js",
                import.meta.url,
              ),
            ),
          )
          .digest("hex"),
        evidence,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
