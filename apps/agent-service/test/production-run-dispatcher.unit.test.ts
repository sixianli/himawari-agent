import type {
  CoordinatedRunResult,
  ExecuteCoordinatedRunInput,
  ExecutionInterruptionResult,
  RunDispatchCandidate,
  RunDispatchPort,
  RunExecutionLease,
  RunExecutionLeaseReceipt,
  RunReconciliationCandidate,
} from "@himawari-agent/application";
import { createApplicationServiceIdentityFactory } from "@himawari-agent/application";
import { createBeefRestaurantFixture, createV02Fixture } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import {
  ProductionRunDispatcher,
  type ProductionRunInputFactory,
  ProductionRunUnknownResultError,
} from "../src/production-run-dispatcher.js";

const FIXTURE = createBeefRestaurantFixture();
const IDENTITY = createApplicationServiceIdentityFactory();
const OWNER_ID = FIXTURE.owner.id;
const AGENT_ID = FIXTURE.agent.id;
const RUN_ID = FIXTURE.runs.recommendation.id;
const SESSION_ID = FIXTURE.session.id;
const TRIGGER_ID = FIXTURE.runs.recommendation.triggerId;
const DEPLOYMENT_ID = createV02Fixture().scope.authority.deploymentId;
const AUTHORITY_LEASE_ID = IDENTITY.createAuthorityLease({
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  leaseId: "authority-production-dispatch",
  holderId: "holder-production-dispatch",
}).id;
const EXECUTION_LEASE_ID = IDENTITY.createExecutionLeaseId({
  instanceId: "production-dispatch-test",
  runId: RUN_ID,
  expectedLeaseRevision: 0,
});
const NOW = "2026-09-05T00:00:00.000Z";

function candidate(action: RunDispatchCandidate["action"] = "start"): RunDispatchCandidate {
  return Object.freeze({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    triggerId: TRIGGER_ID,
    threadId: FIXTURE.thread.id,
    runRevision: 1,
    runStatus: "accepted",
    checkpointPhase: null,
    leaseRevision: 0,
    action,
  });
}

function lease(candidate_: RunDispatchCandidate): RunExecutionLease {
  return Object.freeze({
    ownerId: candidate_.ownerId,
    agentId: candidate_.agentId,
    runId: candidate_.runId,
    authorityLeaseId: AUTHORITY_LEASE_ID,
    deploymentId: DEPLOYMENT_ID,
    authorityEpoch: 3,
    fencingToken: 9,
    consumerId: "consumer-production-dispatch",
    executionLeaseId: EXECUTION_LEASE_ID,
    revision: candidate_.leaseRevision + 1,
    claimedAt: NOW,
    expiresAt: "2026-09-05T00:01:00.000Z",
    releasedAt: null,
  });
}

class DispatchFixture implements RunDispatchPort {
  readonly candidates: RunDispatchCandidate[];
  readonly reconciliation: RunReconciliationCandidate[] = [];
  readonly claims: RunExecutionLease[] = [];
  readonly renewals: RunExecutionLeaseReceipt[] = [];
  readonly releases: RunExecutionLeaseReceipt[] = [];
  readonly renewAttempted: Promise<void>;
  private resolveRenewAttempt!: () => void;
  private renewAttemptWasObserved = false;
  renewError: unknown;

  constructor(candidates: readonly RunDispatchCandidate[]) {
    this.candidates = [...candidates];
    this.renewAttempted = new Promise<void>((resolve) => {
      this.resolveRenewAttempt = resolve;
    });
  }

  async listClaimable(): Promise<readonly RunDispatchCandidate[]> {
    return this.candidates.splice(0);
  }

  async listReconciliationRequired(): Promise<readonly RunReconciliationCandidate[]> {
    return this.reconciliation.splice(0);
  }

