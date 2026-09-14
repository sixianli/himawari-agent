import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { executeSandboxedPiCodingTool } from "../src/sandboxed-coding-executor.js";

it("reports the UTF-8 byte length of an actual governed write", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "himawari-write-bytes-"));
  try {
    const result = await executeSandboxedPiCodingTool({
      name: "write",
      toolCallId: "fixture:write",
      cwd,
      parameters: { path: "note.txt", content: "青柠灯塔72" },
      operations: {
        access: async (path) => access(path),
        readFile: async (path) => readFile(path),
        writeFile: async (path, content) => writeFile(path, content),
        makeDirectory: async (path) => {
          await mkdir(path, { recursive: true });
        },
        executeCommand: async () => {
          throw new Error("UNEXPECTED_COMMAND");
        },
      },
    });
    expect((await readFile(join(cwd, "note.txt"))).byteLength).toBe(14);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "Successfully wrote 14 bytes to note.txt" },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
