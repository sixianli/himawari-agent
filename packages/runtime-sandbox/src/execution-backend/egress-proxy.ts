import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ContainerBackendError } from "./container-backend-error.ts";
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
import type { DockerCommandResult } from "./docker-command.ts";

export const EGRESS_PORT = 3128;
export const EGRESS_ALIAS = "himawari-egress";
const OUTBOUND_NETWORK = "bridge";
const INHIBIT_HOST_ADDRESS = "com.docker.network.bridge.inhibit_ipv4";
const RUNTIME_TARGET = "/egress";
const RUNTIME_FILES = ["egress-proxy-main.ts", "network-egress.ts"] as const;
const PROXY_MEMORY_BYTES = 128 * 1024 * 1024;
const PROXY_PROCESSES = 64;
const PROXY_NANO_CPUS = 500_000_000;
const PROXY_TMPFS = "rw,nosuid,nodev,size=16777216,mode=1777";
const READY_SCRIPT = `const s=require("node:net").connect(${EGRESS_PORT},"127.0.0.1");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1000)`;
const LABEL = "io.himawari.environment.";

export interface ContainerEgressOptions {
  readonly image: PinnedImage;
  readonly user: string;
  readonly readyAttempts: number;
  readonly readyIntervalMs: number;
}

export interface EgressRuntime {
  readonly stateDirectory: string;
  readonly stopGraceSeconds: number;
  command(args: readonly string[]): Promise<DockerCommandResult>;
  inspectContainer(nameOrId: string): Promise<Container | null>;
  pinnedImageId(image: PinnedImage): Promise<string>;
  remove(containerId: string): Promise<void>;
  kill(containerId: string): Promise<boolean>;
}

export interface EgressFiles {
  readonly key: string;
  readonly egress: string;
  readonly egressStartIntent: string;
  readonly egressStarted: string;
}

export interface EgressRecord {
  readonly token: string;
  readonly targets: readonly string[];
}

export function egressNames(key: string) {
  return { network: `himawari-net-${key}`, proxy: `himawari-egress-${key}` };
}

export function egressProxyUrl(record: EgressRecord) {
  return `http://job:${record.token}@${EGRESS_ALIAS}:${EGRESS_PORT}`;
}

export class ContainerEgress {
  private readonly options: ContainerEgressOptions;
  private readonly runtime: EgressRuntime;

  constructor(options: ContainerEgressOptions, runtime: EgressRuntime) {
    this.options = options;
    this.runtime = runtime;
  }

  imageId() {
    return this.runtime.pinnedImageId(this.options.image);
  }

  async record(files: EgressFiles, targets: readonly string[]) {
    const record = await writeOnce<EgressRecord>(
      files.egress,
      { token: randomBytes(32).toString("hex"), targets: [...targets].sort() },
      0o600,
    );
    if (canonical(record.targets) !== canonical([...targets].sort()))
      throw new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
    return record;
  }

