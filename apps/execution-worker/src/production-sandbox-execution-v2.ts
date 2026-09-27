import { createHash } from "node:crypto";
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
  PI_RUNNER_CONTRACT,
  piCodingToolNameSchema,
  piContainerRunnerInputSchema,
  piRunnerInputSchema,
  type SandboxExecutionBrokerCommand,
  type SandboxExecutionPlanV2,
  type SandboxTaskEnvironmentBinding,
  type SandboxTaskTermination,
  sandboxExecutionFactsSchema,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import {
  CapabilityDeploymentSnapshotLoader,
  hasVerifiedPiFileConflict,
  publishPreparedPiOperation,
  resolveSandboxWorkspaceRoot,
  revalidateCapabilityDeploymentSnapshot,
  verifyPiWriteEvidence,
  verifySandboxHost,
} from "@himawari-agent/platform-node";
import {
  prepareJobPolicy,
  prepareSandboxJobHost,
  type SandboxJobHost,
} from "@himawari-agent/runtime-sandbox";
import { sandboxInvocationFromRequest } from "./broker-sandbox-execution.js";
import type { ProductionPayloadBrokerClient } from "./production-payload-broker-client.js";
import {
  type SandboxWorkerResult,
  sandboxExternalActionId,
} from "./production-sandbox-execution.js";

