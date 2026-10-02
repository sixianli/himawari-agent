import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    mkdir(runtimeBin, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
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
    await Promise.all([
      writeFile(hostFile, "fixture input\n", { mode: 0o600 }),
      writeFile(runtimeFile, "target\n", { mode: 0o600 }),
    ]);
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

  it(
    "enforces output bytes independently of process startup time",
    { timeout: 15_000 },
    async () => {
      const outputLimited = await runSandboxedProcess(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(10000))"],
          cwd: "/",
          environment: {},
          // Give this output-quota assertion a separate wall deadline: cold Node startup
          // must not satisfy a different resource limit before the child writes output.
          ceiling: { ...CEILING, maxWallTimeMs: 10_000, maxOutputBytes: 128 },
        },
        null,
      );
      expect(outputLimited).toMatchObject({ outputLimitExceeded: true, timedOut: false });
      expect(outputLimited.stdout.byteLength + outputLimited.stderr.byteLength).toBeLessThanOrEqual(
        128,
      );
    },
  );

  it("reports the exit of a process that stops before reading its whole input", async () => {
    const result = await runSandboxedProcess(
      {
        command: "/bin/sh",
        args: ["-c", "exit 3"],
        cwd: "/",
        environment: {},
        ceiling: { ...CEILING, maxWallTimeMs: 10_000 },
      },
      new Uint8Array(4 * 1024 * 1024),
    );
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, outputLimitExceeded: false });
  });

  it("enforces wall time when supervising the sandbox process group", async () => {
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
    expect(timedOut).toMatchObject({ timedOut: true, outputLimitExceeded: false });
  });
});

