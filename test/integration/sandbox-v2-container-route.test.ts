import { afterEach, expect, it, vi } from "vitest";
import type { ProductionPayloadBrokerClient } from "../../apps/execution-worker/src/production-payload-broker-client.ts";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  policy: vi.fn(),
  load: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@himawari-agent/runtime-sandbox", () => ({
  prepareSandboxJobHost: mocks.prepare,
  prepareJobPolicy: mocks.policy,
}));
vi.mock("@himawari-agent/platform-node", async (original) => ({
  ...(await original<object>()),
  CapabilityDeploymentSnapshotLoader: class {
    load = mocks.load;
  },
  revalidateCapabilityDeploymentSnapshot: async (admitted: unknown) => admitted,
  verifySandboxHost: mocks.verify,
}));

import { taskEnvironmentCallEvidence } from "@himawari-agent/application";
import {
  PI_CONTAINER_RUNNER_PATH,
  PI_FIXED_FILE_CONTRACT,
  PI_RUNNER_CONTRACT,
  piContainerRunnerInputSchema,
  type SandboxExecutionFacts,
  type SandboxExecutionPlanV2,
  validateSandboxExecutionFacts,
} from "@himawari-agent/execution-contracts";
import {
  ProductionSandboxExecutionV2,
  type SandboxContainerRoute,
} from "../../apps/execution-worker/src/production-sandbox-execution-v2.ts";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  openSandboxJournal,
  serviceRequest,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.resetAllMocks();
});

const BACKEND = "container-local";
const PARAMETERS = { path: "notes.txt", workspace: "/untrusted", authorizationRef: "forged" };
const locator = {
  backendRef: BACKEND,
  runtimeInstanceId: "daemon-1",
  runtimeEnvironmentId: "c".repeat(64),
  createIntentId: "environment-create-1",
  effectivePolicyDigest: "e".repeat(64),
};

type Scenario =
  | "read"
  | "read-failed"
  | "bash"
  | "execute-lost"
  | "output-truncated"
  | "no-environment"
  | "revoked-after-bind"
  | "bind-replayed"
  | "write-general"
  | "fixed-file"
  | "workspace-copy";

