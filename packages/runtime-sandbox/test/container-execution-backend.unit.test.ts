import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EXECUTION_ENVELOPE_V1,
  EXECUTION_ENVIRONMENT_V1,
  executionBackendCapabilitiesSchema,
  executionEnvironmentLocatorSchema,
  executionEnvironmentStopProofSchema,
} from "@himawari-agent/execution-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTAINER_RUNNER_DIGEST,
  ContainerExecutionBackend,
} from "../src/execution-backend/container-execution-backend.ts";
import {
  type DockerCommand,
  DockerCommandTimeout,
  dockerCli,
} from "../src/execution-backend/docker-command.ts";

const IMAGE_DIGEST = "bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const IMAGE_REFERENCE = "docker.io/library/busybox";
const identity = {
  schemaVersion: EXECUTION_ENVIRONMENT_V1,
  ownerId: "owner-1",
  agentId: "agent-1",
  runId: "run-1",
  hostId: "host-1",
  executionJobId: "job-1",
  environmentId: "environment-1",
  environmentGeneration: 1,
  role: "primary",
} as const;
const envelope = {
  schemaVersion: EXECUTION_ENVELOPE_V1,
  directories: [],
  network: [],
  resources: {
    cpuMillicores: 500,
    memoryBytes: 134217728,
    maxProcesses: 64,
    privateStorageBytes: 16777216,
  },
};
const source = {
  authorizationRef: "authorization-1",
  decidedBy: "user",
  delegationListRef: null,
  expiresAt: "2026-09-25T12:00:00.000Z",
} as const;

interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Config: {
    User: string;
    Labels: Record<string, string>;
    Entrypoint: string[];
    Cmd: string[];
    Image: string;
  };
  HostConfig: Record<string, unknown>;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    StartedAt: string;
    FinishedAt: string;
  };
  RestartCount: number;
  Mounts: unknown[];
}

const ZERO_TIME = "0001-01-01T00:00:00Z";

