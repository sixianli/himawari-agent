import { link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostDirectoryGrant } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConstrainedHostFileSystem,
  createSandboxedCodingOperations,
  exportPiOutputFile,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(initial?: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-ops-")));
  roots.push(root);
  const file = path.join(root, "file.txt");
  if (initial !== undefined) await writeFile(file, initial);
  const identity = await new ConstrainedHostFileSystem().inspectRoot(root);
  const grant: HostDirectoryGrant = {
    id: "grant",
    revision: 1,
    hostId: "host",
    canonicalRootId: `${identity.device}:${identity.inode}`,
    displayPath: root,
    operations: ["read", "create", "update"],
    dataClassification: "private",
    disclosure: "worker",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "authorization",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    revokedAt: null,
  };
  const port = await createSandboxedCodingOperations({
    grant,
    targetPath: file,
    shell: "/bin/bash",
    privateDirectory: root,
    binaryDirectory: "/usr/bin",
    maxOutputBytes: 4096,
  });
  return { root, file, grant, port };
}
describe("sandboxed coding file operations", () => {
  it("creates missing parents exclusively and reads a genuine empty file", async () => {
    const { file, port } = await setup();
    await expect(port.readFile(file)).rejects.toThrow("PI_FILE_MISSING");
    await port.writeFile(file, "");
    expect(await readFile(file, "utf8")).toBe("");
  });
  it("safely replaces an empty existing file", async () => {
    const { file, port } = await setup("");
    expect(await port.readFile(file)).toHaveLength(0);
    await port.writeFile(file, "new content");
    expect(await readFile(file, "utf8")).toBe("new content");
  });
  it("preserves an external modification between prepare and write", async () => {
    const { file, port } = await setup("original");
    await writeFile(file, "user edit");
    await expect(port.writeFile(file, "agent edit")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("user edit");
  });
  it("does not replace a file created after the exclusive-create baseline", async () => {
    const { file, port } = await setup();
    await writeFile(file, "user file");
    await expect(port.writeFile(file, "agent file")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("user file");
  });
  it("rejects escape, protected paths and changed symlink targets", async () => {
    const { root, file, port } = await setup("original");
    for (const name of ["../other", ".env", ".git/config", ".himawari-recovery/x"])
      await expect(port.readFile(path.resolve(root, name))).rejects.toThrow();
    await rm(file);
    await symlink(path.join(root, "other"), file);
    await expect(port.writeFile(file, "replacement")).rejects.toThrow();
  });
  it("does not turn a partial file write grant into arbitrary shell authority", async () => {
    const { root, port } = await setup();
    await expect(port.executeCommand({ cwd: root, command: "true", onData() {} })).rejects.toThrow(
      "PI_SHELL_EFFECT_SCOPE_INCOMPLETE",
    );
  });
});
describe("Pi output export", () => {
  it("exports bytes and digest, without a host locator", async () => {
    const { root } = await setup();
    const file = path.join(root, "pi-bash-123abc.log");
    await writeFile(file, "output");
    const result = await exportPiOutputFile(file, root, 64);
    expect(Buffer.from(result.data, "base64").toString()).toBe("output");
    expect(JSON.stringify(result)).not.toContain(root);
  });
  it("rejects forged paths, links and oversized files", async () => {
    const { root, file } = await setup("private bytes");
    const output = path.join(root, "pi-bash-abc123.log");
    await expect(exportPiOutputFile(file, root, 64)).rejects.toThrow("PI_OUTPUT_OWNER_MISMATCH");
    await symlink(file, output);
    await expect(exportPiOutputFile(output, root, 64)).rejects.toThrow();
    await rm(output);
    await link(file, output);
    await expect(exportPiOutputFile(output, root, 64)).rejects.toThrow("PI_OUTPUT_FILE_REJECTED");
    await rm(output);
    await writeFile(output, "too long");
    await expect(exportPiOutputFile(output, root, 1)).rejects.toThrow("PI_OUTPUT_FILE_REJECTED");
  });
});

describe("sandboxed shell result boundary", () => {
  it("preserves nonzero exits and rejects signal exits instead of empty success", async () => {
    const { root, grant } = await setup();
    const port = await createSandboxedCodingOperations({
      grant: { ...grant, operations: ["read"] },
      shell: "/bin/bash",
      privateDirectory: root,
      binaryDirectory: "/usr/bin",
      maxOutputBytes: 64,
    });
    let output = "";
    const command = {
      cwd: root,
      onData(bytes: Uint8Array) {
        output += Buffer.from(bytes).toString();
      },
    };
    expect(await port.executeCommand({ ...command, command: "printf output; exit 7" })).toEqual({
      exitCode: 7,
    });
    expect(output).toBe("output");
    await expect(port.executeCommand({ ...command, command: "kill -KILL $$" })).rejects.toThrow(
      "PI_COMMAND_SIGNALLED",
    );
    await expect(
      port.executeCommand({ ...command, command: "while :; do :; done", timeoutMs: 20 }),
    ).rejects.toThrow("PI_COMMAND_TIMEOUT");
    await expect(port.executeCommand({ ...command, command: "printf '%100s' x" })).rejects.toThrow(
      "PI_COMMAND_OUTPUT_LIMIT",
    );
  });
});