  async claim(input: {
    readonly runId: RunDispatchCandidate["runId"];
    readonly expectedRunRevision: number;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: RunExecutionLease["executionLeaseId"];
    readonly claimedAt: string;
    readonly expiresAt: string;
  }): Promise<RunExecutionLeaseReceipt> {
    const found = candidate();
    if (found.runId !== input.runId || found.runRevision !== input.expectedRunRevision)
      throw new Error("UNEXPECTED_CLAIM");
    const claimed = Object.freeze({
      ...lease(found),
      executionLeaseId: input.executionLeaseId,
      claimedAt: input.claimedAt,
      expiresAt: input.expiresAt,
    });
    this.claims.push(claimed);
    return Object.freeze({ ...claimed, replayed: false });
  }

  async renew(input: {
    readonly runId: RunDispatchCandidate["runId"];
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: RunExecutionLease["executionLeaseId"];
    readonly renewedAt: string;
    readonly expiresAt: string;
  }): Promise<RunExecutionLeaseReceipt> {
    if (!this.renewAttemptWasObserved) {
      this.renewAttemptWasObserved = true;
      this.resolveRenewAttempt();
    }
    if (this.renewError) throw this.renewError;
    const current = this.claims.find(
      (claim) => claim.runId === input.runId && claim.executionLeaseId === input.executionLeaseId,
    );
    if (!current || current.revision !== input.expectedLeaseRevision)
      throw new Error("UNEXPECTED_RENEW");
    const renewed = Object.freeze({ ...current, expiresAt: input.expiresAt });
    const result = Object.freeze({ ...renewed, replayed: false });
    this.renewals.push(result);
    this.claims.splice(this.claims.indexOf(current), 1, renewed);
    return result;
  }

  async release(input: {
    readonly runId: RunDispatchCandidate["runId"];
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: RunExecutionLease["executionLeaseId"];
    readonly releasedAt: string;
  }): Promise<RunExecutionLeaseReceipt> {
    const current = this.claims.find(
      (claim) => claim.runId === input.runId && claim.executionLeaseId === input.executionLeaseId,
    );
    if (!current) throw new Error("UNEXPECTED_RELEASE");
    const released = Object.freeze({ ...current, releasedAt: input.releasedAt });
    const result = Object.freeze({ ...released, replayed: false });
    this.releases.push(result);
    return result;
  }

  async assertHeld(): Promise<RunExecutionLease> {
    throw new Error("not used");
  }
}

function inputFor(
  current: RunDispatchCandidate,
  currentLease: RunExecutionLease,
): ExecuteCoordinatedRunInput {
  return {
    ownerId: current.ownerId,
    agentId: current.agentId,
    runId: current.runId,
    authority: {
      leaseId: currentLease.authorityLeaseId,
      fencingToken: currentLease.fencingToken,
    },
    context: {} as ExecuteCoordinatedRunInput["context"],
    runtime: {} as ExecuteCoordinatedRunInput["runtime"],
    workers: [],
    delegableCapabilityHandleRefs: [],
    delegableContextRefs: [],
    commands: {} as ExecuteCoordinatedRunInput["commands"],
  };
}

type RunStatus = CoordinatedRunResult["run"]["run"]["status"];

interface ExecutionInterruptInput {
  readonly runId: RunDispatchCandidate["runId"];
  readonly executionLeaseId: RunExecutionLease["executionLeaseId"];
  readonly reasonCode: string;
}

interface TestCoordinator {
  execute(input: ExecuteCoordinatedRunInput): Promise<CoordinatedRunResult>;
  interruptExecution?(
    input: ExecutionInterruptInput,
  ): Promise<ExecutionInterruptionResult | undefined>;
}

function result(status: RunStatus): CoordinatedRunResult {
  return {
    run: {
      revision: 2,
      run: {
        id: RUN_ID,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        triggerId: TRIGGER_ID,
        status,
      },
    },
    checkpoint: {
      phase: status === "completed" ? "completed" : "reconciling_external_result",
      contextRef: null,
      workerResults: {},
      runtimeEventCount: 0,
      lastTraceEventId: null,
      terminalStatus: status === "completed" ? "completed" : null,
      output: null,
      diagnosticCode: null,
    },
    workerResultRefs: [],
    resumed: false,
  };
}