describe("frozen sandbox launch boundary", () => {
  it.each([
    ["capabilityRef", "other"],
    ["capabilityVersion", "other"],
    ["artifactDigest", `sha256:${"b".repeat(64)}`],
    ["workdirRef", "workspace:other"],
    ["command", "/bin/other"],
    ["availableExecutables", ["/bin/fixture", "/bin/fixture"]],
    ["availableExecutables", []],
    ["availableExecutables", ["/bin/fixture", "/bin/undeclared"]],
    ["environment", { UNDECLARED: "1" }],
    ["filesystem", []],
    ["sandboxWorkdir", "/workspace/other"],
    ["mcpServerIdentity", "server"],
    ["mcpServerName", "server"],
    ["mcpServerVersion", "1"],
    ["mcpOperationMap", { execute: "tool" }],
    ["maximumResourceCeiling", { ...CEILING, maxMemoryBytes: 0 }],
  ])("refuses launch when frozen %s is substituted", async (key, value) => {
    const { backend, binding } = await backendFixture();
    Object.assign(binding, { [key as string]: value });
    await expect(backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH],
    });
    await expect(backend.createLaunch(programManifest(), CEILING)).rejects.toThrow(
      CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH,
    );
  });
  it.each(["/workspace", "/workspace/child"])(
    "refuses overlapping filesystem mounts %s",
    async (sandboxPath) => {
      const { backend, binding } = await backendFixture();
      Object.assign(binding, {
        filesystem: [...binding.filesystem, { ...binding.filesystem[0], sandboxPath }],
      });
      await expect(backend.qualify(programManifest())).resolves.toMatchObject({
        productionSuitable: false,
        reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH],
      });
    },
  );
  it.each(["relative", "/", "/bin/../bin/prlimit"])(
    "refuses noncanonical helper path %s",
    async (sandboxPath) => {
      const { backend, binding } = await backendFixture();
      Object.assign(binding, {
        resourceLimitExecutable: { ...binding.resourceLimitExecutable, sandboxPath },
      });
      await expect(backend.qualify(programManifest())).resolves.toMatchObject({
        productionSuitable: false,
        reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE],
      });
    },
  );
  it.each(["bin/prlimit", "bin/fixture", "proc", "workspace"])(
    "refuses writable runtime member %s",
    async (member) => {
      const { backend, binding } = await backendFixture();
      await chmod(path.join(binding.runtimeRoot, member), 0o777);
      await expect(backend.qualify(programManifest())).resolves.toMatchObject({
        productionSuitable: false,
        reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE],
      });
    },
  );
  it.each(["empty", "not-executable", "invalid-digest"])(
    "refuses helper with %s identity",
    async (kind) => {
      const { backend, binding } = await backendFixture();
      const executable = path.join(binding.runtimeRoot, "bin/prlimit");
      if (kind === "empty") await writeFile(executable, "");
      else if (kind === "not-executable") await chmod(executable, 0o600);
      else
        Object.assign(binding, {
          resourceLimitExecutable: { ...binding.resourceLimitExecutable, sha256: "invalid" },
        });
      await expect(backend.qualify(programManifest())).resolves.toMatchObject({
        productionSuitable: false,
        reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE],
      });
    },
  );
  it("reports an unsafe helper even when the host namespace probe also fails", async () => {
    const { backend, binding } = await backendFixture();
    await writeFile(path.join(binding.runtimeRoot, "bin/prlimit"), "");
    await writeFile(
      path.join(path.dirname(binding.runtimeRoot), "bwrap"),
      "#!/bin/sh\n" +
        'if [ "$1" = "--version" ]; then echo \'bubblewrap 0.11.2\'; exit 0; fi\n' +
        "exit 1\n",
      { mode: 0o700 },
    );
    await expect(backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE],
    });
  });
  it("refuses host filesystem access with group write permissions", async () => {
    const { backend, binding } = await backendFixture();
    const filesystem = binding.filesystem[0];
    if (!filesystem) throw new Error("Expected filesystem binding");
    await chmod(filesystem.hostPath, 0o770);
    await expect(backend.qualify(programManifest())).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.FILESYSTEM_SCOPE_UNSAFE],
    });
  });
  it.each(["scope", "secrets"])("refuses a manifest that changes %s assumptions", async (kind) => {
    const { backend } = await backendFixture();
    const manifest = programManifest();
    const invalid =
      kind === "scope"
        ? { ...manifest, isolation: "worker" as const }
        : { ...manifest, scopes: { ...manifest.scopes, secrets: ["secret:fixture"] } };
    await expect(backend.qualify(invalid)).resolves.toMatchObject({
      productionSuitable: false,
      reasonCodes: [CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH],
    });
  });
});

