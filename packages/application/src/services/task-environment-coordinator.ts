import {
  type ExecutionEnvelope,
  executionBackendCapabilitiesSchema,
  TASK_ENVIRONMENT_GUARANTEES,
} from "@himawari-agent/execution-contracts";
import type { CapabilityInvocationAuthority } from "../ports/capability-invocations.js";
import type { ExecutionBackendPort } from "../ports/execution-backend.js";
import type {
  ExecutionEnvironmentRecord,
  ExecutionEnvironmentRotationReason,
  ExecutionEnvironmentStopReason,
  ExecutionEnvironmentStorePort,
} from "../ports/execution-environment.js";
import type { SandboxWorkspaceClaim } from "../ports/sandbox-execution-journal.js";
import { type EnvelopeCapability, envelopeAfterWithdrawal } from "./execution-envelope-policy.js";

export type ExecutionEnvironmentErrorCode =
  | "EXECUTION_BACKEND_UNAVAILABLE"
  | "EXECUTION_POLICY_UNSUPPORTED"
  | "EXECUTION_ENVIRONMENT_CREATE_FAILED"
  | "EXECUTION_ENVIRONMENT_UNKNOWN"
  | "EXECUTION_STOP_UNCONFIRMED"
  | "EXECUTION_BINDING_CHANGED"
  | "EXECUTION_ENVELOPE_EXCEEDED";

export class ExecutionEnvironmentError extends Error {
  readonly code: ExecutionEnvironmentErrorCode;
  constructor(code: ExecutionEnvironmentErrorCode, options?: { readonly cause?: unknown }) {
    super(code, options);
    this.name = "ExecutionEnvironmentError";
    this.code = code;
  }
}

export function executionEnvelopeCovers(
  current: ExecutionEnvelope,
  requested: ExecutionEnvelope,
): boolean {
  return (
    requested.directories.every((wanted) =>
      current.directories.some(
        (held) =>
          held.hostId === wanted.hostId &&
          held.canonicalRootId === wanted.canonicalRootId &&
          (held.access === "write" || wanted.access === "read"),
      ),
    ) &&
    requested.network.every((wanted) =>
      current.network.some((held) => held.target === wanted.target),
    ) &&
    requested.resources.cpuMillicores <= current.resources.cpuMillicores &&
    requested.resources.memoryBytes <= current.resources.memoryBytes &&
    requested.resources.maxProcesses <= current.resources.maxProcesses &&
    requested.resources.privateStorageBytes <= current.resources.privateStorageBytes
  );
}

const ROTATION_AFTER_STOP: Readonly<
  Record<ExecutionEnvironmentStopReason, ExecutionEnvironmentRotationReason | null>
> = {
  expansion: "expansion",
  revocation: "revocation",
  expiry: "expiry",
  failure: "failure",
  supervision_lost: "failure",
  run_finished: null,
  run_cancelled: null,
};

export class TaskEnvironmentCoordinator {
  private readonly store: ExecutionEnvironmentStorePort;
  private readonly backend: ExecutionBackendPort;
  private readonly ids: { next(prefix: string): string };
  private readonly clock: { now(): string };
  private readonly authority: () => CapabilityInvocationAuthority;
  private readonly runs = new Map<string, Promise<unknown>>();

  constructor(options: {
    readonly store: ExecutionEnvironmentStorePort;
    readonly backend: ExecutionBackendPort;
    readonly ids: { next(prefix: string): string };
    readonly clock: { now(): string };
    readonly authority: () => CapabilityInvocationAuthority;
  }) {
    this.store = options.store;
    this.backend = options.backend;
    this.ids = options.ids;
    this.clock = options.clock;
    this.authority = options.authority;
  }

  acquire(input: {
    readonly runId: string;
    readonly hostId: string;
    readonly envelope: ExecutionEnvelope;
    readonly leases: readonly SandboxWorkspaceClaim[];
    readonly policyDigest: string;
    readonly imageDigest: string;
    readonly runnerDigest: string;
    readonly deadlineAt: string;
  }): Promise<ExecutionEnvironmentRecord> {
    const previous = this.runs.get(input.runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.acquireInOrder(input));
    this.runs.set(input.runId, next);
    return next.finally(() => {
      if (this.runs.get(input.runId) === next) this.runs.delete(input.runId);
    });
  }

  async rotate(
    input: Parameters<TaskEnvironmentCoordinator["acquire"]>[0] & {
      readonly environmentId: string;
      readonly reason: "expansion" | "revocation" | "expiry" | "failure";
      readonly stoppedResourceRefs: readonly string[];
    },
  ): Promise<ExecutionEnvironmentRecord> {
    const { environmentId, reason, stoppedResourceRefs, ...next } = input;
    const current = await this.store.read(environmentId);
    if (!current || current.identity.runId !== next.runId || current.identity.role !== "primary")
      throw new ExecutionEnvironmentError("EXECUTION_BINDING_CHANGED");
    await this.stop({ environmentId, reason, stoppedResourceRefs });
    return this.acquire(next);
  }