  async prepare(input: {
    readonly files: EgressFiles;
    readonly record: EgressRecord;
    readonly labels: Record<string, string>;
    readonly deadlineEpoch: number;
    readonly closed: () => Promise<boolean>;
  }) {
    const names = egressNames(input.files.key);
    const runtimeFiles = await this.runtimeFiles();
    const imageId = await this.imageId();
    await this.network(names.network, input.labels);
    const labels = {
      ...input.labels,
      [`${LABEL}part`]: "egress-proxy",
      [`${LABEL}egress-runtime-digest`]: runtimeFiles.digest,
    };
    let proxy = await this.runtime.inspectContainer(names.proxy);
    if (!proxy) {
      const created = await this.runtime.command([
        "container",
        "create",
        ...this.createArguments(names.proxy, labels, runtimeFiles.directory, imageId, input),
      ]);
      if (created.exitCode !== 0)
        throw new ContainerBackendError(
          /Conflict/i.test(created.stderr)
            ? "CONTAINER_IDENTITY_CONFLICT"
            : "CONTAINER_RUNTIME_UNAVAILABLE",
        );
      proxy = await this.inspectOrFail(names.proxy);
    }
    if (!belongs(proxy, names.proxy, input.labels))
      throw new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
    if (!(names.network in (proxy.NetworkSettings?.Networks ?? {}))) {
      const connected = await this.runtime.command([
        "network",
        "connect",
        "--alias",
        EGRESS_ALIAS,
        names.network,
        proxy.Id,
      ]);
      if (connected.exitCode !== 0)
        throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
      proxy = await this.inspectOrFail(proxy.Id);
    }
    const neverStarted = proxy.State.StartedAt === NEVER;
    const expected = this.expectedPolicy(
      imageId,
      labels,
      runtimeFiles.directory,
      names.network,
      input,
    );
    if (canonical(effectivePolicy(proxy, names.network)) !== canonical(expected)) {
      if (neverStarted) await this.runtime.remove(proxy.Id);
      throw new ContainerBackendError("CONTAINER_POLICY_MISMATCH");
    }
    if (neverStarted) {
      if (await input.closed()) {
        await this.runtime.remove(proxy.Id);
        throw new ContainerBackendError("CONTAINER_EXECUTION_CLOSED");
      }
      await writeOnce(input.files.egressStartIntent, { proxyId: proxy.Id });
      const started = await this.runtime.command(["container", "start", proxy.Id]);
      if (started.exitCode !== 0) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
      proxy = await this.inspectOrFail(proxy.Id);
    }
    const started = await writeOnce(input.files.egressStarted, {
      startedAt: proxy.State.StartedAt,
    });
    if (started.startedAt !== proxy.State.StartedAt || proxy.RestartCount > 0)
      throw new ContainerBackendError("CONTAINER_RESTARTED");
    if (!(await this.ready(proxy.Id))) {
      await this.runtime.kill(proxy.Id);
      throw new ContainerBackendError("CONTAINER_EGRESS_UNAVAILABLE");
    }
    return { network: names.network, proxyId: proxy.Id };
  }

  async running(files: EgressFiles) {
    const proxy = await this.runtime.inspectContainer(egressNames(files.key).proxy);
    return proxy !== null && (proxy.State.Running || proxy.State.Paused);
  }

  async stop(files: EgressFiles) {
    const proxy = await this.runtime.inspectContainer(egressNames(files.key).proxy);
    if (!proxy || !(proxy.State.Running || proxy.State.Paused)) return;
    const stopped = await this.runtime.command([
      "container",
      "stop",
      "--time",
      String(this.runtime.stopGraceSeconds),
      proxy.Id,
    ]);
    if (stopped.exitCode !== 0) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
  }

  async kill(files: EgressFiles) {
    const proxy = await this.runtime.inspectContainer(egressNames(files.key).proxy);
    return proxy === null || (await this.runtime.kill(proxy.Id));
  }

  async stoppedProxy(input: {
    readonly files: EgressFiles;
    readonly labels: Record<string, string>;
    readonly destroyed: boolean;
  }): Promise<Container | null> {
    const proxy = await this.runtime.inspectContainer(egressNames(input.files.key).proxy);
    const startIntent = await readJson(input.files.egressStartIntent);
    if (!proxy) {
      if (input.destroyed || !startIntent) return null;
      throw new ContainerBackendError("CONTAINER_STOP_UNVERIFIED");
    }
    if (!belongs(proxy, egressNames(input.files.key).proxy, input.labels))
      throw new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
    if (proxy.State.StartedAt !== NEVER) {
      const started = startIntent
        ? await writeOnce(input.files.egressStarted, { startedAt: proxy.State.StartedAt })
        : null;
      if (!started || started.startedAt !== proxy.State.StartedAt)
        throw new ContainerBackendError("CONTAINER_RESTARTED");
    }
    if (proxy.RestartCount > 0) throw new ContainerBackendError("CONTAINER_RESTARTED");
    if (!hasStopped(proxy)) throw new ContainerBackendError("CONTAINER_NOT_STOPPED");
    return proxy;
  }

