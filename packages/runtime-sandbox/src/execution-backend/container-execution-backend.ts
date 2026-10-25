import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  EXECUTION_BACKEND_PROTOCOL_V1,
  type ExecutionBackendCapabilities,
  type ExecutionEnvelope,
  type ExecutionEnvironmentIdentity,
  type ExecutionEnvironmentLocator,
  type ExecutionEnvironmentStopProof,
  STOP_PROOF_COVERAGE,
  TASK_ENVIRONMENT_GUARANTEES,
} from "@himawari-agent/execution-contracts";
import {
  ContainerBackendError,
  type ContainerBackendErrorCode,
} from "./container-backend-error.ts";
import {
  type Container,
  canonical,
  effectiveMounts,
  expectedMounts,
  hasStopped,
  mountArguments,
  NEVER,
  type PinnedImage,
  parseJson,
  readJson,
  sha256,
  writeOnce,
} from "./container-records.ts";
import {
  containerRunnerDigest,
  INIT_NAME,
  INIT_SCRIPT,
  RUNTIME_MOUNT_TARGET,
  TASK_ENVIRONMENT,
  TASK_WORKDIR,
} from "./container-runner.ts";
import { type DockerCommand, DockerCommandTimeout } from "./docker-command.ts";
import {
  ContainerEgress,
  type ContainerEgressOptions,
  type EgressRecord,
  egressNames,
  egressProxyUrl,
} from "./egress-proxy.ts";
import {
  type ContainerMount,
  type HostDirectoryCapability,
  type HostDirectoryIdentity,
  type HostDirectoryLimits,
  type PreparedHostDirectories,
  prepareHostDirectories,
  verifyHostDirectory,
} from "./host-directories.ts";
import {
  credentialEnvironment,
  type TemporaryCredentialIssuer,
  type TemporaryCredentialRecord,
} from "./temporary-credential.ts";

const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
const RESERVED_VARIABLES = [
  ...TASK_ENVIRONMENT.map((variable) => variable.slice(0, variable.indexOf("="))),
  ...PROXY_VARIABLES,
  "NO_PROXY",
];
const LABEL = "io.himawari.environment.";
const INSPECT_OUTPUT_BYTES = 4 * 1024 * 1024;

export const CONTAINER_RUNNER_DIGEST = containerRunnerDigest(null);

export { ContainerBackendError, type ContainerBackendErrorCode };
export { containerRunnerDigest, RUNTIME_MOUNT_TARGET };
export type {
  TemporaryCredentialIssuer,
  TemporaryCredentialRequest,
} from "./temporary-credential.ts";

export interface ContainerExecutionBackendOptions {
  readonly backendRef: string;
  readonly docker: DockerCommand;
  readonly image: PinnedImage;
  readonly initUser: string;
  readonly taskUser: string;
  readonly stateDirectory: string;
  readonly commandTimeoutMs: number;
  readonly stopGraceSeconds: number;
  readonly proofValidityMs: number;
  readonly maxOutputBytes: number;
  readonly now: () => Date;
  readonly readArguments: (argumentsRef: string) => Promise<{ readonly argv: readonly string[] }>;
  readonly resolveDirectory: (
    directory: HostDirectoryCapability,
  ) => Promise<HostDirectoryIdentity | null>;
  readonly hostDirectories: HostDirectoryLimits;
  readonly diskGuard: {
    readonly minFreeBytes: number;
    readonly maxGrowthBytes: number;
    readonly intervalMs: number;
    readonly freeBytes: (directory: string) => Promise<number>;
  };
  readonly egress: ContainerEgressOptions;
  readonly credentialIssuer: TemporaryCredentialIssuer | null;
  readonly runtime: { readonly source: string; readonly digest: string } | null;
}

interface DiskGuardRecord {
  readonly roots: readonly { readonly directory: string; readonly baselineFreeBytes: number }[];
}

export interface DiskGuardBreach {
  readonly reason: "growth" | "floor" | "unavailable";
  readonly directory: string;
  readonly baselineFreeBytes: number;
  readonly freeBytes?: number;
  readonly consumedBytes?: number;
  readonly containerId: string;
  readonly observedAt: string;
}

export interface ContainerInvocationOutput {
  readonly invocationId: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

interface EnvironmentTarget {
  readonly identity: ExecutionEnvironmentIdentity;
  readonly createIntentId: string;
  readonly locator: ExecutionEnvironmentLocator | null;
}

type Observation =
  | { readonly kind: "unavailable"; readonly cause: unknown }
  | { readonly kind: "foreign" }
  | { readonly kind: "missing"; readonly daemonId: string }
  | { readonly kind: "mismatch" }
  | { readonly kind: "restarted"; readonly container: Container }
  | {
      readonly kind: "found";
      readonly daemonId: string;
      readonly container: Container;
      readonly locator: ExecutionEnvironmentLocator;
    };

interface StopRecord {
  readonly stopIntentId: string;
  readonly stopFence: number;
}
interface CredentialRevokedRecord {
  readonly credentialId: string;
  readonly revokedAt: string;
}
interface DestroyedRecord {
  readonly locator: ExecutionEnvironmentLocator;
  readonly evidence: { readonly ref: string; readonly digest: string };
}

export class ContainerExecutionBackend {
  private readonly options: ContainerExecutionBackendOptions;
  private readonly diskWatches = new Map<string, NodeJS.Timeout>();
  private readonly hostPublications = new Map<string, number>();
  private readonly egress: ContainerEgress;

  constructor(options: ContainerExecutionBackendOptions) {
    this.options = options;
    this.egress = new ContainerEgress(options.egress, {
      stateDirectory: options.stateDirectory,
      stopGraceSeconds: options.stopGraceSeconds,
      command: (args) => this.command(args),
      inspectContainer: (nameOrId) => this.inspectContainer(nameOrId),
      pinnedImageId: (image) => this.pinnedImageId(image),
      remove: (containerId) => this.remove(containerId),
      kill: (containerId) => this.kill(containerId),
    });
  }

