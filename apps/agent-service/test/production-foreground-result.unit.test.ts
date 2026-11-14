import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PI_RUNNER_CONTRACT, PI_WRITE_VERIFIER } from "@himawari-agent/execution-contracts";
import { formatForegroundPiResult, verifyPiWriteEvidence } from "@himawari-agent/platform-node";
import { executeSandboxedPiCodingTool, fitPiResultOutput } from "@himawari-agent/runtime-pi";
import { afterEach, describe, expect, it } from "vitest";
import { failedCommandModelContent } from "../src/production-sandbox-tool-result.js";
import { toolResultSentToModel } from "./fixtures/model-egress.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "r2t9-fg-")));
  roots.push(directory);
  return directory;
}

function publication(
  privateDirectory: string,
  content: string,
  details: Record<string, unknown>,
  maxOutputBytes: number,
): Parameters<typeof formatForegroundPiResult>[0] {
  return {
    tool: "bash",
    result: { content: [{ type: "text", text: content }], details, isError: false },
    commandExitCode: 0,
    verifiedWrite: null,
    privateDirectory,
    maxOutputBytes,
    fitOutput: fitPiResultOutput,
    closing: {},
    source: {
      workspace: "/workspace",
      toolCallId: "r2t9-bash",
      directoryGrantRef: "grant",
      directoryGrantRevision: 1,
      parameters: { command: "big" },
    },
  };
}

describe("[R2-T9] foreground Pi result over the limit", () => {
  it("[R2-T9] drops a full output that no longer fits and keeps the tail", async () => {
    const directory = await privateDirectory();
    const file = path.join(directory, "pi-bash-0123456789abcdef.log");
    await writeFile(file, "h".repeat(200 * 1024), { mode: 0o600 });
    const text = `command tail\n\n[Showing lines 4001-6000 of 6000 (50.0KB limit). Full output: ${file}]`;
    const { output, exitCode } = await formatForegroundPiResult(
      publication(directory, text, { fullOutputPath: file }, 48 * 1024),
    );
    const parsed = JSON.parse(output) as {
      isError: boolean;
      fullOutput: unknown;
      content: { text: string }[];
    };
    expect(exitCode).toBe(0);
    expect(parsed.isError).toBe(false);
    expect(parsed.fullOutput).toBeNull();
    expect(parsed.content[0]?.text).not.toContain(file);
    expect(parsed.content[0]?.text).toContain("完整输出超过上限，未保留");
    expect(Buffer.byteLength(output, "utf-8")).toBeLessThanOrEqual(48 * 1024);
  });

  it("[R2-T9] keeps a full output that still fits", async () => {
    const directory = await privateDirectory();
    const file = path.join(directory, "pi-bash-0123456789abcdef.log");
    await writeFile(file, "small output\n", { mode: 0o600 });
    const text = `tail\n\n[Showing lines 1-2 of 3. Full output: ${file}]`;
    const { output } = await formatForegroundPiResult(
      publication(directory, text, { fullOutputPath: file }, 48 * 1024),
    );
    const parsed = JSON.parse(output) as { fullOutput: unknown; content: { text: string }[] };
    expect(parsed.fullOutput).toMatchObject({ encoding: "base64" });
    expect(parsed.content[0]?.text).toContain("本次受保护结果的 fullOutput 字段");
  });

  it("[R2-T9] leaves an under-threshold command output without a full output file untouched", async () => {
    const directory = await privateDirectory();
    const text = Array.from({ length: 1000 }, (_, index) =>
      `第${index + 1}行`.padEnd(32, "x"),
    ).join("\n");
    const { output } = await formatForegroundPiResult(publication(directory, text, {}, 48 * 1024));
    const parsed = JSON.parse(output) as { fullOutput: unknown; content: { text: string }[] };
    expect(parsed.fullOutput).toBeNull();
    expect(parsed.content[0]?.text).toBe(text);
    expect(parsed.content[0]?.text).not.toContain("limit reached");
  });
});

function shownText(output: string): string | undefined {
  return (JSON.parse(output) as { content: { text: string }[] }).content[0]?.text;
}

function decodedFullOutput(output: string): Buffer {
  const { fullOutput } = JSON.parse(output) as { fullOutput: { data: string } };
  return Buffer.from(fullOutput.data, "base64");
}

const SECRET_OUTPUT = "api_key=R2T14SECRETVALUE0001\n";