function dispatcher(
  dispatch: DispatchFixture,
  coordinator: TestCoordinator,
  reconcile: (input: {
    readonly candidate: RunReconciliationCandidate;
    readonly reasonCode: string;
  }) => Promise<void>,
  options: {
    readonly clock?: { readonly now: () => string };
    readonly executionLeaseDurationMs?: number;
    readonly executionLeaseRenewalIntervalMs?: number;
    readonly input?: ProductionRunInputFactory;
  } = {},
): ProductionRunDispatcher {
  const boundCoordinator = {
    execute: coordinator.execute,
    interruptExecution: coordinator.interruptExecution ?? (async () => undefined),
  };
  return new ProductionRunDispatcher({
    authority: {
      assertActive: async () => undefined,
      isAccepting: () => true,
    },
    dispatch,
    coordinator: boundCoordinator,
    input:
      options.input ??
      (async ({ candidate: current, lease: currentLease }) => inputFor(current, currentLease)),
    reconcile,
    clock: options.clock ?? { now: () => NOW },
    executionLeaseDurationMs: options.executionLeaseDurationMs ?? 60_000,
    ...(options.executionLeaseRenewalIntervalMs === undefined
      ? {}
      : { executionLeaseRenewalIntervalMs: options.executionLeaseRenewalIntervalMs }),
    maximumRunsPerPump: 4,
    instanceId: "production-dispatch-test",
    nextExecutionLeaseId: () => EXECUTION_LEASE_ID,
  });
}