class FakeDocker {
  daemonId = "daemon-1";
  reachable = true;
  cgroupVersion = "2";
  repoDigests = [`busybox@sha256:${IMAGE_DIGEST}`];
  readonly containers = new Map<string, FakeContainer>();
  readonly calls: string[][] = [];
  readonly execs: string[][] = [];
  tamper: (container: FakeContainer) => void = () => {};
  afterCreate: () => Promise<void> = async () => {};
  execResult: { exitCode: number; stdout: string; stderr: string; truncated: boolean } = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
  };
  execTimeout = false;
  private sequence = 0;
  private tick = 0;

  readonly run: DockerCommand = async (args) => {
    this.calls.push([...args]);
    if (!this.reachable)
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
        truncated: false,
      };
    const [group, command] = args;
    if (group === "system" && command === "info")
      return this.ok(
        JSON.stringify({
          ID: this.daemonId,
          CgroupVersion: this.cgroupVersion,
          SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
        }),
      );
    if (group === "image" && command === "inspect")
      return this.ok(JSON.stringify({ Id: "sha256:image-id", RepoDigests: this.repoDigests }));
    if (group !== "container") throw new Error(`unexpected docker command ${args.join(" ")}`);
    const target = args.at(-1) ?? "";
    if (command === "inspect") {
      const container = this.find(target);
      return container ? this.ok(JSON.stringify(container)) : this.missing(target);
    }
    if (command === "create") return this.create(args);
    if (command === "exec") return this.exec(args);
    const container = this.find(target);
    if (!container) return this.missing(target);
    if (command === "start") this.start(container);
    else if (command === "stop") {
      if (container.State.Running && !container.State.Paused) this.exit(container);
    } else if (command === "rm") {
      if (container.State.Running)
        return { exitCode: 1, stdout: "", stderr: "running", truncated: false };
      this.containers.delete(container.Id);
    } else throw new Error(`unexpected container command ${command}`);
    return this.ok(container.Id);
  };

  find(nameOrId: string) {
    return [...this.containers.values()].find(
      (container) => container.Id === nameOrId || container.Name === `/${nameOrId}`,
    );
  }
  only() {
    const [container] = [...this.containers.values()];
    if (!container) throw new Error("no container");
    return container;
  }
  start(container: FakeContainer) {
    container.State = {
      ...container.State,
      Status: "running",
      Running: true,
      Paused: false,
      StartedAt: `2026-09-25T10:00:0${++this.tick}.000000000Z`,
      FinishedAt: container.State.FinishedAt,
    };
  }
  exit(container: FakeContainer) {
    container.State = {
      ...container.State,
      Status: "exited",
      Running: false,
      Paused: false,
      FinishedAt: `2026-09-25T10:00:0${++this.tick}.500000000Z`,
    };
  }
  pause(container: FakeContainer) {
    container.State = { ...container.State, Status: "paused", Paused: true };
  }

  private async create(args: readonly string[]) {
    const values = new Map<string, string[]>();
    let readOnly = false;
    let index = 2;
    while (index < args.length && (args[index] ?? "").startsWith("--")) {
      const flag = args[index] ?? "";
      if (flag === "--read-only") {
        readOnly = true;
        index += 1;
        continue;
      }
      values.set(flag, [...(values.get(flag) ?? []), args[index + 1] ?? ""]);
      index += 2;
    }
    const one = (flag: string) => values.get(flag)?.[0];
    const name = one("--name") ?? "";
    if (this.find(name))
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Conflict. The container name is already in use",
        truncated: false,
      };
    const container: FakeContainer = {
      Id: `container-${++this.sequence}`.padEnd(64, "0"),
      Name: `/${name}`,
      Image: "sha256:image-id",
      Config: {
        User: one("--user") ?? "",
        Labels: Object.fromEntries(
          (values.get("--label") ?? []).map((label) => [
            label.slice(0, label.indexOf("=")),
            label.slice(label.indexOf("=") + 1),
          ]),
        ),
        Entrypoint: [one("--entrypoint") ?? ""],
        Cmd: args.slice(index + 1),
        Image: args[index] ?? "",
      },
      HostConfig: {
        ReadonlyRootfs: readOnly,
        CapDrop: values.get("--cap-drop") ?? null,
        CapAdd: null,
        SecurityOpt: values.get("--security-opt") ?? null,
        NetworkMode: one("--network") ?? "bridge",
        Privileged: false,
        RestartPolicy: { Name: one("--restart") ?? "no", MaximumRetryCount: 0 },
        PidsLimit: Number(one("--pids-limit")),
        Memory: Number(one("--memory")),
        MemorySwap: Number(one("--memory-swap")),
        NanoCpus: Math.round(Number(one("--cpus")) * 1e9),
        Tmpfs: Object.fromEntries(
          (values.get("--tmpfs") ?? []).map((mount) => [
            mount.slice(0, mount.indexOf(":")),
            mount.slice(mount.indexOf(":") + 1),
          ]),
        ),
        Binds: null,
        Devices: [],
        PidMode: "",
        IpcMode: one("--ipc") ?? "shareable",
        UsernsMode: "",
        CgroupnsMode: "private",
        LogConfig: { Type: one("--log-driver") ?? "json-file", Config: {} },
      },
      State: {
        Status: "created",
        Running: false,
        Paused: false,
        Restarting: false,
        StartedAt: ZERO_TIME,
        FinishedAt: ZERO_TIME,
      },
      RestartCount: 0,
      Mounts: [],
    };
    this.tamper(container);
    this.containers.set(container.Id, container);
    await this.afterCreate();
    return this.ok(container.Id);
  }
  private exec(args: readonly string[]) {
    let index = 2;
    while ((args[index] ?? "").startsWith("--")) index += 2;
    const container = this.find(args[index] ?? "");
    if (!container) return this.missing(args[index] ?? "");
    if (!container.State.Running || container.State.Paused)
      return { exitCode: 1, stdout: "", stderr: "container is not running", truncated: false };
    if (this.execTimeout) throw new DockerCommandTimeout();
    this.execs.push([...args]);
    return this.execResult;
  }
  private ok(stdout: string) {
    return { exitCode: 0, stdout, stderr: "", truncated: false };
  }
  private missing(target: string) {
    return {
      exitCode: 1,
      stdout: "[]",
      stderr: `Error response from daemon: No such container: ${target}`,
      truncated: false,
    };
  }
}

let stateDirectory: string;
let docker: FakeDocker;
let now: Date;
const argumentsByRef = new Map<string, { argv: readonly string[] }>();