async function run(scenario: Scenario) {
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const admitted = sandboxV2Call(f, "admit", sandboxV2Admission(f)).record;
  const tool =
    scenario === "bash" ? "bash" : scenario === "write-general" ? "write" : admitted.plan.operation;
  const plan: SandboxExecutionPlanV2 = {
    ...admitted.plan,
    operation: tool,
    backendRef: BACKEND,
    environmentId: "environment-task-1",
    operationContract:
      scenario === "bash"
        ? { kind: "command", ...PI_RUNNER_CONTRACT }
        : scenario === "write-general"
          ? {
              kind: "verified_effect",
              ...PI_RUNNER_CONTRACT,
              verifierRef: "pi-write",
              verifierVersion: "1",
              targetRef: "workspace",
            }
          : scenario === "fixed-file"
            ? { kind: "fixed_read", ...PI_FIXED_FILE_CONTRACT }
            : { kind: "fixed_read", ...PI_RUNNER_CONTRACT },
  };
  mocks.load.mockResolvedValue({
    snapshot: {
      capabilities: [
        {
          manifest: { ref: plan.capabilityRef, version: plan.capabilityVersion },
          binding: {
            kind: "sandbox",
            value: {
              privateRoot: "/private",
              hostId: plan.identity.hostId,
              runtimeRoot: "/runtime",
              readOnlyToolchainPaths: [],
              protectedPaths: [],
              roots: [],
              executable: { path: "/bin/true" },
              runner: { path: "/runner" },
            },
          },
          qualification: { sandbox: {} },
        },
      ],
    },
  });
  mocks.verify.mockResolvedValue(undefined);
  const environment = {
    identity: {
      schemaVersion: "execution-environment.v1" as const,
      ownerId: plan.identity.ownerId,
      agentId: plan.identity.agentId,
      runId: plan.identity.runId,
      hostId: plan.identity.hostId,
      executionJobId: "execution-job-1",
      environmentId: plan.environmentId,
      environmentGeneration: 1,
      role: "primary" as const,
    },
    createIntentId: locator.createIntentId,
    locator,
    stopFence: 0,
  };
  const calls: string[] = [];
  const history: SandboxExecutionFacts[] = [];
  let facts: SandboxExecutionFacts | undefined;
  let resolves = 0;
  const payloads = {
    readInput: async () => Buffer.from(JSON.stringify(PARAMETERS)),
    writeOutput: vi.fn(async () => "output-ref"),
    sandboxExecution: async (
      _invocation: unknown,
      _identity: unknown,
      command: { kind: string; facts?: SandboxExecutionFacts },
    ) => {
      calls.push(command.kind);
      if (command.kind === "resolve") {
        resolves++;
        if (scenario === "revoked-after-bind" && facts) throw new Error("revoked");
      }
      if (command.kind === "bind" || command.kind === "append") {
        if (!command.facts) throw new Error("facts missing");
        const next = validateSandboxExecutionFacts(
          plan,
          command.facts,
          { environment: command.facts.environment, operationContract: plan.operationContract },
          command.kind === "append" ? facts : undefined,
        );
        if (command.kind === "bind")
          expect(next.resource).toMatchObject({ sequence: 2, supervision: "initializing" });
        facts = next;
        history.push(next);
      }
      return {
        record: facts
          ? { phase: "bound", plan, facts, startedAt: T1, operationRevision: 0 }
          : {
              phase: "reserved",
              plan,
              reservation: {
                schemaVersion: "sandbox-preparation.v1",
                identity: plan.identity,
                environmentId: plan.environmentId,
                resourceRef: null,
                mode: plan.mode,
                workspaceConflictRefs: admitted.workspaces.map((item) => item.ref),
                sequence: 1,
                createdAt: plan.requestedAt,
              },
              startedAt: null,
              operationRevision: 0,
            },
        applied: command.kind === "bind" ? scenario !== "bind-replayed" : command.kind === "append",
        resolvedScope:
          command.kind === "resolve"
            ? {
                scope: {
                  ...f.scope,
                  operation: tool,
                  profileRef: "authorized-project.v1",
                  ...(scenario === "workspace-copy"
                    ? {
                        workspaceCopy: {
                          canonicalRootId: "copy-root",
                          canonicalPath: "/copies/copy-root",
                          device: "1",
                          inode: "20",
                        },
                      }
                    : {}),
                },
                allowedDomains: [],
              }
            : null,
        environment:
          command.kind === "resolve" && scenario !== "no-environment" ? environment : null,
        output: null,
      };
    },
  } as unknown as ProductionPayloadBrokerClient;
  const executed: Parameters<SandboxContainerRoute["execute"]>[0][] = [];
  const containers: SandboxContainerRoute = {
    backendRef: BACKEND,
    execute: async (input) => {
      calls.push("container-execute");
      executed.push(input);
      if (scenario === "execute-lost") throw new Error("exec response lost");
      return {
        exitCode: scenario === "bash" ? 3 : scenario === "read-failed" ? 1 : 0,
        stdout: new TextEncoder().encode('{"schemaVersion":"pi-result.v1"}'),
        truncated: scenario === "output-truncated",
      };
    },
  };
  const worker = new ProductionSandboxExecutionV2({
    configuration: { capabilityDeployment: {} as never },
    peer: { workerInstanceId: "worker" } as never,
    payloads,
    clock: { now: () => T1 },
    containers,
  });
  const base = serviceRequest();
  const request = {
    ...base,
    messageId: plan.identity.invocationId,
    authorizationRef: plan.authorizationRef,
    scope: {
      ...base.scope,
      deploymentId: plan.executionLease.deploymentId,
      authorityEpoch: plan.executionLease.authorityEpoch,
      fencingToken: plan.executionLease.fencingToken,
    },
    payload: {
      ...base.payload,
      capabilityId: plan.capabilityRef,
      capabilityVersion: plan.capabilityVersion,
      capabilityHandleRef: plan.handleRef,
      inputRef: plan.inputRef,
      operation: plan.operation,
      deadlineAt: plan.effectiveDeadlineAt,
      resourceCeiling: plan.resourceCeiling,
      sandboxExecution: {
        schemaVersion: "sandbox-execution.v2" as const,
        mode: plan.mode,
        environmentId: plan.environmentId,
        identity: plan.identity,
      },
    },
  };
  const outcome = await worker.execute(request);
  const replay = await worker.execute(request);
  await worker.shutdown();
  return {
    plan,
    f,
    outcome,
    replay,
    calls,
    history,
    facts,
    executed,
    resolves,
    writeOutput: payloads.writeOutput as unknown as ReturnType<typeof vi.fn>,
  };
}

const released = (plan: SandboxExecutionPlanV2) => ({
  supervision: "released",
  cleanup: "confirmed",
  evidence: {
    ...taskEnvironmentCallEvidence({
      environmentId: plan.environmentId,
      invocationId: plan.identity.invocationId,
      createIntentId: locator.createIntentId,
      runtimeInstanceId: locator.runtimeInstanceId,
      runtimeEnvironmentId: locator.runtimeEnvironmentId,
    }),
    subject: { kind: "task_environment", environmentId: plan.environmentId },
  },
});

