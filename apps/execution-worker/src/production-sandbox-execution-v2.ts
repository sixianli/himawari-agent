import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CapabilityInvocationRequest,
  type ClockPort,
  type ProductConfiguration,
  taskEnvironmentCallEvidence,
} from "@himawari-agent/application";
import {
  type EnvironmentPrewarmRequest,
  type ExecutionAdmissionPeerBinding,
  type ExecutionEnvironmentIdentity,
  type ExecutionEnvironmentLocator,
  type ExecutionV2Request,
  executionV2MessageSchema,
  type PayloadBrokerSandboxExecutionResult,
  PI_CONTAINER_RUNNER_PATH,
  PI_CONTAINER_WORKSPACE_ROOT,
  PI_COPY_SAVE_CONTRACT,
  PI_DIRECTORY_MOVE_CONTRACT,
  PI_FIXED_FILE_CONTRACT,
  PI_PREPARED_FILE_CONTRACT,
  PI_RESIDENT_RUNNER_FLAG,
  PI_RUNNER_CONTRACT,
  piCodingToolNameSchema,
  piContainerRunnerInputSchema,
  piRunnerInputSchema,
  SANDBOX_HOST_COMPLETION_CONTRADICTED,
  SANDBOX_OUTPUT_LIMIT,
  SANDBOX_PREPARATION_LAUNCH_PROTOCOL,
  SANDBOX_TOOL_NOT_STARTED,
  type SandboxExecutionBrokerCommand,
  type SandboxExecutionPlanV2,
  type SandboxPreparationDiagnostic,
  type SandboxTaskEnvironmentBinding,
  type SandboxTaskTermination,
  SRT_BACKEND_REF,
  SRT_TASK_ENVIRONMENT_BACKEND_REF,
  sandboxExecutionFactsSchema,
  sandboxFileOperationFailureReason,
  sandboxPreparationDiagnosticSchema,
  sandboxResourceLimitReason,
  sandboxScopeSchema,
  srtTaskEnvironmentSession,
} from "@himawari-agent/execution-contracts";
import {
  CapabilityDeploymentSnapshotLoader,
  publishPreparedPiOperation,
  resolveSandboxWorkspaceRoot,
  revalidateCapabilityDeploymentSnapshot,
  verifiedPiWriteFailure,
  verifyPiWriteEvidence,
  verifySandboxHost,
} from "@himawari-agent/platform-node";
import {
  type JobHostControlAccess,
  type JobHostLauncher,
  JobHostPreparationError,
  localJobHostControlAccess,
  prepareJobPolicy,
  prepareSandboxJobHost,
  type SandboxJobHost,
} from "@himawari-agent/runtime-sandbox";
import { BrokerPollTolerance } from "./broker-poll-tolerance.js";
import { sandboxInvocationFromRequest } from "./broker-sandbox-execution.js";
import type { ProductionPayloadBrokerClient } from "./production-payload-broker-client.js";
import {
  type SandboxWorkerResult,
  sandboxExternalActionId,
} from "./production-sandbox-execution.js";
import {
  type SrtTaskEnvironmentBackend,
  type SrtTaskEnvironmentSession,
  type SrtTaskEnvironmentSessionKind,
  srtTaskEnvironmentJobId,
} from "./production-srt-task-environment-backend.js";
import { injectProgramSecrets, type ProgramSecretSource } from "./program-secret-injection.js";

