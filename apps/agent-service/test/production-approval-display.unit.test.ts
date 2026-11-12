import { describe, expect, it } from "vitest";
import {
  createApprovalDisplayBuilder,
  toolApprovalBodyText,
} from "../src/production-approval-display.js";

describe("approval display facts", () => {
  it("takes the preview from the real tool arguments", () => {
    expect(toolApprovalBodyText("bash", { command: "npm test" })).toBe("npm test");
    expect(toolApprovalBodyText("write", { path: "a.txt", content: "你好" })).toBe("你好");
    expect(toolApprovalBodyText("web_search", { query: "新干线 时刻" })).toBe("新干线 时刻");
    expect(toolApprovalBodyText("web_fetch", { url: "https://example.com/a" })).toBe(
      "https://example.com/a",
    );
    expect(
      toolApprovalBodyText("edit", { path: "a", edits: [{ oldText: "x", newText: "y" }] }),
    ).toBe("- x\n+ y");
    expect(toolApprovalBodyText("move_directory", { path: "a", destination: "b" })).toBe("a → b");
    expect(toolApprovalBodyText("read", { path: "notes/a.md" })).toBe("notes/a.md");
  });

  it("gives no preview when the arguments carry nothing to show", () => {
    expect(toolApprovalBodyText("bash", {})).toBeNull();
    expect(toolApprovalBodyText("bash", { command: "   " })).toBeNull();
    expect(toolApprovalBodyText("write", { content: 5 })).toBeNull();
    expect(toolApprovalBodyText("save_copy", { operationId: "x" })).toBeNull();
  });

  it("masks secrets and cuts the preview at the configured length", async () => {
    const build = createApprovalDisplayBuilder({
      maximumCharacters: 20,
      threadTitle: async () => "周五去大阪",
    });
    const shown = await build({
      threadId: "thread-1",
      tool: "bash",
      arguments: { command: `echo 4111 1111 1111 1111 ${"x".repeat(100)}` },
    })();
    expect(shown.bodyPreview).not.toContain("4111 1111 1111 1111");
    expect([...(shown.bodyPreview ?? "")].length).toBeLessThanOrEqual(21);
    expect(shown.origin).toEqual({ threadId: "thread-1", threadTitle: "周五去大阪" });
    expect(shown.displayTitle).toBeNull();
  });

  it("never invents a title and keeps the preview when the thread title cannot be read", async () => {
    const build = createApprovalDisplayBuilder({
      threadTitle: async () => {
        throw new Error("payload unavailable");
      },
    });
    const shown = await build({
      threadId: "thread-2",
      tool: "bash",
      arguments: { command: "ls" },
    })();
    expect(shown).toEqual({
      displayTitle: null,
      bodyPreview: "ls",
      origin: { threadId: "thread-2", threadTitle: null },
    });
  });
});
