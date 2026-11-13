import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionBackendObservation,
  ExecutionEnvironmentLifecyclePort,
} from "@himawari-agent/application";
import {
  EXECUTION_BACKEND_PROTOCOL_V1,
  type ExecutionBackendCapabilities,
  type ExecutionEnvironmentIdentity,
  type ExecutionEnvironmentLocator,
  type ExecutionEnvironmentStopProof,
  SRT_TASK_ENVIRONMENT_BACKEND_REF,
  SRT_TASK_ENVIRONMENT_GUARANTEES,
} from "@himawari-agent/execution-contracts";
import {
  type JobHostCommandOutcome,
  type JobHostRequest,
  type JobHostRunInput,
  prepareSandboxJobSession,
  processGroupPresent,
  readProcessStartToken,
  type SandboxJobSession,
  type SandboxJobSessionReady,
  type SandboxJobSessionRun,
} from "@himawari-agent/runtime-sandbox";

export type SrtTaskEnvironmentSessionKind = "command" | "file_write";

const STATE_VERSION = "srt-task-environment-state.v1";
const VERIFIER_REF = "srt-task-environment-stop.v1";
const SESSION_CLOSE_WAIT_MS = 15_000;

interface SessionRecord {
  readonly jobId: string;
  readonly privateDirectory: string;
  readonly policyDigest: string;
  readonly pid: number | null;
  readonly startToken: string | null;
  readonly residentGroup: number | null;
  readonly residentStartToken: string | null;
  readonly commandGroups: readonly number[];
}

interface EnvironmentState {
  readonly schemaVersion: typeof STATE_VERSION;
  readonly identity: ExecutionEnvironmentIdentity;
  readonly createIntentId: string;
  readonly locator: ExecutionEnvironmentLocator | null;
  readonly deadlineAt: string;
  readonly sessions: Partial<Record<SrtTaskEnvironmentSessionKind, SessionRecord>>;
  readonly failed: string | null;
  readonly stop: { readonly stopIntentId: string; readonly stopFence: number } | null;
  readonly destroyed: boolean;
}

interface Target {
  readonly identity: ExecutionEnvironmentIdentity;
  readonly createIntentId: string;
  readonly locator: ExecutionEnvironmentLocator | null;
}

export interface SrtTaskEnvironmentSession {
  readonly policyDigest: string;
  run(input: JobHostRunInput, authorize: () => Promise<void>): SandboxJobSessionRun;
}

export class SrtTaskEnvironmentError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const sessionRecords = (state: EnvironmentState): SessionRecord[] =>
  Object.values(state.sessions).filter((session): session is SessionRecord => Boolean(session));

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function srtTaskEnvironmentJobId(
  environmentId: string,
  kind: SrtTaskEnvironmentSessionKind,
): string {
  return `env-${sha256(JSON.stringify([environmentId, kind])).slice(0, 20)}`;
}

export class SrtTaskEnvironmentBackend implements ExecutionEnvironmentLifecyclePort {
  private readonly options: {
    readonly stateDirectory: string;
    readonly runtimeInstanceId: string;
    readonly proofValidityMs: number;
    readonly now: () => Date;
    readonly prepareSession: (request: JobHostRequest) => SandboxJobSession;
    readonly startToken: (pid: number) => Promise<string | null>;
    readonly groupPresent: (groupId: number) => boolean;
  };
  private readonly live = new Map<string, SandboxJobSession>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly starting = new Map<string, Promise<SrtTaskEnvironmentSession>>();

  constructor(options: {
    readonly stateDirectory: string;
    readonly runtimeInstanceId: string;
    readonly proofValidityMs: number;
    readonly now: () => Date;
    readonly prepareSession?: (request: JobHostRequest) => SandboxJobSession;
    readonly startToken?: (pid: number) => Promise<string | null>;
    readonly groupPresent?: (groupId: number) => boolean;
  }) {
    this.options = {
      stateDirectory: options.stateDirectory,
      runtimeInstanceId: options.runtimeInstanceId,
      proofValidityMs: options.proofValidityMs,
      now: options.now,
      prepareSession: options.prepareSession ?? prepareSandboxJobSession,
      startToken: options.startToken ?? ((pid) => readProcessStartToken(pid)),
      groupPresent: options.groupPresent ?? processGroupPresent,
    };
  }

  async capabilities(): Promise<ExecutionBackendCapabilities> {
    return {
      protocolVersion: EXECUTION_BACKEND_PROTOCOL_V1,
      backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
      runtimeInstanceId: this.options.runtimeInstanceId,
      guarantees: [...SRT_TASK_ENVIRONMENT_GUARANTEES],
      checkedAt: this.options.now().toISOString(),
    };
  }

