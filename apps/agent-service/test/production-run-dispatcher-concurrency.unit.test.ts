import type {
  CoordinatedRunResult,
  ExecuteCoordinatedRunInput,
  RunDispatchCandidate,
  RunDispatchPort,
  RunExecutionLease,
  RunExecutionLeaseReceipt,
} from "@himawari-agent/application";
import {
  claimFromRunExecutionLease,
  createApplicationServiceIdentityFactory,
} from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import { createBeefRestaurantFixture, createV02Fixture } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import { ProductionRunDispatcher } from "../src/production-run-dispatcher.js";

const FIXTURE = createBeefRestaurantFixture();
const IDENTITY = createApplicationServiceIdentityFactory();
const DEPLOYMENT_ID = createV02Fixture().scope.authority.deploymentId;
const AUTHORITY_LEASE_ID = IDENTITY.createAuthorityLease({
  ownerId: FIXTURE.owner.id,
  agentId: FIXTURE.agent.id,
  leaseId: "authority-dispatch-concurrency",
  holderId: "holder-dispatch-concurrency",
}).id;
const NOW = "2026-09-05T00:00:00.000Z";

function candidateFor(name: string, runRevision = 1): RunDispatchCandidate {
  return Object.freeze({
    ownerId: FIXTURE.owner.id,
    agentId: FIXTURE.agent.id,
    runId: createRunId(`run:${name}`),
    sessionId: FIXTURE.session.id,
    triggerId: FIXTURE.runs.recommendation.triggerId,
    threadId: FIXTURE.thread.id,
    runRevision,
    runStatus: "accepted",
    checkpointPhase: null,
    leaseRevision: 0,
    action: "start",
  });
}

class QueueDispatch implements RunDispatchPort {
  readonly waiting: RunDispatchCandidate[] = [];
  readonly claimed = new Map<string, RunExecutionLease>();
  readonly released: string[] = [];
  listedLimits: number[] = [];

  async listClaimable(input: { readonly limit: number }): Promise<readonly RunDispatchCandidate[]> {
    this.listedLimits.push(input.limit);
    return this.waiting.slice(0, input.limit);
  }

  async listReconciliationRequired(): Promise<[]> {
    return [];
  }

  async claim(input: {
    readonly runId: RunDispatchCandidate["runId"];
    readonly executionLeaseId: RunExecutionLease["executionLeaseId"];
    readonly claimedAt: string;
    readonly expiresAt: string;
  }): Promise<RunExecutionLeaseReceipt> {
    const index = this.waiting.findIndex((entry) => entry.runId === input.runId);
    if (index < 0) throw new Error("UNEXPECTED_CLAIM");
    this.waiting.splice(index, 1);
    const lease = Object.freeze({
      ownerId: FIXTURE.owner.id,
      agentId: FIXTURE.agent.id,
      runId: input.runId,
      authorityLeaseId: AUTHORITY_LEASE_ID,
      deploymentId: DEPLOYMENT_ID,
      authorityEpoch: 3,
      fencingToken: 9,
      consumerId: "consumer-dispatch-concurrency",
      executionLeaseId: input.executionLeaseId,
      revision: 1,
      claimedAt: input.claimedAt,
      expiresAt: input.expiresAt,
      releasedAt: null,
    });
    this.claimed.set(input.runId, lease);
    return Object.freeze({ ...lease, replayed: false });
  }

  async renew(input: {
    readonly runId: RunDispatchCandidate["runId"];
    readonly expiresAt: string;
  }): Promise<RunExecutionLeaseReceipt> {
    const current = this.claimed.get(input.runId);
    if (!current) throw new Error("UNEXPECTED_RENEW");
    return Object.freeze({ ...current, expiresAt: input.expiresAt, replayed: false });
  }

  async release(input: {
    readonly runId: RunDispatchCandidate["runId"];
    readonly releasedAt: string;
  }): Promise<RunExecutionLeaseReceipt> {
    const current = this.claimed.get(input.runId);
    if (!current) throw new Error("UNEXPECTED_RELEASE");
    this.released.push(input.runId);
    return Object.freeze({ ...current, releasedAt: input.releasedAt, replayed: false });
  }

  async assertHeld(): Promise<RunExecutionLease> {
    throw new Error("not used");
  }
}