  async destroy(files: EgressFiles) {
    const names = egressNames(files.key);
    const proxy = await this.runtime.inspectContainer(names.proxy);
    if (proxy) await this.runtime.remove(proxy.Id);
    const removed = await this.runtime.command(["network", "rm", names.network]);
    if (removed.exitCode !== 0 && !/not found/i.test(removed.stderr))
      throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
  }

  private async network(name: string, labels: Record<string, string>) {
    let network = await this.inspectNetwork(name);
    if (!network) {
      const created = await this.runtime.command([
        "network",
        "create",
        "--internal",
        "--opt",
        `${INHIBIT_HOST_ADDRESS}=true`,
        ...Object.entries({ ...labels, [`${LABEL}part`]: "egress-network" }).flatMap(
          ([key, value]) => ["--label", `${key}=${value}`],
        ),
        name,
      ]);
      if (created.exitCode !== 0) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
      network = await this.inspectNetwork(name);
      if (!network) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    }
    const actualLabels = (network["Labels"] ?? {}) as Record<string, string>;
    if (Object.entries(labels).some(([key, value]) => actualLabels[key] !== value))
      throw new ContainerBackendError("CONTAINER_IDENTITY_CONFLICT");
    const options = (network["Options"] ?? {}) as Record<string, string>;
    if (
      network["Driver"] !== "bridge" ||
      network["Internal"] !== true ||
      network["EnableIPv6"] === true ||
      options[INHIBIT_HOST_ADDRESS] !== "true"
    )
      throw new ContainerBackendError("CONTAINER_POLICY_MISMATCH");
  }

  private async inspectNetwork(name: string) {
    const result = await this.runtime.command([
      "network",
      "inspect",
      "--format",
      "{{json .}}",
      name,
    ]);
    if (result.exitCode !== 0) {
      if (/not found/i.test(result.stderr)) return null;
      throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    }
    const network = parseJson(result.stdout);
    if (!network || network["Name"] !== name)
      throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    return network;
  }

  private async inspectOrFail(nameOrId: string) {
    const proxy = await this.runtime.inspectContainer(nameOrId);
    if (!proxy) throw new ContainerBackendError("CONTAINER_RUNTIME_UNAVAILABLE");
    return proxy;
  }

