import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
import { type DockerCommand, DockerCommandTimeout } from "./docker-command.ts";

const INIT_SCRIPT = 'd=$1; while [ "$(date +%s)" -lt "$d" ]; do sleep 1; done';
const INIT_NAME = "himawari-init";
const TASK_WORKDIR = "/tmp";
const TASK_ENVIRONMENT = [
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "XDG_CACHE_HOME=/tmp/.cache",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
];
const LABEL = "io.himawari.environment.";
const NEVER = "0001-01-01T00:00:00Z";
const INSPECT_OUTPUT_BYTES = 4 * 1024 * 1024;
const STOPPED_STATUSES = new Set(["exited", "created", "dead"]);

export const CONTAINER_RUNNER_DIGEST = sha256(
  canonical({
    init: ["/bin/sh", "-c", INIT_SCRIPT, INIT_NAME],
    task: { environment: TASK_ENVIRONMENT, workdir: TASK_WORKDIR },
  }),
);
const GUARANTEES = TASK_ENVIRONMENT_GUARANTEES.filter((item) => item !== "task-egress-policy.v1");

export type ContainerBackendErrorCode =
  | "CONTAINER_RUNTIME_UNAVAILABLE"
  | "CONTAINER_RUNTIME_CHANGED"
  | "CONTAINER_IMAGE_UNQUALIFIED"
  | "CONTAINER_RUNNER_UNQUALIFIED"
  | "CONTAINER_POLICY_UNSUPPORTED"
  | "CONTAINER_POLICY_MISMATCH"
  | "CONTAINER_IDENTITY_CONFLICT"
  | "CONTAINER_DEADLINE_PASSED"
  | "CONTAINER_EXECUTION_CLOSED"
  | "CONTAINER_NOT_RUNNING"
  | "CONTAINER_RESTARTED"
  | "CONTAINER_ARGUMENTS_INVALID"
  | "CONTAINER_COMMAND_TIMEOUT"
  | "CONTAINER_OUTPUT_UNKNOWN"
  | "CONTAINER_STOP_NOT_REQUESTED"
  | "CONTAINER_NOT_STOPPED"
  | "CONTAINER_STOP_UNVERIFIED";

export class ContainerBackendError extends Error {
  readonly code: ContainerBackendErrorCode;

  constructor(code: ContainerBackendErrorCode, options?: { readonly cause?: unknown }) {
    super(code, options);
    this.name = "ContainerBackendError";
    this.code = code;
  }
}

export interface ContainerExecutionBackendOptions {
  readonly backendRef: string;
  readonly docker: DockerCommand;
  readonly image: { readonly reference: string; readonly digest: string };
  readonly initUser: string;
  readonly taskUser: string;
  readonly stateDirectory: string;
  readonly commandTimeoutMs: number;
  readonly stopGraceSeconds: number;
  readonly proofValidityMs: number;
  readonly maxOutputBytes: number;
  readonly now: () => Date;
  readonly readArguments: (argumentsRef: string) => Promise<{ readonly argv: readonly string[] }>;
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

interface Container {
  readonly Id: string;
  readonly Name: string;
  readonly Image: string;
  readonly Config: {
    readonly User: string;
    readonly Labels: Record<string, string> | null;
    readonly Entrypoint: readonly string[] | null;
    readonly Cmd: readonly string[] | null;
  };
  readonly HostConfig: Record<string, unknown> & {
    readonly RestartPolicy?: { readonly Name?: string };
    readonly LogConfig?: { readonly Type?: string };
  };
  readonly State: {
    readonly Status: string;
    readonly Running: boolean;
    readonly Paused: boolean;
    readonly Restarting: boolean;
    readonly StartedAt: string;
  };
  readonly RestartCount: number;
  readonly Mounts: readonly unknown[] | null;
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
interface DestroyedRecord {
  readonly locator: ExecutionEnvironmentLocator;
  readonly evidence: { readonly ref: string; readonly digest: string };
}

export class ContainerExecutionBackend {
  private readonly options: ContainerExecutionBackendOptions;

  constructor(options: ContainerExecutionBackendOptions) {
    this.options = options;
  }

