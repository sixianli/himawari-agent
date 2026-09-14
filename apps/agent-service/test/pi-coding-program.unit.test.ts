import { Readable } from "node:stream";
import type { PiRunnerInput } from "@himawari-agent/execution-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  process: {
    ...process,
    argv: [] as string[],
    env: { ...process.env },
    stdin: undefined as unknown,
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    exitCode: undefined as number | undefined,
    cwd: vi.fn(),
  },
  metadata: vi.fn(),
  canonical: vi.fn(),
  operations: vi.fn(),
  execute: vi.fn(),
  exportFile: vi.fn(),
  command: vi.fn(),
}));
vi.mock("node:process", () => ({ default: boundary.process }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()),
  lstat: boundary.metadata,
  realpath: boundary.canonical,
}));
vi.mock("@himawari-agent/platform-node", () => ({
  createSandboxedCodingOperations: boundary.operations,
  exportPiOutputFile: boundary.exportFile,
}));
vi.mock("@himawari-agent/runtime-pi", () => ({ executeSandboxedPiCodingTool: boundary.execute }));
function input(tool: PiRunnerInput["tool"] = "read"): PiRunnerInput {
  return {
    schemaVersion: "pi-runner.v1",
    workerInstanceId: "worker-program",
    tool,
    workspace: "/workspace",
    runtimeRoot: "/runtime",
    privateDirectory: "/private-runner",
    maxOutputBytes: 65536,
    parametersJson: '{"path":"README.md"}',
    executionMode: "foreground",
    scope: {
      schemaVersion: "sandbox-scope.v1",
      ownerId: "owner-program",
      agentId: "agent-program",
      threadId: "thread-program",
      runId: "run-program",
      toolCallId: "tool-program",
      parentToolCallId: null,
      parentRequestId: "run-program",
      hostId: "host-program",
      handleRef: "handle-program",
      inputRef: "input-program",
      operation: tool,
      authorizationRef: "grant-program",
      modelRef: "model-program",
      profileRef: "authorized-project.v1",
      directoryGrant: {
        ref: "directory-program",
        revision: 1,
        canonicalRootId: "root-program",
        authorizationRef: "directory-grant",
        operations: ["read", "create", "update"],
      },
      networkAuthorizationRef: null,
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
  };
}
async function run(value: unknown, bytes?: Buffer) {
  boundary.process.stdin = Readable.from([bytes ?? Buffer.from(JSON.stringify(value))]);
  await import("../src/capability-programs/pi-coding-main.ts");
}
function failed() {
  expect(boundary.process.exitCode).toBe(1);
  expect(boundary.process.stderr.write).toHaveBeenCalledWith("PI_RUNNER_EXECUTION_FAILED\n");
}
function output() {
  return JSON.parse(
    boundary.process.stdout.write.mock.calls.map(([value]) => String(value)).join(""),
  );
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boundary.process.argv = ["node", "pi-coding-main", "host-program", "worker-program"];
  boundary.process.env = { HOME: "/private-runner", TMPDIR: "/private-runner", PATH: "/initial" };
  boundary.process.exitCode = undefined;
  boundary.process.cwd.mockReturnValue("/workspace");
  boundary.metadata.mockResolvedValue({
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o755,
  });
  boundary.canonical.mockImplementation(async (filename: string) => filename);
  boundary.operations.mockResolvedValue({ executeCommand: boundary.command });
  boundary.command.mockResolvedValue({ exitCode: 0 });
  boundary.execute.mockResolvedValue({
    content: [{ type: "text", text: "Authorized result" }],
    details: {},
    isError: false,
  });
  boundary.exportFile.mockResolvedValue({ text: "Complete output", byteLength: 15 });
});
afterEach(() => vi.restoreAllMocks());