async function inheritedProgramFixture(mode: "tail" | "continuous" | "slow-start") {
  const root = await mkdtemp(path.join(os.tmpdir(), "b6-output-"));
  roots.push(root);
  const marker = `B6_OUTPUT_${path.basename(root)}`;
  const childFile = path.join(root, "child.sh");
  const readyFile = path.join(root, "ready.json");
  const countFile = path.join(root, "written-lines.txt");
  const parentFile = path.join(root, "parent.sh");
  await writeFile(countFile, "");
  await writeFile(
    childFile,
    `
parent="$1"
${mode === "slow-start" ? "sleep 0.8" : ""}
printf '{"pid":%s,"parent":%s}' "$$" "$parent" > ./ready.json
while kill -0 "$parent" 2>/dev/null; do sleep 0.002; done
${
  mode === "tail"
    ? `sleep 0.05
printf 'child-tail\\n'
printf 'stderr-tail\\n' >&2`
    : `while :; do
  printf 'more-output\\n'
  printf 'parent-exited\\n' >> ./written-lines.txt
  sleep ${mode === "slow-start" ? "0.06" : "0.02"}
done`
}
`,
  );
  await writeFile(
    parentFile,
    `
printf 'parent-start\\n'
/bin/sh ./child.sh "$$" "$1" &
while [ ! -f ./ready.json ]; do sleep 0.002; done
exit 7
`,
  );
  const processes = () =>
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match
          ? [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                pgid: Number(match[3]),
                command: match[4] ?? "",
              },
            ]
          : [];
      });
  const identity = async () =>
    JSON.parse(await readFile(readyFile, "utf8")) as { pid: number; parent: number };
  return {
    launch: {
      command: "/bin/sh",
      args: [parentFile, marker],
      cwd: root,
      environment: {},
      ceiling: { ...CEILING },
    },
    async expectCompleteOutput(stdout: Uint8Array) {
      const confirmed = (await readFile(countFile, "utf8")).split("parent-exited\n").length - 1;
      const output = new TextDecoder().decode(stdout);
      const received = output.split("more-output\n").length - 1;
      expect(confirmed).toBeGreaterThan(0);
      expect(output).toBe(`parent-start\n${"more-output\n".repeat(received)}`);
      expect(received).toBeGreaterThanOrEqual(confirmed);
      expect(received).toBeLessThanOrEqual(confirmed + 1);
    },
    async parentExited() {
      const known = await identity().catch(() => undefined);
      if (!known) return false;
      const rows = processes();
      const child = rows.find((row) => row.pid === known.pid);
      expect(child?.command).toContain(marker);
      expect(child?.pgid).toBe(known.parent);
      return !rows.some((row) => row.pid === known.parent);
    },
    async childGone() {
      const known = await identity();
      return !processes().some((row) => row.pid === known.pid && row.command.includes(marker));
    },
    async cleanup() {
      const known = await identity().catch(() => undefined);
      if (!known) return;
      const child = processes().find(
        (row) => row.pid === known.pid && row.command.includes(marker),
      );
      if (child) process.kill(child.pid, "SIGKILL");
      await expect.poll(() => this.childGone(), { timeout: 1000 }).toBe(true);
    },
  };
}

describe("program output after the parent exits", () => {
  it("[R2-D20] preserves deadline with delayed child startup after the parent exits", async () => {
    const fixture = await inheritedProgramFixture("slow-start");
    try {
      const result = await runSandboxedProcess(fixture.launch, null);
      expect(result).toMatchObject({
        exitCode: 7,
        timedOut: true,
        outputLimitExceeded: false,
      });
      await fixture.expectCompleteOutput(result.stdout);
      await expect.poll(() => fixture.childGone(), { timeout: 1000 }).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("collects delayed stdout and stderr from the original process group", async () => {
    const fixture = await inheritedProgramFixture("tail");
    try {
      const result = await runSandboxedProcess(fixture.launch, null);
      expect(result).toMatchObject({
        exitCode: 7,
        signal: null,
        timedOut: false,
        outputLimitExceeded: false,
      });
      expect(new TextDecoder().decode(result.stdout)).toBe("parent-start\nchild-tail\n");
      expect(new TextDecoder().decode(result.stderr)).toBe("stderr-tail\n");
      expect(await fixture.childGone()).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["deadline", "output-limit", "cancel"] as const)(
    "preserves %s after the parent exits",
    async (mode) => {
      const fixture = await inheritedProgramFixture("continuous");
      const controller = new AbortController();
      const running = runSandboxedProcess(
        {
          ...fixture.launch,
          ceiling: { ...CEILING, maxOutputBytes: mode === "output-limit" ? 64 : 4096 },
        },
        null,
        controller.signal,
      );
      try {
        if (mode === "cancel") {
          await expect.poll(() => fixture.parentExited(), { timeout: 1000 }).toBe(true);
          controller.abort();
        }
        const result = await running;
        expect(result).toMatchObject({
          exitCode: 7,
          timedOut: mode === "deadline",
          outputLimitExceeded: mode === "output-limit",
        });
        if (mode === "deadline") await fixture.expectCompleteOutput(result.stdout);
        if (mode === "output-limit")
          expect(result.stdout.byteLength + result.stderr.byteLength).toBeLessThanOrEqual(64);
        await expect.poll(() => fixture.childGone(), { timeout: 1000 }).toBe(true);
      } finally {
        await fixture.cleanup();
        await running;
      }
    },
  );
});
