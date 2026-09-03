import { execFile as execFileCallback } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandProfile } from "@himawari-agent/application";
import type { CommandSandboxLaunchProvider } from "./qualified-command-sandbox.js";

const execFile = promisify(execFileCallback);

export const APPLE_CONTAINER_COMMAND_ERROR_CODES = Object.freeze({
  PLATFORM_UNSUPPORTED: "COMMAND_APPLE_CONTAINER_PLATFORM_UNSUPPORTED",
  BACKEND_MISSING: "COMMAND_APPLE_CONTAINER_BACKEND_MISSING",
  BACKEND_VERSION_UNSUPPORTED: "COMMAND_APPLE_CONTAINER_VERSION_UNSUPPORTED",
  SYSTEM_NOT_READY: "COMMAND_APPLE_CONTAINER_SYSTEM_NOT_READY",
  IMAGE_NOT_PINNED: "COMMAND_APPLE_CONTAINER_IMAGE_NOT_PINNED",
  IMAGE_UNAVAILABLE: "COMMAND_APPLE_CONTAINER_IMAGE_UNAVAILABLE",
  WORKSPACE_SCOPE_INVALID: "COMMAND_APPLE_CONTAINER_WORKSPACE_SCOPE_INVALID",
} as const);

export interface AppleContainerWorkspaceBinding {
  readonly workspaceId: string;
  readonly hostRoot: string;
  readonly imageRef: string;
  readonly containerPath: "/workspace";
  readonly guestPrlimitPath: "/usr/bin/prlimit";
  readonly probeShellPath: "/bin/sh";
}

interface AppleContainerProbeResult {
  readonly productionSuitable: boolean;
  readonly runtimeIdentity: string;
  readonly reasonCodes: readonly string[];
}

export class AppleContainerCommandLaunchProvider implements CommandSandboxLaunchProvider {
  readonly #bindings: ReadonlyMap<string, AppleContainerWorkspaceBinding>;
  readonly #containerPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #hostEnvironment: Readonly<Record<string, string>>;
  readonly #run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly #observe: (profile: CommandProfile) => Promise<readonly string[]>;

  constructor(input: {
    readonly bindings: ReadonlyMap<string, AppleContainerWorkspaceBinding>;
    readonly observe: (profile: CommandProfile) => Promise<readonly string[]>;
    readonly containerPath?: string;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly hostEnvironment?: Readonly<Record<string, string>>;
    readonly run?: (
      command: string,
      args: readonly string[],
    ) => Promise<{ stdout: string; stderr: string }>;
  }) {
    this.#bindings = input.bindings;
    this.#observe = input.observe;
    this.#containerPath = input.containerPath ?? "/usr/local/bin/container";
    this.#platform = input.platform ?? process.platform;
    this.#arch = input.arch ?? process.arch;
    this.#hostEnvironment = Object.freeze({ ...(input.hostEnvironment ?? {}) });
    this.#run =
      input.run ??
      (async (command, args) => {
        const result = await execFile(command, [...args], {
          encoding: "utf8",
          timeout: 5_000,
          env: { ...this.#hostEnvironment },
          maxBuffer: 1024 * 1024,
        });
        return { stdout: result.stdout, stderr: result.stderr };
      });
  }

  async qualify(profile: CommandProfile): Promise<AppleContainerProbeResult> {
    const binding = this.#bindings.get(profile.workspaceId);
    const identity = binding
      ? `apple-container:1.2.0:${binding.imageRef}`
      : "apple-container:1.2.0:unbound";
    if (this.#platform !== "darwin" || this.#arch !== "arm64")
      return rejected(identity, APPLE_CONTAINER_COMMAND_ERROR_CODES.PLATFORM_UNSUPPORTED);
    if (!binding || !/^.+@sha256:[a-f0-9]{64}$/.test(binding.imageRef))
      return rejected(identity, APPLE_CONTAINER_COMMAND_ERROR_CODES.IMAGE_NOT_PINNED);
    try {
      const executable = await lstat(this.#containerPath);
      if (!executable.isFile() || executable.isSymbolicLink())
        return rejected(identity, APPLE_CONTAINER_COMMAND_ERROR_CODES.BACKEND_MISSING);
      const root = await realpath(binding.hostRoot);
      if (
        !path.isAbsolute(binding.hostRoot) ||
        (await realpath(profile.workdir)) !== root ||
        profile.fileScopes.length !== 1 ||
        (await realpath(profile.fileScopes[0] ?? "")) !== root
      ) {
        return rejected(identity, APPLE_CONTAINER_COMMAND_ERROR_CODES.WORKSPACE_SCOPE_INVALID);
      }
      const version = await this.#run(this.#containerPath, ["system", "version"]);
      if (!/(?:^|\s)1\.2\.0(?:\s|$)/.test(`${version.stdout} ${version.stderr}`))
        return rejected(identity, APPLE_CONTAINER_COMMAND_ERROR_CODES.BACKEND_VERSION_UNSUPPORTED);
      await this.#run(this.#containerPath, ["system", "status"]);
      await this.#run(this.#containerPath, ["image", "inspect", binding.imageRef]);
      await this.#run(this.#containerPath, [
        "run",
        "--rm",
        "--network",
        "none",
        "--no-dns",
        "--home-mount",
        "none",
        "--read-only",
        binding.imageRef,
        binding.probeShellPath,
        "-c",
        [
          "set -eu",
          "set -- /sys/class/net/*",
          'test "$#" -eq 1',
          'test "$(basename "$1")" = lo',
          'while read -r _ destination _; do test "$destination" != 00000000 || exit 1; done < /proc/net/route',
          "test ! -e /Users",
          `test -x ${binding.guestPrlimitPath}`,
          "! touch /.himawari-root-write-probe",
        ].join("; "),
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
          ? APPLE_CONTAINER_COMMAND_ERROR_CODES.BACKEND_MISSING
          : APPLE_CONTAINER_COMMAND_ERROR_CODES.SYSTEM_NOT_READY,
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
      throw new Error(qualification.reasonCodes[0] ?? "COMMAND_APPLE_CONTAINER_NOT_READY");
    const binding = this.#bindings.get(input.profile.workspaceId);
    if (!binding) throw new Error(APPLE_CONTAINER_COMMAND_ERROR_CODES.WORKSPACE_SCOPE_INVALID);
    const cpuSeconds = Math.max(1, Math.ceil(input.profile.resources.maxCpuTimeMs / 1_000));
    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--no-dns",
      "--home-mount",
      "none",
      "--read-only",
      "--cpus",
      "1",
      "--memory",
      String(input.profile.resources.maxMemoryBytes),
      "--mount",
      `type=bind,source=${binding.hostRoot},target=${binding.containerPath}`,
      "--workdir",
      binding.containerPath,
    ];
    for (const name of Object.keys(input.environment).sort()) args.push("--env", name);
    args.push(
      binding.imageRef,
      binding.guestPrlimitPath,
      `--cpu=${cpuSeconds}`,
      `--nproc=${input.profile.resources.maxProcesses}`,
      `--fsize=${input.profile.maxOutputBytes}`,
      "--",
      ...input.argv,
    );
    return Object.freeze({
      command: this.#containerPath,
      args: Object.freeze(args),
      cwd: "/",
      environment: Object.freeze({ ...this.#hostEnvironment, ...input.environment }),
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

function rejected(runtimeIdentity: string, reasonCode: string): AppleContainerProbeResult {
  return Object.freeze({
    productionSuitable: false,
    runtimeIdentity,
    reasonCodes: Object.freeze([reasonCode]),
  });
}