describe("installed Pi coding program boundary", () => {
  it("binds its existing Pi executor to the frozen grant and serializes a scoped result", async () => {
    await run(input());
    expect(boundary.process.exitCode).toBeUndefined();
    expect(boundary.operations).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPath: "/workspace/README.md",
        privateDirectory: "/private-runner",
        binaryDirectory: "/runtime/pi-tools/bin",
        grant: expect.objectContaining({
          hostId: "host-program",
          id: "directory-program",
          operations: ["read", "create", "update"],
        }),
      }),
    );
    expect(boundary.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "read",
        toolCallId: "tool-program",
        cwd: "/workspace",
        parameters: { path: "README.md" },
      }),
    );
    expect(output()).toMatchObject({
      schemaVersion: "pi-result.v1",
      tool: "read",
      content: [{ type: "text", text: "Authorized result" }],
      verifiedWrite: null,
      source: { directoryGrantRef: "directory-program", directoryGrantRevision: 1 },
    });
    expect(boundary.process.env).toMatchObject({
      PI_OFFLINE: "1",
      PATH: "/runtime/pi-tools/bin",
      PI_CODING_AGENT_DIR: "/runtime/pi-tools",
    });
  });
  it.each([
    { args: [] },
    { args: ["host-program"] },
    { args: ["host-program", "worker-program", "extra"] },
  ])("refuses invalid process identity arguments $args", async ({ args }) => {
    boundary.process.argv = ["node", "pi-coding-main", ...args];
    await run(input());
    failed();
    expect(boundary.operations).not.toHaveBeenCalled();
  });
  it.each([Buffer.alloc(128 * 1024 + 1), Buffer.from([0xff, 0xfe]), Buffer.from("{invalid")])(
    "rejects oversized or malformed protected input",
    async (bytes) => {
      await run(null, bytes);
      failed();
      expect(boundary.execute).not.toHaveBeenCalled();
      expect(boundary.process.stdout.write).not.toHaveBeenCalled();
    },
  );
  it.each([
    "hostId",
    "workerInstanceId",
    "operation",
    "profileRef",
    "expiresAt",
    "cwd",
    "home",
    "tmpdir",
  ])("rejects mismatched %s before creating operations", async (field) => {
    const value = input();
    const changed =
      field === "workerInstanceId"
        ? { ...value, workerInstanceId: "other" }
        : ["hostId", "operation", "profileRef", "expiresAt"].includes(field)
          ? {
              ...value,
              scope: {
                ...value.scope,
                [field]: field === "expiresAt" ? "2000-01-01T00:00:00.000Z" : "other",
              },
            }
          : value;
    if (field === "cwd") boundary.process.cwd.mockReturnValue("/other");
    if (field === "home") boundary.process.env = { ...boundary.process.env, HOME: "/other" };
    if (field === "tmpdir") boundary.process.env = { ...boundary.process.env, TMPDIR: "/other" };
    await run(changed);
    failed();
    expect(boundary.operations).not.toHaveBeenCalled();
  });
  it.each([
    ["grep", "rg"],
    ["find", "fd"],
    ["bash", "bash"],
  ] as const)("uses the verified installed %s binary", async (tool, name) => {
    await run(input(tool));
    expect(boundary.metadata).toHaveBeenCalledWith(`/runtime/pi-tools/bin/${name}`);
    expect(boundary.canonical).toHaveBeenCalledWith(`/runtime/pi-tools/bin/${name}`);
    expect(boundary.execute).toHaveBeenCalledOnce();
  });
  it.each(["missing", "symlink", "directory", "non-executable", "outside"])(
    "refuses a %s installed tool without a PATH fallback",
    async (kind) => {
      if (kind === "missing") boundary.metadata.mockRejectedValue(new Error("ENOENT"));
      else
        boundary.metadata.mockResolvedValue({
          isFile: () => kind !== "directory",
          isSymbolicLink: () => kind === "symlink",
          mode: kind === "non-executable" ? 0o644 : 0o755,
        });
      if (kind === "outside") boundary.canonical.mockResolvedValue("/unapproved/rg");
      await run(input("grep"));
      failed();
      expect(boundary.execute).not.toHaveBeenCalled();
    },
  );
  it.each(["../outside", ".git/config", ".env", ".himawari-private/record"])(
    "rejects out-of-scope target %s",
    async (target) => {
      await run({ ...input(), parametersJson: JSON.stringify({ path: target }) });
      failed();
      expect(boundary.operations).not.toHaveBeenCalled();
    },
  );
  it.each(["null", "[]", '"text"', "{invalid"])(
    "refuses invalid tool arguments %s",
    async (parametersJson) => {
      await run({ ...input(), parametersJson });
      failed();
      expect(boundary.execute).not.toHaveBeenCalled();
    },
  );
  it("exports a protected full result and removes its private filesystem path", async () => {
    boundary.execute.mockResolvedValue({
      content: [{ type: "text", text: "See /private-runner/output.txt" }],
      details: { fullOutputPath: "/private-runner/output.txt", other: "kept" },
      isError: false,
    });
    await run(input());
    expect(boundary.exportFile).toHaveBeenCalledWith(
      "/private-runner/output.txt",
      "/private-runner",
      65536,
    );
    expect(output()).toMatchObject({
      details: { other: "kept" },
      fullOutput: { text: "Complete output" },
    });
    expect(JSON.stringify(output())).not.toContain("/private-runner/output.txt");
  });
  it("records exactly one independently verified write", async () => {
    const proof = { path: "note.txt", contentDigest: "sha256:verified", byteLength: 4 };
    boundary.operations.mockImplementation(async ({ onVerifiedWrite }) => {
      onVerifiedWrite(proof);
      return { executeCommand: boundary.command };
    });
    await run(input("write"));
    expect(output().verifiedWrite).toEqual(proof);
  });
  it("rejects multiple write proofs instead of presenting ambiguous provenance", async () => {
    boundary.operations.mockImplementation(async ({ onVerifiedWrite }) => {
      const proof = { path: "note.txt", contentDigest: "sha256:verified", byteLength: 4 };
      onVerifiedWrite(proof);
      onVerifiedWrite(proof);
    });
    await run(input("write"));
    failed();
    expect(boundary.process.stdout.write).not.toHaveBeenCalled();
  });
  it.each([0, 7, 300])("maps tool failure to a valid process exit code (%s)", async (exitCode) => {
    boundary.command.mockResolvedValue({ exitCode });
    boundary.execute.mockImplementation(async ({ operations }) => {
      await operations.executeCommand({ command: "fixture", onData: vi.fn() });
      return { content: [], isError: true };
    });
    await run(input("bash"));
    expect(output().commandExitCode).toBe(exitCode);
    expect(boundary.process.exitCode).toBe(exitCode === 7 ? 7 : 1);
  });
  it("rejects a foreground output exceeding its granted byte ceiling", async () => {
    await run({ ...input(), maxOutputBytes: 10 });
    failed();
    expect(boundary.process.stdout.write).not.toHaveBeenCalled();
  });
  it("streams complete background lines and the final fragment with the real exit result", async () => {
    boundary.command.mockImplementation(async ({ onData }) => {
      onData(Buffer.from("line one\npartial"));
      onData(Buffer.from(" end"));
      return { exitCode: 7 };
    });
    boundary.execute.mockImplementation(async ({ operations }) => {
      await operations.executeCommand({ command: "fixture", onData: vi.fn() });
      return { content: [], isError: false };
    });
    await run({ ...input("bash"), executionMode: "background" });
    expect(boundary.process.stdout.write.mock.calls.map(([value]) => String(value))).toEqual([
      "line one\n",
      "partial end",
    ]);
    expect(boundary.process.exitCode).toBe(7);
  });
  it.each(["too-large", "secret"])("blocks unsafe background output (%s)", async (kind) => {
    boundary.command.mockImplementation(async ({ onData }) => {
      onData(
        Buffer.from(
          kind === "too-large" ? "x".repeat(65537) : ["-----BEGIN", "PRIVATE KEY-----\n"].join(" "),
        ),
      );
      return { exitCode: 0 };
    });
    boundary.execute.mockImplementation(async ({ operations }) => {
      await operations.executeCommand({ command: "fixture", onData: vi.fn() });
      return { content: [], isError: false };
    });
    await run({ ...input("bash"), executionMode: "background" });
    failed();
    expect(boundary.process.stdout.write).not.toHaveBeenCalled();
  });
});
