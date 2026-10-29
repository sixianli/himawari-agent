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

  it("starts empty, so a device keeps its own choice until the owner saves one", async () => {
    const { device } = await setup();
    expect(await read(device())).toEqual({
      name: null,
      locale: null,
      accent: null,
      updatedAt: null,
    });
  });

  it("returns on the phone the name, language and color saved on the computer", async () => {
    const { device, advance } = await setup();
    const computer = device();
    const phone = device();
    await set(computer, { name: "  Andy ", locale: "ja", accent: "teal" });
    expect(await read(phone)).toEqual({
      name: "Andy",
      locale: "ja",
      accent: "teal",
      updatedAt: T0,
    });
    advance();
    await set(phone, { name: null, locale: "zh-CN", accent: "teal" });
    expect(await read(computer)).toEqual({
      name: null,
      locale: "zh-CN",
      accent: "teal",
      updatedAt: T1,
    });
  });

  it("refuses a name longer than the page allows and a command not from the owner", async () => {
    const { device } = await setup();
    const control = device();
    expect(() =>
      message("command", "owner.preferences.set", {
        name: "a".repeat(41),
        locale: null,
        accent: null,
      }),
    ).toThrow();
    await expect(set(control, { name: "   ", locale: null, accent: null })).rejects.toThrow();
    await expect(
      set(control, { name: "Andy", locale: null, accent: null }, "system"),
    ).rejects.toThrow("OWNER_PREFERENCES_OWNER_REQUIRED");
    expect((await read(control)).updatedAt).toBeNull();
  });
});
