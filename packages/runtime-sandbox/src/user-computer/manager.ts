import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type DockerCommand, dockerCli } from "../execution-backend/docker-command.ts";
import type { UserComputerConfig } from "./config.ts";
import { prepareComputerDisk, removeComputerDisk } from "./disk.ts";
import { type ComputerEgress, normalizeAllowedDomains, openComputerEgress } from "./egress.ts";
import { computerMemoryBytes, decideAdmission, hostAvailableMemoryBytes } from "./memory.ts";
import {
  COMPUTER_HOME,
  type UserComputerExecInput,
  type UserComputerExecResult,
  UserComputerError,
  type UserComputers,
  type UserComputerStatus,
} from "./types.ts";

const LABEL = "io.himawari.computer";
const POLICY_LABEL = `${LABEL}.policy`;
const RESERVED_VARIABLES = new Set([
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
]);
const CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "KILL"];
const KILL_AFTER_SECONDS = 2;
const CLIENT_GRACE_MS = 10_000;

export function computerOwnerKey(ownerId: string): string {
  return createHash("sha256").update(`himawari-computer:${ownerId}`).digest("hex").slice(0, 24);
}

export function computerNames(ownerKey: string) {
  return {
    container: `himawari-computer-${ownerKey}`,
    network: `himawari-computer-net-${ownerKey}`,
  };
}

interface Entry {
  activeCalls: number;
  lastActivityMs: number;
  egress: ComputerEgress | null;
  egressHost: string | null;
  lock: Promise<unknown>;
}

interface ComputerState {
  readonly ownerKey: string;
  readonly lastStartedAt: string | null;
  readonly lastActivityAt: string | null;
}

interface Inspected {
  readonly Id: string;
  readonly State: { readonly Running: boolean };
  readonly Config: { readonly Labels: Record<string, string> | null };
}

export interface UserComputerManagerOptions {
  readonly now?: () => number;
  readonly availableMemoryBytes?: () => Promise<number>;
}

export class UserComputerManager implements UserComputers {
  private readonly config: UserComputerConfig;
  private readonly docker: DockerCommand;
  private readonly now: () => number;
  private readonly availableMemoryBytes: () => Promise<number>;
  private readonly entries = new Map<string, Entry>();
  private admission: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private idleCheck: Promise<void> | null = null;
  private closed = false;

  constructor(config: UserComputerConfig, options: UserComputerManagerOptions = {}) {
    this.config = config;
    this.docker = dockerCli(
      config.docker.executable,
      config.docker.host ? ["--host", config.docker.host] : [],
    );
    this.now = options.now ?? Date.now;
    this.availableMemoryBytes = options.availableMemoryBytes ?? (() => hostAvailableMemoryBytes());
  }

