import { execFile as execFileCallback } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandProfile } from "@himawari-agent/application";
import type { CommandSandboxLaunchProvider } from "./qualified-command-sandbox.js";

const execFile = promisify(execFileCallback);

export const LINUX_COMMAND_SANDBOX_ERROR_CODES = Object.freeze({
  PLATFORM_UNSUPPORTED: "COMMAND_BWRAP_PLATFORM_UNSUPPORTED",
  BACKEND_MISSING: "COMMAND_BWRAP_BACKEND_MISSING",
  BACKEND_UNSAFE: "COMMAND_BWRAP_BACKEND_UNSAFE",
  BACKEND_VERSION_UNSUPPORTED: "COMMAND_BWRAP_VERSION_UNSUPPORTED",
  WORKSPACE_SCOPE_INVALID: "COMMAND_BWRAP_WORKSPACE_SCOPE_INVALID",
  RUNTIME_ROOT_UNSAFE: "COMMAND_BWRAP_RUNTIME_ROOT_UNSAFE",
  PROBE_FAILED: "COMMAND_BWRAP_PROBE_FAILED",
} as const);

export interface LinuxBubblewrapWorkspaceBinding {
  readonly workspaceId: string;
  readonly hostRoot: string;
  readonly runtimeRoot: string;
  readonly sandboxPath: "/workspace";
  readonly executablePaths: Readonly<Record<string, string>>;
  readonly runtimeDigest: string;
}

interface LinuxCommandProbeResult {
  readonly productionSuitable: boolean;
  readonly runtimeIdentity: string;
  readonly reasonCodes: readonly string[];
}

export class LinuxBubblewrapCommandLaunchProvider implements CommandSandboxLaunchProvider {
  readonly #bindings: ReadonlyMap<string, LinuxBubblewrapWorkspaceBinding>;
  readonly #bwrapPath: string;
  readonly #prlimitPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly #observe: (profile: CommandProfile) => Promise<readonly string[]>;

  constructor(input: {
    readonly bindings: ReadonlyMap<string, LinuxBubblewrapWorkspaceBinding>;
    readonly observe: (profile: CommandProfile) => Promise<readonly string[]>;
    readonly bwrapPath: string;
    readonly prlimitPath: string;
    readonly platform?: NodeJS.Platform;
    readonly run?: (
      command: string,
      args: readonly string[],
    ) => Promise<{ stdout: string; stderr: string }>;
  }) {
    this.#bindings = input.bindings;
    this.#observe = input.observe;
    this.#bwrapPath = input.bwrapPath;
    this.#prlimitPath = input.prlimitPath;
    this.#platform = input.platform ?? process.platform;
    this.#run =
      input.run ??
      (async (command, args) => {
        const result = await execFile(command, [...args], {
          encoding: "utf8",
          timeout: 5_000,
          env: {},
          maxBuffer: 1024 * 1024,
        });
        return { stdout: result.stdout, stderr: result.stderr };
      });
  }

