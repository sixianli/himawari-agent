import type {
  HostDirectoryGrant,
  HostReadOnlyDirectoryEntry,
  HostReadOnlyEntryKind,
  HostReadOnlyPort,
} from "@himawari-agent/application/runtime-port";
import { describe, expect, it } from "vitest";
import { createProductionHostReadOnly } from "../src/production-host-read.js";
import { toolResultSentToModel } from "./fixtures/model-egress.js";

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

function execute(
  port: HostReadOnlyPort,
  tool: "read" | "ls" | "find" | "grep",
  relativePath: string,
  parameters: Record<string, unknown>,
  maximumOutputBytes: number,
) {
  return createProductionHostReadOnly(port).execute({
    tool,
    toolCallId: `r2t9-${tool}`,
    grant,
    parameters,
    relativePath,
    readBytesLimit: 16 * 1024 * 1024,
    maximumOutputBytes,
  });
}

const manyLines = Array.from(
  { length: 4000 },
  (_, index) => `第${index + 1}行 ${"内".repeat(40)}`,
).join("\n");

describe("[R2-T9] production host read output limit", () => {
  it("[R2-T9] returns truncated content instead of failing an over-limit read", async () => {
    const port = new FakePort({ "big.txt": { kind: "file", content: manyLines } });
    const result = await execute(port, "read", "big.txt", { path: "big.txt" }, 4096);
    expect(result.isError).toBe(false);
    expect(result.errorCode).toBeNull();
    expect(result.modelContent).toContain("Use offset=");
    expect(Buffer.byteLength(result.modelContent, "utf-8")).toBeLessThanOrEqual(4096);
  });

  it("[R2-T9] returns a machine secret over the limit, and egress masks it", async () => {
    const entries: Record<string, FakeNode> = {};
    const fakeKey = "sk-" + "abcdefghijklmnopqrstuvwx";
    for (let file = 0; file < 3; file += 1) {
      const lines = Array.from(
        { length: 30 },
        (_, index) => `needle ${file}-${index} ${"x".repeat(100)}`,
      );
      if (file === 0) lines[0] = `needle ${file}-0 token = ${fakeKey}`;
      entries[`file-${file}.txt`] = { kind: "file", content: `${lines.join("\n")}\n` };
    }
    const result = await execute(
      new FakePort(entries),
      "grep",
      "",
      { pattern: "needle", path: "." },
      4096,
    );
    expect(result.isError).toBe(false);
    expect(result.modelContent).toContain(fakeKey);
    expect(await toolResultSentToModel(result.modelContent)).not.toContain(fakeKey);
  });

  it("[R2-T14] returns grep context that shows a private key, and egress masks it", async () => {
    const marker = (edge: string) => [`-----${edge}`, "PRIVATE KEY-----"].join(" ");
    const body = Array.from(
      { length: 26 },
      (_, index) => `MIIEvR2T14GREPBODY${index}${"Qk".repeat(28)}`,
    );
    const port = new FakePort({
      "deploy-notes.txt": {
        kind: "file",
        content: ["deploy key:", marker("BEGIN"), ...body, marker("END"), ""].join("\n"),
      },
    });
    const result = await execute(port, "grep", "", { pattern: "BEGIN", context: 4 }, 48 * 1024);
    expect(result.isError).toBe(false);
    expect(result.modelContent).toContain("R2T14GREPBODY");
    expect(await toolResultSentToModel(result.modelContent)).not.toContain("R2T14GREPBODY");
  });

  it("[R2-T14] keeps the result of a grep whose own pattern is a key's first line", async () => {
    const pattern = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const port = new FakePort({ "notes.txt": { kind: "file", content: "no keys here\n" } });
    const result = await execute(port, "grep", "", { pattern, path: "." }, 48 * 1024);
    expect(result.isError).toBe(false);
    expect(result.errorCode).toBeNull();
    expect(JSON.parse(result.modelContent)).toMatchObject({
      tool: "grep",
      content: [{ type: "text", text: "No matches found" }],
      source: { parameters: { pattern } },
    });
  });

  it("[R2-T9] keeps the hard limit only when the envelope itself cannot fit", async () => {
    const port = new FakePort({ "small.txt": { kind: "file", content: "short\n" } });
    const result = await execute(port, "read", "small.txt", { path: "small.txt" }, 1);
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("PI_RESULT_OUTPUT_LIMIT");
  });
});
