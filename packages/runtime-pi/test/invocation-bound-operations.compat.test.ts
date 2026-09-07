import type { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createGovernedPiCodingTools,
  createPiOperationsFromGovernedHostPort,
} from "../src/index.js";

describe("per-invocation Pi Operations", () => {
  it("keeps concurrent calls bound to separate trusted closures", async () => {
    const writes: string[] = [];
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bind = vi.fn(async ({ toolCallId }: { toolCallId: string }) => {
      if (toolCallId === "call-a") await pending;
      return {
        write: {
          mkdir: async () => undefined,
          writeFile: async (path: string, text: string) => {
            writes.push(`${toolCallId}:${path}:${text}`);
          },
        },
      };
    });
    const options = {
      cwd: "/workspace",
      enabled: ["write"] as const,
      operationsForCall: bind,
    };
    const [definition] = createGovernedPiCodingTools(options);
    const tool = definition as ReturnType<typeof createWriteToolDefinition>;
    const a = tool.execute(
      "call-a",
      { path: "a.txt", content: "a" },
      undefined,
      undefined,
      {} as never,
    );
    options.cwd = "/changed-after-registration";
    await tool.execute(
      "call-b",
      { path: "b.txt", content: "b" },
      undefined,
      undefined,
      {} as never,
    );
    release();
    await a;
    expect(writes).toEqual(["call-b:/workspace/b.txt:b", "call-a:/workspace/a.txt:a"]);
    expect(bind).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(bind.mock.calls[0]?.[0])).toBe(true);
  });

  it("rebinds a resumed call and propagates revoked authority without fallback I/O", async () => {
    const writeFile = vi.fn(async () => undefined);
    let allowed = true;
    const [definition] = createGovernedPiCodingTools({
      cwd: "/workspace",
      enabled: ["write"],
      operationsForCall: () => {
        if (!allowed) throw new Error("AUTHORITY_REVOKED");
        return { write: { mkdir: async () => undefined, writeFile } };
      },
    });
    const tool = definition as ReturnType<typeof createWriteToolDefinition>;
    const invoke = () =>
      tool.execute("same-call", { path: "a.txt", content: "a" }, undefined, undefined, {} as never);
    await invoke();
    allowed = false;
    await expect(invoke()).rejects.toThrow("AUTHORITY_REVOKED");
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("checks cancellation after asynchronous binding and before Pi executes", async () => {
    const controller = new AbortController();
    const writeFile = vi.fn(async () => undefined);
    const [definition] = createGovernedPiCodingTools({
      cwd: "/workspace",
      enabled: ["write"],
      operationsForCall: async () => {
        controller.abort();
        return { write: { mkdir: async () => undefined, writeFile } };
      },
    });
    const tool = definition as ReturnType<typeof createWriteToolDefinition>;
    await expect(
      tool.execute(
        "cancelled-call",
        { path: "a.txt", content: "a" },
        controller.signal,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("retains the existing product Operations adapter inside the invocation binding", async () => {
    const calls: string[] = [];
    const forbidden = async (): Promise<never> => {
      throw new Error("unexpected read");
    };
    const [definition] = createGovernedPiCodingTools({
      cwd: "/workspace",
      enabled: ["write"],
      operationsForCall: ({ toolCallId }) =>
        createPiOperationsFromGovernedHostPort({
          access: forbidden,
          readFile: forbidden,
          executeCommand: forbidden,
          makeDirectory: async () => undefined,
          writeFile: async (path) => {
            calls.push(`${toolCallId}:${path}`);
          },
        }),
    });
    const tool = definition as ReturnType<typeof createWriteToolDefinition>;
    await tool.execute(
      "bound-call",
      { path: "a.txt", content: "a" },
      undefined,
      undefined,
      {} as never,
    );
    expect(calls).toEqual(["bound-call:/workspace/a.txt"]);
  });
});