  async qualify(profile: CommandProfile): Promise<LinuxCommandProbeResult> {
    const binding = this.#bindings.get(profile.workspaceId);
    const identity = binding
      ? `linux-bwrap:0.11.2+prlimit>=2.38:${binding.runtimeDigest}`
      : "linux-bwrap:0.11.2+prlimit>=2.38:unbound";
    if (this.#platform !== "linux")
      return rejected(identity, LINUX_COMMAND_SANDBOX_ERROR_CODES.PLATFORM_UNSUPPORTED);
    if (!binding)
      return rejected(identity, LINUX_COMMAND_SANDBOX_ERROR_CODES.WORKSPACE_SCOPE_INVALID);
    try {
      const [bwrap, prlimit, runtimeRoot, hostRoot] = await Promise.all([
        lstat(this.#bwrapPath),
        lstat(this.#prlimitPath),
        lstat(binding.runtimeRoot),
        realpath(binding.hostRoot),
      ]);
      if (
        !bwrap.isFile() ||
        !prlimit.isFile() ||
        bwrap.isSymbolicLink() ||
        prlimit.isSymbolicLink() ||
        (bwrap.mode & 0o4022) !== 0 ||
        (prlimit.mode & 0o022) !== 0
      ) {
        return rejected(identity, LINUX_COMMAND_SANDBOX_ERROR_CODES.BACKEND_UNSAFE);
      }
      if (
        !runtimeRoot.isDirectory() ||
        runtimeRoot.isSymbolicLink() ||
        (runtimeRoot.mode & 0o022) !== 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(binding.runtimeDigest)
      ) {
        return rejected(identity, LINUX_COMMAND_SANDBOX_ERROR_CODES.RUNTIME_ROOT_UNSAFE);
      }
      if (
        (await realpath(profile.workdir)) !== hostRoot ||
        profile.fileScopes.length !== 1 ||
        (await realpath(profile.fileScopes[0] ?? "")) !== hostRoot
      ) {
        return rejected(identity, LINUX_COMMAND_SANDBOX_ERROR_CODES.WORKSPACE_SCOPE_INVALID);
      }
      const [bwrapVersion, prlimitVersion] = await Promise.all([
        this.#run(this.#bwrapPath, ["--version"]),
        this.#run(this.#prlimitPath, ["--version"]),
      ]);
      if (
        !/\b0\.11\.2\b/.test(`${bwrapVersion.stdout} ${bwrapVersion.stderr}`) ||
        !prlimitAtLeast238(`${prlimitVersion.stdout} ${prlimitVersion.stderr}`)
      ) {
        return rejected(identity, LINUX_COMMAND_SANDBOX_ERROR_CODES.BACKEND_VERSION_UNSUPPORTED);
      }
      await this.#run(this.#bwrapPath, [
        "--unshare-all",
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
        "--",
        "/usr/bin/true",
      ]);
      return Object.freeze({
        productionSuitable: true,
        runtimeIdentity: identity,
        reasonCodes: Object.freeze([]),
      });
    } catch (error) {
      const missing =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
      return rejected(
        identity,
        missing
          ? LINUX_COMMAND_SANDBOX_ERROR_CODES.BACKEND_MISSING
          : LINUX_COMMAND_SANDBOX_ERROR_CODES.PROBE_FAILED,
      );
    }
  }

  async createLaunch(input: {
    readonly profile: CommandProfile;
    readonly argv: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  }) {
    const qualification = await this.qualify(input.profile);
    if (!qualification.productionSuitable)
      throw new Error(qualification.reasonCodes[0] ?? "COMMAND_BWRAP_NOT_READY");
    const binding = this.#bindings.get(input.profile.workspaceId);
    const executable = binding?.executablePaths[input.argv[0] ?? ""];
    if (!binding || !executable || !path.posix.isAbsolute(executable))
      throw new Error(LINUX_COMMAND_SANDBOX_ERROR_CODES.RUNTIME_ROOT_UNSAFE);
    return Object.freeze({
      command: this.#prlimitPath,
      args: Object.freeze([
        `--cpu=${Math.max(1, Math.ceil(input.profile.resources.maxCpuTimeMs / 1_000))}`,
        `--as=${input.profile.resources.maxMemoryBytes}`,
        `--nproc=${input.profile.resources.maxProcesses}`,
        `--fsize=${input.profile.maxOutputBytes}`,
        "--",
        this.#bwrapPath,
        "--unshare-all",
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
        "--bind",
        binding.hostRoot,
        binding.sandboxPath,
        "--chdir",
        binding.sandboxPath,
        "--",
        executable,
        ...input.argv.slice(1),
      ]),
      cwd: "/",
      environment: Object.freeze({ ...input.environment }),
      ceiling: Object.freeze({
        maxWallTimeMs: input.profile.timeoutMs,
        maxCpuTimeMs: input.profile.resources.maxCpuTimeMs,
        maxMemoryBytes: input.profile.resources.maxMemoryBytes,
        maxOutputBytes: input.profile.maxOutputBytes,
        maxProgressEvents: 1,
      }),
    });
  }

  observeFiles(profile: CommandProfile): Promise<readonly string[]> {
    return this.#observe(profile);
  }
}

function prlimitAtLeast238(value: string): boolean {
  const match = value.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 38);
}

function rejected(runtimeIdentity: string, reasonCode: string): LinuxCommandProbeResult {
  return Object.freeze({
    productionSuitable: false,
    runtimeIdentity,
    reasonCodes: Object.freeze([reasonCode]),
  });
}
