import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ExecutionEnvironmentLifecyclePort,
  TaskEnvironmentConfiguration,
} from "@himawari-agent/application";
import type { SandboxHostBinding } from "@himawari-agent/execution-contracts";
import {
  ContainerExecutionBackend,
  type ContainerExecutionBackendOptions,
  containerRunnerDigest,
  dockerCli,
  hostFreeBytes,
} from "@himawari-agent/runtime-sandbox";
import type { SandboxContainerRoute } from "./production-sandbox-execution-v2.js";

const INIT_USER = "65532:65532";
const TASK_USER = "65534:65534";
const EGRESS_USER = "65533:65533";

type ContainerCalls = Pick<ContainerExecutionBackend, "execute" | "readOutput">;

export function taskEnvironmentRoute(
  backendRef: string,
  argumentsByRef: Map<string, readonly string[]>,
  backend: ContainerCalls,
): SandboxContainerRoute {
  return {
    backendRef,
    async execute(input) {
      const argumentsRef = `container-arguments:${randomUUID()}`;
      argumentsByRef.set(argumentsRef, input.argv);
      try {
        const { outputRef } = await backend.execute({
          identity: input.identity,
          createIntentId: input.createIntentId,
          locator: input.locator,
          stopFence: input.stopFence,
          invocationId: input.invocationId,
          argumentsRef,
          deadlineAt: input.deadlineAt,
        });
        const output = await backend.readOutput(outputRef);
        return {
          exitCode: output.exitCode,
          stdout: new TextEncoder().encode(output.stdout),
          truncated: output.truncated,
        };
      } finally {
        argumentsByRef.delete(argumentsRef);
      }
    },
  };
}

export function createWorkerTaskEnvironments(input: {
  readonly configuration: TaskEnvironmentConfiguration;
  readonly runtimeDirectory: string;
  readonly bindings: readonly SandboxHostBinding[];
  readonly now: () => Date;
}): {
  readonly containers: SandboxContainerRoute;
  readonly environments: ExecutionEnvironmentLifecyclePort;
  readonly resolveDirectory: ContainerExecutionBackendOptions["resolveDirectory"];
} {
  const { configuration } = input;
  const routed = input.bindings.filter((binding) =>
    binding.operationBindings?.some((entry) => entry.backendRef === configuration.backendRef),
  );
  const [first] = routed;
  if (!first) throw new Error("TASK_ENVIRONMENT_BINDING_UNAVAILABLE");
  if (
    routed.some(
      (binding) =>
        binding.runtimeRoot !== first.runtimeRoot || binding.runtimeDigest !== first.runtimeDigest,
    )
  )
    throw new Error("TASK_ENVIRONMENT_RUNTIME_AMBIGUOUS");
  if (containerRunnerDigest(first.runtimeDigest) !== configuration.runnerDigest)
    throw new Error("TASK_ENVIRONMENT_RUNNER_MISMATCH");
  const resolveDirectory: ContainerExecutionBackendOptions["resolveDirectory"] = async (
    directory,
  ) => {
    for (const binding of routed) {
      if (binding.hostId !== directory.hostId) continue;
      const root = binding.roots.find(
        (candidate) => candidate.canonicalRootId === directory.canonicalRootId,
      );
      if (root)
        return { canonicalPath: root.canonicalPath, device: root.device, inode: root.inode };
    }
    return null;
  };
  const argumentsByRef = new Map<string, readonly string[]>();
  const backend = new ContainerExecutionBackend({
    backendRef: configuration.backendRef,
    docker: dockerCli(
      configuration.dockerExecutable,
      configuration.dockerHost ? ["--host", configuration.dockerHost] : [],
    ),
    image: configuration.image,
    initUser: INIT_USER,
    taskUser: TASK_USER,
    stateDirectory: path.join(input.runtimeDirectory, "task-environments"),
    commandTimeoutMs: 30_000,
    stopGraceSeconds: 5,
    proofValidityMs: 60_000,
    maxOutputBytes: Math.max(
      ...routed.map((binding) => binding.maximumResourceCeiling.maxOutputBytes),
    ),
    now: input.now,
    readArguments: async (argumentsRef) => {
      const argv = argumentsByRef.get(argumentsRef);
      if (!argv) throw new Error("TASK_ENVIRONMENT_ARGUMENTS_UNKNOWN");
      return { argv };
    },
    resolveDirectory,
    hostDirectories: { maxScannedEntries: 20_000, maxProtectedEntries: 256 },
    diskGuard: {
      minFreeBytes: 1024 * 1024 * 1024,
      maxGrowthBytes: 256 * 1024 * 1024,
      intervalMs: 1000,
      freeBytes: hostFreeBytes,
    },
    egress: {
      image: configuration.egressImage,
      user: EGRESS_USER,
      readyAttempts: 50,
      readyIntervalMs: 100,
    },
    credentialIssuer: null,
    runtime: { source: first.runtimeRoot, digest: first.runtimeDigest },
  });
  return {
    containers: taskEnvironmentRoute(configuration.backendRef, argumentsByRef, backend),
    environments: backend,
    resolveDirectory,
  };
}
