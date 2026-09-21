import { createHash } from "node:crypto";
import path from "node:path";
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
  type RuntimeRequest,
  type RuntimeToolInvocation,
  resolveSandboxActionGrant,
  type SandboxExecutionEvidencePort,
  type SandboxExecutionPlan,
  SandboxExecutionReconciliationService,
  SandboxResourceRecoveryService,
  SandboxScopeService,
  scanMachineSecrets,
  type WorkerDelegationAdmissionServiceOptions,
} from "@himawari-agent/application";
import { canonicalAuthorizationSnapshot } from "@himawari-agent/application/action-intent-snapshot";
import {
  assertSandboxExecutionSupport,
  executionV2MessageSchema,
  PI_COPY_SAVE_CONTRACT,
  PI_DIRECTORY_MOVE_CONTRACT,
  PI_FIXED_FILE_CONTRACT,
  PI_PREPARED_FILE_CONTRACT,
  piFileRecoveryOperationKey,
  type SandboxExecutionPlanCandidate,
  type SandboxExecutionPlanCandidateV2,
  type SandboxExecutionPlanV2,
  type SandboxExecutionScope,
  type SandboxExecutionSupport,
  type SandboxHostBinding,
  type SandboxOperationBinding,
  type SandboxScope,
  type SandboxWorkspaceCopy,
  sandboxExecutionPlanCandidateSchema,
  sandboxExecutionPlanCandidateV2Schema,
  sandboxExecutionReservationSchema,
  sandboxExecutionScopeSchema,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  CapabilityDeploymentSnapshotLoader,
  createDirectoryMoveJournal,
  createPiFilePublicationJournal,
  resolveSandboxDirectoryMoveScope,
  resolveSandboxFileScope,
  resolveSandboxWorkspaceClaim,
  revalidateCapabilityDeploymentSnapshot,
  verifyPiWriteEvidence,
  verifySandboxHost,
} from "@himawari-agent/platform-node";
import {
  importProductionCopySave,
  prepareProductionCopySave,
  resolveProductionCopySaveClaims,
} from "./production-copy-save.js";
import { prepareProductionFile } from "./production-file-preparation.js";
import type { ProductionFileReadServices } from "./production-file-read-workflow.js";
import { createProductionManagedTasks } from "./production-managed-tasks.js";
import { configuredModelDisclosureIdentity } from "./production-model-disclosure.js";
import type { ProductionRuntimeSandbox } from "./production-runtime-tools.js";
import { createProductionSandboxControl } from "./production-sandbox-control.js";
import { createProductionSandboxFileRecovery } from "./production-sandbox-file-recovery.js";
import { createProductionSandboxOutput } from "./production-sandbox-output.js";
import { createProductionSandboxStream } from "./production-sandbox-stream.js";
import { createProductionSandboxToolResult } from "./production-sandbox-tool-result.js";

