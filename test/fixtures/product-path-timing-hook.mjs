import cp from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { measure, record } from "./product-path-timing-runtime.mjs";

const manifest = process.env.HIMAWARI_TEST_TIMING_MANIFEST;
if (manifest) {
  const entries = JSON.parse(readFileSync(manifest, "utf8"));
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      const entry = entries[url];
      if (!entry) return result;
      if (createHash("sha256").update(result.source).digest("hex") !== entry.digest)
        throw new Error("PRODUCT_TIMING_SOURCE_CHANGED");
      return { ...result, source: entry.source };
    },
  });
  const fork = cp.fork;
  cp.fork = (file, args, options) => {
    if (!String(file).endsWith("/job-host-main.js")) return fork(file, args, options);
    const startedAt = Date.now();
    const child = fork(file, args, {
      ...options,
      execArgv: [...(options.execArgv ?? []), "--import", fileURLToPath(import.meta.url)],
      env: {
        ...options.env,
        HIMAWARI_TEST_TIMING_MANIFEST: manifest,
        HIMAWARI_TEST_TIMING_OUTPUT: process.env.HIMAWARI_TEST_TIMING_OUTPUT,
      },
    });
    let jobId;
    const send = child.send.bind(child);
    child.send = (message, ...rest) => {
      jobId ??= message.request?.jobId;
      if (message.type !== "heartbeat")
        record({
          kind: "ipc_send",
          type: message.type,
          childPid: child.pid,
          jobId,
          startedAt,
          ageMs: Date.now() - Date.parse(message.observedAt),
        });
      return send(message, ...rest);
    };
    child.on("message", (message) => {
      if (message.type !== "output")
        record({
          kind: "ipc_receive",
          type: message.type,
          childPid: child.pid,
          jobId,
          startedAt,
          ageMs: Date.now() - Date.parse(message.observedAt),
          ...(message.type === "diagnostic"
            ? { stage: message.stage, systemCode: message.systemCode, detail: message.detail }
            : {}),
        });
    });
    let diagnostics = "";
    child.stderr?.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-4096);
      for (;;) {
        const end = diagnostics.indexOf("\n");
        if (end < 0) break;
        const line = diagnostics.slice(0, end);
        diagnostics = diagnostics.slice(end + 1);
        if (/^JOB_HOST_[A-Z_]{1,80}$/.test(line))
          record({ kind: "host_machine_code", childPid: child.pid, jobId, code: line });
      }
    });
    child.once("close", () =>
      record({ kind: "host_close", childPid: child.pid, jobId, startedAt }),
    );
    return child;
  };
  const execute = cp.execSync;
  cp.execSync = (command, ...args) =>
    command === "npm root -g"
      ? measure("host.npm_global_discovery", null, () => execute(command, ...args))
      : execute(command, ...args);
  syncBuiltinESMExports();
  if (process.send) {
    let jobId;
    process.on("message", (message) => {
      jobId ??= message.request?.jobId;
      record({
        kind: "host_ipc_receive",
        jobId,
        type: message.type,
        sequence: message.sequence,
        ageMs: Date.now() - Date.parse(message.observedAt),
      });
    });
  }
}
