import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EXECUTION_ENVELOPE_V1,
  EXECUTION_ENVIRONMENT_V1,
  executionBackendCapabilitiesSchema,
  executionEnvironmentLocatorSchema,
  executionEnvironmentStopProofSchema,
} from "@himawari-agent/execution-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    } else if (command === "kill") {
      if (!container.State.Running)
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error response from daemon: cannot kill container: ${target}: container ${target} is not running`,
          truncated: false,
        };
      this.exit(container);
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
    const mounts = (values.get("--mount") ?? []).map((spec) => {
      const fields = new Map(
        spec.split(",").map((field) => {
          const separator = field.indexOf("=");
          return separator < 0
            ? [field, "true"]
            : [field.slice(0, separator), field.slice(separator + 1)];
        }),
      );
      return {
        type: fields.get("type") ?? "",
        source: fields.get("source") ?? "",
        target: fields.get("target") ?? "",
        readOnly: fields.get("readonly") === "true",
      };
    });
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
        ...(mounts.length > 0
          ? {
              Mounts: mounts.map((mount) => ({
                Type: mount.type,
                Source: mount.source,
                Target: mount.target,
                ...(mount.readOnly ? { ReadOnly: true } : {}),
              })),
            }
          : {}),
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
      Mounts: mounts.map((mount) => ({
        Type: mount.type,
        Source: mount.source,
        Destination: mount.target,
        Mode: "",
        RW: !mount.readOnly,
        Propagation: "rprivate",
      })),
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
let hostRoot: string;
let docker: FakeDocker;
let now: Date;
let freeBytes: (directory: string) => Promise<number>;
const argumentsByRef = new Map<string, { argv: readonly string[] }>();
const roots = new Map<
  string,
  { readonly canonicalPath: string; readonly device: string; readonly inode: string }
>();

function backend(
  overrides: Partial<ConstructorParameters<typeof ContainerExecutionBackend>[0]> = {},
) {
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
    resolveDirectory: async (directory) => roots.get(directory.canonicalRootId) ?? null,
    hostDirectories: { maxScannedEntries: 200, maxProtectedEntries: 8 },
    diskGuard: {
      minFreeBytes: 1000,
      maxGrowthBytes: 500,
      intervalMs: 100,
      freeBytes: (directory) => freeBytes(directory),
    },
    ...overrides,
  });
}
async function hostDirectory(name: string, files: Record<string, string> = {}) {
  const root = path.join(hostRoot, name);
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const info = await lstat(root);
  roots.set(name, { canonicalPath: root, device: String(info.dev), inode: String(info.ino) });
  return root;
}
function directory(name: string, access: "read" | "write") {
  return { hostId: "host-1", grantRef: `grant-${name}`, canonicalRootId: name, access, source };
}
function withDirectories(...directories: ReturnType<typeof directory>[]) {
  return { envelope: { ...envelope, directories } };
}
async function caseInsensitiveHost() {
  await writeFile(path.join(hostRoot, "case-probe"), "");
  return lstat(path.join(hostRoot, "CASE-PROBE")).then(
    () => true,
    () => false,
  );
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
  hostRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "container-host-")));
  docker = new FakeDocker();
  now = new Date("2026-09-25T10:00:00.000Z");
  freeBytes = async () => 10_000;
  argumentsByRef.clear();
  roots.clear();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(stateDirectory, { recursive: true, force: true });
  await rm(hostRoot, { recursive: true, force: true });
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
        "CONTAINER_DIRECTORY_UNRESOLVED",
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

describe("mounting approved host directories", () => {
  const execute = (subject: ContainerExecutionBackend, locator: unknown, invocationId: string) =>
    subject.execute({
      identity,
      createIntentId: "create-1",
      locator: locator as ReturnType<typeof executionEnvironmentLocatorSchema.parse>,
      stopFence: 0,
      invocationId,
      argumentsRef: "arguments-1",
      deadlineAt: "2026-09-25T10:30:00.000Z",
    });

  it("mounts each approved directory at a fixed target and runs the task as its owner", async () => {
    const repo = await hostDirectory("repo", { "src/index.js": "x" });
    const docs = await hostDirectory("docs", { "readme.md": "y" });
    const subject = backend();
    const locator = await subject.create(
      createInput(withDirectories(directory("repo", "write"), directory("docs", "read"))),
    );
    const container = docker.only();
    expect(container.HostConfig["Mounts"]).toEqual([
      { Type: "bind", Source: docs, Target: "/workspaces/docs", ReadOnly: true },
      { Type: "bind", Source: repo, Target: "/workspaces/repo" },
    ]);
    const owner = await lstat(repo);
    const taskUser = `${owner.uid}:${owner.gid}`;
    expect(container.Config.Labels["io.himawari.environment.task-user"]).toBe(taskUser);
    argumentsByRef.set("arguments-1", { argv: ["true"] });
    await execute(subject, locator, "invocation-1");
    expect(docker.execs[0]).toContain(taskUser);
    expect(docker.execs[0]).not.toContain("65534:65534");
  });

  it("removes a created container whose mounts differ from the approved directories", async () => {
    await hostDirectory("repo", { "src/index.js": "x" });
    docker.tamper = (container) => {
      container.Mounts = container.Mounts.map((mount) => ({
        ...(mount as Record<string, unknown>),
        RW: true,
      }));
    };
    await expect(
      backend().create(createInput(withDirectories(directory("repo", "read")))),
    ).rejects.toMatchObject({ code: "CONTAINER_POLICY_MISMATCH" });
    expect(docker.containers.size).toBe(0);
  });

  it("kills the environment when an approved directory is replaced before the runtime mounts it", async () => {
    const repo = await hostDirectory("repo");
    docker.afterCreate = async () => {
      await rename(repo, `${repo}-old`);
      await mkdir(repo);
    };
    await expect(
      backend().create(createInput(withDirectories(directory("repo", "write")))),
    ).rejects.toMatchObject({ code: "CONTAINER_DIRECTORY_CHANGED" });
    expect(docker.only().State.Running).toBe(false);
  });

  it("refuses directories it cannot resolve or verify on the host before touching the runtime", async () => {
    const real = await hostDirectory("real");
    await symlink(real, path.join(hostRoot, "alias"));
    const realInfo = await lstat(real);
    roots.set("alias", {
      canonicalPath: path.join(hostRoot, "alias"),
      device: String(realInfo.dev),
      inode: String(realInfo.ino),
    });
    const moved = await hostDirectory("moved");
    roots.set("moved", { canonicalPath: moved, device: String(realInfo.dev), inode: "1" });
    await writeFile(path.join(hostRoot, "plain-file"), "");
    const fileInfo = await lstat(path.join(hostRoot, "plain-file"));
    roots.set("plain-file", {
      canonicalPath: path.join(hostRoot, "plain-file"),
      device: String(fileInfo.dev),
      inode: String(fileInfo.ino),
    });
    await hostDirectory("outer");
    const inner = await hostDirectory("outer/inner");
    const innerInfo = await lstat(inner);
    roots.set("inner", {
      canonicalPath: inner,
      device: String(innerInfo.dev),
      inode: String(innerInfo.ino),
    });
    const comma = await hostDirectory("comma,name");
    const commaInfo = await lstat(comma);
    roots.set("comma", {
      canonicalPath: comma,
      device: String(commaInfo.dev),
      inode: String(commaInfo.ino),
    });
    const refusals: [ReturnType<typeof directory>[], string][] = [
      [[directory("unknown", "read")], "CONTAINER_DIRECTORY_UNRESOLVED"],
      [[{ ...directory("real", "read"), hostId: "host-2" }], "CONTAINER_DIRECTORY_UNRESOLVED"],
      [[directory("alias", "read")], "CONTAINER_DIRECTORY_CHANGED"],
      [[directory("moved", "read")], "CONTAINER_DIRECTORY_CHANGED"],
      [[directory("plain-file", "read")], "CONTAINER_DIRECTORY_CHANGED"],
      [[directory("outer", "read"), directory("inner", "write")], "CONTAINER_POLICY_UNSUPPORTED"],
      [[directory("comma", "read")], "CONTAINER_POLICY_UNSUPPORTED"],
    ];
    for (const [directories, code] of refusals)
      await expect(
        backend().create(createInput(withDirectories(...directories))),
      ).rejects.toMatchObject({ code });
    expect(docker.calls.filter((call) => call[0] === "container")).toEqual([]);
  });

  it("masks protected entries and special files that exist when the environment is created", async () => {
    const repo = await hostDirectory("repo", {
      ".env": "SECRET",
      ".env.local": "SECRET",
      ".envrc": "not protected",
      "config/server.key": "SECRET",
      "keys/id_ed25519.pub": "SECRET",
      ".docker/config.json": "SECRET",
      ".npmrc": "SECRET",
      ".ssh/known_hosts": "SECRET",
      ".himawari-trash/old": "SECRET",
      "nested/.aws/credentials": "SECRET",
      ".git/HEAD": "ref: refs/heads/main\n",
      "src/app.js": "ok",
    });
    await mkdir(path.join(repo, "run"));
    execFileSync("mkfifo", [path.join(repo, "run", "pipe")]);
    const caseInsensitive = await caseInsensitiveHost();
    const create = backend({
      hostDirectories: { maxScannedEntries: 200, maxProtectedEntries: 16 },
    }).create(createInput(withDirectories(directory("repo", "write"))));
    if (caseInsensitive) {
      await expect(create).rejects.toMatchObject({ code: "CONTAINER_PROTECTED_FILE_UNMASKABLE" });
      expect(docker.calls.filter((call) => call[0] === "container")).toEqual([]);
      return;
    }
    await create;
    const file = await realpath(path.join(stateDirectory, "masks", "file"));
    const folder = await realpath(path.join(stateDirectory, "masks", "directory"));
    const mask = (target: string, source: string) => ({
      Type: "bind",
      Source: source,
      Target: `/workspaces/repo/${target}`,
      ReadOnly: true,
    });
    expect(docker.only().HostConfig["Mounts"]).toEqual([
      { Type: "bind", Source: repo, Target: "/workspaces/repo" },
      mask(".docker/config.json", file),
      mask(".env", file),
      mask(".env.local", file),
      mask(".himawari-trash", folder),
      mask(".npmrc", file),
      mask(".ssh", folder),
      mask("config/server.key", file),
      mask("keys/id_ed25519.pub", file),
      mask("nested/.aws", folder),
      mask("run/pipe", file),
    ]);
    expect((await lstat(file)).mode & 0o777).toBe(0o444);
    expect((await lstat(folder)).mode & 0o777).toBe(0o555);
  });

  it("refuses protected entries that another name could still reach", async () => {
    const hardLinked = await hostDirectory("hard-linked", { "other.txt": "SECRET" });
    await link(path.join(hardLinked, "other.txt"), path.join(hardLinked, ".env"));
    const nested = await hostDirectory("nested-link", { ".ssh/id_rsa": "SECRET" });
    await mkdir(path.join(nested, "notes"));
    await link(path.join(nested, ".ssh", "id_rsa"), path.join(nested, "notes", "copy"));
    const symlinked = await hostDirectory("symlinked", { "app.cfg": "SECRET" });
    await symlink("app.cfg", path.join(symlinked, ".env"));
    await hostDirectory(
      "crowded",
      Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`.env.${index}`, "SECRET"])),
    );
    await hostDirectory(
      "large",
      Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`file-${index}`, ""])),
    );
    const refusals: [string, string][] = [
      ["hard-linked", "CONTAINER_PROTECTED_FILE_UNMASKABLE"],
      ["nested-link", "CONTAINER_PROTECTED_FILE_UNMASKABLE"],
      ["symlinked", "CONTAINER_PROTECTED_FILE_UNMASKABLE"],
      ["crowded", "CONTAINER_PROTECTED_FILE_UNMASKABLE"],
      ["large", "CONTAINER_DIRECTORY_SCAN_LIMIT"],
    ];
    for (const [name, code] of refusals)
      await expect(
        backend().create(createInput(withDirectories(directory(name, "write")))),
      ).rejects.toMatchObject({ code });
    expect(docker.calls.filter((call) => call[0] === "container")).toEqual([]);
  });

  it("requires Git metadata referenced by the directory to stay inside it", async () => {
    const outside = await hostDirectory("outside-gitdir", { HEAD: "ref: refs/heads/main\n" });
    await hostDirectory("worktree-outside", { ".git": `gitdir: ${outside}\n` });
    await hostDirectory("relative-escape", { ".git": "gitdir: ../outside-gitdir\n" });
    await hostDirectory("common-outside", {
      ".git": "gitdir: meta\n",
      "meta/HEAD": "ref: refs/heads/main\n",
      "meta/commondir": "../../outside-gitdir\n",
    });
    const symlinked = await hostDirectory("symlinked-git");
    await symlink(outside, path.join(symlinked, ".git"));
    await hostDirectory("malformed", { ".git": "not a gitdir line\n" });
    for (const name of [
      "worktree-outside",
      "relative-escape",
      "common-outside",
      "symlinked-git",
      "malformed",
    ])
      await expect(
        backend().create(createInput(withDirectories(directory(name, "write")))),
      ).rejects.toMatchObject({ code: "CONTAINER_GIT_METADATA_OUTSIDE" });
    expect(docker.calls.filter((call) => call[0] === "container")).toEqual([]);

    await hostDirectory("inside", {
      ".git": "gitdir: meta/worktrees/main\n",
      "meta/worktrees/main/HEAD": "ref: refs/heads/main\n",
      "meta/worktrees/main/commondir": "../..\n",
      "vendor/lib/.git": "gitdir: ../../meta/modules/lib\n",
      "meta/modules/lib/HEAD": "ref: refs/heads/main\n",
    });
    await backend().create(createInput(withDirectories(directory("inside", "write"))));
    expect(docker.containers.size).toBe(1);
  });
});

describe("protecting the host disk behind writable directories", () => {
  const request = { identity, createIntentId: "create-1" };
  const guarded = (free: () => Promise<number>, intervalMs = 10) =>
    backend({
      diskGuard: { minFreeBytes: 1000, maxGrowthBytes: 500, intervalMs, freeBytes: free },
    });

  it("refuses to create a writable environment when free space is unknown or below the floor", async () => {
    await hostDirectory("repo");
    const writable = createInput(withDirectories(directory("repo", "write")));
    await expect(
      guarded(async () => {
        throw new Error("statfs failed");
      }).create(writable),
    ).rejects.toMatchObject({ code: "CONTAINER_DISK_GUARD_UNAVAILABLE" });
    await expect(guarded(async () => 999).create(writable)).rejects.toMatchObject({
      code: "CONTAINER_DISK_FLOOR",
    });
    expect(docker.calls.filter((call) => call[0] === "container")).toEqual([]);

    let observed = 0;
    await guarded(async () => {
      observed += 1;
      throw new Error("statfs failed");
    }).create(createInput(withDirectories(directory("repo", "read"))));
    expect(observed).toBe(0);
    expect(docker.only().State.Running).toBe(true);
  });

  it.each([
    ["growth", 9_400, { consumedBytes: 600, freeBytes: 9_400 }],
    ["floor", 900, { freeBytes: 900 }],
    ["unavailable", Number.NaN, {}],
  ] as const)(
    "kills the whole environment on a %s observation and refuses later execution",
    async (reason, after, expected) => {
      const repo = await hostDirectory("repo");
      let free = 10_000;
      let observations = 0;
      const subject = guarded(async () => {
        observations += 1;
        if (Number.isNaN(free)) throw new Error("statfs failed");
        return free;
      });
      const locator = await subject.create(
        createInput(withDirectories(directory("repo", "write"))),
      );
      free = 9_600;
      const seen = observations;
      await vi.waitFor(() => expect(observations).toBeGreaterThan(seen + 2));
      expect(docker.only().State.Running).toBe(true);
      expect(await subject.diskGuardBreach({ ...request, locator })).toBeNull();

      free = after;
      await vi.waitFor(async () =>
        expect(await subject.diskGuardBreach({ ...request, locator })).toMatchObject({
          reason,
          directory: repo,
          baselineFreeBytes: 10_000,
          ...expected,
        }),
      );
      expect(docker.only().State.Running).toBe(false);
      expect(docker.calls.filter((call) => call[1] === "kill")).toHaveLength(1);
      const stable = observations;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(observations).toBe(stable);
      argumentsByRef.set("arguments-1", { argv: ["true"] });
      await expect(
        subject.execute({
          ...request,
          locator,
          stopFence: 0,
          invocationId: "invocation-1",
          argumentsRef: "arguments-1",
          deadlineAt: "2026-09-25T10:30:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "CONTAINER_DISK_GUARD_TRIPPED" });
      await subject.stop(stopRequest(locator));
      expect(
        executionEnvironmentStopProofSchema.parse(await subject.verifyStopped(stopRequest(locator)))
          .basis,
      ).toBe("verified_stopped");
    },
  );

  it("stops observing once the environment is stopped", async () => {
    await hostDirectory("repo");
    let observations = 0;
    const subject = guarded(async () => {
      observations += 1;
      return 10_000;
    });
    const locator = await subject.create(createInput(withDirectories(directory("repo", "write"))));
    await vi.waitFor(() => expect(observations).toBeGreaterThan(2));
    await subject.stop(stopRequest(locator));
    const stable = observations;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(observations).toBe(stable);
  });

  it("resumes the guard from the saved baseline in a new backend before executing", async () => {
    await hostDirectory("repo");
    let free = 10_000;
    const first = guarded(async () => free, 60_000);
    const locator = await first.create(createInput(withDirectories(directory("repo", "write"))));
    free = 9_000;
    argumentsByRef.set("arguments-1", { argv: ["true"] });
    const second = guarded(async () => free, 60_000);
    await expect(
      second.execute({
        ...request,
        locator,
        stopFence: 0,
        invocationId: "invocation-1",
        argumentsRef: "arguments-1",
        deadlineAt: "2026-09-25T10:30:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONTAINER_DISK_GUARD_TRIPPED" });
    expect(docker.execs).toEqual([]);
    expect(docker.only().State.Running).toBe(false);
    expect(await second.diskGuardBreach({ ...request, locator })).toMatchObject({
      reason: "growth",
      consumedBytes: 1_000,
    });
    await first.stop(stopRequest(locator));
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