function backend() {
  return new ContainerExecutionBackend({
    backendRef: "container-docker:host-1",
    docker: docker.run,
    image: { reference: IMAGE_REFERENCE, digest: IMAGE_DIGEST },
    initUser: "65532:65532",
    taskUser: "65534:65534",
    stateDirectory,
    commandTimeoutMs: 10_000,
    stopGraceSeconds: 2,
    proofValidityMs: 60_000,
    maxOutputBytes: 1024,
    now: () => now,
    readArguments: async (ref) => {
      const value = argumentsByRef.get(ref);
      if (!value) throw new Error("unknown arguments");
      return value;
    },
  });
}
function createInput(overrides: Record<string, unknown> = {}) {
  return {
    identity,
    createIntentId: "create-1",
    envelope,
    policyDigest: "b".repeat(64),
    imageDigest: IMAGE_DIGEST,
    runnerDigest: CONTAINER_RUNNER_DIGEST,
    deadlineAt: "2026-09-25T11:00:00.000Z",
    ...overrides,
  };
}
async function started() {
  const subject = backend();
  const locator = await subject.create(createInput());
  return { subject, locator, request: { identity, createIntentId: "create-1", locator } };
}
function stopRequest(locator: unknown, stopIntentId = "stop-1") {
  return {
    identity,
    createIntentId: "create-1",
    locator: locator as ReturnType<typeof executionEnvironmentLocatorSchema.parse> | null,
    stopIntentId,
    stopFence: 1,
  };
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(path.join(os.tmpdir(), "container-backend-"));
  docker = new FakeDocker();
  now = new Date("2026-09-25T10:00:00.000Z");
  argumentsByRef.clear();
});
afterEach(async () => {
  await rm(stateDirectory, { recursive: true, force: true });
});

describe("container execution backend capabilities", () => {
  it("declares lifecycle guarantees without task egress, bound to the daemon and pinned image", async () => {
    const capabilities = executionBackendCapabilitiesSchema.parse(await backend().capabilities());
    expect(capabilities).toMatchObject({
      backendRef: "container-docker:host-1",
      runtimeInstanceId: "daemon-1",
      checkedAt: "2026-09-25T10:00:00.000Z",
    });
    expect([...capabilities.guarantees].sort()).toEqual(
      [
        "immutable-environment-identity.v1",
        "whole-environment-stop.v1",
        "no-automatic-restart.v1",
        "protected-init-wall-clock-deadline.v1",
        "enforced-resource-limits.v1",
      ].sort(),
    );
  });

  it("refuses an unreachable daemon, a missing pinned image and a daemon without cgroup v2", async () => {
    docker.reachable = false;
    await expect(backend().capabilities()).rejects.toMatchObject({
      code: "CONTAINER_RUNTIME_UNAVAILABLE",
    });
    docker.reachable = true;
    docker.repoDigests = [`busybox@sha256:${"c".repeat(64)}`];
    await expect(backend().capabilities()).rejects.toMatchObject({
      code: "CONTAINER_IMAGE_UNQUALIFIED",
    });
    docker.repoDigests = [`busybox@sha256:${IMAGE_DIGEST}`];
    docker.cgroupVersion = "1";
    await expect(backend().capabilities()).rejects.toMatchObject({
      code: "CONTAINER_POLICY_UNSUPPORTED",
    });
  });
});

