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
  sandboxExecutionFactsSchema,
} from "@himawari-agent/execution-contracts";
import {
  CapabilityDeploymentSnapshotLoader,
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
  constructor(options: Options) {
    this.options = options;
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
    entry.completion = this.run(entry);
    return entry.completion;
  }
  private async hostBinding(plan: SandboxExecutionPlanV2) {
    const deployment = this.options.configuration.capabilityDeployment;
    if (!deployment) throw new Error("SANDBOX_DEPLOYMENT_UNAVAILABLE");
    const loaded = await new CapabilityDeploymentSnapshotLoader({
      ...deployment,
      now: () => this.options.clock.now(),
    }).load();
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
      plan.mode !== "foreground" ||
      !["fixed_read", "command", "verified_effect"].includes(plan.operationContract.kind) ||
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
        const kind =
          tool === "bash"
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
        writable: resolved.scope.directoryGrant.operations.some(
          (operation) => operation !== "read",
        ),
        readOnlyToolchainPaths: [binding.runtimeRoot, ...binding.readOnlyToolchainPaths],
        protectedPaths: piRunner
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
          resourceRef: null,
          status: { kind: "foreground" },
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
      await this.hostBinding(plan);
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
          const observed = await this.rpc(entry, {
            kind: "observe_control",
            expectedSequence: current.facts.resource.sequence,
          });
          if (
            observed.record.phase !== "bound" ||
            observed.record.facts.resource.supervision !== "controlled"
          )
            host.cancel();
        } catch {
          host.cancel();
          break;
        }
      }
      const result = await completion;
      const latest = (await this.rpc(entry, { kind: "read" })).record;
      if (latest.phase !== "bound") throw new Error("SANDBOX_BINDING_LOST");
      const ref = await this.options.payloads.writeOutput(
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
      const observation = sandboxExecutionFactsSchema.parse({
        ...latest.facts,
        result: !knownExit
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
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.completion));
  }
}