  create(input: {
    readonly identity: ExecutionEnvironmentIdentity;
    readonly createIntentId: string;
    readonly policyDigest: string;
    readonly deadlineAt: string;
  }): Promise<ExecutionEnvironmentLocator> {
    return this.locked(input.identity, async () => {
      if (Date.parse(input.deadlineAt) - this.options.now().getTime() <= 1000)
        throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_DEADLINE_PASSED");
      const locator: ExecutionEnvironmentLocator = {
        backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
        runtimeInstanceId: this.options.runtimeInstanceId,
        runtimeEnvironmentId: sha256(
          JSON.stringify([
            "himawari.srt-task-environment.v1",
            input.identity.environmentId,
            input.createIntentId,
            this.options.runtimeInstanceId,
          ]),
        ),
        createIntentId: input.createIntentId,
        effectivePolicyDigest: input.policyDigest,
      };
      const existing = await this.read(input.identity);
      if (existing) {
        if (
          existing.stop ||
          existing.createIntentId !== input.createIntentId ||
          JSON.stringify(existing.identity) !== JSON.stringify(input.identity) ||
          JSON.stringify(existing.locator) !== JSON.stringify(locator)
        )
          throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_CLOSED");
        return locator;
      }
      await this.write({
        schemaVersion: STATE_VERSION,
        identity: input.identity,
        createIntentId: input.createIntentId,
        locator,
        deadlineAt: input.deadlineAt,
        sessions: {},
        failed: null,
        stop: null,
        destroyed: false,
      });
      return locator;
    });
  }

  async inspect(input: Target): Promise<ExecutionBackendObservation> {
    const observedAt = this.options.now().toISOString();
    const state = await this.read(input.identity);
    if (!state) return { state: "not_found", locator: null, observedAt };
    this.assertTarget(state, input);
    if (state.destroyed || state.locator === null)
      return { state: "not_found", locator: state.locator, observedAt };
    if (
      !state.stop &&
      !state.failed &&
      state.locator.runtimeInstanceId === this.options.runtimeInstanceId
    )
      return { state: "running", locator: state.locator, observedAt };
    return {
      state: (await this.remaining(state)).length === 0 ? "stopped" : "unknown",
      locator: state.locator,
      observedAt,
    };
  }

  stop(
    input: Target & { readonly stopIntentId: string; readonly stopFence: number },
  ): Promise<{ readonly accepted: true }> {
    return this.locked(input.identity, async () => {
      const state = await this.read(input.identity);
      if (!state) {
        await this.write(this.unreachedState(input));
        return { accepted: true } as const;
      }
      this.assertTarget(state, input);
      if (state.stop && state.stop.stopIntentId !== input.stopIntentId)
        throw new SrtTaskEnvironmentError("SRT_STOP_CHANGED");
      if (!state.stop)
        await this.write({
          ...state,
          stop: { stopIntentId: input.stopIntentId, stopFence: input.stopFence },
        });
      await this.closeSessions(state.identity);
      return { accepted: true } as const;
    });
  }

  verifyStopped(
    input: Target & { readonly stopIntentId: string; readonly stopFence: number },
  ): Promise<ExecutionEnvironmentStopProof> {
    return this.locked(input.identity, async () => {
      const state = await this.read(input.identity);
      if (state?.stop?.stopIntentId !== input.stopIntentId)
        throw new SrtTaskEnvironmentError("SRT_STOP_NOT_REQUESTED");
      if (state.stop.stopFence !== input.stopFence)
        throw new SrtTaskEnvironmentError("SRT_STOP_CHANGED");
      this.assertTarget(state, input);
      if (this.liveKinds(state.identity).length > 0)
        throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_NOT_STOPPED");
      const remaining = await this.remaining(state);
      if (remaining.length > 0) throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_NOT_STOPPED");
      const checkedAt = this.options.now();
      const proof = {
        identity: input.identity,
        createIntentId: input.createIntentId,
        stopIntentId: input.stopIntentId,
        stopFence: input.stopFence,
        verifierRef: VERIFIER_REF,
        checkedAt: checkedAt.toISOString(),
        validUntil: new Date(checkedAt.getTime() + this.options.proofValidityMs).toISOString(),
      };
      if (state.locator === null) {
        const evidence = await this.saveEvidence(state, {
          schemaVersion: "srt-task-environment-stop-evidence.v1",
          verifierRef: VERIFIER_REF,
          neverCreated: true,
          runtimeInstanceId: this.options.runtimeInstanceId,
          stop: state.stop,
          checkedAt: proof.checkedAt,
        });
        return { basis: "never_created", ...proof, evidence: [evidence] };
      }
      const evidence = await this.saveEvidence(state, {
        schemaVersion: "srt-task-environment-stop-evidence.v1",
        verifierRef: VERIFIER_REF,
        runtimeInstanceId: this.options.runtimeInstanceId,
        locator: state.locator,
        sessions: state.sessions,
        failed: state.failed,
        stop: state.stop,
        checkedAt: proof.checkedAt,
      });
      return {
        basis: "process_group_gone",
        ...proof,
        evidence: [evidence],
        locator: state.locator,
      };
    });
  }

