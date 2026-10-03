import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiFilePreparationPool } from "../../packages/runtime-pi/src/pi-file-preparation-pool.ts";
import {
  type PiFilePreparationInput,
  stopPiPreparationWorker,
} from "../../packages/runtime-pi/src/prepare-file-mutation.ts";

type Mode = "actual" | "fail" | "exit" | "never-ready" | "busy";
type Event = {
  readonly stage:
    | "constructor"
    | "online"
    | "message"
    | "input"
    | "error"
    | "exit"
    | "close"
    | "delivery";
  readonly sequence: number;
  readonly value?: unknown;
};
type WorkerRecord = {
  readonly worker: Worker;
  readonly threadId: number;
  readonly filename: string;
  readonly mode: Mode;
  readonly prewarm: boolean;
  readonly workerData: unknown;
  readonly execArgv: readonly string[] | undefined;
  readonly resourceLimits: WorkerOptions["resourceLimits"];
  readonly progress: Int32Array;
  readonly events: Event[];
};
type Pool = ReturnType<typeof createPiFilePreparationPool>;
type PreparationInput = Parameters<Pool["prepare"]>[0];

const observations = vi.hoisted(() => ({
  records: [] as WorkerRecord[],
  byWorker: new WeakMap<Worker, WorkerRecord>(),
  listeners: new Set<() => void>(),
  mode: "actual" as Mode,
  sequence: 0,
}));

vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  const scripts: Record<Exclude<Mode, "actual">, string> = {
    fail: `throw new Error("PI_TEST_WARM_FAILURE");`,
    exit: `process.exit(0);`,
    "never-ready": `const { parentPort } = require("node:worker_threads");
parentPort.on("message", () => {});`,
    busy: `const { parentPort, workerData } = require("node:worker_threads");
const progress = new Int32Array(workerData.progress);
parentPort.postMessage({ kind: "ready" });
parentPort.on("message", (message) => {
  if (message.kind !== "input") return;
  Atomics.store(progress, 0, 1);
  parentPort.postMessage({ kind: "started" });
  while (true) Atomics.add(progress, 1, 1);
});`,
  };
  const notify = () => {
    for (const listener of [...observations.listeners]) listener();
  };
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const target = filename instanceof URL ? filename.href : filename;
        const preparation = /\/prepare-file-mutation-worker\.(?:ts|js)(?:\?|$)/.test(target);
        const prewarm = preparation && options?.workerData?.prewarm === true;
        const mode = prewarm ? observations.mode : "actual";
        const progress = new Int32Array(new SharedArrayBuffer(8));
        super(
          mode === "actual" ? filename : scripts[mode],
          mode === "actual"
            ? options
            : {
                ...options,
                eval: true,
                workerData: { progress: progress.buffer },
              },
        );
        if (!preparation) return;
        const record: WorkerRecord = {
          worker: this,
          threadId: this.threadId,
          filename: target,
          mode,
          prewarm,
          workerData: options?.workerData,
          execArgv: options?.execArgv,
          resourceLimits: options?.resourceLimits,
          progress,
          events: [{ stage: "constructor", sequence: ++observations.sequence }],
        };
        observations.records.push(record);
        observations.byWorker.set(this, record);
        this.on("online", () => {
          record.events.push({ stage: "online", sequence: ++observations.sequence });
          notify();
        });
        this.on("message", (message: unknown) => {
          record.events.push({
            stage: "message",
            sequence: ++observations.sequence,
            value: message,
          });
          notify();
        });
        this.on("error", (error: Error) => {
          record.events.push({
            stage: "error",
            sequence: ++observations.sequence,
            value: error.message,
          });
          notify();
        });
        this.on("exit", (code: number) => {
          record.events.push({ stage: "exit", sequence: ++observations.sequence, value: code });
          notify();
        });
        notify();
      }

      override postMessage(...arguments_: Parameters<Worker["postMessage"]>) {
        observations.byWorker.get(this)?.events.push({
          stage: "input",
          sequence: ++observations.sequence,
          value: arguments_[0],
        });
        const result = super.postMessage(...arguments_);
        notify();
        return result;
      }
    },
  };
});