// Job directory names encode the full digest compactly: SRT appends Unix socket
// names below them. External reconciliation IDs retain their separate contract.
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobId = (value: unknown) => `j${Buffer.from(hash(value), "hex").toString("base64url")}`;
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
  // Complete the first installation audit in this Agent process before readiness.
  // Worker verification uses a separate process and cannot warm this cache.
  // Per-invocation plan, authority and host checks remain in resolve below.
  for (const entry of sandboxEntries) {
    if (entry.binding.kind !== "sandbox" || !entry.qualification.sandbox)
      throw new Error("SANDBOX_HOST_BINDING_UNAVAILABLE");
    await verifySandboxHost({
      binding: entry.binding.value,
      qualification: entry.qualification.sandbox,
      hostId,
    });
  }
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
    const loaded = await revalidateCapabilityDeploymentSnapshot(initial);
    const entry = loaded.snapshot.capabilities.find(
      (entry) =>
        entry.manifest.ref === capabilityRef && entry.manifest.version === capabilityVersion,
    );
    if (!entry || entry.binding.kind !== "sandbox" || !entry.qualification.sandbox)
      throw new Error("SANDBOX_HOST_BINDING_UNAVAILABLE");
    return { binding: entry.binding.value, qualification: entry.qualification.sandbox };
  };
  const verifyParent = async (
    scope: SandboxExecutionScope,
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
    const timed = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await action();
      } finally {
        console.error(
          JSON.stringify({
            event: "sandbox.admission.timing",
            runId: plan.identity.runId,
            stage,
            durationMs: performance.now() - started,
            at: new Date().toISOString(),
          }),
        );
      }
    };
    const { binding, qualification } = await timed("deployment_snapshot", () =>
      entryFor(plan.capabilityRef, plan.capabilityVersion),
    );
    await timed("host_verification", () =>
      verifySandboxHost({ binding, qualification, hostId, plan }),
    );
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
    const raw = sandboxExecutionScopeSchema.parse(
      await timed("scope_payload", () => readJson(plan.binding.scopeRef)),
    );
    if (plan.schemaVersion === "sandbox-execution.v2") {
      const descriptor = binding.operationBindings?.find(
        (item) => item.operation === plan.operation,
      );
      if (
        !descriptor ||
        (descriptor.scopeSource === "private_temp"
          ? raw.directoryGrant !== null
          : raw.directoryGrant === null ||
            descriptor.directoryOperations.some(
              (op) =>
                !(
                  raw.schemaVersion === "sandbox-scope.v1" &&
                  (raw.workspaceCopy || raw.copySave)
                ) && !raw.directoryGrant?.operations.includes(op),
            ) ||
            raw.directoryGrant.operations.some(
              (op) => !descriptor.directoryOperations.includes(op),
            )) ||
        (descriptor.network === "disabled" && raw.networkAuthorizationRef !== null)
      )
        throw new Error("SANDBOX_OPERATION_SCOPE_CHANGED");
      if (
        raw.schemaVersion === "sandbox-scope.v1" &&
        raw.workspaceCopy &&
        (plan.operation !== "bash" ||
          plan.mode !== "foreground" ||
          plan.operationContract.kind !== "command" ||
          descriptor.scopeSource !== "grant_targets")
      )
        throw new Error("SANDBOX_COPY_CONTRACT_CHANGED");
      if (descriptor.scopeSource === "grant_targets" || descriptor.scopeSource === "private_temp") {
        const { intent } = await resolveSandboxActionGrant({
          plan,
          authorizations: repository.authorizationStore(),
          now: () => clock.now(),
        });
        const directories = intent.targets.filter((item) => item.type === "directory-grant");
        const copies = intent.targets.filter((item) => item.type === "workspace-copy");
        const copy = raw.schemaVersion === "sandbox-scope.v1" ? raw.workspaceCopy : undefined;
        if (
          copy
            ? copies.length !== 1 || copies[0]?.ref !== copy.canonicalRootId
            : copies.length !== 0
        )
          throw new Error("SANDBOX_COPY_AUTHORIZATION_CHANGED");
        if (
          (descriptor.scopeSource === "private_temp"
            ? intent.targets.some((item) =>
                ["directory-grant", "directory-path", "file-path"].includes(item.type),
              )
            : directories.length !== 1 || directories[0]?.ref !== raw.directoryGrant?.ref) ||
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
    const resolved = await timed("scope_authorization", () =>
      reader.resolve(plan, raw.parentRequestId),
    );
    const directoryScope = resolved.scope;
    if (directoryScope.directoryGrant === null)
      return { binding, qualification, workspaceClaims: [], ...resolved };
    if (
      !binding.roots.some(
        (root) => root.canonicalRootId === directoryScope.directoryGrant.canonicalRootId,
      )
    )
      throw new Error("SANDBOX_ROOT_UNAVAILABLE");
    let workspaceClaim = await timed("workspace_identity", () =>
      resolveSandboxWorkspaceClaim({ binding, scope: directoryScope }),
    );
    const fixed =
      plan.schemaVersion === "sandbox-execution.v2" && fixedFileContract(plan.operationContract);
    const staged =
      plan.schemaVersion === "sandbox-execution.v2" &&
      plan.operationContract.ref === PI_PREPARED_FILE_CONTRACT.ref &&
      plan.operationContract.version === PI_PREPARED_FILE_CONTRACT.version;
    if (
      Boolean(resolved.scope.preparedFile) !== staged ||
      (staged && !["write", "edit"].includes(plan.operation))
    )
      throw new Error("SANDBOX_PREPARED_FILE_CONTRACT_CHANGED");
    if (Boolean(resolved.scope.fileTarget) !== fixed)
      throw new Error("SANDBOX_FILE_CONTRACT_CHANGED");
    if (fixed && plan.schemaVersion === "sandbox-execution.v2") {
      const admission = await preparations.readAdmission(plan.identity);
      if (admission?.phase === "bound") {
        const retained = admission.record.workspaces[0];
        if (
          !retained ||
          (!retained.file && !resolved.scope.fileTarget?.missingParents) ||
          admission.record.workspaces.length !== 1
        )
          throw new Error("SANDBOX_FILE_CLAIM_CHANGED");
        workspaceClaim = retained;
      } else {
        const current = await fileTarget(directoryScope, binding);
        if (hash(current.target) !== hash(resolved.scope.fileTarget))
          throw new Error("SANDBOX_FILE_VERSION_CHANGED");
        workspaceClaim = current.claim;
      }
    }
    let workspaceClaims = [workspaceClaim];
    const moving =
      plan.schemaVersion === "sandbox-execution.v2" &&
      plan.operationContract.ref === PI_DIRECTORY_MOVE_CONTRACT.ref &&
      plan.operationContract.version === PI_DIRECTORY_MOVE_CONTRACT.version;
    if (Boolean(directoryScope.directoryMove) !== moving)
      throw new Error("SANDBOX_DIRECTORY_MOVE_CONTRACT_CHANGED");
    if (moving && plan.schemaVersion === "sandbox-execution.v2") {
      if (plan.operation !== "move_directory")
        throw new Error("SANDBOX_DIRECTORY_MOVE_CONTRACT_CHANGED");
      const admission = await preparations.readAdmission(plan.identity);
      if (admission?.phase === "bound") {
        workspaceClaims = [...admission.record.workspaces];
        if (workspaceClaims.length !== 3) throw new Error("SANDBOX_DIRECTORY_MOVE_CLAIMS_CHANGED");
      } else {
        const current = await directoryMoveTarget(directoryScope, binding).catch(
          (error: NodeJS.ErrnoException) => {
            if (
              error.code === "ENOENT" ||
              ["HOST_FILE_TARGET_EXISTS", "SANDBOX_HOST_PATH_CHANGED"].includes(error.message)
            )
              throw new Error("SANDBOX_DIRECTORY_MOVE_TARGET_CHANGED");
            throw error;
          },
        );
        if (hash(current.target) !== hash(directoryScope.directoryMove))
          throw new Error("SANDBOX_DIRECTORY_MOVE_TARGET_CHANGED");
        workspaceClaims = [...current.claims];
      }
    }
    const saving =
      plan.schemaVersion === "sandbox-execution.v2" &&
      plan.operationContract.ref === PI_COPY_SAVE_CONTRACT.ref &&
      plan.operationContract.version === PI_COPY_SAVE_CONTRACT.version;
    if (Boolean(directoryScope.copySave) !== saving) throw new Error("COPY_SAVE_CONTRACT_CHANGED");
    if (saving && plan.schemaVersion === "sandbox-execution.v2") {
      const admission = await preparations.readAdmission(plan.identity);
      workspaceClaims =
        admission?.phase === "bound"
          ? [...admission.record.workspaces]
          : await resolveProductionCopySaveClaims({ scope: directoryScope, binding });
      if (!workspaceClaims.length) throw new Error("COPY_SAVE_CLAIMS_REQUIRED");
    }
    return { binding, qualification, workspaceClaims, ...resolved };
  };
  const fixedFileContract = (contract: { readonly ref: string; readonly version: string }) =>
    contract.ref === PI_FIXED_FILE_CONTRACT.ref &&
    [PI_FIXED_FILE_CONTRACT.version, PI_PREPARED_FILE_CONTRACT.version].some(
      (version) => version === contract.version,
    );
  const fileTarget = async (scope: SandboxScope, binding: SandboxHostBinding) => {
    if (!["read", "write", "edit"].includes(scope.operation))
      throw new Error("SANDBOX_FILE_CONTRACT_UNSUPPORTED");
    const root = binding.roots.find(
      (item) => item.canonicalRootId === scope.directoryGrant.canonicalRootId,
    );
    const parameters = (await readJson(scope.inputRef)) as { path?: unknown };
    if (!root || !parameters || typeof parameters.path !== "string")
      throw new Error("SANDBOX_FILE_TARGET_INVALID");
    const relativePath = path.relative(
      root.canonicalPath,
      path.resolve(root.canonicalPath, parameters.path),
    );
    return resolveSandboxFileScope({
      binding,
      scope,
      relativePath,
      access: scope.operation === "read" ? "read" : "write",
    });
  };
  const directoryMoveTarget = async (scope: SandboxScope, binding: SandboxHostBinding) => {
    const parameters = (await readJson(scope.inputRef)) as {
      path?: unknown;
      destination?: unknown;
    };
    const root = binding.roots.find(
      (item) => item.canonicalRootId === scope.directoryGrant.canonicalRootId,
    );
    if (
      !root ||
      typeof parameters?.path !== "string" ||
      typeof parameters.destination !== "string" ||
      Object.keys(parameters).some((key) => !["path", "destination"].includes(key))
    )
      throw new Error("SANDBOX_DIRECTORY_MOVE_INPUT_INVALID");
    return resolveSandboxDirectoryMoveScope({
      binding,
      scope,
      sourceRelativePath: path.relative(
        root.canonicalPath,
        path.resolve(root.canonicalPath, parameters.path),
      ),
      destinationRelativePath: path.relative(
        root.canonicalPath,
        path.resolve(root.canonicalPath, parameters.destination),
      ),
    });
  };
  const freezeFileScope = async (
    scope: SandboxScope,
    binding: SandboxHostBinding,
    contract: { readonly ref: string; readonly version: string },
  ) => {
    const { fileTarget: _parentTarget, directoryMove: _parentMove, ...plain } = scope;
    if (
      contract.ref === PI_DIRECTORY_MOVE_CONTRACT.ref &&
      contract.version === PI_DIRECTORY_MOVE_CONTRACT.version
    )
      return sandboxScopeSchema.parse({
        ...plain,
        directoryMove: (await directoryMoveTarget(plain, binding)).target,
      });
    return fixedFileContract(contract)
      ? sandboxScopeSchema.parse({
          ...plain,
          fileTarget: (await fileTarget(plain, binding)).target,
        })
      : sandboxScopeSchema.parse(plain);
  };
  const persistScope = async (scope: SandboxExecutionScope, invocationId: string) => {
    const plaintext = new TextEncoder().encode(
      JSON.stringify(sandboxExecutionScopeSchema.parse(scope)),
    );
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
    const actual = sandboxExecutionScopeSchema.parse(await readJson(saved.ref));
    if (hash(actual) !== hash(sandboxExecutionScopeSchema.parse(scope)))
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
    const queued = await preparations.readQueuedByInvocation({
      runId: input.requestScope.runId,
      invocationId: input.invocationId,
    });
    if (queued) {
      const { consumedAt: _now, ...invocation } = input;
      if (
        queued.status !== "queued" ||
        canonicalAuthorizationSnapshot({
          ...invocation,
          receiptRef: queued.invocation.receiptRef,
        }) !== canonicalAuthorizationSnapshot(queued.invocation)
      )
        throw new Error("SANDBOX_QUEUED_REQUEST_CHANGED");
      // Reuse the approved target baseline and original deadline. Reconstructing
      // them from the current file would silently authorize a changed object.
      await resolve(queued.plan);
      return {
        ...(queued.recovery ? { recovery: queued.recovery } : {}),
        plan: queued.plan,
        reservation: queued.reservation,
        workspaces: queued.workspaces,
      };
    }
    return undefined;
  };
  const prepareRuntimeV2 = async (
    input: ConsumeCapabilityInvocationInput,
    call: RuntimeToolInvocation,
    parentCall: RuntimeToolInvocation | undefined,
    descriptor: SandboxOperationBinding,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const replay = await replayReservation(input);
    if (replay) return replay;
    const handle = await currentHandle(input);
    if (input.authorizationRef !== null && input.authorizationRef !== handle.authorizationRef)
      throw new Error("SANDBOX_EXECUTION_HANDLE_MISMATCH");
    if (
      canonicalAuthorizationSnapshot(input.authority) !==
      canonicalAuthorizationSnapshot(options.authority())
    )
      throw new Error("SANDBOX_PREPARATION_AUTHORITY_CHANGED");
    await preparations.validatePreparation({ ...input, consumedAt: clock.now() });
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
    let workspaceCopy: SandboxWorkspaceCopy | undefined;
    if (descriptor.scopeSource === "file_workflow") {
      const file = await options.fileRead.binding(parentCall ?? call);
      if (
        !file ||
        !file.grant ||
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
      const copyTargets = intent.targets.filter((item) => item.type === "workspace-copy");
      if (copyTargets.length) {
        const file = await options.fileRead.binding(parentCall ?? call);
        if (
          descriptor.scopeSource !== "grant_targets" ||
          input.operation !== "bash" ||
          descriptor.mode !== "foreground" ||
          descriptor.contract.kind !== "command" ||
          !file?.grant ||
          !file.workspaceCopy ||
          copyTargets.length !== 1 ||
          copyTargets[0]?.ref !== file.workspaceCopy.canonicalRootId ||
          targets.length !== 1 ||
          targets[0]?.ref !== file.grant.id
        )
          throw new Error("SANDBOX_COPY_BINDING_CHANGED");
        workspaceCopy = file.workspaceCopy;
      }
      if (
        (descriptor.scopeSource === "private_temp"
          ? intent.targets.some((item) =>
              ["directory-grant", "directory-path", "file-path"].includes(item.type),
            )
          : targets.length !== 1 || !targets[0]) ||
        !intent.targets.some((item) => item.type === "host" && item.ref === hostId) ||
        intent.disclosure !== "named_recipients" ||
        !intent.recipients.includes(modelIdentity(call.context.modelRef))
      )
        throw new Error("SANDBOX_SCOPE_SOURCE_UNAVAILABLE");
      if (descriptor.scopeSource !== "private_temp" && targets[0])
        grant = (
          await repository.readScopedState(
            configuration.ownerId,
            configuration.agentId,
            hostDirectoryGrantStateKey(targets[0].ref),
          )
        )?.value as unknown as HostDirectoryGrant | undefined;
    }
    if (!grant && descriptor.scopeSource !== "private_temp")
      throw new Error("SANDBOX_DIRECTORY_GRANT_UNAVAILABLE");
    if (grant)
      expiresAt = new Date(
        Math.min(Date.parse(expiresAt), Date.parse(grant.expiresAt)),
      ).toISOString();
    let copyOperation: import("@himawari-agent/application").PreparedFileOperation | undefined;
    if (input.operation === "save_copy") {
      if (
        !grant ||
        descriptor.contract.ref !== PI_COPY_SAVE_CONTRACT.ref ||
        descriptor.contract.version !== PI_COPY_SAVE_CONTRACT.version ||
        descriptor.mode !== "foreground"
      )
        throw new Error("COPY_SAVE_CONTRACT_CHANGED");
      const parameters = (await readJson(input.inputRef)) as {
        operationId?: unknown;
        expectedHash?: unknown;
      };
      if (typeof parameters.operationId !== "string") throw new Error("COPY_SAVE_INPUT_INVALID");
      copyOperation = (
        await repository.readScopedState(
          configuration.ownerId,
          configuration.agentId,
          `host-workspace:file-operation:${parameters.operationId}`,
        )
      )?.value as unknown as typeof copyOperation;
      if (
        !copyOperation ||
        copyOperation.canonicalHash !== parameters.expectedHash ||
        copyOperation.grantId !== grant.id ||
        !["create", "update", "move", "trash"].includes(copyOperation.operation) ||
        !descriptor.directoryOperations.includes(copyOperation.operation)
      )
        throw new Error("COPY_SAVE_OPERATION_UNAVAILABLE");
    }
    const scope = sandboxExecutionScopeSchema.parse({
      schemaVersion: grant ? "sandbox-scope.v1" : "sandbox-scope.v2",
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
      directoryGrant: grant
        ? {
            ref: grant.id,
            revision: grant.revision,
            canonicalRootId: grant.canonicalRootId,
            authorizationRef: grant.authorizationRef,
            operations: workspaceCopy
              ? ["read"]
              : copyOperation
                ? ["read", copyOperation.operation]
                : descriptor.directoryOperations,
          }
        : null,
      ...(workspaceCopy ? { workspaceCopy } : {}),
      networkAuthorizationRef:
        descriptor.network === "grant_targets" ? handle.authorizationRef : null,
      expiresAt,
    });
    if (
      grant &&
      (grant.revokedAt !== null ||
        grant.expiresAt <= clock.now() ||
        grant.hostId !== hostId ||
        grant.pathPolicy !== "same_filesystem_no_links" ||
        grant.mountPolicy !== "fixed_device" ||
        (workspaceCopy
          ? !grant.operations.includes("read")
          : (copyOperation
              ? ["read", copyOperation.operation]
              : descriptor.directoryOperations
            ).some((operation) => !grant.operations.some((allowed) => allowed === operation))))
    )
      throw new Error("SANDBOX_DIRECTORY_GRANT_UNAVAILABLE");
    const retainedScope = await artifacts().lookup({
      runId: scope.runId as RuntimeToolInvocation["runId"],
      purpose: "trace",
      operationKey: `sandbox-scope:${input.invocationId}`,
    });
    let frozenScope: SandboxExecutionScope;
    if (retainedScope) {
      frozenScope = sandboxExecutionScopeSchema.parse(await readJson(retainedScope.payloadRef));
      const {
        fileTarget: _target,
        preparedFile: _prepared,
        directoryMove: _move,
        copySave: _copySave,
        ...baseScope
      } = frozenScope;
      if (hash(baseScope) !== hash(scope)) throw new Error("SANDBOX_SCOPE_CHANGED");
    } else {
      frozenScope =
        scope.schemaVersion === "sandbox-scope.v1"
          ? await freezeFileScope(scope, binding, descriptor.contract)
          : scope;
      if (copyOperation && grant && frozenScope.schemaVersion === "sandbox-scope.v1") {
        frozenScope = await prepareProductionCopySave({
          scope: frozenScope,
          binding,
          grant,
          now: clock.now(),
          parameters: (await readJson(input.inputRef)) as Record<string, unknown>,
          readPrepared: async (id) =>
            (
              await repository.readScopedState(
                configuration.ownerId,
                configuration.agentId,
                `host-workspace:file-operation:${id}`,
              )
            )?.value as unknown as
              | import("@himawari-agent/application").PreparedFileOperation
              | undefined,
          readBytes: async (ref) => {
            const payload = await payloads.get(ref);
            if (!payload) throw new Error("COPY_SAVE_PAYLOAD_MISSING");
            return protector.unprotect({
              ownerId: configuration.ownerId,
              agentId: configuration.agentId,
              payload,
            });
          },
        });
      }
      if (
        descriptor.contract.ref === PI_PREPARED_FILE_CONTRACT.ref &&
        descriptor.contract.version === PI_PREPARED_FILE_CONTRACT.version
      ) {
        if (
          frozenScope.schemaVersion !== "sandbox-scope.v1" ||
          !frozenScope.fileTarget ||
          !grant ||
          (input.operation !== "write" && input.operation !== "edit")
        )
          throw new Error("SANDBOX_PREPARED_FILE_CONTRACT_CHANGED");
        frozenScope = sandboxScopeSchema.parse({
          ...frozenScope,
          preparedFile: await prepareProductionFile({
            ...(signal ? { signal } : {}),
            grant,
            target: frozenScope.fileTarget,
            tool: input.operation,
            toolCallId: scope.toolCallId,
            parameters: (await readJson(input.inputRef)) as Record<string, unknown>,
            resourceCeiling: {
              ...input.resourceCeiling,
              maxWallTimeMs: Math.min(
                input.resourceCeiling.maxWallTimeMs,
                Date.parse(expiresAt) - Date.parse(clock.now()),
              ),
            },
          }),
        });
      }
    }
    const scopeBinding = await persistScope(frozenScope, input.invocationId);
    signal?.throwIfAborted();
    if (
      canonicalAuthorizationSnapshot(input.authority) !==
      canonicalAuthorizationSnapshot(options.authority())
    )
      throw new Error("SANDBOX_PREPARATION_AUTHORITY_CHANGED");
    await preparations.validatePreparation({ ...input, consumedAt: clock.now() });
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
      jobId: jobId(input.invocationId),
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
      workspaceConflictRefs: resolved.workspaceClaims.map((claim) => claim.ref),
      sequence: 1,
      createdAt: plan.requestedAt,
    });
    const recoveryCall = parentCall ?? call;
    return {
      ...(recoveryCall.context?.continuationRef
        ? {
            recovery: {
              version: "queued-tool-batch.v1" as const,
              continuationRef: recoveryCall.context.continuationRef,
              toolCallId: recoveryCall.toolCallId,
              authority: input.authority.product,
            },
          }
        : {}),
      plan,
      reservation,
      workspaces: resolved.workspaceClaims,
    };
  };
  const runtime: ProductionRuntimeSandbox = {
    journal,
    preparations,
    scopes,
    appliesTo,
    prepare: async (input, call, parentCall, signal) => {
      signal?.throwIfAborted();
      const selected = await entryFor(input.capabilityRef, input.capabilityVersion);
      if (selected.binding.operationBindings) {
        const descriptor = selected.binding.operationBindings.find(
          (item) => item.operation === input.operation,
        );
        if (!descriptor) throw new Error("SANDBOX_OPERATION_UNAVAILABLE");
        return prepareRuntimeV2(input, call, parentCall, descriptor, signal);
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
        !file.grant ||
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
        jobId: jobId(input.invocationId),
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
        if (
          inherited.scope.schemaVersion !== "sandbox-scope.v1" ||
          inherited.scope.workspaceCopy !== undefined ||
          inherited.scope.copySave !== undefined ||
          descriptor.scopeSource === "private_temp"
        )
          throw new Error("SANDBOX_CHILD_SCOPE_UNSUPPORTED");
        const inheritedDirectory = inherited.scope.directoryGrant;
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
            (op) => !inheritedDirectory.operations.includes(op),
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
        const scopeBinding = await persistScope(
          await freezeFileScope(scope, binding, descriptor.contract),
          input.invocationId,
        );
        const { semanticFingerprint: _fingerprint, ...candidate } = prior;
        const plan = sandboxExecutionPlanCandidateV2Schema.parse({
          ...candidate,
          identity: {
            ...prior.identity,
            jobId: jobId(input.invocationId),
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
        if (!resolved.workspaceClaims.length) throw new Error("SANDBOX_CHILD_SCOPE_UNSUPPORTED");
        if (resolved.allowedDomains.some((domain) => !inherited.allowedDomains.includes(domain)))
          throw new Error("SANDBOX_CHILD_SCOPE_EXCEEDED");
        const reservation = sandboxExecutionReservationSchema.parse({
          schemaVersion: "sandbox-preparation.v1",
          identity: plan.identity,
          environmentId: plan.environmentId,
          resourceRef: plan.mode === "foreground" ? null : ids.next("sandbox-resource"),
          mode: plan.mode,
          workspaceConflictRefs: resolved.workspaceClaims.map((claim) => claim.ref),
          sequence: 1,
          createdAt: plan.requestedAt,
        });
        return { plan, reservation, workspaces: resolved.workspaceClaims };
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
          jobId: jobId(input.invocationId),
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
    fixedFileCompleted: async (record) => {
      const result = record.facts.result;
      if (
        record.facts.effect.kind !== "verified" ||
        !result ||
        (result.kind !== "result" &&
          !(result.kind === "error" && result.reasonCode === "FILE_VERSION_CONFLICT"))
      )
        return false;
      const verified = await verifyOutput({
        plan: record.plan,
        facts: record.facts,
        now: clock.now(),
      });
      return verified.effectEvidence.length === 1 && verified.fixedFileClosed;
    },
    now: () => clock.now(),
    admit: resolve,
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
  const verifyOutput = async ({
    plan,
    facts,
    now,
  }: Parameters<SandboxExecutionEvidencePort["verify"]>[0]) => {
    let fixedFileClosed = false;
    const effectEvidence: { ref: string; digest: string }[] = [];
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
        const recovered =
          (fixedFileContract(plan.operationContract) ||
            (plan.operationContract.ref === PI_DIRECTORY_MOVE_CONTRACT.ref &&
              plan.operationContract.version === PI_DIRECTORY_MOVE_CONTRACT.version)) &&
          plan.operationContract.kind === "verified_effect"
            ? await artifacts().lookup({
                runId: plan.identity.runId as RuntimeToolInvocation["runId"],
                purpose: "trace",
                operationKey: piFileRecoveryOperationKey(plan.identity.invocationId),
              })
            : undefined;
        if (
          (!artifact || artifact.payloadRef !== facts.result.output.ref) &&
          recovered?.payloadRef !== facts.result.output.ref
        )
          throw new Error("SANDBOX_OUTPUT_BINDING_CHANGED");
      }
      const payload = await payloads.get(facts.result.output.ref);
      if (!payload || payload.ciphertext.byteLength > plan.resourceCeiling.maxOutputBytes + 131072)
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
      if (facts.effect.kind === "verified") {
        if (
          (facts.result.kind !== "result" &&
            !(
              facts.result.kind === "error" && facts.result.reasonCode === "FILE_VERSION_CONFLICT"
            )) ||
          facts.effect.evidence.ref !== facts.result.output.ref ||
          facts.effect.evidence.digest !== facts.result.output.digest
        )
          throw new Error("PI_WRITE_EVIDENCE_INVALID");
        const verifiedOutcome = verifyPiWriteEvidence({
          bytes,
          parameters: await readJson(plan.inputRef),
          plan,
          scope: sandboxScopeSchema.parse(await readJson(plan.binding.scopeRef)),
        });
        if (
          (verifiedOutcome === "conflict") !==
          (facts.result.kind === "error" && facts.result.reasonCode === "FILE_VERSION_CONFLICT")
        )
          throw new Error("PI_WRITE_EVIDENCE_INVALID");
        if (plan.operation === "save_copy") {
          const scope = sandboxScopeSchema.parse(await readJson(plan.binding.scopeRef));
          const { binding } = await entryFor(plan.capabilityRef, plan.capabilityVersion);
          const root = binding.roots.find(
            (item) => item.canonicalRootId === scope.directoryGrant.canonicalRootId,
          );
          if (!root) throw new Error("COPY_SAVE_ROOT_UNAVAILABLE");
          const saved = await importProductionCopySave({
            scope,
            workspace: root.canonicalPath,
            privateDirectory: path.join(binding.privateRoot, plan.identity.jobId),
            repository,
            authority: options.authority().lease,
            now,
          });
          const proof = JSON.parse(Buffer.from(bytes).toString()).verifiedCopySave;
          if (
            !saved ||
            (verifiedOutcome === "conflict"
              ? !saved.conflict
              : saved.operation.status !== "verified") ||
            saved.operation.revision !== proof.revision
          )
            throw new Error("COPY_SAVE_CHECKPOINT_UNAVAILABLE");
        }
        fixedFileClosed =
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).fileCommitClosed ===
          true;
        effectEvidence.push({ ...facts.effect.evidence });
      }
      outputs.push({ ...facts.result.output });
    }
    return { outputs, effectEvidence, fixedFileClosed };
  };
  const evidence: SandboxExecutionEvidencePort = {
    verify: async ({ plan, facts, now }) => {
      const { outputs, effectEvidence } = await verifyOutput({ plan, facts, now });
      return {
        facts,
        identity: plan.identity,
        environmentId: plan.environmentId,
        policyDigest: facts.environment.policyDigest,
        resourceSequence: facts.resource.sequence,
        checkedAt: now,
        validUntil: new Date(Date.parse(now) + 1000).toISOString(),
        outputs,
        evidence: [...(await control.evidence(plan, facts)), ...effectEvidence],
      };
    },
  };
  const refreshVerification = async (
    record: Parameters<typeof control.refreshEvidence>[0],
    retainedRelease = false,
    action: "inspect" | "stop" = "inspect",
    signal?: AbortSignal,
  ) => {
    const { outputs, effectEvidence } = await verifyOutput({
      plan: record.plan,
      facts: record.facts,
      now: clock.now(),
    });
    const observed =
      retainedRelease && record.releaseReceipt
        ? { resource: record.facts.resource, evidence: [] }
        : await control.refreshEvidence(record, action, signal);
    const facts = { ...record.facts, resource: observed.resource };
    const now = clock.now();
    return {
      facts,
      identity: record.plan.identity,
      environmentId: record.plan.environmentId,
      policyDigest: facts.environment.policyDigest,
      resourceSequence: facts.resource.sequence,
      checkedAt: now,
      validUntil: new Date(Date.parse(now) + 1000).toISOString(),
      outputs,
      evidence: [...observed.evidence, ...effectEvidence],
    };
  };
  const recoverFileResult = createProductionSandboxFileRecovery({
    journal: repository.sandboxExecutionJournal(configuration.ownerId, configuration.agentId),
    authority: options.authority,
    now: () => clock.now(),
    verifyFresh: (record) => refreshVerification(record, true),
    recoverOutput: async ({ plan }) => {
      const key = {
        runId: plan.identity.runId as RuntimeToolInvocation["runId"],
        purpose: "trace" as const,
        operationKey: piFileRecoveryOperationKey(plan.identity.invocationId),
      };
      const retained = await artifacts().lookup(key);
      // An accepted recovery artifact survives later user edits and service boots.
      // The immutable bytes are verified again by verifyOutput before journal CAS.
      if (retained) {
        const value = await readJson(retained.payloadRef);
        const bytes = Buffer.from(JSON.stringify(value));
        return {
          ref: retained.payloadRef,
          digest: bytesHash(bytes),
          byteLength: bytes.length,
          outcome: (value as { fileConflict?: unknown }).fileConflict
            ? ("conflict" as const)
            : ("published" as const),
        };
      }
      const entry = await entryFor(plan.capabilityRef, plan.capabilityVersion);
      await verifySandboxHost({ ...entry, hostId, plan });
      const scope = sandboxScopeSchema.parse(await readJson(plan.binding.scopeRef));
      const root = entry.binding.roots.find(
        (item) => item.canonicalRootId === scope.directoryGrant.canonicalRootId,
      );
      if (!root || hash(scope) !== plan.binding.scopeDigest)
        throw new Error("SANDBOX_RECOVERY_SCOPE_CHANGED");
      const parameters = await readJson(plan.inputRef);
      const grant: HostDirectoryGrant = {
        id: scope.directoryGrant.ref,
        revision: scope.directoryGrant.revision,
        hostId: scope.hostId,
        canonicalRootId: scope.directoryGrant.canonicalRootId,
        displayPath: root.canonicalPath,
        operations: scope.directoryGrant.operations,
        authorizationRef: scope.directoryGrant.authorizationRef,
        expiresAt: scope.expiresAt,
        revokedAt: null,
        dataClassification: "private",
        disclosure: "none",
        pathPolicy: "same_filesystem_no_links",
        mountPolicy: "fixed_device",
      };
      const moving = plan.operation === "move_directory";
      const saving = plan.operation === "save_copy";
      const privateDirectory = path.join(entry.binding.privateRoot, plan.identity.jobId);
      const savedCopy = saving
        ? await importProductionCopySave({
            scope,
            workspace: root.canonicalPath,
            privateDirectory,
            repository,
            authority: options.authority().lease,
            now: clock.now(),
            recover: true,
          })
        : undefined;
      const publication =
        moving || saving
          ? undefined
          : createPiFilePublicationJournal({
              privateDirectory,
              workspace: root.canonicalPath,
              scope,
              parametersJson: JSON.stringify(parameters),
            });
      const fileConflict =
        saving && savedCopy?.conflict
          ? {
              operationId: savedCopy.operation.id,
              canonicalHash: savedCopy.operation.canonicalHash,
            }
          : await publication?.recoverConflict();
      const proof = fileConflict
        ? undefined
        : saving
          ? savedCopy?.operation.status === "verified"
            ? {
                operationId: savedCopy.operation.id,
                canonicalHash: savedCopy.operation.canonicalHash,
                status: "verified",
                revision: savedCopy.operation.revision,
              }
            : undefined
          : moving
            ? await createDirectoryMoveJournal({
                privateDirectory,
                workspace: root.canonicalPath,
                scope,
              }).recover()
            : await publication?.recover(grant);
      if (!proof && !fileConflict) return undefined;
      const invocationPrefix = "runtime-tool:";
      if (!plan.identity.invocationId.startsWith(invocationPrefix))
        throw new Error("SANDBOX_RECOVERY_REQUEST_UNAVAILABLE");
      const original = await artifacts().lookup({
        runId: key.runId,
        purpose: "trace",
        operationKey: `runtime-tool-intent:${plan.identity.invocationId.slice(invocationPrefix.length)}`,
      });
      if (!original) throw new Error("SANDBOX_RECOVERY_REQUEST_UNAVAILABLE");
      const originalIntent = (await readJson(original.payloadRef)) as { request?: unknown };
      const request = executionV2MessageSchema.parse(originalIntent.request);
      if (
        request.type !== "work.execute" ||
        request.messageId !== plan.identity.invocationId ||
        request.scope.runId !== plan.identity.runId ||
        request.payload.capabilityHandleRef !== plan.handleRef ||
        request.payload.inputRef !== plan.inputRef
      )
        throw new Error("SANDBOX_RECOVERY_REQUEST_CHANGED");
      const value = {
        schemaVersion: "pi-result.v1",
        tool: plan.operation,
        isError: Boolean(fileConflict),
        content: [
          {
            type: "text",
            text: fileConflict
              ? "已核验原操作在发布前因版本冲突停止；候选保留，未重新执行。"
              : moving
                ? "已核验本次目录移动；结果来自原操作记录，未再次执行移动。"
                : "已核验本次文件保存；结果来自原操作的持久发布记录，未再次执行写入。",
          },
        ],
        details: { recoveredPublication: true },
        fullOutput: null,
        commandExitCode: null,
        ...(fileConflict
          ? {
              fileConflict,
              ...(saving && savedCopy
                ? {
                    verifiedCopySave: {
                      operationId: savedCopy.operation.id,
                      canonicalHash: savedCopy.operation.canonicalHash,
                      status: "not_started",
                      revision: savedCopy.operation.revision,
                    },
                  }
                : {}),
            }
          : saving
            ? { verifiedCopySave: proof }
            : moving
              ? { verifiedMove: proof }
              : { verifiedWrite: proof }),
        source: {
          workspace: root.canonicalPath,
          toolCallId: scope.toolCallId,
          directoryGrantRef: scope.directoryGrant.ref,
          directoryGrantRevision: scope.directoryGrant.revision,
          parameters,
        },
      };
      const plaintext = Buffer.from(JSON.stringify(value));
      if (
        plaintext.length > plan.resourceCeiling.maxOutputBytes ||
        scanMachineSecrets(plaintext.toString()).length
      )
        throw new Error("SANDBOX_RECOVERY_OUTPUT_REJECTED");
      verifyPiWriteEvidence({
        bytes: plaintext,
        parameters,
        plan,
        scope,
        workspace: root.canonicalPath,
      });
      const payload = await protector.protect({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        ref: ids.next("sandbox-file-recovery"),
        dataClassification: request.dataClassification,
        contentType: "application/json",
        plaintext,
        createdAt: clock.now(),
      });
      const saved = await artifacts().commit({ ...key, payload });
      if (hash(await readJson(saved.ref)) !== bytesHash(plaintext))
        throw new Error("SANDBOX_RECOVERY_OUTPUT_CHANGED");
      return {
        ref: saved.ref,
        digest: bytesHash(plaintext),
        byteLength: plaintext.length,
        outcome: fileConflict ? ("conflict" as const) : ("published" as const),
      };
    },
  });
  const completeToolResult = createProductionSandboxToolResult({
    preparations,
    journal: repository.sandboxExecutionJournal(configuration.ownerId, configuration.agentId),
    authority: options.authority,
    now: () => clock.now(),
    verifyFresh: (record) => refreshVerification(record, true),
    recoverResult: recoverFileResult,
  });
  const outputOptions = {
    ownerId: configuration.ownerId,
    agentId: configuration.agentId,
    payloads,
    protector,
    artifacts,
    clock,
    ids,
  };
  const stream = createProductionSandboxStream(outputOptions);
  const readForegroundOutput = createProductionSandboxOutput(outputOptions);
  const reconciliation = new SandboxExecutionReconciliationService({
    hostId,
    journal: repository.sandboxExecutionJournal(configuration.ownerId, configuration.agentId),
    evidence,
    backend: {
      ...control.backend,
      observeVerified: (record, action, signal) =>
        refreshVerification(record, false, action, signal),
    },
    // Reconciliation verifies installed runtime bytes on the host as well as process facts.
    // Use the existing bounded maximum so mechanical-disk verification can finish.
    timeoutMs: 30000,
    now: () => clock.now(),
  });
  const stopRecord = async (record: Parameters<typeof stream.output>[0]) => {
    let current = record;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return (
          await reconciliation.reconcile({
            identity: current.plan.identity,
            expectedSequence: current.facts.resource.sequence,
            authority: options.authority(),
            action: "stop",
          })
        ).record;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "SANDBOX_RECONCILIATION_SEQUENCE_CHANGED"
        )
          throw error;
        const latest = await repository
          .sandboxExecutionJournal(configuration.ownerId, configuration.agentId)
          .read(record.plan.identity);
        if (!latest) throw error;
        current = latest;
      }
    }
    throw new Error("SANDBOX_STOP_OBSERVATION_CONFLICT");
  };
  const resourceRecovery = new SandboxResourceRecoveryService({
    hostId,
    preparations,
    reconciliation,
    reservations: { stop: control.stopPreparation, verify: control.verifyReservationRelease },
    authority: options.authority,
    now: () => clock.now(),
    timeoutMs: 30000,
  });
  const resolveTask = async (call: RuntimeToolInvocation, resourceRef: string) => {
    const admission = await preparations.readAdmissionByResource({
      runId: call.runId,
      resourceRef,
    });
    if (
      !admission ||
      admission.phase !== "bound" ||
      admission.record.plan.mode === "foreground" ||
      !call.context
    )
      throw new Error("MANAGED_TASK_UNAVAILABLE");
    const record = admission.record;
    const resolved = await resolve(record.plan);
    if (
      resolved.scope.modelRef !== call.context.modelRef ||
      resolved.scope.threadId !== call.context.threadId ||
      record.plan.executionLease.deploymentId !== call.context.executionLease.deploymentId ||
      record.plan.executionLease.authorityEpoch !== call.context.executionLease.authorityEpoch ||
      record.plan.executionLease.fencingToken !== call.context.executionLease.fencingToken
    )
      throw new Error("MANAGED_TASK_CALLER_CHANGED");
    const receipt = await repository
      .capabilityInvocationReceiptPort(configuration.ownerId, configuration.agentId)
      .read({
        handleRef: record.plan.handleRef,
        invocationId: record.plan.identity.invocationId,
        authority: options.authority(),
        now: clock.now(),
      });
    const rank = ["public", "private", "sensitive", "restricted"];
    if (
      !receipt ||
      rank.indexOf(receipt.dataClassification) > rank.indexOf(call.dataClassification)
    )
      throw new Error("MANAGED_TASK_DISCLOSURE_DENIED");
    return record;
  };
  const managedTasks = createProductionManagedTasks({
    termination: stream.termination,
    now: () => clock.now(),
    resolve: resolveTask,
    observe: async (record, stop) => {
      if (!stop) return record;
      return stopRecord(record);
    },
    output: (record, cursor, limit) =>
      stream.output(record, {
        resourceRef: record.facts.environment.resourceRef ?? "",
        cursor,
        limit,
      }),
    readOutput: async (call, record, ref) => {
      await resolveTask(call, record.facts.environment.resourceRef ?? "");
      const payload = await payloads.get(ref);
      if (!payload || payload.ciphertext.byteLength > 65536)
        throw new Error("MANAGED_TASK_OUTPUT_UNAVAILABLE");
      const bytes = await protector.unprotect({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        payload,
      });
      if (bytes.byteLength > 32768) throw new Error("MANAGED_TASK_OUTPUT_LIMIT");
      return Buffer.from(bytes).toString("base64");
    },
    load: async (call, key) => {
      const stored = await artifacts().lookup({
        runId: call.runId,
        purpose: "trace",
        operationKey: key,
      });
      return stored ? readJson(stored.payloadRef) : undefined;
    },
    save: async (call, key, value) => {
      const plaintext = Buffer.from(JSON.stringify(value));
      if (plaintext.length > 65536) throw new Error("MANAGED_TASK_RECORD_LIMIT");
      const payload = await protector.protect({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        ref: ids.next("managed-task"),
        dataClassification: call.dataClassification,
        contentType: "application/json",
        plaintext,
        createdAt: clock.now(),
      });
      const saved = await artifacts().commit({
        runId: call.runId,
        purpose: "trace",
        operationKey: key,
        payload,
      });
      return { ref: saved.ref, value: await readJson(saved.ref) };
    },
  });
  return {
    rebindQueuedRun: async (
      request: Pick<
        RuntimeRequest,
        | "runId"
        | "threadId"
        | "executionLease"
        | "modelRef"
        | "capabilityHandleRefs"
        | "executionDeadlineAt"
        | "continuationRef"
      >,
    ): Promise<void> => {
      const inventory = await preparations.readRunInventory({ runId: request.runId });
      for (const queued of inventory.queue) {
        if (queued.status !== "queued") continue;
        const authority = options.authority();
        const plan = sandboxExecutionPlanCandidateV2Schema.parse({
          ...queued.plan,
          executionLease: request.executionLease,
        });
        let privateChild = false;
        if (queued.recovery && queued.recovery.continuationRef === request.continuationRef) {
          const scope = sandboxExecutionScopeSchema.parse(await readJson(plan.binding.scopeRef));
          const savedIntent = await artifacts().lookup({
            runId: request.runId,
            purpose: "trace",
            operationKey: `runtime-tool-intent:${hash([request.runId, scope.toolCallId])}`,
          });
          const original = savedIntent
            ? ((await readJson(savedIntent.payloadRef)) as {
                recovery?: { continuationRef: string; toolCallId: string };
              })
            : undefined;
          privateChild =
            scope.parentToolCallId === queued.recovery.toolCallId &&
            original?.recovery?.continuationRef === queued.recovery.continuationRef &&
            original.recovery.toolCallId === queued.recovery.toolCallId;
        }
        if (
          plan.identity.threadId !== request.threadId ||
          plan.modelRef !== request.modelRef ||
          (!request.capabilityHandleRefs.includes(plan.handleRef) && !privateChild) ||
          (request.executionDeadlineAt && plan.effectiveDeadlineAt > request.executionDeadlineAt)
        )
          throw new Error("SANDBOX_QUEUE_RUN_CONTEXT_CHANGED");
        // Resolve the original protected scope and target against current grants.
        // Rebuilding a scope from today's target would silently change the approval.
        await resolve(plan);
        await preparations.rebindQueued({
          ...(queued.recovery ? { recovery: queued.recovery } : {}),
          plan,
          reservation: queued.reservation,
          workspaces: queued.workspaces,
          invocation: {
            ...queued.invocation,
            authority,
            consumedAt: clock.now(),
            requestScope: {
              ...queued.invocation.requestScope,
              ...authority.product,
            },
          },
          expectedBindingRevision: queued.bindingRevision,
        });
      }
    },
    maximumResourceCeiling: async (capabilityRef: string, capabilityVersion: string) => {
      if (!sandboxEntries.some((entry) => entry.manifest.ref === capabilityRef)) return undefined;
      return (await entryFor(capabilityRef, capabilityVersion)).binding.maximumResourceCeiling;
    },
    runtime,
    completeToolResult,
    child,
    managedTasks,
    resources: {
      recoverPending: (signal: AbortSignal, maximum: number) =>
        resourceRecovery.pump(signal, maximum),
      stopRun: async (runId: RuntimeToolInvocation["runId"]) => {
        let afterJobId: string | null = null;
        let released = true;
        const stops: Promise<void>[] = [];
        for (;;) {
          const page = await preparations.listAdmissions({ runId, afterJobId, limit: 100 });
          for (let admission of page) {
            const plan = admission.phase === "bound" ? admission.record.plan : admission.plan;
            if (plan.identity.runId !== runId) continue;
            // Enumerate and stop every owned admission before waiting for any
            // cleanup result, including admissions on later pages.
            stops.push(
              (async () => {
                if (admission.phase === "reserved") {
                  if (admission.releaseReceipt && admission.workspaceBlocked === false) return;
                  try {
                    admission = (
                      await preparations.interruptReservation({
                        identity: plan.identity,
                        authority: options.authority(),
                        now: clock.now(),
                        reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
                      })
                    ).admission;
                    if (admission.phase === "reserved") {
                      // Stop only the original registered host; missing binding remains unknown.
                      await control.stopPreparation(plan);
                      if (!admission.stopRequestedAt) throw new Error("SANDBOX_STOP_FENCE_MISSING");
                      const verification = await control.verifyReservationRelease(
                        plan,
                        admission.stopRequestedAt,
                      );
                      if (verification)
                        admission = (
                          await preparations.releaseReservation({
                            identity: plan.identity,
                            authority: options.authority(),
                            now: clock.now(),
                            verification,
                          })
                        ).admission;
                    }
                  } catch {
                    released = false;
                    return;
                  }
                  if (admission.phase === "reserved") {
                    if (!admission.releaseReceipt || admission.workspaceBlocked !== false)
                      released = false;
                    return;
                  }
                }
                try {
                  const result = { record: await stopRecord(admission.record) };
                  if (
                    result.record.facts.resource.supervision !== "released" ||
                    !result.record.releaseReceipt ||
                    result.record.workspaceBlocked
                  )
                    released = false;
                } catch {
                  released = false;
                }
              })(),
            );
          }
          if (page.length < 100) break;
          const last = page.at(-1);
          if (!last) break;
          afterJobId =
            last.phase === "bound" ? last.record.plan.identity.jobId : last.plan.identity.jobId;
        }
        await Promise.all(stops);
        return { released };
      },
    },
    taskHandle: async (handle: GovernedCapabilityExecutionHandle) => {
      if (
        !sandboxEntries.some(
          (entry) =>
            entry.manifest.ref === handle.capabilityRef &&
            entry.manifest.version === handle.capabilityVersion,
        )
      )
        return false;
      const { binding } = await entryFor(handle.capabilityRef, handle.capabilityVersion);
      return (
        binding.operationBindings?.some(
          (item) =>
            item.operation === handle.operation &&
            ((item.mode === "background" && item.contract.kind === "task_start") ||
              (item.mode === "service" && item.contract.kind === "service_start")),
        ) === true
      );
    },
    brokerV2: {
      evidence,
      refreshVerification,
      appendOutput: stream.append,
      readOutput: (
        record: Parameters<typeof readForegroundOutput>[0],
        query: Parameters<typeof readForegroundOutput>[1],
      ) =>
        record.plan.mode === "foreground"
          ? readForegroundOutput(record, query)
          : stream.output(record, query),
      registerControl: control.register,
      observeVerifiedControl: refreshVerification,
      verifyPreparation: control.verifyPreparation,
      reconciliation,
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