it("runs a read inside the bound task environment and records the call under its lease", async () => {
  const { plan, f, outcome, replay, calls, history, executed } = await run("read");
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.policy).not.toHaveBeenCalled();
  expect(replay).toEqual(outcome);
  expect(executed).toHaveLength(1);
  expect(calls.indexOf("bind")).toBeLessThan(calls.indexOf("container-execute"));
  const [call] = executed;
  expect(call).toMatchObject({
    identity: { environmentId: plan.environmentId, executionJobId: "execution-job-1" },
    createIntentId: locator.createIntentId,
    locator,
    stopFence: 0,
    invocationId: plan.identity.invocationId,
    authorizationRef: plan.authorizationRef,
    deadlineAt: plan.effectiveDeadlineAt,
  });
  const [node, runner, json, ...extra] = call?.argv ?? [];
  expect([node, runner, extra]).toEqual(["node", PI_CONTAINER_RUNNER_PATH, []]);
  const input = piContainerRunnerInputSchema.parse(JSON.parse(json ?? ""));
  expect(input).toMatchObject({
    tool: plan.operation,
    toolCallId: plan.identity.toolCallId,
    hostId: plan.identity.hostId,
    canonicalRootId: f.scope.directoryGrant.canonicalRootId,
    workspace: `/workspaces/${f.scope.directoryGrant.canonicalRootId}`,
    grantRef: f.scope.directoryGrant.ref,
    grantRevision: f.scope.directoryGrant.revision,
    access: "read",
    maxOutputBytes: plan.resourceCeiling.maxOutputBytes,
  });
  expect(JSON.parse(input.parametersJson)).toEqual(PARAMETERS);
  expect(history.map((item) => item.resource.supervision)).toEqual([
    "initializing",
    "stopping",
    "released",
  ]);
  expect(history[0]?.environment).toMatchObject({
    kind: "container",
    executionJobId: "execution-job-1",
    runtimeEnvironmentId: locator.runtimeEnvironmentId,
    createIntentId: locator.createIntentId,
    stopFence: 0,
    policyDigest: locator.effectivePolicyDigest,
  });
  const last = history.at(-1);
  expect(last?.result).toMatchObject({
    kind: "result",
    completion: { type: "value" },
    output: { ref: "output-ref", byteLength: 32 },
  });
  expect(last?.effect).toEqual({ kind: "not_applicable" });
  expect(last?.resource).toMatchObject(released(plan));
});

it("keeps a command's exit code and does not assert its effects", async () => {
  const { history } = await run("bash");
  const last = history.at(-1);
  expect(last?.result).toMatchObject({ kind: "result", completion: { type: "exit", exitCode: 3 } });
  expect(last?.effect).toEqual({ kind: "not_asserted" });
  expect(last?.resource.supervision).toBe("released");
});

it("reports a failed read as an operation error", async () => {
  const { history } = await run("read-failed");
  const last = history.at(-1);
  expect(last?.result).toMatchObject({ kind: "error", reasonCode: "SANDBOX_OPERATION_FAILED" });
  expect(last?.effect).toEqual({ kind: "not_applicable" });
});

it("treats a lost execute response as unknown and never releases the call", async () => {
  const { outcome, history, executed, writeOutput } = await run("execute-lost");
  expect(outcome.outcome).toBe("result_unknown");
  expect(executed).toHaveLength(1);
  expect(writeOutput).not.toHaveBeenCalled();
  const last = history.at(-1);
  expect(last?.result).toMatchObject({ kind: "unknown", reasonCode: "SANDBOX_EXIT_UNKNOWN" });
  expect(last?.effect.kind).toBe("unknown");
  expect(last?.resource).toMatchObject({
    supervision: "lost",
    cleanup: "unknown",
    reasonCode: "CONTAINER_EXECUTE_UNKNOWN",
  });
});

it("does not report truncated output as a completed result", async () => {
  const { history } = await run("output-truncated");
  const last = history.at(-1);
  expect(last?.result).toMatchObject({ kind: "error", reasonCode: "SANDBOX_OUTPUT_LIMIT" });
  expect(last?.effect.kind).toBe("unknown");
});

it.each(["no-environment", "write-general", "fixed-file", "workspace-copy"] as const)(
  "refuses %s before binding or executing",
  async (scenario) => {
    const { outcome, calls, executed } = await run(scenario);
    expect(outcome.outcome).toBe("result_unknown");
    expect(calls).toEqual(
      scenario === "write-general" || scenario === "fixed-file" ? ["read"] : ["read", "resolve"],
    );
    expect(executed).toHaveLength(0);
    expect(mocks.policy).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  },
);

it.each(["revoked-after-bind", "bind-replayed"] as const)(
  "does not execute when %s",
  async (scenario) => {
    const { outcome, calls, executed } = await run(scenario);
    expect(outcome.outcome).toBe("result_unknown");
    expect(calls).toEqual(
      scenario === "bind-replayed"
        ? ["read", "resolve", "bind"]
        : ["read", "resolve", "bind", "resolve"],
    );
    expect(executed).toHaveLength(0);
    expect(mocks.policy).not.toHaveBeenCalled();
  },
);
