import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileOperationService,
  HostFileReadService,
  type HostDirectoryGrant,
  type HostFileStatePort,
  type HostTrashRecord,
  type PermanentDeletionPlan,
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
  deletionPlans = new Map<string, PermanentDeletionPlan>();
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
  async saveDeletionPlan(value: PermanentDeletionPlan) {
    this.deletionPlans.set(value.id, value);
    return value;
  }
  async readDeletionPlan(id: string) {
    return this.deletionPlans.get(id);
  }
}

async function fixture(platform = new ConstrainedHostFileSystem()) {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-host-files-"));
  roots.push(root);
  const state = new MemoryHostFileState();
  let sequence = 0;
  const service = new FileOperationService({
    state,
    platform,
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
    operations: ["read", "create", "update", "move", "trash", "restore", "permanent_delete"],
    dataClassification: "private",
    disclosure: "model",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "authorization:directory",
    expiresAt: "2026-08-28T21:00:00.000Z",
    revokedAt: null,
  });
  return { root, service, grant, state, platform };
}

class CrashAfterEffectPlatform extends ConstrainedHostFileSystem {
  readonly crashes = new Set<string>();

  arm(operation: "create" | "move" | "trash" | "restore" | "delete") {
    this.crashes.add(operation);
  }

  #crash(operation: string) {
    if (!this.crashes.delete(operation)) return;
    throw new Error(`fixture crash after ${operation}`);
  }

  override async createExclusive(
    ...input: Parameters<ConstrainedHostFileSystem["createExclusive"]>
  ) {
    const result = await super.createExclusive(...input);
    this.#crash("create");
    return result;
  }

  override async move(...input: Parameters<ConstrainedHostFileSystem["move"]>) {
    const result = await super.move(...input);
    this.#crash("move");
    return result;
  }

  override async trash(...input: Parameters<ConstrainedHostFileSystem["trash"]>) {
    const result = await super.trash(...input);
    this.#crash("trash");
    return result;
  }

  override async restore(...input: Parameters<ConstrainedHostFileSystem["restore"]>) {
    const result = await super.restore(...input);
    this.#crash("restore");
    return result;
  }

  override async deletePermanently(
    ...input: Parameters<ConstrainedHostFileSystem["deletePermanently"]>
  ) {
    await super.deletePermanently(...input);
    this.#crash("delete");
  }
}