  async capabilities(): Promise<ExecutionBackendCapabilities> {
    const daemon = await this.daemon();
    if (
      daemon.cgroupVersion !== "2" ||
      !daemon.securityOptions.some((option) => option.startsWith("name=seccomp"))
    )
      throw new ContainerBackendError("CONTAINER_POLICY_UNSUPPORTED");
    await this.pinnedImageId(this.options.image);
    await this.egress.imageId();
    return {
      protocolVersion: EXECUTION_BACKEND_PROTOCOL_V1,
      backendRef: this.options.backendRef,
      runtimeInstanceId: daemon.id,
      guarantees: TASK_ENVIRONMENT_GUARANTEES,
      checkedAt: this.now(),
    };
  }

  async create(input: {
    readonly identity: ExecutionEnvironmentIdentity;
    readonly createIntentId: string;
    readonly envelope: ExecutionEnvelope;
    readonly policyDigest: string;
    readonly imageDigest: string;
    readonly runnerDigest: string;
    readonly deadlineAt: string;
  }): Promise<ExecutionEnvironmentLocator> {
    if (input.imageDigest !== this.options.image.digest)
      throw new ContainerBackendError("CONTAINER_IMAGE_UNQUALIFIED");
    if (input.runnerDigest !== containerRunnerDigest(this.options.runtime?.digest ?? null))
      throw new ContainerBackendError("CONTAINER_RUNNER_UNQUALIFIED");
    const runtimeMounts = await this.runtimeMounts();
    const deadlineMs = Date.parse(input.deadlineAt);
    if (deadlineMs - this.options.now().getTime() <= 1000)
      throw new ContainerBackendError("CONTAINER_DEADLINE_PASSED");
    const files = await this.files(input.identity);
    if (await readJson(files.stop)) throw new ContainerBackendError("CONTAINER_EXECUTION_CLOSED");
    const directories = await prepareHostDirectories({
      hostId: input.identity.hostId,
      directories: input.envelope.directories,
      resolve: this.options.resolveDirectory,
      limits: this.options.hostDirectories,
      masks: await this.masks(),
    });
    const taskUser = this.taskUser(directories);
    const mounts = [...directories.mounts, ...runtimeMounts].sort((a, b) =>
      a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
    );
    await this.admitDisk(files, directories);
    const egressRecord =
      input.envelope.network.length > 0
        ? await this.egress.record(
            files,
            input.envelope.network.map((item) => item.target),
          )
        : null;
    const daemon = await this.daemon();
    const imageId = await this.pinnedImageId(this.options.image);
    const route = egressRecord
      ? await this.egress.prepare({
          files,
          record: egressRecord,
          labels: this.identityLabels(input.identity, input.createIntentId),
          deadlineEpoch: Math.floor(deadlineMs / 1000),
          closed: async () => (await readJson(files.stop)) !== null,
        })
      : null;
    const expected = this.expectedPolicy(
      input.envelope,
      imageId,
      Math.floor(deadlineMs / 1000),
      mounts,
      taskUser,
      route,
    );
    const name = containerName(input.identity);
    let container = await this.inspectContainer(name);
    if (!container) {
      const record = await writeOnce(files.create, {
        createIntentId: input.createIntentId,
        runtimeInstanceId: daemon.id,
      });
      if (record.createIntentId !== input.createIntentId)
        throw new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
      if (record.runtimeInstanceId !== daemon.id)
        throw new ContainerBackendError("CONTAINER_RUNTIME_CHANGED");
      const created = await this.command([
        "container",
        "create",
        ...this.createArguments(input, name, expected, mounts, taskUser, route),
      ]);
      if (created.exitCode !== 0)
        throw new ContainerBackendError(
          /Conflict/i.test(created.stderr)
            ? "CONTAINER_IDENTITY_CONFLICT"
            : "CONTAINER_RUNTIME_UNAVAILABLE",
        );
      container = await this.inspectContainer(name);
      if (!container) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    }
    if (!this.belongsTo(container, input.identity, input.createIntentId))
      throw new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
    const neverStarted = container.State.StartedAt === NEVER;
    if (canonical(effectivePolicy(container)) !== canonical(expected)) {
      if (neverStarted) await this.remove(container.Id);
      throw new ContainerBackendError("CONTAINER_POLICY_MISMATCH");
    }
    if (neverStarted) {
      if (await readJson(files.stop)) {
        await this.remove(container.Id);
        throw new ContainerBackendError("CONTAINER_EXECUTION_CLOSED");
      }
      await writeOnce(files.startIntent, { createIntentId: input.createIntentId });
      const started = await this.command(["container", "start", container.Id]);
      if (started.exitCode !== 0) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
      container = await this.inspectContainer(container.Id);
      if (!container) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    }
    const startedRecord = await writeOnce(files.started, {
      startedAt: container.State.StartedAt,
    });
    if (startedRecord.startedAt !== container.State.StartedAt || container.RestartCount > 0)
      throw new ContainerBackendError("CONTAINER_RESTARTED");
    try {
      for (const root of directories.roots) await verifyHostDirectory(root);
    } catch (cause) {
      await this.kill(container.Id);
      throw cause;
    }
    if (await this.guardDisk(files, container.Id))
      throw new ContainerBackendError("CONTAINER_DISK_GUARD_TRIPPED");
    return this.locatorFor(daemon.id, container, input.createIntentId);
  }