  private async ready(proxyId: string) {
    for (let attempt = 0; attempt < this.options.readyAttempts; attempt++) {
      const probe = await this.runtime.command([
        "container",
        "exec",
        "--user",
        this.options.user,
        proxyId,
        "node",
        "-e",
        READY_SCRIPT,
      ]);
      if (probe.exitCode === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, this.options.readyIntervalMs));
    }
    return false;
  }

  private async runtimeFiles() {
    const directory = path.join(this.runtime.stateDirectory, "egress-runtime");
    await mkdir(directory, { recursive: true });
    const digests: Record<string, string> = {};
    for (const name of RUNTIME_FILES) {
      const content = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
      digests[name] = sha256(content);
      const target = path.join(directory, name);
      if ((await readFile(target, "utf8").catch(() => null)) !== content) {
        await rm(`${target}.tmp`, { force: true });
        await writeFile(`${target}.tmp`, content, { mode: 0o444 });
        await rename(`${target}.tmp`, target);
      }
      await chmod(target, 0o444);
    }
    return { directory: await realpath(directory), digest: sha256(canonical(digests)) };
  }

  private createArguments(
    name: string,
    labels: Record<string, string>,
    runtimeDirectory: string,
    imageId: string,
    input: { readonly record: EgressRecord; readonly deadlineEpoch: number },
  ) {
    return [
      "--name",
      name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--user",
      this.options.user,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--network",
      OUTBOUND_NETWORK,
      "--restart",
      "no",
      "--pull",
      "never",
      "--pids-limit",
      String(PROXY_PROCESSES),
      "--memory",
      String(PROXY_MEMORY_BYTES),
      "--memory-swap",
      String(PROXY_MEMORY_BYTES),
      "--cpus",
      String(PROXY_NANO_CPUS / 1e9),
      "--ipc",
      "private",
      "--tmpfs",
      `/tmp:${PROXY_TMPFS}`,
      ...mountArguments([{ source: runtimeDirectory, target: RUNTIME_TARGET, readOnly: true }]),
      "--stop-timeout",
      String(this.runtime.stopGraceSeconds),
      "--log-driver",
      "none",
      "--hostname",
      EGRESS_ALIAS,
      "--env",
      `HIMAWARI_EGRESS_TOKEN=${input.record.token}`,
      "--env",
      `HIMAWARI_EGRESS_TARGETS=${input.record.targets.join(",")}`,
      "--entrypoint",
      "node",
      imageId,
      ...proxyCommand(input.deadlineEpoch),
    ];
  }

  private expectedPolicy(
    imageId: string,
    labels: Record<string, string>,
    runtimeDirectory: string,
    network: string,
    input: { readonly record: EgressRecord; readonly deadlineEpoch: number },
  ) {
    return {
      user: this.options.user,
      image: imageId,
      entrypoint: ["node"],
      cmd: proxyCommand(input.deadlineEpoch),
      readonlyRootfs: true,
      capDrop: ["ALL"],
      capAdd: null,
      securityOpt: ["no-new-privileges=true"],
      networkMode: OUTBOUND_NETWORK,
      privileged: false,
      restartPolicy: "no",
      pidsLimit: PROXY_PROCESSES,
      memory: PROXY_MEMORY_BYTES,
      memorySwap: PROXY_MEMORY_BYTES,
      nanoCpus: PROXY_NANO_CPUS,
      tmpfs: { "/tmp": PROXY_TMPFS },
      binds: null,
      ...expectedMounts([{ source: runtimeDirectory, target: RUNTIME_TARGET, readOnly: true }]),
      devices: [],
      pidMode: "",
      ipcMode: "private",
      usernsMode: "",
      logType: "none",
      environment: [
        `HIMAWARI_EGRESS_TARGETS=${input.record.targets.join(",")}`,
        `HIMAWARI_EGRESS_TOKEN=${input.record.token}`,
      ],
      networks: [OUTBOUND_NETWORK, network].sort(),
      alias: true,
      runtimeDigest: labels[`${LABEL}egress-runtime-digest`],
    };
  }
}

function proxyCommand(deadlineEpoch: number) {
  return [`${RUNTIME_TARGET}/egress-proxy-main.ts`, String(deadlineEpoch), String(EGRESS_PORT)];
}

function belongs(container: Container, name: string, labels: Record<string, string>) {
  const actual = container.Config.Labels ?? {};
  return (
    container.Name === `/${name}` &&
    Object.entries(labels).every(([key, value]) => actual[key] === value)
  );
}

function effectivePolicy(container: Container, network: string) {
  const host = container.HostConfig;
  const networks = container.NetworkSettings?.Networks ?? {};
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
    ...effectiveMounts(container),
    devices: host["Devices"] ?? [],
    pidMode: host["PidMode"],
    ipcMode: host["IpcMode"],
    usernsMode: host["UsernsMode"],
    logType: host.LogConfig?.Type,
    environment: (container.Config.Env ?? []).filter((item) => item.startsWith("HIMAWARI_")).sort(),
    networks: Object.keys(networks).sort(),
    alias: networks[network]?.Aliases?.includes(EGRESS_ALIAS) === true,
    runtimeDigest: container.Config.Labels?.[`${LABEL}egress-runtime-digest`],
  };
}
