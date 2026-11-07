import { Readable } from "node:stream";
import type { PiRunnerInput } from "@himawari-agent/execution-contracts";
import {
  PI_RESIDENT_FRAME_LIMIT_BYTES,
  PI_RESIDENT_OUTPUT_CHUNK_BYTES,
} from "@himawari-agent/execution-contracts";
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
  fitOutput: vi.fn(),
  command: vi.fn(),
}));
vi.mock("node:process", () => ({ default: boundary.process }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()),
  lstat: boundary.metadata,
  realpath: boundary.canonical,
}));
vi.mock("@himawari-agent/platform-node", async (original) => ({
  ...(await original<object>()),
  createSandboxedCodingOperations: boundary.operations,
}));
vi.mock("../../../packages/platform-node/src/files/pi-output-export.ts", () => ({
  exportPiOutputFile: boundary.exportFile,
}));
vi.mock("@himawari-agent/runtime-pi", () => ({
  executeSandboxedPiCodingTool: boundary.execute,
  fitPiResultOutput: boundary.fitOutput,
}));

await Promise.all([
  vi.importActual("@himawari-agent/application"),
  vi.importActual("@himawari-agent/platform-node"),
]);
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
function frames(): Record<string, unknown>[] {
  return boundary.process.stdout.write.mock.calls
    .map(([value]) => String(value))
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
const runFrame = (seq: number, value: unknown) =>
  `${JSON.stringify({
    type: "run",
    seq,
    inputBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
  })}\n`;
async function runResident(lines: readonly string[]) {
  boundary.process.argv = [
    "node",
    "pi-coding-main",
    "host-program",
    "worker-program",
    "--resident",
    "/runtime",
  ];
  boundary.process.stdin = Readable.from(lines.map((line) => Buffer.from(line)));
  await import("../src/capability-programs/pi-coding-main.ts");
}
function outputsFor(seq: number): Record<string, unknown>[] {
  return frames().filter((frame) => frame["seq"] === seq && frame["type"] === "output");
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
    isDirectory: () => false,
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
  boundary.fitOutput.mockImplementation((json: string, maxBytes: number) =>
    Buffer.byteLength(json, "utf-8") <= maxBytes ? json : null,
  );
});
afterEach(() => vi.restoreAllMocks());

