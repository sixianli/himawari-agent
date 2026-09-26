import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionBackendPort } from "@himawari-agent/application";
import {
  EXECUTION_ENVELOPE_V1,
  EXECUTION_ENVIRONMENT_V1,
  type ExecutionEnvironmentIdentity,
  type ExecutionEnvironmentLocator,
  executionEnvironmentStopProofSchema,
} from "@himawari-agent/execution-contracts";
import {
  CONTAINER_RUNNER_DIGEST,
  ContainerExecutionBackend,
  type ContainerExecutionBackendOptions,
  dockerCli,
  type HostDirectoryIdentity,
  hostFreeBytes,
} from "@himawari-agent/runtime-sandbox";

export const dockerExecutable = process.env["HIMAWARI_CONTAINER_DOCKER_CLI"] ?? "docker";
export const dockerHost = process.env["HIMAWARI_CONTAINER_DOCKER_HOST"] ?? "";
export const evidencePath = process.env["HIMAWARI_CONTAINER_EVIDENCE_PATH"];
const workRoot = process.env["HIMAWARI_CONTAINER_WORK_ROOT"] ?? os.tmpdir();
export const IMAGE_REFERENCE = "docker.io/library/busybox";
export const IMAGE_DIGEST = "bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
export const EGRESS_IMAGE_REFERENCE = "docker.io/library/node";
export const EGRESS_IMAGE_DIGEST =
  "e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd";
export const RESOURCES = {
  cpuMillicores: 500,
  memoryBytes: 128 * 1024 * 1024,
  maxProcesses: 64,
  privateStorageBytes: 16 * 1024 * 1024,
};
export const DISK_GUARD = {
  minFreeBytes: 1024 * 1024 * 1024,
  maxGrowthBytes: 256 * 1024 * 1024,
  intervalMs: 1000,
};

const docker = dockerCli(dockerExecutable, dockerHost ? ["--host", dockerHost] : []);
export const direct = async (...args: string[]) =>
  docker(args, { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });

export type QualificationBackend = ReturnType<ContainerQualification["backend"]>;
export interface QualificationTarget {
  readonly identity: ExecutionEnvironmentIdentity;
  readonly createIntentId: string;
}

export class ContainerQualification {
  readonly runId = `run-q-${randomUUID().slice(0, 8)}`;
  readonly observations: Record<string, unknown> = {};
  readonly argumentsByRef = new Map<string, { readonly argv: readonly string[] }>();
  readonly approved = new Map<string, HostDirectoryIdentity>();
  stateDirectory = "";
  hostRoot = "";
  private sequence = 0;

  async setup() {
    const root = await realpath(workRoot);
    this.stateDirectory = await mkdtemp(path.join(root, "container-qualification-"));
    this.hostRoot = await mkdtemp(path.join(root, "container-host-"));
  }

