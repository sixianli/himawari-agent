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
  resolveSandboxActionGrant,
  type SandboxExecutionEvidencePort,
  type SandboxExecutionPlan,
  SandboxExecutionReconciliationService,
  SandboxScopeService,
  type WorkerDelegationAdmissionServiceOptions,
} from "@himawari-agent/application";
import {
  assertSandboxExecutionSupport,
  type SandboxExecutionPlanCandidate,
  type SandboxExecutionPlanCandidateV2,
  type SandboxExecutionPlanV2,
  type SandboxExecutionSupport,
  type SandboxOperationBinding,
  type SandboxScope,
  sandboxExecutionPlanCandidateSchema,
  sandboxExecutionPlanCandidateV2Schema,
  sandboxExecutionReservationSchema,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  CapabilityDeploymentSnapshotLoader,
  resolveSandboxWorkspaceClaim,
  verifySandboxHost,
} from "@himawari-agent/platform-node";
import { configuredModelDisclosureIdentity } from "./production-file-read-services.js";
import type { ProductionFileReadServices } from "./production-file-read-workflow.js";
import type { ProductionRuntimeSandbox } from "./production-runtime-tools.js";
import { createProductionSandboxControl } from "./production-sandbox-control.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Composition only: existing grants, protected Run artifacts and the existing
 * job journal retain authority. Neither inventory nor this factory issues it. */