  async execute(
    input: EnvironmentTarget & {
      readonly stopFence: number;
      readonly invocationId: string;
      readonly argumentsRef: string;
      readonly deadlineAt: string;
      readonly credential?: { readonly secretRef: string; readonly approvalRef: string };
    },
  ): Promise<{ readonly outputRef: string; readonly observedAt: string }> {
    const files = await this.files(input.identity);
    if (await readJson(files.stop)) throw new ContainerBackendError("CONTAINER_EXECUTION_CLOSED");
    const remainingMs = Date.parse(input.deadlineAt) - this.options.now().getTime();
    if (remainingMs <= 0) throw new ContainerBackendError("CONTAINER_DEADLINE_PASSED");
    const observation = await this.observe(input);
    if (observation.kind !== "found") throw refusal(observation);
    const { container } = observation;
    if (await this.guardDisk(files, container.Id))
      throw new ContainerBackendError("CONTAINER_DISK_GUARD_TRIPPED");
    if (!container.State.Running || container.State.Paused)
      throw new ContainerBackendError("CONTAINER_NOT_RUNNING");
    const taskUser = container.Config.Labels?.[`${LABEL}task-user`];
    if (!taskUser) throw new ContainerBackendError("CONTAINER_POLICY_MISMATCH");
    const egressRecord = await readJson<EgressRecord>(files.egress);
    const proxyEnvironment = egressRecord
      ? PROXY_VARIABLES.map((variable) => `${variable}=${egressProxyUrl(egressRecord)}`).concat([
          "NO_PROXY=",
          "no_proxy=",
        ])
      : [];
    const { argv } = await this.options.readArguments(input.argumentsRef);
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((item) => typeof item !== "string" || item.includes("\0"))
    )
      throw new ContainerBackendError("CONTAINER_ARGUMENTS_INVALID");
    const invocationKey = sha256(input.invocationId);
    const outputFile = path.join(files.invocations, `${invocationKey}.json`);
    if (await readJson(outputFile)) throw new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
    const credential = input.credential
      ? await this.claimCredential(files, input, invocationKey, container)
      : null;
    if (!credential)
      await writeOnce(path.join(files.invocations, `${invocationKey}.started`), {
        invocationId: input.invocationId,
      });
    let result: Awaited<ReturnType<DockerCommand>> | null = null;
    let failure: unknown = null;
    let revoked = true;
    try {
      const environment = credential ? await this.issueCredential(credential) : {};
      result = await this.options.docker(
        [
          "container",
          "exec",
          "--user",
          taskUser,
          "--workdir",
          TASK_WORKDIR,
          ...[...TASK_ENVIRONMENT, ...proxyEnvironment, ...Object.keys(environment)].flatMap(
            (variable) => ["--env", variable],
          ),
          container.Id,
          ...argv,
        ],
        { timeoutMs: remainingMs, maxOutputBytes: this.options.maxOutputBytes, environment },
      );
    } catch (cause) {
      failure =
        cause instanceof ContainerBackendError
          ? cause
          : new ContainerBackendError(
              cause instanceof DockerCommandTimeout
                ? "CONTAINER_COMMAND_TIMEOUT"
                : "CONTAINER_RUNTIME_UNAVAILABLE",
              { cause },
            );
    } finally {
      if (credential) revoked = await this.revokeCredential(files, true);
    }
    if (!revoked) {
      await this.kill(container.Id);
      if (egressRecord) await this.egress.kill(files);
    }
    if (result)
      await writeOnce(outputFile, {
        invocationId: input.invocationId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      });
    if (!revoked) throw new ContainerBackendError("CONTAINER_CREDENTIAL_NOT_REVOKED");
    if (failure) throw failure;
    return {
      outputRef: `container-output:${files.key}:${invocationKey}`,
      observedAt: this.now(),
    };
  }

  private async claimCredential(
    files: Awaited<ReturnType<ContainerExecutionBackend["files"]>>,
    input: {
      readonly invocationId: string;
      readonly deadlineAt: string;
      readonly credential?: { readonly secretRef: string; readonly approvalRef: string };
    },
    invocationKey: string,
    container: Container,
  ): Promise<TemporaryCredentialRecord> {
    if (!input.credential || !this.options.credentialIssuer)
      throw new ContainerBackendError("CONTAINER_CREDENTIAL_UNAVAILABLE");
    if ((await readdir(files.invocations)).length > 0 || (await readJson(files.credential)))
      throw new ContainerBackendError("CONTAINER_CREDENTIAL_REFUSED");
    const environmentDeadline = container.Config.Labels?.[`${LABEL}deadline`] ?? "";
    const expiresAt = new Date(
      Math.min(Date.parse(input.deadlineAt), Date.parse(environmentDeadline)),
    );
    if (!Number.isFinite(expiresAt.getTime()))
      throw new ContainerBackendError("CONTAINER_POLICY_MISMATCH");
    const record = await writeOnce<TemporaryCredentialRecord>(
      files.credential,
      {
        credentialId: sha256(`${files.key}\n${invocationKey}`),
        invocationId: input.invocationId,
        secretRef: input.credential.secretRef,
        approvalRef: input.credential.approvalRef,
        expiresAt: expiresAt.toISOString(),
      },
      0o600,
    );
    if (record.invocationId !== input.invocationId)
      throw new ContainerBackendError("CONTAINER_CREDENTIAL_REFUSED");
    await writeOnce(path.join(files.invocations, `${invocationKey}.started`), {
      invocationId: input.invocationId,
    });
    if (await readJson(files.stop)) {
      await this.revokeCredential(files, true);
      throw new ContainerBackendError("CONTAINER_EXECUTION_CLOSED");
    }
    return record;
  }

