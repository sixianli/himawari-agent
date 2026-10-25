import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  JobHostCommandOutcome,
  JobHostRequest,
  JobHostResult,
  SandboxJobSession,
  SandboxJobSessionReady,
  SandboxJobSessionRun,
} from "@himawari-agent/runtime-sandbox";
import { JobHostPreparationError } from "@himawari-agent/runtime-sandbox";
import type {
  ExecutionEnvironmentIdentity,
  ExecutionEnvironmentLocator,
} from "@himawari-agent/execution-contracts";
import { SRT_TASK_ENVIRONMENT_BACKEND_REF } from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  SrtTaskEnvironmentBackend,
  srtTaskEnvironmentJobId,
} from "../src/production-srt-task-environment-backend.ts";

const NOW = new Date("2026-10-18T02:00:00.000Z");
const DEADLINE = new Date(NOW.getTime() + 600_000).toISOString();
const POLICY = "a".repeat(64);
const OTHER_POLICY = "b".repeat(64);
const PID = 4242;
const RESIDENT_PID = 4243;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function stateRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-srt-backend-"));
  directories.push(directory);
  return directory;
}

const identity = (environmentId = "environment-srt-backend"): ExecutionEnvironmentIdentity => ({
  schemaVersion: "execution-environment.v1",
  ownerId: "owner-srt-backend",
  agentId: "agent-srt-backend",
  runId: "run-srt-backend",
  hostId: "host-srt-backend",
  executionJobId: "job-srt-backend",
  environmentId,
  environmentGeneration: 1,
  role: "primary",
});

const createIntentId = (environment: ExecutionEnvironmentIdentity) =>
  `create-${environment.environmentId}`;

const target = <T extends ExecutionEnvironmentLocator | null>(
  environment: ExecutionEnvironmentIdentity,
  locator: T,
) => ({ identity: environment, createIntentId: createIntentId(environment), locator });

const stopInput = <T extends ExecutionEnvironmentLocator | null>(
  environment: ExecutionEnvironmentIdentity,
  locator: T,
) => ({
  ...target(environment, locator),
  stopIntentId: `stop-${environment.environmentId}`,
  stopFence: 1,
});

function hostResult(pid: number | undefined): JobHostResult {
  return {
    jobId: "job-host-session",
    attemptId: "attempt-session",
    reason: "exited",
    resources: null,
    exitCode: 0,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    taskStarted: pid !== undefined,
    taskProcessExited: true,
    stdioClosed: true,
    srtReset: false,
    taskTreeCleanup: "process_group_gone",
  };
}

function outcome(settled = true): JobHostCommandOutcome {
  return {
    attemptId: "attempt-run",
    sequence: 1,
    reason: "exited",
    exitCode: 0,
    resources: null,
    taskStarted: true,
    taskProcessExited: true,
    stdioClosed: true,
    processGroupGone: true,
    namespace: "resident_intact",
    namespaceSwept: false,
    cleanedUp: true,
    settled,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  };
}

class FakeSession implements SandboxJobSession {
  readonly pid: number | undefined = PID;
  readonly ready: Promise<SandboxJobSessionReady>;
  readonly result: Promise<JobHostResult>;
  closeCount = 0;
  runCount = 0;
  outcome: JobHostCommandOutcome = outcome();
  pendingResult: Promise<JobHostCommandOutcome> | null = null;
  private settle!: (value: JobHostResult) => void;
  constructor(readyFailure?: Error) {
    this.ready = readyFailure
      ? Promise.reject(readyFailure)
      : Promise.resolve({ residentProcessId: RESIDENT_PID, hostSteps: null });
    this.ready.catch(() => {});
    this.result = new Promise((resolve) => {
      this.settle = resolve;
    });
  }
  run(): SandboxJobSessionRun {
    this.runCount += 1;
    return {
      started: Promise.resolve({
        processId: 777,
        processIdentityRef: `task-${this.runCount}`,
        startedAt: NOW.toISOString(),
      }),
      result: this.pendingResult ?? Promise.resolve(this.outcome),
      readOutput: () => ({ bytes: new Uint8Array(), nextOffset: 0, end: true }),
      cancel: () => {},
    };
  }
  inspect() {
    return null;
  }
  close() {
    this.closeCount += 1;
    this.settle(hostResult(this.pid));
  }
}

