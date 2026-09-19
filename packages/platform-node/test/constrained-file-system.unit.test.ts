import { createHash } from "node:crypto";
import {
  chmod,
  stat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConstrainedHostFileSystem } from "../src/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open), unlink: vi.fn(original.unlink) };
});

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
  it("freezes create content before asynchronous filesystem checks", async () => {
    const { root, grant, platform } = await fixture();
    const bytes = new TextEncoder().encode("approved");
    const pending = platform.createExclusive(grant, "frozen.txt", bytes);
    bytes.fill(120);
    await pending;
    expect(await readFile(path.join(root, "frozen.txt"), "utf8")).toBe("approved");
  });

  it("recovers its private link after interruption between publish and staging cleanup", async () => {
    const { root, grant, service, state } = await fixture();
    const candidateBytes = new TextEncoder().encode("complete published bytes");
    const operation = await service.prepareWrite({
      grantId: grant.id,
      operation: "create",
      relativePath: "interrupted.txt",
      candidatePayloadRef: "payload:interrupted",
      candidateBytes,
      redactedDiffRef: null,
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    const input = {
      operationId: operation.id,
      expectedHash: operation.canonicalHash,
      candidateBytes,
    };
    const originalUnlink = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).unlink;
    const unlink = vi.spyOn(fsPromises, "unlink").mockImplementation(async (filename) => {
      if (String(filename).includes("staged-")) throw new Error("fixture crash before unlink");
      return originalUnlink(filename);
    });
    try {
      await expect(service.executeWrite(input)).rejects.toThrow("fixture crash before unlink");
    } finally {
      unlink.mockRestore();
    }
    const saved = await state.readPrepared(operation.id);
    expect(saved?.publication).toBeDefined();
    if (!saved?.publication) throw new Error("Missing persisted publication evidence");
    expect((await stat(path.join(root, "interrupted.txt"))).nlink).toBe(2);
    expect(await readFile(path.join(root, "interrupted.txt"), "utf8")).toBe(
      "complete published bytes",
    );
    expect((await service.executeWrite(input)).status).toBe("verified");
    expect((await stat(path.join(root, "interrupted.txt"))).nlink).toBe(1);
    await expect(readFile(saved.publication.identity.canonicalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("verifies its own completed publication after grant revocation without writing again", async () => {
    const platform = new CrashAfterEffectPlatform();
    const { root, grant, service, state } = await fixture(platform);
    const candidateBytes = new TextEncoder().encode("saved before revoke");
    const operation = await service.prepareWrite({
      grantId: grant.id,
      operation: "create",
      relativePath: "saved.txt",
      candidatePayloadRef: "payload:save",
      candidateBytes,
      redactedDiffRef: null,
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    platform.arm("create");
    const input = {
      operationId: operation.id,
      expectedHash: operation.canonicalHash,
      candidateBytes,
    };
    await expect(service.executeWrite(input)).rejects.toThrow("fixture crash after create");
    const before = await stat(path.join(root, "saved.txt"));
    state.grants.set(grant.id, { ...grant, revision: 2, revokedAt: "2026-08-28T20:00:00.000Z" });
    expect((await service.executeWrite(input)).status).toBe("verified");
    expect((await stat(path.join(root, "saved.txt"))).ino).toBe(before.ino);
  });

  it("preserves a competing target created after staging without replacing it", async () => {
    const { root, grant, platform } = await fixture();
    await expect(
      platform.createExclusive(grant, "winner.txt", new TextEncoder().encode("candidate"), {
        async beforePublish() {
          await writeFile(path.join(root, "winner.txt"), "other writer");
        },
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(root, "winner.txt"), "utf8")).toBe("other writer");
  });

  it("retains the staged candidate and leaves the target unchanged when authority is withdrawn", async () => {
    const { root, grant, platform } = await fixture();
    let publication: import("@himawari-agent/application").HostFilePublication | undefined;
    await expect(
      platform.createExclusive(grant, "cancelled.txt", new TextEncoder().encode("candidate"), {
        async beforePublish(value) {
          publication = value;
        },
        async assertCurrentAuthority() {
          throw new Error("fixture cancelled");
        },
      }),
    ).rejects.toThrow("fixture cancelled");
    await expect(readFile(path.join(root, "cancelled.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(publication).toBeDefined();
    if (!publication) throw new Error("Missing staged publication evidence");
    expect(await readFile(publication.identity.canonicalPath, "utf8")).toBe("candidate");
  });

  it("does not attribute another writer's identical file to an interrupted operation", async () => {
    class InterruptedCreate extends ConstrainedHostFileSystem {
      override async createExclusive(
        ..._input: Parameters<ConstrainedHostFileSystem["createExclusive"]>
      ): Promise<import("@himawari-agent/application").HostFileIdentity> {
        throw new Error("fixture before effect");
      }
    }
    const { root, service, grant, state } = await fixture(new InterruptedCreate());
    const candidateBytes = new TextEncoder().encode("identical content");
    const prepared = await service.prepareWrite({
      grantId: grant.id,
      operation: "create",
      relativePath: "note.txt",
      candidatePayloadRef: "payload:candidate",
      candidateBytes,
      redactedDiffRef: null,
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    const input = {
      operationId: prepared.id,
      expectedHash: prepared.canonicalHash,
      candidateBytes,
    };
    await expect(service.executeWrite(input)).rejects.toThrow("fixture before effect");
    await writeFile(path.join(root, "note.txt"), candidateBytes);
    await expect(service.executeWrite(input)).rejects.toThrow();
    expect((await state.readPrepared(prepared.id))?.status).not.toBe("verified");
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("identical content");
  });

  it("preserves ordinary permission bits when atomically replacing a file", async () => {
    const { root, platform, grant } = await fixture();
    await writeFile(path.join(root, "script.sh"), "old");
    await chmod(path.join(root, "script.sh"), 0o750);
    const expected = await platform.inspect(grant, "script.sh");
    if (!expected) throw new Error("fixture missing");
    await platform.replaceAtomic(
      grant,
      "script.sh",
      expected,
      new TextEncoder().encode("new"),
      new TextEncoder().encode("old"),
    );
    expect((await stat(path.join(root, "script.sh"))).mode & 0o777).toBe(0o750);
  });

  it("never exposes partial content at a newly created target", async () => {
    const { root, grant, platform } = await fixture();
    const originalOpen = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).open;
    let observeWrite!: () => void;
    let continueWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      observeWrite = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      continueWrite = resolve;
    });
    const open = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile")
            return async (bytes: Uint8Array) => {
              await target.write(bytes.subarray(0, 2), 0, 2, 0);
              observeWrite();
              await resume;
              await target.write(bytes, 0, bytes.length, 0);
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const create = platform.createExclusive(
      grant,
      "complete.txt",
      new TextEncoder().encode("complete"),
    );
    try {
      await writing;
      await expect(readFile(path.join(root, "complete.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      continueWrite();
      await create;
      open.mockRestore();
    }
    expect(await readFile(path.join(root, "complete.txt"), "utf8")).toBe("complete");
  });

  it("leaves no partial final file when preparing a create fails", async () => {
    const { root, grant, platform } = await fixture();
    const originalOpen = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).open;
    const open = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile")
            return async (bytes: Uint8Array) => {
              await target.write(bytes.subarray(0, 2), 0, 2, 0);
              throw new Error("fixture disk write failed");
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(
        platform.createExclusive(grant, "complete.txt", new TextEncoder().encode("complete")),
      ).rejects.toThrow("fixture disk write failed");
    } finally {
      open.mockRestore();
    }
    await expect(readFile(path.join(root, "complete.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves same-inode edits made after write preview", async () => {
    const { root, service, grant, state } = await fixture();
    await writeFile(path.join(root, "note.txt"), "original");
    const candidateBytes = new TextEncoder().encode("new");
    const prepared = await service.prepareWrite({
      grantId: grant.id,
      operation: "update",
      relativePath: "note.txt",
      candidatePayloadRef: "payload:candidate",
      candidateBytes,
      redactedDiffRef: null,
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    await writeFile(path.join(root, "note.txt"), "owner edit");
    await expect(
      service.executeWrite({
        operationId: prepared.id,
        expectedHash: prepared.canonicalHash,
        candidateBytes,
      }),
    ).rejects.toThrow("content changed");
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("owner edit");
    expect((await state.readPrepared(prepared.id))?.status).toBe("invalidated");
  });

  it("checks content again at the platform replacement boundary", async () => {
    const { root, platform, grant } = await fixture();
    await writeFile(path.join(root, "note.txt"), "original");
    const expected = await platform.inspect(grant, "note.txt");
    if (!expected) throw new Error("Missing fixture file");
    await writeFile(path.join(root, "note.txt"), "modified");
    await expect(
      platform.replaceAtomic(
        grant,
        "note.txt",
        expected,
        new TextEncoder().encode("new"),
        new TextEncoder().encode("original"),
      ),
    ).rejects.toThrow("HOST_FILE_CONTENT_CHANGED");
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("modified");
  });

  it("retries an interrupted update whose original content is longer than its replacement", async () => {
    class InterruptedPlatform extends ConstrainedHostFileSystem {
      fail = true;
      override async replaceAtomic(
        ...input: Parameters<ConstrainedHostFileSystem["replaceAtomic"]>
      ) {
        if (this.fail) {
          this.fail = false;
          throw new Error("before replacement");
        }
        return super.replaceAtomic(...input);
      }
    }
    const { root, service, grant } = await fixture(new InterruptedPlatform());
    await writeFile(path.join(root, "note.txt"), "long original content");
    const candidateBytes = new TextEncoder().encode("new");
    const prepared = await service.prepareWrite({
      grantId: grant.id,
      operation: "update",
      relativePath: "note.txt",
      candidatePayloadRef: "payload:candidate",
      candidateBytes,
      redactedDiffRef: null,
      expiresAt: "2026-08-28T20:30:00.000Z",
    });
    const input = {
      operationId: prepared.id,
      expectedHash: prepared.canonicalHash,
      candidateBytes,
    };
    await expect(service.executeWrite(input)).rejects.toThrow("before replacement");
    expect((await service.executeWrite(input)).status).toBe("verified");
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("new");
  });

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

  it("reads every byte when the descriptor returns short reads", async () => {
    const { root, grant, platform } = await fixture();
    await writeFile(path.join(root, "short.txt"), "short reads must not produce zero padding");
    const originalOpen = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).open;
    const open = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read")
            return (buffer: Uint8Array, offset: number, length: number, position: number) =>
              target.read(buffer, offset, Math.min(length, 2), position);
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      expect(new TextDecoder().decode(await platform.read(grant, "short.txt", 1024))).toBe(
        "short reads must not produce zero padding",
      );
    } finally {
      open.mockRestore();
    }
  });

  it("checks the opened descriptor against the inspected file identity", async () => {
    const { root, grant, platform } = await fixture();
    await writeFile(path.join(root, "identity.txt"), "original");
    const expected = await platform.inspect(grant, "identity.txt");
    if (!expected) throw new Error("identity missing");
    await rename(path.join(root, "identity.txt"), path.join(root, "original.txt"));
    await writeFile(path.join(root, "identity.txt"), "replaced");
    await expect(platform.read(grant, "identity.txt", 1024, expected)).rejects.toThrow(
      "HOST_FILE_IDENTITY_CHANGED",
    );
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

describe("host file read target resolution", () => {
  function resolver(f: Awaited<ReturnType<typeof fixture>>) {
    const protect = vi.fn(async () => "unexpected-payload");
    const service = new HostFileReadService({
      state: f.state,
      platform: f.platform,
      disclosure: { protect },
      hostId: "host-mac",
      clock: { now: () => "2026-08-28T20:00:00.000Z" },
    });
    const resolve = (filePath: string, maximumBytes = 64) =>
      service.resolveTarget({
        hostId: "host-mac",
        grantId: f.grant.id,
        path: filePath,
        maximumBytes,
      });
    return { service, resolve, protect };
  }

  it("binds absolute and relative paths to the same host, grant revision and file identity without reading content", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "中文.txt"), "sample");
    const read = vi.spyOn(f.platform, "read");
    const { resolve, protect } = resolver(f);
    const absolute = await resolve(path.join(f.root, "中文.txt"));
    const relative = await resolve("中文.txt");
    expect(absolute).toMatchObject({
      hostId: "host-mac",
      grantId: f.grant.id,
      grantRevision: f.grant.revision,
      canonicalRootId: f.grant.canonicalRootId,
      authorizationRef: f.grant.authorizationRef,
      relativePath: "中文.txt",
      maximumBytes: 64,
      identity: { sizeBytes: 6 },
    });
    expect(absolute.identity).toEqual(relative.identity);
    expect(Object.isFrozen(absolute)).toBe(true);
    expect(Object.isFrozen(absolute.identity)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(protect).not.toHaveBeenCalled();
  });

  it.each([
    "../outside.txt",
    "sub/../file.txt",
    "/other/file.txt",
    "~/file.txt",
    "@file.txt",
    "a\\b.txt",
    "file\u0000.txt",
    "",
    "sub//file.txt",
  ])("rejects unsafe path %j before filesystem inspection", async (filePath) => {
    const f = await fixture();
    const inspect = vi.spyOn(f.platform, "inspect");
    await expect(resolver(f).resolve(filePath)).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects sibling prefixes, links, directories, missing files and files over the byte limit", async () => {
    const f = await fixture();
    const { resolve } = resolver(f);
    await writeFile(path.join(f.root, "file.txt"), "12345");
    await mkdir(path.join(f.root, "directory"));
    await expect(resolve(`${f.root}-sibling/file.txt`)).rejects.toThrow("HOST_PATH_ESCAPE_BLOCKED");
    await expect(resolve("file.txt", 4)).rejects.toThrow("HOST_FILE_READ_LIMIT_EXCEEDED");
    expect((await resolve("file.txt", 5)).identity.sizeBytes).toBe(5);
    await expect(resolve("directory")).rejects.toThrow("HOST_FILE_NOT_REGULAR");
    await expect(resolve("missing.txt")).rejects.toThrow("HOST_FILE_TARGET_MISSING");
    await expect(resolve("missing/file.txt")).rejects.toThrow("HOST_FILE_TARGET_MISSING");
    await symlink(path.join(f.root, "file.txt"), path.join(f.root, "symbolic"));
    await expect(resolve("symbolic")).rejects.toThrow("HOST_PATH_ESCAPE_BLOCKED");
    await symlink(f.root, path.join(f.root, "linked-directory"));
    await expect(resolve("linked-directory/file.txt")).rejects.toThrow("HOST_PATH_ESCAPE_BLOCKED");
    await link(path.join(f.root, "file.txt"), path.join(f.root, "hard-link"));
    await expect(resolve("hard-link")).rejects.toThrow("HOST_LINK_ESCAPE_BLOCKED");
  });

  it.each(["revoked", "expired", "wrong-host", "no-read", "invalid-expiry"])(
    "rejects an unusable grant (%s) before filesystem inspection",
    async (mode) => {
      const f = await fixture();
      const changes = {
        revoked: { revokedAt: "2026-08-28T19:00:00.000Z" },
        expired: { expiresAt: "2026-08-28T19:00:00.000Z" },
        "wrong-host": { hostId: "host-hermes" },
        "no-read": { operations: [] },
        "invalid-expiry": { expiresAt: "invalid" },
      };
      f.state.grants.set(f.grant.id, { ...f.grant, ...changes[mode as keyof typeof changes] });
      const inspect = vi.spyOn(f.platform, "inspect");
      await expect(resolver(f).resolve("file.txt")).rejects.toThrow();
      expect(inspect).not.toHaveBeenCalled();
    },
  );

  it("rejects a request for another host and invalid size limits before inspection", async () => {
    const f = await fixture();
    const { service, resolve } = resolver(f);
    const inspect = vi.spyOn(f.platform, "inspect");
    await expect(
      service.resolveTarget({
        hostId: "host-hermes",
        grantId: f.grant.id,
        path: "file.txt",
        maximumBytes: 64,
      }),
    ).rejects.toThrow();
    for (const size of [0, -1, NaN, Infinity, 1.5])
      await expect(resolve("file.txt", size)).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(["revocation", "replacement"])("rejects %s during inspection", async (change) => {
    const f = await fixture();
    await writeFile(path.join(f.root, "file.txt"), "sample");
    const original = f.platform.inspect.bind(f.platform);
    vi.spyOn(f.platform, "inspect").mockImplementation(async (grant, relativePath) => {
      const identity = await original(grant, relativePath);
      f.state.grants.set(
        grant.id,
        change === "revocation"
          ? { ...grant, revokedAt: "2026-08-28T20:00:00.000Z" }
          : { ...grant, revision: grant.revision + 1 },
      );
      return identity;
    });
    await expect(resolver(f).resolve("file.txt")).rejects.toThrow();
  });

  it("rejects replacement of the granted root directory", async () => {
    const f = await fixture();
    const oldRoot = `${f.root}-old`;
    await rename(f.root, oldRoot);
    roots.push(oldRoot);
    await mkdir(f.root);
    await writeFile(path.join(f.root, "file.txt"), "sample");
    await expect(resolver(f).resolve("file.txt")).rejects.toThrow("HOST_ROOT_IDENTITY_CHANGED");
  });
});

it.each(["current_path", "opened_version"] as const)(
  "preserves the chosen read contract during atomic replacement: %s",
  async (consistency) => {
    const { grant, platform } = await fixture();
    const target = path.join(grant.displayPath, "atomic-read.txt");
    await writeFile(target, "complete old version");
    const expected = await platform.inspect(grant, "atomic-read.txt");
    if (!expected) throw new Error("fixture file missing");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let replaced = false;
    const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await original.open(...args);
      if (String(args[0]) === expected.canonicalPath && !replaced) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...values) => {
          if (!replaced) {
            replaced = true;
            await platform.replaceAtomic(
              grant,
              "atomic-read.txt",
              expected,
              new TextEncoder().encode("complete new version"),
              new TextEncoder().encode("complete old version"),
            );
          }
          return read(...values);
        });
      }
      return handle;
    });
    try {
      const reading = platform.read(grant, "atomic-read.txt", 100, expected, consistency);
      if (consistency === "opened_version")
        expect(new TextDecoder().decode(await reading)).toBe("complete old version");
      else await expect(reading).rejects.toThrow("HOST_FILE_CONTENT_CHANGED");
      expect(await readFile(target, "utf8")).toBe("complete new version");
    } finally {
      openSpy.mockRestore();
    }
  },
);