  private async issueCredential(record: TemporaryCredentialRecord) {
    const issuer = this.options.credentialIssuer;
    if (!issuer) throw new ContainerBackendError("CONTAINER_CREDENTIAL_UNAVAILABLE");
    const issued = await issuer
      .issue({
        credentialId: record.credentialId,
        secretRef: record.secretRef,
        approvalRef: record.approvalRef,
        expiresAt: record.expiresAt,
      })
      .catch((cause: unknown) => {
        throw new ContainerBackendError("CONTAINER_CREDENTIAL_UNAVAILABLE", { cause });
      });
    const environment = credentialEnvironment(issued, record.expiresAt, RESERVED_VARIABLES);
    if (!environment) throw new ContainerBackendError("CONTAINER_CREDENTIAL_REFUSED");
    return environment;
  }

  private async revokeCredential(
    files: Awaited<ReturnType<ContainerExecutionBackend["files"]>>,
    attempt: boolean,
  ): Promise<boolean> {
    const record = await readJson<TemporaryCredentialRecord>(files.credential);
    if (!record || (await readJson(files.credentialRevoked))) return true;
    const issuer = this.options.credentialIssuer;
    if (!issuer) return false;
    try {
      if (attempt) await issuer.revoke(record.credentialId);
      if (!(await issuer.isRevoked(record.credentialId))) return false;
    } catch {
      return false;
    }
    await writeOnce<CredentialRevokedRecord>(files.credentialRevoked, {
      credentialId: record.credentialId,
      revokedAt: this.now(),
    });
    return true;
  }

  async readOutput(outputRef: string): Promise<ContainerInvocationOutput> {
    const match = /^container-output:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(outputRef);
    const output = match
      ? await readJson<ContainerInvocationOutput>(
          path.join(this.options.stateDirectory, match[1] ?? "", "invocations", `${match[2]}.json`),
        )
      : null;
    if (!output) throw new ContainerBackendError("CONTAINER_OUTPUT_UNKNOWN");
    return output;
  }

  async readEvidence(evidenceRef: string): Promise<string> {
    const match = /^container-evidence:([a-f0-9]{32}):([a-f0-9]{32}\.json)$/.exec(evidenceRef);
    if (!match) throw new ContainerBackendError("CONTAINER_OUTPUT_UNKNOWN");
    return readFile(
      path.join(this.options.stateDirectory, match[1] ?? "", "evidence", match[2] ?? ""),
      "utf8",
    ).catch((cause: unknown) => {
      throw new ContainerBackendError("CONTAINER_OUTPUT_UNKNOWN", { cause });
    });
  }

  async inspect(input: EnvironmentTarget): Promise<{
    readonly state: "running" | "stopped" | "not_found" | "unknown";
    readonly locator: ExecutionEnvironmentLocator | null;
    readonly observedAt: string;
  }> {
    const observation = await this.observe(input);
    const observedAt = this.now();
    if (observation.kind === "missing") return { state: "not_found", locator: null, observedAt };
    if (observation.kind !== "found") return { state: "unknown", locator: null, observedAt };
    const { container, locator } = observation;
    const files = await this.files(input.identity);
    const egress = (await readJson(files.egress)) !== null;
    if (container.State.Running || (egress && (await this.egress.running(files))))
      return { state: "running", locator, observedAt };
    return {
      state: isStopped(container, this.networkMode(files.key, egress)) ? "stopped" : "unknown",
      locator,
      observedAt,
    };
  }

