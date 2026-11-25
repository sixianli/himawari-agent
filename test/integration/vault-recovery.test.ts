import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type VaultNotifierPort,
  type VaultReleaseOutcome,
  VaultService,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { NodeVaultCrypto } from "@himawari-agent/platform-node";
import { VaultTestPhone } from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = createOwnerId("owner-vault-recovery");
const AGENT_ID = createAgentId("agent-vault-recovery");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const DEVICE = "device-vault-phone-0001";

describe("[vault-recovery] rotating the master key", () => {
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("re-encrypts every item; the old item key no longer opens the new ciphertext", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-vault-rotate-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => new Date().toISOString(),
    });
    closers.push(() => repository.close());
    const notified: string[] = [];
    const notifier: VaultNotifierPort = {
      approvalNeeded: async (input) => {
        notified.push(input.requestId);
      },
    };
    const service = new VaultService({
      store: repository.vault(),
      crypto: new NodeVaultCrypto(),
      notifier,
      now: () => new Date(),
    });
    const phone = new VaultTestPhone();
    const added = phone.add({
      name: "API",
      kind: "api_key",
      origins: ["https://api.example.com"],
      values: { api_key: "secret-key" },
    });
    await service.applyDeviceChange(scope, added.change);
    const before = (await repository.vault().listItems(scope))[0];
    await service.applyDeviceChange(scope, phone.rotate());
    const after = (await repository.vault().listItems(scope))[0];
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.wrappedKey).not.toBe(before?.wrappedKey);
    expect(after?.ciphertexts["api_key"]).not.toBe(before?.ciphertexts["api_key"]);
    const releasing = service.requestRelease({
      ...scope,
      runId: null,
      itemIds: [added.id],
      origin: "https://api.example.com",
      pageVersion: null,
      purpose: "",
      background: false,
    });
    await vi.waitFor(() => expect(notified).toHaveLength(1), { timeout: 10_000 });
    const request = (await service.snapshot(scope)).pending[0];
    if (!request) throw new Error("missing request");
    await service.approve(
      scope,
      { deviceId: DEVICE, confirmed: true },
      await phone.approval({ request, deviceId: DEVICE }),
    );
    const outcome = (await releasing) as Extract<VaultReleaseOutcome, { kind: "approved" }>;
    expect(outcome.secrets.items[0]?.fields.get("api_key")?.toString("utf8")).toBe("secret-key");
    outcome.secrets.wipe();
  });

  it("a rotation that leaves out an existing item is refused", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-vault-rotate-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => new Date().toISOString(),
    });
    closers.push(() => repository.close());
    const service = new VaultService({
      store: repository.vault(),
      crypto: new NodeVaultCrypto(),
      notifier: { approvalNeeded: async () => undefined },
      now: () => new Date(),
    });
    const phone = new VaultTestPhone();
    await service.applyDeviceChange(
      scope,
      phone.add({
        name: "A",
        kind: "api_key",
        origins: ["https://a.example.com"],
        values: { api_key: "a" },
      }).change,
    );
    await service.applyDeviceChange(
      scope,
      phone.add({
        name: "B",
        kind: "api_key",
        origins: ["https://b.example.com"],
        values: { api_key: "b" },
      }).change,
    );
    const rotation = phone.rotate();
    await expect(
      service.applyDeviceChange(scope, { ...rotation, upserts: rotation.upserts.slice(0, 1) }),
    ).rejects.toMatchObject({ code: "VAULT_ITEM_NOT_FOUND" });
  });
});
