import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CapabilityManifest } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_ISOLATION_ERROR_CODES,
  type CapabilityProcessBinding,
  type CapabilityRuntimeBindingPort,
  LinuxBubblewrapIsolationBackend,
  MacSignedHelperIsolationBackend,
  runSandboxedProcess,
} from "../src/capabilities/isolation.js";

const NOW = "2026-08-28T08:10:00.000Z";
const roots: string[] = [];
const CEILING = {
  maxWallTimeMs: 1_000,
  maxCpuTimeMs: 1_000,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxOutputBytes: 4_096,
  maxProgressEvents: 8,
};

function programManifest(network: readonly string[] = []): CapabilityManifest {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    manifestVersion: "capability.v2",
    ref: "isolated-program",
    displayName: "Isolated program",
    version: "1.0.0",
    source: { type: "program", locator: "artifact:isolated-program:1.0.0" },
    sourceIdentity: "publisher:fixture",
    integrity: digest,
    artifact: {
      digest,
      signatureStatus: "verified",
      signerRef: "signer:fixture",
      rollbackArtifactRef: null,
    },
    operations: ["execute"],
    permissionRefs: [],
    isolation: "sandbox",
    scopes: {
      dataClassifications: ["public"],
      network,
      filesystem: ["workspace:fixture"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "unknown", checkedAt: null },
    reviewedBy: "owner",
    reviewedAt: NOW,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: ["/bin/fixture", "--json"],
      environmentKeys: ["LANG"],
      workdirRef: "workspace:fixture",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network,
      filesystem: ["workspace:fixture"],
    },
  };
}