  get policyDigest(): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          image: this.config.image.digest,
          runtime: this.config.runtime,
          resources: this.config.resources,
          disk: this.config.disk.mode,
          home: COMPUTER_HOME,
        }),
      )
      .digest("hex");
  }

  start(): void {
    if (this.idleTimer || this.closed) return;
    this.idleTimer = setInterval(() => {
      void this.stopIdle().catch(() => undefined);
    }, this.config.idle.checkIntervalMs);
    this.idleTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    await this.idleCheck;
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await entry.egress?.close();
        entry.egress = null;
        entry.egressHost = null;
      }),
    );
  }

  async exec(input: UserComputerExecInput): Promise<UserComputerExecResult> {
    if (this.closed) throw new UserComputerError("COMPUTER_UNAVAILABLE", "电脑管理已关闭");
    const request = this.validate(input);
    const ownerKey = computerOwnerKey(input.ownerId);
    const entry = this.entry(ownerKey);
    entry.activeCalls++;
    entry.lastActivityMs = this.now();
    try {
      const running = await this.withLock(entry, () =>
        this.ensureRunning(ownerKey, entry, request.deadlineMs),
      );
      if (!entry.egress) throw new UserComputerError("COMPUTER_UNAVAILABLE", "出口代理没有准备好");
      const release = entry.egress.allowlist.open(request.targets);
      try {
        return await this.run(running.containerId, entry.egress.proxyUrl, input, request);
      } finally {
        release();
      }
    } finally {
      entry.activeCalls--;
      entry.lastActivityMs = this.now();
      await this.writeState(ownerKey, { lastActivityAt: new Date(entry.lastActivityMs) }).catch(
        () => undefined,
      );
    }
  }

  async status(): Promise<readonly UserComputerStatus[]> {
    const containers = await this.listComputers();
    const states = await Promise.all(
      containers.map(async (container) => {
        const ownerKey = container.Config.Labels?.[LABEL] ?? "";
        const state = await this.readState(ownerKey);
        const entry = this.entries.get(ownerKey);
        return {
          ownerKey,
          state: container.State.Running ? ("running" as const) : ("stopped" as const),
          activeCalls: entry?.activeCalls ?? 0,
          lastActivityAt: entry
            ? new Date(entry.lastActivityMs).toISOString()
            : (state?.lastActivityAt ?? null),
          lastStartedAt: state?.lastStartedAt ?? null,
          memoryBytes: container.State.Running ? await computerMemoryBytes(container.Id) : null,
        };
      }),
    );
    return states.sort((a, b) => (a.ownerKey < b.ownerKey ? -1 : 1));
  }

  async staleComputers(): Promise<readonly string[]> {
    const cutoff = this.now() - this.config.idle.staleAfterMs;
    const stale: string[] = [];
    for (const computer of await this.status()) {
      if (computer.state === "running") continue;
      const last = Date.parse(computer.lastStartedAt ?? computer.lastActivityAt ?? "");
      if (Number.isFinite(last) && last < cutoff) stale.push(computer.ownerKey);
    }
    return stale;
  }

  async deleteComputer(ownerId: string): Promise<void> {
    const ownerKey = computerOwnerKey(ownerId);
    const entry = this.entry(ownerKey);
    await this.withLock(entry, async () => {
      if (entry.activeCalls > 0)
        throw new UserComputerError("COMPUTER_UNAVAILABLE", "这台电脑正在用，不能删");
      const names = computerNames(ownerKey);
      await entry.egress?.close();
      entry.egress = null;
      entry.egressHost = null;
      await this.command(["container", "rm", "--force", names.container]);
      await this.command(["network", "rm", names.network]);
      await removeComputerDisk({
        stateDirectory: this.config.stateDirectory,
        ownerKey,
        timeoutMs: this.config.commandTimeoutMs,
      });
      this.entries.delete(ownerKey);
    });
  }

  async stopIdle(): Promise<readonly string[]> {
    if (this.idleCheck) {
      await this.idleCheck;
      return [];
    }
    const stopped: string[] = [];
    const check = (async () => {
      for (const container of await this.listComputers()) {
        if (!container.State.Running) continue;
        const ownerKey = container.Config.Labels?.[LABEL];
        if (!ownerKey) continue;
        const entry = this.entry(ownerKey);
        if (entry.activeCalls > 0) continue;
        if (this.now() - entry.lastActivityMs < this.config.idle.stopAfterMs) continue;
        await this.withLock(entry, async () => {
          if (entry.activeCalls > 0) return;
          if (this.now() - entry.lastActivityMs < this.config.idle.stopAfterMs) return;
          await this.stopComputer(ownerKey, entry);
          stopped.push(ownerKey);
        });
      }
    })();
    this.idleCheck = check.finally(() => {
      this.idleCheck = null;
    });
    await this.idleCheck;
    return stopped;
  }

  private validate(input: UserComputerExecInput) {
    if (typeof input.ownerId !== "string" || input.ownerId.trim() === "")
      throw new UserComputerError("COMPUTER_REQUEST_INVALID", "ownerId");
    if (
      !Array.isArray(input.argv) ||
      input.argv.length === 0 ||
      input.argv.some((part) => typeof part !== "string" || part.includes("\0"))
    )
      throw new UserComputerError("COMPUTER_REQUEST_INVALID", "argv");
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0)
      throw new UserComputerError("COMPUTER_REQUEST_INVALID", "maxOutputBytes");
    if (input.cwd !== undefined && (!input.cwd.startsWith("/") || input.cwd.includes("\0")))
      throw new UserComputerError("COMPUTER_REQUEST_INVALID", "cwd");
    for (const [name, value] of Object.entries(input.env ?? {}))
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        RESERVED_VARIABLES.has(name) ||
        value.includes("\0")
      )
        throw new UserComputerError("COMPUTER_REQUEST_INVALID", `env.${name}`);
    const deadlineMs = Date.parse(input.deadlineAt);
    if (!Number.isFinite(deadlineMs))
      throw new UserComputerError("COMPUTER_REQUEST_INVALID", "deadlineAt");
    if (deadlineMs - this.now() < 1000) throw new UserComputerError("COMPUTER_DEADLINE_PASSED");
    let targets: readonly string[];
    try {
      targets = normalizeAllowedDomains(input.allowedDomains);
    } catch (error) {
      throw new UserComputerError(
        "COMPUTER_REQUEST_INVALID",
        error instanceof Error ? error.message : "allowedDomains",
      );
    }
    return { deadlineMs, targets };
  }

  private entry(ownerKey: string): Entry {
    let entry = this.entries.get(ownerKey);
    if (!entry) {
      entry = {
        activeCalls: 0,
        lastActivityMs: this.now(),
        egress: null,
        egressHost: null,
        lock: Promise.resolve(),
      };
      this.entries.set(ownerKey, entry);
    }
    return entry;
  }

  private async withLock<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
    const previous = entry.lock;
    let release = () => {};
    entry.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async ensureRunning(ownerKey: string, entry: Entry, deadlineMs: number) {
    const names = computerNames(ownerKey);
    const disk = await prepareComputerDisk({
      stateDirectory: this.config.stateDirectory,
      ownerKey,
      mode: this.config.disk.mode,
      sizeBytes: this.config.disk.sizeBytes,
      timeoutMs: this.config.commandTimeoutMs,
    }).catch((cause: unknown) => {
      throw new UserComputerError(
        "COMPUTER_START_FAILED",
        `准备磁盘失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
    const gateway = await this.ensureNetwork(ownerKey, names.network);
    let container = await this.inspect(names.container);
    if (container && container.Config.Labels?.[POLICY_LABEL] !== this.policyDigest) {
      if (container.State.Running && entry.activeCalls > 1) {
        return { containerId: container.Id, gateway };
      }
      await this.command(["container", "rm", "--force", container.Id]);
      container = null;
    }
    if (!container) {
      await this.ensureImage();
      const created = await this.command([
        "container",
        "create",
        ...this.createArguments(ownerKey, names, disk.home),
      ]);
      if (created.exitCode !== 0)
        throw new UserComputerError("COMPUTER_START_FAILED", created.stderr.trim().slice(0, 500));
      container = await this.inspect(names.container);
      if (!container) throw new UserComputerError("COMPUTER_START_FAILED", "创建后找不到电脑");
    }
    if (!container.State.Running) {
      await this.admit(ownerKey, deadlineMs);
      const started = await this.command(["container", "start", container.Id]);
      if (started.exitCode !== 0)
        throw new UserComputerError("COMPUTER_START_FAILED", started.stderr.trim().slice(0, 500));
      await this.writeState(ownerKey, { lastStartedAt: new Date(this.now()) });
    }
    if (!entry.egress || entry.egressHost !== gateway) {
      await entry.egress?.close();
      entry.egress = await openComputerEgress(gateway).catch((cause: unknown) => {
        throw new UserComputerError(
          "COMPUTER_START_FAILED",
          `出口代理没开起来：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
      entry.egressHost = gateway;
    }
    return { containerId: container.Id, gateway };
  }

  private async admit(ownerKey: string, deadlineMs: number): Promise<void> {
    const previous = this.admission;
    let release = () => {};
    this.admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      const attempts = Math.ceil(this.config.admission.waitMs / this.config.admission.pollMs);
      for (let attempt = 0; ; attempt++) {
        const running = (await this.listComputers())
          .filter((container) => container.State.Running)
          .map((container) => container.Config.Labels?.[LABEL] ?? "")
          .filter((key) => key && key !== ownerKey)
          .map((key) => {
            const entry = this.entry(key);
            return {
              ownerKey: key,
              activeCalls: entry.activeCalls,
              lastActivityMs: entry.lastActivityMs,
            };
          });
        const decision = decideAdmission({
          availableBytes: await this.availableMemoryBytes(),
          startBytes: this.config.admission.startBytes,
          reserveBytes: this.config.admission.reserveBytes,
          running,
        });
        if (decision.kind === "start") return;
        if (decision.kind === "evict") {
          const victim = this.entry(decision.ownerKey);
          await this.withLock(victim, async () => {
            if (victim.activeCalls === 0) await this.stopComputer(decision.ownerKey, victim);
          });
          continue;
        }
        if (attempt >= attempts || this.now() + this.config.admission.pollMs > deadlineMs)
          throw new UserComputerError("COMPUTER_WAITING_FOR_MEMORY", decision.detail);
        await new Promise((resolve) => setTimeout(resolve, this.config.admission.pollMs));
      }
    } finally {
      release();
    }
  }

  private async stopComputer(ownerKey: string, entry: Entry) {
    const names = computerNames(ownerKey);
    const hook = this.config.beforeStop;
    if (hook)
      await this.command(
        [
          "exec",
          names.container,
          "timeout",
          "-k",
          String(KILL_AFTER_SECONDS),
          String(hook.timeoutSeconds),
          ...hook.argv,
        ],
        (hook.timeoutSeconds + KILL_AFTER_SECONDS) * 1000 + CLIENT_GRACE_MS,
      ).catch(() => undefined);
    const stopped = await this.command(
      ["container", "stop", "--time", String(this.config.stopGraceSeconds), names.container],
      (this.config.stopGraceSeconds + 30) * 1000,
    );
    if (stopped.exitCode !== 0)
      throw new UserComputerError("COMPUTER_UNAVAILABLE", stopped.stderr.trim().slice(0, 500));
    await entry.egress?.close();
    entry.egress = null;
    entry.egressHost = null;
  }

  private createArguments(
    ownerKey: string,
    names: ReturnType<typeof computerNames>,
    home: string,
  ): string[] {
    const { resources } = this.config;
    return [
      "--name",
      names.container,
      "--label",
      `${LABEL}=${ownerKey}`,
      "--label",
      `${POLICY_LABEL}=${this.policyDigest}`,
      "--runtime",
      this.config.runtime,
      "--network",
      names.network,
      "--hostname",
      "himawari",
      "--memory",
      String(resources.memoryBytes),
      "--memory-swap",
      String(resources.memoryBytes),
      "--cpus",
      String(resources.cpus),
      "--pids-limit",
      String(resources.maxProcesses),
      "--cap-drop",
      "ALL",
      ...CAPABILITIES.flatMap((capability) => ["--cap-add", capability]),
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,source=${home},target=${COMPUTER_HOME}`,
      "--env",
      `HOME=${COMPUTER_HOME}`,
      "--workdir",
      COMPUTER_HOME,
      "--init",
      this.imageRef(),
      "sleep",
      "infinity",
    ];
  }

  private imageRef() {
    const { reference, digest } = this.config.image;
    return reference === null ? digest : `${reference}@${digest}`;
  }

  private async ensureImage() {
    const present = await this.command([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      this.imageRef(),
    ]);
    if (present.exitCode === 0) return;
    if (this.config.image.reference === null)
      throw new UserComputerError("COMPUTER_START_FAILED", "本机没有这个镜像，先在服务器上构建");
    const pulled = await this.command(["image", "pull", this.imageRef()], 30 * 60 * 1000);
    if (pulled.exitCode !== 0)
      throw new UserComputerError("COMPUTER_START_FAILED", `拉镜像失败：${pulled.stderr.trim()}`);
  }

  private async ensureNetwork(ownerKey: string, network: string): Promise<string> {
    let gateway = await this.networkGateway(network);
    if (gateway) return gateway;
    const created = await this.command([
      "network",
      "create",
      "--internal",
      "--driver",
      "bridge",
      "--label",
      `${LABEL}=${ownerKey}`,
      network,
    ]);
    if (created.exitCode !== 0 && !/already exists/i.test(created.stderr))
      throw new UserComputerError("COMPUTER_START_FAILED", created.stderr.trim().slice(0, 500));
    gateway = await this.networkGateway(network);
    if (!gateway) throw new UserComputerError("COMPUTER_START_FAILED", "网络没有网关地址");
    return gateway;
  }

  private async networkGateway(network: string): Promise<string | null> {
    const result = await this.command(["network", "inspect", "--format", "{{json .}}", network]);
    if (result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout) as {
      Internal?: boolean;
      IPAM?: { Config?: { Gateway?: string }[] };
    };
    if (parsed.Internal !== true)
      throw new UserComputerError("COMPUTER_START_FAILED", `${network} 不是内部网络`);
    return parsed.IPAM?.Config?.find((entry) => entry.Gateway)?.Gateway ?? null;
  }

  private async inspect(name: string): Promise<Inspected | null> {
    const result = await this.command(["container", "inspect", "--format", "{{json .}}", name]);
    if (result.exitCode !== 0) return null;
    return JSON.parse(result.stdout) as Inspected;
  }

  private async listComputers(): Promise<readonly Inspected[]> {
    const listed = await this.command([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=${LABEL}`,
    ]);
    if (listed.exitCode !== 0)
      throw new UserComputerError("COMPUTER_UNAVAILABLE", listed.stderr.trim().slice(0, 500));
    const ids = listed.stdout.split("\n").filter(Boolean);
    const found = await Promise.all(ids.map((id) => this.inspect(id)));
    return found.filter((item): item is Inspected => item !== null);
  }

  private async command(args: readonly string[], timeoutMs = this.config.commandTimeoutMs) {
    try {
      return await this.docker(args, { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
    } catch (cause) {
      throw new UserComputerError(
        "COMPUTER_UNAVAILABLE",
        `docker ${args[0] ?? ""} ${args[1] ?? ""}：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private run(
    containerId: string,
    proxyUrl: string,
    input: UserComputerExecInput,
    request: { readonly deadlineMs: number },
  ): Promise<UserComputerExecResult> {
    const seconds = Math.floor((request.deadlineMs - this.now()) / 1000);
    if (seconds < 1) throw new UserComputerError("COMPUTER_DEADLINE_PASSED");
    const environment: Record<string, string> = {
      ...(input.env ?? {}),
      HOME: COMPUTER_HOME,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
    };
    const args = [
      ...(this.config.docker.host ? ["--host", this.config.docker.host] : []),
      "exec",
      "--interactive",
      "--workdir",
      input.cwd ?? COMPUTER_HOME,
      ...Object.keys(environment)
        .sort()
        .flatMap((name) => ["--env", name]),
      containerId,
      "timeout",
      "-k",
      String(KILL_AFTER_SECONDS),
      String(seconds),
      ...input.argv,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.docker.executable, args, {
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const limit = input.maxOutputBytes;
      const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const sizes = { stdout: 0, stderr: 0 };
      let truncated = false;
      const collect = (name: "stdout" | "stderr") => (chunk: Buffer) => {
        const room = limit - sizes[name];
        if (chunk.length > room) truncated = true;
        if (room <= 0) return;
        const kept = chunk.subarray(0, room);
        streams[name].push(kept);
        sizes[name] += kept.length;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      child.stdin.on("error", () => undefined);
      child.stdin.end(input.stdin ? Buffer.from(input.stdin) : undefined);
      let killed = false;
      const timer = setTimeout(
        () => {
          killed = true;
          child.kill("SIGKILL");
        },
        (seconds + KILL_AFTER_SECONDS) * 1000 + CLIENT_GRACE_MS,
      );
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new UserComputerError("COMPUTER_UNAVAILABLE", error.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed || code === null) {
          reject(new UserComputerError("COMPUTER_UNAVAILABLE", "命令没有按时结束，结果未知"));
          return;
        }
        resolve({
          exitCode: code,
          stdout: new Uint8Array(Buffer.concat(streams.stdout)),
          stderr: new Uint8Array(Buffer.concat(streams.stderr)),
          truncated,
        });
      });
    });
  }

  private stateFile(ownerKey: string) {
    return path.join(this.config.stateDirectory, "computers", ownerKey, "state.json");
  }

  private async readState(ownerKey: string): Promise<ComputerState | null> {
    try {
      return JSON.parse(await readFile(this.stateFile(ownerKey), "utf8")) as ComputerState;
    } catch {
      return null;
    }
  }

  private async writeState(
    ownerKey: string,
    change: { readonly lastStartedAt?: Date; readonly lastActivityAt?: Date },
  ) {
    const current = await this.readState(ownerKey);
    const next: ComputerState = {
      ownerKey,
      lastStartedAt: change.lastStartedAt?.toISOString() ?? current?.lastStartedAt ?? null,
      lastActivityAt: change.lastActivityAt?.toISOString() ?? current?.lastActivityAt ?? null,
    };
    const file = this.stateFile(ownerKey);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }
}