describe("[R2-T14] command output that contains machine secrets", () => {
  it.each([
    [false, 0, 0],
    [true, 2, 2],
    [true, null, 1],
  ] as const)(
    "returns the output and the real command status, and egress masks the secret (error %s, exit %s)",
    async (isError, commandExitCode, processExitCode) => {
      const directory = await privateDirectory();
      const input = publication(directory, SECRET_OUTPUT, {}, 48 * 1024);
      const { output, exitCode } = await formatForegroundPiResult({
        ...input,
        result: { ...input.result, isError },
        commandExitCode,
      });
      expect(exitCode).toBe(processExitCode);
      expect(JSON.parse(output)).toMatchObject({
        schemaVersion: "pi-result.v1",
        tool: "bash",
        content: [{ type: "text", text: SECRET_OUTPUT }],
        fullOutput: null,
        isError,
        commandExitCode,
        source: { parameters: { command: "big" } },
      });
      const sent = await toolResultSentToModel(output);
      expect(sent).not.toContain("R2T14SECRETVALUE0001");
      expect(sent).toContain("[密钥]");
    },
  );

  it("keeps a command whose own text carries a machine secret, and egress masks it", async () => {
    const directory = await privateDirectory();
    const command = "curl -H 'Authorization: Bearer R2T14BEARERVALUE0001' x";
    const input = publication(directory, "ok\n", {}, 48 * 1024);
    const { output, exitCode } = await formatForegroundPiResult({
      ...input,
      source: { ...input.source, parameters: { command } },
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ source: { parameters: { command } } });
    expect(await toolResultSentToModel(output)).not.toContain("R2T14BEARERVALUE0001");
  });

  it("returns machine secrets from tools other than bash too", async () => {
    const directory = await privateDirectory();
    const input = publication(directory, SECRET_OUTPUT, {}, 48 * 1024);
    const { output } = await formatForegroundPiResult({ ...input, tool: "read" });
    expect(shownText(output)).toBe(SECRET_OUTPUT);
    expect(await toolResultSentToModel(output)).not.toContain("R2T14SECRETVALUE0001");
  });
});

const keyMarker = (edge: "BEGIN" | "END") => [`-----${edge}`, "PRIVATE KEY-----"].join(" ");
const keyBody = Array.from(
  { length: 26 },
  (_, index) => `MIIEvR2T14KEYBODY${String(index).padStart(2, "0")}${"Qk".repeat(28)}`,
);
const fullKey = [keyMarker("BEGIN"), ...keyBody, keyMarker("END")].join("\n");

async function expectKeyMasked(output: string) {
  const sent = await toolResultSentToModel(output);
  expect(sent).not.toContain("R2T14KEYBODY");
  expect(sent).toContain("[密钥]");
}

