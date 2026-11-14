import { APPROVAL_DISPLAY_BODY_MAX_CHARACTERS } from "@himawari-agent/gateway-contracts";
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
    expect(
      toolApprovalBodyText("send_email", { to: "tanaka@example.com", body: "周五见", path: "x" }),
    ).toBeNull();
    expect(toolApprovalBodyText("unknown_tool", { command: "ls", query: "q" })).toBeNull();
  });

  it("masks a secret that straddles the cut instead of leaving its start in the preview", async () => {
    const build = createApprovalDisplayBuilder({
      maximumCharacters: 60,
      threadTitle: async () => "周五去大阪",
    });
    const shown = await build({
      threadId: "thread-1",
      tool: "bash",
      arguments: { command: `${"x".repeat(52)} 4111 1111 1111 1111 ${"y".repeat(100)}` },
    })();
    expect(shown.bodyPreview).not.toContain("4111");
    expect([...(shown.bodyPreview ?? "")].length).toBeLessThanOrEqual(61);
    expect(shown.origin).toEqual({ threadId: "thread-1", threadTitle: "周五去大阪" });
    expect(shown.displayTitle).toBeNull();
  });

  it("replaces bidirectional formatting characters that could reorder what the owner reads", async () => {
    const build = createApprovalDisplayBuilder({});
    const shown = await build({
      threadId: "thread-1",
      tool: "bash",
      arguments: { command: "rm \u202Efdp.txt\u2066 \u200f done" },
    })();
    expect(shown.bodyPreview).toBe("rm \uFFFDfdp.txt\uFFFD \uFFFD done");
  });

  it("replaces control characters the gateway contract refuses and keeps tab and newline", async () => {
    const build = createApprovalDisplayBuilder({ threadTitle: async () => "a\u0007b" });
    const shown = await build({
      threadId: "thread-1",
      tool: "bash",
      arguments: { command: "echo \u001b[31mred\u0000\u007f\ttab\nline" },
    })();
    expect(shown.bodyPreview).toBe("echo \uFFFD[31mred\uFFFD\uFFFD\ttab\nline");
    expect(shown.origin?.threadTitle).toBe("a\uFFFDb");
  });

  it("never exceeds the configured ceiling even when asked for more", async () => {
    const build = createApprovalDisplayBuilder({ maximumCharacters: 5000 });
    const shown = await build({
      threadId: "thread-1",
      tool: "bash",
      arguments: { command: "y".repeat(5000) },
    })();
    expect([...(shown.bodyPreview ?? "")].length).toBe(2001);
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

  it("produces the longest preview and title the gateway contract accepts, and no longer", async () => {
    const build = createApprovalDisplayBuilder({
      maximumCharacters: 100_000,
      threadTitle: async () => "题".repeat(5000),
    });
    const shown = await build({
      threadId: "thread-1",
      tool: "bash",
      arguments: { command: "x".repeat(50_000) },
    })();
    expect([...(shown.bodyPreview ?? "")]).toHaveLength(APPROVAL_DISPLAY_BODY_MAX_CHARACTERS);
    expect([...(shown.origin?.threadTitle ?? "")]).toHaveLength(121);
  });
});
