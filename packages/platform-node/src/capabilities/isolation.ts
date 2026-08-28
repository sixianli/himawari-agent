import { execFile as execFileCallback, spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CapabilityManifest,
  CapabilityResourceCeiling,
  CapabilityRuntimeQualification,
  CapabilityRuntimeQualifierPort,
  ClockPort,
} from "@himawari-agent/application";

const execFile = promisify(execFileCallback);

export const CAPABILITY_ISOLATION_ERROR_CODES = Object.freeze({
  PLATFORM_UNSUPPORTED: "CAPABILITY_ISOLATION_PLATFORM_UNSUPPORTED",
  BACKEND_MISSING: "CAPABILITY_ISOLATION_BACKEND_MISSING",
  BACKEND_VERSION_UNSUPPORTED: "CAPABILITY_ISOLATION_BACKEND_VERSION_UNSUPPORTED",
  BACKEND_UNSAFE: "CAPABILITY_ISOLATION_BACKEND_UNSAFE",
  BACKEND_SETUID_FORBIDDEN: "CAPABILITY_ISOLATION_BACKEND_SETUID_FORBIDDEN",
  USER_NAMESPACE_UNAVAILABLE: "CAPABILITY_ISOLATION_USER_NAMESPACE_UNAVAILABLE",
  PROCESS_BINDING_MISSING: "CAPABILITY_ISOLATION_PROCESS_BINDING_MISSING",
  PROCESS_BINDING_MISMATCH: "CAPABILITY_ISOLATION_PROCESS_BINDING_MISMATCH",
  RUNTIME_ROOT_UNSAFE: "CAPABILITY_ISOLATION_RUNTIME_ROOT_UNSAFE",
  FILESYSTEM_SCOPE_UNSAFE: "CAPABILITY_ISOLATION_FILESYSTEM_SCOPE_UNSAFE",
  NETWORK_SCOPE_UNENFORCEABLE: "CAPABILITY_ISOLATION_NETWORK_SCOPE_UNENFORCEABLE",
  MACOS_SIGNED_HELPER_REQUIRED: "CAPABILITY_ISOLATION_MACOS_SIGNED_HELPER_REQUIRED",
  RUNTIME_KIND_UNSUPPORTED: "CAPABILITY_ISOLATION_RUNTIME_KIND_UNSUPPORTED",
  ENDPOINT_BINDING_MISSING: "CAPABILITY_ENDPOINT_BINDING_MISSING",
  ENDPOINT_IDENTITY_MISMATCH: "CAPABILITY_ENDPOINT_IDENTITY_MISMATCH",
  ENDPOINT_TRANSPORT_UNSAFE: "CAPABILITY_ENDPOINT_TRANSPORT_UNSAFE",
  ENDPOINT_BINDING_MISMATCH: "CAPABILITY_ENDPOINT_BINDING_MISMATCH",
  ENDPOINT_RUNTIME_NOT_APPROVED: "CAPABILITY_ENDPOINT_RUNTIME_NOT_APPROVED",
} as const);

export interface CapabilityFilesystemBinding {
  readonly scopeRef: string;
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly access: "read" | "read_write";
}

export interface CapabilityProcessBinding {
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  readonly artifactDigest: string;
  readonly runtimeRoot: string;
  readonly command: string;
  readonly workdirRef: string;
  readonly sandboxWorkdir: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly availableExecutables: readonly string[];
  readonly filesystem: readonly CapabilityFilesystemBinding[];
  readonly maximumResourceCeiling: CapabilityResourceCeiling;
  readonly mcpServerIdentity: string | null;
  readonly mcpServerName: string | null;
  readonly mcpServerVersion: string | null;
  readonly mcpOperationMap: Readonly<Record<string, string>>;
}

export interface CapabilityEndpointOperationBinding {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly secretHeaders: Readonly<Record<string, string>>;
}