describe("[R2-T14] command output that carries part of a private key", () => {
  it("returns the kept tail when truncation cut off the key's first line, and egress masks it", async () => {
    const directory = await privateDirectory();
    const file = path.join(directory, "pi-bash-0123456789abcdef.log");
    const filler = Array.from({ length: 4000 }, (_, index) => `line ${index} ${"f".repeat(40)}`);
    await writeFile(file, [...filler, fullKey, "after"].join("\n"), { mode: 0o600 });
    const tail = [...keyBody.slice(10), keyMarker("END"), "after"].join("\n");
    const input = publication(
      directory,
      `${tail}\n\n[Showing lines 3990-4029 of 4029 (50.0KB limit). Full output: ${file}]`,
      { fullOutputPath: file, truncation: { truncated: true, truncatedBy: "bytes" } },
      48 * 1024,
    );
    const { output, exitCode } = await formatForegroundPiResult({
      ...input,
      result: { ...input.result, isError: true },
      commandExitCode: 1,
    });
    expect(exitCode).toBe(1);
    expect(shownText(output)).toContain(keyBody[10]);
    await expectKeyMasked(output);
  });

  it("returns output that shows only the key's first line and body, and egress masks it", async () => {
    const directory = await privateDirectory();
    const head = [keyMarker("BEGIN"), ...keyBody.slice(0, 4)].join("\n");
    const { output, exitCode } = await formatForegroundPiResult(
      publication(directory, `${head}\n`, {}, 48 * 1024),
    );
    expect(exitCode).toBe(0);
    expect(shownText(output)).toBe(`${head}\n`);
    await expectKeyMasked(output);
  });

  it("masks the full output file before encoding it, and records the masked bytes", async () => {
    const directory = await privateDirectory();
    const file = path.join(directory, "pi-bash-0123456789abcdef.log");
    await writeFile(file, `${fullKey}\nclean tail\n`, { mode: 0o600 });
    const { output, exitCode } = await formatForegroundPiResult(
      publication(
        directory,
        `clean tail\n\n[Showing lines 28-29 of 29. Full output: ${file}]`,
        { fullOutputPath: file },
        48 * 1024,
      ),
    );
    expect(exitCode).toBe(0);
    const decoded = decodedFullOutput(output);
    expect(decoded.toString()).toBe("[密钥]\nclean tail\n");
    expect(JSON.parse(output)).toMatchObject({
      fullOutput: {
        encoding: "base64",
        redacted: true,
        byteLength: decoded.length,
        digest: createHash("sha256").update(decoded).digest("hex"),
      },
    });
  });

  it("masks a full output file that holds only the key's first line and body", async () => {
    const directory = await privateDirectory();
    const file = path.join(directory, "pi-bash-0123456789abcdef.log");
    await writeFile(file, `${[keyMarker("BEGIN"), ...keyBody.slice(0, 4)].join("\n")}\nclean\n`, {
      mode: 0o600,
    });
    const { output } = await formatForegroundPiResult(
      publication(
        directory,
        `clean\n\n[Showing lines 6-6 of 6. Full output: ${file}]`,
        { fullOutputPath: file },
        48 * 1024,
      ),
    );
    expect(decodedFullOutput(output).toString()).not.toContain("R2T14KEYBODY");
  });

  it("leaves a clean full output file as it is", async () => {
    const directory = await privateDirectory();
    const file = path.join(directory, "pi-bash-0123456789abcdef.log");
    await writeFile(file, "clean\n", { mode: 0o600 });
    const { output } = await formatForegroundPiResult(
      publication(
        directory,
        `clean\n\n[Showing lines 1-1 of 1. Full output: ${file}]`,
        { fullOutputPath: file },
        48 * 1024,
      ),
    );
    expect(decodedFullOutput(output).toString()).toBe("clean\n");
    expect((JSON.parse(output) as { fullOutput: object }).fullOutput).not.toHaveProperty(
      "redacted",
    );
  });

  it("returns part of a private key from tools other than bash, and egress masks it", async () => {
    const directory = await privateDirectory();
    const input = publication(
      directory,
      [...keyBody.slice(20), keyMarker("END")].join("\n"),
      {},
      48 * 1024,
    );
    const { output } = await formatForegroundPiResult({ ...input, tool: "grep" });
    await expectKeyMasked(output);
  });

  it("keeps ordinary output that only names private keys", async () => {
    const directory = await privateDirectory();
    const text = "docs/keys.md: rotate the PRIVATE KEY yearly\n";
    const { output } = await formatForegroundPiResult(publication(directory, text, {}, 48 * 1024));
    expect(shownText(output)).toBe(text);
    expect(await toolResultSentToModel(output)).toContain("rotate the PRIVATE KEY yearly");
  });

  it("keeps the clean output of a command whose own text shows a key's first line", async () => {
    const directory = await privateDirectory();
    const command = `grep -rn -- '${keyMarker("BEGIN")}' .`;
    const input = publication(directory, "(no output)", {}, 48 * 1024);
    const { output, exitCode } = await formatForegroundPiResult({
      ...input,
      result: { ...input.result, isError: true },
      commandExitCode: 1,
      source: { ...input.source, parameters: { command } },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      tool: "bash",
      content: [{ type: "text", text: "(no output)" }],
      isError: true,
      commandExitCode: 1,
      source: { parameters: { command } },
    });
    expect(await toolResultSentToModel(output)).toContain(keyMarker("BEGIN"));
  });

  it("returns the result of a write whose own content shows part of a key", async () => {
    const directory = await privateDirectory();
    const content = [keyMarker("BEGIN"), ...keyBody.slice(0, 2), ""].join("\n");
    const input = publication(directory, "Successfully wrote 160 bytes to pem.md", {}, 48 * 1024);
    const { output, exitCode } = await formatForegroundPiResult({
      ...input,
      tool: "write",
      commandExitCode: null,
      source: { ...input.source, parameters: { path: "pem.md", content } },
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      tool: "write",
      content: [{ type: "text", text: "Successfully wrote 160 bytes to pem.md" }],
      isError: false,
      source: { parameters: { path: "pem.md", content } },
    });
    await expectKeyMasked(output);
  });
});