  async cleanup() {
    const listed = await direct(
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=io.himawari.environment.run=${this.runId}`,
    );
    const ids = listed.stdout.split("\n").filter(Boolean);
    if (ids.length) await direct("container", "rm", "--force", ...ids);
    this.observations["leftoverContainersRemoved"] = ids.length;
    const networks = (
      await direct(
        "network",
        "ls",
        "--quiet",
        "--filter",
        `label=io.himawari.environment.run=${this.runId}`,
      )
    ).stdout
      .split("\n")
      .filter(Boolean);
    if (networks.length) await direct("network", "rm", ...networks);
    this.observations["leftoverNetworksRemoved"] = networks.length;
    if (evidencePath)
      await writeFile(
        evidencePath,
        `${JSON.stringify({ runId: this.runId, observations: this.observations }, null, 2)}\n`,
      );
    await rm(this.stateDirectory, { recursive: true, force: true });
    await rm(this.hostRoot, { recursive: true, force: true });
  }

  backend(host = dockerHost, overrides: Partial<ContainerExecutionBackendOptions> = {}) {
    const subject = new ContainerExecutionBackend({
      backendRef: "container-docker:qualification",
      docker: dockerCli(dockerExecutable, host ? ["--host", host] : []),
      image: { reference: IMAGE_REFERENCE, digest: IMAGE_DIGEST },
      initUser: "65532:65532",
      taskUser: "65534:65534",
      stateDirectory: this.stateDirectory,
      commandTimeoutMs: 30_000,
      stopGraceSeconds: 1,
      proofValidityMs: 60_000,
      maxOutputBytes: 64 * 1024,
      now: () => new Date(Math.floor(Date.now())),
      readArguments: async (ref) => {
        const value = this.argumentsByRef.get(ref);
        if (!value) throw new Error("unknown arguments");
        return value;
      },
      resolveDirectory: async (directory) => this.approved.get(directory.canonicalRootId) ?? null,
      egress: {
        image: { reference: EGRESS_IMAGE_REFERENCE, digest: EGRESS_IMAGE_DIGEST },
        user: "65533:65533",
        readyAttempts: 50,
        readyIntervalMs: 100,
      },
      hostDirectories: { maxScannedEntries: 20_000, maxProtectedEntries: 256 },
      diskGuard: { ...DISK_GUARD, freeBytes: hostFreeBytes },
      credentialIssuer: null,
      ...overrides,
    });
    const port: ExecutionBackendPort = subject;
    return Object.assign(port, {
      readOutput: subject.readOutput.bind(subject),
      readEvidence: subject.readEvidence.bind(subject),
      diskGuardBreach: subject.diskGuardBreach.bind(subject),
    });
  }

  environment(
    deadlineSeconds = 600,
    directories: ReturnType<typeof grant>[] = [],
    targets: string[] = [],
  ) {
    this.sequence += 1;
    const identity: ExecutionEnvironmentIdentity = {
      schemaVersion: EXECUTION_ENVIRONMENT_V1,
      ownerId: "owner-q",
      agentId: "agent-q",
      runId: this.runId,
      hostId: "host-q",
      executionJobId: `job-${this.sequence}`,
      environmentId: `${this.runId}-environment-${this.sequence}`,
      environmentGeneration: 1,
      role: "primary",
    };
    const createIntentId = `create-${this.sequence}`;
    const deadlineAt = new Date(Date.now() + deadlineSeconds * 1000).toISOString();
    return {
      identity,
      createIntentId,
      deadlineAt,
      create: {
        identity,
        createIntentId,
        envelope: {
          schemaVersion: EXECUTION_ENVELOPE_V1,
          directories,
          network: targets.map((target) => ({ target, source: grant(target, "read").source })),
          resources: RESOURCES,
        },
        policyDigest: "b".repeat(64),
        imageDigest: IMAGE_DIGEST,
        runnerDigest: CONTAINER_RUNNER_DIGEST,
        deadlineAt,
      },
    };
  }

  async run(
    subject: QualificationBackend,
    target: QualificationTarget,
    locator: ExecutionEnvironmentLocator,
    script: string,
  ) {
    const ref = `arguments-${randomUUID()}`;
    this.argumentsByRef.set(ref, { argv: ["sh", "-c", script] });
    const { outputRef } = await subject.execute({
      identity: target.identity,
      createIntentId: target.createIntentId,
      locator,
      stopFence: 0,
      invocationId: `invocation-${randomUUID()}`,
      argumentsRef: ref,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return subject.readOutput(outputRef);
  }
}

export function grant(canonicalRootId: string, access: "read" | "write") {
  return {
    hostId: "host-q",
    grantRef: `grant-${canonicalRootId}`,
    canonicalRootId,
    access,
    source: {
      authorizationRef: `authorization-${canonicalRootId}`,
      decidedBy: "user" as const,
      delegationListRef: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
}

export function lines(stdout: string) {
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

export async function stopAndProve(
  subject: QualificationBackend,
  target: QualificationTarget,
  locator: ExecutionEnvironmentLocator,
  stopIntentId = "stop-1",
) {
  const request = { ...target, locator, stopIntentId, stopFence: 1 };
  await subject.stop(request);
  return executionEnvironmentStopProofSchema.parse(await subject.verifyStopped(request));
}
