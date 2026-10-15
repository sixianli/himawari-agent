import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostDirectoryGrant } from "@himawari-agent/application";
import {
  COMMAND_OUTPUT_CEILING_MULTIPLIER,
  createSandboxedCodingOperations,
  DescriptorRelativeReadOnly,
} from "@himawari-agent/platform-node";
import { executeHostReadOnlyTool, executeSandboxedPiCodingTool } from "@himawari-agent/runtime-pi";
import { firstRejectedPathComponent } from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";

const linux = process.platform === "linux";
const scratchRoot = process.env["HIMAWARI_TEST_TEMP_ROOT"] ?? os.tmpdir();

type ToolName = "read" | "ls" | "find" | "grep";

function grantFor(directory: string): HostDirectoryGrant {
  const info = lstatSync(directory, { bigint: true });
  return Object.freeze({
    id: "directory:consistency",
    revision: 1,
    hostId: "host:consistency",
    canonicalRootId: `${info.dev}:${info.ino}`,
    displayPath: directory,
    operations: Object.freeze(["read" as const]),
    dataClassification: "private" as const,
    disclosure: "worker" as const,
    pathPolicy: "same_filesystem_no_links" as const,
    mountPolicy: "fixed_device" as const,
    authorizationRef: "authorization:consistency",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
  });
}

interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

async function sandboxOutcome(
  grant: HostDirectoryGrant,
  privateDirectory: string,
  tool: ToolName,
  relativePath: string,
  parameters: Record<string, unknown>,
): Promise<ToolOutcome> {
  if (firstRejectedPathComponent(relativePath.split("/")) !== undefined)
    return { text: "PI_PATH_OUTSIDE_SCOPE", isError: true };
  const operations = await createSandboxedCodingOperations({
    grant,
    shell: "/bin/bash",
    privateDirectory,
    commandPath: "/usr/bin:/bin",
    maxCommandOutputBytes: 48 * 1024 * COMMAND_OUTPUT_CEILING_MULTIPLIER,
  });
  const result = await executeSandboxedPiCodingTool({
    name: tool,
    toolCallId: `consistency-${tool}`,
    cwd: grant.displayPath,
    parameters,
    operations,
  });
  return { text: textOf(result), isError: result.isError };
}

async function hostOutcome(
  grant: HostDirectoryGrant,
  port: DescriptorRelativeReadOnly,
  tool: ToolName,
  relativePath: string,
  parameters: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = await executeHostReadOnlyTool({
    port,
    grant,
    tool,
    toolCallId: `host-${tool}`,
    parameters,
    relativePath,
    readBytesLimit: 16 * 1024 * 1024,
  });
  return { text: result.content, isError: result.isError };
}