  async publishOnHost(
    input: EnvironmentTarget & {
      readonly stopFence: number;
      readonly invocationId: string;
      readonly deadlineAt: string;
    },
    commit: () => Promise<{ readonly exitCode: number; readonly stdout: Uint8Array }>,
  ): Promise<{ readonly exitCode: number; readonly stdout: Uint8Array }> {
    const files = await this.files(input.identity);
    this.hostPublications.set(files.key, (this.hostPublications.get(files.key) ?? 0) + 1);
    try {
      if (await readJson(files.stop)) throw new ContainerBackendError("CONTAINER_EXECUTION_CLOSED");
      if (Date.parse(input.deadlineAt) <= this.options.now().getTime())
        throw new ContainerBackendError("CONTAINER_DEADLINE_PASSED");
      const observation = await this.observe(input);
      if (observation.kind !== "found") throw refusal(observation);
      const { container } = observation;
      if (await this.guardDisk(files, container.Id))
        throw new ContainerBackendError("CONTAINER_DISK_GUARD_TRIPPED");
      if (!container.State.Running || container.State.Paused)
        throw new ContainerBackendError("CONTAINER_NOT_RUNNING");
      const invocationKey = sha256(input.invocationId);
      try {
        await writeFile(
          path.join(files.invocations, `${invocationKey}.started`),
          `${JSON.stringify({ invocationId: input.invocationId, kind: "host_publication" })}\n`,
          { flag: "wx", mode: 0o644 },
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        throw new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
      }
      const result = await commit();
      await writeOnce(path.join(files.invocations, `${invocationKey}.json`), {
        invocationId: input.invocationId,
        kind: "host_publication",
        exitCode: result.exitCode,
        stdoutDigest: sha256(Buffer.from(result.stdout).toString("base64")),
        byteLength: result.stdout.byteLength,
      });
      return result;
    } finally {
      const remaining = (this.hostPublications.get(files.key) ?? 1) - 1;
      if (remaining) this.hostPublications.set(files.key, remaining);
      else this.hostPublications.delete(files.key);
    }
  }

  async stop(
    input: EnvironmentTarget & { readonly stopIntentId: string; readonly stopFence: number },
  ): Promise<{ readonly accepted: true }> {
    const files = await this.files(input.identity);
    this.unwatchDisk(files.key);
    await writeOnce(files.stop, { stopIntentId: input.stopIntentId, stopFence: input.stopFence });
    if (await readJson(files.egress)) await this.egress.stop(files);
    const revoked = await this.revokeCredential(files, true);
    const observation = await this.observe(input);
    if (observation.kind !== "missing") {
      if (observation.kind !== "found" && observation.kind !== "restarted")
        throw refusal(observation);
      const stopped = await this.command([
        "container",
        "stop",
        "--time",
        String(this.options.stopGraceSeconds),
        observation.container.Id,
      ]);
      if (stopped.exitCode !== 0) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    }
    if (!revoked) throw new ContainerBackendError("CONTAINER_CREDENTIAL_NOT_REVOKED");
    return { accepted: true };
  }

  async verifyStopped(
    input: EnvironmentTarget & { readonly stopIntentId: string; readonly stopFence: number },
  ): Promise<ExecutionEnvironmentStopProof> {
    const files = await this.files(input.identity);
    const stop = await readJson<StopRecord>(files.stop);
    if (stop?.stopIntentId !== input.stopIntentId)
      throw new ContainerBackendError("CONTAINER_STOP_NOT_REQUESTED");
    if (this.hostPublications.has(files.key))
      throw new ContainerBackendError("CONTAINER_NOT_STOPPED");
    if (!(await this.revokeCredential(files, false)))
      throw new ContainerBackendError("CONTAINER_CREDENTIAL_NOT_REVOKED");
    const credential = await readJson<CredentialRevokedRecord>(files.credentialRevoked);
    const observation = await this.observe(input);
    const destroyed = await readJson<DestroyedRecord>(files.destroyed);
    const egress = (await readJson(files.egress)) !== null;
    const egressProxy = egress
      ? await this.egress.stoppedProxy({
          files,
          labels: this.identityLabels(input.identity, input.createIntentId),
          destroyed: destroyed !== null,
        })
      : null;
    const checkedAt = this.options.now();
    const proof = {
      identity: input.identity,
      createIntentId: input.createIntentId,
      stopIntentId: input.stopIntentId,
      stopFence: input.stopFence,
      verifierRef: this.options.backendRef,
      checkedAt: checkedAt.toISOString(),
      validUntil: new Date(checkedAt.getTime() + this.options.proofValidityMs).toISOString(),
    };
    if (observation.kind === "missing") {
      if (
        destroyed &&
        (input.locator === null ||
          destroyed.locator.runtimeEnvironmentId === input.locator.runtimeEnvironmentId)
      )
        return {
          basis: "verified_stopped",
          ...proof,
          evidence: [destroyed.evidence],
          locator: destroyed.locator,
          coverage: [...STOP_PROOF_COVERAGE],
        };
      if (await readJson(files.startIntent))
        throw new ContainerBackendError("CONTAINER_STOP_UNVERIFIED");
      const evidence = await this.saveEvidence(files, {
        neverStarted: true,
        daemonId: observation.daemonId,
        create: await readJson(files.create),
        egress: egressProxy,
        stop,
        checkedAt: proof.checkedAt,
      });
      return { basis: "never_created", ...proof, evidence: [evidence] };
    }
    if (observation.kind !== "found") throw refusal(observation);
    if (!isStopped(observation.container, this.networkMode(files.key, egress)))
      throw new ContainerBackendError("CONTAINER_NOT_STOPPED");
    const evidence = await this.saveEvidence(files, {
      container: observation.container,
      egress: egressProxy,
      credential,
      daemonId: observation.daemonId,
      stop,
      checkedAt: proof.checkedAt,
    });
    return {
      basis: "verified_stopped",
      ...proof,
      evidence: [evidence],
      locator: observation.locator,
      coverage: [...STOP_PROOF_COVERAGE],
    };
  }

  async diskGuardBreach(input: EnvironmentTarget): Promise<DiskGuardBreach | null> {
    return readJson<DiskGuardBreach>((await this.files(input.identity)).diskBreach);
  }

  async destroy(input: EnvironmentTarget): Promise<void> {
    const files = await this.files(input.identity);
    const stop = await readJson<StopRecord>(files.stop);
    if (!stop || this.hostPublications.has(files.key))
      throw new ContainerBackendError("CONTAINER_NOT_STOPPED");
    if (!(await this.revokeCredential(files, false)))
      throw new ContainerBackendError("CONTAINER_CREDENTIAL_NOT_REVOKED");
    this.unwatchDisk(files.key);
    const egress = (await readJson(files.egress)) !== null;
    const observation = await this.observe(input);
    if (observation.kind === "missing") {
      if (!(await readJson(files.destroyed)))
        throw new ContainerBackendError("CONTAINER_STOP_UNVERIFIED");
      if (egress) await this.egress.destroy(files);
      return;
    }
    if (observation.kind !== "found") throw refusal(observation);
    if (!isStopped(observation.container, this.networkMode(files.key, egress)))
      throw new ContainerBackendError("CONTAINER_NOT_STOPPED");
    const egressProxy = egress
      ? await this.egress.stoppedProxy({
          files,
          labels: this.identityLabels(input.identity, input.createIntentId),
          destroyed: false,
        })
      : null;
    const evidence = await this.saveEvidence(files, {
      container: observation.container,
      egress: egressProxy,
      credential: await readJson<CredentialRevokedRecord>(files.credentialRevoked),
      daemonId: observation.daemonId,
      stop,
      destroyed: true,
      checkedAt: this.now(),
    });
    await writeOnce(files.destroyed, { locator: observation.locator, evidence });
    await this.remove(observation.container.Id);
    if (egress) await this.egress.destroy(files);
  }

  private networkMode(key: string, egress: boolean) {
    return egress ? egressNames(key).network : "none";
  }

  private async observe(target: EnvironmentTarget): Promise<Observation> {
    const files = await this.files(target.identity);
    let daemonId: string;
    let container: Container | null;
    try {
      daemonId = (await this.daemon()).id;
      const expectedRuntime =
        target.locator?.runtimeInstanceId ??
        (await readJson<{ runtimeInstanceId: string }>(files.create))?.runtimeInstanceId;
      if (
        (expectedRuntime !== undefined && expectedRuntime !== daemonId) ||
        (target.locator !== null && target.locator.backendRef !== this.options.backendRef)
      )
        return { kind: "foreign" };
      container = await this.inspectContainer(containerName(target.identity));
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
    if (!container) return { kind: "missing", daemonId };
    if (!this.belongsTo(container, target.identity, target.createIntentId))
      return { kind: "mismatch" };
    const locator = this.locatorFor(daemonId, container, target.createIntentId);
    if (
      target.locator !== null &&
      (target.locator.runtimeEnvironmentId !== container.Id ||
        target.locator.effectivePolicyDigest !== locator.effectivePolicyDigest ||
        target.locator.createIntentId !== target.createIntentId)
    )
      return { kind: "mismatch" };
    if (container.RestartCount > 0) return { kind: "restarted", container };
    if (container.State.StartedAt !== NEVER) {
      if (!(await readJson(files.startIntent))) return { kind: "restarted", container };
      const started = await writeOnce(files.started, { startedAt: container.State.StartedAt });
      if (started.startedAt !== container.State.StartedAt) return { kind: "restarted", container };
    }
    return { kind: "found", daemonId, container, locator };
  }

  private belongsTo(
    container: Container,
    identity: ExecutionEnvironmentIdentity,
    createIntentId: string,
  ) {
    const labels = container.Config.Labels ?? {};
    return (
      container.Name === `/${containerName(identity)}` &&
      Object.entries(this.identityLabels(identity, createIntentId)).every(
        ([key, value]) => labels[key] === value,
      )
    );
  }

  private identityLabels(identity: ExecutionEnvironmentIdentity, createIntentId: string) {
    return {
      [`${LABEL}schema`]: identity.schemaVersion,
      [`${LABEL}owner`]: identity.ownerId,
      [`${LABEL}agent`]: identity.agentId,
      [`${LABEL}run`]: identity.runId,
      [`${LABEL}host`]: identity.hostId,
      [`${LABEL}job`]: identity.executionJobId,
      [`${LABEL}id`]: identity.environmentId,
      [`${LABEL}generation`]: String(identity.environmentGeneration),
      [`${LABEL}role`]: identity.role,
      [`${LABEL}create-intent`]: createIntentId,
      [`${LABEL}backend`]: this.options.backendRef,
    };
  }

  private createArguments(
    input: Parameters<ContainerExecutionBackend["create"]>[0],
    name: string,
    expected: ReturnType<ContainerExecutionBackend["expectedPolicy"]>,
    mounts: readonly ContainerMount[],
    taskUser: string,
    route: { readonly network: string; readonly proxyId: string } | null,
  ) {
    const labels = {
      ...this.identityLabels(input.identity, input.createIntentId),
      [`${LABEL}policy-digest`]: input.policyDigest,
      [`${LABEL}image-digest`]: input.imageDigest,
      [`${LABEL}runner-digest`]: input.runnerDigest,
      [`${LABEL}deadline`]: input.deadlineAt,
      [`${LABEL}task-user`]: taskUser,
      ...(route ? { [`${LABEL}egress-proxy`]: route.proxyId } : {}),
      ...(this.options.runtime ? { [`${LABEL}runtime-digest`]: this.options.runtime.digest } : {}),
    };
    return [
      "--name",
      name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--user",
      this.options.initUser,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--network",
      expected.networkMode,
      "--restart",
      "no",
      "--pull",
      "never",
      "--pids-limit",
      String(expected.pidsLimit),
      "--memory",
      String(expected.memory),
      "--memory-swap",
      String(expected.memorySwap),
      "--cpus",
      String(input.envelope.resources.cpuMillicores / 1000),
      "--ipc",
      "private",
      "--tmpfs",
      `${TASK_WORKDIR}:${expected.tmpfs[TASK_WORKDIR]}`,
      ...mountArguments(mounts),
      "--stop-timeout",
      String(this.options.stopGraceSeconds),
      "--log-driver",
      "none",
      "--hostname",
      "himawari",
      "--workdir",
      TASK_WORKDIR,
      "--entrypoint",
      "/bin/sh",
      expected.image,
      ...expected.cmd,
    ];
  }

  private expectedPolicy(
    envelope: ExecutionEnvelope,
    imageId: string,
    deadlineEpoch: number,
    mounts: readonly ContainerMount[],
    taskUser: string,
    route: { readonly network: string; readonly proxyId: string } | null,
  ) {
    const { resources } = envelope;
    return {
      user: this.options.initUser,
      taskUser,
      egressProxy: route?.proxyId ?? null,
      image: imageId,
      entrypoint: ["/bin/sh"],
      cmd: ["-c", INIT_SCRIPT, INIT_NAME, String(deadlineEpoch)],
      readonlyRootfs: true,
      capDrop: ["ALL"],
      capAdd: null,
      securityOpt: ["no-new-privileges=true"],
      networkMode: route?.network ?? "none",
      privileged: false,
      restartPolicy: "no",
      pidsLimit: resources.maxProcesses,
      memory: resources.memoryBytes,
      memorySwap: resources.memoryBytes,
      nanoCpus: resources.cpuMillicores * 1_000_000,
      tmpfs: {
        [TASK_WORKDIR]: `rw,nosuid,nodev,size=${resources.privateStorageBytes},mode=1777`,
      },
      binds: null,
      ...expectedMounts(mounts),
      devices: [],
      pidMode: "",
      ipcMode: "private",
      usernsMode: "",
      logType: "none",
    };
  }

  private locatorFor(
    daemonId: string,
    container: Container,
    createIntentId: string,
  ): ExecutionEnvironmentLocator {
    return {
      backendRef: this.options.backendRef,
      runtimeInstanceId: daemonId,
      runtimeEnvironmentId: container.Id,
      createIntentId,
      effectivePolicyDigest: sha256(canonical(effectivePolicy(container))),
    };
  }

  private async daemon() {
    const result = await this.command(["system", "info", "--format", "{{json .}}"]);
    const info = result.exitCode === 0 ? parseJson(result.stdout) : null;
    if (!info || typeof info["ID"] !== "string" || info["ID"] === "")
      throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    return {
      id: info["ID"],
      cgroupVersion: String(info["CgroupVersion"] ?? ""),
      securityOptions: Array.isArray(info["SecurityOptions"])
        ? info["SecurityOptions"].map(String)
        : [],
    };
  }

  private async pinnedImageId({ reference, digest, pin }: PinnedImage) {
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new ContainerBackendError("CONTAINER_IMAGE_UNQUALIFIED");
    const result = await this.command([
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      pin === "image-id" ? `sha256:${digest}` : `${reference}@sha256:${digest}`,
    ]);
    const image = result.exitCode === 0 ? parseJson(result.stdout) : null;
    const id = image?.["Id"];
    const repoDigests = image?.["RepoDigests"];
    const pinned =
      pin === "image-id"
        ? id === `sha256:${digest}`
        : Array.isArray(repoDigests) &&
          repoDigests.some((item) => String(item).endsWith(`@sha256:${digest}`));
    if (typeof id !== "string" || !pinned)
      throw new ContainerBackendError("CONTAINER_IMAGE_UNQUALIFIED");
    return id;
  }

  private async inspectContainer(nameOrId: string): Promise<Container | null> {
    const result = await this.command(
      ["container", "inspect", "--format", "{{json .}}", nameOrId],
      INSPECT_OUTPUT_BYTES,
    );
    if (result.exitCode !== 0) {
      if (/No such container/i.test(result.stderr)) return null;
      throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    }
    const container = parseJson(result.stdout);
    if (!container || typeof container["Id"] !== "string")
      throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    return container as unknown as Container;
  }

  private async remove(containerId: string) {
    const removed = await this.command(["container", "rm", containerId]);
    if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr))
      throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
  }