  destroy(input: Target): Promise<void> {
    return this.locked(input.identity, async () => {
      const state = await this.read(input.identity);
      if (!state || state.destroyed) return;
      this.assertTarget(state, input);
      if (!state.stop || this.liveKinds(state.identity).length > 0)
        throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_NOT_STOPPED");
      if ((await this.remaining(state)).length > 0)
        throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_NOT_STOPPED");
      for (const session of sessionRecords(state))
        await rm(session.privateDirectory, { recursive: true, force: true });
      await this.write({ ...state, destroyed: true });
    });
  }

  async session(input: {
    readonly target: Target & { readonly locator: ExecutionEnvironmentLocator };
    readonly kind: SrtTaskEnvironmentSessionKind;
    readonly request: Omit<JobHostRequest, "deadlineAt">;
  }): Promise<SrtTaskEnvironmentSession> {
    const { identity } = input.target;
    const key = this.sessionKey(identity, input.kind);
    const next = await this.locked(identity, async () => {
      const state = await this.read(identity);
      if (!state) throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_UNAVAILABLE");
      this.assertTarget(state, input.target);
      if (
        state.stop ||
        state.destroyed ||
        state.failed ||
        Date.parse(state.deadlineAt) <= this.options.now().getTime() ||
        state.locator === null ||
        state.locator.runtimeInstanceId !== this.options.runtimeInstanceId
      )
        throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_UNAVAILABLE");
      if (input.request.jobId !== srtTaskEnvironmentJobId(identity.environmentId, input.kind))
        throw new SrtTaskEnvironmentError("SRT_SESSION_BINDING_INVALID");
      const starting = this.starting.get(key);
      if (starting) {
        const retry = () => this.session(input);
        return { session: starting.then(retry, retry) };
      }
      const recorded = state.sessions[input.kind];
      const live = this.live.get(key);
      if (recorded) {
        if (!live) {
          await this.fail(state, "SRT_SESSION_LOST");
          throw new SrtTaskEnvironmentError("SRT_SESSION_LOST");
        }
        if (recorded.policyDigest !== input.request.policyDigest) {
          await this.fail(state, "SRT_POLICY_CHANGED");
          throw new SrtTaskEnvironmentError("SRT_POLICY_CHANGED");
        }
        return {
          session: Promise.resolve(
            this.wrap(identity, input.kind, live, recorded.policyDigest, state.deadlineAt),
          ),
        };
      }
      const record: SessionRecord = {
        jobId: input.request.jobId,
        privateDirectory: input.request.policy.privateDirectory,
        policyDigest: input.request.policyDigest,
        pid: null,
        startToken: null,
        residentGroup: null,
        residentStartToken: null,
        commandGroups: [],
      };
      const timingStarted = performance.now();
      const withRecord = { ...state, sessions: { ...state.sessions, [input.kind]: record } };
      await this.write(withRecord);
      const timing: Record<string, number> = {
        write_state: Math.round(performance.now() - timingStarted),
      };
      let session: SandboxJobSession;
      try {
        session = this.options.prepareSession({ ...input.request, deadlineAt: state.deadlineAt });
      } catch (error) {
        await this.fail(withRecord, "SRT_SESSION_START_FAILED");
        throw error;
      }
      const pid = (await session.spawned) ?? null;
      const spawned = {
        ...withRecord,
        sessions: { ...withRecord.sessions, [input.kind]: { ...record, pid } },
      };
      this.writeNow(spawned);
      this.live.set(key, session);
      const forget = () => {
        if (this.live.get(key) === session) this.live.delete(key);
      };
      void session.result.then(forget, forget);
      if (pid === null) {
        session.close();
        await this.fail(spawned, "SRT_SESSION_START_FAILED");
        throw new SrtTaskEnvironmentError("SRT_SESSION_START_FAILED");
      }
      const startToken = await this.options.startToken(pid).catch(() => null);
      await this.updateSession(identity, input.kind, (current) => ({ ...current, startToken }));
      timing["spawn_and_start_token"] = Math.round(
        performance.now() - timingStarted - (timing["write_state"] ?? 0),
      );
      const ready = this.finishStart({
        identity,
        kind: input.kind,
        session,
        policyDigest: record.policyDigest,
        deadlineAt: state.deadlineAt,
        timing,
        timingStarted,
      });
      this.starting.set(key, ready);
      const finished = () => {
        if (this.starting.get(key) === ready) this.starting.delete(key);
      };
      void ready.then(finished, finished);
      return { session: ready };
    });
    return next.session;
  }

