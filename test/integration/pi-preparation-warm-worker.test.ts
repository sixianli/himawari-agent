import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Worker, WorkerOptions } from "node:worker_threads";
import {
  PI_PREPARED_FILE_CONTRACT,
  PI_WRITE_VERIFIER,
  type SandboxOperationBinding,
} from "@himawari-agent/execution-contracts";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { ConstrainedHostFileSystem } from "@himawari-agent/platform-node";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackPiPreparationDiagnostics } from "../fixtures/pi-preparation-diagnostics.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";

type WorkerEvent = {
  readonly stage: "constructor" | "message" | "postMessage" | "exit";
  readonly monotonicNs: string;
  readonly value?: unknown;
};

type PreparationWorkerRecord = {
  readonly filename: string;
  readonly workerData: unknown;
  readonly threadId: number;
  readonly events: WorkerEvent[];
  readonly ready: Promise<void>;
  readonly worker: Worker;
};

const preparationWorkers = vi.hoisted(() => ({
  records: [] as PreparationWorkerRecord[],
  byWorker: new WeakMap<Worker, PreparationWorkerRecord>(),
  onColdCreated: undefined as ((record: PreparationWorkerRecord) => void) | undefined,
  heldWarmTerminationUntilColdCreation: false,
}));

vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  const url = new URL("../fixtures/pi-preparation-diagnostics.mjs", import.meta.url).href;
  const { wrapPiPreparationWorker } = await import(url);
  const DiagnosticWorker: typeof actual.Worker = wrapPiPreparationWorker(actual.Worker);
  return {
    ...actual,
    Worker: class extends DiagnosticWorker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const target = filename instanceof URL ? filename.href : filename;
        const monotonicNs = process.hrtime.bigint().toString();
        super(filename, options);
        if (!/\/prepare-file-mutation-worker\.(?:ts|js)(?:\?|$)/.test(target)) return;
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        let readyObserved = false;
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        void ready.catch(() => {});
        const record: PreparationWorkerRecord = {
          filename: target,
          workerData: options?.workerData,
          threadId: this.threadId,
          events: [{ stage: "constructor", monotonicNs }],
          ready,
          worker: this,
        };
        preparationWorkers.records.push(record);
        preparationWorkers.byWorker.set(this, record);
        if (
          !options?.workerData ||
          typeof options.workerData !== "object" ||
          options.workerData.prewarm !== true
        )
          preparationWorkers.onColdCreated?.(record);
        this.on("message", (message: unknown) => {
          record.events.push({
            stage: "message",
            monotonicNs: process.hrtime.bigint().toString(),
            value: message,
          });
          if (
            message &&
            typeof message === "object" &&
            "kind" in message &&
            message.kind === "ready"
          ) {
            readyObserved = true;
            resolveReady();
          }
        });
        this.once("error", rejectReady);
        this.once("exit", (code) => {
          record.events.push({
            stage: "exit",
            monotonicNs: process.hrtime.bigint().toString(),
            value: code,
          });
          if (!readyObserved) rejectReady(new Error("PI_PREPARATION_WORKER_EXITED_BEFORE_READY"));
        });
      }

      override postMessage(...arguments_: Parameters<Worker["postMessage"]>) {
        preparationWorkers.byWorker.get(this)?.events.push({
          stage: "postMessage",
          monotonicNs: process.hrtime.bigint().toString(),
          value: arguments_[0],
        });
        return super.postMessage(...arguments_);
      }
    },
  };
});

trackPiPreparationDiagnostics(import.meta.url);

beforeEach(() => {
  preparationWorkers.records = [];
  preparationWorkers.onColdCreated = undefined;
  preparationWorkers.heldWarmTerminationUntilColdCreation = false;
});

afterEach((context) => {
  preparationWorkers.onColdCreated = undefined;
  Object.assign(context.task.meta, {
    heldWarmTerminationUntilColdCreation: preparationWorkers.heldWarmTerminationUntilColdCreation,
    piPreparationWarmWorkers: preparationWorkers.records.map(
      ({ ready: _ready, worker: _worker, ...record }) => record,
    ),
  });
});