function completed(runId: RunDispatchCandidate["runId"]): CoordinatedRunResult {
  return {
    run: {
      revision: 2,
      run: {
        id: runId,
        ownerId: FIXTURE.owner.id,
        agentId: FIXTURE.agent.id,
        sessionId: FIXTURE.session.id,
        triggerId: FIXTURE.runs.recommendation.triggerId,
        status: "completed",
      },
    },
    checkpoint: {
      phase: "completed",
      contextRef: null,
      workerResults: {},
      runtimeEventCount: 0,
      lastTraceEventId: null,
      terminalStatus: "completed",
      output: null,
      diagnosticCode: null,
    },
    workerResultRefs: [],
    resumed: false,
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function build(
  dispatch: QueueDispatch,
  execute: (input: ExecuteCoordinatedRunInput) => Promise<CoordinatedRunResult>,
  concurrency: number,
  onCapacityFreed?: () => void,
) {
  return new ProductionRunDispatcher({
    authority: { assertActive: async () => undefined, isAccepting: () => true },
    dispatch,
    coordinator: {
      execute,
      recoverCompleted: async () => {
        throw new Error("unexpected completion recovery");
      },
      interruptExecution: async () => undefined,
    },
    input: async ({ candidate, lease }) => ({
      ownerId: candidate.ownerId,
      agentId: candidate.agentId,
      runId: candidate.runId,
      authority: { leaseId: lease.authorityLeaseId, fencingToken: lease.fencingToken },
      executionLease: claimFromRunExecutionLease(lease),
      context: {} as ExecuteCoordinatedRunInput["context"],
      runtime: {} as ExecuteCoordinatedRunInput["runtime"],
      workers: [],
      delegableCapabilityHandleRefs: [],
      delegableContextRefs: [],
      commands: {} as ExecuteCoordinatedRunInput["commands"],
    }),
    reconcile: async () => undefined,
    clock: { now: () => NOW },
    executionLeaseDurationMs: 60_000,
    maximumRunsPerPump: concurrency,
    instanceId: "dispatch-concurrency-test",
    ...(onCapacityFreed ? { onCapacityFreed } : {}),
  });
}

describe("ProductionRunDispatcher concurrency", () => {
  it("starts a quick Run while a slow Run still holds its slot", async () => {
    const dispatch = new QueueDispatch();
    dispatch.waiting.push(candidateFor("slow"), candidateFor("quick"));
    const slowGate = gate();
    const started: string[] = [];
    const finished: string[] = [];
    const service = build(
      dispatch,
      async (input) => {
        started.push(input.runId);
        if (input.runId === "run:slow") await slowGate.opened;
        finished.push(input.runId);
        return completed(input.runId);
      },
      2,
    );

    await expect(service.fill()).resolves.toMatchObject({ claimed: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["run:slow", "run:quick"]);
    expect(finished).toEqual(["run:quick"]);

    slowGate.open();
    await expect(service.drain(1000)).resolves.toMatchObject({ drained: true, inFlight: 0 });
    expect(finished).toEqual(["run:quick", "run:slow"]);
    expect(dispatch.released.sort()).toEqual(["run:quick", "run:slow"]);
  });

  it("never runs more Runs at once than the limit and takes the next one as soon as a slot frees", async () => {
    const dispatch = new QueueDispatch();
    dispatch.waiting.push(candidateFor("a"), candidateFor("b"), candidateFor("c"));
    const gates = new Map([
      ["run:a", gate()],
      ["run:b", gate()],
      ["run:c", gate()],
    ]);
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    let service!: ProductionRunDispatcher;
    service = build(
      dispatch,
      async (input) => {
        started.push(input.runId);
        running += 1;
        peak = Math.max(peak, running);
        await gates.get(input.runId)?.opened;
        running -= 1;
        return completed(input.runId);
      },
      2,
      () => {
        void service.fill();
      },
    );

    await service.fill();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["run:a", "run:b"]);
    expect(dispatch.listedLimits).toEqual([2]);

    gates.get("run:b")?.open();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(started).toEqual(["run:a", "run:b", "run:c"]);
    expect(peak).toBe(2);

    gates.get("run:a")?.open();
    gates.get("run:c")?.open();
    await expect(service.drain(1000)).resolves.toMatchObject({ drained: true });
  });

  it("keeps one Run at a time when the limit is 1", async () => {
    const dispatch = new QueueDispatch();
    dispatch.waiting.push(candidateFor("first"), candidateFor("second"));
    const firstGate = gate();
    const started: string[] = [];
    const service = build(
      dispatch,
      async (input) => {
        started.push(input.runId);
        if (input.runId === "run:first") await firstGate.opened;
        return completed(input.runId);
      },
      1,
    );

    await service.fill();
    await service.fill();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(["run:first"]);
    firstGate.open();
    await service.drain(1000);
  });

  it("raises a failure from a detached execution on the next fill", async () => {
    const dispatch = new QueueDispatch();
    dispatch.waiting.push(candidateFor("broken"));
    let freed = 0;
    const service = build(
      dispatch,
      async () => {
        throw Object.assign(new Error("AUTHORITY_LOST"), { code: "PORT_NOT_AUTHORITATIVE" });
      },
      2,
      () => {
        freed += 1;
      },
    );

    await service.fill();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(freed).toBe(1);
    await expect(service.fill()).rejects.toThrow("AUTHORITY_LOST");
  });
});