type Execute = Extract<ExecutionV2Request, { type: "work.execute" }>;
type Control = Extract<ExecutionV2Request, { type: "work.cancel" | "work.reconcile" }>;
type Record = PayloadBrokerSandboxExecutionResult["payload"]["record"];
interface Entry {
  identity: NonNullable<Execute["payload"]["sandboxExecution"]>["identity"];
  request: Execute;
  invocation: CapabilityInvocationRequest;
  cancelled: boolean;
  stage?: SandboxPreparationDiagnostic["stage"];
  host?: SandboxJobHost;
  record?: Record;
  completion?: Promise<SandboxWorkerResult>;
  supervision?: Promise<void>;
  acknowledge?: (result: SandboxWorkerResult) => void;
  resolving?: Promise<ResolveReply> | undefined;
  queuedResolve?: Promise<ResolveReply> | undefined;
}
type ResolveReply = Awaited<ReturnType<ProductionPayloadBrokerClient["sandboxExecution"]>>;
export interface SandboxContainerRoute {
  readonly backendRef: string;
  execute(input: {
    readonly identity: ExecutionEnvironmentIdentity;
    readonly createIntentId: string;
    readonly locator: ExecutionEnvironmentLocator;
    readonly stopFence: number;
    readonly invocationId: string;
    readonly argv: readonly string[];
    readonly deadlineAt: string;
    readonly authorizationRef: string;
  }): Promise<{
    readonly exitCode: number;
    readonly stdout: Uint8Array;
    readonly truncated: boolean;
  }>;
  publish(input: {
    readonly identity: ExecutionEnvironmentIdentity;
    readonly createIntentId: string;
    readonly locator: ExecutionEnvironmentLocator;
    readonly stopFence: number;
    readonly invocationId: string;
    readonly deadlineAt: string;
    readonly authorizationRef: string;
    readonly commit: () => Promise<{ readonly exitCode: number; readonly stdout: Uint8Array }>;
  }): Promise<{ readonly exitCode: number; readonly stdout: Uint8Array }>;
}
interface Options {
  configuration: Pick<ProductConfiguration, "capabilityDeployment">;
  peer: ExecutionAdmissionPeerBinding;
  payloads: ProductionPayloadBrokerClient;
  clock: ClockPort;
  containers?: SandboxContainerRoute;
  srtEnvironments?: Pick<SrtTaskEnvironmentBackend, "session">;
  secrets?: ProgramSecretSource;
  jobHostAccount?: {
    readonly launcher: JobHostLauncher;
    readonly control: JobHostControlAccess;
  };
}
const COMPLETION_RECORD_ATTEMPTS = 5;
const RECOVERY_SETTLE_WAIT_MS = 35000;
const RECOVERY_POLL_MS = 250;
const SRT_PREWARM_SESSIONS = ["command", "file_write"] as const;
const CONTAINER_TOOLS = new Set(["read", "bash", "find", "grep", "ls"]);
const HOST_PUBLICATION_CONTRACTS: ReadonlyMap<string, readonly string[]> = new Map([
  [PI_PREPARED_FILE_CONTRACT.version, ["write", "edit"]],
  [PI_DIRECTORY_MOVE_CONTRACT.version, ["move_directory"]],
  [PI_COPY_SAVE_CONTRACT.version, ["save_copy"]],
]);
export class ProductionSandboxExecutionV2 {
  private readonly options: Options;
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private readonly admitted: ReturnType<CapabilityDeploymentSnapshotLoader["load"]>;
  constructor(options: Options) {
    this.options = options;
    const deployment = options.configuration.capabilityDeployment;
    this.admitted = deployment
      ? new CapabilityDeploymentSnapshotLoader({
          ...deployment,
          now: () => options.clock.now(),
        }).load()
      : Promise.reject(new Error("SANDBOX_DEPLOYMENT_UNAVAILABLE"));
    void this.admitted.catch(() => {});
  }
  handles(id: string) {
    return this.entries.has(id);
  }
  private unknown(entry: Entry): SandboxWorkerResult {
    return {
      outcome: "result_unknown",
      outputRef: null,
      errorCode: null,
      externalActionId: sandboxExternalActionId(entry.identity),
    };
  }
  private freshResolve(entry: Entry): Promise<ResolveReply> {
    if (entry.queuedResolve) return entry.queuedResolve;
    const start = () => {
      const running = this.options.payloads.sandboxExecution(entry.invocation, entry.identity, {
        kind: "resolve",
      });
      entry.resolving = running;
      const clear = () => {
        if (entry.resolving === running) entry.resolving = undefined;
      };
      void running.then(clear, clear);
      return running;
    };
    if (!entry.resolving) return start();
    const queued = entry.resolving
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (entry.queuedResolve === queued) entry.queuedResolve = undefined;
        return start();
      });
    entry.queuedResolve = queued;
    return queued;
  }
  private async resolveRecord(entry: Entry) {
    const reply = await this.freshResolve(entry);
    entry.record = reply.record;
    return reply;
  }
  private async rpc(entry: Entry, command: SandboxExecutionBrokerCommand) {
    const reply = await this.options.payloads.sandboxExecution(
      entry.invocation,
      entry.identity,
      command,
    );
    entry.record = reply.record;
    return reply;
  }
  execute(value: Execute): Promise<SandboxWorkerResult> {
    const request = executionV2MessageSchema.parse(value);
    if (request.type !== "work.execute" || !request.payload.sandboxExecution || this.closed)
      throw new Error("SANDBOX_V2_UNAVAILABLE");
    const prior = this.entries.get(request.messageId);
    if (prior) {
      if (
        executionV2MessageSchema.serialize(prior.request) !==
          executionV2MessageSchema.serialize(request) ||
        !prior.completion
      )
        throw new Error("SANDBOX_REQUEST_CHANGED");
      return prior.completion;
    }
    const entry: Entry = {
      request,
      identity: request.payload.sandboxExecution.identity,
      invocation: sandboxInvocationFromRequest(request),
      cancelled: false,
    };
    this.entries.set(request.messageId, entry);
    entry.completion = new Promise((resolve) => {
      entry.acknowledge = resolve;
    });
    entry.supervision = this.run(entry).then((result) => entry.acknowledge?.(result));
    return entry.completion;
  }
  private hostBinding(plan: SandboxExecutionPlanV2) {
    return this.capabilityBinding(
      {
        capabilityRef: plan.capabilityRef,
        capabilityVersion: plan.capabilityVersion,
        hostId: plan.identity.hostId,
      },
      plan,
    );
  }
  private async capabilityBinding(
    target: {
      readonly capabilityRef: string;
      readonly capabilityVersion: string;
      readonly hostId: string;
    },
    plan?: SandboxExecutionPlanV2,
  ) {
    const deployment = this.options.configuration.capabilityDeployment;
    if (!deployment) throw new Error("SANDBOX_DEPLOYMENT_UNAVAILABLE");
    const loaded = await revalidateCapabilityDeploymentSnapshot(await this.admitted);
    const entry = loaded.snapshot.capabilities.find(
      (item) =>
        item.manifest.ref === target.capabilityRef &&
        item.manifest.version === target.capabilityVersion,
    );
    if (!entry || entry.binding.kind !== "sandbox" || !entry.qualification.sandbox)
      throw new Error("SANDBOX_HOST_UNAVAILABLE");
    await verifySandboxHost({
      binding: entry.binding.value,
      qualification: entry.qualification.sandbox,
      hostId: target.hostId,
      ...(plan ? { plan } : {}),
    });
    return entry.binding.value;
  }
  private assertRequest(entry: Entry, plan: SandboxExecutionPlanV2) {
    const request = entry.request;
    if (
      JSON.stringify(plan.identity) !==
        JSON.stringify(request.payload.sandboxExecution?.identity) ||
      plan.handleRef !== request.payload.capabilityHandleRef ||
      plan.inputRef !== request.payload.inputRef ||
      plan.capabilityRef !== request.payload.capabilityId ||
      plan.capabilityVersion !== request.payload.capabilityVersion ||
      plan.operation !== request.payload.operation ||
      plan.environmentId !== request.payload.sandboxExecution?.environmentId ||
      plan.mode !== request.payload.sandboxExecution?.mode ||
      (plan.mode !== "foreground" &&
        !(plan.mode === "background" && plan.operationContract.kind === "task_start") &&
        !(plan.mode === "service" && plan.operationContract.kind === "service_start")) ||
      ![
        "fixed_read",
        "command",
        "network_only",
        "verified_effect",
        "task_start",
        "service_start",
      ].includes(plan.operationContract.kind) ||
      (plan.operationContract.kind === "verified_effect" &&
        plan.operationContract.ref !== PI_RUNNER_CONTRACT.ref) ||
      plan.executionLease.deploymentId !== request.scope.deploymentId ||
      plan.executionLease.authorityEpoch !== request.scope.authorityEpoch ||
      plan.executionLease.fencingToken !== request.scope.fencingToken ||
      plan.effectiveDeadlineAt > request.payload.deadlineAt ||
      (request.authorizationRef !== null && plan.authorizationRef !== request.authorizationRef) ||
      Object.entries(plan.resourceCeiling).some(
        ([key, value]) =>
          value > request.payload.resourceCeiling[key as keyof typeof plan.resourceCeiling],
      )
    )
      throw new Error("SANDBOX_EXECUTION_BINDING_CHANGED");
  }
  private async run(entry: Entry): Promise<SandboxWorkerResult> {
    let stage: SandboxPreparationDiagnostic["stage"] | undefined;
    try {
      const initial = (await this.rpc(entry, { kind: "read" })).record;
      this.assertRequest(entry, initial.plan);
      if (initial.phase !== "reserved") return this.unknown(entry);
      if (entry.cancelled || this.closed) return this.unknown(entry);
      const plan = initial.plan;
      if (this.options.containers && plan.backendRef === this.options.containers.backendRef)
        return await this.runInEnvironment(entry, initial, this.options.containers);
      if (plan.backendRef === SRT_TASK_ENVIRONMENT_BACKEND_REF) {
        if (!this.options.srtEnvironments) throw new Error("SANDBOX_ENVIRONMENT_UNAVAILABLE");
        return await this.runInSrtEnvironment(entry, initial, this.options.srtEnvironments);
      }
      stage = "prepare";
      const piRunner = plan.operationContract.ref === PI_RUNNER_CONTRACT.ref;
      if (piRunner) {
        const tool = piCodingToolNameSchema.parse(plan.operation);
        if (plan.mode !== "foreground" && tool !== "bash")
          throw new Error("PI_RUNNER_MODE_UNSUPPORTED");
        const kind =
          plan.mode === "background"
            ? "task_start"
            : plan.mode === "service"
              ? "service_start"
              : tool === "bash"
                ? "command"
                : ["write", "edit", "move_directory", "save_copy"].includes(tool)
                  ? "verified_effect"
                  : "fixed_read";
        if (
          ![
            PI_RUNNER_CONTRACT.version,
            PI_FIXED_FILE_CONTRACT.version,
            PI_PREPARED_FILE_CONTRACT.version,
            PI_DIRECTORY_MOVE_CONTRACT.version,
            PI_COPY_SAVE_CONTRACT.version,
          ].some((version) => version === plan.operationContract.version) ||
          ([PI_FIXED_FILE_CONTRACT.version, PI_PREPARED_FILE_CONTRACT.version].some(
            (version) => version === plan.operationContract.version,
          ) &&
            !["read", "write", "edit"].includes(tool)) ||
          (plan.operationContract.version === PI_DIRECTORY_MOVE_CONTRACT.version) !==
            (tool === "move_directory") ||
          (plan.operationContract.version === PI_COPY_SAVE_CONTRACT.version) !==
            (tool === "save_copy") ||
          plan.operationContract.kind !== kind
        )
          throw new Error("PI_RUNNER_CONTRACT_UNSUPPORTED");
      }
      const binding = await this.hostBinding(plan);
      const readinessRef =
        plan.operationContract.kind === "service_start"
          ? plan.operationContract.readinessProbeRef
          : null;
      const readiness = binding.readinessProbes?.find((probe) => probe.ref === readinessRef);
      if (plan.mode === "service" && !readiness) throw new Error("SANDBOX_READINESS_UNAVAILABLE");
      const resolved = (await this.rpc(entry, { kind: "resolve" })).resolvedScope;
      if (
        !resolved ||
        resolved.scope.authorizationRef !== plan.authorizationRef ||
        resolved.scope.operation !== plan.operation
      )
        throw new Error("SANDBOX_SCOPE_CHANGED");
      const scope = resolved.scope;
      if (
        scope.schemaVersion === "sandbox-scope.v1" &&
        scope.workspaceCopy &&
        (plan.mode !== "foreground" || plan.operationContract.kind !== "command")
      )
        throw new Error("SANDBOX_COPY_CONTRACT_CHANGED");
      const privateOnly = plan.operationContract.kind === "network_only";
      if (privateOnly !== (scope.directoryGrant === null)) throw new Error("SANDBOX_SCOPE_CHANGED");
      const root =
        scope.directoryGrant === null
          ? undefined
          : await resolveSandboxWorkspaceRoot({ binding, scope });
      if (!privateOnly && !root) throw new Error("SANDBOX_ROOT_UNAVAILABLE");
      const { policy, compiled } = await prepareJobPolicy({
        workspace: root?.canonicalPath ?? null,
        privateRoot: binding.privateRoot,
        jobId: plan.identity.jobId,
        ...(readiness ? { readinessSocketName: readiness.socketName } : {}),
        writable: Boolean(
          scope.directoryGrant &&
            (scope.workspaceCopy ||
              scope.directoryGrant.operations.some((operation) => operation !== "read")),
        ),
        readOnlyToolchainPaths: [binding.runtimeRoot, ...binding.readOnlyToolchainPaths],
        protectedPaths:
          root && (piRunner || plan.mode !== "foreground")
            ? [
                ...binding.protectedPaths,
                ...[
                  ".env",
                  ".git",
                  ...(plan.operation === "save_copy" ? [] : [".himawari-trash"]),
                  ...(["write", "edit", "save_copy"].includes(plan.operation)
                    ? []
                    : [".himawari-recovery"]),
                ].map((name) => path.join(root.canonicalPath, name)),
              ]
            : binding.protectedPaths,
        allowedDomains: resolved.allowedDomains,
      });
      const controlAccess =
        this.options.jobHostAccount?.control ?? localJobHostControlAccess(binding.privateRoot);
      const controlName = `control-${createHash("sha256").update(JSON.stringify(plan.identity)).digest("hex").slice(0, 20)}`;
      const preparedDirectory = await controlAccess.prepareDirectory(controlName);
      if (preparedDirectory.directory !== path.join(binding.privateRoot, controlName))
        throw new Error("SANDBOX_CONTROL_ROOT_MISMATCH");
      const controlDirectory = preparedDirectory.directory;
      const stored = await this.options.payloads.readInput(entry.invocation);
      if (stored.byteLength > 49152) throw new Error("SANDBOX_INPUT_TOO_LARGE");
      const input =
        entry.request.payload.secretRefs.length && !piRunner
          ? await injectProgramSecrets({
              stored,
              granted: entry.request.payload.secretRefs,
              networkOnly: plan.operationContract.kind === "network_only",
              ...(this.options.secrets ? { secrets: this.options.secrets } : {}),
            })
          : stored;
      if (piRunner && entry.request.payload.secretRefs.length)
        throw new Error("SANDBOX_SECRET_UNSUPPORTED");
      if (
        piRunner &&
        (![
          PI_RUNNER_CONTRACT.version,
          PI_FIXED_FILE_CONTRACT.version,
          PI_PREPARED_FILE_CONTRACT.version,
          PI_DIRECTORY_MOVE_CONTRACT.version,
          PI_COPY_SAVE_CONTRACT.version,
        ].some((version) => version === plan.operationContract.version) ||
          [PI_FIXED_FILE_CONTRACT.version, PI_PREPARED_FILE_CONTRACT.version].some(
            (version) => version === plan.operationContract.version,
          ) !== Boolean(resolved.scope.fileTarget) ||
          (plan.operationContract.version === PI_PREPARED_FILE_CONTRACT.version) !==
            Boolean(resolved.scope.preparedFile) ||
          (plan.operationContract.version === PI_DIRECTORY_MOVE_CONTRACT.version) !==
            Boolean(resolved.scope.directoryMove) ||
          (plan.operationContract.version === PI_COPY_SAVE_CONTRACT.version) !==
            Boolean(resolved.scope.copySave) ||
          resolved.scope.profileRef !== "authorized-project.v1")
      )
        throw new Error("PI_RUNNER_CONTRACT_UNSUPPORTED");
      const runnerInput = piRunner
        ? Buffer.from(
            JSON.stringify(
              piRunnerInputSchema.parse({
                schemaVersion: "pi-runner.v1",
                workerInstanceId: this.options.peer.workerInstanceId,
                tool: piCodingToolNameSchema.parse(plan.operation),
                executionMode: plan.mode,
                scope: resolved.scope,
                workspace: compiled.cwd,
                runtimeRoot: binding.runtimeRoot,
                privateDirectory: policy.privateDirectory,
                maxOutputBytes: plan.resourceCeiling.maxOutputBytes,
                parametersJson: new TextDecoder("utf-8", { fatal: true }).decode(input),
              }),
            ),
          )
        : input;
      const controlBinding = {
        directory: controlDirectory,
        token: randomBytes(32).toString("hex"),
        sessionId: randomUUID(),
        jobId: plan.identity.jobId,
        attemptId: plan.identity.attemptId,
      };
      stage = "register_preparation_control";
      await this.rpc(entry, {
        kind: "register_preparation_control",
        expectedSequence: 1,
        control: controlBinding,
        policyDigest: compiled.policyDigest,
      });
      if (entry.cancelled || this.closed || this.options.clock.now() >= plan.effectiveDeadlineAt)
        return this.unknown(entry);
      stage = "prepare";
      if (
        plan.preparationProtocol === SANDBOX_PREPARATION_LAUNCH_PROTOCOL &&
        !(await controlAccess.claimLaunch({
          plan,
          control: controlBinding,
          policyDigest: compiled.policyDigest,
          directoryDevice: preparedDirectory.device,
          directoryInode: preparedDirectory.inode,
        }))
      )
        return this.unknown(entry);
      if (entry.cancelled || this.closed || this.options.clock.now() >= plan.effectiveDeadlineAt)
        return this.unknown(entry);
      const host = prepareSandboxJobHost(
        {
          jobId: plan.identity.jobId,
          attemptId: plan.identity.attemptId,
          policy,
          policyDigest: compiled.policyDigest,
          executable: binding.executable.path,
          args: [binding.runner.path, binding.hostId, this.options.peer.workerInstanceId],
          stdinBase64: Buffer.from(runnerInput).toString("base64"),
          ...(readiness ? { readiness } : {}),
          deadlineAt: plan.effectiveDeadlineAt,
          maxOutputBytes: plan.resourceCeiling.maxOutputBytes,
          resourceLimits: {
            maxCpuTimeMs: plan.resourceCeiling.maxCpuTimeMs,
            maxMemoryBytes: plan.resourceCeiling.maxMemoryBytes,
          },
          cleanupTimeoutMs: 5000,
        },
        controlDirectory,
        async () => {
          if (entry.cancelled || this.closed) throw new Error("SANDBOX_STOPPED");
          const current = (await this.freshResolve(entry)).resolvedScope;
          if (
            entry.cancelled ||
            this.closed ||
            JSON.stringify(current) !== JSON.stringify(resolved)
          )
            throw new Error("SANDBOX_SCOPE_CHANGED");
        },
        controlBinding,
        this.options.jobHostAccount?.launcher,
      );
      entry.host = host;
      await host.ready;
      const identity = host.inspect();
      if (!identity || !host.controlBinding) throw new Error("SANDBOX_SUPERVISOR_UNAVAILABLE");
      stage = "register_control";
      await this.rpc(entry, {
        kind: "register_control",
        expectedSequence: 1,
        control: host.controlBinding,
      });
      const supervisor = {
        supervisorId: host.controlBinding.sessionId,
        bootId: identity.bootId,
        epoch: 1,
      };
      const environment = {
        schemaVersion: "sandbox-execution.v2",
        kind: "local",
        environmentId: plan.environmentId,
        resourceRef: initial.reservation.resourceRef,
        creator: plan.identity,
        mode: plan.mode,
        backendRef: plan.backendRef,
        authorizationRef: plan.authorizationRef,
        scopeDigest: plan.binding.scopeDigest,
        policyDigest: compiled.policyDigest,
        deadlineAt: plan.effectiveDeadlineAt,
        supervisor,
        workspaceConflictRefs: initial.reservation.workspaceConflictRefs,
        privateDirectoryRef: `sandbox-private:${createHash("sha256").update(policy.privateDirectory).digest("hex")}`,
        privateDirectoryOwnerRef: plan.identity.hostId,
      };
      const facts = sandboxExecutionFactsSchema.parse({
        schemaVersion: "sandbox-execution.v2",
        environment,
        result: null,
        effect: { kind: "unknown", reasonCode: "SANDBOX_NOT_STARTED" },
        resource: {
          schemaVersion: "sandbox-execution.v2",
          environmentId: plan.environmentId,
          creator: plan.identity,
          policyDigest: compiled.policyDigest,
          scopeDigest: plan.binding.scopeDigest,
          sequence: 2,
          occurredAt: this.options.clock.now(),
          supervisor,
          resourceRef: plan.mode === "foreground" ? null : initial.reservation.resourceRef,
          status:
            plan.mode === "foreground"
              ? { kind: "foreground" }
              : plan.mode === "service"
                ? { kind: "service", readiness: "starting" }
                : { kind: "task", state: "starting" },
          metrics: null,
          supervision: "initializing",
          cleanup: "pending",
        },
      });
      if (entry.cancelled || this.closed) {
        host.cancel();
        return this.unknown(entry);
      }
      stage = "bind";
      const started = await this.rpc(entry, { kind: "bind", expectedSequence: 1, facts });
      if (!started.applied || entry.cancelled || this.closed) {
        host.cancel();
        return this.unknown(entry);
      }
      stage = "execute";
      const launchBinding = await this.hostBinding(plan);
      if (
        readiness &&
        JSON.stringify(
          launchBinding.readinessProbes?.find((probe) => probe.ref === readiness.ref),
        ) !== JSON.stringify(readiness)
      )
        throw new Error("SANDBOX_READINESS_BINDING_CHANGED");
      if (entry.cancelled || this.closed) {
        host.cancel();
        return this.unknown(entry);
      }
      await this.rpc(entry, { kind: "resolve" });
      if (entry.cancelled || this.closed) {
        host.cancel();
        return this.unknown(entry);
      }
      host.start();
      const flush = this.outputStream(entry, plan, (offset, limit, channel) =>
        host.readOutput(offset, limit, channel),
      );
      let acknowledged = false;
      const acknowledge = async () => {
        const record = entry.record;
        if (
          acknowledged ||
          plan.mode === "foreground" ||
          !record ||
          record.phase !== "bound" ||
          record.facts.resource.supervision !== "controlled" ||
          !record.facts.environment.resourceRef
        )
          return;
        if (
          plan.mode === "service" &&
          (record.facts.resource.status.kind !== "service" ||
            record.facts.resource.status.readiness !== "ready")
        )
          return;
        await host.started;
        await this.rpc(entry, { kind: "resolve" });
        const handle = {
          ...(plan.mode === "service"
            ? { kind: "service", readiness: "ready" }
            : { kind: "task", state: "running" }),
          ref: record.facts.environment.resourceRef,
          environmentId: plan.environmentId,
          creator: plan.identity,
          backendRef: plan.backendRef,
          authorizationRef: plan.authorizationRef,
          scopeDigest: plan.binding.scopeDigest,
          deadlineAt: plan.effectiveDeadlineAt,
        };
        const bytes = Buffer.from(
          JSON.stringify({ schemaVersion: "sandbox-task-started.v1", status: "started", handle }),
        );
        const ref = await this.options.payloads.writeOutput(
          entry.invocation,
          bytes,
          "application/json",
        );
        const facts = sandboxExecutionFactsSchema.parse({
          ...record.facts,
          effect: { kind: "not_asserted" },
          result: {
            schemaVersion: "sandbox-execution.v2",
            kind: "started",
            identity: plan.identity,
            environmentId: plan.environmentId,
            policyDigest: compiled.policyDigest,
            contract: { ref: plan.operationContract.ref, version: plan.operationContract.version },
            occurredAt: this.options.clock.now(),
            output: {
              ref,
              digest: createHash("sha256").update(bytes).digest("hex"),
              byteLength: bytes.length,
            },
            handle,
            readinessEvidence:
              plan.mode === "service"
                ? {
                    ref: record.facts.resource.evidence.ref,
                    digest: record.facts.resource.evidence.digest,
                  }
                : null,
          },
        });
        await this.rpc(entry, {
          kind: "operation",
          expectedSequence: record.facts.resource.sequence,
          expectedOperationRevision: record.operationRevision,
          facts,
        });
        if (entry.cancelled || this.closed || host.inspect()?.state !== "alive")
          throw new Error("SANDBOX_START_LOST");
        acknowledged = true;
        entry.acknowledge?.({
          outcome: "succeeded",
          outputRef: ref,
          errorCode: null,
          externalActionId: sandboxExternalActionId(entry.identity),
        });
      };
      let finished = false;
      const completion = host.result.finally(() => {
        finished = true;
      });
      let taskCompleted: SandboxTaskTermination | null = null;
      let completionObserved = false;
      const earlyCompletion = host.completed.then((value) => {
        completionObserved = true;
        taskCompleted = value;
      });
      const tolerance = new BrokerPollTolerance();
      while (!finished) {
        await Promise.race([
          completion,
          delay(250),
          ...(!completionObserved ? [earlyCompletion] : []),
        ]);
        if (taskCompleted && plan.mode === "foreground") {
          await flush(true, taskCompleted);
          break;
        }
        if (finished) break;
        const current = entry.record;
        if (!current || current.phase !== "bound") throw new Error("SANDBOX_BINDING_LOST");
        try {
          await this.resolveRecord(entry);
          if (taskCompleted && plan.mode === "foreground") {
            await flush(true, taskCompleted);
            break;
          }
          if (finished) break;
          await flush(false);
          if (finished) break;
          const observed = await this.rpc(entry, {
            kind: "observe_control",
            expectedSequence: current.facts.resource.sequence,
          });
          const supervision =
            observed.record.phase === "bound"
              ? observed.record.facts.resource.supervision
              : undefined;
          if (supervision !== "controlled" && supervision !== "initializing") host.cancel();
          else if (supervision === "controlled") await acknowledge();
          tolerance.succeeded();
        } catch (error) {
          if (tolerance.failed(error) !== "cancel") continue;
          host.cancel();
          break;
        }
      }
      const result = await completion;
      await flush(result.stdioClosed === true, {
        exitCode: result.taskProcessExited ? result.exitCode : null,
        reasonCode: result.reason ?? "host_failure",
        taskProcessExited: result.taskProcessExited,
      });
      const latest = (await this.rpc(entry, { kind: "read" })).record;
      if (latest.phase !== "bound") throw new Error("SANDBOX_BINDING_LOST");
      const ref =
        latest.facts.result?.kind === "started"
          ? latest.facts.result.output.ref
          : await this.options.payloads.writeOutput(
              entry.invocation,
              result.stdout,
              "application/octet-stream",
            );
      const knownExit =
        result.taskStarted === true &&
        result.taskProcessExited &&
        result.stdioClosed === true &&
        result.exitCode !== null;
      if (plan.mode === "foreground" && !knownExit)
        console.error(
          JSON.stringify({
            event: "sandbox.exit.unknown",
            runId: plan.identity.runId,
            taskStarted: result.taskStarted === true,
            taskProcessExited: result.taskProcessExited === true,
            stdioClosed: result.stdioClosed === true,
            exitCodeKnown: result.exitCode !== null,
            reason: typeof result.reason === "string" ? result.reason.slice(0, 64) : null,
            at: new Date().toISOString(),
          }),
        );
      const reportedCompletion = await host.completed;
      const completionContradicted =
        plan.mode === "foreground" &&
        reportedCompletion !== null &&
        result.supervision?.state === "exited" &&
        (!result.taskProcessExited ||
          !result.stdioClosed ||
          result.reason !== reportedCompletion.reasonCode ||
          result.exitCode !== reportedCompletion.exitCode);
      let authenticatedDeadline = false;
      let completionRecord = latest;
      if (
        plan.mode === "foreground" &&
        !completionContradicted &&
        result.reason === "deadline" &&
        result.exitCode === null &&
        result.taskProcessExited
      ) {
        const final = await controlAccess.readFinalEvidence(host.controlBinding);
        if (
          final.taskStarted &&
          final.taskProcessExited &&
          final.stdioClosed &&
          final.srtReset &&
          final.policyDigest === compiled.policyDigest &&
          latest.facts.environment.kind === "local" &&
          final.privateDirectoryRef === latest.facts.environment.privateDirectoryRef
        ) {
          await this.reduceRisk(entry, "reconcile");
          const released = (await this.rpc(entry, { kind: "read" })).record;
          if (released.phase !== "bound") throw new Error("SANDBOX_BINDING_LOST");
          completionRecord = released;
          authenticatedDeadline = released.facts.resource.supervision === "released";
        }
      }
      let authenticatedNotStarted = false;
      if (
        plan.mode === "foreground" &&
        !completionContradicted &&
        result.taskStarted === false &&
        result.exitCode === null &&
        latest.facts.result === null
      ) {
        let final: Awaited<ReturnType<JobHostControlAccess["readFinalEvidence"]>> | undefined;
        try {
          final = await controlAccess.readFinalEvidence(host.controlBinding);
        } catch {
          final = undefined;
        }
        if (
          final &&
          final.taskStarted === false &&
          final.srtReset &&
          final.policyDigest === compiled.policyDigest &&
          latest.facts.environment.kind === "local" &&
          final.privateDirectoryRef === latest.facts.environment.privateDirectoryRef
        ) {
          await this.reduceRisk(entry, "reconcile");
          const released = (await this.rpc(entry, { kind: "read" })).record;
          if (released.phase !== "bound") throw new Error("SANDBOX_BINDING_LOST");
          completionRecord = released;
          authenticatedNotStarted = released.facts.resource.supervision === "released";
        }
      }
      const resultFields = {
        schemaVersion: "sandbox-execution.v2",
        identity: plan.identity,
        environmentId: plan.environmentId,
        policyDigest: compiled.policyDigest,
        contract: { ref: plan.operationContract.ref, version: plan.operationContract.version },
        occurredAt: this.options.clock.now(),
      };
      const output = {
        ref,
        digest: createHash("sha256").update(result.stdout).digest("hex"),
        byteLength: result.stdout.byteLength,
      };
      const evidence = () => ({
        bytes: result.stdout,
        parameters: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)),
        plan,
        scope: sandboxScopeSchema.parse(resolved.scope),
        workspace: compiled.cwd,
      });
      const fileFailure =
        knownExit && result.exitCode === 1 && plan.operationContract.kind === "verified_effect"
          ? verifiedPiWriteFailure(evidence())
          : null;
      if (
        knownExit &&
        result.exitCode === 0 &&
        plan.operationContract.kind === "verified_effect" &&
        verifyPiWriteEvidence(evidence()) !== "published"
      )
        throw new Error("PI_WRITE_EVIDENCE_INVALID");
      const boundedTermination =
        plan.mode === "foreground" &&
        !completionContradicted &&
        !authenticatedDeadline &&
        !authenticatedNotStarted &&
        latest.facts.result?.kind !== "started"
          ? result.reason === "resource_limit"
            ? sandboxResourceLimitReason(plan.resourceCeiling, result.resources)
            : result.reason === "output_limit"
              ? SANDBOX_OUTPUT_LIMIT
              : null
          : null;
      const operation = {
        effect:
          (knownExit ||
            completionContradicted ||
            authenticatedDeadline ||
            authenticatedNotStarted) &&
          plan.operationContract.kind === "fixed_read"
            ? { kind: "not_applicable" }
            : completionContradicted
              ? { kind: "unknown", reasonCode: SANDBOX_HOST_COMPLETION_CONTRADICTED }
              : authenticatedDeadline
                ? { kind: "unknown", reasonCode: "SANDBOX_TOOL_DEADLINE_EXCEEDED" }
                : boundedTermination
                  ? { kind: "unknown", reasonCode: boundedTermination }
                  : knownExit && ["command", "network_only"].includes(plan.operationContract.kind)
                    ? { kind: "not_asserted" }
                    : knownExit &&
                        (result.exitCode === 0 || fileFailure !== null) &&
                        plan.operationContract.kind === "verified_effect"
                      ? {
                          kind: "verified",
                          verifierRef: plan.operationContract.verifierRef,
                          verifierVersion: plan.operationContract.verifierVersion,
                          targetRef: plan.operationContract.targetRef,
                          evidence: { ref: output.ref, digest: output.digest },
                          occurredAt: this.options.clock.now(),
                        }
                      : latest.facts.effect,
        result:
          latest.facts.result?.kind === "started"
            ? latest.facts.result
            : completionContradicted
              ? {
                  ...resultFields,
                  kind: "error",
                  output,
                  reasonCode: "SANDBOX_HOST_COMPLETION_CONTRADICTED",
                  termination: { type: "failure" },
                }
              : authenticatedDeadline
                ? {
                    ...resultFields,
                    kind: "error",
                    output,
                    reasonCode: "SANDBOX_TOOL_DEADLINE_EXCEEDED",
                    termination: { type: "failure" },
                  }
                : authenticatedNotStarted
                  ? {
                      ...resultFields,
                      kind: "error",
                      output,
                      reasonCode: SANDBOX_TOOL_NOT_STARTED,
                      termination: { type: "failure" },
                    }
                  : boundedTermination
                    ? {
                        ...resultFields,
                        kind: "error",
                        output,
                        reasonCode: boundedTermination,
                        termination: { type: "failure" },
                      }
                    : plan.mode !== "foreground" || !knownExit
                      ? { ...resultFields, kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" }
                      : ["command", "network_only"].includes(plan.operationContract.kind) ||
                          result.exitCode === 0
                        ? {
                            ...resultFields,
                            kind: "result",
                            output,
                            completion: ["command", "network_only"].includes(
                              plan.operationContract.kind,
                            )
                              ? { type: "exit", exitCode: result.exitCode }
                              : { type: "value" },
                          }
                        : {
                            ...resultFields,
                            kind: "error",
                            output,
                            reasonCode: sandboxFileOperationFailureReason(plan, fileFailure),
                            termination: { type: "failure" },
                          },
      };
      await this.recordCompletion(entry, completionRecord, operation, result.taskProcessExited);
      if (authenticatedNotStarted) await this.reportHostLaunchFailure(entry, result);
      await this.reduceRisk(entry, "reconcile");
      return this.unknown(entry);
    } catch (error) {
      entry.host?.cancel();
      stage ??= entry.stage;
      if (!stage) return this.unknown(entry);
      const result = await entry.host?.result;
      const hostDiagnostic =
        result?.diagnostic ??
        (error instanceof JobHostPreparationError ? error.diagnostic : undefined);
      const systemCode =
        hostDiagnostic?.systemCode ??
        (error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN");
      console.error(
        JSON.stringify({
          event: "sandbox.preparation.error",
          runId: entry.identity.runId,
          stage,
          reason:
            error instanceof Error
              ? error.message.replace(/[^A-Za-z0-9_ .:-]/g, "_").slice(0, 120)
              : "UNKNOWN",
          at: new Date().toISOString(),
        }),
      );
      const diagnostic = {
        stage,
        reasonCode:
          stage === "bind"
            ? "SANDBOX_BIND_FAILED"
            : stage === "register_control" || stage === "register_preparation_control"
              ? "SANDBOX_CONTROL_REGISTRATION_FAILED"
              : stage === "execute"
                ? "SANDBOX_EXECUTION_FAILED"
                : "SANDBOX_PREPARATION_FAILED",
        hostStage: hostDiagnostic?.stage ?? null,
        hostDetail: hostDiagnostic?.detail ?? null,
        systemCode,
      };
      try {
        let parsed: SandboxPreparationDiagnostic;
        try {
          parsed = sandboxPreparationDiagnosticSchema.parse(diagnostic);
        } catch {
          parsed = sandboxPreparationDiagnosticSchema.parse({
            ...diagnostic,
            systemCode: "UNKNOWN",
          });
        }
        await this.rpc(entry, { kind: "preparation_diagnostic", diagnostic: parsed });
      } catch {}
      return this.unknown(entry);
    } finally {
      if (entry.host) {
        entry.host.cancel();
        await entry.host.result;
      }
    }
  }
  private async runInEnvironment(
    entry: Entry,
    initial: Extract<Record, { phase: "reserved" }>,
    containers: SandboxContainerRoute,
  ): Promise<SandboxWorkerResult> {
    entry.stage = "prepare";
    const plan = initial.plan;
    const tool = piCodingToolNameSchema.parse(plan.operation);
    const publication = plan.operationContract.kind === "verified_effect";
    if (
      plan.mode !== "foreground" ||
      plan.operationContract.ref !== PI_RUNNER_CONTRACT.ref ||
      (publication
        ? !HOST_PUBLICATION_CONTRACTS.get(plan.operationContract.version)?.includes(tool)
        : plan.operationContract.version !== PI_RUNNER_CONTRACT.version ||
          !CONTAINER_TOOLS.has(tool) ||
          plan.operationContract.kind !== (tool === "bash" ? "command" : "fixed_read"))
    )
      throw new Error("PI_RUNNER_CONTRACT_UNSUPPORTED");
    const binding = await this.hostBinding(plan);
    const resolved = await this.rpc(entry, { kind: "resolve" });
    const scope = resolved.resolvedScope?.scope;
    const environment = resolved.environment;
    if (
      !scope ||
      scope.authorizationRef !== plan.authorizationRef ||
      scope.operation !== plan.operation ||
      scope.schemaVersion !== "sandbox-scope.v1" ||
      scope.profileRef !== "authorized-project.v1" ||
      scope.workspaceCopy ||
      (plan.operationContract.version === PI_PREPARED_FILE_CONTRACT.version) !==
        Boolean(scope.preparedFile && scope.fileTarget) ||
      (plan.operationContract.version !== PI_PREPARED_FILE_CONTRACT.version &&
        Boolean(scope.fileTarget || scope.preparedFile)) ||
      (plan.operationContract.version === PI_DIRECTORY_MOVE_CONTRACT.version) !==
        Boolean(scope.directoryMove) ||
      (plan.operationContract.version === PI_COPY_SAVE_CONTRACT.version) !== Boolean(scope.copySave)
    )
      throw new Error("SANDBOX_SCOPE_CHANGED");
    if (
      !environment ||
      environment.identity.runId !== plan.identity.runId ||
      environment.locator.backendRef !== plan.backendRef
    )
      throw new Error("SANDBOX_ENVIRONMENT_UNAVAILABLE");
    const input = await this.options.payloads.readInput(entry.invocation);
    if (input.byteLength > 49152) throw new Error("SANDBOX_INPUT_TOO_LARGE");
    const parametersJson = new TextDecoder("utf-8", { fatal: true }).decode(input);
    const root = publication ? await resolveSandboxWorkspaceRoot({ binding, scope }) : null;
    if (publication && !root) throw new Error("SANDBOX_ROOT_UNAVAILABLE");
    const privateDirectory = path.join(binding.privateRoot, plan.identity.jobId);
    if (publication) await mkdir(privateDirectory, { mode: 0o700 });
    const grant = scope.directoryGrant;
    const runnerInput = piContainerRunnerInputSchema.parse({
      schemaVersion: "pi-container-runner.v1",
      tool,
      toolCallId: scope.toolCallId,
      hostId: plan.identity.hostId,
      canonicalRootId: grant.canonicalRootId,
      workspace: `${PI_CONTAINER_WORKSPACE_ROOT}/${grant.canonicalRootId}`,
      grantRef: grant.ref,
      grantRevision: grant.revision,
      authorizationRef: grant.authorizationRef,
      access: grant.operations.some((operation) => operation !== "read") ? "write" : "read",
      expiresAt: scope.expiresAt,
      maxOutputBytes: plan.resourceCeiling.maxOutputBytes,
      parametersJson,
    });
    const facts = sandboxExecutionFactsSchema.parse(
      this.environmentFacts(plan, initial, environment),
    );
    if (entry.cancelled || this.closed) return this.unknown(entry);
    entry.stage = "bind";
    const bound = await this.rpc(entry, { kind: "bind", expectedSequence: 1, facts });
    if (!bound.applied || entry.cancelled || this.closed) return this.unknown(entry);
    entry.stage = "execute";
    const current = await this.rpc(entry, { kind: "resolve" });
    if (
      entry.cancelled ||
      this.closed ||
      JSON.stringify(current.resolvedScope) !== JSON.stringify(resolved.resolvedScope) ||
      JSON.stringify(current.environment) !== JSON.stringify(environment)
    )
      return this.unknown(entry);
    let completed: Awaited<ReturnType<SandboxContainerRoute["execute"]>> | null = null;
    let published: "published" | "conflict" | null = null;
    const target = {
      identity: environment.identity,
      createIntentId: environment.createIntentId,
      locator: environment.locator,
      stopFence: environment.stopFence,
      invocationId: plan.identity.invocationId,
      deadlineAt: plan.effectiveDeadlineAt,
      authorizationRef: plan.authorizationRef,
    };
    try {
      if (publication && root) {
        const committed = await containers.publish({
          ...target,
          commit: async () => {
            const result = await publishPreparedPiOperation({
              hostId: plan.identity.hostId,
              tool,
              executionMode: plan.mode,
              scope: sandboxScopeSchema.parse(scope),
              workspace: root.canonicalPath,
              privateDirectory,
              commandPath: path.join(binding.runtimeRoot, "pi-tools", "bin"),
              maxOutputBytes: plan.resourceCeiling.maxOutputBytes,
              parametersJson,
            });
            return { exitCode: result.exitCode, stdout: new TextEncoder().encode(result.output) };
          },
        });
        const outcome = verifyPiWriteEvidence({
          bytes: committed.stdout,
          parameters: JSON.parse(parametersJson),
          plan,
          scope: sandboxScopeSchema.parse(scope),
          workspace: root.canonicalPath,
        });
        if (
          outcome === "not_written" ||
          (outcome === "conflict") !== (committed.exitCode === 1) ||
          committed.exitCode > 1
        )
          throw new Error("PI_WRITE_EVIDENCE_INVALID");
        published = outcome;
        completed = { ...committed, truncated: false };
      } else
        completed = await containers.execute({
          ...target,
          argv: ["node", PI_CONTAINER_RUNNER_PATH, JSON.stringify(runnerInput)],
        });
    } catch {
      completed = null;
    }
    const resultFields = {
      schemaVersion: "sandbox-execution.v2",
      identity: plan.identity,
      environmentId: plan.environmentId,
      policyDigest: facts.environment.policyDigest,
      contract: { ref: plan.operationContract.ref, version: plan.operationContract.version },
      occurredAt: this.options.clock.now(),
    };
    if (!completed) {
      await this.rpc(entry, {
        kind: "append",
        expectedSequence: 2,
        expectedOperationRevision: 0,
        facts: sandboxExecutionFactsSchema.parse({
          ...facts,
          result: { ...resultFields, kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" },
          resource: {
            ...facts.resource,
            sequence: 3,
            occurredAt: this.options.clock.now(),
            supervision: "lost",
            cleanup: "unknown",
            reasonCode: "CONTAINER_EXECUTE_UNKNOWN",
          },
        }),
      });
      return this.unknown(entry);
    }
    const ref = await this.options.payloads.writeOutput(
      entry.invocation,
      completed.stdout,
      "application/octet-stream",
    );
    const output = {
      ref,
      digest: createHash("sha256").update(completed.stdout).digest("hex"),
      byteLength: completed.stdout.byteLength,
    };
    const command = plan.operationContract.kind === "command";
    const settled = sandboxExecutionFactsSchema.parse({
      ...facts,
      result: published
        ? published === "conflict"
          ? {
              ...resultFields,
              kind: "error",
              output,
              reasonCode: "FILE_VERSION_CONFLICT",
              termination: { type: "failure" },
            }
          : { ...resultFields, kind: "result", output, completion: { type: "value" } }
        : completed.truncated
          ? {
              ...resultFields,
              kind: "error",
              output,
              reasonCode: SANDBOX_OUTPUT_LIMIT,
              termination: { type: "failure" },
            }
          : command || completed.exitCode === 0
            ? {
                ...resultFields,
                kind: "result",
                output,
                completion: command
                  ? { type: "exit", exitCode: completed.exitCode }
                  : { type: "value" },
              }
            : {
                ...resultFields,
                kind: "error",
                output,
                reasonCode: "SANDBOX_OPERATION_FAILED",
                termination: { type: "failure" },
              },
      effect: published
        ? plan.operationContract.kind === "verified_effect"
          ? {
              kind: "verified",
              verifierRef: plan.operationContract.verifierRef,
              verifierVersion: plan.operationContract.verifierVersion,
              targetRef: plan.operationContract.targetRef,
              evidence: { ref: output.ref, digest: output.digest },
              occurredAt: this.options.clock.now(),
            }
          : { kind: "unknown", reasonCode: "SANDBOX_OPERATION_FAILED" }
        : completed.truncated
          ? { kind: "unknown", reasonCode: SANDBOX_OUTPUT_LIMIT }
          : command
            ? { kind: "not_asserted" }
            : { kind: "not_applicable" },
      resource: {
        ...facts.resource,
        sequence: 3,
        occurredAt: this.options.clock.now(),
        supervision: "stopping",
        cleanup: "pending",
        reasonCode: "CONTAINER_CALL_RETURNED",
      },
    });
    const stopping = await this.rpc(entry, {
      kind: "append",
      expectedSequence: 2,
      expectedOperationRevision: 0,
      facts: settled,
    });
    const { reasonCode: _reason, ...resourceFields } =
      settled.resource as typeof settled.resource & {
        reasonCode?: string;
      };
    await this.rpc(entry, {
      kind: "append",
      expectedSequence: 3,
      expectedOperationRevision: stopping.record.operationRevision,
      facts: sandboxExecutionFactsSchema.parse({
        ...settled,
        resource: {
          ...resourceFields,
          sequence: 4,
          occurredAt: this.options.clock.now(),
          supervision: "released",
          cleanup: "confirmed",
          evidence: {
            ...taskEnvironmentCallEvidence({
              environmentId: environment.identity.environmentId,
              invocationId: plan.identity.invocationId,
              createIntentId: environment.createIntentId,
              runtimeInstanceId: environment.locator.runtimeInstanceId,
              runtimeEnvironmentId: environment.locator.runtimeEnvironmentId,
            }),
            qualificationRef: plan.binding.qualificationRef,
            profileRef: plan.binding.profileRef,
            validUntil: plan.effectiveDeadlineAt,
            subject: {
              kind: "task_environment",
              environmentId: environment.identity.environmentId,
            },
          },
        },
      }),
    });
    return this.unknown(entry);
  }
  prewarmSrtEnvironment(request: EnvironmentPrewarmRequest): Promise<void> {
    const environments = this.options.srtEnvironments;
    if (!environments || this.closed || request.backendRef !== SRT_TASK_ENVIRONMENT_BACKEND_REF)
      throw new Error("SANDBOX_ENVIRONMENT_UNAVAILABLE");
    const started = performance.now();
    const log = (event: string, fields: object) =>
      console.error(
        JSON.stringify({
          event,
          runId: request.identity.runId,
          environmentId: request.identity.environmentId,
          ...fields,
          totalMs: Math.round(performance.now() - started),
          at: new Date().toISOString(),
        }),
      );
    return this.prewarm(request, environments).then(
      (sessions) => log("sandbox.srt_prewarm.finished", { sessions }),
      (error: unknown) =>
        log("sandbox.srt_prewarm.failed", {
          reasonCode: error instanceof Error ? error.message : "SRT_PREWARM_FAILED",
        }),
    );
  }
  private async prewarm(
    request: EnvironmentPrewarmRequest,
    environments: Pick<SrtTaskEnvironmentBackend, "session">,
  ) {
    const binding = await this.capabilityBinding({
      capabilityRef: request.capabilityRef,
      capabilityVersion: request.capabilityVersion,
      hostId: request.identity.hostId,
    });
    const root = binding.roots.find((item) => item.canonicalRootId === request.canonicalRootId);
    if (!root) throw new Error("SANDBOX_ROOT_UNAVAILABLE");
    const started = await Promise.all(
      SRT_PREWARM_SESSIONS.map(async (kind) => {
        const descriptor = binding.operationBindings?.find(
          (item) =>
            item.backendRef === SRT_BACKEND_REF &&
            item.scopeSource === "grant_targets" &&
            item.network === "disabled" &&
            srtTaskEnvironmentSession({
              mode: item.mode,
              operation: item.operation,
              operationContract: item.contract,
            }) === kind,
        );
        if (!descriptor || this.closed) return null;
        const { request: sessionRequest } = await this.srtSessionRequest({
          binding,
          workspace: root.canonicalPath,
          environment: request,
          kind,
          writable: descriptor.directoryOperations.some((operation) => operation !== "read"),
          allowedDomains: [],
        });
        await environments.session({
          target: {
            identity: request.identity,
            createIntentId: request.createIntentId,
            locator: request.locator,
          },
          kind,
          request: sessionRequest,
        });
        return kind;
      }),
    );
    return started.filter((kind) => kind !== null);
  }
  private async srtSessionRequest(input: {
    readonly binding: Awaited<ReturnType<ProductionSandboxExecutionV2["capabilityBinding"]>>;
    readonly workspace: string;
    readonly environment: {
      readonly identity: ExecutionEnvironmentIdentity;
      readonly locator: ExecutionEnvironmentLocator;
    };
    readonly kind: SrtTaskEnvironmentSessionKind;
    readonly writable: boolean;
    readonly allowedDomains: readonly string[];
  }) {
    const { binding, workspace, environment, kind } = input;
    const jobId = srtTaskEnvironmentJobId(environment.identity.environmentId, kind);
    const { policy, compiled } = await prepareJobPolicy({
      workspace,
      privateRoot: binding.privateRoot,
      jobId,
      writable: input.writable,
      readOnlyToolchainPaths: [binding.runtimeRoot, ...binding.readOnlyToolchainPaths],
      protectedPaths: [
        ...binding.protectedPaths,
        ...[
          ".env",
          ".git",
          ".himawari-trash",
          ...(kind === "file_write" ? [] : [".himawari-recovery"]),
        ].map((name) => path.join(workspace, name)),
      ],
      allowedDomains: input.allowedDomains,
    });
    return {
      policy,
      compiled,
      request: {
        jobId,
        attemptId: `${kind}-${environment.locator.runtimeEnvironmentId.slice(0, 24)}`,
        policy,
        policyDigest: compiled.policyDigest,
        executable: binding.executable.path,
        args: [
          binding.runner.path,
          binding.hostId,
          this.options.peer.workerInstanceId,
          PI_RESIDENT_RUNNER_FLAG,
          binding.runtimeRoot,
        ],
        maxOutputBytes: binding.maximumResourceCeiling.maxOutputBytes,
        cleanupTimeoutMs: 5000,
      },
    };
  }
  private async runInSrtEnvironment(
    entry: Entry,
    initial: Extract<Record, { phase: "reserved" }>,
    environments: Pick<SrtTaskEnvironmentBackend, "session">,
  ): Promise<SandboxWorkerResult> {
    entry.stage = "prepare";
    const plan = initial.plan;
    const kind = srtTaskEnvironmentSession(plan);
    if (!kind) throw new Error("PI_RUNNER_CONTRACT_UNSUPPORTED");
    const timing = srtCallTiming(plan.identity.runId, plan.identity.invocationId, kind);
    const binding = await this.hostBinding(plan);
    timing.mark("host_binding");
    const resolved = await this.rpc(entry, { kind: "resolve" });
    timing.mark("resolve");
    const resolvedScope = resolved.resolvedScope;
    const scope = resolvedScope?.scope;
    const environment = resolved.environment;
    if (
      !resolvedScope ||
      !scope ||
      scope.authorizationRef !== plan.authorizationRef ||
      scope.operation !== plan.operation ||
      scope.schemaVersion !== "sandbox-scope.v1" ||
      scope.profileRef !== "authorized-project.v1" ||
      scope.workspaceCopy ||
      scope.fileTarget ||
      scope.preparedFile ||
      scope.directoryMove ||
      scope.copySave ||
      !scope.directoryGrant
    )
      throw new Error("SANDBOX_SCOPE_CHANGED");
    if (
      !environment ||
      environment.identity.runId !== plan.identity.runId ||
      environment.locator.backendRef !== plan.backendRef
    )
      throw new Error("SANDBOX_ENVIRONMENT_UNAVAILABLE");
    const root = await resolveSandboxWorkspaceRoot({ binding, scope });
    if (!root) throw new Error("SANDBOX_ROOT_UNAVAILABLE");
    timing.mark("workspace_root");
    const { policy, compiled, request } = await this.srtSessionRequest({
      binding,
      workspace: root.canonicalPath,
      environment,
      kind,
      writable: scope.directoryGrant.operations.some((operation) => operation !== "read"),
      allowedDomains: resolvedScope.allowedDomains,
    });
    timing.mark("job_policy");
    const input = await this.options.payloads.readInput(entry.invocation);
    timing.mark("read_input");
    if (input.byteLength > 49152) throw new Error("SANDBOX_INPUT_TOO_LARGE");
    const parametersJson = new TextDecoder("utf-8", { fatal: true }).decode(input);
    const runnerInput = Buffer.from(
      JSON.stringify(
        piRunnerInputSchema.parse({
          schemaVersion: "pi-runner.v1",
          workerInstanceId: this.options.peer.workerInstanceId,
          tool: piCodingToolNameSchema.parse(plan.operation),
          executionMode: plan.mode,
          scope,
          workspace: compiled.cwd,
          runtimeRoot: binding.runtimeRoot,
          privateDirectory: policy.privateDirectory,
          maxOutputBytes: plan.resourceCeiling.maxOutputBytes,
          parametersJson,
        }),
      ),
    );
    if (entry.cancelled || this.closed) return this.unknown(entry);
    const session = await environments.session({
      target: {
        identity: environment.identity,
        createIntentId: environment.createIntentId,
        locator: environment.locator,
      },
      kind,
      request,
    });
    timing.mark("session");
    const facts = sandboxExecutionFactsSchema.parse(
      this.environmentFacts(plan, initial, environment),
    );
    if (entry.cancelled || this.closed) return this.unknown(entry);
    entry.stage = "bind";
    const bound = await this.rpc(entry, { kind: "bind", expectedSequence: 1, facts });
    timing.mark("bind");
    if (!bound.applied || entry.cancelled || this.closed) return this.unknown(entry);
    entry.stage = "execute";
    const current = await this.rpc(entry, { kind: "resolve" });
    timing.mark("resolve_bound");
    if (
      entry.cancelled ||
      this.closed ||
      JSON.stringify(current.resolvedScope) !== JSON.stringify(resolvedScope) ||
      JSON.stringify(current.environment) !== JSON.stringify(environment)
    )
      return this.unknown(entry);
    const resultFields = () => ({
      schemaVersion: "sandbox-execution.v2",
      identity: plan.identity,
      environmentId: plan.environmentId,
      policyDigest: facts.environment.policyDigest,
      contract: { ref: plan.operationContract.ref, version: plan.operationContract.version },
      occurredAt: this.options.clock.now(),
    });
    const lost = async (reasonCode: string) => {
      const latest = (await this.rpc(entry, { kind: "read" })).record;
      if (latest.phase !== "bound" || latest.facts.resource.supervision !== "initializing") return;
      await this.rpc(entry, {
        kind: "append",
        expectedSequence: latest.facts.resource.sequence,
        expectedOperationRevision: latest.operationRevision,
        facts: sandboxExecutionFactsSchema.parse({
          ...latest.facts,
          result: { ...resultFields(), kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" },
          resource: {
            ...latest.facts.resource,
            sequence: latest.facts.resource.sequence + 1,
            occurredAt: this.options.clock.now(),
            supervision: "lost",
            cleanup: "unknown",
            reasonCode,
          },
        }),
      });
    };
    const settle = async (operation: object, namespaceSwept: boolean) => {
      const latest = (await this.rpc(entry, { kind: "read" })).record;
      if (latest.phase !== "bound" || latest.facts.resource.supervision !== "initializing")
        throw new Error("SANDBOX_BINDING_LOST");
      const stoppingFacts = sandboxExecutionFactsSchema.parse({
        ...latest.facts,
        ...operation,
        resource: {
          ...latest.facts.resource,
          sequence: latest.facts.resource.sequence + 1,
          occurredAt: this.options.clock.now(),
          supervision: "stopping",
          cleanup: "pending",
          reasonCode: "SRT_COMMAND_SETTLED",
        },
      });
      const stopping = await this.rpc(entry, {
        kind: "append",
        expectedSequence: latest.facts.resource.sequence,
        expectedOperationRevision: latest.operationRevision,
        facts: stoppingFacts,
      });
      const { reasonCode: _reason, ...resourceFields } =
        stoppingFacts.resource as typeof stoppingFacts.resource & { reasonCode?: string };
      await this.rpc(entry, {
        kind: "append",
        expectedSequence: stoppingFacts.resource.sequence,
        expectedOperationRevision: stopping.record.operationRevision,
        facts: sandboxExecutionFactsSchema.parse({
          ...stoppingFacts,
          resource: {
            ...resourceFields,
            sequence: stoppingFacts.resource.sequence + 1,
            occurredAt: this.options.clock.now(),
            supervision: "released",
            cleanup: "process_group_gone",
            ...(namespaceSwept ? { cleanupScope: "pid_namespace" } : {}),
            evidence: {
              ...taskEnvironmentCallEvidence({
                environmentId: environment.identity.environmentId,
                invocationId: plan.identity.invocationId,
                createIntentId: environment.createIntentId,
                runtimeInstanceId: environment.locator.runtimeInstanceId,
                runtimeEnvironmentId: environment.locator.runtimeEnvironmentId,
              }),
              qualificationRef: plan.binding.qualificationRef,
              profileRef: plan.binding.profileRef,
              validUntil: plan.effectiveDeadlineAt,
              subject: {
                kind: "task_environment",
                environmentId: environment.identity.environmentId,
              },
            },
          },
        }),
      });
    };
    let run: ReturnType<SrtTaskEnvironmentSession["run"]> | undefined;
    try {
      try {
        run = session.run(
          {
            attemptId: plan.identity.attemptId,
            policyDigest: compiled.policyDigest,
            deadlineAt: plan.effectiveDeadlineAt,
            maxOutputBytes: plan.resourceCeiling.maxOutputBytes,
            inputBase64: runnerInput.toString("base64"),
            resourceLimits: {
              maxCpuTimeMs: plan.resourceCeiling.maxCpuTimeMs,
              maxMemoryBytes: plan.resourceCeiling.maxMemoryBytes,
            },
          },
          async () => {
            if (entry.cancelled || this.closed) throw new Error("SANDBOX_STOPPED");
            const latest = (await this.freshResolve(entry)).resolvedScope;
            if (
              entry.cancelled ||
              this.closed ||
              JSON.stringify(latest) !== JSON.stringify(resolvedScope)
            )
              throw new Error("SANDBOX_SCOPE_CHANGED");
          },
        );
      } catch (error) {
        const reason =
          error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
            ? error.message
            : "SRT_COMMAND_NOT_LAUNCHED";
        console.error(
          JSON.stringify({
            event: "sandbox.command.not_launched",
            runId: plan.identity.runId,
            reason,
            at: new Date().toISOString(),
          }),
        );
        const empty = new Uint8Array();
        const ref = await this.options.payloads.writeOutput(
          entry.invocation,
          empty,
          "application/octet-stream",
        );
        await settle(
          {
            result: {
              ...resultFields(),
              kind: "error",
              output: {
                ref,
                digest: createHash("sha256").update(empty).digest("hex"),
                byteLength: 0,
              },
              reasonCode: SANDBOX_TOOL_NOT_STARTED,
              termination: { type: "failure" },
            },
            effect: { kind: "unknown", reasonCode: "SANDBOX_NOT_STARTED" },
          },
          false,
        );
        return this.unknown(entry);
      }
      const active = run;
      void active.started.then(
        () => timing.finish("command_started"),
        () => timing.finish("command_not_started"),
      );
      const flush = this.outputStream(entry, plan, (offset, limit, channel) =>
        active.readOutput(offset, limit, channel),
      );
      let finished = false;
      const completion = active.result.finally(() => {
        finished = true;
      });
      const tolerance = new BrokerPollTolerance();
      while (!finished) {
        await Promise.race([completion, delay(250)]);
        if (finished) break;
        if (entry.cancelled || this.closed) {
          active.cancel("cancelled");
          continue;
        }
        try {
          await this.resolveRecord(entry);
          if (finished) break;
          await flush(false);
          tolerance.succeeded();
        } catch (error) {
          const decision = tolerance.failed(error);
          if (decision !== "cancel") {
            if (decision === "retry_first")
              console.error(
                JSON.stringify({
                  event: "sandbox.command.poll_retry",
                  runId: plan.identity.runId,
                  at: new Date().toISOString(),
                }),
              );
            continue;
          }
          console.error(
            JSON.stringify({
              event: "sandbox.command.cancelled_by_poll_error",
              runId: plan.identity.runId,
              reason:
                error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
                  ? error.message
                  : "SRT_POLL_FAILED",
              at: new Date().toISOString(),
            }),
          );
          active.cancel("cancelled");
        }
      }
      const outcome = await completion;
      await flush(outcome.stdioClosed, {
        exitCode: outcome.taskProcessExited ? outcome.exitCode : null,
        reasonCode: outcome.reason,
        taskProcessExited: outcome.taskProcessExited,
      });
      if (!outcome.settled) {
        await lost("SRT_COMMAND_UNSETTLED");
        return this.unknown(entry);
      }
      const ref = await this.options.payloads.writeOutput(
        entry.invocation,
        outcome.stdout,
        "application/octet-stream",
      );
      const output = {
        ref,
        digest: createHash("sha256").update(outcome.stdout).digest("hex"),
        byteLength: outcome.stdout.byteLength,
      };
      const knownExit =
        outcome.taskStarted &&
        outcome.taskProcessExited &&
        outcome.stdioClosed &&
        outcome.exitCode !== null;
      if (!knownExit)
        console.error(
          JSON.stringify({
            event: "sandbox.exit.unknown",
            runId: plan.identity.runId,
            taskStarted: outcome.taskStarted === true,
            taskProcessExited: outcome.taskProcessExited === true,
            stdioClosed: outcome.stdioClosed === true,
            exitCodeKnown: outcome.exitCode !== null,
            reason: typeof outcome.reason === "string" ? outcome.reason.slice(0, 64) : null,
            at: new Date().toISOString(),
          }),
        );
      const command = plan.operationContract.kind === "command";
      const evidence = () => ({
        bytes: outcome.stdout,
        parameters: JSON.parse(parametersJson),
        plan,
        scope: sandboxScopeSchema.parse(scope),
        workspace: compiled.cwd,
      });
      const fileFailure =
        knownExit && outcome.exitCode === 1 && !command ? verifiedPiWriteFailure(evidence()) : null;
      if (
        knownExit &&
        outcome.exitCode === 0 &&
        !command &&
        verifyPiWriteEvidence(evidence()) !== "published"
      )
        throw new Error("PI_WRITE_EVIDENCE_INVALID");
      const fields = resultFields();
      const failure = (reasonCode: string) => ({
        ...fields,
        kind: "error",
        output,
        reasonCode,
        termination: { type: "failure" },
      });
      const limitTermination =
        outcome.reason === "output_limit"
          ? SANDBOX_OUTPUT_LIMIT
          : outcome.reason === "resource_limit"
            ? sandboxResourceLimitReason(plan.resourceCeiling, outcome.resources)
            : null;
      const operation =
        limitTermination !== null
          ? {
              result: failure(limitTermination),
              effect: { kind: "unknown", reasonCode: limitTermination },
            }
          : knownExit && outcome.exitCode !== null
            ? {
                result:
                  command || outcome.exitCode === 0
                    ? {
                        ...fields,
                        kind: "result",
                        output,
                        completion: command
                          ? { type: "exit", exitCode: outcome.exitCode }
                          : { type: "value" },
                      }
                    : failure(sandboxFileOperationFailureReason(plan, fileFailure)),
                effect:
                  plan.operationContract.kind !== "verified_effect"
                    ? { kind: "not_asserted" }
                    : outcome.exitCode === 0 || fileFailure !== null
                      ? {
                          kind: "verified",
                          verifierRef: plan.operationContract.verifierRef,
                          verifierVersion: plan.operationContract.verifierVersion,
                          targetRef: plan.operationContract.targetRef,
                          evidence: { ref: output.ref, digest: output.digest },
                          occurredAt: this.options.clock.now(),
                        }
                      : { kind: "unknown", reasonCode: "SANDBOX_OPERATION_FAILED" },
              }
            : outcome.reason === "deadline"
              ? {
                  result: failure("SANDBOX_TOOL_DEADLINE_EXCEEDED"),
                  effect: { kind: "unknown", reasonCode: "SANDBOX_TOOL_DEADLINE_EXCEEDED" },
                }
              : {
                  result: { ...fields, kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" },
                  effect: { kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" },
                };
      await settle(operation, outcome.namespaceSwept === true);
      return this.unknown(entry);
    } catch (error) {
      run?.cancel("cancelled");
      if (run) await run.result.catch(() => undefined);
      const reason =
        error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
          ? error.message
          : "SRT_EXECUTION_FAILED";
      console.error(
        JSON.stringify({
          event: "sandbox.execution.lost",
          runId: plan.identity.runId,
          reason,
          at: new Date().toISOString(),
        }),
      );
      try {
        await lost(reason);
      } catch {}
      return this.unknown(entry);
    }
  }
  private outputStream(
    entry: Entry,
    plan: SandboxExecutionPlanV2,
    read: (
      offset: number,
      limit: number,
      channel?: "stdout",
    ) => { readonly bytes: Uint8Array; readonly nextOffset: number; readonly end: boolean },
  ) {
    let streamIndex = 0;
    let streamOffset = 0;
    let streamEnded = false;
    return async (final: boolean, termination?: SandboxTaskTermination) => {
      if (streamEnded) return;
      for (;;) {
        const page = read(streamOffset, 32768, plan.mode === "foreground" ? "stdout" : undefined);
        if (page.bytes.length === 0 && !final) return;
        let record = entry.record;
        if (
          !record ||
          record.phase !== "bound" ||
          (plan.mode !== "foreground" && !record.facts.environment.resourceRef)
        )
          throw new Error("SANDBOX_STREAM_BINDING_LOST");
        const chunk = {
          index: streamIndex,
          offset: streamOffset,
          bytesBase64: Buffer.from(page.bytes).toString("base64"),
          end: final && page.end,
          ...(final && page.end && termination ? { termination } : {}),
        };
        for (let attempt = 1; ; attempt++) {
          try {
            await this.rpc(entry, {
              kind: "append_output",
              resourceRef: plan.mode === "foreground" ? null : record.facts.environment.resourceRef,
              expectedSequence: record.facts.resource.sequence,
              chunk,
            });
            break;
          } catch (error) {
            const latest = (await this.rpc(entry, { kind: "read" })).record;
            if (
              attempt >= COMPLETION_RECORD_ATTEMPTS ||
              latest.phase !== "bound" ||
              latest.plan.semanticFingerprint !== record.plan.semanticFingerprint ||
              JSON.stringify(latest.facts.environment) !==
                JSON.stringify(record.facts.environment) ||
              latest.facts.resource.sequence <= record.facts.resource.sequence
            )
              throw error;
            record = latest;
          }
        }
        streamIndex++;
        streamOffset = page.nextOffset;
        streamEnded = final && page.end;
        if (page.end || page.bytes.length === 0) return;
      }
    };
  }
  private environmentFacts(
    plan: SandboxExecutionPlanV2,
    initial: Extract<Record, { phase: "reserved" }>,
    environment: SandboxTaskEnvironmentBinding,
  ) {
    const supervisor = {
      supervisorId: environment.locator.runtimeEnvironmentId,
      bootId: environment.locator.runtimeInstanceId,
      epoch: 1,
    };
    return {
      schemaVersion: "sandbox-execution.v2",
      environment: {
        schemaVersion: "sandbox-execution.v2",
        kind: "container",
        environmentId: plan.environmentId,
        taskEnvironmentId: environment.identity.environmentId,
        resourceRef: null,
        creator: plan.identity,
        mode: plan.mode,
        backendRef: plan.backendRef,
        authorizationRef: plan.authorizationRef,
        scopeDigest: plan.binding.scopeDigest,
        policyDigest: environment.locator.effectivePolicyDigest,
        deadlineAt: plan.effectiveDeadlineAt,
        supervisor,
        workspaceConflictRefs: initial.reservation.workspaceConflictRefs,
        executionJobId: environment.identity.executionJobId,
        environmentGeneration: environment.identity.environmentGeneration,
        runtimeInstanceId: environment.locator.runtimeInstanceId,
        runtimeEnvironmentId: environment.locator.runtimeEnvironmentId,
        createIntentId: environment.createIntentId,
        stopFence: environment.stopFence,
      },
      result: null,
      effect: { kind: "unknown", reasonCode: "SANDBOX_NOT_STARTED" },
      resource: {
        schemaVersion: "sandbox-execution.v2",
        environmentId: plan.environmentId,
        creator: plan.identity,
        policyDigest: environment.locator.effectivePolicyDigest,
        scopeDigest: plan.binding.scopeDigest,
        sequence: 2,
        occurredAt: this.options.clock.now(),
        supervisor,
        resourceRef: null,
        status: { kind: "foreground" },
        metrics: null,
        supervision: "initializing",
        cleanup: "pending",
      },
    };
  }
  private entry(request: Control) {
    const entry = this.entries.get(request.payload.targetRequestId);
    if (!entry || JSON.stringify(entry.request.scope) !== JSON.stringify(request.scope))
      throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
    return entry;
  }
  private async recordCompletion(
    entry: Entry,
    initial: Extract<Record, { phase: "bound" }>,
    operation: { readonly effect: unknown; readonly result: unknown },
    taskProcessExited: boolean,
  ) {
    let current = initial;
    for (let attempt = 1; ; attempt++) {
      current = await this.afterRecovery(entry, current);
      if (current.facts.result?.kind === "result" || current.facts.result?.kind === "error") return;
      const { evidence: _evidence, ...resource } = current.facts
        .resource as typeof current.facts.resource & { evidence?: unknown };
      try {
        await this.rpc(
          entry,
          resource.supervision === "released"
            ? {
                kind: "operation",
                expectedSequence: resource.sequence,
                expectedOperationRevision: current.operationRevision,
                facts: sandboxExecutionFactsSchema.parse({ ...current.facts, ...operation }),
              }
            : {
                kind: "append",
                expectedSequence: resource.sequence,
                expectedOperationRevision: current.operationRevision,
                facts: sandboxExecutionFactsSchema.parse({
                  ...current.facts,
                  ...operation,
                  resource: {
                    ...resource,
                    ...(resource.status.kind === "task" && taskProcessExited
                      ? { status: { kind: "task", state: "exited" } }
                      : {}),
                    sequence: resource.sequence + 1,
                    occurredAt: this.options.clock.now(),
                    supervision: "lost",
                    cleanup: "unknown",
                    reasonCode: "SANDBOX_CLEANUP_UNCONFIRMED",
                  },
                }),
              },
        );
        return;
      } catch (error) {
        const latest = (await this.rpc(entry, { kind: "read" })).record;
        if (
          attempt >= COMPLETION_RECORD_ATTEMPTS ||
          latest.phase !== "bound" ||
          (latest.facts.resource.sequence === resource.sequence &&
            latest.operationRevision === current.operationRevision)
        )
          throw error;
        current = latest;
      }
    }
  }
  private async afterRecovery(entry: Entry, record: Extract<Record, { phase: "bound" }>) {
    const waitUntil = performance.now() + RECOVERY_SETTLE_WAIT_MS;
    let current = record;
    while (current.facts.resource.supervision === "reconciling") {
      if (performance.now() >= waitUntil) throw new Error("SANDBOX_RECOVERY_UNSETTLED");
      await delay(RECOVERY_POLL_MS);
      const latest = (await this.rpc(entry, { kind: "read" })).record;
      if (latest.phase !== "bound") throw new Error("SANDBOX_BINDING_LOST");
      current = latest;
    }
    return current;
  }
  private async reportHostLaunchFailure(entry: Entry, result: Awaited<SandboxJobHost["result"]>) {
    const host = result.diagnostic;
    try {
      await this.rpc(entry, {
        kind: "preparation_diagnostic",
        diagnostic: sandboxPreparationDiagnosticSchema.parse({
          stage: "execute",
          reasonCode: "SANDBOX_EXECUTION_FAILED",
          hostStage: host?.stage ?? null,
          hostDetail: host?.detail ?? null,
          systemCode: host?.systemCode ?? "UNKNOWN",
        }),
      });
    } catch {}
  }
  private async reduceRisk(entry: Entry, kind: "reconcile" | "stop") {
    const record = (await this.rpc(entry, { kind: "read" })).record;
    if (record.phase !== "bound") return;
    await this.rpc(
      entry,
      kind === "reconcile"
        ? { kind, expectedSequence: record.facts.resource.sequence }
        : {
            kind,
            reason: "owner_cancelled",
            expectedSequence: record.facts.resource.sequence,
            resourceRef: record.facts.environment.resourceRef,
          },
    );
  }
  async cancel(request: Extract<Control, { type: "work.cancel" }>) {
    const entry = this.entry(request);
    entry.cancelled = true;
    entry.host?.cancel();
  }
  async reconcile(request: Extract<Control, { type: "work.reconcile" }>) {
    const entry = this.entry(request);
    if (request.payload.externalActionId !== sandboxExternalActionId(entry.identity))
      throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
    await this.reduceRisk(entry, "reconcile");
    return this.unknown(entry);
  }
  async shutdown() {
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.cancelled = true;
      entry.host?.cancel();
    }
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.supervision));
  }
}

function srtCallTiming(runId: string, invocationId: string, session: string) {
  const started = performance.now();
  let last = started;
  const stages: { [stage: string]: number } = {};
  const mark = (stage: string) => {
    const now = performance.now();
    stages[stage] = Math.round(now - last);
    last = now;
    return now;
  };
  return {
    mark,
    finish(stage: string) {
      const now = mark(stage);
      console.error(
        JSON.stringify({
          event: "sandbox.srt_call.timing",
          runId,
          invocationId,
          session,
          stages,
          totalMs: Math.round(now - started),
          at: new Date().toISOString(),
        }),
      );
    },
  };
}