describe("R2-P1 host path vs sandboxed path", () => {
  if (!linux) {
    it("reports the host read-only port unavailable on hosts without procfs", () => {
      expect(new DescriptorRelativeReadOnly().available).toBe(false);
    });
    return;
  }

  it("returns byte-identical read and ls output on the same fixture", async () => {
    const directory = mkdtempSync(path.join(scratchRoot, "consistency-"));
    chmodSync(directory, 0o700);
    const privateDirectory = mkdtempSync(path.join(scratchRoot, "consistency-private-"));
    chmodSync(privateDirectory, 0o700);
    writeFileSync(path.join(directory, "notes.txt"), "向日葵\n");
    writeFileSync(path.join(directory, "editable.txt"), "editable\n");
    mkdirSync(path.join(directory, "sub"));
    writeFileSync(path.join(directory, "sub", "nested.txt"), "nested content\n");
    const grant = grantFor(directory);
    const port = new DescriptorRelativeReadOnly();

    const hostRead = await hostOutcome(grant, port, "read", "notes.txt", { path: "notes.txt" });
    const sandboxRead = await sandboxOutcome(grant, privateDirectory, "read", "notes.txt", {
      path: "notes.txt",
    });
    expect(hostRead.text).toBe(sandboxRead.text);

    const hostMissing = await hostOutcome(grant, port, "read", "missing.txt", {
      path: "missing.txt",
    });
    const sandboxMissing = await sandboxOutcome(grant, privateDirectory, "read", "missing.txt", {
      path: "missing.txt",
    });
    expect(hostMissing.isError).toBe(true);
    expect(sandboxMissing.isError).toBe(true);
    expect(hostMissing.text).toBe(sandboxMissing.text);

    const hostLs = await hostOutcome(grant, port, "ls", "", { path: "." });
    const sandboxLs = await sandboxOutcome(grant, privateDirectory, "ls", "", { path: "." });
    expect(hostLs.text).toBe(sandboxLs.text);

    rmSync(directory, { recursive: true, force: true });
    rmSync(privateDirectory, { recursive: true, force: true });
  });

  it("matches the sandboxed path rule for .git, .env and .himawari-* on all four tools", async () => {
    const directory = mkdtempSync(path.join(scratchRoot, "consistency-protected-"));
    chmodSync(directory, 0o700);
    const privateDirectory = mkdtempSync(path.join(scratchRoot, "consistency-private-"));
    chmodSync(privateDirectory, 0o700);
    mkdirSync(path.join(directory, ".git"));
    writeFileSync(path.join(directory, ".git", "config"), "[remote]\n");
    writeFileSync(path.join(directory, ".env"), "TOKEN=1\n");
    mkdirSync(path.join(directory, ".himawari-state"));
    writeFileSync(path.join(directory, ".himawari-state", "x"), "state\n");
    const grant = grantFor(directory);
    const port = new DescriptorRelativeReadOnly();
    const cases: Array<[ToolName, string, Record<string, unknown>]> = [
      ["read", ".git/config", { path: ".git/config" }],
      ["read", ".env", { path: ".env" }],
      ["read", ".himawari-state/x", { path: ".himawari-state/x" }],
      ["ls", ".git", { path: ".git" }],
      ["ls", ".himawari-state", { path: ".himawari-state" }],
      ["find", ".git", { pattern: "**/*", path: ".git" }],
      ["find", ".himawari-state", { pattern: "**/*", path: ".himawari-state" }],
      ["grep", ".env", { pattern: "TOKEN", path: ".env" }],
      ["grep", ".git", { pattern: "remote", path: ".git" }],
    ];
    for (const [tool, relativePath, parameters] of cases) {
      const host = await hostOutcome(grant, port, tool, relativePath, parameters);
      const sandbox = await sandboxOutcome(grant, privateDirectory, tool, relativePath, parameters);
      expect({ tool, relativePath, ...host }).toEqual({ tool, relativePath, ...sandbox });
      expect(host.isError).toBe(true);
      expect(host.text).toBe("PI_PATH_OUTSIDE_SCOPE");
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(privateDirectory, { recursive: true, force: true });
  });

  it("documents the masked-name behaviour as a known divergence", async () => {
    const directory = mkdtempSync(path.join(scratchRoot, "consistency-masked-"));
    chmodSync(directory, 0o700);
    mkdirSync(path.join(directory, ".ssh"));
    writeFileSync(path.join(directory, ".ssh", "config"), "Host x\n");
    writeFileSync(path.join(directory, ".ssh", "id_rsa"), "key\n");
    mkdirSync(path.join(directory, "keys"));
    writeFileSync(path.join(directory, "keys", "server.pem"), "pem\n");
    mkdirSync(path.join(directory, ".docker"));
    writeFileSync(path.join(directory, ".docker", "config.json"), "{}\n");
    const grant = grantFor(directory);
    const port = new DescriptorRelativeReadOnly();

    const listing = await hostOutcome(grant, port, "ls", "", { path: "." });
    expect(listing.text).toContain(".ssh/");
    expect(listing.text).toContain("keys/");

    const emptySsh = await hostOutcome(grant, port, "ls", ".ssh", { path: ".ssh" });
    expect(emptySsh.isError).toBe(false);
    expect(emptySsh.text).toBe("(empty directory)");

    const refusedKey = await hostOutcome(grant, port, "read", ".ssh/id_rsa", {
      path: ".ssh/id_rsa",
    });
    expect(refusedKey.isError).toBe(true);
    expect(refusedKey.text).toBe("PI_PROTECTED_PATH");

    const findInSsh = await hostOutcome(grant, port, "find", ".ssh", {
      pattern: "**/*",
      path: ".ssh",
    });
    expect(findInSsh.text).toBe("No files found matching pattern");

    const grepInSsh = await hostOutcome(grant, port, "grep", ".ssh", {
      pattern: "Host",
      path: ".ssh",
    });
    expect(grepInSsh.text).toBe("No matches found");

    const findRoot = await hostOutcome(grant, port, "find", "", { pattern: "**/*.pem", path: "." });
    expect(findRoot.text).not.toContain("id_rsa");
    const grepRoot = await hostOutcome(grant, port, "grep", "", { pattern: "pem", path: "." });
    expect(grepRoot.text).toBe("No matches found");

    rmSync(directory, { recursive: true, force: true });
  });

  it("documents the directory-read message difference as a known divergence", async () => {
    const directory = mkdtempSync(path.join(scratchRoot, "consistency-dir-"));
    chmodSync(directory, 0o700);
    const privateDirectory = mkdtempSync(path.join(scratchRoot, "consistency-private-"));
    chmodSync(privateDirectory, 0o700);
    mkdirSync(path.join(directory, "sub"));
    const grant = grantFor(directory);
    const port = new DescriptorRelativeReadOnly();
    const hostRead = await hostOutcome(grant, port, "read", "sub", { path: "sub" });
    const sandboxRead = await sandboxOutcome(grant, privateDirectory, "read", "sub", {
      path: "sub",
    });
    expect(hostRead.isError).toBe(true);
    expect(hostRead.text).toContain("是目录");
    expect(sandboxRead.isError).toBe(true);
    rmSync(directory, { recursive: true, force: true });
    rmSync(privateDirectory, { recursive: true, force: true });
  });

  it("[R2-T9] bounds an over-limit host read with Pi's continuation notice", async () => {
    const directory = mkdtempSync(path.join(scratchRoot, "consistency-r2t9-"));
    chmodSync(directory, 0o700);
    writeFileSync(
      path.join(directory, "big.txt"),
      Array.from({ length: 1000 }, (_, index) => `第${index + 1}行 ${"内".repeat(60)}`).join("\n"),
    );
    const grant = grantFor(directory);
    const port = new DescriptorRelativeReadOnly();
    const limit = 4096;
    const bounded = await executeHostReadOnlyTool({
      port,
      grant,
      tool: "read",
      toolCallId: "r2t9-bounded-read",
      parameters: { path: "big.txt" },
      relativePath: "big.txt",
      readBytesLimit: 16 * 1024 * 1024,
      contentBytesLimit: limit,
    });
    expect(bounded.isError).toBe(false);
    expect(bounded.content).toContain("Use offset=");
    expect(bounded.details).toMatchObject({ truncation: { truncated: true, maxBytes: limit } });

    const privateDirectory = mkdtempSync(path.join(scratchRoot, "consistency-p-"));
    const sandbox = await sandboxOutcome(grant, privateDirectory, "read", "big.txt", {
      path: "big.txt",
    });
    expect(sandbox.isError).toBe(false);
    rmSync(directory, { recursive: true, force: true });
    rmSync(privateDirectory, { recursive: true, force: true });
  });
});