export interface CapabilityEndpointBinding {
  readonly endpointIdentity: string;
  readonly artifactDigest: string;
  readonly url: string;
  readonly allowedMethods: readonly string[];
  readonly operations: Readonly<Record<string, CapabilityEndpointOperationBinding>>;
  readonly productionSuitable: boolean;
  readonly allowLoopbackQualification: boolean;
}

export interface CapabilityRuntimeBindingPort {
  resolveProcess(manifest: CapabilityManifest): Promise<CapabilityProcessBinding | undefined>;
  resolveEndpoint(manifest: CapabilityManifest): Promise<CapabilityEndpointBinding | undefined>;
}

export interface SandboxedProcessLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly ceiling: CapabilityResourceCeiling;
}

export interface SandboxedProcessIsolationBackend extends CapabilityRuntimeQualifierPort {
  createLaunch(
    manifest: CapabilityManifest,
    ceiling: CapabilityResourceCeiling,
  ): Promise<SandboxedProcessLaunch>;
}

interface IsolationProbe {
  readonly ready: boolean;
  readonly identity: string;
  readonly reasonCodes: readonly string[];
}

function versionTuple(value: string): readonly number[] | undefined {
  const match = value.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

function atLeast(actual: readonly number[], expected: readonly number[]): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    const delta = (actual[index] ?? 0) - (expected[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

function safeOwnedMode(info: Awaited<ReturnType<typeof lstat>>): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  return (
    (Number(info.mode) & 0o022) === 0 &&
    (currentUid === null || Number(info.uid) === currentUid || Number(info.uid) === 0)
  );
}

function validCeiling(ceiling: CapabilityResourceCeiling): boolean {
  return (
    Object.values(ceiling).every((value) => Number.isSafeInteger(value) && value > 0) &&
    ceiling.maxCpuTimeMs >= 1_000
  );
}

function sandboxPathInRuntimeRoot(runtimeRoot: string, sandboxPath: string): string | undefined {
  if (!path.posix.isAbsolute(sandboxPath) || sandboxPath === "/") return undefined;
  const resolvedRoot = path.resolve(runtimeRoot);
  const resolvedTarget = path.resolve(resolvedRoot, `.${sandboxPath}`);
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`) ? resolvedTarget : undefined;
}

function safeFilesystemSandboxPath(sandboxPath: string): boolean {
  const normalized = path.posix.normalize(sandboxPath);
  return (
    normalized === sandboxPath &&
    (normalized === "/workspace" || normalized.startsWith("/workspace/"))
  );
}

function platformName(value: NodeJS.Platform): CapabilityRuntimeQualification["platform"] {
  return value === "darwin" || value === "linux" ? value : "other";
}

function qualification(
  manifest: CapabilityManifest,
  platform: NodeJS.Platform,
  now: string,
  input: {
    readonly identity: string;
    readonly ready: boolean;
    readonly reasons: readonly string[];
  },
): CapabilityRuntimeQualification {
  return Object.freeze({
    qualificationVersion: "capability-runtime-qualification.v1",
    platform: platformName(platform),
    runtimeIdentity: input.identity,
    productionSuitable: input.ready,
    artifactDigest: manifest.integrity,
    enforcement: {
      filesystem: input.ready,
      network: input.ready,
      processes: input.ready,
      secrets: input.ready,
      resourceCeilings: input.ready,
      termination: input.ready,
    },
    reasonCodes: Object.freeze([...input.reasons]),
    checkedAt: now,
  });
}

function broadPath(target: string): boolean {
  const resolved = path.resolve(target);
  // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is index-signature typed under noPropertyAccessFromIndexSignature.
  const configuredHome = process.env["HOME"];
  const home = configuredHome ? path.resolve(configuredHome) : null;
  return (
    resolved === path.parse(resolved).root ||
    resolved === "/home" ||
    resolved === "/Users" ||
    (home !== null && (resolved === home || home.startsWith(`${resolved}${path.sep}`)))
  );
}

export class LinuxBubblewrapIsolationBackend implements SandboxedProcessIsolationBackend {
  readonly #bindings: CapabilityRuntimeBindingPort;
  readonly #clock: ClockPort;
  readonly #platform: NodeJS.Platform;
  readonly #bwrapPath: string;
  readonly #prlimitPath: string;
  #probePromise: Promise<IsolationProbe> | undefined;

  constructor(options: {
    readonly bindings: CapabilityRuntimeBindingPort;
    readonly clock: ClockPort;
    readonly platform?: NodeJS.Platform;
    readonly bwrapPath?: string;
    readonly prlimitPath?: string;
  }) {
    this.#bindings = options.bindings;
    this.#clock = options.clock;
    this.#platform = options.platform ?? process.platform;
    this.#bwrapPath = options.bwrapPath ?? "/usr/bin/bwrap";
    this.#prlimitPath = options.prlimitPath ?? "/usr/bin/prlimit";
  }

  async qualify(manifest: CapabilityManifest): Promise<CapabilityRuntimeQualification> {
    const now = this.#clock.now();
    if (manifest.runtime.kind !== "program" && manifest.runtime.kind !== "mcp") {
      return qualification(manifest, this.#platform, now, {
        identity: "linux-bubblewrap-0.11.2+prlimit",
        ready: false,
        reasons: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_KIND_UNSUPPORTED],
      });
    }
    const probe = await this.probe();
    if (!probe.ready) {
      return qualification(manifest, this.#platform, now, {
        identity: probe.identity,
        ready: false,
        reasons: probe.reasonCodes,
      });
    }
    if (manifest.isolation !== "sandbox") {
      return qualification(manifest, this.#platform, now, {
        identity: probe.identity,
        ready: false,
        reasons: [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH],
      });
    }
    if (manifest.scopes.network.length > 0) {
      return qualification(manifest, this.#platform, now, {
        identity: probe.identity,
        ready: false,
        reasons: [CAPABILITY_ISOLATION_ERROR_CODES.NETWORK_SCOPE_UNENFORCEABLE],
      });
    }
    if (manifest.scopes.secrets.length > 0) {
      return qualification(manifest, this.#platform, now, {
        identity: probe.identity,
        ready: false,
        reasons: [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH],
      });
    }
    const binding = await this.#bindings.resolveProcess(manifest);
    const reasons = await this.bindingReasons(manifest, binding);
    return qualification(manifest, this.#platform, now, {
      identity: probe.identity,
      ready: reasons.length === 0,
      reasons,
    });
  }

  async createLaunch(
    manifest: CapabilityManifest,
    ceiling: CapabilityResourceCeiling,
  ): Promise<SandboxedProcessLaunch> {
    const result = await this.qualify(manifest);
    if (!result.productionSuitable) throw new Error(result.reasonCodes[0] ?? "isolation-not-ready");
    const binding = await this.#bindings.resolveProcess(manifest);
    if (!binding) throw new Error(CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISSING);
    if (
      !validCeiling(ceiling) ||
      ceiling.maxWallTimeMs > binding.maximumResourceCeiling.maxWallTimeMs ||
      ceiling.maxCpuTimeMs > binding.maximumResourceCeiling.maxCpuTimeMs ||
      ceiling.maxMemoryBytes > binding.maximumResourceCeiling.maxMemoryBytes ||
      ceiling.maxOutputBytes > binding.maximumResourceCeiling.maxOutputBytes ||
      ceiling.maxProgressEvents > binding.maximumResourceCeiling.maxProgressEvents
    ) {
      throw new Error(CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH);
    }
    const runtime = manifest.runtime;
    if (runtime.kind !== "program" && runtime.kind !== "mcp") {
      throw new Error(CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_KIND_UNSUPPORTED);
    }
    const cpuSeconds = Math.floor(ceiling.maxCpuTimeMs / 1_000);
    const processLimit = Math.max(2, binding.availableExecutables.length + 1);
    const bwrapArgs = [
      "--unshare-all",
      "--clearenv",
      "--new-session",
      "--die-with-parent",
      "--disable-userns",
      "--ro-bind",
      binding.runtimeRoot,
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
    ];
    for (const [key, value] of Object.entries(binding.environment).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      bwrapArgs.push("--setenv", key, value);
    }
    for (const entry of [...binding.filesystem].sort((left, right) =>
      left.scopeRef.localeCompare(right.scopeRef),
    )) {
      bwrapArgs.push(
        entry.access === "read" ? "--ro-bind" : "--bind",
        entry.hostPath,
        entry.sandboxPath,
      );
    }
    bwrapArgs.push("--chdir", binding.sandboxWorkdir, "--", binding.command);
    if (runtime.kind === "program") bwrapArgs.push(...runtime.argv.slice(1));
    return Object.freeze({
      command: this.#prlimitPath,
      args: Object.freeze([
        `--cpu=${String(cpuSeconds)}`,
        `--as=${String(ceiling.maxMemoryBytes)}`,
        `--nproc=${String(processLimit)}`,
        `--fsize=${String(ceiling.maxOutputBytes)}`,
        "--",
        this.#bwrapPath,
        ...bwrapArgs,
      ]),
      cwd: "/",
      environment: Object.freeze({}),
      ceiling,
    });
  }

  private probe(): Promise<IsolationProbe> {
    this.#probePromise ??= this.runProbe();
    return this.#probePromise;
  }

  private async runProbe(): Promise<IsolationProbe> {
    const identity = "linux-bubblewrap-0.11.2+prlimit";
    if (this.#platform !== "linux") {
      return Object.freeze({
        ready: false,
        identity,
        reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.PLATFORM_UNSUPPORTED],
      });
    }
    try {
      const [bwrapInfo, prlimitInfo] = await Promise.all([
        lstat(this.#bwrapPath),
        lstat(this.#prlimitPath),
      ]);
      if (!bwrapInfo.isFile() || !prlimitInfo.isFile()) throw new Error("backend-not-file");
      if (!safeOwnedMode(bwrapInfo) || !safeOwnedMode(prlimitInfo)) {
        return Object.freeze({
          ready: false,
          identity,
          reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.BACKEND_UNSAFE],
        });
      }
      if ((bwrapInfo.mode & 0o4000) !== 0) {
        return Object.freeze({
          ready: false,
          identity,
          reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.BACKEND_SETUID_FORBIDDEN],
        });
      }
      const [bwrapVersion, prlimitVersion] = await Promise.all([
        execFile(this.#bwrapPath, ["--version"], { timeout: 2_000 }),
        execFile(this.#prlimitPath, ["--version"], { timeout: 2_000 }),
      ]);
      const bubblewrap = versionTuple(`${bwrapVersion.stdout} ${bwrapVersion.stderr}`);
      const utilLinux = versionTuple(`${prlimitVersion.stdout} ${prlimitVersion.stderr}`);
      if (
        !bubblewrap ||
        !utilLinux ||
        !atLeast(bubblewrap, [0, 11, 2]) ||
        !atLeast(utilLinux, [2, 38, 0])
      ) {
        return Object.freeze({
          ready: false,
          identity,
          reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.BACKEND_VERSION_UNSUPPORTED],
        });
      }
      await execFile(
        this.#bwrapPath,
        [
          "--unshare-all",
          "--clearenv",
          "--new-session",
          "--die-with-parent",
          "--disable-userns",
          "--ro-bind",
          "/usr",
          "/usr",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--",
          "/usr/bin/true",
        ],
        { timeout: 2_000 },
      );
      return Object.freeze({ ready: true, identity, reasonCodes: Object.freeze([]) });
    } catch (error) {
      const missing =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
      return Object.freeze({
        ready: false,
        identity,
        reasonCodes: [
          missing
            ? CAPABILITY_ISOLATION_ERROR_CODES.BACKEND_MISSING
            : CAPABILITY_ISOLATION_ERROR_CODES.USER_NAMESPACE_UNAVAILABLE,
        ],
      });
    }
  }

  private async bindingReasons(
    manifest: CapabilityManifest,
    binding: CapabilityProcessBinding | undefined,
  ): Promise<readonly string[]> {
    if (!binding) return [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISSING];
    const runtime = manifest.runtime;
    if (runtime.kind !== "program" && runtime.kind !== "mcp") {
      return [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_KIND_UNSUPPORTED];
    }
    const declaredExecutables =
      runtime.kind === "program"
        ? [runtime.argv[0] ?? "", ...runtime.subprocesses]
        : [binding.command];
    const mappedMcpOperations = Object.entries(binding.mcpOperationMap);
    const filesystemPaths = binding.filesystem.map(({ sandboxPath }) => sandboxPath);
    const overlappingFilesystemPaths = filesystemPaths.some((left, index) =>
      filesystemPaths.some(
        (right, otherIndex) =>
          index !== otherIndex &&
          (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)),
      ),
    );
    const bindingMismatch =
      binding.capabilityRef !== manifest.ref ||
      binding.capabilityVersion !== manifest.version ||
      binding.artifactDigest !== manifest.integrity ||
      !validCeiling(binding.maximumResourceCeiling) ||
      binding.workdirRef !==
        (runtime.kind === "program" ? runtime.workdirRef : binding.workdirRef) ||
      binding.command !== (runtime.kind === "program" ? runtime.argv[0] : binding.command) ||
      new Set(binding.availableExecutables).size !== binding.availableExecutables.length ||
      declaredExecutables.some(
        (executable) => !binding.availableExecutables.includes(executable),
      ) ||
      binding.availableExecutables.some(
        (executable) => !declaredExecutables.includes(executable),
      ) ||
      Object.keys(binding.environment).some((key) =>
        runtime.kind === "program" ? !runtime.environmentKeys.includes(key) : true,
      ) ||
      binding.filesystem.some((entry) => !manifest.scopes.filesystem.includes(entry.scopeRef)) ||
      overlappingFilesystemPaths ||
      binding.availableExecutables.some((executable) =>
        filesystemPaths.some(
          (filesystemPath) =>
            executable === filesystemPath || executable.startsWith(`${filesystemPath}/`),
        ),
      ) ||
      manifest.scopes.filesystem.some(
        (scope) => !binding.filesystem.some((entry) => entry.scopeRef === scope),
      ) ||
      (runtime.kind === "mcp" &&
        (runtime.transport !== "stdio:mcp-2026-07-28" ||
          binding.mcpServerName === null ||
          binding.mcpServerVersion === null ||
          binding.mcpServerIdentity !== runtime.serverIdentity ||
          mappedMcpOperations.length !== manifest.operations.length ||
          manifest.operations.some(
            (operation) =>
              !binding.mcpOperationMap[operation] ||
              !runtime.mappedResources.includes(`tool:${binding.mcpOperationMap[operation]}`),
          ))) ||
      (runtime.kind === "program" &&
        (!binding.filesystem.some(
          (entry) =>
            entry.scopeRef === runtime.workdirRef && entry.sandboxPath === binding.sandboxWorkdir,
        ) ||
          binding.mcpServerIdentity !== null ||
          binding.mcpServerName !== null ||
          binding.mcpServerVersion !== null ||
          mappedMcpOperations.length > 0));
    if (bindingMismatch) return [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH];
    try {
      const root = await lstat(binding.runtimeRoot);
      if (
        !path.isAbsolute(binding.runtimeRoot) ||
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        !safeOwnedMode(root) ||
        broadPath(binding.runtimeRoot)
      ) {
        return [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE];
      }
      for (const entry of binding.filesystem) {
        const host = await lstat(entry.hostPath);
        if (
          !path.isAbsolute(entry.hostPath) ||
          !path.isAbsolute(entry.sandboxPath) ||
          !safeFilesystemSandboxPath(entry.sandboxPath) ||
          host.isSymbolicLink() ||
          broadPath(entry.hostPath) ||
          !safeOwnedMode(host)
        ) {
          return [CAPABILITY_ISOLATION_ERROR_CODES.FILESYSTEM_SCOPE_UNSAFE];
        }
      }
      for (const executable of binding.availableExecutables) {
        const executablePath = sandboxPathInRuntimeRoot(binding.runtimeRoot, executable);
        if (!executablePath) {
          return [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE];
        }
        const executableInfo = await lstat(executablePath);
        if (
          !executableInfo.isFile() ||
          executableInfo.isSymbolicLink() ||
          !safeOwnedMode(executableInfo) ||
          (Number(executableInfo.mode) & 0o100) === 0
        ) {
          return [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE];
        }
      }
    } catch {
      return [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE];
    }
    return [];
  }
}

export class MacSignedHelperIsolationBackend implements CapabilityRuntimeQualifierPort {
  readonly #clock: ClockPort;
  readonly #platform: NodeJS.Platform;

  constructor(options: { readonly clock: ClockPort; readonly platform?: NodeJS.Platform }) {
    this.#clock = options.clock;
    this.#platform = options.platform ?? process.platform;
  }

  async qualify(manifest: CapabilityManifest): Promise<CapabilityRuntimeQualification> {
    return qualification(manifest, this.#platform, this.#clock.now(), {
      identity: "macos-app-sandbox-xpc-helper:not-configured",
      ready: false,
      reasons: [CAPABILITY_ISOLATION_ERROR_CODES.MACOS_SIGNED_HELPER_REQUIRED],
    });
  }
}

export class NodeCapabilityRuntimeQualifier implements CapabilityRuntimeQualifierPort {
  readonly #bindings: CapabilityRuntimeBindingPort;
  readonly #process: CapabilityRuntimeQualifierPort;
  readonly #clock: ClockPort;
  readonly #platform: NodeJS.Platform;
  readonly #delegated: CapabilityRuntimeQualifierPort | undefined;

  constructor(options: {
    readonly bindings: CapabilityRuntimeBindingPort;
    readonly process: CapabilityRuntimeQualifierPort;
    readonly clock: ClockPort;
    readonly platform?: NodeJS.Platform;
    readonly delegated?: CapabilityRuntimeQualifierPort;
  }) {
    this.#bindings = options.bindings;
    this.#process = options.process;
    this.#clock = options.clock;
    this.#platform = options.platform ?? globalThis.process.platform;
    this.#delegated = options.delegated;
  }

  async qualify(manifest: CapabilityManifest): Promise<CapabilityRuntimeQualification> {
    if (manifest.runtime.kind === "program" || manifest.runtime.kind === "mcp") {
      return this.#process.qualify(manifest);
    }
    if (manifest.runtime.kind === "remote_api" || manifest.runtime.kind === "adapter") {
      const binding = await this.#bindings.resolveEndpoint(manifest);
      let endpoint: URL | undefined;
      try {
        endpoint = binding ? new URL(binding.url) : undefined;
      } catch {
        endpoint = undefined;
      }
      const loopback = endpoint?.hostname === "127.0.0.1" || endpoint?.hostname === "localhost";
      const identityMatches =
        binding?.endpointIdentity === manifest.runtime.endpointIdentity &&
        binding.artifactDigest === manifest.integrity;
      const transportSafe =
        endpoint?.protocol === "https:" ||
        (endpoint?.protocol === "http:" &&
          loopback &&
          binding?.allowLoopbackQualification === true);
      const ready =
        binding !== undefined &&
        identityMatches &&
        transportSafe &&
        binding.productionSuitable &&
        binding.allowedMethods.length > 0 &&
        Object.keys(binding.operations).length === manifest.operations.length &&
        manifest.operations.every((operation) => {
          const operationBinding = binding.operations[operation];
          return (
            operationBinding !== undefined &&
            binding.allowedMethods.includes(operationBinding.method) &&
            operationBinding.path.startsWith("/") &&
            !operationBinding.path.startsWith("//") &&
            Object.keys(operationBinding.secretHeaders).every((secretRef) =>
              manifest.scopes.secrets.includes(secretRef),
            )
          );
        });
      const reasons = [
        ...(binding ? [] : [CAPABILITY_ISOLATION_ERROR_CODES.ENDPOINT_BINDING_MISSING]),
        ...(binding && !identityMatches
          ? [CAPABILITY_ISOLATION_ERROR_CODES.ENDPOINT_IDENTITY_MISMATCH]
          : []),
        ...(binding && !transportSafe
          ? [CAPABILITY_ISOLATION_ERROR_CODES.ENDPOINT_TRANSPORT_UNSAFE]
          : []),
        ...(binding && identityMatches && transportSafe && !binding.productionSuitable
          ? [CAPABILITY_ISOLATION_ERROR_CODES.ENDPOINT_RUNTIME_NOT_APPROVED]
          : []),
        ...(binding && identityMatches && transportSafe && binding.productionSuitable && !ready
          ? [CAPABILITY_ISOLATION_ERROR_CODES.ENDPOINT_BINDING_MISMATCH]
          : []),
      ];
      return qualification(manifest, this.#platform, this.#clock.now(), {
        identity: binding ? `node-fetch:${binding.endpointIdentity}` : "node-fetch:unbound",
        ready,
        reasons,
      });
    }
    if (this.#delegated) return this.#delegated.qualify(manifest);
    return qualification(manifest, this.#platform, this.#clock.now(), {
      identity: "delegated-runtime:unbound",
      ready: false,
      reasons: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_KIND_UNSUPPORTED],
    });
  }
}

export interface SandboxedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
}

export async function runSandboxedProcess(
  launch: SandboxedProcessLaunch,
  stdin: Uint8Array | null,
  signal?: AbortSignal,
): Promise<SandboxedProcessResult> {
  const child = spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: { ...launch.environment },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputLimitExceeded = false;
  let timedOut = false;
  let terminal = false;

  const killGroup = (terminationSignal: NodeJS.Signals): void => {
    if (!child.pid || terminal) return;
    try {
      process.kill(-child.pid, terminationSignal);
    } catch {
      child.kill(terminationSignal);
    }
  };
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    if (outputLimitExceeded) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > launch.ceiling.maxOutputBytes) {
      outputLimitExceeded = true;
      killGroup("SIGTERM");
      return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const onAbort = () => killGroup("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
  }, launch.ceiling.maxWallTimeMs);
  timeout.unref();
  const force = setTimeout(
    () => {
      if (timedOut || outputLimitExceeded || signal?.aborted) killGroup("SIGKILL");
    },
    Math.min(launch.ceiling.maxWallTimeMs + 250, 60_000),
  );
  force.unref();
  if (stdin) child.stdin.end(stdin);
  else child.stdin.end();
  try {
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode, exitSignal) => {
          terminal = true;
          resolve({ exitCode, signal: exitSignal });
        });
      },
    );
    return Object.freeze({
      ...result,
      stdout: new Uint8Array(Buffer.concat(stdout)),
      stderr: new Uint8Array(Buffer.concat(stderr)),
      timedOut,
      outputLimitExceeded,
    });
  } finally {
    terminal = true;
    clearTimeout(timeout);
    clearTimeout(force);
    signal?.removeEventListener("abort", onAbort);
  }
}