describe("[R2-T14] file tool result that carries part of a private key", () => {
  const editParameters = {
    path: "key-notes.txt",
    edits: [{ oldText: "deploy key:", newText: "old deploy key:" }],
  };
  const keyDiff = [
    "-1 deploy key:",
    "+1 old deploy key:",
    ` 2 ${keyMarker("BEGIN")}`,
    ...keyBody.slice(0, 3).map((line, index) => ` ${index + 3} ${line}`),
  ].join("\n");
  const editInput = (directory: string): Parameters<typeof formatForegroundPiResult>[0] => {
    const input = publication(
      directory,
      "Successfully replaced text in key-notes.txt.",
      {},
      48 * 1024,
    );
    return {
      ...input,
      tool: "edit",
      result: { ...input.result, details: { diff: keyDiff, firstChangedLine: 1 } },
      commandExitCode: null,
      verifiedWrite: {
        path: "/workspace/key-notes.txt",
        contentDigest: "a".repeat(64),
        byteLength: 300,
      },
      source: { ...input.source, toolCallId: "r2t14-edit", parameters: editParameters },
    };
  };
  const editPlan = {
    operation: "edit",
    identity: { toolCallId: "r2t14-edit" },
    operationContract: {
      ...PI_RUNNER_CONTRACT,
      kind: "verified_effect" as const,
      verifierRef: PI_WRITE_VERIFIER.ref,
      verifierVersion: PI_WRITE_VERIFIER.version,
      targetRef: PI_WRITE_VERIFIER.targetRef,
    },
  };
  const verifyEdit = (output: string) =>
    verifyPiWriteEvidence({
      bytes: Buffer.from(output),
      parameters: editParameters,
      plan: editPlan,
      scope: { directoryGrant: { ref: "grant", revision: 1 } },
      workspace: "/workspace",
    });

  it("returns the diff of a verified edit with its write proof, and egress masks the key", async () => {
    const directory = await privateDirectory();
    const { output, exitCode } = await formatForegroundPiResult(editInput(directory));
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      tool: "edit",
      content: [{ type: "text", text: "Successfully replaced text in key-notes.txt." }],
      details: { diff: keyDiff },
      isError: false,
      verifiedWrite: { path: "/workspace/key-notes.txt" },
      source: { toolCallId: "r2t14-edit", parameters: editParameters },
    });
    expect(verifyEdit(output)).toBe("published");
    await expectKeyMasked(output);
  });

  it("returns the error of an edit that failed before writing, and egress masks the key", async () => {
    const directory = await privateDirectory();
    const input = editInput(directory);
    const { output, exitCode } = await formatForegroundPiResult({
      ...input,
      result: {
        content: [{ type: "text", text: `Could not find the exact text near:\n${keyDiff}` }],
        details: {},
        isError: true,
      },
      verifiedWrite: null,
      closing: { writeNotStarted: true },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      tool: "edit",
      isError: true,
      verifiedWrite: null,
      writeNotStarted: true,
    });
    expect(verifyEdit(output)).toBe("not_written");
    await expectKeyMasked(output);
  });

  it("returns an edit whose own parameters carry a machine secret, and egress masks it", async () => {
    const directory = await privateDirectory();
    const input = editInput(directory);
    const { output } = await formatForegroundPiResult({
      ...input,
      source: {
        ...input.source,
        parameters: {
          path: "key-notes.txt",
          edits: [{ oldText: "deploy key:", newText: "api_key=R2T14SECRETVALUE0001" }],
        },
      },
    });
    expect(await toolResultSentToModel(output)).not.toContain("R2T14SECRETVALUE0001");
  });
});

describe("a real shell command that exits nonzero", () => {
  async function runBash(command: string) {
    const workspace = await privateDirectory();
    let commandExitCode: number | null = null;
    const result = await executeSandboxedPiCodingTool({
      name: "bash",
      toolCallId: "nonzero-bash",
      cwd: workspace,
      parameters: { command },
      operations: {
        access: async () => undefined,
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => undefined,
        makeDirectory: async () => undefined,
        executeCommand: ({ command: line, cwd, onData }) =>
          new Promise((resolve, reject) => {
            const child = spawn("bash", ["-c", line], { cwd, stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", (chunk: Buffer) => onData(chunk));
            child.stderr.on("data", (chunk: Buffer) => onData(chunk));
            child.on("error", reject);
            child.on("close", (code) => {
              commandExitCode = code;
              resolve({ exitCode: code });
            });
          }),
      },
    });
    const formatted = await formatForegroundPiResult({
      tool: "bash",
      result,
      commandExitCode,
      verifiedWrite: null,
      privateDirectory: await privateDirectory(),
      maxOutputBytes: 64 * 1024,
      fitOutput: fitPiResultOutput,
      closing: {},
      source: {
        workspace,
        toolCallId: "nonzero-bash",
        directoryGrantRef: "grant",
        directoryGrantRevision: 1,
        parameters: { command },
      },
    });
    return { result, formatted };
  }

  it("leaves the runner with the command's exit code and tells the model the command failed", async () => {
    const { result, formatted } = await runBash("echo 'not ok 4 - rounds totals'; exit 3");
    expect(result.isError).toBe(true);
    expect(formatted.exitCode).toBe(3);
    const notice = failedCommandModelContent(formatted.output, {
      operation: "bash",
      processExitCode: 3,
    });
    expect(notice).toContain("命令执行失败：命令以退出码 3 结束");
    expect(notice).toContain("not ok 4 - rounds totals");
  });

  it("keeps a successful command at exit code 0 without a failure notice", async () => {
    const { result, formatted } = await runBash("echo ok");
    expect(result.isError).toBe(false);
    expect(formatted.exitCode).toBe(0);
    expect(
      failedCommandModelContent(formatted.output, { operation: "bash", processExitCode: 0 }),
    ).toBeNull();
  });
});
