import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CommandExecutionService,
  CommandProfileService,
  type CommandProfile,
} from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppleContainerCommandLaunchProvider,
  LinuxBubblewrapCommandLaunchProvider,
  MacCommandSandboxRouter,
  MacSeatbeltXpcCommandSandbox,
  QualifiedCommandSandbox,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QualifiedCommandSandbox", () => {
  it("requires the signed read-only App Sandbox/XPC qualification contract", async () => {
    const runtimeIdentity = "mac-seatbelt-xpc:v1:fixture-team:fixture-helper";
    let invoked = 0;
    const qualification = {
      protocolIdentity: "himawari.mac-command.v1" as const,
      runtimeIdentity,
      codeSignatureValid: true,
      appSandboxEntitled: true,
      xpcServiceSandboxInherited: true,
      workspaceReadOnlyEnforced: true,
      networkClientEntitled: false,
    };
    const profile: CommandProfile = {
      id: "command-profile-seatbelt",
      revision: 1,
      workspaceId: "workspace-seatbelt",
      argvPattern: ["git", "status", "--short"],
      workdir: "/fixture",
      environmentNames: [],
      fileScopes: ["/fixture"],
      network: "none",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      resources: { maxCpuTimeMs: 500, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 2 },
      sandboxTier: "native-low-risk",
      sandboxRuntimeIdentity: runtimeIdentity,
      scriptDigest: null,
      scriptSource: null,
      authorizationRef: "authorization:seatbelt",
      expiresAt: "2026-09-01T00:00:00.000Z",
      revokedAt: null,
    };
    const client = {
      qualify: async () => qualification,
      execute: async () => {
        invoked += 1;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: new TextEncoder().encode(" M file.txt"),
          stderr: new Uint8Array(),
          outputLimitExceeded: false,
          wallTimeMs: 1,
          fileObservationRefs: ["workspace-readonly:fixture"],
          cancellationReconciled: true,
          resourceCeilingEnforced: true as const,
        };
      },
    };
    const sandbox = new MacSeatbeltXpcCommandSandbox({
      client,
      expectedRuntimeIdentity: runtimeIdentity,
      platform: "darwin",
    });
    await expect(
      sandbox.execute({ profile, argv: profile.argvPattern, secretBindings: [] }),
    ).resolves.toEqual(
      expect.objectContaining({
        sandboxRuntimeIdentity: runtimeIdentity,
        networkObservationRefs: ["command-network:none:app-sandbox-entitlement"],
      }),
    );
    expect(invoked).toBe(1);
    const unqualified = new MacSeatbeltXpcCommandSandbox({
      client: {
        ...client,
        qualify: async () => ({ ...qualification, codeSignatureValid: false }),
      },
      expectedRuntimeIdentity: runtimeIdentity,
      platform: "darwin",
    });
    await expect(
      unqualified.execute({ profile, argv: profile.argvPattern, secretBindings: [] }),
    ).rejects.toThrow("COMMAND_MAC_SEATBELT_HELPER_NOT_QUALIFIED");
    expect(invoked).toBe(1);
  });

  it("routes Mac commands by frozen tier without fallback", async () => {
    const calls: string[] = [];
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      outputLimitExceeded: false,
      wallTimeMs: 1,
      fileObservationRefs: [],
      networkObservationRefs: ["command-network:none:enforced"],
      redactionApplied: true as const,
      cancellationReconciled: true,
      sandboxRuntimeIdentity: "fixture",
      resourceCeilingEnforced: true as const,
    };
    const router = new MacCommandSandboxRouter({
      nativeLowRisk: {
        execute: async () => {
          calls.push("native");
          return result;
        },
      },
      isolatedHighRisk: {
        execute: async () => {
          calls.push("isolated");
          throw new Error("CONTAINER_UNAVAILABLE");
        },
      },
    });
    const profile: CommandProfile = {
      id: "command-profile-router",
      revision: 1,
      workspaceId: "workspace-router",
      argvPattern: ["git", "status"],
      workdir: "/fixture",
      environmentNames: [],
      fileScopes: ["/fixture"],
      network: "none",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      resources: { maxCpuTimeMs: 500, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 2 },
      sandboxTier: "native-low-risk",
      sandboxRuntimeIdentity: "mac-seatbelt-xpc:fixture",
      scriptDigest: null,
      scriptSource: null,
      authorizationRef: "authorization:router",
      expiresAt: "2026-09-01T00:00:00.000Z",
      revokedAt: null,
    };
    await expect(
      router.execute({ profile, argv: profile.argvPattern, secretBindings: [] }),
    ).resolves.toEqual(result);
    await expect(
      router.execute({
        profile: { ...profile, sandboxTier: "isolated-high-risk" },
        argv: ["npm", "test"],
        secretBindings: [],
      }),
    ).rejects.toThrow("CONTAINER_UNAVAILABLE");
    expect(calls).toEqual(["native", "isolated"]);
    await expect(
      router.execute({
        profile,
        argv: profile.argvPattern,
        secretBindings: [{ environmentName: "TOKEN", handleRef: "secret:fixture" }],
      }),
    ).rejects.toThrow("COMMAND_NATIVE_LOW_RISK_SECRETS_FORBIDDEN");
    expect(calls).toEqual(["native", "isolated"]);
  });

  it("injects handle-resolved secrets only into the child and redacts protected output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-command-sandbox-"));
    roots.push(root);
    const argv = [
      "node",
      "-e",
      "process.stdout.write(process.env.FIXTURE_TOKEN + ' sk-' + 'proj-abcdefghijklmnop')",
    ];
    const profile: CommandProfile = {
      id: "command-profile-01",
      revision: 1,
      workspaceId: "workspace-01",
      argvPattern: argv,
      workdir: root,
      environmentNames: ["FIXTURE_TOKEN"],
      fileScopes: [root],
      network: "none",
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      resources: {
        maxCpuTimeMs: 2_000,
        maxMemoryBytes: 128 * 1024 * 1024,
        maxProcesses: 2,
      },
      sandboxTier: "isolated-high-risk",
      sandboxRuntimeIdentity: "fixture-sandbox:v1",
      scriptDigest: "sha256:fixture-script",
      scriptSource: argv[2] ?? null,
      authorizationRef: "authorization:command",
      expiresAt: "2026-08-28T21:00:00.000Z",
      revokedAt: null,
    };
    const sandbox = new QualifiedCommandSandbox({
      clock: { now: () => "2026-08-28T20:00:00.000Z" },
      secrets: {
        resolve: async () => ({
          value: "fixture-secret-value",
          scopeRef: profile.id,
          expiresAt: "2026-08-28T20:30:00.000Z",
          revokedAt: null,
        }),
      },
      launches: {
        qualify: async () => ({
          productionSuitable: true,
          runtimeIdentity: profile.sandboxRuntimeIdentity,
          reasonCodes: [],
        }),
        observeFiles: async () => ["fixture-snapshot"],
        createLaunch: async ({ environment }) => ({
          command: process.execPath,
          args: argv.slice(1),
          cwd: root,
          environment,
          ceiling: {
            maxWallTimeMs: profile.timeoutMs,
            maxCpuTimeMs: profile.resources.maxCpuTimeMs,
            maxMemoryBytes: profile.resources.maxMemoryBytes,
            maxOutputBytes: profile.maxOutputBytes,
            maxProgressEvents: 1,
          },
        }),
      },
    });
    const payloads = new Map<string, string>();
    const service = new CommandExecutionService({
      profiles: new CommandProfileService(),
      sandbox,
      clock: { now: () => "2026-08-28T20:00:00.000Z" },
      output: {
        protect: async ({ stream, bytes }) => {
          const ref = `payload:${stream}`;
          payloads.set(ref, new TextDecoder().decode(bytes));
          return ref;
        },
      },
    });
    const observation = await service.execute({
      profile,
      argv,
      scriptDigest: profile.scriptDigest,
      secretBindings: [{ environmentName: "FIXTURE_TOKEN", handleRef: "secret-handle-01" }],
    });
    expect(payloads.get(observation.stdoutRef)).toBe("[SECRET_REDACTED] [MACHINE_SECRET_REDACTED]");
    expect(observation.networkObservationRefs).toEqual(["command-network:none:enforced"]);
    expect(observation.cancellationReconciled).toBe(true);
  });

  it("builds a pinned no-network Apple container launch without secret values in argv", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-apple-container-"));
    roots.push(root);
    const executable = path.join(root, "container");
    await writeFile(executable, "fixture");
    await chmod(executable, 0o700);
    const imageRef = `local/himawari-runtime@sha256:${"a".repeat(64)}`;
    const profile: CommandProfile = {
      id: "command-profile-apple",
      revision: 1,
      workspaceId: "workspace-apple",
      argvPattern: ["npm", "test"],
      workdir: root,
      environmentNames: ["FIXTURE_TOKEN"],
      fileScopes: [root],
      network: "none",
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      resources: {
        maxCpuTimeMs: 2_000,
        maxMemoryBytes: 128 * 1024 * 1024,
        maxProcesses: 4,
      },
      sandboxTier: "isolated-high-risk",
      sandboxRuntimeIdentity: `apple-container:1.2.0:${imageRef}`,
      scriptDigest: null,
      scriptSource: null,
      authorizationRef: "authorization:apple-command",
      expiresAt: "2026-08-28T21:00:00.000Z",
      revokedAt: null,
    };
    const probeCalls: string[][] = [];
    const provider = new AppleContainerCommandLaunchProvider({
      platform: "darwin",
      arch: "arm64",
      containerPath: executable,
      bindings: new Map([
        [
          profile.workspaceId,
          {
            workspaceId: profile.workspaceId,
            hostRoot: root,
            imageRef,
            containerPath: "/workspace",
            guestPrlimitPath: "/usr/bin/prlimit",
            probeShellPath: "/bin/sh",
          },
        ],
      ]),
      observe: async () => [],
      run: async (_command, args) => {
        probeCalls.push([...args]);
        return {
          stdout:
            args[0] === "system" && args[1] === "version" ? "container 1.2.0" : "fixture-ready",
          stderr: "",
        };
      },
    });
    expect(await provider.qualify(profile)).toEqual({
      productionSuitable: true,
      runtimeIdentity: profile.sandboxRuntimeIdentity,
      reasonCodes: [],
    });
    expect(probeCalls).toContainEqual(
      expect.arrayContaining([
        "run",
        "--network",
        "none",
        "--no-dns",
        "--home-mount",
        "none",
        "--read-only",
        "/bin/sh",
        "-c",
      ]),
    );
    const launch = await provider.createLaunch({
      profile,
      argv: profile.argvPattern,
      environment: { FIXTURE_TOKEN: "fixture-secret-value" },
    });
    expect(launch.args).toContain("none");
    expect(launch.args).toContain("--read-only");
    expect(launch.args).toContain("--no-dns");
    expect(launch.args).toContain("FIXTURE_TOKEN");
    expect(launch.args.join(" ")).not.toContain("fixture-secret-value");
    // biome-ignore lint/complexity/useLiteralKeys: environment is intentionally indexable.
    expect(launch.environment["FIXTURE_TOKEN"]).toBe("fixture-secret-value");
  });

  it("qualifies an exact non-setuid bubblewrap runtime and freezes an isolated Linux launch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-linux-sandbox-"));
    roots.push(root);
    const runtimeRoot = path.join(root, "runtime");
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(runtimeRoot, "usr/bin"), { recursive: true });
    await mkdir(workspace);
    const bwrap = path.join(root, "bwrap");
    const prlimit = path.join(root, "prlimit");
    await writeFile(bwrap, "fixture");
    await writeFile(prlimit, "fixture");
    await chmod(bwrap, 0o755);
    await chmod(prlimit, 0o755);
    const runtimeDigest = `sha256:${"b".repeat(64)}`;
    const profile: CommandProfile = {
      id: "command-profile-linux",
      revision: 1,
      workspaceId: "workspace-linux",
      argvPattern: ["npm", "test"],
      workdir: workspace,
      environmentNames: [],
      fileScopes: [workspace],
      network: "none",
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      resources: {
        maxCpuTimeMs: 2_000,
        maxMemoryBytes: 128 * 1024 * 1024,
        maxProcesses: 4,
      },
      sandboxTier: "isolated-high-risk",
      sandboxRuntimeIdentity: `linux-bwrap:0.11.2+prlimit>=2.38:${runtimeDigest}`,
      scriptDigest: null,
      scriptSource: null,
      authorizationRef: "authorization:linux-command",
      expiresAt: "2026-08-28T21:00:00.000Z",
      revokedAt: null,
    };
    const provider = new LinuxBubblewrapCommandLaunchProvider({
      platform: "linux",
      bwrapPath: bwrap,
      prlimitPath: prlimit,
      bindings: new Map([
        [
          profile.workspaceId,
          {
            workspaceId: profile.workspaceId,
            hostRoot: workspace,
            runtimeRoot,
            sandboxPath: "/workspace",
            executablePaths: { npm: "/usr/bin/npm" },
            runtimeDigest,
          },
        ],
      ]),
      observe: async () => [],
      run: async (command) => ({
        stdout:
          command === bwrap
            ? "bubblewrap 0.11.2"
            : command === prlimit
              ? "prlimit from util-linux 2.38.1"
              : "",
        stderr: "",
      }),
    });
    expect(await provider.qualify(profile)).toEqual({
      productionSuitable: true,
      runtimeIdentity: profile.sandboxRuntimeIdentity,
      reasonCodes: [],
    });
    const launch = await provider.createLaunch({
      profile,
      argv: profile.argvPattern,
      environment: {},
    });
    expect(launch.command).toBe(prlimit);
    expect(launch.args).toContain("--unshare-all");
    expect(launch.args).toContain("--disable-userns");
    expect(launch.args).toContain("/usr/bin/npm");
    expect(launch.environment).toEqual({});
  });
});