async function backendFixture(): Promise<{
  readonly backend: LinuxBubblewrapIsolationBackend;
  readonly binding: CapabilityProcessBinding;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-isolation-"));
  roots.push(root);
  const bwrap = path.join(root, "bwrap");
  const prlimit = path.join(root, "prlimit");
  const runtimeRoot = path.join(root, "runtime-root");
  const runtimeBin = path.join(runtimeRoot, "bin");
  const workspace = path.join(root, "workspace");
  await Promise.all([
    mkdir(runtimeBin, { recursive: true }),
    mkdir(workspace),
    mkdir(path.join(runtimeRoot, "proc"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(runtimeRoot, "dev"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(runtimeRoot, "tmp"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(runtimeRoot, "workspace"), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(path.join(runtimeBin, "fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const resourceLimitSource = "#!/bin/sh\nexit 0\n";
  await writeFile(path.join(runtimeBin, "prlimit"), resourceLimitSource, { mode: 0o700 });
  await writeFile(
    bwrap,
    "#!/bin/sh\n" +
      'if [ "$1" = "--version" ]; then echo \'bubblewrap 0.11.2\'; exit 0; fi\n' +
      'case " $* " in *" --unshare-user "*) ;; *) exit 97;; esac\n' +
      'case " $* " in *" --symlink usr/lib /lib "*) ;; *) exit 98;; esac\n' +
      'case " $* " in *" --symlink usr/lib64 /lib64 "*) ;; *) exit 99;; esac\n' +
      "exit 0\n",
    { mode: 0o700 },
  );
  await writeFile(
    prlimit,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'prlimit from util-linux 2.39.4\'; fi\nexit 0\n',
    { mode: 0o700 },
  );
  const binding: CapabilityProcessBinding = {
    capabilityRef: "isolated-program",
    capabilityVersion: "1.0.0",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    runtimeRoot,
    command: "/bin/fixture",
    workdirRef: "workspace:fixture",
    sandboxWorkdir: "/workspace",
    environment: { LANG: "C.UTF-8" },
    availableExecutables: ["/bin/fixture"],
    resourceLimitExecutable: {
      sandboxPath: "/bin/prlimit",
      sha256: `sha256:${createHash("sha256").update(resourceLimitSource).digest("hex")}`,
    },
    filesystem: [
      {
        scopeRef: "workspace:fixture",
        hostPath: workspace,
        sandboxPath: "/workspace",
        access: "read_write",
      },
    ],
    maximumResourceCeiling: CEILING,
    mcpServerIdentity: null,
    mcpServerName: null,
    mcpServerVersion: null,
    mcpOperationMap: {},
  };
  const bindings: CapabilityRuntimeBindingPort = {
    resolveProcess: async () => binding,
    resolveEndpoint: async () => undefined,
  };
  return {
    binding,
    backend: new LinuxBubblewrapIsolationBackend({
      bindings,
      clock: { now: () => NOW },
      platform: "linux",
      bwrapPath: bwrap,
      prlimitPath: prlimit,
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("capability process isolation", () => {
  it("qualifies a pinned non-setuid Linux backend and builds a no-network launch", async () => {
    const { backend } = await backendFixture();
    const manifest = programManifest();
    await expect(backend.qualify(manifest)).resolves.toMatchObject({
      productionSuitable: true,
      platform: "linux",
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        resourceCeilings: true,
        termination: true,
      },
      reasonCodes: [],
    });
    const launch = await backend.createLaunch(manifest, CEILING);
    const processLimitIndex = launch.args.indexOf("--nproc=2");
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--unshare-all",
        "--clearenv",
        "--unshare-user",
        "--disable-userns",
        "--ro-bind",
        "--cpu=1",
        `--as=${String(CEILING.maxMemoryBytes)}`,
      ]),
    );
    expect(launch.args.filter((argument) => argument === "--nproc=2")).toHaveLength(1);
    expect(processLimitIndex).toBeGreaterThan(launch.args.indexOf("/bin/prlimit"));
    expect(launch.args[processLimitIndex + 1]).toBe("--");
    expect(launch.args[processLimitIndex + 2]).toBe("/bin/fixture");
    expect(launch.args).not.toContain("--share-net");
  });

  it("rejects a process-limit helper that is not the frozen runtime-root executable", async () => {
    const fixture = await backendFixture();
    Object.assign(fixture.binding, {
      resourceLimitExecutable: {
        sandboxPath: "/host/prlimit",
        sha256: `sha256:${"a".repeat(64)}`,
      },
    });
    await expect(fixture.backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE],
    });
  });

  it("rejects a process-limit helper covered by a writable filesystem mount", async () => {
    const fixture = await backendFixture();
    const runtimeWorkspace = path.join(fixture.binding.runtimeRoot, "workspace");
    const resourceLimitSource = "#!/bin/sh\nexit 0\n";
    await writeFile(path.join(runtimeWorkspace, "prlimit"), resourceLimitSource, { mode: 0o700 });
    Object.assign(fixture.binding, {
      resourceLimitExecutable: {
        sandboxPath: "/workspace/prlimit",
        sha256: `sha256:${createHash("sha256").update(resourceLimitSource).digest("hex")}`,
      },
    });
    await expect(fixture.backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH],
    });
  });

  it("rejects a runtime root without the fixed bubblewrap mountpoints", async () => {
    const fixture = await backendFixture();
    await rm(path.join(fixture.binding.runtimeRoot, "proc"), { recursive: true });
    await expect(fixture.backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE],
    });
  });

  it("accepts a regular-file filesystem bind when the runtime target has the same shape", async () => {
    const fixture = await backendFixture();
    const hostFile = path.join(fixture.binding.filesystem[0]?.hostPath ?? "/missing", "input.txt");
    const runtimeFile = path.join(fixture.binding.runtimeRoot, "workspace", "input.txt");
    await Promise.all([writeFile(hostFile, "fixture input\n"), writeFile(runtimeFile, "target\n")]);
    const mcpManifest: CapabilityManifest = {
      ...programManifest(),
      scopes: {
        ...programManifest().scopes,
        filesystem: ["file:fixture"],
      },
      runtime: {
        kind: "mcp",
        serverIdentity: "fixture-mcp@1.0.0",
        transport: "stdio:mcp-2026-07-28",
        mappedResources: ["tool:execute"],
      },
    };
    Object.assign(fixture.binding, {
      workdirRef: "file:fixture",
      filesystem: [
        {
          scopeRef: "file:fixture",
          hostPath: hostFile,
          sandboxPath: "/workspace/input.txt",
          access: "read",
        },
      ],
      mcpServerIdentity: "fixture-mcp@1.0.0",
      mcpServerName: "fixture-mcp",
      mcpServerVersion: "1.0.0",
      mcpOperationMap: { execute: "execute" },
      environment: {},
    });
    await expect(fixture.backend.qualify(mcpManifest)).resolves.toMatchObject({
      productionSuitable: true,
      reasonCodes: [],
    });
  });

  it("rejects a process-limit helper whose bytes do not match the frozen digest", async () => {
    const fixture = await backendFixture();
    await writeFile(path.join(fixture.binding.runtimeRoot, "bin", "prlimit"), "tampered\n", {
      mode: 0o700,
    });
    await expect(fixture.backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE],
    });
  });

  it("rejects a symlinked process-limit helper even when its target is inside the runtime root", async () => {
    const fixture = await backendFixture();
    await symlink("prlimit", path.join(fixture.binding.runtimeRoot, "bin", "prlimit-link"));
    Object.assign(fixture.binding, {
      resourceLimitExecutable: {
        sandboxPath: "/bin/prlimit-link",
        sha256: fixture.binding.resourceLimitExecutable.sha256,
      },
    });
    await expect(fixture.backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE],
    });
  });

  it("blocks network-scoped Linux programs because bubblewrap cannot enforce host allowlists", async () => {
    const { backend } = await backendFixture();
    await expect(backend.qualify(programManifest(["api.example.test:443"]))).resolves.toMatchObject(
      {
        productionSuitable: false,
        reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.NETWORK_SCOPE_UNENFORCEABLE],
      },
    );
  });

  it("blocks ceilings above the attested maximum", async () => {
    const { backend } = await backendFixture();
    await expect(
      backend.createLaunch(programManifest(), {
        ...CEILING,
        maxMemoryBytes: CEILING.maxMemoryBytes + 1,
      }),
    ).rejects.toThrow(CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH);
  });

  it("rejects sub-second CPU ceilings and filesystem binds outside /workspace", async () => {
    const cpuFixture = await backendFixture();
    Object.assign(cpuFixture.binding, {
      maximumResourceCeiling: { ...CEILING, maxCpuTimeMs: 999 },
    });
    await expect(cpuFixture.backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH],
    });

    const filesystemFixture = await backendFixture();
    Object.assign(filesystemFixture.binding, {
      sandboxWorkdir: "/opt/workspace",
      filesystem: filesystemFixture.binding.filesystem.map((entry) => ({
        ...entry,
        sandboxPath: "/opt/workspace",
      })),
    });
    await expect(filesystemFixture.backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.FILESYSTEM_SCOPE_UNSAFE],
    });
  });

  it("blocks Mac process capabilities until a signed App Sandbox/XPC helper exists", async () => {
    const backend = new MacSignedHelperIsolationBackend({
      clock: { now: () => NOW },
      platform: "darwin",
    });
    await expect(backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      platform: "darwin",
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.MACOS_SIGNED_HELPER_REQUIRED],
    });
  });

  it("enforces wall time and output bytes when supervising the sandbox process group", async () => {
    const outputLimited = await runSandboxedProcess(
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(10000))"],
        cwd: "/",
        environment: {},
        ceiling: { ...CEILING, maxOutputBytes: 128 },
      },
      null,
    );
    expect(outputLimited.outputLimitExceeded).toBe(true);

    const timedOut = await runSandboxedProcess(
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: "/",
        environment: {},
        ceiling: { ...CEILING, maxWallTimeMs: 50 },
      },
      null,
    );
    expect(timedOut.timedOut).toBe(true);
  });
});