  private async finishStart(input: {
    readonly identity: ExecutionEnvironmentIdentity;
    readonly kind: SrtTaskEnvironmentSessionKind;
    readonly session: SandboxJobSession;
    readonly policyDigest: string;
    readonly deadlineAt: string;
    readonly timing: Record<string, number>;
    readonly timingStarted: number;
  }): Promise<SrtTaskEnvironmentSession> {
    const { identity, kind, session, timing, timingStarted } = input;
    let residentGroup: number;
    let hostSteps: SandboxJobSessionReady["hostSteps"] = null;
    try {
      ({ residentProcessId: residentGroup, hostSteps } = await session.ready);
    } catch (error) {
      session.close();
      await this.locked(identity, async () =>
        this.fail(await this.require(identity), "SRT_SESSION_START_FAILED"),
      );
      throw error;
    }
    timing["ready"] = Math.round(
      performance.now() -
        timingStarted -
        (timing["write_state"] ?? 0) -
        (timing["spawn_and_start_token"] ?? 0),
    );
    const residentStartToken = await this.options.startToken(residentGroup).catch(() => null);
    await this.locked(identity, async () => {
      const state = await this.require(identity);
      if (state.stop || state.failed || this.live.get(this.sessionKey(identity, kind)) !== session)
        throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_UNAVAILABLE");
      await this.updateSession(identity, kind, (current) => ({
        ...current,
        residentGroup,
        residentStartToken,
      }));
    });
    console.error(
      JSON.stringify({
        event: "sandbox.srt_session.timing",
        environmentId: identity.environmentId,
        session: kind,
        stages: timing,
        hostSteps,
        totalMs: Math.round(performance.now() - timingStarted),
        at: new Date().toISOString(),
      }),
    );
    return this.wrap(identity, kind, session, input.policyDigest, input.deadlineAt);
  }

  async close(): Promise<void> {
    const sessions = [...this.live.values()];
    for (const session of sessions) session.close();
    await Promise.all(sessions.map((session) => this.settle(session)));
  }

  private wrap(
    identity: ExecutionEnvironmentIdentity,
    kind: SrtTaskEnvironmentSessionKind,
    session: SandboxJobSession,
    policyDigest: string,
    deadlineAt: string,
  ): SrtTaskEnvironmentSession {
    return {
      policyDigest,
      run: (input, authorize) => {
        if (Date.parse(input.deadlineAt) > Date.parse(deadlineAt))
          throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_DEADLINE_EXCEEDED");
        const run = session.run(input, authorize);
        const recorded = run.started.then(
          (task) =>
            this.locked(identity, () =>
              this.updateSession(identity, kind, (current) => ({
                ...current,
                commandGroups: [...current.commandGroups, task.processId],
              })),
            ).then(() => task.processId),
          () => null,
        );
        const result = run.result.then(async (outcome: JobHostCommandOutcome) => {
          const group = await recorded;
          if (!outcome.settled) {
            session.close();
            await this.locked(identity, async () =>
              this.fail(await this.require(identity), "SRT_COMMAND_UNSETTLED"),
            );
          } else if (group !== null)
            await this.locked(identity, () =>
              this.updateSession(identity, kind, (current) => ({
                ...current,
                commandGroups: current.commandGroups.filter((item) => item !== group),
              })),
            );
          return outcome;
        });
        return {
          started: run.started,
          result,
          readOutput: (offset, limit, channel) => run.readOutput(offset, limit, channel),
          cancel: (reason) => run.cancel(reason),
        };
      },
    };
  }

