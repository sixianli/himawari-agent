import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyDeliveryTimingOverrides,
  DELIVERY_TIMING_DEFAULTS,
} from "@himawari-agent/application";
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
import { ProductionDeliveryTimingControl } from "../../apps/agent-service/src/production-delivery-timing-control.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("delivery-timing-control");
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

describe("delivery timing settings live on the server", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-delivery-timing-"));
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
    let effective = DELIVERY_TIMING_DEFAULTS;
    const device = () =>
      new ProductionDeliveryTimingControl({
        configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
        defaults: DELIVERY_TIMING_DEFAULTS,
        store: repository.deliveryTimingSettings(),
        clock: { now: () => now },
        changed: (overrides) => {
          effective = applyDeliveryTimingOverrides(DELIVERY_TIMING_DEFAULTS, overrides);
        },
      });
    return {
      device,
      effective: () => effective,
      advance: () => {
        now = T1;
      },
    };
  }

  const read = async (control: ProductionDeliveryTimingControl) => {
    const snapshot = await control.query(
      message("query", "delivery_timing.settings.read", {}) as GatewayV2Query,
    );
    gatewayV2MessageSchema.parse(snapshot);
    if (snapshot.type !== "delivery_timing.settings.snapshot") throw new Error("unexpected");
    return snapshot.payload;
  };

  const change = (
    control: ProductionDeliveryTimingControl,
    payload: unknown,
    actorType = "owner",
  ) =>
    control.execute(
      message("command", "delivery_timing.settings.change", payload, actorType) as GatewayV2Command,
    );

  const item = (payload: Awaited<ReturnType<typeof read>>, key: string) =>
    payload.items.find((candidate) => candidate.key === key);

  it("lists every setting with its default and range, none changed", async () => {
    const { device } = await setup();
    const payload = await read(device());
    expect(payload.revision).toBe(0);
    expect(payload.items).toHaveLength(Object.keys(DELIVERY_TIMING_DEFAULTS).length);
    expect(item(payload, "recheckSeconds")).toEqual({
      key: "recheckSeconds",
      value: 300,
      defaultValue: 300,
      minimum: 60,
      maximum: 3600,
      overridden: false,
    });
  });

  it("shows on the phone a value changed on the computer, and the running service uses it", async () => {
    const { device, effective } = await setup();
    await change(device(), { expectedRevision: 0, key: "recheckSeconds", value: 600 });
    const payload = await read(device());
    expect(payload.revision).toBe(1);
    expect(item(payload, "recheckSeconds")).toMatchObject({ value: 600, overridden: true });
    expect(item(payload, "maximumDeferSeconds")).toMatchObject({ value: 7200, overridden: false });
    expect(effective().recheckSeconds).toBe(600);
    expect(effective().maximumDeferSeconds).toBe(7200);
  });

  it("goes back to the default when the value is cleared", async () => {
    const { device, effective } = await setup();
    await change(device(), { expectedRevision: 0, key: "recheckSeconds", value: 600 });
    await change(device(), { expectedRevision: 1, key: "recheckSeconds", value: null });
    expect(item(await read(device()), "recheckSeconds")).toMatchObject({
      value: 300,
      overridden: false,
    });
    expect(effective().recheckSeconds).toBe(300);
  });

  it("refuses a value outside its range and an unknown setting, keeping the old value", async () => {
    const { device, effective } = await setup();
    const control = device();
    await expect(
      change(control, { expectedRevision: 0, key: "recheckSeconds", value: 5 }),
    ).rejects.toThrow();
    await expect(
      change(control, { expectedRevision: 0, key: "recheckSeconds", value: 3601 }),
    ).rejects.toThrow();
    await expect(
      change(control, { expectedRevision: 0, key: "model", value: 5 }),
    ).rejects.toThrow();
    await expect(
      change(control, { expectedRevision: 0, key: "constructor", value: 5 }),
    ).rejects.toThrow();
    expect((await read(control)).revision).toBe(0);
    expect(effective().recheckSeconds).toBe(300);
  });

  it("refuses a change made on an older revision, so a stale device cannot overwrite", async () => {
    const { device } = await setup();
    await change(device(), { expectedRevision: 0, key: "recheckSeconds", value: 600 });
    await expect(
      change(device(), { expectedRevision: 0, key: "recheckSeconds", value: 900 }),
    ).rejects.toThrow();
    expect(item(await read(device()), "recheckSeconds")?.value).toBe(600);
  });

  it("accepts a change only from the owner", async () => {
    const { device, effective } = await setup();
    await expect(
      change(device(), { expectedRevision: 0, key: "recheckSeconds", value: 600 }, "client"),
    ).rejects.toThrow();
    expect(effective().recheckSeconds).toBe(300);
  });
});
