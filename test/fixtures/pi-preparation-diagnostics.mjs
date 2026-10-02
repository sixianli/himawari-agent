import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";

const workerThreads = createRequire(import.meta.url)("node:worker_threads");

const environmentKey = "himawari.test.piPreparationTiming";
const slots = {
  preload: 0,
  firstLoad: 1,
  rootLoadStart: 2,
  rootLoadEnd: 3,
  body: 4,
  loadNanoseconds: 5,
  loadCount: 6,
  activeLoadStart: 7,
  loadFailureCount: 8,
};
const records = [];
let currentCase = {};
const enabled = Boolean(process.env.HIMAWARI_TEST_DIAGNOSTIC_OUTPUT);
const preloadUrl = new URL(import.meta.url);
preloadUrl.search = "";

function timestamp() {
  return { at: Date.now(), monotonicNs: process.hrtime.bigint().toString() };
}

function sharedSnapshot(shared) {
  return Object.fromEntries(
    Object.entries(slots).map(([name, index]) => {
      const value = Atomics.load(shared, index);
      return [name, value === 0n ? null : value.toString()];
    }),
  );
}

export function beginPiPreparationDiagnostics(context) {
  currentCase = context;
}

export function wrapPiPreparationWorker(Worker) {
  if (!enabled) return Worker;
  return class extends Worker {
    constructor(filename, options) {
      const target = filename instanceof URL ? filename.href : String(filename);
      if (!/\/prepare-file-mutation-worker\.(?:ts|js)(?:\?|$)/.test(target)) {
        super(filename, options);
        return;
      }
      const shared = new BigInt64Array(new SharedArrayBuffer(9 * BigInt64Array.BYTES_PER_ELEMENT));
      const record = {
        ...currentCase,
        id: randomUUID(),
        target,
        processId: process.pid,
        parentThreadId: workerThreads.threadId,
        tool: options?.workerData?.tool,
        toolCallId: options?.workerData?.toolCallId,
        events: [{ stage: "creation", ...timestamp() }],
        shared,
      };
      const previous = workerThreads.getEnvironmentData(environmentKey);
      workerThreads.setEnvironmentData(environmentKey, { shared: shared.buffer });
      try {
        super(filename, {
          ...options,
          execArgv: [...(options?.execArgv ?? process.execArgv), "--import", preloadUrl.href],
        });
      } finally {
        workerThreads.setEnvironmentData(environmentKey, previous);
      }
      record.workerThreadId = this.threadId;
      record.events.push({ stage: "created", ...timestamp() });
      records.push(record);
      this.on("online", () => record.events.push({ stage: "online", ...timestamp() }));
      this.on("message", (message) => {
        if (message?.kind === "started") {
          record.events.push({ stage: "started", ...timestamp() });
        } else if (typeof message?.ok === "boolean") {
          record.events.push({ stage: "result", ok: message.ok, ...timestamp() });
        }
      });
      this.on("error", (error) => {
        record.events.push({ stage: "error", code: error.code ?? null, ...timestamp() });
      });
      this.on("exit", (code) => record.events.push({ stage: "exit", code, ...timestamp() }));
    }
  };
}

export function piPreparationDiagnosticArguments() {
  if (!enabled) return [];
  const url = new URL(preloadUrl);
  url.searchParams.set("parent", "1");
  url.searchParams.set("case", JSON.stringify(currentCase));
  return ["--import", url.href];
}

export function flushPiPreparationDiagnostics() {
  const output = process.env.HIMAWARI_TEST_DIAGNOSTIC_OUTPUT;
  if (!output || records.length === 0) return;
  const selected = [...records];
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(output, `pi-preparation-${process.pid}-${randomUUID()}.json`),
    JSON.stringify({
      processId: process.pid,
      vitestWorkerId: process.env.VITEST_WORKER_ID ?? null,
      vitestPoolId: process.env.VITEST_POOL_ID ?? null,
      recordedAt: Date.now(),
      records: selected.map(({ shared, ...record }) => ({
        ...record,
        snapshotStableAfterExit: record.events.some((event) => event.stage === "exit"),
        workerStages: sharedSnapshot(shared),
      })),
    }),
    { mode: 0o600, flag: "wx" },
  );
  for (const record of selected) {
    if (record.events.some((event) => event.stage === "exit")) {
      records.splice(records.indexOf(record), 1);
    }
  }
}

if (enabled && !workerThreads.isMainThread) {
  const data = workerThreads.getEnvironmentData(environmentKey);
  if (data?.shared) {
    workerThreads.setEnvironmentData(environmentKey, undefined);
    const shared = new BigInt64Array(data.shared);
    Atomics.store(shared, slots.preload, process.hrtime.bigint());
    globalThis[Symbol.for("himawari.test.piPreparationBody")] = () => {
      Atomics.store(shared, slots.body, process.hrtime.bigint());
    };
    let loadDepth = 0;
    registerHooks({
      load(url, context, nextLoad) {
        const start = process.hrtime.bigint();
        if (loadDepth++ === 0) Atomics.store(shared, slots.activeLoadStart, start);
        Atomics.compareExchange(shared, slots.firstLoad, 0n, start);
        const root = /\/prepare-file-mutation-worker\.(?:ts|js)(?:\?|$)/.test(url);
        if (root) Atomics.store(shared, slots.rootLoadStart, start);
        try {
          const loaded = nextLoad(url, context);
          if (!root) return loaded;
          Atomics.store(shared, slots.rootLoadEnd, process.hrtime.bigint());
          const source =
            typeof loaded.source === "string"
              ? loaded.source
              : Buffer.from(loaded.source).toString("utf8");
          return {
            ...loaded,
            source: `globalThis[Symbol.for("himawari.test.piPreparationBody")]();\n${source}`,
          };
        } catch (error) {
          Atomics.add(shared, slots.loadFailureCount, 1n);
          throw error;
        } finally {
          Atomics.add(shared, slots.loadNanoseconds, process.hrtime.bigint() - start);
          Atomics.add(shared, slots.loadCount, 1n);
          if (--loadDepth === 0) Atomics.store(shared, slots.activeLoadStart, 0n);
        }
      },
    });
  }
}

if (enabled && workerThreads.isMainThread && new URL(import.meta.url).searchParams.has("parent")) {
  currentCase = JSON.parse(new URL(import.meta.url).searchParams.get("case") ?? "{}");
  workerThreads.Worker = wrapPiPreparationWorker(workerThreads.Worker);
  syncBuiltinESMExports();
  process.on("exit", flushPiPreparationDiagnostics);
}