interface BackendFixture {
  readonly backend: SrtTaskEnvironmentBackend;
  readonly sessions: FakeSession[];
  readonly tokens: Map<number, string>;
  readonly groups: Set<number>;
  readonly clock: { at: Date };
  readonly directory: string;
  readonly readyFailure: { error?: Error };
}

interface SharedState {
  readonly directory: string;
  readonly tokens: Map<number, string>;
  readonly groups: Set<number>;
  readonly clock?: { at: Date };
}

async function backendFixture(
  runtimeInstanceId = "rt-instance-1",
  shared?: SharedState,
): Promise<BackendFixture> {
  const directory = shared?.directory ?? (await stateRoot());
  const tokens = shared?.tokens ?? new Map<number, string>();
  const groups = shared?.groups ?? new Set<number>();
  const clock = shared?.clock ?? { at: NOW };
  const sessions: FakeSession[] = [];
  const readyFailure: { error?: Error } = {};
  const backend = new SrtTaskEnvironmentBackend({
    stateDirectory: directory,
    runtimeInstanceId,
    proofValidityMs: 300_000,
    now: () => clock.at,
    prepareSession: () => {
      const session = new FakeSession(readyFailure.error);
      sessions.push(session);
      return session;
    },
    startToken: async (pid) => tokens.get(pid) ?? null,
    groupPresent: (groupId) => groups.has(groupId),
  });
  return { backend, sessions, tokens, groups, clock, directory, readyFailure };
}

function sessionRequest(
  environment: ExecutionEnvironmentIdentity,
  kind: "command" | "file_write" = "command",
) {
  const jobId = srtTaskEnvironmentJobId(environment.environmentId, kind);
  const request: Omit<JobHostRequest, "deadlineAt"> = {
    jobId,
    attemptId: `attempt-${kind}`,
    policy: {
      workspace: "/workspace",
      writable: true,
      privateDirectory: `/private/${jobId}`,
      readOnlyToolchainPaths: [],
      protectedPaths: [],
      allowedDomains: [],
    },
    policyDigest: POLICY,
    executable: "/usr/bin/bash",
    args: [],
    maxOutputBytes: 4096,
    cleanupTimeoutMs: 1000,
  };
  return { request, kind };
}

const runInput = {
  attemptId: "attempt-run",
  policyDigest: POLICY,
  deadlineAt: new Date(NOW.getTime() + 60_000).toISOString(),
  maxOutputBytes: 4096,
  inputBase64: "",
  resourceLimits: { maxCpuTimeMs: 1000, maxMemoryBytes: 1_048_576 },
};

async function environmentDirectory(directory: string): Promise<string> {
  const entries = await readdir(directory);
  return path.join(directory, entries[0] as string);
}