  async withdraw(input: {
    readonly environmentId: string;
    readonly withdrawnAuthorizationRefs: readonly string[];
    readonly stoppedResourceRefs: readonly string[];
  }): Promise<{
    readonly environment: ExecutionEnvironmentRecord;
    readonly removed: readonly EnvelopeCapability[];
    readonly nextExpiryAt: string | null;
  }> {
    const current = await this.store.read(input.environmentId);
    if (!current || current.identity.role !== "primary")
      throw new ExecutionEnvironmentError("EXECUTION_BINDING_CHANGED");
    const remaining = envelopeAfterWithdrawal(current.envelope, {
      now: this.clock.now(),
      withdrawnAuthorizationRefs: input.withdrawnAuthorizationRefs,
    });
    if (remaining.removed.length === 0)
      return { environment: current, removed: [], nextExpiryAt: remaining.nextExpiryAt };
    const revoked = [...current.envelope.directories, ...current.envelope.network].some((item) =>
      input.withdrawnAuthorizationRefs.includes(item.source.authorizationRef),
    );
    const environment = await this.rotate({
      environmentId: input.environmentId,
      reason: revoked ? "revocation" : "expiry",
      stoppedResourceRefs: input.stoppedResourceRefs,
      runId: current.identity.runId,
      hostId: current.identity.hostId,
      envelope: remaining.envelope,
      leases: current.leases.filter((lease) =>
        remaining.envelope.directories.some(
          (directory) =>
            directory.hostId === lease.hostId &&
            directory.canonicalRootId === lease.canonicalRootId &&
            directory.access === lease.access,
        ),
      ),
      policyDigest: current.policyDigest,
      imageDigest: current.imageDigest,
      runnerDigest: current.runnerDigest,
      deadlineAt: current.deadlineAt,
    });
    return { environment, removed: remaining.removed, nextExpiryAt: remaining.nextExpiryAt };
  }

  async resolveUnknown(environmentId: string): Promise<ExecutionEnvironmentRecord> {
    const record = await this.store.read(environmentId);
    if (!record) throw new ExecutionEnvironmentError("EXECUTION_BINDING_CHANGED");
    if (record.state !== "unknown") return record;
    const observation = await this.backend
      .inspect({ identity: record.identity, createIntentId: record.createIntentId, locator: null })
      .catch((cause: unknown) => {
        throw new ExecutionEnvironmentError("EXECUTION_ENVIRONMENT_UNKNOWN", { cause });
      });
    if (observation.state === "unknown")
      throw new ExecutionEnvironmentError("EXECUTION_ENVIRONMENT_UNKNOWN");
    if (observation.locator) {
      const created = await this.store.recordCreated({
        ...this.authorized(),
        environmentId,
        locator: observation.locator,
      });
      if (observation.state === "running" && created.executable) return created.record;
    }
    return this.stop({ environmentId, reason: "failure", stoppedResourceRefs: [] });
  }

  async stop(input: {
    readonly environmentId: string;
    readonly reason: ExecutionEnvironmentStopReason;
    readonly stoppedResourceRefs: readonly string[];
  }): Promise<ExecutionEnvironmentRecord> {
    const { record } = await this.store.requestStop({
      ...this.authorized(),
      environmentId: input.environmentId,
      stopIntentId: this.ids.next("environment-stop"),
      reason: input.reason,
      stoppedResourceRefs: input.stoppedResourceRefs,
    });
    if (record.state === "released") return record;
    if (!record.stopIntent) throw new ExecutionEnvironmentError("EXECUTION_BINDING_CHANGED");
    if (record.createDispatchedAt === null)
      return (
        await this.store.acceptRelease({
          ...this.authorized(),
          environmentId: input.environmentId,
          proof: { basis: "create_not_dispatched" },
        })
      ).record;
    const request = {
      identity: record.identity,
      createIntentId: record.createIntentId,
      locator: record.locator,
      stopIntentId: record.stopIntent.stopIntentId,
      stopFence: record.stopFence,
    };
    const proof = await this.backend
      .stop(request)
      .then(() =>
        this.store.acknowledgeStop({
          ...this.authorized(),
          environmentId: input.environmentId,
          stopIntentId: request.stopIntentId,
        }),
      )
      .then(() => this.backend.verifyStopped(request))
      .catch((cause: unknown) => {
        throw new ExecutionEnvironmentError("EXECUTION_STOP_UNCONFIRMED", { cause });
      });
    if (proof.basis === "verified_stopped" && record.locator === null)
      await this.store.recordCreated({
        ...this.authorized(),
        environmentId: input.environmentId,
        locator: proof.locator,
      });
    return (
      await this.store.acceptRelease({
        ...this.authorized(),
        environmentId: input.environmentId,
        proof,
      })
    ).record;
  }

