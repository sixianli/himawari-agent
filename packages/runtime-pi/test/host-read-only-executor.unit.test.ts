import type {
  HostDirectoryGrant,
  HostReadOnlyDirectoryEntry,
  HostReadOnlyEntryKind,
  HostReadOnlyPort,
} from "@himawari-agent/application/runtime-port";
import { describe, expect, it } from "vitest";
import { executeHostReadOnlyTool } from "../src/host-read-only-executor.js";

interface FakeNode {
  readonly kind: HostReadOnlyEntryKind;
  readonly content?: string;
}

class FakePort implements HostReadOnlyPort {
  readonly available = true;
  readonly nodes = new Map<string, FakeNode>();
  constructor(entries: Record<string, FakeNode>) {
    for (const [key, value] of Object.entries(entries)) this.nodes.set(key, value);
  }
  async listDirectory(input: {
    readonly relativePath: string;
  }): Promise<readonly HostReadOnlyDirectoryEntry[]> {
    const prefix = input.relativePath === "" ? "" : `${input.relativePath}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest === "" || rest.includes("/")) continue;
      names.add(rest);
    }
    return [...names].sort().map((name) => {
      const node = this.nodes.get(`${prefix}${name}`);
      if (!node) throw new Error("FAKE_PORT_MISSING_NODE");
      return Object.freeze({ name, kind: node.kind });
    });
  }
  async inspectEntry(input: {
    readonly relativePath: string;
  }): Promise<HostReadOnlyEntryKind | null> {
    if (input.relativePath === "") return "directory";
    return this.nodes.get(input.relativePath)?.kind ?? null;
  }
  async readFile(input: {
    readonly relativePath: string;
    readonly maximumBytes: number;
  }): Promise<Uint8Array> {
    const node = this.nodes.get(input.relativePath);
    if (!node) throw new Error("HOST_READ_TARGET_MISSING");
    if (node.kind !== "file") throw new Error("HOST_READ_NOT_REGULAR");
    const bytes = new TextEncoder().encode(node.content ?? "");
    if (bytes.byteLength > input.maximumBytes) throw new Error("HOST_READ_LENGTH_EXCEEDED");
    return bytes;
  }
}

const grant: HostDirectoryGrant = Object.freeze({
  id: "directory:test",
  revision: 1,
  hostId: "host:test",
  canonicalRootId: "1:1",
  displayPath: "/workspace",
  operations: Object.freeze(["read" as const]),
  dataClassification: "private" as const,
  disclosure: "model" as const,
  pathPolicy: "same_filesystem_no_links" as const,
  mountPolicy: "fixed_device" as const,
  authorizationRef: "authorization:test",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  revokedAt: null,
});

function run(
  port: HostReadOnlyPort,
  tool: "read" | "ls" | "find" | "grep",
  relativePath: string,
  parameters: Record<string, unknown>,
) {
  return executeHostReadOnlyTool({
    port,
    grant,
    tool,
    toolCallId: "call-1",
    parameters,
    relativePath,
    readBytesLimit: 16 * 1024 * 1024,
  });
}

function fixture(): FakePort {
  return new FakePort({
    "notes.txt": { kind: "file", content: "向日葵\n" },
    sub: { kind: "directory" },
    "sub/nested.txt": { kind: "file", content: "nested content\n" },
    ".env": { kind: "file", content: "SECRET=1\n" },
    pipe: { kind: "other" },
  });
}

describe("host read-only executor", () => {
  it("reads a file with Pi's read shape", async () => {
    const result = await run(fixture(), "read", "notes.txt", { path: "notes.txt" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("向日葵\n");
  });

  it("reports a directory read instead of failing as outside scope", async () => {
    const result = await run(fixture(), "read", "sub", { path: "sub" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("CODING_PATH_IS_DIRECTORY");
    expect(result.content).toContain("是目录");
  });

  it("reports a missing file", async () => {
    const result = await run(fixture(), "read", "missing.txt", { path: "missing.txt" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("PI_FILE_MISSING");
  });

  it("refuses a protected path", async () => {
    const port = fixture();
    const result = await run(port, "read", ".env", { path: ".env" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("PI_PATH_OUTSIDE_SCOPE");
  });

  it("refuses a wider protected name with a clear code", async () => {
    const port = new FakePort({
      ".ssh": { kind: "directory" },
      ".ssh/id_rsa": { kind: "file", content: "key\n" },
    });
    const result = await run(port, "read", ".ssh/id_rsa", { path: ".ssh/id_rsa" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("PI_PROTECTED_PATH");
  });

  it("refuses content with machine secrets", async () => {
    const fakeKey = "sk-" + "abcdefghijklmnopqrstuvwx";
    const port = new FakePort({
      "keys.txt": { kind: "file", content: `${fakeKey}\n` },
    });
    const result = await run(port, "read", "keys.txt", { path: "keys.txt" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("PI_TEXT_READ_REJECTED");
  });

  it("lists entries with Pi's ls formatting", async () => {
    const result = await run(fixture(), "ls", "", { path: "." });
    expect(result.isError).toBe(false);
    expect(result.content.split("\n").sort()).toEqual([".env", "notes.txt", "pipe", "sub/"].sort());
  });

  it("finds a nested file and respects gitignore", async () => {
    const port = fixture();
    port.nodes.set(".gitignore", { kind: "file", content: "sub/\n" });
    const found = await run(port, "find", "", { pattern: "**/*.txt", path: "." });
    expect(found.isError).toBe(false);
    expect(found.content).toContain("notes.txt");
    expect(found.content).not.toContain("nested.txt");
  });

  it("grep returns matching file, line and text", async () => {
    const result = await run(fixture(), "grep", "", { pattern: "nested", path: "." });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("sub/nested.txt:1: nested content");
  });

  it("grep reports no matches", async () => {
    const result = await run(fixture(), "grep", "", { pattern: "does-not-exist", path: "." });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No matches found");
  });

  it("grep skips protected files", async () => {
    const result = await run(fixture(), "grep", "", { pattern: "SECRET", path: "." });
    expect(result.content).toBe("No matches found");
  });

  it("rejects ripgrep-only pattern syntax", async () => {
    for (const pattern of ["(?i)foo", "[[:alpha:]]+"]) {
      const result = await run(fixture(), "grep", "", { pattern, path: "." });
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe("GREP_PATTERN_UNSUPPORTED");
    }
  });

  it("stays unavailable when the port has no descriptor-relative open", async () => {
    const port = fixture();
    Object.defineProperty(port, "available", { value: false });
    const result = await run(port, "read", "notes.txt", { path: "notes.txt" });
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("HOST_READ_PROC_UNAVAILABLE");
  });
});

it("reports files it could not search", async () => {
  const port = new FakePort({
    "small.txt": { kind: "file", content: "needle\n" },
    "big.txt": { kind: "file", content: "x".repeat(100) },
  });
  const found = await executeHostReadOnlyTool({
    port,
    grant,
    tool: "grep",
    toolCallId: "grep-skip",
    parameters: { pattern: "needle", path: "." },
    relativePath: "",
    readBytesLimit: 50,
  });
  expect(found.content).toContain("needle");
  expect(found.content).toContain("1 个文件因过大或无法读取未搜索");
  const none = await executeHostReadOnlyTool({
    port,
    grant,
    tool: "grep",
    toolCallId: "grep-skip-none",
    parameters: { pattern: "absent", path: "." },
    relativePath: "",
    readBytesLimit: 50,
  });
  expect(none.content).toContain("No matches found");
  expect(none.content).toContain("1 个文件因过大或无法读取未搜索");
});

function manyFiles(count: number): FakePort {
  const entries: Record<string, FakeNode> = {};
  for (let index = 0; index < count; index += 1) {
    entries[`file-${index}.txt`] = { kind: "file", content: `content ${index}\n` };
  }
  return new FakePort(entries);
}

it("yields the event loop while grepping many files", async () => {
  const port = manyFiles(50);
  const flag: { ran: boolean } = { ran: false };
  setImmediate(() => {
    flag.ran = true;
  });
  const result = await executeHostReadOnlyTool({
    port,
    grant,
    tool: "grep",
    toolCallId: "grep-yield",
    parameters: { pattern: "no-such-token", path: "." },
    relativePath: "",
    readBytesLimit: 1024,
  });
  expect(flag.ran).toBe(true);
  expect(result.content).toContain("No matches found");
});

it("yields the event loop while walking many files with find", async () => {
  const port = manyFiles(50);
  const flag: { ran: boolean } = { ran: false };
  setImmediate(() => {
    flag.ran = true;
  });
  const result = await executeHostReadOnlyTool({
    port,
    grant,
    tool: "find",
    toolCallId: "find-yield",
    parameters: { pattern: "*.txt", path: "." },
    relativePath: "",
    readBytesLimit: 1024,
  });
  expect(flag.ran).toBe(true);
  expect(result.isError).toBe(false);
});