export async function createProductionSandboxServices(options: {
  readonly configuration: Pick<
    ProductConfiguration,
    "ownerId" | "agentId" | "capabilityDeployment" | "modelDescriptors"
  >;
  readonly repository: SqliteProductStateRepository;
  readonly protector: PayloadProtectorPort;
  readonly authority: () => CapabilityInvocationAuthority;
  readonly fileRead: ProductionFileReadServices;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly workerSupport?: () => SandboxExecutionSupport | undefined;
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
  const modelIdentity = (ref: string) => {
    const model = configuration.modelDescriptors.find(
      (model) => model.ref === ref && model.role !== "embedding",
    );
    if (!model) throw new Error("SANDBOX_MODEL_UNAVAILABLE");
    return configuredModelDisclosureIdentity(model);
  };
  const hostIds = new Set(
    sandboxEntries.map((entry) =>
      entry.binding.kind === "sandbox" ? entry.binding.value.hostId : "",
    ),
  );
  if (hostIds.size !== 1) throw new Error("SANDBOX_HOST_BINDING_AMBIGUOUS");
  const hostId = [...hostIds][0];
  if (!hostId) throw new Error("SANDBOX_HOST_BINDING_UNAVAILABLE");
  const journal = repository.sandboxJobJournal(configuration.ownerId, configuration.agentId);
  const preparations = repository.sandboxExecutionPreparations(
    configuration.ownerId,
    configuration.agentId,
  );
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
  const verifyParent = async (
    scope: SandboxScope,
    plan: SandboxExecutionPlanCandidate | SandboxExecutionPlanCandidateV2,
  ) => {
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
    const v2 = await preparations.readAdmissionByInvocation({
      runId: scope.runId,
      invocationId: scope.parentRequestId,
    });
    const legacy = v2
      ? undefined
      : await journal.readByInvocation({ runId: scope.runId, invocationId: scope.parentRequestId });
    const parentPlan = v2?.phase === "bound" ? v2.record.plan : legacy?.plan;
    const available = v2
      ? v2.phase === "bound" &&
        v2.record.facts.resource.supervision === "controlled" &&
        v2.record.facts.resource.evidence.validUntil > clock.now()
      : legacy && ["starting", "running"].includes(legacy.observation.state);
    if (
      !available ||
      !parentPlan ||
      parentPlan.identity.toolCallId !== scope.parentToolCallId ||
      parentPlan.modelRef !== plan.modelRef ||
      parentPlan.identity.threadId !== plan.identity.threadId ||
      hash(parentPlan.executionLease) !== hash(plan.executionLease) ||
      parentPlan.identity.hostId !== plan.identity.hostId
    )
      throw new Error("SANDBOX_PARENT_UNAVAILABLE");
    const live = await repository
      .capabilityInvocationReceiptPort(configuration.ownerId, configuration.agentId)
      .read({
        handleRef: parentPlan.handleRef,
        invocationId: parentPlan.identity.invocationId,
        authority: options.authority(),
        now: clock.now(),
      });
    if (!live) throw new Error("SANDBOX_PARENT_UNAVAILABLE");
  };
  const resolve = async (
    value:
      | SandboxExecutionPlanCandidate
      | SandboxExecutionPlan
      | SandboxExecutionPlanCandidateV2
      | SandboxExecutionPlanV2,
  ) => {
    const candidate =
      "semanticFingerprint" in value
        ? (({ semanticFingerprint: _fingerprint, ...rest }) => rest)(value)
        : value;
    const plan =
      candidate.schemaVersion === "sandbox-execution.v2"
        ? sandboxExecutionPlanCandidateV2Schema.parse(candidate)
        : sandboxExecutionPlanCandidateSchema.parse(candidate);
    const { binding, qualification } = await entryFor(plan.capabilityRef, plan.capabilityVersion);
    await verifySandboxHost({ binding, qualification, hostId, plan });
    if (plan.schemaVersion === "sandbox-execution.v2") {
      assertSandboxExecutionSupport({ schemaVersion: plan.schemaVersion, mode: plan.mode }, [
        options.workerSupport?.(),
        binding.supportedExecutions,
        qualification.supportedExecutions,
      ]);
      const descriptor = binding.operationBindings?.find(
        (item) => item.operation === plan.operation,
      );
      if (
        !descriptor ||
        descriptor.mode !== plan.mode ||
        descriptor.backendRef !== plan.backendRef ||
        hash(descriptor.contract) !== hash(plan.operationContract)
      )
        throw new Error("SANDBOX_OPERATION_BINDING_CHANGED");
    }
    const raw = sandboxScopeSchema.parse(await readJson(plan.binding.scopeRef));
    if (plan.schemaVersion === "sandbox-execution.v2") {
      const descriptor = binding.operationBindings?.find(
        (item) => item.operation === plan.operation,
      );
      if (
        !descriptor ||
        descriptor.directoryOperations.some((op) => !raw.directoryGrant.operations.includes(op)) ||
        raw.directoryGrant.operations.some((op) => !descriptor.directoryOperations.includes(op)) ||
        (descriptor.network === "disabled" && raw.networkAuthorizationRef !== null)
      )
        throw new Error("SANDBOX_OPERATION_SCOPE_CHANGED");
      if (descriptor.scopeSource === "grant_targets") {
        const { intent } = await resolveSandboxActionGrant({
          plan,
          authorizations: repository.authorizationStore(),
          now: () => clock.now(),
        });
        const directories = intent.targets.filter((item) => item.type === "directory-grant");
        if (
          directories.length !== 1 ||
          directories[0]?.ref !== raw.directoryGrant.ref ||
          !intent.targets.some((item) => item.type === "host" && item.ref === hostId) ||
          intent.disclosure !== "named_recipients" ||
          !intent.recipients.includes(modelIdentity(plan.modelRef))
        )
          throw new Error("SANDBOX_ACTION_SCOPE_CHANGED");
      }
    }
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
    const workspaceClaim = await resolveSandboxWorkspaceClaim({ binding, scope: resolved.scope });
    return { binding, qualification, workspaceClaim, ...resolved };
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
    read: async (
      plan: SandboxExecutionPlanCandidate | SandboxExecutionPlanCandidateV2,
      parentRequestId: string | null,
    ) => {
      const result = await resolve(plan);
      if (result.scope.parentRequestId !== parentRequestId)
        throw new Error("SANDBOX_PARENT_CHANGED");
      return result.scope;
    },
  };
  const replayReservation = async (input: ConsumeCapabilityInvocationInput) => {
    const existing = await preparations.readAdmissionByInvocation({
      runId: input.requestScope.runId,
      invocationId: input.invocationId,
    });
    if (existing) {
      // The reservation is immutable. A replay returns its original admission;
      // reserve will never project a second executable Worker request.
      const plan = existing.phase === "reserved" ? existing.plan : existing.record.plan;
      const { semanticFingerprint: _fingerprint, ...candidate } = plan;
      const workspaces =
        existing.phase === "reserved" ? existing.workspaces : existing.record.workspaces;
      const reservation = sandboxExecutionReservationSchema.parse({
        schemaVersion: "sandbox-preparation.v1",
        identity: plan.identity,
        environmentId: plan.environmentId,
        resourceRef:
          existing.phase === "reserved"
            ? existing.reservation.resourceRef
            : existing.record.facts.environment.resourceRef,
        mode: plan.mode,
        workspaceConflictRefs: workspaces.map((item) => item.ref),
        sequence: 1,
        createdAt: plan.requestedAt,
      });
      await resolve(candidate);
      return { plan: candidate, reservation, workspaces };
    }
    return undefined;
  };
  const prepareRuntimeV2 = async (
    input: ConsumeCapabilityInvocationInput,
    call: RuntimeToolInvocation,
    parentCall: RuntimeToolInvocation | undefined,
    descriptor: SandboxOperationBinding,
  ) => {
    const replay = await replayReservation(input);
    if (replay) return replay;
    const handle = await currentHandle(input);
    if (!call.context || !call.executionDeadlineAt)
      throw new Error("SANDBOX_SCOPE_SOURCE_UNAVAILABLE");
    const { binding, qualification } = await entryFor(input.capabilityRef, input.capabilityVersion);
    assertSandboxExecutionSupport(
      { schemaVersion: "sandbox-execution.v2", mode: descriptor.mode },
      [options.workerSupport?.(), binding.supportedExecutions, qualification.supportedExecutions],
    );
    let expiresAt = new Date(
      Math.min(
        Date.parse(handle.expiresAt),
        Date.parse(input.deadlineAt),
        Date.parse(call.executionDeadlineAt),
      ),
    ).toISOString();
    let grant: HostDirectoryGrant | undefined;
    if (descriptor.scopeSource === "file_workflow") {
      const file = await options.fileRead.binding(parentCall ?? call);
      if (
        !file ||
        file.capabilityRef !== input.capabilityRef ||
        file.capabilityVersion !== input.capabilityVersion ||
        !["inspect", "read"].includes(input.operation)
      )
        throw new Error("SANDBOX_SCOPE_SOURCE_UNAVAILABLE");
      grant = file.grant;
    } else {
      const { intent } = await resolveSandboxActionGrant({
        plan: {
          authorizationRef: handle.authorizationRef,
          capabilityRef: input.capabilityRef,
          capabilityVersion: input.capabilityVersion,
          operation: input.operation,
          effectiveDeadlineAt: expiresAt,
          identity: {
            ownerId: configuration.ownerId,
            agentId: configuration.agentId,
            runId: call.runId,
            threadId: call.context.threadId,
          },
        },
        authorizations: repository.authorizationStore(),
        now: () => clock.now(),
      });
      const targets = intent.targets.filter((item) => item.type === "directory-grant");
      if (
        targets.length !== 1 ||
        !targets[0] ||
        !intent.targets.some((item) => item.type === "host" && item.ref === hostId) ||
        intent.disclosure !== "named_recipients" ||
        !intent.recipients.includes(modelIdentity(call.context.modelRef))
      )
        throw new Error("SANDBOX_SCOPE_SOURCE_UNAVAILABLE");
      grant = (
        await repository.readScopedState(
          configuration.ownerId,
          configuration.agentId,
          hostDirectoryGrantStateKey(targets[0].ref),
        )
      )?.value as unknown as HostDirectoryGrant | undefined;
    }
    if (!grant) throw new Error("SANDBOX_DIRECTORY_GRANT_UNAVAILABLE");
    expiresAt = new Date(
      Math.min(Date.parse(expiresAt), Date.parse(grant.expiresAt)),
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
        ref: grant.id,
        revision: grant.revision,
        canonicalRootId: grant.canonicalRootId,
        authorizationRef: grant.authorizationRef,
        operations: descriptor.directoryOperations,
      },
      networkAuthorizationRef:
        descriptor.network === "grant_targets" ? handle.authorizationRef : null,
      expiresAt,
    });
    const scopeBinding = await persistScope(scope, input.invocationId);
    const base = createSandboxExecutionPlanCandidate({
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
    const plan = sandboxExecutionPlanCandidateV2Schema.parse({
      ...base,
      schemaVersion: "sandbox-execution.v2",
      effectiveDeadlineAt: expiresAt,
      mode: descriptor.mode,
      operationContract: descriptor.contract,
      backendRef: descriptor.backendRef,
      environmentId: `environment:${hash(input.invocationId)}`,
    });
    const resolved = await resolve(plan);
    const reservation = sandboxExecutionReservationSchema.parse({
      schemaVersion: "sandbox-preparation.v1",
      identity: plan.identity,
      environmentId: plan.environmentId,
      resourceRef: plan.mode === "foreground" ? null : ids.next("sandbox-resource"),
      mode: plan.mode,
      workspaceConflictRefs: [resolved.workspaceClaim.ref],
      sequence: 1,
      createdAt: plan.requestedAt,
    });
    return { plan, reservation, workspaces: [resolved.workspaceClaim] };
  };
  const runtime: ProductionRuntimeSandbox = {
    journal,
    preparations,
    scopes,
    appliesTo,
    prepare: async (input, call, parentCall) => {
      const selected = await entryFor(input.capabilityRef, input.capabilityVersion);
      if (selected.binding.operationBindings) {
        const descriptor = selected.binding.operationBindings.find(
          (item) => item.operation === input.operation,
        );
        if (!descriptor) throw new Error("SANDBOX_OPERATION_UNAVAILABLE");
        return prepareRuntimeV2(input, call, parentCall, descriptor);
      }
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
    preparations,
    scopes,
    appliesTo,
    prepare: async (input, request) => {
      const childEntry = await entryFor(input.capabilityRef, input.capabilityVersion);
      if (childEntry.binding.operationBindings) {
        const replay = await replayReservation(input);
        if (replay) return replay;
        if (!request.causationId) throw new Error("SANDBOX_PARENT_UNAVAILABLE");
        const parent = await preparations.readAdmissionByInvocation({
          runId: input.requestScope.runId,
          invocationId: request.causationId,
        });
        const descriptor = childEntry.binding.operationBindings.find(
          (item) => item.operation === input.operation,
        );
        if (
          !descriptor ||
          parent?.phase !== "bound" ||
          parent.record.facts.resource.supervision !== "controlled" ||
          parent.record.facts.resource.evidence.validUntil <= clock.now()
        )
          throw new Error("SANDBOX_PARENT_UNAVAILABLE");
        const prior = parent.record.plan;
        const inherited = await resolve(prior);
        const handle = await currentHandle(input);
        const { binding, qualification } = childEntry;
        assertSandboxExecutionSupport(
          { schemaVersion: "sandbox-execution.v2", mode: descriptor.mode },
          [
            options.workerSupport?.(),
            binding.supportedExecutions,
            qualification.supportedExecutions,
          ],
        );
        if (
          binding.hostId !== prior.identity.hostId ||
          binding.profileRef !== prior.binding.profileRef ||
          descriptor.directoryOperations.some(
            (op) => !inherited.scope.directoryGrant.operations.includes(op),
          ) ||
          Object.entries(input.resourceCeiling).some(
            ([key, value]) =>
              value > prior.resourceCeiling[key as keyof typeof prior.resourceCeiling],
          )
        )
          throw new Error("SANDBOX_CHILD_SCOPE_EXCEEDED");
        const expiresAt = new Date(
          Math.min(
            Date.parse(input.deadlineAt),
            Date.parse(handle.expiresAt),
            Date.parse(prior.effectiveDeadlineAt),
          ),
        ).toISOString();
        const scope = sandboxScopeSchema.parse({
          ...inherited.scope,
          toolCallId: input.invocationId,
          parentToolCallId: prior.identity.toolCallId,
          parentRequestId: request.causationId,
          handleRef: handle.ref,
          inputRef: input.inputRef,
          operation: input.operation,
          authorizationRef: handle.authorizationRef,
          networkAuthorizationRef:
            descriptor.network === "grant_targets" ? handle.authorizationRef : null,
          directoryGrant: {
            ...inherited.scope.directoryGrant,
            operations: descriptor.directoryOperations,
          },
          expiresAt,
        });
        const scopeBinding = await persistScope(scope, input.invocationId);
        const { semanticFingerprint: _fingerprint, ...candidate } = prior;
        const plan = sandboxExecutionPlanCandidateV2Schema.parse({
          ...candidate,
          identity: {
            ...prior.identity,
            jobId: `sandbox-job:${hash(input.invocationId)}`,
            attemptId: `sandbox-attempt:${hash(input.invocationId)}`,
            invocationId: input.invocationId,
            receiptRef: input.receiptRef,
            toolCallId: scope.toolCallId,
          },
          environmentId: `environment:${hash(input.invocationId)}`,
          mode: descriptor.mode,
          operationContract: descriptor.contract,
          backendRef: descriptor.backendRef,
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
        const reservation = sandboxExecutionReservationSchema.parse({
          schemaVersion: "sandbox-preparation.v1",
          identity: plan.identity,
          environmentId: plan.environmentId,
          resourceRef: plan.mode === "foreground" ? null : ids.next("sandbox-resource"),
          mode: plan.mode,
          workspaceConflictRefs: [resolved.workspaceClaim.ref],
          sequence: 1,
          createdAt: plan.requestedAt,
        });
        return { plan, reservation, workspaces: [resolved.workspaceClaim] };
      }
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
  const control = createProductionSandboxControl({
    now: () => clock.now(),
    host: async (plan) => {
      const entry = await entryFor(plan.capabilityRef, plan.capabilityVersion);
      await verifySandboxHost({ ...entry, hostId, plan });
      return entry;
    },
    read: async (plan, key) => {
      const saved = await artifacts().lookup({
        runId: plan.identity.runId as RuntimeToolInvocation["runId"],
        purpose: "trace",
        operationKey: key,
      });
      if (!saved) return undefined;
      const payload = await payloads.get(saved.payloadRef);
      if (!payload || payload.dataClassification !== "restricted")
        throw new Error("SANDBOX_CONTROL_ARTIFACT_INVALID");
      const value = await readJson(saved.payloadRef);
      return { ref: saved.payloadRef, digest: hash(value), value };
    },
    write: async (plan, key, value) => {
      const plaintext = new TextEncoder().encode(JSON.stringify(value));
      if (plaintext.byteLength > 65536) throw new Error("SANDBOX_CONTROL_ARTIFACT_TOO_LARGE");
      const payload = await protector.protect({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        ref: ids.next("sandbox-control"),
        dataClassification: "restricted",
        contentType: "application/json",
        plaintext,
        createdAt: clock.now(),
      });
      const saved = await artifacts().commit({
        runId: plan.identity.runId as RuntimeToolInvocation["runId"],
        purpose: "trace",
        operationKey: key,
        payload,
      });
      if (hash(await readJson(saved.ref)) !== bytesHash(plaintext))
        throw new Error("SANDBOX_CONTROL_ARTIFACT_CHANGED");
      return { ref: saved.ref, digest: bytesHash(plaintext) };
    },
  });
  const evidence: SandboxExecutionEvidencePort = {
    verify: async ({ plan, facts, now }) => {
      const outputs: { ref: string; digest: string; byteLength: number }[] = [];
      if (facts.result && facts.result.kind !== "unknown") {
        // A retained result is already bound by the journal to its immutable
        // invocation artifact. Reconciliation under a new boot may authenticate
        // these same bytes without adopting the old Worker's execution authority.
        const previous = await repository
          .sandboxExecutionJournal(configuration.ownerId, configuration.agentId)
          .read(plan.identity);
        const retained =
          previous &&
          previous.plan.semanticFingerprint === plan.semanticFingerprint &&
          JSON.stringify(previous.facts.result) === JSON.stringify(facts.result);
        if (!retained) {
          const artifact = await repository
            .capabilityInvocationResultPort(configuration.ownerId, configuration.agentId)
            .lookupOutput({
              handleRef: plan.handleRef,
              invocationId: plan.identity.invocationId,
              authority: options.authority(),
              now,
            });
          if (!artifact || artifact.payloadRef !== facts.result.output.ref)
            throw new Error("SANDBOX_OUTPUT_BINDING_CHANGED");
        }
        const payload = await payloads.get(facts.result.output.ref);
        if (
          !payload ||
          payload.ciphertext.byteLength > plan.resourceCeiling.maxOutputBytes + 131072
        )
          throw new Error("SANDBOX_OUTPUT_UNAVAILABLE");
        const bytes = await protector.unprotect({
          ownerId: configuration.ownerId,
          agentId: configuration.agentId,
          payload,
        });
        if (
          bytes.byteLength > plan.resourceCeiling.maxOutputBytes ||
          bytes.byteLength !== facts.result.output.byteLength ||
          bytesHash(bytes) !== facts.result.output.digest
        )
          throw new Error("SANDBOX_OUTPUT_CHANGED");
        outputs.push({ ...facts.result.output });
      }
      // Authenticate retained output and independently stored supervisor facts.
      return {
        facts,
        identity: plan.identity,
        environmentId: plan.environmentId,
        policyDigest: facts.environment.policyDigest,
        resourceSequence: facts.resource.sequence,
        checkedAt: now,
        validUntil: new Date(Date.parse(now) + 1000).toISOString(),
        outputs,
        evidence: await control.evidence(plan, facts),
      };
    },
  };
  return {
    runtime,
    child,
    brokerV2: {
      evidence,
      registerControl: control.register,
      observeControl: control.observe,
      verifyPreparation: control.verifyPreparation,
      reconciliation: new SandboxExecutionReconciliationService({
        hostId,
        journal: repository.sandboxExecutionJournal(configuration.ownerId, configuration.agentId),
        evidence,
        backend: control.backend,
        timeoutMs: 5000,
        now: () => clock.now(),
      }),
      hostId,
      journal: repository.sandboxExecutionJournal(configuration.ownerId, configuration.agentId),
      preparations,
      resolveScope: async (plan: SandboxExecutionPlanV2) => {
        const { scope, allowedDomains } = await resolve(plan);
        return { scope, allowedDomains };
      },
      verifyStart: async (plan: SandboxExecutionPlanV2) => {
        await resolve(plan);
      },
    },
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