const descriptor = (operation: "write" | "edit"): SandboxOperationBinding => ({
  operation,
  mode: "foreground",
  contract: {
    ...PI_PREPARED_FILE_CONTRACT,
    kind: "verified_effect",
    verifierRef: PI_WRITE_VERIFIER.ref,
    verifierVersion: PI_WRITE_VERIFIER.version,
    targetRef: PI_WRITE_VERIFIER.targetRef,
  },
  backendRef: "srt",
  scopeSource: "grant_targets",
  directoryOperations: ["read", "create", "update"],
  network: "disabled",
});

const resourceCeiling = {
  maxWallTimeMs: 10000,
  maxCpuTimeMs: 10000,
  maxMemoryBytes: 268435456,
  maxOutputBytes: 65536,
  maxProgressEvents: 10,
};

function expectWorkersStopped() {
  for (const { worker, events } of preparationWorkers.records) {
    expect(worker.threadId).toBe(-1);
    expect(events.some(({ stage }) => stage === "exit")).toBe(true);
  }
}

it("[R2-D19] prewarms one input-free Pi preparation worker before the first request", async () => {
  const scope = await productionSandboxScope(descriptor("write"), undefined, {
    resourceCeiling,
    realFileIdentity: true,
    piParameters: { path: "file.txt", content: "candidate" },
  });
  try {
    expect(preparationWorkers.records).toHaveLength(1);
    const record = preparationWorkers.records[0];
    if (!record) throw new Error("PI_PREPARATION_WARM_WORKER_MISSING");
    expect(record.workerData).toEqual({ prewarm: true });
    expect(record.threadId).toBeGreaterThan(0);
    await record.ready;
    expect(record.events.some(({ stage }) => stage === "postMessage")).toBe(false);
    expect(scope.preparationWarmupFailures).toEqual([]);
  } finally {
    await scope.close();
    expectWorkersStopped();
  }
});