describe("creating a container environment", () => {
  it("creates one locked-down container per create intent and starts the protected init", async () => {
    const { subject, locator } = await started();
    expect(executionEnvironmentLocatorSchema.parse(locator)).toMatchObject({
      backendRef: "container-docker:host-1",
      runtimeInstanceId: "daemon-1",
      createIntentId: "create-1",
    });
    const container = docker.only();
    expect(container.State.Running).toBe(true);
    expect(locator.runtimeEnvironmentId).toBe(container.Id);
    expect(container.Config.User).toBe("65532:65532");
    expect(container.Config.Cmd.at(-1)).toBe(String(Date.parse("2026-09-25T11:00:00.000Z") / 1000));
    expect(container.Config.Labels).toMatchObject({
      "io.himawari.environment.id": "environment-1",
      "io.himawari.environment.generation": "1",
      "io.himawari.environment.run": "run-1",
      "io.himawari.environment.create-intent": "create-1",
      "io.himawari.environment.image-digest": IMAGE_DIGEST,
      "io.himawari.environment.runner-digest": CONTAINER_RUNNER_DIGEST,
    });
    expect(container.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges=true"],
      NetworkMode: "none",
      RestartPolicy: { Name: "no" },
      PidsLimit: 64,
      Memory: 134217728,
      MemorySwap: 134217728,
      NanoCpus: 500000000,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=16777216,mode=1777" },
      IpcMode: "private",
      LogConfig: { Type: "none" },
    });

    const creates = () => docker.calls.filter((call) => call[1] === "create").length;
    expect(await subject.create(createInput())).toEqual(locator);
    expect(await backend().create(createInput())).toEqual(locator);
    expect(creates()).toBe(1);
    await expect(
      backend().create(createInput({ createIntentId: "create-2" })),
    ).rejects.toMatchObject({ code: "CONTAINER_IDENTITY_CONFLICT" });
    expect(docker.containers.size).toBe(1);
  });

  it("refuses inputs it cannot enforce before touching the runtime", async () => {
    const refusals: [Record<string, unknown>, string][] = [
      [
        {
          envelope: {
            ...envelope,
            directories: [
              {
                hostId: "host-1",
                grantRef: "grant-1",
                canonicalRootId: "root-1",
                access: "read",
                source,
              },
            ],
          },
        },
        "CONTAINER_POLICY_UNSUPPORTED",
      ],
      [
        { envelope: { ...envelope, network: [{ target: "registry.npmjs.org:443", source }] } },
        "CONTAINER_POLICY_UNSUPPORTED",
      ],
      [{ imageDigest: "c".repeat(64) }, "CONTAINER_IMAGE_UNQUALIFIED"],
      [{ runnerDigest: "c".repeat(64) }, "CONTAINER_RUNNER_UNQUALIFIED"],
      [{ deadlineAt: "2026-09-25T10:00:00.000Z" }, "CONTAINER_DEADLINE_PASSED"],
    ];
    for (const [overrides, code] of refusals)
      await expect(backend().create(createInput(overrides))).rejects.toMatchObject({ code });
    expect(docker.calls.filter((call) => call[0] === "container")).toEqual([]);
  });

  it("removes a created container whose effective policy differs and never starts it", async () => {
    docker.tamper = (container) => {
      container.HostConfig["Privileged"] = true;
    };
    await expect(backend().create(createInput())).rejects.toMatchObject({
      code: "CONTAINER_POLICY_MISMATCH",
    });
    expect(docker.containers.size).toBe(0);
    expect(docker.calls.some((call) => call[1] === "start")).toBe(false);
  });

  it("seals the environment when a stop arrives between create and start", async () => {
    const subject = backend();
    docker.afterCreate = async () => {
      docker.afterCreate = async () => {};
      await subject.stop(stopRequest(null));
    };
    await expect(subject.create(createInput())).rejects.toMatchObject({
      code: "CONTAINER_EXECUTION_CLOSED",
    });
    expect(docker.containers.size).toBe(0);
    expect(docker.calls.some((call) => call[1] === "start")).toBe(false);
    const proof = executionEnvironmentStopProofSchema.parse(
      await subject.verifyStopped(stopRequest(null)),
    );
    expect(proof.basis).toBe("never_created");
    await expect(backend().create(createInput())).rejects.toMatchObject({
      code: "CONTAINER_EXECUTION_CLOSED",
    });
    expect(docker.calls.filter((call) => call[1] === "create")).toHaveLength(1);
  });
});

