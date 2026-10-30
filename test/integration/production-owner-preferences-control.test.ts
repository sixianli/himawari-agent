import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  type GatewayV2Command,
  type GatewayV2Query,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionOwnerPreferencesControl } from "../../apps/agent-service/src/production-owner-preferences-control.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-preferences-control");
const AGENT_ID = createAgentId("agent-preferences-control");
const T0 = "2026-10-29T05:00:00.000Z";
const T1 = "2026-10-29T05:10:00.000Z";

function message(kind: "command" | "query", type: string, payload: unknown, actorType = "owner") {
  return gatewayV2MessageSchema.parse({
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `message-${type}`,
    correlationId: `correlation-${type}`,
    causationId: null,
    dataClassification: "private",
    risk: "medium",
    authorizationRef: kind === "command" ? "authorization-01" : null,
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType, actorId: "owner-subject" },
    ...(kind === "command" ? { idempotencyKey: `idempotency-${type}-${Math.random()}` } : {}),
    payload,
  });
}

describe("[I-16] owner preferences live on the server", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-owner-preferences-"));
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
      now: () => T0,
    });
    closers.push(() => repository.close());
    let now = T0;
    const device = () =>
      new ProductionOwnerPreferencesControl({
        configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
        store: repository.ownerPreferences(),
        clock: { now: () => now },
      });
    return {
      device,
      advance: () => {
        now = T1;
      },
    };
  }

  const read = async (control: ProductionOwnerPreferencesControl) => {
    const snapshot = await control.query(
      message("query", "owner.preferences.read", {}) as GatewayV2Query,
    );
    gatewayV2MessageSchema.parse(snapshot);
    if (snapshot.type !== "owner.preferences.snapshot") throw new Error("unexpected snapshot");
    return snapshot.payload;
  };

  const set = (control: ProductionOwnerPreferencesControl, payload: unknown, actorType = "owner") =>
    control.execute(
      message("command", "owner.preferences.set", payload, actorType) as GatewayV2Command,
    );

  const EMPTY = {
    name: null,
    locale: null,
    accent: null,
    theme: null,
    modelRef: null,
    thinkingLevel: null,
  };

  it("starts empty, so a device keeps its own choice until the owner saves one", async () => {
    const { device } = await setup();
    expect(await read(device())).toEqual({ ...EMPTY, revision: 0, updatedAt: null });
  });

  it("returns on the phone every setting saved on the computer", async () => {
    const { device, advance } = await setup();
    const computer = device();
    const phone = device();
    const chosen = {
      name: "  Andy ",
      locale: "ja",
      accent: "teal",
      theme: "light",
      modelRef: "magpie-main",
      thinkingLevel: "high",
    };
    await set(computer, { ...chosen, expectedRevision: 0 });
    expect(await read(phone)).toEqual({ ...chosen, name: "Andy", revision: 1, updatedAt: T0 });
    advance();
    await set(phone, { ...EMPTY, locale: "zh-CN", theme: "system", expectedRevision: 1 });
    expect(await read(computer)).toEqual({
      ...EMPTY,
      locale: "zh-CN",
      theme: "system",
      revision: 2,
      updatedAt: T1,
    });
  });

  it("[I-16] refuses a save from a device that has not seen the newer settings", async () => {
    const { device, advance } = await setup();
    const computer = device();
    const phone = device();
    await set(computer, { ...EMPTY, name: "Andy", theme: "light", expectedRevision: 0 });
    advance();
    await set(computer, { ...EMPTY, name: "Andy", theme: "dark", expectedRevision: 1 });
    await expect(
      set(phone, { ...EMPTY, name: "Old", theme: "light", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    expect(await read(phone)).toMatchObject({ name: "Andy", theme: "dark", revision: 2 });
  });

  it("refuses a name longer than the page allows and a command not from the owner", async () => {
    const { device } = await setup();
    const control = device();
    expect(() =>
      message("command", "owner.preferences.set", {
        ...EMPTY,
        name: "a".repeat(41),
        expectedRevision: 0,
      }),
    ).toThrow();
    await expect(set(control, { ...EMPTY, name: "   ", expectedRevision: 0 })).rejects.toThrow();
    await expect(
      set(control, { ...EMPTY, name: "Andy", expectedRevision: 0 }, "system"),
    ).rejects.toThrow("OWNER_PREFERENCES_OWNER_REQUIRED");
    expect((await read(control)).updatedAt).toBeNull();
  });
});
