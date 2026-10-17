import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PI_RUNNER_CONTRACT, PI_WRITE_VERIFIER } from "@himawari-agent/execution-contracts";
import { formatForegroundPiResult, verifyPiWriteEvidence } from "@himawari-agent/platform-node";
import { fitPiResultOutput } from "@himawari-agent/runtime-pi";
import { afterEach, describe, expect, it } from "vitest";

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

describe("[R2-T14] command output that contains machine secrets", () => {
  it.each([
    [false, 0, 0],
    [true, 2, 2],
    [true, null, 1],
  ] as const)(
    "withholds the output but keeps the real command status (error %s, exit %s)",
    async (isError, commandExitCode, processExitCode) => {
      const directory = await privateDirectory();
      const input = publication(directory, "api_key=R2T14SECRETVALUE0001\n", {}, 48 * 1024);
      const { output, exitCode } = await formatForegroundPiResult({
        ...input,
        result: { ...input.result, isError },
        commandExitCode,
      });
      expect(exitCode).toBe(processExitCode);
      expect(output).not.toContain("R2T14SECRETVALUE0001");
      expect(output).not.toContain("api_key=");
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        schemaVersion: "pi-result.v1",
        tool: "bash",
        details: {},
        fullOutput: null,
        isError,
        commandExitCode,
      });
      expect(parsed["content"]).toEqual([
        { type: "text", text: expect.stringContaining("疑似密钥") },
      ]);
      expect(parsed["source"]).toEqual({
        workspace: "/workspace",
        toolCallId: "r2t9-bash",
        directoryGrantRef: "grant",
        directoryGrantRevision: 1,
      });
    },
  );

  it("withholds a command whose own text carries a machine secret", async () => {
    const directory = await privateDirectory();
    const input = publication(directory, "ok\n", {}, 48 * 1024);
    const { output, exitCode } = await formatForegroundPiResult({
      ...input,
      source: {
        ...input.source,
        parameters: { command: "curl -H 'Authorization: Bearer R2T14BEARERVALUE0001' x" },
      },
    });
    expect(exitCode).toBe(0);
    expect(output).not.toContain("R2T14BEARERVALUE0001");
    expect(output).toContain("疑似密钥");
  });

  it("still refuses machine secrets from tools other than bash", async () => {
    const directory = await privateDirectory();
    const input = publication(directory, "api_key=R2T14SECRETVALUE0001\n", {}, 48 * 1024);
    await expect(formatForegroundPiResult({ ...input, tool: "read" })).rejects.toThrow(
      "PI_RESULT_SECRET_REJECTED",
    );
  });
});

const keyMarker = (edge: "BEGIN" | "END") => [`-----${edge}`, "PRIVATE KEY-----"].join(" ");
const keyBody = Array.from(
  { length: 26 },
  (_, index) => `MIIEvR2T14KEYBODY${String(index).padStart(2, "0")}${"Qk".repeat(28)}`,
);
const fullKey = [keyMarker("BEGIN"), ...keyBody, keyMarker("END")].join("\n");

function expectWithheld(output: string, isError: boolean, commandExitCode: number | null) {
  expect(output).not.toContain("R2T14KEYBODY");
  expect(output).not.toContain("PRIVATE KEY");
  expect(JSON.parse(output)).toMatchObject({
    tool: "bash",
    content: [{ type: "text", text: expect.stringContaining("疑似密钥") }],
    details: {},
    fullOutput: null,
    isError,
    commandExitCode,
  });
}

describe("[R2-T14] command output that carries part of a private key", () => {
  it("withholds the kept tail when truncation cut off the key's first line", async () => {
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
    expectWithheld(output, true, 1);
  });

  it("withholds output that shows only the key's first line and body", async () => {
    const directory = await privateDirectory();
    const head = [keyMarker("BEGIN"), ...keyBody.slice(0, 4)].join("\n");
    const { output, exitCode } = await formatForegroundPiResult(
      publication(directory, `${head}\n`, {}, 48 * 1024),
    );
    expect(exitCode).toBe(0);
    expectWithheld(output, false, 0);
  });

  it("withholds instead of failing when only the full output file holds the key", async () => {
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
    expectWithheld(output, false, 0);
  });

  it("withholds when the full output file holds only the key's first line and body", async () => {
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
    expectWithheld(output, false, 0);
  });

  it("still refuses part of a private key from tools other than bash", async () => {
    const directory = await privateDirectory();
    const input = publication(
      directory,
      [...keyBody.slice(20), keyMarker("END")].join("\n"),
      {},
      48 * 1024,
    );
    await expect(formatForegroundPiResult({ ...input, tool: "grep" })).rejects.toThrow(
      "PI_RESULT_SECRET_REJECTED",
    );
  });

  it("keeps ordinary output that only names private keys", async () => {
    const directory = await privateDirectory();
    const text = "docs/keys.md: rotate the PRIVATE KEY yearly\n";
    const { output } = await formatForegroundPiResult(publication(directory, text, {}, 48 * 1024));
    expect((JSON.parse(output) as { content: { text: string }[] }).content[0]?.text).toBe(text);
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

  it("withholds the diff of a verified edit but keeps its write proof and parameters", async () => {
    const directory = await privateDirectory();
    const { output, exitCode } = await formatForegroundPiResult(editInput(directory));
    expect(exitCode).toBe(0);
    expect(output).not.toContain("R2T14KEYBODY");
    expect(output).not.toContain("PRIVATE KEY");
    expect(JSON.parse(output)).toMatchObject({
      tool: "edit",
      content: [{ type: "text", text: expect.stringMatching(/已修改.*疑似密钥/) }],
      details: {},
      isError: false,
      verifiedWrite: { path: "/workspace/key-notes.txt" },
      source: { toolCallId: "r2t14-edit", parameters: editParameters },
    });
    expect(verifyEdit(output)).toBe("published");
  });

  it("withholds the error of an edit that failed before writing and keeps that claim", async () => {
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
    expect(output).not.toContain("R2T14KEYBODY");
    expect(output).not.toContain("PRIVATE KEY");
    expect(JSON.parse(output)).toMatchObject({
      tool: "edit",
      content: [{ type: "text", text: expect.stringMatching(/没有被修改.*疑似密钥/) }],
      details: {},
      isError: true,
      verifiedWrite: null,
      writeNotStarted: true,
    });
    expect(verifyEdit(output)).toBe("not_written");
  });

  it("still refuses an edit whose own parameters carry a machine secret", async () => {
    const directory = await privateDirectory();
    const input = editInput(directory);
    await expect(
      formatForegroundPiResult({
        ...input,
        source: {
          ...input.source,
          parameters: {
            path: "key-notes.txt",
            edits: [{ oldText: "deploy key:", newText: "api_key=R2T14SECRETVALUE0001" }],
          },
        },
      }),
    ).rejects.toThrow("PI_RESULT_SECRET_REJECTED");
  });
});