describe("[R2-P2] the SRT task environment backend", () => {
  it("makes create idempotent and refuses a closed or changed environment", async () => {
    const f = await backendFixture();
    const environment = identity();
    const first = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    expect(first).toMatchObject({
      backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
      effectivePolicyDigest: POLICY,
    });
    expect(
      await f.backend.create({
        identity: environment,
        createIntentId: createIntentId(environment),
        policyDigest: POLICY,
        deadlineAt: DEADLINE,
      }),
    ).toEqual(first);
    await f.backend.stop(stopInput(environment, first));
    await expect(
      f.backend.create({
        identity: environment,
        createIntentId: createIntentId(environment),
        policyDigest: POLICY,
        deadlineAt: DEADLINE,
      }),
    ).rejects.toMatchObject({ code: "SRT_ENVIRONMENT_CLOSED" });
    await expect(
      f.backend.create({
        identity: environment,
        createIntentId: "create-other",
        policyDigest: POLICY,
        deadlineAt: DEADLINE,
      }),
    ).rejects.toMatchObject({ code: "SRT_ENVIRONMENT_CLOSED" });
  });

  it("refuses a deadline that leaves less than one second", async () => {
    const f = await backendFixture();
    const environment = identity();
    await expect(
      f.backend.create({
        identity: environment,
        createIntentId: createIntentId(environment),
        policyDigest: POLICY,
        deadlineAt: new Date(NOW.getTime() + 500).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "SRT_ENVIRONMENT_DEADLINE_PASSED" });
  });

  it("keeps the state directory private", async () => {
    const f = await backendFixture();
    const environment = identity();
    await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const directory = await environmentDirectory(f.directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(directory, "sessions.json"))).mode & 0o777).toBe(0o600);
  });

  it("stops an environment that was never created as never_created", async () => {
    const f = await backendFixture();
    const environment = identity();
    const request = stopInput(environment, null);
    await f.backend.stop(request);
    const proof = await f.backend.verifyStopped(request);
    expect(proof).toMatchObject({ basis: "never_created", stopIntentId: request.stopIntentId });
    expect("locator" in proof).toBe(false);
    const directory = await environmentDirectory(f.directory);
    expect((await readdir(directory)).some((name) => name.startsWith("stop-"))).toBe(true);
  });

  it("stops a created environment as process_group_gone with evidence", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const request = stopInput(environment, locator);
    await f.backend.stop(request);
    const proof = await f.backend.verifyStopped(request);
    expect(proof).toMatchObject({ basis: "process_group_gone", locator });
    const evidenceRef = proof.basis === "never_created" ? undefined : proof.evidence[0]?.ref;
    expect(evidenceRef).toMatch(/^srt-stop-evidence:/);
    const directory = await environmentDirectory(f.directory);
    const evidence = (await readdir(directory)).find((name) => name.startsWith("stop-"));
    expect(evidence).toBeDefined();
    const saved = await readFile(path.join(directory, evidence as string), "utf8");
    expect(JSON.parse(saved)).toMatchObject({ verifierRef: "srt-task-environment-stop.v1" });
  });

  it("refuses a changed stop intent and reports a live process group", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    f.tokens.set(PID, "token-1");
    const { request: hostRequest, kind } = sessionRequest(environment);
    const session = await f.backend.session({
      target: target(environment, locator),
      kind,
      request: hostRequest,
    });
    expect(session.policyDigest).toBe(POLICY);
    const request = stopInput(environment, locator);
    await f.backend.stop(request);
    await expect(f.backend.stop({ ...request, stopIntentId: "stop-other" })).rejects.toMatchObject({
      code: "SRT_STOP_CHANGED",
    });
    await expect(f.backend.verifyStopped(request)).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_NOT_STOPPED",
    });
  });

  it("marks the environment failed when a recorded session has no live host", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const { request: hostRequest, kind } = sessionRequest(environment);
    await f.backend.session({ target: target(environment, locator), kind, request: hostRequest });
    const restarted = await backendFixture("rt-instance-1", {
      directory: f.directory,
      tokens: f.tokens,
      groups: f.groups,
    });
    const input = { target: target(environment, locator), kind, request: hostRequest };
    await expect(restarted.backend.session(input)).rejects.toMatchObject({
      code: "SRT_SESSION_LOST",
    });
    await expect(restarted.backend.session(input)).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_UNAVAILABLE",
    });
    expect(await restarted.backend.inspect(target(environment, locator))).toMatchObject({
      state: "stopped",
    });
  });

  it("[R2-P2] passes the host's preparation diagnostic through when the session never becomes ready", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const failure = new JobHostPreparationError({ stage: "sdk_initialize", systemCode: "EIO" });
    f.readyFailure.error = failure;
    const { request: hostRequest, kind } = sessionRequest(environment);
    const rejected = await f.backend
      .session({ target: target(environment, locator), kind, request: hostRequest })
      .catch((error: unknown) => error);
    expect(rejected).toBe(failure);
    expect(rejected).toMatchObject({
      message: "JOB_HOST_NOT_READY",
      diagnostic: { stage: "sdk_initialize", systemCode: "EIO" },
    });
    expect((f.sessions[0] as FakeSession).closeCount).toBe(1);
    const state = await readFile(
      path.join(await environmentDirectory(f.directory), "sessions.json"),
    );
    expect(JSON.parse(state.toString("utf8"))).toMatchObject({
      failed: "SRT_SESSION_START_FAILED",
    });
  });

  it("fails the environment when the compiled policy changed", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const { request: hostRequest, kind } = sessionRequest(environment);
    await f.backend.session({ target: target(environment, locator), kind, request: hostRequest });
    const input = { target: target(environment, locator), kind };
    await expect(
      f.backend.session({ ...input, request: { ...hostRequest, policyDigest: OTHER_POLICY } }),
    ).rejects.toMatchObject({ code: "SRT_POLICY_CHANGED" });
    await expect(f.backend.session({ ...input, request: hostRequest })).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_UNAVAILABLE",
    });
  });

  it("fails the environment when a command does not settle", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const { request: hostRequest, kind } = sessionRequest(environment);
    const session = await f.backend.session({
      target: target(environment, locator),
      kind,
      request: hostRequest,
    });
    const fake = f.sessions[0] as FakeSession;
    fake.outcome = outcome(false);
    await session.run(runInput, async () => {}).result;
    expect(fake.closeCount).toBe(1);
    const state = await readFile(
      path.join(await environmentDirectory(f.directory), "sessions.json"),
    );
    expect(JSON.parse(state.toString("utf8"))).toMatchObject({ failed: "SRT_COMMAND_UNSETTLED" });
  });

  it("never reports a restarted Worker's stale environment as running", async () => {
    const f = await backendFixture("rt-instance-1");
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    expect(await f.backend.inspect(target(environment, locator))).toMatchObject({
      state: "running",
    });
    const restarted = await backendFixture("rt-instance-2", {
      directory: f.directory,
      tokens: f.tokens,
      groups: f.groups,
    });
    expect(await restarted.backend.inspect(target(environment, locator))).toMatchObject({
      state: "stopped",
    });
  });

  it("treats a recorded process with a changed start token as gone", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    f.tokens.set(PID, "token-1");
    const { request: hostRequest, kind } = sessionRequest(environment);
    await f.backend.session({ target: target(environment, locator), kind, request: hostRequest });
    const request = stopInput(environment, locator);
    await f.backend.stop(request);
    await expect(f.backend.verifyStopped(request)).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_NOT_STOPPED",
    });
    f.tokens.set(PID, "token-2");
    await expect(f.backend.verifyStopped(request)).resolves.toMatchObject({
      basis: "process_group_gone",
    });
  });

  it("[R2-P2] A: does not raise an unhandled rejection when a locked operation fails", async () => {
    const f = await backendFixture();
    const environment = identity("environment-srt-backend-absent");
    const locator: ExecutionEnvironmentLocator = {
      backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
      runtimeInstanceId: "rt-instance-1",
      runtimeEnvironmentId: "runtime-environment-absent",
      createIntentId: createIntentId(environment),
      effectivePolicyDigest: POLICY,
    };
    const { request, kind } = sessionRequest(environment);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await expect(
        f.backend.session({ target: target(environment, locator), kind, request }),
      ).rejects.toMatchObject({ code: "SRT_ENVIRONMENT_UNAVAILABLE" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("[R2-P2] B: treats a reused process id as gone when the recorded start token changed", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    f.tokens.set(PID, "token-1");
    const { request: hostRequest, kind } = sessionRequest(environment);
    await f.backend.session({ target: target(environment, locator), kind, request: hostRequest });
    const request = stopInput(environment, locator);
    await f.backend.stop(request);
    f.tokens.set(PID, "token-2");
    f.groups.add(PID);
    await expect(f.backend.verifyStopped(request)).resolves.toMatchObject({
      basis: "process_group_gone",
    });
  });

  it("[R2-P2] B: reports a live process id when the recorded start token cannot be read", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    f.tokens.set(PID, "token-1");
    const { request: hostRequest, kind } = sessionRequest(environment);
    await f.backend.session({ target: target(environment, locator), kind, request: hostRequest });
    f.tokens.delete(PID);
    f.groups.add(PID);
    const request = stopInput(environment, locator);
    await f.backend.stop(request);
    await expect(f.backend.verifyStopped(request)).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_NOT_STOPPED",
    });
  });

  it("[R2-P2] B: reports a live process id when the recorded start token still matches", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    f.tokens.set(PID, "token-1");
    const { request: hostRequest, kind } = sessionRequest(environment);
    await f.backend.session({ target: target(environment, locator), kind, request: hostRequest });
    f.groups.add(PID);
    const request = stopInput(environment, locator);
    await f.backend.stop(request);
    await expect(f.backend.verifyStopped(request)).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_NOT_STOPPED",
    });
  });

  it("[R2-P2] C: refuses to verify a stop whose fence changed", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const request = { ...stopInput(environment, locator), stopFence: 3 };
    await f.backend.stop(request);
    await expect(f.backend.verifyStopped({ ...request, stopFence: 4 })).rejects.toMatchObject({
      code: "SRT_STOP_CHANGED",
    });
  });

  it("[R2-P2] D: refuses a session after the environment deadline passed", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const { request: hostRequest, kind } = sessionRequest(environment);
    await f.backend.session({ target: target(environment, locator), kind, request: hostRequest });
    expect(f.sessions).toHaveLength(1);
    f.clock.at = new Date(Date.parse(DEADLINE) + 1);
    await expect(
      f.backend.session({ target: target(environment, locator), kind, request: hostRequest }),
    ).rejects.toMatchObject({ code: "SRT_ENVIRONMENT_UNAVAILABLE" });
    const fileWrite = sessionRequest(environment, "file_write");
    await expect(
      f.backend.session({
        target: target(environment, locator),
        kind: fileWrite.kind,
        request: fileWrite.request,
      }),
    ).rejects.toMatchObject({ code: "SRT_ENVIRONMENT_UNAVAILABLE" });
    expect(f.sessions).toHaveLength(1);
  });

  it("[R2-P2] D: refuses a session exactly at the environment deadline", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const { request, kind } = sessionRequest(environment);
    f.clock.at = new Date(Date.parse(DEADLINE));
    await expect(
      f.backend.session({ target: target(environment, locator), kind, request }),
    ).rejects.toMatchObject({ code: "SRT_ENVIRONMENT_UNAVAILABLE" });
    expect(f.sessions).toHaveLength(0);
  });

  it("[R2-P2] B: reports a live process id when no start token was recorded at session start", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    const { request, kind } = sessionRequest(environment);
    await f.backend.session({ target: target(environment, locator), kind, request });
    f.groups.add(PID);
    const stop = stopInput(environment, locator);
    await f.backend.stop(stop);
    await expect(f.backend.verifyStopped(stop)).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_NOT_STOPPED",
    });
  });

  it("[R2-P2] records the resident bwrap identity and keeps the environment stopped only when it and command processes are gone", async () => {
    const f = await backendFixture();
    const environment = identity();
    const locator = await f.backend.create({
      identity: environment,
      createIntentId: createIntentId(environment),
      policyDigest: POLICY,
      deadlineAt: DEADLINE,
    });
    f.tokens.set(PID, "token-1");
    f.tokens.set(RESIDENT_PID, "resident-1");
    const { request: hostRequest, kind } = sessionRequest(environment);
    const session = await f.backend.session({
      target: target(environment, locator),
      kind,
      request: hostRequest,
    });
    const statePath = path.join(await environmentDirectory(f.directory), "sessions.json");
    const readState = async () =>
      JSON.parse((await readFile(statePath)).toString("utf8")).sessions[kind] as Record<
        string,
        unknown
      >;
    expect(await readState()).toMatchObject({
      pid: PID,
      startToken: "token-1",
      residentGroup: RESIDENT_PID,
      residentStartToken: "resident-1",
    });
    const fake = f.sessions[0] as FakeSession;
    fake.pendingResult = new Promise(() => {});
    await session.run(runInput, async () => {}).started;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (((await readState())["commandGroups"] as number[]).includes(777)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect((await readState())["commandGroups"]).toEqual([777]);
    f.tokens.delete(PID);
    const stop = stopInput(environment, locator);
    await f.backend.stop(stop);
    await expect(f.backend.verifyStopped(stop)).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_NOT_STOPPED",
    });
    f.tokens.set(RESIDENT_PID, "resident-2");
    f.groups.add(777);
    await expect(f.backend.verifyStopped(stop)).rejects.toMatchObject({
      code: "SRT_ENVIRONMENT_NOT_STOPPED",
    });
    f.groups.delete(777);
    await expect(f.backend.verifyStopped(stop)).resolves.toMatchObject({
      basis: "process_group_gone",
    });
  });
});
