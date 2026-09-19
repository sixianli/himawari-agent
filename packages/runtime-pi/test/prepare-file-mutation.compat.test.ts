import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { preparePiFileMutation } from "../src/prepare-file-mutation.js";

it("uses Pi edit normalization and preserves BOM/CRLF without changing the shared file", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-prepare-"));
  try {
    const targetPath = path.join(cwd, "note.txt");
    const original = "\uFEFFone\r\ntwo\r\n";
    await writeFile(targetPath, original);
    const prepared = await preparePiFileMutation({
      limits: { maxWallTimeMs: 10000, maxCpuTimeMs: 10000, maxMemoryBytes: 268435456 },
      tool: "edit",
      toolCallId: "edit",
      cwd,
      targetPath,
      before: Buffer.from(original),
      parameters: { path: "note.txt", oldText: "two", newText: "三" },
    });
    expect(Buffer.from(prepared.bytes).toString()).toBe("\uFEFFone\r\n三\r\n");
    expect(prepared.result.isError).toBe(false);
    expect(prepared.result.details).toMatchObject({ diff: expect.stringContaining("三") });
    expect(await readFile(targetPath, "utf8")).toBe(original);
    await expect(
      preparePiFileMutation({
        limits: { maxWallTimeMs: 10000, maxCpuTimeMs: 10000, maxMemoryBytes: 268435456 },
        tool: "write",
        toolCallId: "escape",
        cwd,
        targetPath,
        before: null,
        parameters: { path: "../other", content: "escape" },
      }),
    ).rejects.toThrow("PI_FIXED_TARGET_CHANGED");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("rejects ambiguous edits and cancelled preparation without producing a candidate", async () => {
  const input = {
    limits: { maxWallTimeMs: 10000, maxCpuTimeMs: 10000, maxMemoryBytes: 268435456 },
    tool: "edit" as const,
    toolCallId: "edit",
    cwd: "/fixture",
    targetPath: "/fixture/note.txt",
    before: Buffer.from("same same"),
    parameters: { path: "note.txt", edits: [{ oldText: "same", newText: "changed" }] },
  };
  await expect(preparePiFileMutation(input)).rejects.toThrow();
  await expect(preparePiFileMutation({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
});

it("rejects invalid preparation budgets without starting work", async () => {
  const input = {
    tool: "write" as const,
    toolCallId: "budget",
    cwd: "/fixture",
    targetPath: "/fixture/note.txt",
    before: null,
    parameters: { path: "note.txt", content: "candidate" },
    limits: { maxWallTimeMs: 10000, maxCpuTimeMs: 10000, maxMemoryBytes: 268435456 },
  };
  await expect(
    preparePiFileMutation({ ...input, limits: { ...input.limits, maxWallTimeMs: 0 } }),
  ).rejects.toThrow("PI_PREPARATION_TIME_LIMIT");
  await expect(
    preparePiFileMutation({ ...input, limits: { ...input.limits, maxMemoryBytes: 1048576 } }),
  ).rejects.toThrow("PI_PREPARATION_MEMORY_LIMIT");
});