describe("executing in a container environment", () => {
  it("runs as the task user and keeps the untrusted output behind a reference", async () => {
    const { subject, request } = await started();
    argumentsByRef.set("arguments-1", { argv: ["sh", "-c", "echo hello"] });
    docker.execResult = { exitCode: 3, stdout: "hello\n", stderr: "warn\n", truncated: true };
    const result = await subject.execute({
      ...request,
      stopFence: 0,
      invocationId: "invocation-1",
      argumentsRef: "arguments-1",
      deadlineAt: "2026-09-25T10:30:00.000Z",
    });
    expect(result.observedAt).toBe("2026-09-25T10:00:00.000Z");
    const exec = docker.execs[0] ?? [];
    expect(exec.slice(exec.length - 3)).toEqual(["sh", "-c", "echo hello"]);
    expect(exec).toContain("65534:65534");
    expect(exec).toContain("HOME=/tmp");
    expect(await subject.readOutput(result.outputRef)).toEqual({
      invocationId: "invocation-1",
      exitCode: 3,
      stdout: "hello\n",
      stderr: "warn\n",
      truncated: true,
    });
    await expect(subject.readOutput("container-output:elsewhere/../../x")).rejects.toMatchObject({
      code: "CONTAINER_OUTPUT_UNKNOWN",
    });
  });

  it("refuses execution after a stop, on another runtime and once the container restarted", async () => {
    const { subject, request, locator } = await started();
    argumentsByRef.set("arguments-1", { argv: ["true"] });
    const call = (overrides: Record<string, unknown> = {}) =>
      subject.execute({
        ...request,
        stopFence: 0,
        invocationId: "invocation-1",
        argumentsRef: "arguments-1",
        deadlineAt: "2026-09-25T10:30:00.000Z",
        ...overrides,
      });
    await expect(
      call({ locator: { ...locator, runtimeInstanceId: "daemon-2" } }),
    ).rejects.toMatchObject({ code: "CONTAINER_RUNTIME_CHANGED" });
    docker.daemonId = "daemon-2";
    await expect(call()).rejects.toMatchObject({ code: "CONTAINER_RUNTIME_CHANGED" });
    docker.daemonId = "daemon-1";
    const container = docker.only();
    docker.exit(container);
    docker.start(container);
    await expect(call()).rejects.toMatchObject({ code: "CONTAINER_RESTARTED" });
    await subject.stop(stopRequest(locator));
    await expect(call()).rejects.toMatchObject({ code: "CONTAINER_EXECUTION_CLOSED" });
    await expect(call({ deadlineAt: "2026-09-25T10:00:00.000Z" })).rejects.toMatchObject({
      code: "CONTAINER_EXECUTION_CLOSED",
    });
    expect(docker.execs).toEqual([]);
  });

  it("reports a timed-out execution as a failure the caller must stop for", async () => {
    const { subject, request } = await started();
    argumentsByRef.set("arguments-1", { argv: ["sleep", "100"] });
    docker.execTimeout = true;
    await expect(
      subject.execute({
        ...request,
        stopFence: 0,
        invocationId: "invocation-1",
        argumentsRef: "arguments-1",
        deadlineAt: "2026-09-25T10:30:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONTAINER_COMMAND_TIMEOUT" });
    await expect(
      subject.execute({
        ...request,
        stopFence: 0,
        invocationId: "invocation-2",
        argumentsRef: "arguments-1",
        deadlineAt: "2026-09-25T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONTAINER_DEADLINE_PASSED" });
  });
});

describe("observing and stopping a container environment", () => {
  it("distinguishes running, paused, stopped, missing and untrusted observations", async () => {
    const { subject, request, locator } = await started();
    const state = async (overrides: Record<string, unknown> = {}) =>
      (await subject.inspect({ ...request, ...overrides })).state;
    expect(await state()).toBe("running");
    expect(await state({ locator: null })).toBe("running");
    expect((await subject.inspect({ ...request, locator: null })).locator).toEqual(locator);
    const container = docker.only();
    docker.pause(container);
    expect(await state()).toBe("running");
    container.State = { ...container.State, Status: "running", Paused: false };
    expect(await state({ locator: { ...locator, runtimeInstanceId: "daemon-2" } })).toBe("unknown");
    expect(await state({ locator: { ...locator, runtimeEnvironmentId: "f".repeat(64) } })).toBe(
      "unknown",
    );
    expect(await state({ createIntentId: "create-2" })).toBe("unknown");
    docker.reachable = false;
    expect(await state()).toBe("unknown");
    docker.reachable = true;
    docker.daemonId = "daemon-2";
    expect(await state()).toBe("unknown");
    docker.daemonId = "daemon-1";
    docker.exit(container);
    expect(await state()).toBe("stopped");
    docker.start(container);
    expect(await state()).toBe("unknown");
    docker.containers.clear();
    expect(await state()).toBe("not_found");
  });

  it("proves a stop only for a stopped, unrestarted container on the same runtime", async () => {
    const { subject, locator } = await started();
    await expect(subject.verifyStopped(stopRequest(locator))).rejects.toMatchObject({
      code: "CONTAINER_STOP_NOT_REQUESTED",
    });
    const container = docker.only();
    docker.pause(container);
    await subject.stop(stopRequest(locator));
    expect(container.State.Paused).toBe(true);
    await expect(subject.verifyStopped(stopRequest(locator))).rejects.toMatchObject({
      code: "CONTAINER_NOT_STOPPED",
    });
    container.State = { ...container.State, Status: "running", Paused: false };
    await subject.stop(stopRequest(locator));
    await expect(subject.verifyStopped(stopRequest(locator, "stop-2"))).rejects.toMatchObject({
      code: "CONTAINER_STOP_NOT_REQUESTED",
    });
    docker.reachable = false;
    await expect(subject.verifyStopped(stopRequest(locator))).rejects.toMatchObject({
      code: "CONTAINER_RUNTIME_UNAVAILABLE",
    });
    docker.reachable = true;
    const proof = executionEnvironmentStopProofSchema.parse(
      await subject.verifyStopped(stopRequest(locator)),
    );
    expect(proof).toMatchObject({
      basis: "verified_stopped",
      identity,
      createIntentId: "create-1",
      stopIntentId: "stop-1",
      stopFence: 1,
      verifierRef: "container-docker:host-1",
      checkedAt: "2026-09-25T10:00:00.000Z",
      validUntil: "2026-09-25T10:01:00.000Z",
      locator,
    });
    const [evidence] = proof.evidence;
    const saved = await subject.readEvidence(evidence?.ref ?? "");
    expect(createHash("sha256").update(saved).digest("hex")).toBe(evidence?.digest);
    expect(JSON.parse(saved)).toMatchObject({ container: { Id: container.Id } });

    docker.start(container);
    docker.exit(container);
    await expect(subject.verifyStopped(stopRequest(locator))).rejects.toMatchObject({
      code: "CONTAINER_RESTARTED",
    });
  });

  it("does not treat a container removed outside the backend as stopped", async () => {
    const { subject, locator } = await started();
    await subject.stop(stopRequest(locator));
    docker.containers.clear();
    await expect(subject.verifyStopped(stopRequest(locator))).rejects.toMatchObject({
      code: "CONTAINER_STOP_UNVERIFIED",
    });
  });

  it("destroys only a stopped container and keeps proving the stop from the saved record", async () => {
    const { subject, request, locator } = await started();
    await expect(subject.destroy(request)).rejects.toMatchObject({
      code: "CONTAINER_NOT_STOPPED",
    });
    await subject.stop(stopRequest(locator));
    await subject.destroy(request);
    await subject.destroy(request);
    expect(docker.containers.size).toBe(0);
    const proof = executionEnvironmentStopProofSchema.parse(
      await subject.verifyStopped(stopRequest(locator)),
    );
    expect(proof.basis).toBe("verified_stopped");
    const saved = await subject.readEvidence(proof.evidence[0]?.ref ?? "");
    expect(JSON.parse(saved)).toMatchObject({ destroyed: true });
  });
});

describe("docker command runner", () => {
  const script = (body: string) => ["-e", body, "--"];

  it("returns the exit code and caps each output stream", async () => {
    const run = dockerCli(
      process.execPath,
      script("process.stdout.write('x'.repeat(50)); process.stderr.write('e'); process.exit(4)"),
    );
    expect(await run(["ignored"], { timeoutMs: 5000, maxOutputBytes: 10 })).toEqual({
      exitCode: 4,
      stdout: "x".repeat(10),
      stderr: "e",
      truncated: true,
    });
  });

  it("kills the command at its timeout", async () => {
    const run = dockerCli(process.execPath, script("setTimeout(() => {}, 60000)"));
    await expect(run([], { timeoutMs: 100, maxOutputBytes: 10 })).rejects.toBeInstanceOf(
      DockerCommandTimeout,
    );
  });

  it("does not let the caller's environment redirect the daemon", async () => {
    const previous = process.env["DOCKER_HOST"];
    process.env["DOCKER_HOST"] = "tcp://attacker:2375";
    try {
      const run = dockerCli(
        process.execPath,
        script("process.stdout.write(String(process.env.DOCKER_HOST))"),
      );
      expect((await run([], { timeoutMs: 5000, maxOutputBytes: 100 })).stdout).toBe("undefined");
    } finally {
      if (previous === undefined) delete process.env["DOCKER_HOST"];
      else process.env["DOCKER_HOST"] = previous;
    }
  });
});