  private async remaining(state: EnvironmentState): Promise<readonly number[]> {
    const alive: number[] = [];
    for (const session of sessionRecords(state)) {
      for (const [pid, startToken] of [
        [session.pid, session.startToken],
        [session.residentGroup, session.residentStartToken],
      ] as const) {
        if (pid === null) continue;
        const token = await this.options.startToken(pid);
        const reused = token !== null && startToken !== null && token !== startToken;
        if (!reused && (token !== null || this.options.groupPresent(pid))) alive.push(pid);
      }
      for (const group of session.commandGroups)
        if (this.options.groupPresent(group)) alive.push(group);
    }
    return alive;
  }

  private async closeSessions(identity: ExecutionEnvironmentIdentity) {
    const sessions = this.liveKinds(identity).flatMap((kind) => {
      const session = this.live.get(this.sessionKey(identity, kind));
      return session ? [session] : [];
    });
    for (const session of sessions) session.close();
    await Promise.all(sessions.map((session) => this.settle(session)));
  }

  private async settle(session: SandboxJobSession) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      session.result.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_CLOSE_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private liveKinds(identity: ExecutionEnvironmentIdentity): SrtTaskEnvironmentSessionKind[] {
    return (["command", "file_write"] as const).filter((kind) =>
      this.live.has(this.sessionKey(identity, kind)),
    );
  }

  private assertTarget(state: EnvironmentState, target: Target) {
    if (
      JSON.stringify(state.identity) !== JSON.stringify(target.identity) ||
      state.createIntentId !== target.createIntentId ||
      (target.locator !== null &&
        JSON.stringify(state.locator) !== JSON.stringify(target.locator)) ||
      (state.locator === null && target.locator !== null)
    )
      throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_CHANGED");
  }

  private unreachedState(
    input: Target & { readonly stopIntentId: string; readonly stopFence: number },
  ): EnvironmentState {
    if (input.locator) throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_UNAVAILABLE");
    return {
      schemaVersion: STATE_VERSION,
      identity: input.identity,
      createIntentId: input.createIntentId,
      locator: null,
      deadlineAt: this.options.now().toISOString(),
      sessions: {},
      failed: "SRT_ENVIRONMENT_NOT_CREATED",
      stop: { stopIntentId: input.stopIntentId, stopFence: input.stopFence },
      destroyed: false,
    };
  }

  private async fail(state: EnvironmentState, reason: string) {
    if (state.failed) return;
    await this.write({ ...state, failed: reason });
  }

  private async updateSession(
    identity: ExecutionEnvironmentIdentity,
    kind: SrtTaskEnvironmentSessionKind,
    change: (current: SessionRecord) => SessionRecord,
  ) {
    const state = await this.require(identity);
    const current = state.sessions[kind];
    if (!current) throw new SrtTaskEnvironmentError("SRT_SESSION_BINDING_INVALID");
    await this.write({ ...state, sessions: { ...state.sessions, [kind]: change(current) } });
  }

  private async require(identity: ExecutionEnvironmentIdentity) {
    const state = await this.read(identity);
    if (!state) throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_UNAVAILABLE");
    return state;
  }

  private sessionKey(identity: ExecutionEnvironmentIdentity, kind: SrtTaskEnvironmentSessionKind) {
    return JSON.stringify([identity.environmentId, kind]);
  }

  private directory(identity: ExecutionEnvironmentIdentity) {
    return path.join(this.options.stateDirectory, sha256(identity.environmentId).slice(0, 32));
  }

  private async read(identity: ExecutionEnvironmentIdentity): Promise<EnvironmentState | null> {
    let text: string;
    try {
      text = await readFile(path.join(this.directory(identity), "sessions.json"), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
    const state = JSON.parse(text) as EnvironmentState;
    if (
      state.schemaVersion !== STATE_VERSION ||
      state.identity.environmentId !== identity.environmentId
    )
      throw new SrtTaskEnvironmentError("SRT_ENVIRONMENT_STATE_INVALID");
    return state;
  }

  private async write(state: EnvironmentState) {
    const directory = this.directory(state.identity);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "sessions.json");
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, file);
  }

  private writeNow(state: EnvironmentState) {
    const file = path.join(this.directory(state.identity), "sessions.json");
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, file);
  }

  private async saveEvidence(state: EnvironmentState, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = sha256(bytes);
    await writeFile(path.join(this.directory(state.identity), `stop-${digest}.json`), bytes, {
      mode: 0o600,
    });
    return { ref: `srt-stop-evidence:${digest.slice(0, 32)}`, digest };
  }

  private locked<T>(identity: ExecutionEnvironmentIdentity, work: () => Promise<T>): Promise<T> {
    const key = identity.environmentId;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(key, next);
    const release = () => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    };
    void next.then(release, release);
    return next;
  }
}
