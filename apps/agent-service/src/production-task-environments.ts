import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type CapabilityInvocationAuthority,
  type ClockPort,
  ExecutionEnvironmentError,
  type ExecutionEnvironmentLifecyclePort,
  type ExecutionEnvironmentRecord,
  type ExecutionEnvironmentStopReason,
  type ExecutionEnvironmentStorePort,
  type HostDirectoryGrant,
  type IdGeneratorPort,
  type SandboxExecutionRecord,
  type SandboxReservationReleaseVerification,
  type SandboxWorkspaceClaim,
  TaskEnvironmentCoordinator,
  taskEnvironmentCallEvidence,
} from "@himawari-agent/application";
import {
  type ExecutionBackendCapabilities,
  type SandboxExecutionFacts,
  type SandboxExecutionPlanCandidateV2,
  type SandboxExecutionPlanV2,
  type SandboxHostBinding,
  type SandboxTaskEnvironmentBinding,
  SRT_TASK_ENVIRONMENT_BACKEND_REF,
  sandboxResourceObservationSchema,
} from "@himawari-agent/execution-contracts";
import { containerRunnerDigest } from "@himawari-agent/runtime-sandbox/control";

export interface ProductionTaskEnvironments {
  readonly backendRef: string;
  readonly lifecycle: ExecutionEnvironmentLifecyclePort;
  readonly imageDigest?: string;
  readonly session?: "container" | "srt";
  readonly guarantees?: ExecutionBackendCapabilities["guarantees"];
  readonly inspectBeforeReuse?: boolean;
}

export interface ProductionSrtTaskEnvironmentAcquireInput {
  readonly runId: string;
  readonly hostId: string;
  readonly grant: HostDirectoryGrant;
  readonly claims: readonly SandboxWorkspaceClaim[];
  readonly binding: SandboxHostBinding;
  readonly allowedDomains: readonly string[];
  readonly plan: SandboxExecutionPlanCandidateV2;
  readonly deadlineAt: string;
}

const ENVIRONMENT_RESOURCES = {
  cpuMillicores: 1000,
  maxProcesses: 128,
  privateStorageBytes: 268435456,
} as const;
const PROOF_VALIDITY_MS = 1000;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hexDigest = (value: string) => (value.startsWith("sha256:") ? value.slice(7) : value);

function retryableStopFailure(error: unknown): boolean {
  return (
    (error instanceof ExecutionEnvironmentError && error.code === "EXECUTION_STOP_UNCONFIRMED") ||
    (error instanceof ApplicationPortError && error.code === "PORT_CONFLICT")
  );
}