describe("ProductionRunDispatcher", () => {
  it("claims one canonical Run, executes with that claim, and releases it after settlement", async () => {
    const dispatch = new DispatchFixture([candidate()]);
    const seen: ExecuteCoordinatedRunInput[] = [];
    const service = dispatcher(
      dispatch,
      {
        execute: async (input) => {
          seen.push(input);
          return result("completed");
        },
      },
      async () => undefined,
    );

    await expect(service.pump()).resolves.toMatchObject({
      claimed: 1,
      settled: 1,
      unknown: 0,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.executionLease).toMatchObject({
      executionLeaseId: EXECUTION_LEASE_ID,
      expectedLeaseRevision: 1,
      consumerId: "consumer-production-dispatch",
    });
    expect(dispatch.releases).toHaveLength(1);
    expect(dispatch.releases[0]?.releasedAt).toBe(NOW);
  });

  it("reconciles an unknown provider result and does not immediately retry execution", async () => {
    const dispatch = new DispatchFixture([candidate()]);
    const reconciled: string[] = [];
    let executions = 0;
    const service = dispatcher(
      dispatch,
      {
        execute: async () => {
          executions += 1;
          throw new ProductionRunUnknownResultError("PROVIDER_RESPONSE_UNKNOWN");
        },
      },
      async ({ reasonCode }) => {
        reconciled.push(reasonCode);
      },
    );

    await expect(service.pump()).resolves.toMatchObject({ claimed: 1, unknown: 1, settled: 0 });
    expect(executions).toBe(1);
    expect(reconciled).toEqual(["PROVIDER_RESPONSE_UNKNOWN"]);
    expect(dispatch.releases).toHaveLength(1);
  });

  it("processes persisted reconciliation before claiming safe work", async () => {
    const dispatch = new DispatchFixture([]);
    dispatch.reconciliation.push({ ...candidate("resume"), action: "reconcile" });
    const seen: string[] = [];
    const service = dispatcher(
      dispatch,
      {
        execute: async () => {
          seen.push("execute");
          return result("completed");
        },
      },
      async ({ reasonCode }) => {
        seen.push(reasonCode);
      },
    );

    await expect(service.pump()).resolves.toMatchObject({ reconciled: 1, claimed: 0 });
    expect(seen).toEqual(["PERSISTED_EXECUTION_RECONCILIATION_REQUIRED"]);
  });

  it("single-flights concurrent pumps for one service instance", async () => {
    const dispatch = new DispatchFixture([candidate()]);
    let executions = 0;
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const service = dispatcher(
      dispatch,
      {
        execute: async () => {
          executions += 1;
          await executionReleased;
          return result("completed");
        },
      },
      async () => undefined,
    );

    const first = service.pump();
    const second = service.pump();
    expect(first).toBe(second);
    releaseExecution();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(executions).toBe(1);
    expect(dispatch.claims).toHaveLength(1);
  });

  it("renews a long-running claim with fresh clock time and the stable write revision", async () => {
    const dispatch = new DispatchFixture([candidate()]);
    const clockValues = [NOW, "2026-09-05T00:00:00.010Z", "2026-09-05T00:00:00.020Z"];
    const clock = { now: () => clockValues.shift() ?? NOW };
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const service = dispatcher(
      dispatch,
      {
        execute: async () => {
          await executionReleased;
          return result("completed");
        },
      },
      async () => undefined,
      {
        clock,
        executionLeaseDurationMs: 100,
        executionLeaseRenewalIntervalMs: 5,
      },
    );

    const operation = service.pump();
    await new Promise((resolve) => setTimeout(resolve, 15));
    releaseExecution();
    await expect(operation).resolves.toMatchObject({ settled: 1 });
    expect(dispatch.renewals.length).toBeGreaterThan(0);
    expect(dispatch.renewals.every(({ revision }) => revision === 1)).toBe(true);
    expect(dispatch.renewals[0]?.expiresAt).toBe("2026-09-05T00:00:00.100Z");
  });

  it("interrupts the claimed attempt once when renewal fails and reconciles as unknown", async () => {
    const dispatch = new DispatchFixture([candidate()]);
    dispatch.renewError = new Error("LEASE_RENEWAL_FAILED");
    const interruptions: string[] = [];
    const reconciled: string[] = [];
    let executions = 0;
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const service = dispatcher(
      dispatch,
      {
        execute: async () => {
          executions += 1;
          await executionReleased;
          return result("completed");
        },
        interruptExecution: async ({ runId, executionLeaseId, reasonCode }) => {
          interruptions.push(`${runId}:${executionLeaseId}:${reasonCode}`);
          return undefined;
        },
      },
      async ({ reasonCode }) => {
        reconciled.push(reasonCode);
      },
      { executionLeaseDurationMs: 100, executionLeaseRenewalIntervalMs: 5 },
    );

    const operation = service.pump();
    await dispatch.renewAttempted;
    releaseExecution();

    await expect(operation).resolves.toMatchObject({ claimed: 1, settled: 0, unknown: 1 });
    expect(executions).toBe(1);
    expect(interruptions).toEqual([
      `${RUN_ID}:${EXECUTION_LEASE_ID}:EXECUTION_LEASE_RENEWAL_FAILED`,
    ]);
    expect(reconciled).toEqual(["EXECUTION_LEASE_RENEWAL_FAILED"]);
  });

  it("does not start the coordinator after renewal fails while input is waiting", async () => {
    const dispatch = new DispatchFixture([candidate()]);
    dispatch.renewError = new Error("LEASE_RENEWAL_FAILED");
    const interruptions: string[] = [];
    let executions = 0;
    let inputStarted!: () => void;
    const inputReady = new Promise<void>((resolve) => {
      inputStarted = resolve;
    });
    let releaseInput!: () => void;
    const inputReleased = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    const service = dispatcher(
      dispatch,
      {
        execute: async () => {
          executions += 1;
          return result("completed");
        },
        interruptExecution: async ({ executionLeaseId }) => {
          interruptions.push(executionLeaseId);
          return undefined;
        },
      },
      async () => undefined,
      {
        executionLeaseDurationMs: 100,
        executionLeaseRenewalIntervalMs: 5,
        input: async ({ candidate: current, lease: currentLease }) => {
          inputStarted();
          await inputReleased;
          return inputFor(current, currentLease);
        },
      },
    );

    const operation = service.pump();
    await inputReady;
    await dispatch.renewAttempted;
    releaseInput();

    await expect(operation).resolves.toMatchObject({ claimed: 1, settled: 0, unknown: 1 });
    expect(executions).toBe(0);
    expect(interruptions).toEqual([EXECUTION_LEASE_ID]);
  });
});