describe("ConstrainedHostFileSystem", () => {
  it("rejects same-inode content changes before deleting any approved target", async () => {
    const { root, service, grant, platform } = await fixture();
    await mkdir(path.join(root, "remove"));
    await writeFile(path.join(root, "remove/a.txt"), "first");
    await writeFile(path.join(root, "remove/b.txt"), "approved");
    const plan = await service.preparePermanentDeletion({
      grantId: grant.id,
      relativePath: "remove",
      irreversibleScope: "two files",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    await writeFile(path.join(root, "remove/b.txt"), "modified");
    await expect(platform.deletePermanently(grant, plan.targets)).rejects.toThrow();
    expect(await readFile(path.join(root, "remove/a.txt"), "utf8")).toBe("first");
    await expect(
      service.executePermanentDeletion({
        planId: plan.id,
        expectedHash: plan.canonicalHash,
        recentAuthenticationRef: "auth:fixture",
      }),
    ).rejects.toThrow("changed");
    expect(await readFile(path.join(root, "remove/b.txt"), "utf8")).toBe("modified");
  });

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

  it("freezes move and permanent deletion targets before executing", async () => {
    const { root, service, grant } = await fixture();
    await writeFile(path.join(root, "move.txt"), "move-me");
    const move = await service.prepareMove({
      grantId: grant.id,
      sourceRelativePath: "move.txt",
      destinationRelativePath: "moved/result.txt",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    await service.executeMove({ operationId: move.id, expectedHash: move.canonicalHash });
    expect(await readFile(path.join(root, "moved/result.txt"), "utf8")).toBe("move-me");

    const deletion = await service.preparePermanentDeletion({
      grantId: grant.id,
      relativePath: "moved",
      irreversibleScope: "moved directory and one verified child",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    expect(deletion.objectCount).toBe(2);
    await expect(
      service.executePermanentDeletion({
        planId: deletion.id,
        expectedHash: deletion.canonicalHash,
        recentAuthenticationRef: "",
      }),
    ).rejects.toThrow("recent authentication");
    const verified = await service.executePermanentDeletion({
      planId: deletion.id,
      expectedHash: deletion.canonicalHash,
      recentAuthenticationRef: "authentication:recent",
    });
    expect(verified.status).toBe("verified");
    await expect(readFile(path.join(root, "moved/result.txt"))).rejects.toThrow();
  });

  it("returns only protected references and blocks machine-secret disclosure", async () => {
    const { root, grant, state, platform } = await fixture();
    await writeFile(path.join(root, "public-note.txt"), "safe fixture text");
    await writeFile(path.join(root, "secret-note.txt"), `api_${"key"}=abcdefghijklmnop`);
    const protectedPayloads = new Map<string, string>();
    const reads = new HostFileReadService({
      state,
      platform,
      hostId: "host-mac",
      clock: { now: () => "2026-08-28T20:00:00.000Z" },
      disclosure: {
        protect: async ({ bytes }) => {
          const ref = `payload:host-read:${protectedPayloads.size + 1}`;
          protectedPayloads.set(ref, new TextDecoder().decode(bytes));
          return ref;
        },
      },
    });
    const ref = await reads.readProtected({
      grantId: grant.id,
      relativePath: "public-note.txt",
      destination: "model",
      maximumBytes: 1_024,
    });
    expect(ref).toBe("payload:host-read:1");
    expect(protectedPayloads.get(ref)).toBe("safe fixture text");
    await expect(
      reads.readProtected({
        grantId: grant.id,
        relativePath: "secret-note.txt",
        destination: "model",
        maximumBytes: 1_024,
      }),
    ).rejects.toThrow("machine-secret material");
  });

  it("blocks capacity-increasing writes at the reserve floor while preserving reads", async () => {
    class LowStoragePlatform extends ConstrainedHostFileSystem {
      override async storageObservation() {
        return { availableBytes: 1, totalBytes: 1024 };
      }
    }
    const { root, service, grant, platform } = await fixture(new LowStoragePlatform());
    await writeFile(path.join(root, "readable.txt"), "owner-readable");
    const prepared = await service.prepareWrite({
      grantId: grant.id,
      operation: "create",
      relativePath: "blocked.txt",
      candidatePayloadRef: "payload:blocked",
      candidateBytes: new TextEncoder().encode("blocked"),
      redactedDiffRef: null,
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    await expect(
      service.executeWrite({
        operationId: prepared.id,
        expectedHash: prepared.canonicalHash,
        candidateBytes: new TextEncoder().encode("blocked"),
      }),
    ).rejects.toThrow("Storage reserve reached");
    expect(new TextDecoder().decode(await platform.read(grant, "readable.txt", 1024))).toBe(
      "owner-readable",
    );
  });

  it("reconciles create, move, Trash, restore and permanent-delete crashes after effects", async () => {
    const platform = new CrashAfterEffectPlatform();
    const { root, service, grant, state } = await fixture(platform);

    const bytes = new TextEncoder().encode("recoverable");
    const create = await service.prepareWrite({
      operationId: "operation-create-recovery",
      grantId: grant.id,
      operation: "create",
      relativePath: "recover/create.txt",
      candidatePayloadRef: "payload:create-recovery",
      candidateBytes: bytes,
      redactedDiffRef: "payload:diff-recovery",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    platform.arm("create");
    await expect(
      service.executeWrite({
        operationId: create.id,
        expectedHash: create.canonicalHash,
        candidateBytes: bytes,
      }),
    ).rejects.toThrow("fixture crash after create");
    expect(
      (
        await service.executeWrite({
          operationId: create.id,
          expectedHash: create.canonicalHash,
          candidateBytes: bytes,
        })
      ).status,
    ).toBe("verified");

    const move = await service.prepareMove({
      operationId: "operation-move-recovery",
      grantId: grant.id,
      sourceRelativePath: "recover/create.txt",
      destinationRelativePath: "recover/moved.txt",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    platform.arm("move");
    await expect(
      service.executeMove({ operationId: move.id, expectedHash: move.canonicalHash }),
    ).rejects.toThrow("fixture crash after move");
    expect(
      (await service.executeMove({ operationId: move.id, expectedHash: move.canonicalHash }))
        .status,
    ).toBe("verified");

    const trash = await service.prepareTrash({
      operationId: "operation-trash-recovery",
      grantId: grant.id,
      relativePath: "recover/moved.txt",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    platform.arm("trash");
    await expect(
      service.executeTrash({ operationId: trash.id, expectedHash: trash.canonicalHash }),
    ).rejects.toThrow("fixture crash after trash");
    const trashed = await service.executeTrash({
      operationId: trash.id,
      expectedHash: trash.canonicalHash,
    });
    expect(trashed.operation.status).toBe("verified");

    const restore = await service.prepareRestore({
      operationId: "operation-restore-recovery",
      trashId: trashed.record.id,
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    platform.arm("restore");
    await expect(
      service.executeRestore({ operationId: restore.id, expectedHash: restore.canonicalHash }),
    ).rejects.toThrow("fixture crash after restore");
    expect(
      (
        await service.executeRestore({
          operationId: restore.id,
          expectedHash: restore.canonicalHash,
        })
      ).operation.status,
    ).toBe("verified");

    const deletion = await service.preparePermanentDeletion({
      planId: "operation-delete-recovery",
      grantId: grant.id,
      relativePath: "recover",
      irreversibleScope: "recover directory and verified child",
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    platform.arm("delete");
    await expect(
      service.executePermanentDeletion({
        planId: deletion.id,
        expectedHash: deletion.canonicalHash,
        recentAuthenticationRef: "authentication:recent",
      }),
    ).rejects.toThrow("fixture crash after delete");
    expect(
      (
        await service.executePermanentDeletion({
          planId: deletion.id,
          expectedHash: deletion.canonicalHash,
          recentAuthenticationRef: "authentication:recent",
        })
      ).status,
    ).toBe("verified");
    expect((await state.readDeletionPlan(deletion.id))?.status).toBe("verified");
    await expect(readFile(path.join(root, "recover/moved.txt"))).rejects.toThrow();
  });
});
