import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileOperationService,
  type HostDirectoryGrant,
  type HostFileStatePort,
  type HostTrashRecord,
  type PreparedFileOperation,
} from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import { ConstrainedHostFileSystem } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryHostFileState implements HostFileStatePort {
  grants = new Map<string, HostDirectoryGrant>();
  prepared = new Map<string, PreparedFileOperation>();
  trash = new Map<string, HostTrashRecord>();
  async saveGrant(value: HostDirectoryGrant) {
    this.grants.set(value.id, value);
    return value;
  }
  async readGrant(id: string) {
    return this.grants.get(id);
  }
  async savePrepared(value: PreparedFileOperation) {
    this.prepared.set(value.id, value);
    return value;
  }
  async readPrepared(id: string) {
    return this.prepared.get(id);
  }
  async saveTrash(value: HostTrashRecord) {
    this.trash.set(value.id, value);
    return value;
  }
  async readTrash(id: string) {
    return this.trash.get(id);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-host-files-"));
  roots.push(root);
  const state = new MemoryHostFileState();
  let sequence = 0;
  const service = new FileOperationService({
    state,
    platform: new ConstrainedHostFileSystem(),
    digest: {
      digest: (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      digestCanonical: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
    clock: { now: () => "2026-08-28T20:00:00.000Z" },
    ids: { next: (prefix) => `${prefix}-${++sequence}` },
    hostId: "host-mac",
  });
  const grant = await service.grant({
    hostId: "host-mac",
    displayPath: root,
    operations: ["read", "create", "update", "trash", "restore"],
    dataClassification: "private",
    disclosure: "model",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "authorization:directory",
    expiresAt: "2026-08-28T21:00:00.000Z",
    revokedAt: null,
  });
  return { root, service, grant };
}

describe("ConstrainedHostFileSystem", () => {
  it("creates exclusively, atomically replaces with recovery, trashes and restores", async () => {
    const { root, service, grant } = await fixture();
    const created = await service.prepareWrite({
      grantId: grant.id,
      operation: "create",
      relativePath: "notes/item.txt",
      candidatePayloadRef: "payload:create",
      candidateBytes: new TextEncoder().encode("first"),
      redactedDiffRef: "payload:diff-create",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    await service.executeWrite({
      operationId: created.id,
      expectedHash: created.canonicalHash,
      candidateBytes: new TextEncoder().encode("first"),
    });
    const updated = await service.prepareWrite({
      grantId: grant.id,
      operation: "update",
      relativePath: "notes/item.txt",
      candidatePayloadRef: "payload:update",
      candidateBytes: new TextEncoder().encode("second"),
      redactedDiffRef: "payload:diff-update",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    await service.executeWrite({
      operationId: updated.id,
      expectedHash: updated.canonicalHash,
      candidateBytes: new TextEncoder().encode("second"),
    });
    expect(await readFile(path.join(root, "notes/item.txt"), "utf8")).toBe("second");
    const trash = await service.trash({ grantId: grant.id, relativePath: "notes/item.txt" });
    await expect(readFile(path.join(root, "notes/item.txt"))).rejects.toThrow();
    await service.restore(trash.id);
    expect(await readFile(path.join(root, "notes/item.txt"), "utf8")).toBe("second");
  });

  it("rejects traversal, symlink and hard-link targets without exposing content", async () => {
    const { root, service, grant } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "himawari-host-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside-private-content");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
    await link(path.join(outside, "secret.txt"), path.join(root, "hard.txt"));
    for (const relativePath of ["../secret.txt", "linked.txt", "hard.txt"]) {
      await expect(
        service.prepareWrite({
          grantId: grant.id,
          operation: "update",
          relativePath,
          candidatePayloadRef: "payload:blocked",
          candidateBytes: new TextEncoder().encode("blocked"),
          redactedDiffRef: null,
          expiresAt: "2026-08-28T20:30:00.000Z",
        }),
      ).rejects.toThrow();
    }
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe(
      "outside-private-content",
    );
  });
});
