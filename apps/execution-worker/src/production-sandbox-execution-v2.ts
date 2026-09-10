import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CapabilityInvocationRequest,
  ClockPort,
  ProductConfiguration,
} from "@himawari-agent/application";
import {
  type ExecutionAdmissionPeerBinding,
  type ExecutionV2Request,
  executionV2MessageSchema,
  type PayloadBrokerSandboxExecutionResult,
  PI_RUNNER_CONTRACT,
  piCodingToolNameSchema,
  piRunnerInputSchema,
  type SandboxExecutionBrokerCommand,
  type SandboxExecutionPlanV2,
  type SandboxTaskTermination,
  sandboxExecutionFactsSchema,
} from "@himawari-agent/execution-contracts";
import {
  CapabilityDeploymentSnapshotLoader,
  revalidateCapabilityDeploymentSnapshot,
  verifySandboxHost,
  verifyPiWriteEvidence,
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
interface Options {
  configuration: Pick<ProductConfiguration, "capabilityDeployment">;
  peer: ExecutionAdmissionPeerBinding;
  payloads: ProductionPayloadBrokerClient;
  clock: ClockPort;
}
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
      !["fixed_read", "command", "verified_effect", "task_start", "service_start"].includes(
        plan.operationContract.kind,
      ) ||
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
                : ["write", "edit"].includes(tool)
                  ? "verified_effect"
                  : "fixed_read";
        if (
          plan.operationContract.version !== PI_RUNNER_CONTRACT.version ||
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
      const root = binding.roots.find(
        (item) => item.canonicalRootId === resolved.scope.directoryGrant.canonicalRootId,
      );
      if (!root) throw new Error("SANDBOX_ROOT_UNAVAILABLE");
      const { policy, compiled } = await prepareJobPolicy({
        workspace: root.canonicalPath,
        privateRoot: binding.privateRoot,
        jobId: plan.identity.jobId,
        ...(readiness ? { readinessSocketName: readiness.socketName } : {}),
        writable: resolved.scope.directoryGrant.operations.some(
          (operation) => operation !== "read",
        ),
        readOnlyToolchainPaths: [binding.runtimeRoot, ...binding.readOnlyToolchainPaths],
        protectedPaths:
          piRunner || plan.mode !== "foreground"
            ? [
                ...binding.protectedPaths,
                ...[
                  ".env",
                  ".git",
                  ".himawari-trash",
                  ...(["write", "edit"].includes(plan.operation) ? [] : [".himawari-recovery"]),
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
        (plan.operationContract.version !== PI_RUNNER_CONTRACT.version ||
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
                workspace: root.canonicalPath,
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
          await flush(false);
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
      const { evidence: _evidence, ...resourceFields } = latest.facts
        .resource as typeof latest.facts.resource & { evidence?: unknown };
      if (knownExit && result.exitCode === 0 && plan.operationContract.kind === "verified_effect")
        verifyPiWriteEvidence({
          bytes: result.stdout,
          parameters: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)),
          plan,
          scope: resolved.scope,
          workspace: root.canonicalPath,
        });
      const observation = sandboxExecutionFactsSchema.parse({
        ...latest.facts,
        effect:
          knownExit && plan.operationContract.kind === "fixed_read"
            ? { kind: "not_applicable" }
            : knownExit && plan.operationContract.kind === "command"
              ? { kind: "not_asserted" }
              : knownExit &&
                  result.exitCode === 0 &&
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
              : plan.operationContract.kind === "command" || result.exitCode === 0
                ? {
                    ...resultFields,
                    kind: "result",
                    output,
                    completion:
                      plan.operationContract.kind === "command"
                        ? { type: "exit", exitCode: result.exitCode }
                        : { type: "value" },
                  }
                : {
                    ...resultFields,
                    kind: "error",
                    output,
                    reasonCode: "SANDBOX_OPERATION_FAILED",
                    termination: { type: "failure" },
                  },
        resource: {
          ...resourceFields,
          ...(resourceFields.status.kind === "task" && result.taskProcessExited
            ? { status: { kind: "task", state: "exited" } }
            : {}),
          sequence: latest.facts.resource.sequence + 1,
          occurredAt: this.options.clock.now(),
          supervision: "lost",
          cleanup: "unknown",
          reasonCode: "SANDBOX_CLEANUP_UNCONFIRMED",
        },
      });
      await this.rpc(entry, {
        kind: "append",
        expectedSequence: latest.facts.resource.sequence,
        expectedOperationRevision: latest.operationRevision,
        facts: observation,
      });
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
  private entry(request: Control) {
    const entry = this.entries.get(request.payload.targetRequestId);
    if (!entry || JSON.stringify(entry.request.scope) !== JSON.stringify(request.scope))
      throw new Error("SANDBOX_CONTROL_BINDING_CHANGED");
    return entry;
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
