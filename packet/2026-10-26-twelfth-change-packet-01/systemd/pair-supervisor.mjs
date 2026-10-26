import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

const allowedArguments = ["--prefix", "--config", "--worker-token-file"];
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (
    !allowedArguments.includes(name) ||
    values.has(name) ||
    !value ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    process.stderr.write("PAIR_ARGUMENT_INVALID\n");
    process.exit(1);
  }
  values.set(name, value);
}
if (values.size !== allowedArguments.length || process.getuid?.() === 0) {
  process.stderr.write("PAIR_ARGUMENT_OR_ACCOUNT_INVALID\n");
  process.exit(1);
}

const pairRunId = randomUUID();
const children = new Map();
const productArguments = [
  "--config",
  values.get("--config"),
  "--worker-token-file",
  values.get("--worker-token-file"),
  "--profile",
  "production",
];
let stopping = false;
let stopPromise;

function record(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), component: "pair-supervisor", event, pairRunId, ...fields })}\n`,
  );
}

function stop(exitCode, reason) {
  if (stopping) return stopPromise;
  stopping = true;
  record("pair.stopping", { reason, exitCode });
  stopPromise = (async () => {
    const timer = setTimeout(() => {
      record("pair.stop_timeout", { timeoutMs: 30000, forcedStop: true });
      process.exit(1);
    }, 30000);
    try {
      for (const name of ["agent", "worker"]) {
        const child = children.get(name);
        if (!child || child.settled) continue;
        const sent = child.process.kill("SIGTERM");
        record("pair.child_stop_requested", { name, pid: child.process.pid ?? null, sent });
        await child.finished;
      }
      record("pair.stopped", { exitCode });
      process.exit(exitCode);
    } finally {
      clearTimeout(timer);
    }
  })();
  return stopPromise;
}

function startChild(name, entry) {
  const childProcess = spawn(path.join(values.get("--prefix"), "bin", entry), productArguments, {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  let finish;
  const child = {
    process: childProcess,
    settled: false,
    finished: new Promise((resolve) => {
      finish = resolve;
    }),
  };
  children.set(name, child);
  childProcess.once("exit", (code, signal) => {
    child.settled = true;
    finish();
    record("pair.child_exit", { name, pid: childProcess.pid ?? null, code, signal });
    if (!stopping) void stop(1, `${name}_exit`);
  });
  childProcess.once("error", (error) => {
    child.settled = true;
    finish();
    record("pair.child_error", { name, code: error.code ?? "PAIR_CHILD_ERROR" });
    if (!stopping) void stop(1, `${name}_error`);
  });
  return new Promise((resolve, reject) => {
    childProcess.once("spawn", () => {
      record("pair.child_spawned", { name, pid: childProcess.pid });
      resolve();
    });
    childProcess.once("error", reject);
  });
}

process.once("SIGTERM", () => void stop(0, "SIGTERM"));
process.once("SIGINT", () => void stop(0, "SIGINT"));

try {
  await startChild("worker", "himawari-execution-worker");
  if (!stopping) await startChild("agent", "himawari-agent-service");
  if (!stopping) record("pair.processes_started");
} catch {
  await stop(1, "PAIR_START_FAILED");
}
