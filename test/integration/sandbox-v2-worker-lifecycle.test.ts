import { mkdtemp, rm } from "node:fs/promises";
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
  verifySandboxHost: mocks.verify,
}));

import { parseJobHostRequest } from "../../packages/runtime-sandbox/src/job-host-protocol.ts";
import { ProductionSandboxExecutionV2 } from "../../apps/execution-worker/src/production-sandbox-execution-v2.ts";
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
it.each(["normal", "replay", "bind-ack-loss", "registration-revoked"] as const)(
  "v2 lifecycle: %s",
  async (scenario) => {
    const f = await openSandboxJournal();
    cleanups.push(f.close);
    const root = await mkdtemp("/tmp/r4-worker-v2-");
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const admitted = sandboxV2Call(f, "admit", sandboxV2Admission(f)).record;
    const plan = admitted.plan;
    const calls: string[] = [];
    let bound = false;
    let facts = admitted.facts;
    let resolveResult!: (value: unknown) => void;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const host = {
      ready: Promise.resolve(),
      result,
      controlBinding: {
        directory: `${root}/control`,
        token: "a".repeat(64),
        sessionId: "session",
        jobId: plan.identity.jobId,
        attemptId: plan.identity.attemptId,
      },
      inspect: () => ({ bootId: "boot" }),
      start: vi.fn(() => {
        calls.push("host-start");
        resolveResult({
          stdout: new TextEncoder().encode("result"),
          taskStarted: true,
          taskProcessExited: true,
          exitCode: 0,
        });
      }),
      cancel: vi.fn(() =>
        resolveResult({
          stdout: new Uint8Array(),
          taskStarted: false,
          taskProcessExited: false,
          exitCode: null,
        }),
      ),
    };
    mocks.prepare.mockImplementation((request) => {
      parseJobHostRequest({ ...request, deadlineAt: new Date(Date.now() + 60000).toISOString() });
      return host;
    });
    mocks.policy.mockResolvedValue({
      policy: {
        workspace: root,
        privateDirectory: `${root}/scratch`,
        writable: false,
        readOnlyToolchainPaths: [],
        protectedPaths: [],
        allowedDomains: [],
      },
      compiled: { policyDigest: admitted.facts.environment.policyDigest },
    });
    mocks.load.mockResolvedValue({
      snapshot: {
        capabilities: [
          {
            manifest: { ref: plan.capabilityRef, version: plan.capabilityVersion },
            binding: {
              kind: "sandbox",
              value: {
                privateRoot: root,
                hostId: plan.identity.hostId,
                runtimeRoot: "/runtime",
                readOnlyToolchainPaths: [],
                protectedPaths: [],
                roots: [
                  { canonicalRootId: f.scope.directoryGrant.canonicalRootId, canonicalPath: root },
                ],
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
    const reservation = {
      resourceRef: null,
      workspaceConflictRefs: admitted.workspaces.map((item) => item.ref),
    };
    const payloads = {
      readInput: async () => new Uint8Array(),
      writeOutput: async () => "output",
      sandboxExecution: async (
        _invocation: unknown,
        _identity: unknown,
        command: { kind: string; facts?: typeof facts },
      ) => {
        calls.push(command.kind);
        if (command.kind === "register_control" && scenario === "registration-revoked")
          throw new Error("revoked");
        if (command.kind === "bind") {
          bound = true;
          if (!command.facts) throw new Error("facts missing");
          facts = command.facts;
          if (scenario === "bind-ack-loss") throw new Error("ack lost after commit");
        }
        if (command.kind === "append") {
          if (!command.facts) throw new Error("facts missing");
          facts = command.facts;
        }
        return {
          record: bound
            ? { ...admitted, phase: "bound", facts }
            : { phase: "reserved", plan, reservation, startedAt: null, operationRevision: 0 },
          applied: command.kind === "bind" && scenario !== "replay",
          resolvedScope: command.kind === "resolve" ? { scope: f.scope, allowedDomains: [] } : null,
          output: null,
        };
      },
    } as unknown as ProductionPayloadBrokerClient;
    const worker = new ProductionSandboxExecutionV2({
      configuration: { capabilityDeployment: {} as never },
      peer: { workerInstanceId: "worker" } as never,
      payloads,
      clock: { now: () => T1 },
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
    expect(outcome.outcome).toBe("result_unknown");
    expect(await worker.execute(request)).toEqual(outcome);
    expect(host.start).toHaveBeenCalledTimes(scenario === "normal" ? 1 : 0);
    if (scenario === "normal") {
      expect(calls.indexOf("register_control")).toBeLessThan(calls.indexOf("bind"));
      expect(calls.indexOf("bind")).toBeLessThan(calls.indexOf("host-start"));
      expect(facts.result).toMatchObject({
        kind: "result",
        output: { ref: "output", byteLength: 6 },
      });
      expect(facts.resource).toMatchObject({ supervision: "lost", cleanup: "unknown" });
    }
    expect(host.cancel).toHaveBeenCalled();
    await worker.shutdown();
  },
);