describe("installed Pi coding program boundary", () => {
  it("[R2-D22] binds its existing Pi executor to the frozen grant and serializes a scoped result", async () => {
    await run(input());
    expect(boundary.process.exitCode).toBeUndefined();
    expect(boundary.operations).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPath: "/workspace/README.md",
        privateDirectory: "/private-runner",
        commandPath: "/runtime/pi-tools/bin:/usr/local/bin:/usr/bin:/bin",
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
  it("[R2-T1] reports a directory read as a directory and never runs the Pi tool", async () => {
    boundary.metadata.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
    });
    await run(input("read"));
    expect(boundary.operations).not.toHaveBeenCalled();
    expect(boundary.execute).not.toHaveBeenCalled();
    expect(boundary.process.exitCode).toBe(1);
    expect(JSON.stringify(output())).toContain("是目录");
  });
  it("[R2-T3] finds sandboxed bash commands in the verified tool directory before the system directories", async () => {
    boundary.execute.mockImplementation(async ({ operations }) => {
      await operations.executeCommand({ command: "ls", onData: vi.fn() });
      return { content: [], isError: false };
    });
    await run(input("bash"));
    expect(boundary.operations).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: "/runtime/pi-tools/bin/bash",
        commandPath: "/runtime/pi-tools/bin:/usr/local/bin:/usr/bin:/bin",
      }),
    );
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
      expect.any(Number),
    );
    expect(boundary.exportFile.mock.calls[0]?.[2]).toBeLessThanOrEqual(65536);
    expect(output()).toMatchObject({
      details: { other: "kept" },
      fullOutput: { text: "Complete output" },
    });
    expect(JSON.stringify(output())).not.toContain("/private-runner/output.txt");
  });
  it("records exactly one independently verified write", async () => {
    const proof = { path: "note.txt", contentDigest: "sha256:verified", byteLength: 4 };
    boundary.operations.mockImplementation(async ({ onVerifiedWrite }) => {
      await onVerifiedWrite(proof);
      return { executeCommand: boundary.command };
    });
    await run(input("write"));
    expect(output().verifiedWrite).toEqual(proof);
  });
  it("rejects multiple write proofs instead of presenting ambiguous provenance", async () => {
    boundary.operations.mockImplementation(async ({ onVerifiedWrite }) => {
      const proof = { path: "note.txt", contentDigest: "sha256:verified", byteLength: 4 };
      await onVerifiedWrite(proof);
      await onVerifiedWrite(proof);
    });
    await run(input("write"));
    failed();
    expect(boundary.process.stdout.write).not.toHaveBeenCalled();
  });
  it("rejects concurrent write proofs before accepting either as unique provenance", async () => {
    boundary.operations.mockImplementation(async ({ onVerifiedWrite }) => {
      const proof = { path: "note.txt", contentDigest: "sha256:verified", byteLength: 4 };
      await Promise.all([onVerifiedWrite(proof), onVerifiedWrite(proof)]);
      return { executeCommand: boundary.command };
    });
    await run(input("write"));
    failed();
    expect(boundary.process.stdout.write).not.toHaveBeenCalled();
  });
  it.each([
    ["edit", false, true],
    ["write", false, true],
    ["edit", true, false],
    ["bash", false, false],
  ] as const)(
    "[R2-T14] marks a %s failure as not written only when no commit started (commit %s)",
    async (tool, commitStarted, marked) => {
      let commitStarting: (() => Promise<void>) | undefined;
      boundary.operations.mockImplementation(async (options) => {
        commitStarting = options.onCommitStarting;
        return { executeCommand: boundary.command };
      });
      boundary.execute.mockImplementation(async () => {
        if (commitStarted) await commitStarting?.();
        return {
          content: [{ type: "text", text: "Could not find the exact text in README.md." }],
          details: {},
          isError: true,
        };
      });
      await run(input(tool));
      expect(boundary.process.exitCode).toBe(1);
      expect(output()).toMatchObject({ tool, isError: true, verifiedWrite: null });
      if (marked) expect(output().writeNotStarted).toBe(true);
      else expect(output()).not.toHaveProperty("writeNotStarted");
    },
  );
  it("[R2-T14] does not mark a successful edit as not written", async () => {
    await run(input("edit"));
    expect(boundary.process.exitCode).toBeUndefined();
    expect(output()).not.toHaveProperty("writeNotStarted");
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
  it("blocks background output that is too large", async () => {
    boundary.command.mockImplementation(async ({ onData }) => {
      onData(Buffer.from("x".repeat(65537)));
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

  it.each([
    ["secret", ["-----BEGIN", "PRIVATE KEY-----\n"].join(" ")],
    ["[R2-T14] key tail", `MIIEvR2T14TAILBODY\n${["-----END", "PRIVATE KEY-----\n"].join(" ")}`],
  ])(
    "streams background output that looks like a key (%s); egress masks it later",
    async (_kind, text) => {
      boundary.command.mockImplementation(async ({ onData }) => {
        onData(Buffer.from(text));
        return { exitCode: 0 };
      });
      boundary.execute.mockImplementation(async ({ operations }) => {
        await operations.executeCommand({ command: "fixture", onData: vi.fn() });
        return { content: [], isError: false };
      });
      await run({ ...input("bash"), executionMode: "background" });
      const written = boundary.process.stdout.write.mock.calls
        .map(([value]) => String(value))
        .join("");
      expect(written).toContain(text);
    },
  );
});

describe("[R2-P2] installed Pi coding program resident mode", () => {
  it("[R2-P2] enters resident mode and announces ready before reading any request", async () => {
    await runResident([]);
    expect(frames()).toEqual([{ type: "ready" }]);
    expect(boundary.process.env).toMatchObject({
      PI_OFFLINE: "1",
      PATH: "/runtime/pi-tools/bin",
      PI_CODING_AGENT_DIR: "/runtime/pi-tools",
    });
    expect(boundary.process.exitCode).toBeUndefined();
  });

  it("[R2-P2] serves consecutive requests with matching sequence numbers and chunked output", async () => {
    const large = "x".repeat(PI_RESIDENT_OUTPUT_CHUNK_BYTES + 10);
    boundary.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: large }],
      details: {},
      isError: false,
    });
    boundary.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: "second" }],
      details: {},
      isError: false,
    });
    await runResident([runFrame(1, input()), runFrame(2, input())]);
    const all = frames();
    expect(all[0]).toEqual({ type: "ready" });
    const firstOutputs = outputsFor(1);
    expect(firstOutputs.length).toBeGreaterThan(1);
    expect(firstOutputs.every((frame) => frame["channel"] === "stdout")).toBe(true);
    expect(
      firstOutputs.every(
        (frame) =>
          Buffer.from(String(frame["bytes"]), "base64").byteLength <=
          PI_RESIDENT_OUTPUT_CHUNK_BYTES,
      ),
    ).toBe(true);
    const firstBody = Buffer.concat(
      firstOutputs.map((frame) => Buffer.from(String(frame["bytes"]), "base64")),
    );
    expect(JSON.parse(firstBody.toString("utf8"))).toMatchObject({ tool: "read", isError: false });
    expect(all.filter((frame) => frame["seq"] === 1).at(-1)).toMatchObject({
      type: "result",
      seq: 1,
      exitCode: 0,
    });
    const secondOutputs = outputsFor(2);
    expect(secondOutputs).toHaveLength(1);
    expect(
      JSON.parse(Buffer.from(String(secondOutputs[0]?.["bytes"]), "base64").toString("utf8")),
    ).toMatchObject({ tool: "read" });
    expect(all.filter((frame) => frame["seq"] === 2).at(-1)).toMatchObject({
      type: "result",
      seq: 2,
      exitCode: 0,
    });
    expect(boundary.process.exitCode).toBeUndefined();
  });

  it.each([
    ["a skipped sequence", runFrame(2, input())],
    ["an extra key", `${JSON.stringify({ type: "run", seq: 1, inputBase64: "", extra: true })}\n`],
    ["malformed base64", `${JSON.stringify({ type: "run", seq: 1, inputBase64: "!!" })}\n`],
    ["a line over the frame limit", `${"x".repeat(PI_RESIDENT_FRAME_LIMIT_BYTES + 1)}\n`],
  ])("[R2-P2] ends the runner on %s without executing the request", async (_kind, line) => {
    await runResident([line]);
    failed();
    expect(boundary.execute).not.toHaveBeenCalled();
    expect(frames().some((frame) => frame["type"] === "result")).toBe(false);
  });

  it("[R2-P2] reports a failed request and keeps serving the next one", async () => {
    boundary.execute.mockRejectedValueOnce(new Error("boom"));
    boundary.execute.mockResolvedValueOnce({
      content: [{ type: "text", text: "second" }],
      details: {},
      isError: false,
    });
    await runResident([runFrame(1, input()), runFrame(2, input())]);
    const failure = Buffer.from("PI_RUNNER_EXECUTION_FAILED\n").toString("base64");
    expect(frames().filter((frame) => frame["seq"] === 1)).toEqual([
      { type: "output", seq: 1, channel: "stderr", bytes: failure },
      { type: "result", seq: 1, exitCode: 1 },
    ]);
    expect(
      frames()
        .filter((frame) => frame["seq"] === 2)
        .at(-1),
    ).toMatchObject({
      type: "result",
      seq: 2,
      exitCode: 0,
    });
    expect(boundary.process.exitCode).toBeUndefined();
  });

  it("[R2-P2] refuses a request whose runtime root differs from the launch argument", async () => {
    await runResident([runFrame(1, { ...input(), runtimeRoot: "/other" })]);
    expect(boundary.execute).not.toHaveBeenCalled();
    expect(frames().filter((frame) => frame["seq"] === 1)).toEqual([
      {
        type: "output",
        seq: 1,
        channel: "stderr",
        bytes: Buffer.from("PI_RUNNER_EXECUTION_FAILED\n").toString("base64"),
      },
      { type: "result", seq: 1, exitCode: 1 },
    ]);
    expect(boundary.process.exitCode).toBeUndefined();
    const { runPiCodingRequest } = await import("../src/capability-programs/pi-coding-request.ts");
    await expect(
      runPiCodingRequest(
        Buffer.from(JSON.stringify({ ...input(), runtimeRoot: "/other" })),
        { hostId: "host-program", workerInstanceId: "worker-program", runtimeRoot: "/runtime" },
        () => {},
      ),
    ).rejects.toThrow("PI_RUNNER_SCOPE_INVALID");
  });

  it.each([
    ["a relative resident runtime root", ["--resident", "runtime"]],
    ["an extra trailing argument", ["--resident", "/runtime", "extra"]],
  ])("[R2-P2] refuses %s before announcing ready", async (_kind, extra) => {
    boundary.process.argv = [
      "node",
      "pi-coding-main",
      "host-program",
      "worker-program",
      ...(extra as string[]),
    ];
    boundary.process.stdin = Readable.from([]);
    await import("../src/capability-programs/pi-coding-main.ts");
    failed();
    expect(frames()).toEqual([]);
  });
});
