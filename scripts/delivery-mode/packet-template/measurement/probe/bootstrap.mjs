import cp from "node:child_process";
import { createHash } from "node:crypto";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { record, role, stage } from "./observe.mjs";

const preload = fileURLToPath(import.meta.url);
const helper = new URL("./observe.mjs", import.meta.url).href;
const originals = {
  "job-host-main.js": "8abf49b2d46e1a0f885b9bea9006c9fba2daec518c72b963bab9c09905421749",
  "sandbox-sdk.js": "709171577c8abf28419a96ee1e5c5050e82a47ac69b24d2b137947dd77a346d3",
  "sandbox-sdk-worker.js": "f7b9c4d0c83fdd22fa573a44704dd522f87c6e6cf871007720a0efa067b50be6",
};
if (isMainThread && role === "caller") {
  const fork = cp.fork;
  cp.fork = function (file, args = [], options = {}) {
    if (!String(file).endsWith("/runtime-sandbox/dist/job-host-main.js")) return fork(file, args, options);
    if ((options.execArgv ?? []).length !== 0) throw new Error("PROBE_ORIGINAL_HOST_EXEC_ARGV_CHANGED");
    stage("host_preparation");
    const child = fork(file, args, { ...options, execArgv: ["--import", preload], env: { ...options.env, HIMAWARI___PKT_LABEL_UPPER___PROBE_LOG: process.env.HIMAWARI___PKT_LABEL_UPPER___PROBE_LOG } });
    record({ kind: "host_fork", pid: child.pid });
    child.on("message", (message) => {
      if (["heartbeat", "ready", "started", "result", "diagnostic"].includes(message?.type)) record({ kind: "host_ipc", type: message.type, sequence: message.sequence, observedAt: message.observedAt });
    });
    child.once("close", (code, signal) => record({ kind: "host_close", pid: child.pid, code, signal }));
    return child;
  };
  syncBuiltinESMExports();
}

registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    const basename = url.split("/").at(-1);
    if (!url.includes("/runtime-sandbox/dist/") || !(basename in originals)) return result;
    if (role === "caller") return result;
    const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
    const sha256 = createHash("sha256").update(source).digest("hex");
    if (sha256 !== originals[basename]) throw new Error("PROBE_ORIGINAL_RUNTIME_CHANGED:" + basename);
    let transformed = source;
    const replace = (before, after) => {
      if (source.split(before).length !== 2) throw new Error("PROBE_ANCHOR_CHANGED:" + basename);
      transformed = transformed.replace(before, after);
    };
    if (basename === "job-host-main.js") {
      replace("const manager = await loading;", 'const manager = await __probeMeasure("host.module_loading", () => loading);');
      replace("const privateDirectory = await realpath(request.policy.privateDirectory);", 'const privateDirectory = await __probeMeasure("host.private_realpath", () => realpath(request.policy.privateDirectory));');
      replace("const { policyJson } = await manager.compileSandboxPolicy(request.policy);", 'const { policyJson } = await __probeMeasure("host.policy", () => manager.compileSandboxPolicy(request.policy));');
      replace("control = await openJobHostControl(binding,", 'control = await __probeMeasure("host.control", () => openJobHostControl(binding,');
      replace('}), () => stop("cancelled"));', '}), () => stop("cancelled")));');
      replace("        await readProcessSnapshot();", '        await __probeMeasure("host.resource_snapshot", () => readProcessSnapshot());');
      replace("await manager.checkDependenciesAsync();", 'await __probeMeasure("host.dependencies", () => manager.checkDependenciesAsync());');
      replace("await openNetworkEgress(configuration.network.allowedDomains, networkAuthority.assertCurrent);", 'await __probeMeasure("host.network", () => openNetworkEgress(configuration.network.allowedDomains, networkAuthority.assertCurrent));');
      replace('await startLinuxHostGuardian(request.cleanupTimeoutMs ?? 5000, () => stop("host_failure"));', 'await __probeMeasure("host.guardian", () => startLinuxHostGuardian(request.cleanupTimeoutMs ?? 5000, () => stop("host_failure")));');
      replace("await manager.initialize(configuration, undefined, false);", 'await __probeMeasure("host.sdk_initialize", () => manager.initialize(configuration, undefined, false));');
      replace("const wrapped = await wrapping;", 'const wrapped = await __probeMeasure("host.wrap", () => wrapping);');
      replace("await sandboxManager.cleanupAfterCommand();", 'await __probeMeasure("host.cleanup", () => sandboxManager.cleanupAfterCommand());');
      replace("await sandboxManager.reset();", 'await __probeMeasure("host.reset", () => sandboxManager.reset());');
      transformed = transformed.replace(/(^\s*)failureStage = "([a-z_]+)";/gm, '$1failureStage = "$2", __probeStage("$2");');
      transformed = transformed.replace(/(^\s*)phase = "([a-z_]+)";/gm, '$1phase = "$2", __probeStage("$2");');
    } else if (basename === "sandbox-sdk.js" && role === "host") {
      replace("execArgv: [],", `execArgv: ["--import", ${JSON.stringify(preload)}],`);
    } else if (basename === "sandbox-sdk-worker.js" && role === "sdk-thread") {
      replace('import("@anthropic-ai/sandbox-runtime"),', '__probeMeasure("sdk.module_loading", () => import("@anthropic-ai/sandbox-runtime")),');
      replace("await SandboxManager.checkDependenciesAsync();", 'await __probeMeasure("sdk.dependencies", () => SandboxManager.checkDependenciesAsync());');
      replace("await SandboxManager.initialize(request.args[0], undefined, false);", 'await __probeMeasure("sdk.initialize", () => SandboxManager.initialize(request.args[0], undefined, false));');
      replace("await SandboxManager.wrapWithSandboxArgv(...request.args);", 'await __probeMeasure("sdk.wrap", () => SandboxManager.wrapWithSandboxArgv(...request.args));');
      replace("SandboxManager.cleanupAfterCommand();", '__probeMeasure("sdk.cleanup", () => SandboxManager.cleanupAfterCommand());');
      replace("await SandboxManager.reset();", 'await __probeMeasure("sdk.reset", () => SandboxManager.reset());');
    } else return result;
    record({ kind: "instrumented_module", basename, sha256 });
    return { ...result, source: `import { measure as __probeMeasure, stage as __probeStage } from ${JSON.stringify(helper)};\n${transformed}` };
  },
});