type Execute = Extract<ExecutionV2Request, { type: "work.execute" }>;
type Control = Extract<ExecutionV2Request, { type: "work.cancel" | "work.reconcile" }>;
type Record = PayloadBrokerSandboxExecutionResult["payload"]["record"];
interface Entry {
  identity: NonNullable<Execute["payload"]["sandboxExecution"]>["identity"];
  request: Execute;
  invocation: CapabilityInvocationRequest;
  cancelled: boolean;
  host?: SandboxJobHost;
  record?: Record;
  completion?: Promise<SandboxWorkerResult>;
  supervision?: Promise<void>;
  acknowledge?: (result: SandboxWorkerResult) => void;
}
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
}
const COMPLETION_RECORD_ATTEMPTS = 5;
const RECOVERY_SETTLE_WAIT_MS = 35000;
const RECOVERY_POLL_MS = 250;
const CONTAINER_TOOLS = new Set(["read", "bash", "find", "grep", "ls"]);
const HOST_PUBLICATION_CONTRACTS: ReadonlyMap<string, readonly string[]> = new Map([
  [PI_PREPARED_FILE_CONTRACT.version, ["write", "edit"]],
  [PI_DIRECTORY_MOVE_CONTRACT.version, ["move_directory"]],
  [PI_COPY_SAVE_CONTRACT.version, ["save_copy"]],
]);
/** Foreground v2 supervision through the existing broker. Unsupported operation
 * contracts never fall back to a generic or v1 runner. No database lives here. */
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
  private async hostBinding(plan: SandboxExecutionPlanV2) {
    const deployment = this.options.configuration.capabilityDeployment;
    if (!deployment) throw new Error("SANDBOX_DEPLOYMENT_UNAVAILABLE");
    const loaded = await revalidateCapabilityDeploymentSnapshot(await this.admitted);
    const entry = loaded.snapshot.capabilities.find(
      (item) =>
        item.manifest.ref === plan.capabilityRef &&
        item.manifest.version === plan.capabilityVersion,
    );
    if (!entry || entry.binding.kind !== "sandbox" || !entry.qualification.sandbox)
      throw new Error("SANDBOX_HOST_UNAVAILABLE");
    await verifySandboxHost({
      binding: entry.binding.value,
      qualification: entry.qualification.sandbox,
      hostId: plan.identity.hostId,
      plan,
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
    try {
      const initial = (await this.rpc(entry, { kind: "read" })).record;
      this.assertRequest(entry, initial.plan);
      // A bound or recovered execution is never a launch instruction.
      if (initial.phase !== "reserved") return this.unknown(entry);
      if (entry.cancelled || this.closed) return this.unknown(entry);
      const plan = initial.plan;
      if (this.options.containers && plan.backendRef === this.options.containers.backendRef)
        return await this.runInEnvironment(entry, initial, this.options.containers);
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
      const controlDirectory = path.join(
        binding.privateRoot,
        `control-${createHash("sha256").update(JSON.stringify(plan.identity)).digest("hex").slice(0, 20)}`,
      );
      // An existing control directory is an unresolved prior environment, not a retry target.
      await mkdir(controlDirectory, { mode: 0o700 });
      const input = await this.options.payloads.readInput(entry.invocation);
      if (input.byteLength > 49152) throw new Error("SANDBOX_INPUT_TOO_LARGE");
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
          // Concurrent egress checks must not replace the supervision loop's
          // record with an older snapshot returned by a delayed read.
          const current = (
            await this.options.payloads.sandboxExecution(entry.invocation, entry.identity, {
              kind: "resolve",
            })
          ).resolvedScope;
          if (
            entry.cancelled ||
            this.closed ||
            JSON.stringify(current) !== JSON.stringify(resolved)
          )
            throw new Error("SANDBOX_SCOPE_CHANGED");
        },
      );
      entry.host = host;
      await host.ready;
      const identity = host.inspect();
      if (!identity || !host.controlBinding) throw new Error("SANDBOX_SUPERVISOR_UNAVAILABLE");
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
      const started = await this.rpc(entry, { kind: "bind", expectedSequence: 1, facts });
      if (!started.applied || entry.cancelled || this.closed) {
        host.cancel();
        return this.unknown(entry);
      }
      // Agent revalidates scope and installed bytes in the bind CAS. Host start is single-use.
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
      let streamIndex = 0;
      let streamOffset = 0;
      const flush = async (final: boolean, termination?: SandboxTaskTermination) => {
        if (plan.mode === "foreground") return;
        for (;;) {
          const page = host.readOutput(streamOffset, 32768);
          if (page.bytes.length === 0 && !final) return;
          const record = entry.record;
          if (!record || record.phase !== "bound" || !record.facts.environment.resourceRef)
            throw new Error("SANDBOX_STREAM_BINDING_LOST");
          await this.rpc(entry, {
            kind: "append_output",
            resourceRef: record.facts.environment.resourceRef,
            expectedSequence: record.facts.resource.sequence,
            chunk: {
              index: streamIndex,
              offset: streamOffset,
              bytesBase64: Buffer.from(page.bytes).toString("base64"),
              end: final && page.end,
              ...(final && page.end && termination ? { termination } : {}),
            },
          });
          streamIndex++;
          streamOffset = page.nextOffset;
          if (page.end || page.bytes.length === 0) return;
        }
      };
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
      while (!finished) {
        await Promise.race([completion, delay(250)]);
        if (finished) break;
        const current = entry.record;
        if (!current || current.phase !== "bound") throw new Error("SANDBOX_BINDING_LOST");
        try {
          // Foreground network connections retain authority only while the same
          // Grant remains valid, just like background tasks and services.
          await this.rpc(entry, { kind: "resolve" });
          // Completion can arrive during the asynchronous authority check. Its
          // final output/cleanup path below still verifies every durable fact;
          // do not enqueue a now-obsolete running-state observation first.
          if (finished) break;
          await flush(false);
          if (finished) break;
          const observed = await this.rpc(entry, {
            kind: "observe_control",
            expectedSequence: current.facts.resource.sequence,
          });
          if (
            observed.record.phase !== "bound" ||
            observed.record.facts.resource.supervision !== "controlled"
          )
            host.cancel();
          else await acknowledge();
        } catch {
          host.cancel();
          break;
        }
      }
      const result = await completion;
      await flush(true, {
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
        result.taskStarted === true && result.taskProcessExited && result.exitCode !== null;
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
      const fileConflict =
        knownExit &&
        result.exitCode === 1 &&
        plan.operationContract.kind === "verified_effect" &&
        hasVerifiedPiFileConflict({
          bytes: result.stdout,
          parameters: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)),
          plan,
          scope: sandboxScopeSchema.parse(resolved.scope),
          workspace: compiled.cwd,
        });
      if (knownExit && result.exitCode === 0 && plan.operationContract.kind === "verified_effect")
        verifyPiWriteEvidence({
          bytes: result.stdout,
          parameters: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)),
          plan,
          scope: sandboxScopeSchema.parse(resolved.scope),
          workspace: compiled.cwd,
        });
      const operation = {
        effect:
          knownExit && plan.operationContract.kind === "fixed_read"
            ? { kind: "not_applicable" }
            : knownExit && ["command", "network_only"].includes(plan.operationContract.kind)
              ? { kind: "not_asserted" }
              : knownExit &&
                  (result.exitCode === 0 || fileConflict) &&
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
            : plan.mode !== "foreground" || !knownExit
              ? { ...resultFields, kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" }
              : ["command", "network_only"].includes(plan.operationContract.kind) ||
                  result.exitCode === 0
                ? {
                    ...resultFields,
                    kind: "result",
                    output,
                    completion: ["command", "network_only"].includes(plan.operationContract.kind)
                      ? { type: "exit", exitCode: result.exitCode }
                      : { type: "value" },
                  }
                : {
                    ...resultFields,
                    kind: "error",
                    output,
                    reasonCode: fileConflict ? "FILE_VERSION_CONFLICT" : "SANDBOX_OPERATION_FAILED",
                    termination: { type: "failure" },
                  },
      };
      await this.recordCompletion(entry, latest, operation, result.taskProcessExited);
      await this.reduceRisk(entry, "reconcile");
      return this.unknown(entry);
    } catch {
      entry.host?.cancel();
      return this.unknown(entry);
    } finally {
      // Even failed/uncertain bind replies retain the original host until bounded stop settles.
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
    const bound = await this.rpc(entry, { kind: "bind", expectedSequence: 1, facts });
    if (!bound.applied || entry.cancelled || this.closed) return this.unknown(entry);
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
        published = verifyPiWriteEvidence({
          bytes: committed.stdout,
          parameters: JSON.parse(parametersJson),
          plan,
          scope: sandboxScopeSchema.parse(scope),
          workspace: root.canonicalPath,
        });
        if ((published === "conflict") !== (committed.exitCode === 1) || committed.exitCode > 1)
          throw new Error("PI_WRITE_EVIDENCE_INVALID");
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
              reasonCode: "SANDBOX_OUTPUT_LIMIT",
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
          ? { kind: "unknown", reasonCode: "SANDBOX_OUTPUT_LIMIT" }
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