const pools: Pool[] = [];
const roots: string[] = [];
const memoryBytes = 256 * 1048576;
const limits = { maxWallTimeMs: 10000, maxCpuTimeMs: 10000, maxMemoryBytes: memoryBytes };
let callSequence = 0;

function notify() {
  for (const listener of [...observations.listeners]) listener();
}

function waitFor(condition: () => boolean): Promise<void> {
  if (condition()) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      if (!condition()) return;
      observations.listeners.delete(listener);
      resolve();
    };
    observations.listeners.add(listener);
    listener();
  });
}

function messageIs(event: Event, kind: string) {
  return (
    event.stage === "message" &&
    event.value !== null &&
    typeof event.value === "object" &&
    "kind" in event.value &&
    event.value.kind === kind
  );
}

function ready(record: WorkerRecord) {
  return record.events.some((event) => messageIs(event, "ready"));
}

function online(record: WorkerRecord | undefined) {
  return record?.events.some(({ stage }) => stage === "online") === true;
}

function inputs(record: WorkerRecord) {
  return record.events.filter(({ stage }) => stage === "input");
}

function warmRecords() {
  return observations.records.filter(({ prewarm }) => prewarm);
}

async function readyWorker(excluded: readonly number[] = []) {
  await waitFor(() =>
    warmRecords().some((record) => ready(record) && !excluded.includes(record.threadId)),
  );
  const record = warmRecords().find(
    (candidate) => ready(candidate) && !excluded.includes(candidate.threadId),
  );
  if (!record) throw new Error("PI_TEST_READY_WORKER_MISSING");
  return record;
}

function pool(onWarmupFailure?: (error: Error) => void) {
  const value = createPiFilePreparationPool({
    maxMemoryBytes: memoryBytes,
    ...(onWarmupFailure ? { onWarmupFailure } : {}),
  });
  pools.push(value);
  return value;
}

async function fixture(before = "before\n") {
  const root = await mkdtemp(path.join(testTemporaryRoot(), "pi-pool-"));
  roots.push(root);
  const targetPath = path.join(root, "file.txt");
  await writeFile(targetPath, before);
  return { root, targetPath, before: new TextEncoder().encode(before) };
}

function input(
  source: Awaited<ReturnType<typeof fixture>>,
  content = "candidate\n",
  overrides: Partial<PreparationInput> = {},
): PreparationInput {
  return {
    tool: "write",
    toolCallId: `pi-pool-${++callSequence}`,
    cwd: source.root,
    targetPath: source.targetPath,
    parameters: { path: "file.txt", content },
    before: source.before,
    limits,
    ...overrides,
  };
}

function checkLimits(record: WorkerRecord, expectedMemoryMb = 256) {
  expect(record.execArgv).toEqual([]);
  expect(record.resourceLimits).toEqual({
    maxOldGenerationSizeMb: Math.floor(expectedMemoryMb * 0.75),
    maxYoungGenerationSizeMb: Math.floor(expectedMemoryMb * 0.125),
    codeRangeSizeMb: Math.floor(expectedMemoryMb * 0.0625),
    stackSizeMb: Math.floor(expectedMemoryMb * 0.0625),
  });
  expect(record.workerData).toEqual(record.prewarm ? { prewarm: true } : undefined);
}

beforeEach(() => {
  observations.records.length = 0;
  observations.listeners.clear();
  observations.byWorker = new WeakMap();
  observations.mode = "actual";
  observations.sequence = 0;
  callSequence = 0;
});

