import type { TaskEnvironmentConfiguration } from "@himawari-agent/application";
import {
  EXECUTION_ENVIRONMENT_V1,
  PI_RUNNER_CONTRACT,
  type SandboxHostBinding,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import {
  createWorkerTaskEnvironments,
  taskEnvironmentRoute,
} from "../src/production-task-environment-backend.js";

const BACKEND = "container-docker:local";
const RUNTIME_DIGEST = "d".repeat(64);
const configuration = () =>
  ({
    backendRef: BACKEND,
    dockerExecutable: "/usr/local/bin/docker",
    dockerHost: null,
    image: { reference: "himawari/runner", digest: "b".repeat(64), pin: "image-id" },
    egressImage: {
      reference: "docker.io/library/node",
      digest: "c".repeat(64),
      pin: "registry-digest",
    },
  }) satisfies TaskEnvironmentConfiguration;

function binding(
  overrides: Partial<SandboxHostBinding> & { readonly backendRef?: string } = {},
): SandboxHostBinding {
  const { backendRef = BACKEND, ...rest } = overrides;
  return {
    schemaVersion: "sandbox-host-binding.v1",
    capabilityRef: "capability:coding",
    capabilityVersion: "1.0.0",
    artifactDigest: "a".repeat(64),
    hostId: "host:fixture",
    profileRef: "authorized-project.v1",
    runtimeRoot: "/opt/runtime",
    runtimeDigest: RUNTIME_DIGEST,
    executable: { path: "/usr/bin/node", sha256: "a".repeat(64) },
    runner: { path: "/opt/runtime/runner.js", sha256: "e".repeat(64) },
    privateRoot: "/var/private-jobs",
    roots: [
      { canonicalRootId: "root:project", canonicalPath: "/work/project", device: "1", inode: "2" },
    ],
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
    maximumResourceCeiling: {
      maxWallTimeMs: 60_000,
      maxCpuTimeMs: 60_000,
      maxMemoryBytes: 536_870_912,
      maxOutputBytes: 65_536,
      maxProgressEvents: 16,
    },
    operationBindings: [
      {
        operation: "read",
        mode: "foreground",
        contract: PI_RUNNER_CONTRACT,
        backendRef,
        scopeSource: "file_workflow",
        directoryOperations: ["read"],
        network: "disabled",
      },
    ],
    ...rest,
  } as SandboxHostBinding;
}

const create = (bindings: readonly SandboxHostBinding[]) =>
  createWorkerTaskEnvironments({
    configuration: configuration(),
    runtimeDirectory: "/var/himawari/runtime",
    bindings,
    now: () => new Date("2026-09-26T00:00:00.000Z"),
  });

describe("Worker task environment backend", () => {
  it("refuses to start without a host binding that routes operations to the backend", () => {
    expect(() => create([])).toThrow("TASK_ENVIRONMENT_BINDING_UNAVAILABLE");
    expect(() => create([binding({ backendRef: "srt" })])).toThrow(
      "TASK_ENVIRONMENT_BINDING_UNAVAILABLE",
    );
  });

  it("refuses bindings that disagree on the mounted runtime", () => {
    expect(() =>
      create([
        binding(),
        binding({ capabilityRef: "capability:other", runtimeDigest: "f".repeat(64) }),
      ]),
    ).toThrow("TASK_ENVIRONMENT_RUNTIME_AMBIGUOUS");
    expect(() =>
      create([
        binding(),
        binding({ capabilityRef: "capability:other", runtimeRoot: "/opt/other" }),
      ]),
    ).toThrow("TASK_ENVIRONMENT_RUNTIME_AMBIGUOUS");
  });

  it("resolves only approved roots of the same host", async () => {
    const { resolveDirectory } = create([
      binding(),
      binding({ backendRef: "srt", hostId: "host:srt" }),
    ]);
    const directory = (hostId: string, canonicalRootId: string) => ({
      hostId,
      grantRef: "grant:1",
      canonicalRootId,
      access: "read" as const,
      source: {
        authorizationRef: "authorization:1",
        decidedBy: "user" as const,
        delegationListRef: null,
        expiresAt: "2026-09-27T00:00:00.000Z",
      },
    });
    await expect(resolveDirectory(directory("host:fixture", "root:project"))).resolves.toEqual({
      canonicalPath: "/work/project",
      device: "1",
      inode: "2",
    });
    await expect(resolveDirectory(directory("host:other", "root:project"))).resolves.toBeNull();
    await expect(resolveDirectory(directory("host:fixture", "root:missing"))).resolves.toBeNull();
    await expect(resolveDirectory(directory("host:srt", "root:project"))).resolves.toBeNull();
  });
});

describe("task environment container route", () => {
  const target = {
    identity: {
      schemaVersion: EXECUTION_ENVIRONMENT_V1,
      environmentId: "environment:1",
      executionJobId: "execution-job:1",
      ownerId: "owner:1",
      agentId: "agent:1",
      runId: "run:1",
      hostId: "host:fixture",
      role: "primary" as const,
      environmentGeneration: 1,
    },
    createIntentId: "create-intent:1",
    locator: {
      backendRef: BACKEND,
      runtimeInstanceId: "daemon:1",
      runtimeEnvironmentId: "container:1",
      createIntentId: "create-intent:1",
      effectivePolicyDigest: "a".repeat(64),
    },
    stopFence: 0,
    invocationId: "invocation:1",
    argv: ["node", "/opt/himawari/runner.js", '{"tool":"read"}'],
    deadlineAt: "2026-09-26T00:01:00.000Z",
    authorizationRef: "authorization:1",
  };

  it("hands the exact argv to the backend once and returns the recorded output as bytes", async () => {
    const argumentsByRef = new Map<string, readonly string[]>();
    const seen: unknown[] = [];
    const route = taskEnvironmentRoute(BACKEND, argumentsByRef, {
      execute: async (input) => {
        seen.push({ ...input, argv: argumentsByRef.get(input.argumentsRef) });
        return { outputRef: "container-output:1", observedAt: "2026-09-26T00:00:01.000Z" };
      },
      publishOnHost: async () => {
        throw new Error("unreachable");
      },
      readOutput: async (outputRef) => {
        expect(outputRef).toBe("container-output:1");
        return {
          invocationId: target.invocationId,
          exitCode: 0,
          stdout: "ünïcode",
          stderr: "",
          truncated: false,
        };
      },
    });
    const completed = await route.execute(target);
    expect(route.backendRef).toBe(BACKEND);
    expect(new TextDecoder().decode(completed.stdout)).toBe("ünïcode");
    expect(completed).toMatchObject({ exitCode: 0, truncated: false });
    expect(seen).toEqual([
      {
        identity: target.identity,
        createIntentId: target.createIntentId,
        locator: target.locator,
        stopFence: target.stopFence,
        invocationId: target.invocationId,
        argumentsRef: expect.stringMatching(/^container-arguments:/),
        deadlineAt: target.deadlineAt,
        argv: target.argv,
      },
    ]);
    expect(argumentsByRef.size).toBe(0);
  });

  it("forgets the argv and reports failure when the backend or output is lost", async () => {
    const argumentsByRef = new Map<string, readonly string[]>();
    const lost = taskEnvironmentRoute(BACKEND, argumentsByRef, {
      execute: async () => {
        throw new Error("CONTAINER_NOT_RUNNING");
      },
      readOutput: async () => {
        throw new Error("unreachable");
      },
      publishOnHost: async () => {
        throw new Error("unreachable");
      },
    });
    await expect(lost.execute(target)).rejects.toThrow("CONTAINER_NOT_RUNNING");
    const unread = taskEnvironmentRoute(BACKEND, argumentsByRef, {
      execute: async () => ({
        outputRef: "container-output:1",
        observedAt: "2026-09-26T00:00:01.000Z",
      }),
      readOutput: async () => {
        throw new Error("CONTAINER_OUTPUT_UNKNOWN");
      },
      publishOnHost: async () => {
        throw new Error("unreachable");
      },
    });
    await expect(unread.execute(target)).rejects.toThrow("CONTAINER_OUTPUT_UNKNOWN");
    expect(argumentsByRef.size).toBe(0);
  });

  it("hands a host publication to the backend's gate with only the environment target", async () => {
    const seen: unknown[] = [];
    const committed = { exitCode: 0, stdout: new TextEncoder().encode("published") };
    const route = taskEnvironmentRoute(BACKEND, new Map(), {
      execute: async () => {
        throw new Error("unreachable");
      },
      readOutput: async () => {
        throw new Error("unreachable");
      },
      publishOnHost: async (input, commit) => {
        seen.push(input);
        return commit();
      },
    });
    const { argv: _argv, ...publication } = target;
    await expect(route.publish({ ...publication, commit: async () => committed })).resolves.toBe(
      committed,
    );
    expect(seen).toEqual([
      {
        identity: target.identity,
        createIntentId: target.createIntentId,
        locator: target.locator,
        stopFence: target.stopFence,
        invocationId: target.invocationId,
        deadlineAt: target.deadlineAt,
      },
    ]);
  });
});
