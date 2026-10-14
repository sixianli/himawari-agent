import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatForegroundPiResult } from "@himawari-agent/platform-node";
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