afterEach(async (context) => {
  try {
    await Promise.all(pools.splice(0).map((value) => value.close()));
    expect(observations.records.every(({ worker }) => worker.threadId === -1)).toBe(true);
  } finally {
    const threadIdsAfterClose = observations.records.map(({ worker }) => worker.threadId);
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(observations.records.map(({ worker }) => worker.terminate()));
    const records = observations.records.map(({ worker, progress, ...record }, index) => ({
      ...record,
      threadIdAfterClose: threadIdsAfterClose[index],
      finalThreadId: worker.threadId,
      progress: Array.from(progress),
    }));
    Object.assign(context.task.meta, { piPreparationPoolWorkers: records });
    const output = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
    if (output) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(output, `pi-pool-${context.task.id}.json`),
        JSON.stringify({ name: context.task.name, records }, null, 2),
        { mode: 0o600, flag: "wx" },
      );
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    observations.listeners.clear();
  }
});

describe("one-shot Pi file preparation pool", () => {
  it("[R2-D19] hands one input to a ready worker and preserves the frozen original", async () => {
    const source = await fixture();
    const preparation = pool();
    expect(warmRecords()).toHaveLength(1);
    const warm = await readyWorker();
    checkLimits(warm);
    expect(inputs(warm)).toHaveLength(0);
    const request = input(source, "真实 Pi 候选\n");
    const timers = vi.spyOn(globalThis, "setTimeout");
    const pending = preparation.prepare(request);
    expect(timers.mock.calls.some(([, milliseconds]) => milliseconds === 10000)).toBe(true);
    const result = await pending;
    expect(new TextDecoder().decode(result.bytes)).toBe("真实 Pi 候选\n");
    expect(result.result.isError).toBe(false);
    expect(inputs(warm)).toHaveLength(1);
    expect(inputs(warm)[0]?.value).toMatchObject({
      kind: "input",
      input: { toolCallId: request.toolCallId },
    });
    const readySequence = warm.events.find((event) => messageIs(event, "ready"))?.sequence;
    expect(readySequence).toBeDefined();
    expect(inputs(warm)[0]?.sequence).toBeGreaterThan(readySequence as number);
    expect(warm.worker.threadId).toBe(-1);
    expect(await readFile(source.targetPath, "utf8")).toBe("before\n");
  });

  it("[R2-D19] rejects cancellation before handing input to its ready worker", async () => {
    const source = await fixture();
    const preparation = pool();
    const warm = await readyWorker();
    const controller = new AbortController();
    controller.abort(new Error("PI_TEST_CANCELLED_BEFORE_HANDOFF"));
    await expect(
      preparation.prepare(input(source, "unused\n", { signal: controller.signal })),
    ).rejects.toThrow("PI_TEST_CANCELLED_BEFORE_HANDOFF");
    expect(inputs(warm)).toHaveLength(0);
    expect(observations.records.filter(({ prewarm }) => !prewarm)).toHaveLength(0);
    expect(new TextDecoder().decode((await preparation.prepare(input(source))).bytes)).toBe(
      "candidate\n",
    );
    expect(inputs(warm)).toHaveLength(1);
  });

  it("[R2-D19] starts cold immediately while the prewarm worker has no ready message", async () => {
    observations.mode = "never-ready";
    const source = await fixture();
    const preparation = pool();
    await waitFor(() => online(warmRecords()[0]));
    const pending = preparation.prepare(input(source));
    const cold = observations.records.find(({ prewarm }) => !prewarm);
    expect(cold).toBeDefined();
    if (!cold) throw new Error("PI_TEST_COLD_WORKER_MISSING");
    checkLimits(cold);
    expect(inputs(cold)).toHaveLength(1);
    expect(ready(warmRecords()[0] as WorkerRecord)).toBe(false);
    expect(new TextDecoder().decode((await pending).bytes)).toBe("candidate\n");
    expect(cold.worker.threadId).toBe(-1);
    expect(warmRecords()).toHaveLength(1);
  });

  it("[R2-D19] consumes one ready worker and sends concurrent overflow to cold", async () => {
    const source = await fixture();
    const preparation = pool();
    const warm = await readyWorker();
    const first = preparation.prepare(input(source, "first\n"));
    const second = preparation.prepare(input(source, "second\n"));
    const cold = observations.records.filter(({ prewarm }) => !prewarm);
    expect(cold).toHaveLength(1);
    expect(inputs(warm)).toHaveLength(1);
    const results = await Promise.all([first, second]);
    expect(results.map(({ bytes }) => new TextDecoder().decode(bytes))).toEqual([
      "first\n",
      "second\n",
    ]);
    expect(warm.worker.threadId).toBe(-1);
    expect(cold[0]?.worker.threadId).toBe(-1);
    await readyWorker([warm.threadId]);
    expect(
      warmRecords().filter(
        (record) => record.worker.threadId !== -1 && inputs(record).length === 0,
      ),
    ).toHaveLength(1);
    expect(await readFile(source.targetPath, "utf8")).toBe("before\n");
  });

  it("[R2-D19] keeps a ready worker for an exact computed resource-limit match", async () => {
    const source = await fixture();
    const preparation = pool();
    const warm = await readyWorker();
    const mismatch = input(source, "larger limit\n", {
      limits: { ...limits, maxMemoryBytes: 512 * 1048576 },
    });
    const result = await preparation.prepare(mismatch);
    expect(new TextDecoder().decode(result.bytes)).toBe("larger limit\n");
    const cold = observations.records.find(({ prewarm }) => !prewarm);
    if (!cold) throw new Error("PI_TEST_MISMATCH_COLD_WORKER_MISSING");
    checkLimits(cold, 512);
    expect(inputs(warm)).toHaveLength(0);
    const matched = await preparation.prepare(
      input(source, "same integer limits\n", {
        limits: { ...limits, maxMemoryBytes: memoryBytes + 1048576 },
      }),
    );
    expect(new TextDecoder().decode(matched.bytes)).toBe("same integer limits\n");
    expect(inputs(warm)).toHaveLength(1);
    expect(observations.records.filter(({ prewarm }) => !prewarm)).toHaveLength(1);
  });

  it.each([
    ["fail", "PI_TEST_WARM_FAILURE"],
    ["exit", "PI_PREPARATION_WORKER_EXITED"],
  ] as const)(
    "[R2-D19] reports a real warm %s and falls back to actual Pi",
    async (mode, errorMessage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      observations.mode = mode;
      const failures: Error[] = [];
      const preparation = pool((error) => {
        failures.push(error);
        notify();
      });
      const source = await fixture();
      await waitFor(() => failures.length === 1 && warmRecords()[0]?.worker.threadId === -1);
      expect(failures[0]).toBeInstanceOf(Error);
      expect(failures[0]?.message).toBe(errorMessage);
      const result = await preparation.prepare(input(source));
      expect(new TextDecoder().decode(result.bytes)).toBe("candidate\n");
      const cold = observations.records.find(({ prewarm }) => !prewarm);
      if (!cold) throw new Error("PI_TEST_FAILURE_COLD_WORKER_MISSING");
      checkLimits(cold);
      expect(cold.worker.threadId).toBe(-1);
    },
  );

  it("[R2-D19] gives prewarm its own 8000ms deadline and stops it before cold fallback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    observations.mode = "never-ready";
    const failures: Error[] = [];
    const preparation = pool((error) => {
      failures.push(error);
      notify();
    });
    const source = await fixture();
    await waitFor(() => online(warmRecords()[0]));
    await vi.advanceTimersByTimeAsync(7999);
    expect(failures).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => failures.length === 1 && warmRecords()[0]?.worker.threadId === -1);
    expect(failures[0]?.message).toBe("PI_PREPARATION_WARMUP_TIME_LIMIT");
    expect(new TextDecoder().decode((await preparation.prepare(input(source))).bytes)).toBe(
      "candidate\n",
    );
  });

  it("[R2-D19] rejects a real ready received after its monotonic deadline before the timer callback", async (context) => {
    const source = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const failures: Error[] = [];
    let readyCallbackCount = 0;
    const preparation = createPiFilePreparationPool({
      maxMemoryBytes: memoryBytes,
      onWarmupReady() {
        readyCallbackCount += 1;
      },
      onWarmupFailure(error) {
        failures.push(error);
        notify();
      },
    });
    pools.push(preparation);
    now = 8001;
    const warm = await readyWorker();
    Object.assign(context.task.meta, {
      piPreparationLateReady: {
        creationClockMs: 0,
        readyClockMs: now,
        readyCallbackCount,
        timerAdvanced: false,
        threadId: warm.threadId,
      },
    });
    expect(readyCallbackCount).toBe(0);
    await waitFor(() => failures.length === 1 && warm.worker.threadId === -1);
    expect(failures[0]?.message).toBe("PI_PREPARATION_WARMUP_TIME_LIMIT");
    expect(inputs(warm)).toHaveLength(0);
    clock.mockRestore();
    const result = await preparation.prepare(input(source));
    expect(new TextDecoder().decode(result.bytes)).toBe("candidate\n");
    const cold = observations.records.find(({ prewarm }) => !prewarm);
    if (!cold) throw new Error("PI_TEST_LATE_READY_COLD_WORKER_MISSING");
    checkLimits(cold);
    expect(cold.worker.threadId).toBe(-1);
  });

  it("[R2-D19] limits consecutive prewarm failures to three attempts with 1s and 2s backoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    observations.mode = "fail";
    const failures: Error[] = [];
    const preparation = pool((error) => {
      failures.push(error);
      notify();
    });
    await waitFor(() => failures.length === 1 && warmRecords()[0]?.worker.threadId === -1);
    await vi.advanceTimersByTimeAsync(999);
    expect(warmRecords()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => failures.length === 2 && warmRecords()[1]?.worker.threadId === -1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(warmRecords()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => failures.length === 3 && warmRecords()[2]?.worker.threadId === -1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(warmRecords()).toHaveLength(3);
    expect(failures.map(({ message }) => message)).toEqual(Array(3).fill("PI_TEST_WARM_FAILURE"));
    await preparation.close();
    await preparation.close();
    await expect(preparation.prepare(input(await fixture()))).rejects.toThrow(
      "PI_PREPARATION_POOL_CLOSED",
    );
  });

  it.each(["cancel", "timeout"] as const)(
    "[R2-D19] stops a running warm computation on %s before refilling with a fresh worker",
    async (reason) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      observations.mode = "busy";
      const source = await fixture();
      const preparation = pool();
      const warm = await readyWorker();
      const controller = new AbortController();
      const pending = preparation.prepare(input(source, "unused\n", { signal: controller.signal }));
      const rejected = expect(pending).rejects.toThrow(
        reason === "cancel" ? "PI_PREPARATION_CANCELLED" : "PI_PREPARATION_TIME_LIMIT",
      );
      await waitFor(() => warm.events.some((event) => messageIs(event, "started")));
      expect(Atomics.load(warm.progress, 0)).toBe(1);
      observations.mode = "actual";
      if (reason === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(10000);
      await rejected;
      expect(warm.worker.threadId).toBe(-1);
      const stoppedCount = Atomics.load(warm.progress, 1);
      const replacement = await readyWorker([warm.threadId]);
      expect(replacement.threadId).not.toBe(warm.threadId);
      expect(Atomics.load(warm.progress, 1)).toBe(stoppedCount);
      expect(new TextDecoder().decode((await preparation.prepare(input(source))).bytes)).toBe(
        "candidate\n",
      );
      expect(replacement.worker.threadId).toBe(-1);
    },
  );

  it("[R2-D19] uses a different real Pi worker for every request", async () => {
    const source = await fixture();
    const preparation = pool();
    const first = await readyWorker();
    await preparation.prepare(input(source, "first\n"));
    expect(first.worker.threadId).toBe(-1);
    const second = await readyWorker([first.threadId]);
    await preparation.prepare(input(source, "second\n"));
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.worker.threadId).toBe(-1);
    expect(inputs(first)).toHaveLength(1);
    expect(inputs(second)).toHaveLength(1);
    expect(await readFile(source.targetPath, "utf8")).toBe("before\n");
  });

  it("[R2-D19] rejects a second input at the actual worker entry without computing it", async () => {
    const source = await fixture();
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = new Worker(
      new URL(
        `../../packages/runtime-pi/src/prepare-file-mutation-worker.${extension}`,
        import.meta.url,
      ),
      {
        workerData: { prewarm: true },
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
          codeRangeSizeMb: 16,
          stackSizeMb: 16,
        },
      },
    );
    const record = observations.records.find((candidate) => candidate.worker === worker);
    if (!record) throw new Error("PI_TEST_DIRECT_WORKER_MISSING");
    await waitFor(() => ready(record));
    const { signal: _signal, limits: _limits, ...first } = input(source);
    worker.postMessage({ kind: "input", input: first });
    worker.postMessage({
      kind: "input",
      input: { ...first, toolCallId: "second-must-not-compute", tool: "invalid" },
    });
    await waitFor(() =>
      record.events.some(
        ({ stage, value }) =>
          stage === "message" &&
          value !== null &&
          typeof value === "object" &&
          "error" in value &&
          value.error === "PI_PREPARATION_INPUT_ALREADY_ACCEPTED",
      ),
    );
    await worker.terminate();
    expect(worker.threadId).toBe(-1);
    expect(
      record.events.filter(
        ({ stage, value }) =>
          stage === "message" &&
          value !== null &&
          typeof value === "object" &&
          "ok" in value &&
          value.ok === true,
      ).length,
    ).toBeLessThanOrEqual(1);
    expect(
      record.events
        .filter(
          ({ stage, value }) =>
            stage === "message" &&
            value !== null &&
            typeof value === "object" &&
            "ok" in value &&
            value.ok === false,
        )
        .map(({ value }) => value),
    ).toEqual([{ ok: false, error: "PI_PREPARATION_INPUT_ALREADY_ACCEPTED" }]);
    expect(await readFile(source.targetPath, "utf8")).toBe("before\n");
  });

  it.each(["never-ready", "actual"] as const)(
    "[R2-D19] closes a %s idle worker and prevents late refill",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      observations.mode = mode;
      const preparation = pool();
      if (mode === "actual") await readyWorker();
      else await waitFor(() => online(warmRecords()[0]));
      await Promise.all([preparation.close(), preparation.close()]);
      expect(warmRecords()[0]?.worker.threadId).toBe(-1);
      await vi.advanceTimersByTimeAsync(30000);
      expect(observations.records).toHaveLength(1);
      await expect(preparation.prepare(input(await fixture()))).rejects.toThrow(
        "PI_PREPARATION_POOL_CLOSED",
      );
    },
  );

  it("[R2-D19] closes an already consumed busy worker and prevents its finally from refilling", async () => {
    observations.mode = "busy";
    const source = await fixture();
    const preparation = pool();
    const warm = await readyWorker();
    const outcome = preparation.prepare(input(source)).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await waitFor(() => warm.events.some((event) => messageIs(event, "started")));
    observations.mode = "actual";
    await preparation.close();
    expect((await outcome).error).toBeInstanceOf(Error);
    expect(warm.worker.threadId).toBe(-1);
    expect(observations.records).toHaveLength(1);
    await expect(preparation.prepare(input(source))).rejects.toThrow("PI_PREPARATION_POOL_CLOSED");
  });

  it("[R2-D19] rejects success when close runs after stop completion but before preparation delivery", async (context) => {
    const source = await fixture();
    const preparation = pool();
    const warm = await readyWorker();
    let closedSequence: number | undefined;
    let deliverySequence: number | undefined;
    let closing: Promise<void> | undefined;
    let markClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
      markClosed = resolve;
      rejectClosed = reject;
    });
    const pending = preparation.prepare(input(source, "real success before close\n"));
    warm.worker.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("ok" in message) || message.ok !== true)
        return;
      void stopPiPreparationWorker(warm.worker).then(() => {
        closing = preparation.close();
        closedSequence = ++observations.sequence;
        warm.events.push({ stage: "close", sequence: closedSequence });
        markClosed();
      }, rejectClosed);
    });
    const delivered = pending.then(
      (value) => {
        deliverySequence = ++observations.sequence;
        warm.events.push({
          stage: "delivery",
          sequence: deliverySequence,
          value: { outcome: "success", closedSequence },
        });
        return { outcome: "success" as const, value };
      },
      (error: unknown) => {
        deliverySequence = ++observations.sequence;
        warm.events.push({
          stage: "delivery",
          sequence: deliverySequence,
          value: {
            outcome: "error",
            closedSequence,
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return { outcome: "error" as const, error };
      },
    );
    await closed;
    const result = await delivered;
    await closing;
    Object.assign(context.task.meta, {
      piPreparationClosedDelivery: {
        closedSequence,
        deliverySequence,
        outcome: result.outcome,
        error:
          result.outcome === "error" && result.error instanceof Error ? result.error.message : null,
      },
    });
    expect(closedSequence).toBeDefined();
    expect(deliverySequence).toBeGreaterThan(closedSequence as number);
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.error).toBeInstanceOf(Error);
    expect(warm.worker.threadId).toBe(-1);
    expect(observations.records).toHaveLength(1);
    expect(await readFile(source.targetPath, "utf8")).toBe("before\n");
  });

  it("[R2-D19] closes both its warming slot and an active cold request", async () => {
    observations.mode = "never-ready";
    const source = await fixture();
    const preparation = pool();
    await waitFor(() => online(warmRecords()[0]));
    const outcome = preparation.prepare(input(source)).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    expect(observations.records.filter(({ prewarm }) => !prewarm)).toHaveLength(1);
    await preparation.close();
    expect((await outcome).error).toBeInstanceOf(Error);
    expect(observations.records.every(({ worker }) => worker.threadId === -1)).toBe(true);
    expect(observations.records).toHaveLength(2);
  });

  it("[R2-D19] keeps real Pi multi-edit BOM, CRLF and Unicode behavior in a fresh preparation", async () => {
    const before = "\uFEFFtitle\r\nalpha\r\nbeta\r\n尾行\r\n";
    const source = await fixture(before);
    const preparation = pool();
    const warm = await readyWorker();
    const request: PiFilePreparationInput = {
      tool: "edit",
      toolCallId: "multi-edit-pool",
      cwd: source.root,
      targetPath: source.targetPath,
      parameters: {
        path: "file.txt",
        edits: [
          { oldText: "alpha\nbeta", newText: "first\nsecond" },
          { oldText: "尾行", newText: "结束 🌻" },
        ],
      },
      before: source.before,
    };
    const result = await preparation.prepare({ ...request, limits });
    expect(Buffer.from(result.bytes).toString("utf8")).toBe(
      "\uFEFFtitle\r\nfirst\r\nsecond\r\n结束 🌻\r\n",
    );
    expect(result.result.isError).toBe(false);
    expect(warm.worker.threadId).toBe(-1);
    expect(await readFile(source.targetPath, "utf8")).toBe(before);
    expect(Array.from(source.before)).toEqual(Array.from(new TextEncoder().encode(before)));
  });
});
