import { describe, expect, it, vi } from "vitest";
import type { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGovernedPiCodingTools } from "../src/index.js";

describe("createGovernedPiCodingTools", () => {
  it("keeps Pi's built-in read tool while delegating I/O to governed operations", async () => {
    const access = vi.fn(async () => undefined);
    const readFile = vi.fn(async () => Buffer.from("governed content"));
    const [tool] = createGovernedPiCodingTools({
      cwd: "/workspace",
      enabled: ["read"],
      operations: { read: { access, readFile } },
    });
    if (!tool) throw new Error("missing read tool");

    const readTool = tool as ReturnType<typeof createReadToolDefinition>;
    const result = await readTool.execute(
      "tool-call-read",
      { path: "note.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(readTool.name).toBe("read");
    expect(access).toHaveBeenCalledWith("/workspace/note.txt");
    expect(readFile).toHaveBeenCalledWith("/workspace/note.txt");
    expect(result.content).toEqual([{ type: "text", text: "governed content" }]);
  });

  it("fails closed instead of falling back to Pi's local host operations", () => {
    expect(() =>
      createGovernedPiCodingTools({ cwd: "/workspace", enabled: ["write"], operations: {} }),
    ).toThrow("PI_GOVERNED_OPERATIONS_REQUIRED:write");
  });
});