export function createProductionTaskEnvironments(options: {
  readonly configuration: ProductionTaskEnvironments;
  readonly store: ExecutionEnvironmentStorePort;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}) {
  const { configuration, store, clock } = options;
  const srt =
    configuration.session === "srt" ||
    configuration.backendRef === SRT_TASK_ENVIRONMENT_BACKEND_REF;

  const coordinator = new TaskEnvironmentCoordinator({
    store,
    backend: configuration.lifecycle,
    ids: { next: (prefix) => options.ids.next(prefix) },
    clock,
    authority: options.authority,
    ...(configuration.guarantees ? { requiredGuarantees: configuration.guarantees } : {}),
    ...(configuration.inspectBeforeReuse === undefined
      ? {}
      : { inspectBeforeReuse: configuration.inspectBeforeReuse }),
  });
  const authorized = () => ({ authority: options.authority(), now: clock.now() });
  let leftoverCursor: string | null = null;

  const belongsTo = (record: ExecutionEnvironmentRecord, plan: SandboxExecutionPlanV2) =>
    record.identity.role === "primary" &&
    record.identity.ownerId === plan.identity.ownerId &&
    record.identity.agentId === plan.identity.agentId &&
    record.identity.runId === plan.identity.runId &&
    record.identity.hostId === plan.identity.hostId &&
    record.backendRef === plan.backendRef;

  const current = async (plan: SandboxExecutionPlanV2) =>
    (await store.readRun(plan.identity.runId))?.environments
      .filter((record) => belongsTo(record, plan))
      .at(-1);

  const primaryForRun = async (runId: string) =>
    (await store.readRun(runId))?.environments
      .filter(
        (record) =>
          record.identity.role === "primary" && record.backendRef === configuration.backendRef,
      )
      .at(-1);

  const environmentScope = (input: {
    readonly hostId: string;
    readonly grant: HostDirectoryGrant;
    readonly claims: readonly SandboxWorkspaceClaim[];
    readonly binding: SandboxHostBinding;
  }) => {
    const [claim, ...extra] = input.claims;
    if (
      !claim ||
      extra.length > 0 ||
      claim.file !== undefined ||
      claim.hostId !== input.hostId ||
      claim.canonicalRootId !== input.grant.canonicalRootId
    )
      throw new Error("SANDBOX_TASK_ENVIRONMENT_UNSUPPORTED");
    const access = input.grant.operations.some((operation) => operation !== "read")
      ? ("write" as const)
      : ("read" as const);
    const envelope = {
      schemaVersion: "execution-envelope.v1" as const,
      directories: [
        {
          hostId: input.hostId,
          grantRef: input.grant.id,
          canonicalRootId: input.grant.canonicalRootId,
          access,
          source: {
            authorizationRef: input.grant.authorizationRef,
            decidedBy: "user" as const,
            delegationListRef: null,
            expiresAt: input.grant.expiresAt,
          },
        },
      ],
      network: [],
      resources: {
        ...ENVIRONMENT_RESOURCES,
        memoryBytes: input.binding.maximumResourceCeiling.maxMemoryBytes,
      },
    };
    const leases = [
      {
        ref: `environment-lease:${claim.ref}`,
        hostId: claim.hostId,
        canonicalRootId: claim.canonicalRootId,
        access,
        lineage: claim.lineage,
      },
    ];
    return { envelope, leases };
  };

  const bound = async (plan: SandboxExecutionPlanV2, facts: SandboxExecutionFacts) => {
    const environment = facts.environment;
    if (environment.kind !== "container")
      throw new Error("SANDBOX_TASK_ENVIRONMENT_BINDING_CHANGED");
    const record = await store.read(environment.taskEnvironmentId);
    if (
      !record ||
      !belongsTo(record, plan) ||
      !record.locator ||
      environment.executionJobId !== record.identity.executionJobId ||
      environment.environmentGeneration !== record.identity.environmentGeneration ||
      environment.createIntentId !== record.createIntentId ||
      environment.runtimeInstanceId !== record.locator.runtimeInstanceId ||
      environment.runtimeEnvironmentId !== record.locator.runtimeEnvironmentId ||
      environment.policyDigest !== record.locator.effectivePolicyDigest
    )
      throw new Error("SANDBOX_TASK_ENVIRONMENT_BINDING_CHANGED");
    return {
      record,
      evidence: taskEnvironmentCallEvidence({
        environmentId: record.identity.environmentId,
        invocationId: plan.identity.invocationId,
        createIntentId: record.createIntentId,
        runtimeInstanceId: record.locator.runtimeInstanceId,
        runtimeEnvironmentId: record.locator.runtimeEnvironmentId,
      }),
    };
  };

  const settled = (facts: SandboxExecutionFacts) =>
    facts.result !== null && facts.result.kind !== "unknown";

  const releasedEvidence = async (plan: SandboxExecutionPlanV2, facts: SandboxExecutionFacts) => {
    const { record, evidence } = await bound(plan, facts);
    if (!record.calls.some((call) => call.invocationId === plan.identity.invocationId))
      throw new Error("SANDBOX_TASK_ENVIRONMENT_BINDING_CHANGED");
    if (!settled(facts) && record.state !== "released")
      throw new Error("SANDBOX_TASK_ENVIRONMENT_STILL_RUNNING");
    await store.completeCall({
      ...authorized(),
      environmentId: record.identity.environmentId,
      invocationId: plan.identity.invocationId,
    });
    return evidence;
  };

  return {
    backendRef: configuration.backendRef,

    async acquire(input: {
      readonly runId: string;
      readonly hostId: string;
      readonly grant: HostDirectoryGrant;
      readonly claims: readonly SandboxWorkspaceClaim[];
      readonly binding: SandboxHostBinding;
      readonly deadlineAt: string;
    }): Promise<ExecutionEnvironmentRecord> {
      const { envelope, leases } = environmentScope(input);
      if (!configuration.imageDigest) throw new Error("SANDBOX_TASK_ENVIRONMENT_UNSUPPORTED");
      return coordinator.acquire({
        runId: input.runId,
        hostId: input.hostId,
        envelope,
        leases,
        policyDigest: digest({ profileRef: input.binding.profileRef, envelope }),
        imageDigest: configuration.imageDigest,
        runnerDigest: containerRunnerDigest(input.binding.runtimeDigest),
        deadlineAt: input.deadlineAt,
      });
    },

    async acquireSrt(
      input: ProductionSrtTaskEnvironmentAcquireInput,
    ): Promise<ExecutionEnvironmentRecord> {
      const { envelope, leases } = environmentScope(input);
      const policyDigest = digest({
        profileRef: input.binding.profileRef,
        envelope,
        grant: {
          id: input.grant.id,
          revision: input.grant.revision,
          operations: input.grant.operations,
          canonicalRootId: input.grant.canonicalRootId,
          authorizationRef: input.grant.authorizationRef,
          expiresAt: input.grant.expiresAt,
        },
        allowedDomains: [...input.allowedDomains].sort(),
        executionLease: input.plan.executionLease,
        threadId: input.plan.identity.threadId,
        modelRef: input.plan.modelRef,
        runtimeDigest: input.binding.runtimeDigest,
        runnerDigest: input.binding.runner.sha256,
        qualificationRef: input.plan.binding.qualificationRef,
      });
      const next = {
        runId: input.runId,
        hostId: input.hostId,
        envelope,
        leases,
        policyDigest,
        imageDigest: hexDigest(input.binding.runtimeDigest),
        runnerDigest: hexDigest(input.binding.runner.sha256),
        deadlineAt: input.deadlineAt,
      };
      const existing = await primaryForRun(input.runId);
      if (existing && (existing.state === "ready" || existing.state === "running")) {
        const expired = Date.parse(existing.deadlineAt) <= Date.parse(clock.now());
        if (expired || existing.locator?.effectivePolicyDigest !== policyDigest)
          return coordinator.rotate({
            environmentId: existing.identity.environmentId,
            reason: expired ? "expiry" : "revocation",
            stoppedResourceRefs: [],
            ...next,
          });
      }
      return coordinator.acquire(next);
    },

    async binding(plan: SandboxExecutionPlanV2): Promise<SandboxTaskEnvironmentBinding | null> {
      if (plan.backendRef !== configuration.backendRef) return null;
      const record = await current(plan);
      if (!record || (record.state !== "ready" && record.state !== "running") || !record.locator)
        return null;
      return {
        identity: record.identity,
        createIntentId: record.createIntentId,
        locator: record.locator,
        stopFence: record.stopFence,
      };
    },

    async verifyPreparation(
      plan: SandboxExecutionPlanV2,
      facts: SandboxExecutionFacts,
      claims: readonly SandboxWorkspaceClaim[],
    ): Promise<void> {
      const { record } = await bound(plan, facts);
      if (
        facts.environment.kind !== "container" ||
        facts.environment.stopFence !== record.stopFence ||
        facts.environment.supervisor.supervisorId !== record.locator?.runtimeEnvironmentId ||
        facts.environment.supervisor.bootId !== record.locator.runtimeInstanceId
      )
        throw new Error("SANDBOX_TASK_ENVIRONMENT_BINDING_CHANGED");
      await store.linkCall({
        ...authorized(),
        environmentId: record.identity.environmentId,
        expectedStopFence: record.stopFence,
        invocationId: plan.identity.invocationId,
        receiptRef: plan.identity.receiptRef,
        claims,
      });
    },

    async evidence(plan: SandboxExecutionPlanV2, facts: SandboxExecutionFacts) {
      const resource = facts.resource;
      if (resource.supervision !== "released") {
        if (resource.supervision === "controlled")
          throw new Error("SANDBOX_TASK_ENVIRONMENT_BINDING_CHANGED");
        return [];
      }
      const expected = await releasedEvidence(plan, facts);
      if (resource.evidence.ref !== expected.ref || resource.evidence.digest !== expected.digest)
        throw new Error("SANDBOX_TASK_ENVIRONMENT_EVIDENCE_CHANGED");
      return [expected];
    },

    async observe(record: SandboxExecutionRecord) {
      const { plan, facts } = record;
      const { record: environment } = await bound(plan, facts);
      if (!settled(facts) && environment.state !== "released")
        await coordinator.stop({
          environmentId: environment.identity.environmentId,
          reason: "failure",
          stoppedResourceRefs: [],
        });
      const expected = await releasedEvidence(plan, facts);
      const now = clock.now();
      const previous = facts.resource;
      const resource = sandboxResourceObservationSchema.parse({
        schemaVersion: previous.schemaVersion,
        environmentId: previous.environmentId,
        creator: previous.creator,
        policyDigest: previous.policyDigest,
        scopeDigest: previous.scopeDigest,
        sequence: previous.sequence + 1,
        occurredAt: now,
        supervisor: previous.supervisor,
        resourceRef: previous.resourceRef,
        status: previous.status,
        metrics: previous.metrics,
        supervision: "released",
        cleanup: srt ? "process_group_gone" : "confirmed",
        evidence: {
          ...expected,
          qualificationRef: plan.binding.qualificationRef,
          profileRef: plan.binding.profileRef,
          validUntil: new Date(Date.parse(now) + PROOF_VALIDITY_MS).toISOString(),
          subject: {
            kind: "task_environment",
            environmentId: environment.identity.environmentId,
          },
        },
      });
      return { resource, evidence: [expected] };
    },

    async releaseReservation(
      plan: SandboxExecutionPlanV2,
      stopRequestedAt: string,
    ): Promise<SandboxReservationReleaseVerification | undefined> {
      const environments = (await store.readRun(plan.identity.runId))?.environments.filter(
        (record) => belongsTo(record, plan),
      );
      if (!environments?.length || environments.some((record) => record.state !== "released"))
        return undefined;
      const checkedAt = clock.now();
      return {
        schemaVersion: "sandbox-reservation-release.v1",
        basis: "task_environment_released",
        identity: plan.identity,
        environmentId: plan.environmentId,
        semanticFingerprint: plan.semanticFingerprint,
        stopRequestedAt,
        checkedAt,
        validUntil: new Date(Date.parse(checkedAt) + PROOF_VALIDITY_MS).toISOString(),
        taskEnvironmentIds: environments.map((record) => record.identity.environmentId),
        evidence: {
          ref: `environment-release:${digest(plan.environmentId).slice(0, 32)}`,
          digest: digest(environments.map((record) => record.releaseReceipt)),
        },
      };
    },

    async stopLeftovers(limit: number): Promise<void> {
      const page = await store.listLeftovers({
        backendRef: configuration.backendRef,
        now: clock.now(),
        afterEnvironmentId: leftoverCursor,
        limit,
      });
      leftoverCursor =
        page.length < limit ? null : (page.at(-1)?.environment.identity.environmentId ?? null);
      let failure: { readonly cause: unknown } | null = null;
      for (const { environment, reason } of page) {
        try {
          await coordinator.stop({
            environmentId: environment.identity.environmentId,
            reason,
            stoppedResourceRefs: [],
          });
        } catch (error) {
          if (!retryableStopFailure(error)) failure ??= { cause: error };
        }
      }
      if (failure) throw failure.cause;
    },

    async stopRun(
      runId: string,
      reason: Extract<ExecutionEnvironmentStopReason, "run_finished" | "run_cancelled">,
    ): Promise<boolean> {
      const environments = (await store.readRun(runId))?.environments ?? [];
      const results = await Promise.all(
        environments
          .filter(
            (environment) =>
              environment.state !== "released" &&
              environment.backendRef === configuration.backendRef,
          )
          .map((environment) =>
            coordinator
              .stop({
                environmentId: environment.identity.environmentId,
                reason,
                stoppedResourceRefs: [],
              })
              .then(
                (stopped) => stopped.state === "released",
                () => false,
              ),
          ),
      );
      return results.every(Boolean);
    },
  };
}