  private async command(args: readonly string[], maxOutputBytes = 1024 * 1024) {
    try {
      return await this.options.docker(args, {
        timeoutMs: this.options.commandTimeoutMs,
        maxOutputBytes,
      });
    } catch (cause) {
      throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE", { cause });
    }
  }

  private async saveEvidence(
    files: Awaited<ReturnType<ContainerExecutionBackend["files"]>>,
    content: unknown,
  ) {
    const text = `${JSON.stringify(content, null, 2)}\n`;
    const digest = sha256(text);
    const name = `${digest.slice(0, 32)}.json`;
    const file = path.join(files.evidence, name);
    await writeFile(`${file}.tmp`, text);
    await rename(`${file}.tmp`, file);
    return { ref: `container-evidence:${files.key}:${name}`, digest };
  }

  private async files(identity: ExecutionEnvironmentIdentity) {
    const key = environmentKey(identity);
    const directory = path.join(this.options.stateDirectory, key);
    await mkdir(path.join(directory, "evidence"), { recursive: true });
    await mkdir(path.join(directory, "invocations"), { recursive: true });
    return {
      key,
      create: path.join(directory, "create.json"),
      startIntent: path.join(directory, "start-intent.json"),
      started: path.join(directory, "started.json"),
      stop: path.join(directory, "stop.json"),
      destroyed: path.join(directory, "destroyed.json"),
      diskGuard: path.join(directory, "disk-guard.json"),
      diskBreach: path.join(directory, "disk-breach.json"),
      egress: path.join(directory, "egress.json"),
      egressStartIntent: path.join(directory, "egress-start-intent.json"),
      egressStarted: path.join(directory, "egress-started.json"),
      credential: path.join(directory, "credential.json"),
      credentialRevoked: path.join(directory, "credential-revoked.json"),
      evidence: path.join(directory, "evidence"),
      invocations: path.join(directory, "invocations"),
    };
  }