  private async acquireInOrder(
    input: Parameters<TaskEnvironmentCoordinator["acquire"]>[0],
  ): Promise<ExecutionEnvironmentRecord> {
    const capabilities = await this.qualifiedBackend();
    const latest = (await this.store.readRun(input.runId))?.environments
      .filter((environment) => environment.identity.role === "primary")
      .at(-1);
    let rotationReason: ExecutionEnvironmentRotationReason = "initial";
    if (latest?.state === "released") {
      const after = latest.stopIntent ? ROTATION_AFTER_STOP[latest.stopIntent.reason] : null;
      if (!after) throw new ExecutionEnvironmentError("EXECUTION_BINDING_CHANGED");
      rotationReason = after;
    }
    const { record, applied } = await this.store.reserve({
      ...this.authorized(),
      runId: input.runId,
      hostId: input.hostId,
      role: "primary",
      rotationReason,
      backendRef: capabilities.backendRef,
      envelope: input.envelope,
      policyDigest: input.policyDigest,
      imageDigest: input.imageDigest,
      runnerDigest: input.runnerDigest,
      deadlineAt: input.deadlineAt,
      leases: input.leases,
      ids: {
        executionJobId: this.ids.next("execution-job"),
        environmentId: this.ids.next("environment"),
        createIntentId: this.ids.next("environment-create"),
      },
    });
    if (applied || record.state === "reserved") return this.create(record);
    if (record.state === "ready" || record.state === "running") {
      if (!executionEnvelopeCovers(record.envelope, input.envelope))
        throw new ExecutionEnvironmentError("EXECUTION_ENVELOPE_EXCEEDED");
      return record;
    }
    if (record.state === "creating")
      await this.store.recordCreateUnknown({
        ...this.authorized(),
        environmentId: record.identity.environmentId,
        reasonCode: "EXECUTION_CREATE_INTERRUPTED",
      });
    if (record.state === "creating" || record.state === "unknown")
      throw new ExecutionEnvironmentError("EXECUTION_ENVIRONMENT_UNKNOWN");
    throw new ExecutionEnvironmentError("EXECUTION_STOP_UNCONFIRMED");
  }

  private async create(record: ExecutionEnvironmentRecord): Promise<ExecutionEnvironmentRecord> {
    const environmentId = record.identity.environmentId;
    await this.store.beginCreate({ ...this.authorized(), environmentId });
    let locator: Awaited<ReturnType<ExecutionBackendPort["create"]>>;
    try {
      locator = await this.backend.create({
        identity: record.identity,
        createIntentId: record.createIntentId,
        envelope: record.envelope,
        policyDigest: record.policyDigest,
        imageDigest: record.imageDigest,
        runnerDigest: record.runnerDigest,
        deadlineAt: record.deadlineAt,
      });
    } catch {
      await this.store.recordCreateUnknown({
        ...this.authorized(),
        environmentId,
        reasonCode: "EXECUTION_CREATE_RESPONSE_LOST",
      });
      const resolved = await this.resolveUnknown(environmentId).catch((cause: unknown) => {
        throw new ExecutionEnvironmentError("EXECUTION_ENVIRONMENT_UNKNOWN", { cause });
      });
      if (resolved.state === "released")
        throw new ExecutionEnvironmentError("EXECUTION_ENVIRONMENT_CREATE_FAILED");
      return resolved;
    }
    const created = await this.store.recordCreated({
      ...this.authorized(),
      environmentId,
      locator,
    });
    if (!created.executable) throw new ExecutionEnvironmentError("EXECUTION_BINDING_CHANGED");
    return created.record;
  }

  private async qualifiedBackend() {
    const declared = await this.backend.capabilities().catch((cause: unknown) => {
      throw new ExecutionEnvironmentError("EXECUTION_BACKEND_UNAVAILABLE", { cause });
    });
    let capabilities: ReturnType<typeof executionBackendCapabilitiesSchema.parse>;
    try {
      capabilities = executionBackendCapabilitiesSchema.parse(declared);
    } catch (cause) {
      throw new ExecutionEnvironmentError("EXECUTION_POLICY_UNSUPPORTED", { cause });
    }
    if (!TASK_ENVIRONMENT_GUARANTEES.every((item) => capabilities.guarantees.includes(item)))
      throw new ExecutionEnvironmentError("EXECUTION_POLICY_UNSUPPORTED");
    return capabilities;
  }

  private authorized() {
    return { authority: this.authority(), now: this.clock.now() };
  }
}
