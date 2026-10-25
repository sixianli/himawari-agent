import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type EnvironmentPrewarmRequest,
  PI_WRITE_VERIFIER,
  SRT_TASK_ENVIRONMENT_BACKEND_REF,
} from "@himawari-agent/execution-contracts";

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  load: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@himawari-agent/runtime-sandbox", async (original) => ({
  ...(await original<object>()),
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

import { ProductionSandboxExecutionV2 } from "../src/production-sandbox-execution-v2.ts";
import { srtTaskEnvironmentJobId } from "../src/production-srt-task-environment-backend.ts";

const runner = { kind: "command" as const, ref: "pi-coding-tool", version: "1" };
const writer = {
  kind: "verified_effect" as const,
  ref: "pi-coding-tool",
  version: "1",
  verifierRef: PI_WRITE_VERIFIER.ref,
};
const descriptor = (operation: string, overrides: object = {}) => ({
  operation,
  mode: "foreground",
  contract: operation === "bash" ? runner : writer,
  backendRef: "srt",
  scopeSource: "grant_targets",
  directoryOperations: operation === "bash" ? ["read", "create", "update"] : ["read", "update"],
  network: "disabled",
  ...overrides,
});

const request = (
  overrides: Partial<EnvironmentPrewarmRequest> = {},
): EnvironmentPrewarmRequest => ({
  operation: "prewarm",
  backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
  requestedAt: "2026-10-25T00:00:00.000Z",
  deadlineAt: "2026-10-25T00:01:00.000Z",
  identity: {
    schemaVersion: "execution-environment.v1",
    ownerId: "owner",
    agentId: "agent",
    runId: "run-1",
    hostId: "host-1",
    executionJobId: "execution-job-1",
    environmentId: "environment-1",
    environmentGeneration: 1,
    role: "primary",
  },
  createIntentId: "create-1",
  locator: {
    backendRef: SRT_TASK_ENVIRONMENT_BACKEND_REF,
    runtimeInstanceId: "boot-1",
    runtimeEnvironmentId: "srt-environment-0123456789abcdef0123456789",
    createIntentId: "create-1",
    effectivePolicyDigest: "a".repeat(64),
  },
  capabilityRef: "coding",
  capabilityVersion: "1",
  canonicalRootId: "1:2",
  ...overrides,
});

function worker(operationBindings: readonly object[], session = vi.fn(async () => ({}))) {
  mocks.load.mockResolvedValue({
    snapshot: {
      capabilities: [
        {
          manifest: { ref: "coding", version: "1" },
          binding: {
            kind: "sandbox",
            value: {
              hostId: "host-1",
              privateRoot: "/private",
              runtimeRoot: "/runtime",
              readOnlyToolchainPaths: ["/toolchain"],
              protectedPaths: ["/protected"],
              roots: [{ canonicalRootId: "1:2", canonicalPath: "/workspace" }],
              executable: { path: "/runtime/node" },
              runner: { path: "/runtime/pi-coding-main.js" },
              maximumResourceCeiling: { maxOutputBytes: 1024 },
              operationBindings,
            },
          },
          qualification: { sandbox: {} },
        },
      ],
    },
  });
  mocks.verify.mockResolvedValue(undefined);
  mocks.policy.mockImplementation(async (input: { jobId: string; writable: boolean }) => ({
    policy: { privateDirectory: `/private/${input.jobId}` },
    compiled: { cwd: "/workspace", policyDigest: `${input.jobId}:${input.writable}` },
  }));
  const instance = new ProductionSandboxExecutionV2({
    configuration: { capabilityDeployment: {} as never },
    peer: { workerInstanceId: "worker-1" } as never,
    payloads: {} as never,
    clock: { now: () => "2026-10-25T00:00:00.000Z" },
    srtEnvironments: { session } as never,
  });
  return { instance, session };
}