  async capabilities(): Promise<ExecutionBackendCapabilities> {
    const daemon = await this.daemon();
    if (
      daemon.cgroupVersion !== "2" ||
      !daemon.securityOptions.some((option) => option.startsWith("name=seccomp"))
    )
      throw new ContainerBackendError("CONTAINER_POLICY_UNSUPPORTED");
    await this.pinnedImageId();
    return {
      protocolVersion: EXECUTION_BACKEND_PROTOCOL_V1,
      backendRef: this.options.backendRef,
      runtimeInstanceId: daemon.id,
      guarantees: GUARANTEES,
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
    if (input.runnerDigest !== CONTAINER_RUNNER_DIGEST)
      throw new ContainerBackendError("CONTAINER_RUNNER_UNQUALIFIED");
    if (input.envelope.directories.length > 0 || input.envelope.network.length > 0)
      throw new ContainerBackendError("CONTAINER_POLICY_UNSUPPORTED");
    const deadlineMs = Date.parse(input.deadlineAt);
    if (deadlineMs - this.options.now().getTime() <= 1000)
      throw new ContainerBackendError("CONTAINER_DEADLINE_PASSED");
    const files = await this.files(input.identity);
    if (await readJson(files.stop)) throw new ContainerBackendError("CONTAINER_EXECUTION_CLOSED");
    const daemon = await this.daemon();
    const imageId = await this.pinnedImageId();
    const expected = this.expectedPolicy(input.envelope, imageId, Math.floor(deadlineMs / 1000));
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
        ...this.createArguments(input, name, expected),
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
    return this.locatorFor(daemon.id, container, input.createIntentId);
  }

  async execute(
    input: EnvironmentTarget & {
      readonly stopFence: number;
      readonly invocationId: string;
      readonly argumentsRef: string;
      readonly deadlineAt: string;
    },
  ): Promise<{ readonly outputRef: string; readonly observedAt: string }> {
    const files = await this.files(input.identity);
    if (await readJson(files.stop)) throw new ContainerBackendError("CONTAINER_EXECUTION_CLOSED");
    const remainingMs = Date.parse(input.deadlineAt) - this.options.now().getTime();
    if (remainingMs <= 0) throw new ContainerBackendError("CONTAINER_DEADLINE_PASSED");
    const observation = await this.observe(input);
    if (observation.kind !== "found") throw refusal(observation);
    const { container } = observation;
    if (!container.State.Running || container.State.Paused)
      throw new ContainerBackendError("CONTAINER_NOT_RUNNING");
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
    let result: Awaited<ReturnType<DockerCommand>>;
    try {
      result = await this.options.docker(
        [
          "container",
          "exec",
          "--user",
          this.options.taskUser,
          "--workdir",
          TASK_WORKDIR,
          ...TASK_ENVIRONMENT.flatMap((variable) => ["--env", variable]),
          container.Id,
          ...argv,
        ],
        { timeoutMs: remainingMs, maxOutputBytes: this.options.maxOutputBytes },
      );
    } catch (cause) {
      throw new ContainerBackendError(
        cause instanceof DockerCommandTimeout
          ? "CONTAINER_COMMAND_TIMEOUT"
          : "CONTAINER_RUNTIME_UNAVAILABLE",
        { cause },
      );
    }
    await writeOnce(outputFile, {
      invocationId: input.invocationId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    });
    return {
      outputRef: `container-output:${files.key}:${invocationKey}`,
      observedAt: this.now(),
    };
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
    if (container.State.Running) return { state: "running", locator, observedAt };
    return {
      state: isStopped(container) ? "stopped" : "unknown",
      locator,
      observedAt,
    };
  }

  async stop(
    input: EnvironmentTarget & { readonly stopIntentId: string; readonly stopFence: number },
  ): Promise<{ readonly accepted: true }> {
    const files = await this.files(input.identity);
    await writeOnce(files.stop, { stopIntentId: input.stopIntentId, stopFence: input.stopFence });
    const observation = await this.observe(input);
    if (observation.kind === "missing") return { accepted: true };
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
    return { accepted: true };
  }

  async verifyStopped(
    input: EnvironmentTarget & { readonly stopIntentId: string; readonly stopFence: number },
  ): Promise<ExecutionEnvironmentStopProof> {
    const files = await this.files(input.identity);
    const stop = await readJson<StopRecord>(files.stop);
    if (stop?.stopIntentId !== input.stopIntentId)
      throw new ContainerBackendError("CONTAINER_STOP_NOT_REQUESTED");
    const observation = await this.observe(input);
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
      const destroyed = await readJson<DestroyedRecord>(files.destroyed);
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
        stop,
        checkedAt: proof.checkedAt,
      });
      return { basis: "never_created", ...proof, evidence: [evidence] };
    }
    if (observation.kind !== "found") throw refusal(observation);
    if (!isStopped(observation.container)) throw new ContainerBackendError("CONTAINER_NOT_STOPPED");
    const evidence = await this.saveEvidence(files, {
      container: observation.container,
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

  async destroy(input: EnvironmentTarget): Promise<void> {
    const files = await this.files(input.identity);
    const stop = await readJson<StopRecord>(files.stop);
    if (!stop) throw new ContainerBackendError("CONTAINER_NOT_STOPPED");
    const observation = await this.observe(input);
    if (observation.kind === "missing") {
      if (await readJson(files.destroyed)) return;
      throw new ContainerBackendError("CONTAINER_STOP_UNVERIFIED");
    }
    if (observation.kind !== "found") throw refusal(observation);
    if (!isStopped(observation.container)) throw new ContainerBackendError("CONTAINER_NOT_STOPPED");
    const evidence = await this.saveEvidence(files, {
      container: observation.container,
      daemonId: observation.daemonId,
      stop,
      destroyed: true,
      checkedAt: this.now(),
    });
    await writeOnce(files.destroyed, { locator: observation.locator, evidence });
    await this.remove(observation.container.Id);
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
  ) {
    const labels = {
      ...this.identityLabels(input.identity, input.createIntentId),
      [`${LABEL}policy-digest`]: input.policyDigest,
      [`${LABEL}image-digest`]: input.imageDigest,
      [`${LABEL}runner-digest`]: input.runnerDigest,
      [`${LABEL}deadline`]: input.deadlineAt,
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
      "none",
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
      `${this.options.image.reference}@sha256:${this.options.image.digest}`,
      ...expected.cmd,
    ];
  }

  private expectedPolicy(envelope: ExecutionEnvelope, imageId: string, deadlineEpoch: number) {
    const { resources } = envelope;
    return {
      user: this.options.initUser,
      image: imageId,
      entrypoint: ["/bin/sh"],
      cmd: ["-c", INIT_SCRIPT, INIT_NAME, String(deadlineEpoch)],
      readonlyRootfs: true,
      capDrop: ["ALL"],
      capAdd: null,
      securityOpt: ["no-new-privileges=true"],
      networkMode: "none",
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
      mounts: [],
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

  private async pinnedImageId() {
    const { reference, digest } = this.options.image;
    const result = await this.command([
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      `${reference}@sha256:${digest}`,
    ]);
    const image = result.exitCode === 0 ? parseJson(result.stdout) : null;
    const repoDigests = image?.["RepoDigests"];
    if (
      !image ||
      typeof image["Id"] !== "string" ||
      !Array.isArray(repoDigests) ||
      !repoDigests.some((item) => String(item).endsWith(`@sha256:${digest}`))
    )
      throw new ContainerBackendError("CONTAINER_IMAGE_UNQUALIFIED");
    return image["Id"];
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
      evidence: path.join(directory, "evidence"),
      invocations: path.join(directory, "invocations"),
    };
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

function isStopped(container: Container) {
  return (
    !container.State.Running &&
    !container.State.Paused &&
    !container.State.Restarting &&
    STOPPED_STATUSES.has(container.State.Status) &&
    container.HostConfig.RestartPolicy?.Name === "no" &&
    container.HostConfig["NetworkMode"] === "none"
  );
}

function effectivePolicy(container: Container) {
  const host = container.HostConfig;
  return {
    user: container.Config.User,
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
    mounts: container.Mounts ?? [],
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

async function writeOnce<T extends object>(file: string, value: T): Promise<T> {
  try {
    await writeFile(file, `${JSON.stringify(value)}\n`, { flag: "wx" });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readJson<T>(file);
    if (!existing) throw error;
    return existing;
  }
}

async function readJson<T = Record<string, unknown>>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
