import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DurableHostWorkspaceStateAdapter,
  FileOperationService,
  type StateStorePort,
} from "@himawari-agent/application";
import { createIdempotencyKey } from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { ConstrainedHostFileSystem } from "@himawari-agent/platform-node";
import { describe, expect, it } from "vitest";
import {
  AGENT_ID,
  OWNER_ID,
  openRepository,
  SERVICE_AUTHORITY,
  T0,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

class InterruptedPublication extends ConstrainedHostFileSystem {
  override async createExclusive(
    ...input: Parameters<ConstrainedHostFileSystem["createExclusive"]>
  ): Promise<never> {
    await super.createExclusive(...input);
    throw new Error("fixture process died after publication");
  }
}

function service(repository: SqliteProductStateRepository, platform: ConstrainedHostFileSystem) {
  const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const state: StateStorePort = {
    read: (key) => repository.readScopedState(OWNER_ID, AGENT_ID, key),
    async compareAndSet(input) {
      const fingerprint = digest(JSON.stringify(input));
      return (
        await repository.commitStateAndEvents({
          command: {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            idempotencyKey: createIdempotencyKey(`publication:${fingerprint}`),
            commandType: "file.publication",
            commandFingerprint: fingerprint,
            authority: SERVICE_AUTHORITY.lease,
          },
          state: input,
          events: [],
          resultRef: `publication:${fingerprint}`,
          committedAt: T0,
        })
      ).state;
    },
  };
  let sequence = 0;
  return new FileOperationService({
    state: new DurableHostWorkspaceStateAdapter(state),
    platform,
    digest: {
      digest: (bytes) => `sha256:${digest(bytes)}`,
      digestCanonical: (value) => `sha256:${digest(value)}`,
    },
    clock: { now: () => T0 },
    ids: { next: (prefix) => `${prefix}:publication-fixture:${++sequence}` },
    hostId: "host-publication",
  });
}

describe("file publication durable ownership", () => {
  it("retains per-file partial results after restart without rolling back later edits", async () => {
    const resource = await openRepository();
    let repository = resource.repository;
    const root = path.join(resource.stateRoot, "workspace");
    await mkdir(root, { mode: 0o700 });
    try {
      const files = service(repository, new ConstrainedHostFileSystem());
      const grant = await files.grant({
        hostId: "host-publication",
        displayPath: root,
        operations: ["create", "read"],
        dataClassification: "private",
        disclosure: "none",
        pathPolicy: "same_filesystem_no_links",
        mountPolicy: "fixed_device",
        authorizationRef: "authorization:publication",
        expiresAt: T2,
        revokedAt: null,
      });
      const candidateBytes = Buffer.from("candidate");
      const operations = [];
      for (const name of ["first.txt", "second.txt", "third.txt"])
        operations.push(
          await files.prepareWrite({
            grantId: grant.id,
            operation: "create",
            relativePath: name,
            candidatePayloadRef: `payload:${name}`,
            candidateBytes,
            redactedDiffRef: null,
            expiresAt: T2,
          }),
        );
      const inputs = operations.map((operation) => ({
        operationId: operation.id,
        expectedHash: operation.canonicalHash,
        candidateBytes,
      }));
      const [first, second, third] = inputs;
      if (!first || !second || !third) throw new Error("fixture operations missing");
      expect((await files.executeWrite(first)).status).toBe("verified");
      const crashing = service(repository, new InterruptedPublication());
      await expect(crashing.executeWrite(second)).rejects.toThrow("fixture process died");
      await writeFile(path.join(root, "first.txt"), "newer user edit");
      await repository.close();
      repository = await SqliteProductStateRepository.open({ stateRoot: resource.stateRoot });
      const resumed = service(repository, new ConstrainedHostFileSystem());
      expect((await resumed.executeWrite(first)).status).toBe("verified");
      expect((await resumed.executeWrite(second)).status).toBe("verified");
      expect(await readFile(path.join(root, "first.txt"), "utf8")).toBe("newer user edit");
      expect(await readFile(path.join(root, "second.txt"), "utf8")).toBe("candidate");
      await expect(stat(path.join(root, "third.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await resumed.executeWrite(third)).status).toBe("verified");
    } finally {
      await repository.close();
      await rm(resource.stateRoot, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "uses persisted inode evidence after restart (target replaced: %s)",
    async (replaced) => {
      const resource = await openRepository();
      let repository = resource.repository;
      const root = path.join(resource.stateRoot, "workspace");
      await mkdir(root, { mode: 0o700 });
      try {
        let files = service(repository, new InterruptedPublication());
        const grant = await files.grant({
          hostId: "host-publication",
          displayPath: root,
          operations: ["create", "read"],
          dataClassification: "private",
          disclosure: "none",
          pathPolicy: "same_filesystem_no_links",
          mountPolicy: "fixed_device",
          authorizationRef: "authorization:publication",
          expiresAt: T2,
          revokedAt: null,
        });
        const candidateBytes = new TextEncoder().encode("durable candidate");
        const operation = await files.prepareWrite({
          grantId: grant.id,
          operation: "create",
          relativePath: "note.txt",
          candidatePayloadRef: "payload:candidate",
          candidateBytes,
          redactedDiffRef: null,
          expiresAt: T2,
        });
        const input = {
          operationId: operation.id,
          expectedHash: operation.canonicalHash,
          candidateBytes,
        };
        await expect(files.executeWrite(input)).rejects.toThrow(
          "fixture process died after publication",
        );
        const before = await stat(path.join(root, "note.txt"));
        await repository.close();
        const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
        const row = database
          .prepare(
            "SELECT value_json AS json FROM product_state_records WHERE value_json LIKE '%stagedRelativePath%'",
          )
          .get() as { json: string };
        const persisted = JSON.parse(row.json);
        expect(persisted.status).toBe("executing");
        expect(persisted.publication.identity.inode).toBe(String(before.ino));
        database.close();
        if (replaced) {
          await rename(path.join(root, "note.txt"), path.join(root, "original.txt"));
          await writeFile(path.join(root, "note.txt"), candidateBytes);
        }
        repository = await SqliteProductStateRepository.open({ stateRoot: resource.stateRoot });
        files = service(repository, new ConstrainedHostFileSystem());
        if (replaced)
          await expect(files.executeWrite(input)).rejects.toThrow(
            "HOST_FILE_PUBLICATION_UNVERIFIED",
          );
        else {
          expect((await files.executeWrite(input)).status).toBe("verified");
          expect((await stat(path.join(root, "note.txt"))).ino).toBe(before.ino);
        }
        expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("durable candidate");
      } finally {
        await repository.close();
        await rm(resource.stateRoot, { recursive: true, force: true });
      }
    },
  );
});