const settled = async (log: { readonly mock: { readonly calls: readonly unknown[][] } }) => {
  const lines = () =>
    log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("sandbox.srt_prewarm."));
  await vi.waitFor(() => expect(lines().length).toBeGreaterThan(0));
  return lines().map(
    (line) => JSON.parse(line) as { event: string; sessions?: string[]; reasonCode?: string },
  );
};

describe("SRT resident session prewarm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("starts the command and file write sessions with the same request a tool call builds", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance, session } = worker([descriptor("bash"), descriptor("write")]);
    instance.prewarmSrtEnvironment(request());
    const [event] = await settled(log);
    expect(event).toMatchObject({
      event: "sandbox.srt_prewarm.finished",
      sessions: ["command", "file_write"],
    });
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.not.objectContaining({ plan: expect.anything() }),
    );
    expect(mocks.policy.mock.calls.map(([input]) => input)).toEqual([
      {
        workspace: "/workspace",
        privateRoot: "/private",
        jobId: srtTaskEnvironmentJobId("environment-1", "command"),
        writable: true,
        readOnlyToolchainPaths: ["/runtime", "/toolchain"],
        protectedPaths: [
          "/protected",
          "/workspace/.env",
          "/workspace/.git",
          "/workspace/.himawari-trash",
          "/workspace/.himawari-recovery",
        ],
        allowedDomains: [],
      },
      {
        workspace: "/workspace",
        privateRoot: "/private",
        jobId: srtTaskEnvironmentJobId("environment-1", "file_write"),
        writable: true,
        readOnlyToolchainPaths: ["/runtime", "/toolchain"],
        protectedPaths: [
          "/protected",
          "/workspace/.env",
          "/workspace/.git",
          "/workspace/.himawari-trash",
        ],
        allowedDomains: [],
      },
    ]);
    const [command] = session.mock.calls[0] as unknown as [
      { target: unknown; kind: string; request: { attemptId: string; args: string[] } },
    ];
    expect(command).toMatchObject({
      target: {
        identity: request().identity,
        createIntentId: "create-1",
        locator: request().locator,
      },
      kind: "command",
      request: {
        attemptId: "command-srt-environment-01234567",
        executable: "/runtime/node",
        args: ["/runtime/pi-coding-main.js", "host-1", "worker-1", "--resident", "/runtime"],
        maxOutputBytes: 1024,
        cleanupTimeoutMs: 5000,
      },
    });
  });

  it.each([
    ["network access", { network: "grant_targets" }],
    ["a one-shot backend", { backendRef: "container" }],
    ["a background task", { mode: "background" }],
  ])("does not prewarm a session whose tool needs %s", async (_name, overrides) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance, session } = worker([descriptor("bash", overrides)]);
    instance.prewarmSrtEnvironment(request());
    const [event] = await settled(log);
    expect(event).toMatchObject({ event: "sandbox.srt_prewarm.finished", sessions: [] });
    expect(session).not.toHaveBeenCalled();
  });

  it("reports a failed prewarm without throwing so the tool call starts its own session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance } = worker(
      [descriptor("bash")],
      vi.fn(async () => {
        throw new Error("SRT_SESSION_START_FAILED");
      }),
    );
    instance.prewarmSrtEnvironment(request());
    const [event] = await settled(log);
    expect(event).toMatchObject({
      event: "sandbox.srt_prewarm.failed",
      reasonCode: "SRT_SESSION_START_FAILED",
    });
  });

  it("refuses a prewarm for an unknown root or another backend", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance, session } = worker([descriptor("bash")]);
    expect(() => instance.prewarmSrtEnvironment(request({ backendRef: "container" }))).toThrow(
      "SANDBOX_ENVIRONMENT_UNAVAILABLE",
    );
    instance.prewarmSrtEnvironment(request({ canonicalRootId: "9:9" }));
    const [event] = await settled(log);
    expect(event).toMatchObject({
      event: "sandbox.srt_prewarm.failed",
      reasonCode: "SANDBOX_ROOT_UNAVAILABLE",
    });
    expect(session).not.toHaveBeenCalled();
  });
});