it.each(["write", "edit"] as const)(
  "[R2-D19] preserves frozen %s candidates and authorization with one warm hit and one cold overflow",
  async (tool) => {
    const before = `${Array.from({ length: 128 }, (_, index) => `行 ${index} = source-${index}`).join("\r\n")}\r\nbefore\r\ntrailer\r\n`;
    const candidate = before.replace("before\r\n", "candidate\r\n");
    const scope = await productionSandboxScope(descriptor(tool), undefined, {
      resourceCeiling,
      realFileIdentity: true,
      piParameters:
        tool === "write"
          ? { path: "file.txt", content: candidate }
          : { path: "file.txt", edits: [{ oldText: "before", newText: "candidate" }] },
    });
    const database = openQualifiedDatabase(path.join(scope.f.resource.stateRoot, "product.sqlite"));
    let releaseTermination = () => {};
    let releasePublication = () => {};
    let pending: Promise<unknown> | undefined;
    let restoreTermination = () => {};
    let restorePublication = () => {};
    try {
      expect(preparationWorkers.records).toHaveLength(1);
      const warm = preparationWorkers.records[0];
      if (!warm) throw new Error("PI_PREPARATION_WARM_WORKER_MISSING");
      await warm.ready;
      expect(warm.events.some(({ stage }) => stage === "postMessage")).toBe(false);
      const filename = path.join(scope.host.workspace, "file.txt");
      await writeFile(filename, before);
      const secondCall = { ...scope.call, toolCallId: `second-warm-${tool}` };
      const secondId = `runtime-tool:${createHash("sha256")
        .update(JSON.stringify([secondCall.runId, secondCall.toolCallId]))
        .digest("hex")}`;
      const secondInput = {
        ...scope.input,
        invocationId: secondId,
        idempotencyKey: secondId,
        receiptRef: `receipt-second-warm-${tool}`,
      };
      await scope.persist(`runtime-tool-intent:${secondId.slice("runtime-tool:".length)}`, {
        request: {
          messageId: secondId,
          causationId: secondCall.runId,
          payload: { inputRef: secondInput.inputRef, capabilityHandleRef: secondInput.handleRef },
        },
      });
      let observeTermination!: () => void;
      const terminating = new Promise<void>((resolve) => {
        observeTermination = resolve;
      });
      const terminationGate = new Promise<void>((resolve) => {
        releaseTermination = resolve;
      });
      const terminate = warm.worker.terminate.bind(warm.worker);
      const termination = vi.spyOn(warm.worker, "terminate").mockImplementation(async () => {
        observeTermination();
        await terminationGate;
        return terminate();
      });
      restoreTermination = () => termination.mockRestore();
      preparationWorkers.heldWarmTerminationUntilColdCreation = true;
      let observeCold!: (record: PreparationWorkerRecord) => void;
      const coldCreated = new Promise<PreparationWorkerRecord>((resolve) => {
        observeCold = resolve;
      });
      preparationWorkers.onColdCreated = observeCold;
      let observePublication!: () => void;
      const publicationArrived = new Promise<void>((resolve) => {
        observePublication = resolve;
      });
      const publicationGate = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      const stagePublication = ConstrainedHostFileSystem.prototype.stagePublication;
      let staged = 0;
      const publication = vi
        .spyOn(ConstrainedHostFileSystem.prototype, "stagePublication")
        .mockImplementation(async function (this: ConstrainedHostFileSystem, grant, bytes, mode) {
          const result = await stagePublication.call(this, grant, bytes, mode);
          if (++staged <= 2) {
            if (staged === 2) observePublication();
            await publicationGate;
          }
          return result;
        });
      restorePublication = () => publication.mockRestore();
      const firstPromise = scope.services.runtime.prepare(scope.input, scope.call);
      pending = firstPromise;
      await Promise.race([
        terminating,
        firstPromise.then(() => {
          throw new Error("PI_WARM_PREPARATION_BYPASSED_TERMINATION");
        }),
      ]);
      expect(warm.worker.threadId).toBeGreaterThan(0);
      expect(preparationWorkers.records).toHaveLength(1);
      const secondPromise = scope.services.runtime.prepare(secondInput, secondCall);
      const preparations = Promise.all([firstPromise, secondPromise]);
      pending = preparations;
      const cold = await Promise.race([
        coldCreated,
        secondPromise.then(() => {
          throw new Error("PI_OVERFLOW_PREPARATION_BYPASSED_COLD_WORKER");
        }),
      ]);
      expect(cold.workerData).toBeUndefined();
      expect(cold.threadId).not.toBe(warm.threadId);
      expect(
        preparationWorkers.records.filter(
          ({ workerData }) =>
            workerData &&
            typeof workerData === "object" &&
            "prewarm" in workerData &&
            workerData.prewarm === true,
        ),
      ).toHaveLength(1);
      releaseTermination();
      await Promise.race([
        publicationArrived,
        preparations.then(() => {
          throw new Error("PI_PREPARATION_BYPASSED_PUBLICATION_GATE");
        }),
      ]);
      expect(
        database.prepare("SELECT count(*) AS n FROM sandbox_workspace_occupancy").get(),
      ).toEqual({ n: 0 });
      expect(
        database.prepare("SELECT count(*) AS n FROM capability_invocation_receipts").get(),
      ).toEqual({ n: 0 });
      expect(await readFile(filename, "utf8")).toBe(before);
      releasePublication();
      const [first, second] = await preparations;
      restoreTermination();
      restorePublication();
      if (!("reservation" in first) || !("reservation" in second))
        throw new Error("PI_PREPARATION_RESERVATION_CANDIDATE_MISSING");
      const firstScope = await scope.services.runtime.scopes.read(first.plan, scope.call.runId);
      const secondScope = await scope.services.runtime.scopes.read(second.plan, scope.call.runId);
      for (const preparedScope of [firstScope, secondScope]) {
        if (!preparedScope.preparedFile) throw new Error("PI_PREPARATION_FROZEN_CANDIDATE_MISSING");
        expect(
          await readFile(preparedScope.preparedFile.content.identity.canonicalPath, "utf8"),
        ).toBe(candidate);
        const result = JSON.parse(
          await readFile(preparedScope.preparedFile.result.identity.canonicalPath, "utf8"),
        );
        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "text" })]),
        );
      }
      const warmHandoff = warm.events.find(({ stage }) => stage === "postMessage");
      const warmReady = warm.events.find(
        ({ stage, value }) =>
          stage === "message" &&
          value &&
          typeof value === "object" &&
          "kind" in value &&
          value.kind === "ready",
      );
      if (!warmReady || !warmHandoff) throw new Error("PI_PREPARATION_READY_HANDOFF_MISSING");
      expect(BigInt(warmReady.monotonicNs)).toBeLessThan(BigInt(warmHandoff.monotonicNs));
      expect(warmHandoff.value).toMatchObject({
        kind: "input",
        input: { tool, toolCallId: scope.call.toolCallId },
      });
      expect(warm.worker.threadId).toBe(-1);
      expect(cold.worker.threadId).toBe(-1);
      expect(cold.events.find(({ stage }) => stage === "postMessage")?.value).toMatchObject({
        kind: "input",
        input: { tool, toolCallId: secondCall.toolCallId },
      });
      const nextWarm = preparationWorkers.records.filter(
        ({ workerData }) =>
          workerData &&
          typeof workerData === "object" &&
          "prewarm" in workerData &&
          workerData.prewarm === true,
      )[1];
      const warmExit = warm.events.find(({ stage }) => stage === "exit");
      const nextCreation = nextWarm?.events[0];
      if (!nextWarm || !nextCreation || !warmExit)
        throw new Error("PI_PREPARATION_REPLENISHMENT_MISSING");
      expect(BigInt(nextCreation.monotonicNs)).toBeGreaterThanOrEqual(BigInt(warmExit.monotonicNs));
      expect(new Set(preparationWorkers.records.map(({ threadId }) => threadId)).size).toBe(
        preparationWorkers.records.length,
      );
      await scope.services.brokerV2.preparations.reserve({ ...first, invocation: scope.input });
      await expect(
        scope.services.brokerV2.preparations.reserve({ ...second, invocation: secondInput }),
      ).rejects.toThrow(/Workspace/);
      await scope.services.brokerV2.preparations.enqueue({ ...second, invocation: secondInput });
      expect(
        database.prepare("SELECT count(*) AS n FROM capability_invocation_receipts").get(),
      ).toEqual({ n: 1 });
      await writeFile(filename, "external change");
      await expect(scope.services.runtime.prepare(secondInput, secondCall)).rejects.toThrow(
        "SANDBOX_FILE_VERSION_CHANGED",
      );
      expect(await readFile(filename, "utf8")).toBe("external change");
      if (!secondScope.preparedFile) throw new Error("PI_PREPARATION_FROZEN_CANDIDATE_MISSING");
      expect(await readFile(secondScope.preparedFile.content.identity.canonicalPath, "utf8")).toBe(
        candidate,
      );
      expect(scope.preparationWarmupFailures).toEqual([]);
    } finally {
      releaseTermination();
      releasePublication();
      await Promise.allSettled(pending ? [pending] : []);
      restoreTermination();
      restorePublication();
      database.close();
      await scope.close();
      expectWorkersStopped();
    }
  },
);