  private async masks() {
    const directory = path.join(this.options.stateDirectory, "masks");
    const file = path.join(directory, "file");
    const folder = path.join(directory, "directory");
    await mkdir(folder, { recursive: true });
    await writeFile(file, "", { flag: "wx", mode: 0o444 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await chmod(file, 0o444);
    await chmod(folder, 0o555);
    return { file: await realpath(file), directory: await realpath(folder) };
  }

  private async runtimeMounts(): Promise<ContainerMount[]> {
    const runtime = this.options.runtime;
    if (!runtime) return [];
    const info = await lstat(runtime.source).catch(() => null);
    const resolved = await realpath(runtime.source).catch(() => null);
    if (
      !info?.isDirectory() ||
      resolved !== runtime.source ||
      !/^[a-f0-9]{64}$/.test(runtime.digest)
    )
      throw new ContainerBackendError("CONTAINER_RUNNER_UNQUALIFIED");
    return [{ source: runtime.source, target: RUNTIME_MOUNT_TARGET, readOnly: true }];
  }

  private taskUser(directories: PreparedHostDirectories) {
    if (!directories.owner) return this.options.taskUser;
    const { uid, gid } = directories.owner;
    if (uid === 0 || String(uid) === this.options.initUser.split(":")[0])
      throw new ContainerBackendError("CONTAINER_DIRECTORY_OWNER_UNSUPPORTED");
    return `${uid}:${gid}`;
  }

  private async admitDisk(
    files: Awaited<ReturnType<ContainerExecutionBackend["files"]>>,
    directories: PreparedHostDirectories,
  ) {
    const roots: DiskGuardRecord["roots"][number][] = [];
    for (const root of directories.roots.filter((item) => item.access === "write")) {
      const free = await this.options.diskGuard.freeBytes(root.canonicalPath).catch(() => NaN);
      if (!Number.isFinite(free))
        throw new ContainerBackendError("CONTAINER_DISK_GUARD_UNAVAILABLE");
      if (free < this.options.diskGuard.minFreeBytes)
        throw new ContainerBackendError("CONTAINER_DISK_FLOOR");
      roots.push({ directory: root.canonicalPath, baselineFreeBytes: free });
    }
    if (roots.length > 0) await writeOnce<DiskGuardRecord>(files.diskGuard, { roots });
  }

  private async guardDisk(
    files: Awaited<ReturnType<ContainerExecutionBackend["files"]>>,
    containerId: string,
  ) {
    if (!this.diskWatches.has(files.key)) {
      const result = await this.checkDisk(files, containerId);
      if (result !== "settled") this.watchDisk(files, containerId);
    }
    return (await readJson(files.diskBreach)) !== null;
  }

  private async checkDisk(
    files: Awaited<ReturnType<ContainerExecutionBackend["files"]>>,
    containerId: string,
  ): Promise<"clear" | "settled" | "retry"> {
    const guard = await readJson<DiskGuardRecord>(files.diskGuard);
    if (!guard) return "settled";
    if (!(await readJson(files.diskBreach))) {
      const breach = await this.observeDisk(guard);
      if (!breach) return "clear";
      await writeOnce<DiskGuardBreach>(files.diskBreach, {
        ...breach,
        containerId,
        observedAt: this.now(),
      });
    }
    const killed = await this.kill(containerId);
    const proxyKilled = (await readJson(files.egress)) ? await this.egress.kill(files) : true;
    return killed && proxyKilled ? "settled" : "retry";
  }

  private async observeDisk(guard: DiskGuardRecord) {
    const { freeBytes, minFreeBytes, maxGrowthBytes } = this.options.diskGuard;
    for (const { directory, baselineFreeBytes } of guard.roots) {
      const free = await freeBytes(directory).catch(() => NaN);
      if (!Number.isFinite(free))
        return { reason: "unavailable" as const, directory, baselineFreeBytes };
      const observed = { directory, baselineFreeBytes, freeBytes: free };
      const consumedBytes = baselineFreeBytes - free;
      if (free < minFreeBytes) return { reason: "floor" as const, ...observed, consumedBytes };
      if (consumedBytes > maxGrowthBytes)
        return { reason: "growth" as const, ...observed, consumedBytes };
    }
    return null;
  }

  private watchDisk(
    files: Awaited<ReturnType<ContainerExecutionBackend["files"]>>,
    containerId: string,
  ) {
    const timer = setTimeout(async () => {
      if (this.diskWatches.get(files.key) !== timer) return;
      const result = await this.checkDisk(files, containerId).catch(() => "retry" as const);
      if (this.diskWatches.get(files.key) !== timer) return;
      if (result === "settled") this.diskWatches.delete(files.key);
      else this.watchDisk(files, containerId);
    }, this.options.diskGuard.intervalMs);
    timer.unref();
    this.diskWatches.set(files.key, timer);
  }

  private unwatchDisk(key: string) {
    clearTimeout(this.diskWatches.get(key));
    this.diskWatches.delete(key);
  }

  private async kill(containerId: string) {
    const killed = await this.command(["container", "kill", containerId]).catch(() => null);
    return (
      killed !== null &&
      (killed.exitCode === 0 || /is not running|No such container/i.test(killed.stderr))
    );
  }

  private now() {
    return this.options.now().toISOString();
  }
}

function refusal(observation: Exclude<Observation, { readonly kind: "found" }>) {
  if (observation.kind === "unavailable")
    return new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE", {
      cause: observation.cause,
    });
  if (observation.kind === "foreign") return new ContainerBackendError("CONTAINER_RUNTIME_CHANGED");
  if (observation.kind === "restarted") return new ContainerBackendError("CONTAINER_RESTARTED");
  if (observation.kind === "missing") return new ContainerBackendError("CONTAINER_NOT_RUNNING");
  return new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
}

