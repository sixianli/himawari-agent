import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type VaultCryptoPort,
  type VaultNotifierPort,
  type VaultReleaseOutcome,
  VaultService,
  type VaultStorePort,
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

const bankPw = `pw-${randomBytes(6).toString("hex")}`;
const OWNER_ID = createOwnerId("owner-vault");
const AGENT_ID = createAgentId("agent-vault");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const BANK = "https://bank.example.com";
const DEVICE = "device-vault-phone-0001";

function override<T extends object>(real: T, replacements: Partial<T>): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (Object.hasOwn(replacements, property)) return replacements[property as keyof T];
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}

function flipCharacter(value: string): string {
  const index = 10;
  const replacement = value[index] === "A" ? "B" : "A";
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

describe("[vault-approval] one approval releases exactly the requested items once", () => {
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(
    wrap: {
      crypto?: (real: VaultCryptoPort) => VaultCryptoPort;
      store?: (real: VaultStorePort) => VaultStorePort;
    } = {},
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-vault-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    let clock = Date.parse("2026-11-25T01:00:00.000Z");
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => new Date(clock).toISOString(),
    });
    closers.push(() => repository.close());
    const timers: (() => void)[] = [];
    const notified: string[] = [];
    const notifier: VaultNotifierPort = {
      approvalNeeded: async (input) => {
        notified.push(input.requestId);
      },
    };
    const service = new VaultService({
      store: wrap.store ? wrap.store(repository.vault()) : repository.vault(),
      crypto: wrap.crypto ? wrap.crypto(new NodeVaultCrypto()) : new NodeVaultCrypto(),
      notifier,
      now: () => new Date(clock),
      setTimer: (callback) => {
        timers.push(callback);
        return { cancel: () => undefined };
      },
    });
    const phone = new VaultTestPhone();
    const advance = (milliseconds: number) => {
      clock += milliseconds;
    };
    return { service, phone, repository, notified, timers, advance, stateRoot };
  }

  async function withItem(
    context: Awaited<ReturnType<typeof setup>>,
    values: Record<string, string> = { username: "andy", password: bankPw },
  ) {
    const added = context.phone.add({
      name: "招商银行网银",
      kind: "login",
      origins: [BANK],
      values,
    });
    await context.service.applyDeviceChange(scope, added.change);
    return added.id;
  }

  async function pending(
    context: Awaited<ReturnType<typeof setup>>,
    itemIds: readonly string[],
    origin = BANK,
  ) {
    const outcome = context.service.requestRelease({
      ...scope,
      runId: "run-1",
      itemIds,
      origin,
      pageVersion: "page-1",
      purpose: "登录查余额",
      background: false,
    });
    const before = context.notified.length;
    await vi.waitFor(() => expect(context.notified.length).toBe(before + 1), { timeout: 10_000 });
    const snapshot = await context.service.snapshot(scope);
    const request = snapshot.pending.find((entry) => entry.id === context.notified.at(-1));
    if (!request) throw new Error("no pending request");
    return { outcome, request };
  }

  it("releases the values once after a confirmed approval and never twice", async () => {
    const context = await setup();
    const itemId = await withItem(context);
    const { outcome, request } = await pending(context, [itemId]);
    expect(context.notified).toEqual([request.id]);
    const body = await context.phone.approval({ request, deviceId: DEVICE });
    await context.service.approve(scope, { deviceId: DEVICE, confirmed: true }, body);
    const result = (await outcome) as Extract<VaultReleaseOutcome, { kind: "approved" }>;
    expect(result.kind).toBe("approved");
    expect(result.secrets.items[0]?.fields.get("password")?.toString("utf8")).toBe(bankPw);
    expect(result.secrets.items[0]?.fields.get("username")?.toString("utf8")).toBe("andy");
    result.secrets.wipe();
    expect(result.secrets.items[0]?.fields.get("password")?.every((byte) => byte === 0)).toBe(true);
    await expect(
      context.service.approve(scope, { deviceId: DEVICE, confirmed: true }, body),
    ).rejects.toMatchObject({ code: "VAULT_REQUEST_CLOSED" });
  });

  it("refuses an approval without the Face ID confirmation signature", async () => {
    const context = await setup();
    const itemId = await withItem(context);
    const { request } = await pending(context, [itemId]);
    const body = await context.phone.approval({ request, deviceId: DEVICE });
    await expect(
      context.service.approve(scope, { deviceId: DEVICE, confirmed: false }, body),
    ).rejects.toMatchObject({ code: "VAULT_CONFIRMATION_REQUIRED" });
  });

  it.each([
    ["nonce", (body: Record<string, unknown>) => ({ ...body, nonce: "A".repeat(43) })],
    [
      "origin",
      (body: Record<string, unknown>) => ({ ...body, origin: "https://evil.example.com" }),
    ],
    ["page version", (body: Record<string, unknown>) => ({ ...body, pageVersion: "page-2" })],
    [
      "ephemeral key",
      (body: Record<string, unknown>) => ({
        ...body,
        ephemeralPublicKey: flipCharacter(String(body["ephemeralPublicKey"])),
      }),
    ],
    [
      "expiry",
      (body: Record<string, unknown>) => ({ ...body, expiresAt: "2099-01-01T00:00:00.000Z" }),
    ],
    [
      "item list",
      (body: Record<string, unknown>) => ({ ...body, itemIds: ["vi_AAAAAAAAAAAAAAAAAAAAAA"] }),
    ],
    ["item version", (body: Record<string, unknown>) => ({ ...body, itemVersions: [2] })],
    [
      "device",
      (body: Record<string, unknown>) => ({ ...body, deviceId: "device-other-000000001" }),
    ],
  ])("refuses an approval whose %s differs from the request", async (_name, mutate) => {
    const context = await setup();
    const itemId = await withItem(context);
    const { request } = await pending(context, [itemId]);
    const body = await context.phone.approval({ request, deviceId: DEVICE });
    await expect(
      context.service.approve(scope, { deviceId: DEVICE, confirmed: true }, mutate(body)),
    ).rejects.toMatchObject({ code: "VAULT_REQUEST_MISMATCH" });
  });

  it("refuses an approval after the request expired", async () => {
    const context = await setup();
    const itemId = await withItem(context);
    const { outcome, request } = await pending(context, [itemId]);
    const body = await context.phone.approval({ request, deviceId: DEVICE });
    context.advance(121_000);
    await expect(
      context.service.approve(scope, { deviceId: DEVICE, confirmed: true }, body),
    ).rejects.toMatchObject({ code: "VAULT_REQUEST_CLOSED" });
    for (const fire of context.timers) fire();
    expect((await outcome).kind).toBe("expired");
  });

  it("refuses to ask for an item on a website it is not allowed on", async () => {
    const context = await setup();
    const itemId = await withItem(context);
    await expect(
      context.service.requestRelease({
        ...scope,
        runId: null,
        itemIds: [itemId],
        origin: "https://bank.example.com.evil.test",
        pageVersion: null,
        purpose: "",
        background: false,
      }),
    ).rejects.toMatchObject({ code: "VAULT_ORIGIN_NOT_ALLOWED" });
    await expect(
      context.service.requestRelease({
        ...scope,
        runId: null,
        itemIds: [itemId],
        origin: BANK,
        pageVersion: null,
        purpose: "",
        background: true,
      }),
    ).rejects.toMatchObject({ code: "VAULT_BACKGROUND_NOT_ALLOWED" });
  });

  it("detects a ciphertext the server swapped from another item", async () => {
    const context = await setup();
    const bank = await withItem(context);
    const other = context.phone.add({
      name: "论坛",
      kind: "login",
      origins: [BANK],
      values: { password: "forum-pw" },
    });
    await context.service.applyDeviceChange(scope, other.change);
    const database = openQualifiedDatabase(path.join(context.stateRoot, "product.sqlite"));
    const bankRow = database
      .prepare("SELECT ciphertexts FROM vault_items WHERE id = ?")
      .get(bank) as { ciphertexts: string };
    database
      .prepare("UPDATE vault_items SET ciphertexts = ? WHERE id = ?")
      .run(bankRow.ciphertexts, other.id);
    database.close();
    const { outcome, request } = await pending(context, [other.id]);
    const body = await context.phone.approval({ request, deviceId: DEVICE });
    await expect(
      context.service.approve(scope, { deviceId: DEVICE, confirmed: true }, body),
    ).rejects.toMatchObject({ code: "VAULT_RELEASE_UNREADABLE" });
    expect((await outcome).kind).toBe("denied");
  });

  it("refuses a rolled back or replayed item list", async () => {
    const context = await setup();
    const first = context.phone.add({
      name: "A",
      kind: "api_key",
      origins: ["https://api.example.com"],
      values: { api_key: "k1" },
    });
    await context.service.applyDeviceChange(scope, first.change);
    await expect(context.service.applyDeviceChange(scope, first.change)).rejects.toMatchObject({
      code: "VAULT_MANIFEST_CONFLICT",
    });
    const stale = {
      ...first.change,
      expectedManifestVersion: 1,
      manifest: { ...first.change.manifest, version: 2 },
    };
    await expect(context.service.applyDeviceChange(scope, stale)).rejects.toMatchObject({
      code: "VAULT_VERSION_NOT_NEWER",
    });
  });

  it("a denial closes the request and records it", async () => {
    const context = await setup();
    const itemId = await withItem(context);
    const { outcome, request } = await pending(context, [itemId]);
    await context.service.deny(scope, { requestId: request.id, nonce: request.nonce });
    expect((await outcome).kind).toBe("denied");
    expect(
      (await context.service.usage(scope, itemId)).map((entry) => [entry.outcome, entry.purpose]),
    ).toEqual([["denied", "登录查余额"]]);
  });

  it("hands over two-step codes the phone computed without the seed", async () => {
    const context = await setup();
    const itemId = await withItem(context, { password: "pw", totp: "JBSWY3DPEHPK3PXP" });
    const { outcome, request } = await pending(context, [itemId]);
    await context.service.approve(
      scope,
      { deviceId: DEVICE, confirmed: true },
      await context.phone.approval({ request, deviceId: DEVICE }),
    );
    const result = (await outcome) as Extract<VaultReleaseOutcome, { kind: "approved" }>;
    expect(result.secrets.items[0]?.fields.has("totp")).toBe(false);
    expect(result.secrets.items[0]?.totp).toHaveLength(4);
    result.secrets.wipe();
  });

  it("wipes the fields it already decrypted when a later field fails to decrypt", async () => {
    const decrypted: Uint8Array[] = [];
    const context = await setup({
      crypto: (real) =>
        override<VaultCryptoPort>(real, {
          decryptField(itemKey: Uint8Array, ciphertext: string, aad: Uint8Array) {
            if (decrypted.length === 1) throw new Error("second field unreadable");
            const plain = real.decryptField(itemKey, ciphertext, aad);
            decrypted.push(plain);
            return plain;
          },
        }),
    });
    const itemId = await withItem(context);
    const { outcome, request } = await pending(context, [itemId]);
    const body = await context.phone.approval({ request, deviceId: DEVICE });
    await expect(
      context.service.approve(scope, { deviceId: DEVICE, confirmed: true }, body),
    ).rejects.toMatchObject({ code: "VAULT_RELEASE_UNREADABLE" });
    expect((await outcome).kind).toBe("denied");
    expect(decrypted).toHaveLength(1);
    expect(decrypted[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it("wipes the released values and records a failed use when writing the approval fails", async () => {
    const decrypted: Uint8Array[] = [];
    const context = await setup({
      crypto: (real) =>
        override<VaultCryptoPort>(real, {
          decryptField(itemKey: Uint8Array, ciphertext: string, aad: Uint8Array) {
            const plain = real.decryptField(itemKey, ciphertext, aad);
            decrypted.push(plain);
            return plain;
          },
        }),
      store: (real) =>
        override<VaultStorePort>(real, {
          async decideRequest(input: Parameters<VaultStorePort["decideRequest"]>[0]) {
            if (input.status === "approved") throw new Error("request table unavailable");
            return real.decideRequest(input);
          },
        }),
    });
    const itemId = await withItem(context);
    const { outcome, request } = await pending(context, [itemId]);
    const body = await context.phone.approval({ request, deviceId: DEVICE });
    await expect(
      context.service.approve(scope, { deviceId: DEVICE, confirmed: true }, body),
    ).rejects.toThrow("request table unavailable");
    expect((await outcome).kind).toBe("denied");
    expect(decrypted).toHaveLength(2);
    expect(decrypted.every((plain) => plain.every((byte) => byte === 0))).toBe(true);
    expect((await context.service.usage(scope, itemId)).map((entry) => entry.outcome)).toEqual([
      "failed",
    ]);
  });

  it("tells the phone when even the failed use cannot be written, and records it once the store is back", async () => {
    let broken = true;
    const context = await setup({
      store: (real) =>
        override<VaultStorePort>(real, {
          async decideRequest(input: Parameters<VaultStorePort["decideRequest"]>[0]) {
            if (broken) throw new Error("disk full");
            return real.decideRequest(input);
          },
        }),
    });
    const itemId = await withItem(context);
    const { outcome, request } = await pending(context, [itemId]);
    await expect(
      context.service.approve(
        scope,
        { deviceId: DEVICE, confirmed: true },
        await context.phone.approval({ request, deviceId: DEVICE }),
      ),
    ).rejects.toThrow("disk full");
    expect((await outcome).kind).toBe("denied");
    broken = false;
    context.advance(121_000);
    expect((await context.service.usage(scope, itemId)).map((entry) => entry.outcome)).toEqual([
      "expired",
    ]);
  });

  it("keeps an approval whose decision is being written when the request timer fires", async () => {
    const fire: { timers: (() => void)[] } = { timers: [] };
    const context = await setup({
      store: (real) =>
        override<VaultStorePort>(real, {
          async decideRequest(input: Parameters<VaultStorePort["decideRequest"]>[0]) {
            if (input.status === "approved") {
              for (const timer of fire.timers) timer();
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return real.decideRequest(input);
          },
        }),
    });
    fire.timers = context.timers;
    const itemId = await withItem(context);
    const { outcome, request } = await pending(context, [itemId]);
    await context.service.approve(
      scope,
      { deviceId: DEVICE, confirmed: true },
      await context.phone.approval({ request, deviceId: DEVICE }),
    );
    const result = await outcome;
    expect(result.kind).toBe("approved");
    if (result.kind === "approved") result.secrets.wipe();
    expect((await context.service.usage(scope, itemId)).map((entry) => entry.outcome)).toEqual([
      "approved",
    ]);
  });

  it("closes the request when the expiry cannot be written, and records it once the store is back", async () => {
    let broken = false;
    const context = await setup({
      store: (real) =>
        override<VaultStorePort>(real, {
          async decideRequest(input: Parameters<VaultStorePort["decideRequest"]>[0]) {
            if (broken) throw new Error("database locked");
            return real.decideRequest(input);
          },
        }),
    });
    const itemId = await withItem(context);
    const { outcome, request } = await pending(context, [itemId]);
    const body = await context.phone.approval({ request, deviceId: DEVICE });
    broken = true;
    for (const fire of context.timers) fire();
    expect((await outcome).kind).toBe("expired");
    broken = false;
    await expect(
      context.service.approve(scope, { deviceId: DEVICE, confirmed: true }, body),
    ).rejects.toMatchObject({ code: "VAULT_REQUEST_CLOSED" });
    context.advance(121_000);
    expect((await context.service.usage(scope, itemId)).map((entry) => entry.outcome)).toEqual([
      "expired",
    ]);
  });

  it("still lists the vault and its use when recording overdue requests fails", async () => {
    let broken = false;
    const context = await setup({
      store: (real) =>
        override<VaultStorePort>(real, {
          async decideRequest(input: Parameters<VaultStorePort["decideRequest"]>[0]) {
            if (broken) throw new Error("disk full");
            return real.decideRequest(input);
          },
          async expireOverdue(input: Parameters<VaultStorePort["expireOverdue"]>[0]) {
            if (broken) throw new Error("disk full");
            return real.expireOverdue(input);
          },
        }),
    });
    const itemId = await withItem(context);
    const { outcome } = await pending(context, [itemId]);
    broken = true;
    for (const fire of context.timers) fire();
    expect((await outcome).kind).toBe("expired");
    context.advance(121_000);
    const snapshot = await context.service.snapshot(scope);
    expect(snapshot.items.map((item) => item.id)).toEqual([itemId]);
    expect(snapshot.pending).toEqual([]);
    expect(await context.service.usage(scope, itemId)).toEqual([]);
    broken = false;
    expect((await context.service.usage(scope, itemId)).map((entry) => entry.outcome)).toEqual([
      "expired",
    ]);
  });

  it("records the requests a key change closed", async () => {
    const context = await setup();
    const itemId = await withItem(context);
    const { outcome } = await pending(context, [itemId]);
    await context.service.applyDeviceChange(scope, context.phone.remove(itemId));
    expect((await outcome).kind).toBe("denied");
    expect((await context.service.usage(scope, itemId)).map((entry) => entry.outcome)).toEqual([
      "denied",
    ]);
  });
});