it("[R2-D19] closes the previous preparation pool before reopening sandbox services", async () => {
  const scope = await productionSandboxScope(descriptor("write"), undefined, {
    resourceCeiling,
    realFileIdentity: true,
    piParameters: { path: "file.txt", content: "candidate" },
  });
  try {
    const first = preparationWorkers.records[0];
    if (!first) throw new Error("PI_PREPARATION_WARM_WORKER_MISSING");
    await first.ready;
    await scope.reopen();
    expect(first.worker.threadId).toBe(-1);
    expect(first.events.some(({ stage }) => stage === "exit")).toBe(true);
    expect(preparationWorkers.records).toHaveLength(2);
    const second = preparationWorkers.records[1];
    if (!second) throw new Error("PI_PREPARATION_REOPENED_WORKER_MISSING");
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.workerData).toEqual({ prewarm: true });
    await second.ready;
    expect(second.events.some(({ stage }) => stage === "postMessage")).toBe(false);
    expect(scope.preparationWarmupFailures).toEqual([]);
  } finally {
    await scope.close();
    expectWorkersStopped();
  }
});

it("[R2-D19] keeps sandbox services without a prepared-file contract free of preparation workers", async () => {
  const scope = await productionSandboxScope({
    operation: "read",
    mode: "foreground",
    contract: { ref: "read", version: "1", kind: "fixed_read" },
    backendRef: "srt",
    scopeSource: "grant_targets",
    directoryOperations: ["read"],
    network: "disabled",
  });
  try {
    expect(preparationWorkers.records).toHaveLength(0);
    await scope.reopen();
    expect(preparationWorkers.records).toHaveLength(0);
  } finally {
    await scope.close();
  }
});