function isStopped(container: Container, networkMode: string) {
  return hasStopped(container) && container.HostConfig["NetworkMode"] === networkMode;
}

function effectivePolicy(container: Container) {
  const host = container.HostConfig;
  return {
    user: container.Config.User,
    taskUser: container.Config.Labels?.[`${LABEL}task-user`] ?? null,
    egressProxy: container.Config.Labels?.[`${LABEL}egress-proxy`] ?? null,
    image: container.Image,
    entrypoint: container.Config.Entrypoint,
    cmd: container.Config.Cmd,
    readonlyRootfs: host["ReadonlyRootfs"],
    capDrop: host["CapDrop"],
    capAdd: host["CapAdd"] ?? null,
    securityOpt: host["SecurityOpt"],
    networkMode: host["NetworkMode"],
    privileged: host["Privileged"],
    restartPolicy: host.RestartPolicy?.Name,
    pidsLimit: host["PidsLimit"],
    memory: host["Memory"],
    memorySwap: host["MemorySwap"],
    nanoCpus: host["NanoCpus"],
    tmpfs: host["Tmpfs"],
    binds: host["Binds"] ?? null,
    ...effectiveMounts(container),
    devices: host["Devices"] ?? [],
    pidMode: host["PidMode"],
    ipcMode: host["IpcMode"],
    usernsMode: host["UsernsMode"],
    logType: host.LogConfig?.Type,
  };
}

function containerName(identity: ExecutionEnvironmentIdentity) {
  return `himawari-env-${environmentKey(identity)}`;
}

function environmentKey(identity: ExecutionEnvironmentIdentity) {
  return sha256(`${identity.ownerId}\n${identity.agentId}\n${identity.environmentId}`).slice(0, 32);
}
