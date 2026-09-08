import { createHash } from "node:crypto";
import {
  type CapabilityInvocationAuthority,
  type ClockPort,
  type ConsumeCapabilityInvocationInput,
  createSandboxExecutionPlanCandidate,
  type GovernedCapabilityExecutionHandle,
  type HostDirectoryGrant,
  hostDirectoryGrantStateKey,
  type IdGeneratorPort,
  type PayloadProtectorPort,
  type ProductConfiguration,
  type RuntimeToolInvocation,
  type SandboxExecutionPlan,
  SandboxScopeService,
  type WorkerDelegationAdmissionServiceOptions,
} from "@himawari-agent/application";
import {
  type SandboxExecutionPlanCandidate,
  type SandboxScope,
  sandboxExecutionPlanCandidateSchema,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  CapabilityDeploymentSnapshotLoader,
  verifySandboxHost,
} from "@himawari-agent/platform-node";
import type { ProductionFileReadServices } from "./production-file-read-workflow.js";
import type { ProductionRuntimeSandbox } from "./production-runtime-tools.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Composition only: existing grants, protected Run artifacts and the existing
 * job journal retain authority. Neither inventory nor this factory issues it. */
export async function createProductionSandboxServices(options: {
  readonly configuration: Pick<
    ProductConfiguration,
    "ownerId" | "agentId" | "capabilityDeployment"
  >;
  readonly repository: SqliteProductStateRepository;
  readonly protector: PayloadProtectorPort;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly fileRead: ProductionFileReadServices;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}) {
  const { configuration, repository, protector, clock, ids } = options;
  if (!configuration.capabilityDeployment) return undefined;
  const loader = new CapabilityDeploymentSnapshotLoader({
    ...configuration.capabilityDeployment,
    now: () => clock.now(),
  });
  const initial = await loader.load();
  const sandboxEntries = initial.snapshot.capabilities.filter(
    (entry) => entry.binding.kind === "sandbox",
  );
  if (sandboxEntries.length === 0) return undefined;
  const hostIds = new Set(
    sandboxEntries.map((entry) =>
      entry.binding.kind === "sandbox" ? entry.binding.value.hostId : "",
    ),
  );
  if (hostIds.size !== 1) throw new Error("SANDBOX_HOST_BINDING_AMBIGUOUS");
  const hostId = [...hostIds][0];
  if (!hostId) throw new Error("SANDBOX_HOST_BINDING_UNAVAILABLE");
  const journal = repository.sandboxJobJournal(configuration.ownerId, configuration.agentId);
  const capabilities = repository.capabilityStore(configuration.ownerId, configuration.agentId);
  const payloads = repository.payloadStore(configuration.ownerId, configuration.agentId);
  const artifacts = () =>
    repository.runPayloadArtifactPort(configuration.ownerId, configuration.agentId, {
      product: options.authority().product,
      lease: options.authority().lease,
    });
  const readJson = async (ref: string): Promise<unknown> => {
    const payload = await payloads.get(ref);
    if (
      !payload ||
      payload.contentType !== "application/json" ||
      payload.ciphertext.byteLength > 131072
    )
      throw new Error("SANDBOX_CONTEXT_UNAVAILABLE");
    const bytes = await protector.unprotect({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      payload,
    });
    if (bytes.byteLength > 65536) throw new Error("SANDBOX_CONTEXT_UNAVAILABLE");
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  };
  const entryFor = async (capabilityRef: string, capabilityVersion: string) => {
    const loaded = await loader.load();
    const entry = loaded.snapshot.capabilities.find(
      (entry) =>
        entry.manifest.ref === capabilityRef && entry.manifest.version === capabilityVersion,
    );
    if (!entry || entry.binding.kind !== "sandbox" || !entry.qualification.sandbox)
      throw new Error("SANDBOX_HOST_BINDING_UNAVAILABLE");
    return { binding: entry.binding.value, qualification: entry.qualification.sandbox };
  };
  const verifyParent = async (scope: SandboxScope, plan: SandboxExecutionPlanCandidate) => {
    const saved = await artifacts().lookup({
      runId: scope.runId as RuntimeToolInvocation["runId"],
      purpose: "trace",
      operationKey: `runtime-tool-intent:${hash([scope.runId, scope.toolCallId])}`,
    });
    if (saved) {
      const intent = (await readJson(saved.payloadRef)) as {
        request?: {
          messageId: string;
          causationId: string;
          payload: { inputRef: string; capabilityHandleRef: string };
        };
      };
      if (
        intent.request?.messageId !== plan.identity.invocationId ||
        intent.request.causationId !== scope.parentRequestId ||
        intent.request.payload.inputRef !== plan.inputRef ||
        intent.request.payload.capabilityHandleRef !== plan.handleRef
      )
        throw new Error("SANDBOX_PARENT_CHANGED");
      if (scope.parentToolCallId === null) return;
      const key = hash([scope.runId, scope.parentToolCallId]);
      if (scope.toolCallId !== `file-phase:${hash([key, plan.operation])}`)
        throw new Error("SANDBOX_PARENT_CHANGED");
      const context = await artifacts().lookup({
        runId: scope.runId as RuntimeToolInvocation["runId"],
        purpose: "trace",
        operationKey: `runtime-file-read:${key}:context`,
      });
      if (!context) throw new Error("SANDBOX_PARENT_UNAVAILABLE");
      const savedContext = (await readJson(context.payloadRef)) as {
        call: RuntimeToolInvocation;
        binding: unknown;
      };
      const savedCall = savedContext.call;
      if (!savedCall.context) throw new Error("SANDBOX_PARENT_UNAVAILABLE");
      const current = await options.fileRead.binding({
        ...savedCall,
        context: {
          ...savedCall.context,
          executionLease: plan.executionLease as NonNullable<
            RuntimeToolInvocation["context"]
          >["executionLease"],
        },
      });
      if (
        !current ||
        savedContext.call.runId !== scope.runId ||
        savedContext.call.toolCallId !== scope.parentToolCallId ||
        current.modelRef !== plan.modelRef ||
        current.threadId !== plan.identity.threadId ||
        hash(current) !== hash(savedContext.binding)
      )
        throw new Error("SANDBOX_PARENT_CHANGED");
      return;
    }
    const parent = await journal.readByInvocation({
      runId: scope.runId,
      invocationId: scope.parentRequestId,
    });
    if (
      !parent ||
      !["starting", "running"].includes(parent.observation.state) ||
      parent.plan.identity.toolCallId !== scope.parentToolCallId ||
      parent.plan.modelRef !== plan.modelRef ||
      parent.plan.identity.threadId !== plan.identity.threadId ||
      hash(parent.plan.executionLease) !== hash(plan.executionLease) ||
      parent.plan.identity.hostId !== plan.identity.hostId
    )
      throw new Error("SANDBOX_PARENT_UNAVAILABLE");
    const live = await repository
      .capabilityInvocationReceiptPort(configuration.ownerId, configuration.agentId)
      .read({
        handleRef: parent.plan.handleRef,
        invocationId: parent.plan.identity.invocationId,
        authority: options.authority(),
        now: clock.now(),
      });
    if (!live) throw new Error("SANDBOX_PARENT_UNAVAILABLE");
  };
  const resolve = async (value: SandboxExecutionPlanCandidate | SandboxExecutionPlan) => {
    const { semanticFingerprint: _fingerprint, ...candidate } = value as SandboxExecutionPlan;
    const plan = sandboxExecutionPlanCandidateSchema.parse(candidate);
    const { binding, qualification } = await entryFor(plan.capabilityRef, plan.capabilityVersion);
    await verifySandboxHost({ binding, qualification, hostId, plan });
    const raw = sandboxScopeSchema.parse(await readJson(plan.binding.scopeRef));
    const reader = new SandboxScopeService({
      hostId,
      payloads,
      protector,
      now: () => clock.now(),
      digest: bytesHash,
      verifyParent,
      files: {
        readGrant: async (ref) => {
          const stored = await repository.readScopedState(
            configuration.ownerId,
            configuration.agentId,
            hostDirectoryGrantStateKey(ref),
          );
          return stored?.value as unknown as HostDirectoryGrant | undefined;
        },
      },
      network: {
        authorizations: repository.authorizationStore(),
        maximumDomains: binding.allowedDomains,
      },
    });
    const resolved = await reader.resolve(plan, raw.parentRequestId);
    if (
      !binding.roots.some(
        (root) => root.canonicalRootId === resolved.scope.directoryGrant.canonicalRootId,
      )
    )
      throw new Error("SANDBOX_ROOT_UNAVAILABLE");
    return { binding, qualification, ...resolved };
  };
  const persistScope = async (scope: SandboxScope, invocationId: string) => {
    const plaintext = new TextEncoder().encode(JSON.stringify(sandboxScopeSchema.parse(scope)));
    const payload = await protector.protect({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      ref: ids.next("sandbox-scope"),
      dataClassification: "private",
      contentType: "application/json",
      plaintext,
      createdAt: clock.now(),
    });
    const saved = await artifacts().commit({
      runId: scope.runId as RuntimeToolInvocation["runId"],
      purpose: "trace",
      operationKey: `sandbox-scope:${invocationId}`,
      payload,
    });
    const actual = sandboxScopeSchema.parse(await readJson(saved.ref));
    if (hash(actual) !== hash(sandboxScopeSchema.parse(scope)))
      throw new Error("SANDBOX_SCOPE_CHANGED");
    return { scopeRef: saved.ref, scopeDigest: bytesHash(plaintext) };
  };
  const prepared = async (plan: SandboxExecutionPlanCandidate) => {
    await resolve(plan);
    return {
      plan,
      observation: {
        schemaVersion: "sandbox-execution.v1" as const,
        identity: plan.identity,
        sequence: 1,
        state: "prepared" as const,
        policyDigest: null,
        occurredAt: plan.requestedAt,
        outcome: "pending" as const,
        cleanup: "pending" as const,
        effect: "not_started" as const,
        outputRef: null,
        outputDigest: null,
        reasonCode: null,
      },
    };
  };
  const currentHandle = async (input: ConsumeCapabilityInvocationInput) => {
    const handle = (await capabilities.getExecutionHandle(input.handleRef)) as
      | GovernedCapabilityExecutionHandle
      | undefined;
    if (
      !handle ||
      handle.handleVersion !== "capability-handle.v2" ||
      handle.ownerId !== configuration.ownerId ||
      handle.agentId !== configuration.agentId ||
      handle.runId !== input.requestScope.runId ||
      handle.operation !== input.operation ||
      !handle.inputRefs.includes(input.inputRef) ||
      handle.revokedAt !== null ||
      handle.workerEndedAt !== null
    )
      throw new Error("SANDBOX_HANDLE_UNAVAILABLE");
    return handle;
  };
  const appliesTo = (input: ConsumeCapabilityInvocationInput) =>
    sandboxEntries.some((entry) => entry.manifest.ref === input.capabilityRef);
  const scopes = {
    read: async (plan: SandboxExecutionPlanCandidate, parentRequestId: string | null) => {
      const result = await resolve(plan);
      if (result.scope.parentRequestId !== parentRequestId)
        throw new Error("SANDBOX_PARENT_CHANGED");
      return result.scope;
    },
  };
  const runtime: ProductionRuntimeSandbox = {
    journal,
    scopes,
    appliesTo,
    prepare: async (input, call, parentCall) => {
      const existing = await journal.readByInvocation({
        runId: input.requestScope.runId,
        invocationId: input.invocationId,
      });
      if (existing) {
        const { semanticFingerprint: _fingerprint, ...plan } = existing.plan;
        return prepared(plan);
      }
      const handle = await currentHandle(input);
      const file = await options.fileRead.binding(parentCall ?? call);
      if (
        !file ||
        file.capabilityRef !== input.capabilityRef ||
        file.capabilityVersion !== input.capabilityVersion ||
        !["inspect", "read"].includes(input.operation) ||
        !call.context ||
        !call.executionDeadlineAt
      )
        throw new Error("SANDBOX_SCOPE_SOURCE_UNAVAILABLE");
      const { binding, qualification } = await entryFor(
        input.capabilityRef,
        input.capabilityVersion,
      );
      const expiresAt = new Date(
        Math.min(
          Date.parse(handle.expiresAt),
          Date.parse(file.grant.expiresAt),
          Date.parse(input.deadlineAt),
        ),
      ).toISOString();
      const scope = sandboxScopeSchema.parse({
        schemaVersion: "sandbox-scope.v1",
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        threadId: call.context.threadId,
        runId: call.runId,
        toolCallId: call.toolCallId,
        parentToolCallId: parentCall?.toolCallId ?? null,
        parentRequestId: call.runId,
        hostId,
        handleRef: handle.ref,
        inputRef: input.inputRef,
        operation: input.operation,
        authorizationRef: handle.authorizationRef,
        modelRef: call.context.modelRef,
        profileRef: binding.profileRef,
        directoryGrant: {
          ref: file.grant.id,
          revision: file.grant.revision,
          canonicalRootId: file.grant.canonicalRootId,
          authorizationRef: file.grant.authorizationRef,
          operations: ["read"],
        },
        networkAuthorizationRef: null,
        expiresAt,
      });
      const scopeBinding = await persistScope(scope, input.invocationId);
      const plan = createSandboxExecutionPlanCandidate({
        admission: input,
        handle,
        invocation: call,
        request: {
          ownerId: configuration.ownerId,
          agentId: configuration.agentId,
          runId: call.runId,
          threadId: call.context.threadId,
          modelRef: call.context.modelRef,
          executionLease: call.context.executionLease,
          executionDeadlineAt: call.executionDeadlineAt,
        },
        jobId: `sandbox-job:${hash(input.invocationId)}`,
        attemptId: `sandbox-attempt:${hash(input.invocationId)}`,
        hostId,
        now: input.requestedAt,
        binding: {
          ...scopeBinding,
          profileRef: binding.profileRef,
          runtimeDigest: binding.runtimeDigest,
          runnerDigest: binding.runner.sha256,
          qualificationRef: qualification.qualificationRef,
          requiredGuarantees: qualification.guarantees,
        },
        digest: (canonical) => createHash("sha256").update(canonical).digest("hex"),
      });
      return prepared(plan);
    },
  };
  const child: NonNullable<WorkerDelegationAdmissionServiceOptions["sandbox"]> = {
    journal,
    scopes,
    appliesTo,
    prepare: async (input, request) => {
      if (!request.causationId) throw new Error("SANDBOX_PARENT_UNAVAILABLE");
      const parent = await journal.readByInvocation({
        runId: input.requestScope.runId,
        invocationId: request.causationId,
      });
      if (!parent || !["starting", "running"].includes(parent.observation.state))
        throw new Error("SANDBOX_PARENT_UNAVAILABLE");
      const inherited = await resolve(parent.plan);
      const handle = await currentHandle(input);
      const { binding, qualification } = await entryFor(
        input.capabilityRef,
        input.capabilityVersion,
      );
      if (
        binding.hostId !== parent.plan.identity.hostId ||
        Object.entries(input.resourceCeiling).some(
          ([key, value]) =>
            value > parent.plan.resourceCeiling[key as keyof typeof parent.plan.resourceCeiling],
        )
      )
        throw new Error("SANDBOX_CHILD_SCOPE_EXCEEDED");
      const expiresAt = new Date(
        Math.min(
          Date.parse(input.deadlineAt),
          Date.parse(handle.expiresAt),
          Date.parse(parent.plan.effectiveDeadlineAt),
        ),
      ).toISOString();
      const scope = sandboxScopeSchema.parse({
        ...inherited.scope,
        toolCallId: input.invocationId,
        parentToolCallId: parent.plan.identity.toolCallId,
        parentRequestId: request.causationId,
        handleRef: handle.ref,
        inputRef: input.inputRef,
        operation: input.operation,
        authorizationRef: handle.authorizationRef,
        networkAuthorizationRef:
          inherited.scope.networkAuthorizationRef === null ? null : handle.authorizationRef,
        profileRef: binding.profileRef,
        expiresAt,
      });
      const scopeBinding = await persistScope(scope, input.invocationId);
      const { semanticFingerprint: _fingerprint, ...parentCandidate } = parent.plan;
      const plan = sandboxExecutionPlanCandidateSchema.parse({
        ...parentCandidate,
        identity: {
          ...parent.plan.identity,
          jobId: `sandbox-job:${hash(input.invocationId)}`,
          attemptId: `sandbox-attempt:${hash(input.invocationId)}`,
          invocationId: input.invocationId,
          receiptRef: input.receiptRef,
          toolCallId: scope.toolCallId,
        },
        handleRef: handle.ref,
        inputRef: input.inputRef,
        operation: input.operation,
        capabilityRef: input.capabilityRef,
        capabilityVersion: input.capabilityVersion,
        authorizationRef: handle.authorizationRef,
        requestedAt: input.requestedAt,
        effectiveDeadlineAt: expiresAt,
        resourceCeiling: input.resourceCeiling,
        binding: {
          ...scopeBinding,
          profileRef: binding.profileRef,
          runtimeDigest: binding.runtimeDigest,
          runnerDigest: binding.runner.sha256,
          qualificationRef: qualification.qualificationRef,
          requiredGuarantees: qualification.guarantees,
        },
      });
      const resolved = await resolve(plan);
      if (resolved.allowedDomains.some((domain) => !inherited.allowedDomains.includes(domain)))
        throw new Error("SANDBOX_CHILD_SCOPE_EXCEEDED");
      return prepared(plan);
    },
  };
  return {
    runtime,
    child,
    broker: {
      hostId,
      journal,
      resolveScope: async (plan: SandboxExecutionPlan) => {
        const { scope, allowedDomains } = await resolve(plan);
        return { scope, allowedDomains };
      },
      verifyStart: async (plan: SandboxExecutionPlan) => {
        await resolve(plan);
      },
    },
  };
}
