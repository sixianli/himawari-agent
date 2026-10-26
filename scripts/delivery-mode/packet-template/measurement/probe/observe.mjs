import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";

export const role = !isMainThread ? "sdk-thread" : (process.argv[1] ?? "").endsWith("/job-host-main.js") ? "host" : "caller";
const destination = process.env.HIMAWARI___PKT_LABEL_UPPER___PROBE_LOG;
if (!destination || !path.isAbsolute(destination)) throw new Error("PROBE_LOG_REQUIRED");
const started = performance.now();
const startedEpochMs = Date.now();
const events = [];
const maximumEvents = 50_000;
let droppedEvents = 0;
let timerLateMaxMs = 0;
let phase = "startup";
let flushed = false;
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let expected = performance.now() + 25;
const timer = setInterval(() => {
  const now = performance.now();
  const lateMs = Math.max(0, now - expected);
  timerLateMaxMs = Math.max(timerLateMaxMs, lateMs);
  record({ kind: "timer", lateMs });
  expected = now + 25;
}, 25);
timer.unref();

export function record(value) {
  if (events.length < maximumEvents) events.push({ atMs: performance.now(), epochMs: Date.now(), phase, ...value });
  else droppedEvents += 1;
}

export function stage(value) {
  phase = value;
  record({ kind: "stage", stage: value });
}

export function measure(name, action) {
  const beginMs = performance.now();
  const cpuBefore = process.cpuUsage();
  const finish = (outcome) => record({ kind: "span", name, beginMs, durationMs: performance.now() - beginMs, cpu: process.cpuUsage(cpuBefore), outcome });
  try {
    const value = action();
    if (value && typeof value.then === "function") return value.then((result) => { finish("returned"); return result; }, (error) => { finish("threw"); throw error; });
    finish("returned");
    return value;
  } catch (error) {
    finish("threw");
    throw error;
  }
}

export function flush(reason) {
  if (flushed) return;
  flushed = true;
  clearInterval(timer);
  const status = fs.readFileSync("/proc/self/status", "utf8").split("\n").filter((line) => /^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):/.test(line));
  const report = { schema: "himawari-__PKT_LABEL__-service-read-observation.v1", role, pid: process.pid, threadId, startedEpochMs, startedMs: started, finishedMs: performance.now(), reason, environment: { uid: process.getuid(), gid: process.getgid(), umask: process.umask().toString(8), HOME: process.env.HOME ?? null, PATH: process.env.PATH ?? null, TMPDIR: process.env.TMPDIR ?? null, status }, maximumEvents, droppedEvents, timerLateMaxMs, histogramMaxMs: histogram.count ? histogram.max / 1e6 : null, histogramCount: histogram.count, events, limits: "Probe adds load hooks, timers and in-memory records. Timer lateness includes the first module load. Host child retains product HOME/TMPDIR rebinding. This is one synthetic read, not the service pair or original failure attribution." };
  histogram.disable();
  fs.writeFileSync(path.join(destination, `observation-${role}-${process.pid}-${threadId}.json`), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

process.once("exit", () => flush("exit"));
