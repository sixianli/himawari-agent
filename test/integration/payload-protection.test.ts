import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  ContentAddressedCiphertextStore,
  EnvelopePayloadProtector,
  HybridPayloadStore,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-payload-integration");
const AGENT_ID = createAgentId("agent-payload-integration");
const KEY = Uint8Array.from({ length: 32 }, (_, index) => 127 - index);

describe("production Payload persistence", () => {
  it("restores a file-backed authenticated envelope without persisting its KEK", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-payload-integration-"));
    try {
      const databasePath = path.join(stateRoot, "product.sqlite");
      const database = openQualifiedDatabase(databasePath);
      applyMigrations(database, await loadBundledMigrations());
      database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run(AGENT_ID, OWNER_ID);
      database
        .prepare(
          `INSERT INTO deployments (
            id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
          ) VALUES ('deployment-payload', ?, ?, 0, 'active', 1, 1)`,
        )
        .run(OWNER_ID, AGENT_ID);
      database.close();

      const files = new ContentAddressedCiphertextStore(path.join(stateRoot, "payload-ciphertext"));
      await files.initialize();
      const protector = new EnvelopePayloadProtector({
        keys: new InMemoryDevelopmentSecretSource({ "payload-kek@v1": KEY }),
        activeKey: { keyRef: "payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
      });
      const plaintext = new TextEncoder().encode("private payload ".repeat(32));

      let repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
      let store = new HybridPayloadStore({
        metadata: repository.payloadStore(OWNER_ID, AGENT_ID),
        files,
        fileThresholdBytes: 32,
      });
      const protectedPayload = await protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: "payload-integration",
        dataClassification: "restricted",
        contentType: "text/plain",
        plaintext,
        createdAt: "2026-08-26T00:00:00.000Z",
      });
      await store.put(protectedPayload);
      await repository.close();

      repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
      store = new HybridPayloadStore({
        metadata: repository.payloadStore(OWNER_ID, AGENT_ID),
        files,
        fileThresholdBytes: 32,
      });
      const restored = await store.get("payload-integration");
      expect(restored?.storage?.kind).toBe("ciphertext_file");
      if (!restored) throw new Error("payload was not restored");
      await expect(
        protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload: restored }),
      ).resolves.toEqual(plaintext);
      await repository.close();

      const databaseBytes = await readFile(databasePath);
      const serializedDatabase = databaseBytes.toString("utf8");
      expect(serializedDatabase).not.toContain(Buffer.from(KEY).toString("base64"));
      expect(serializedDatabase).not.toContain(Buffer.from(KEY).toString("hex"));
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
