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
import { WebPushPresence } from "../../apps/agent-service/src/production-web-push.ts";
import {
  ProductionWebPushControl,
  webPushSubscriptionId,
} from "../../apps/agent-service/src/production-web-push-control.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-web-push-control");
const AGENT_ID = createAgentId("agent-web-push-control");
const T0 = "2026-10-26T12:00:00.000Z";
const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

function message(kind: "command" | "query", type: string, payload: unknown, actorType = "owner") {
  return gatewayV2MessageSchema.parse({
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `message-${type}`,
    correlationId: `correlation-${type}`,
    causationId: null,
    dataClassification: "private",
    risk: "low",
    authorizationRef: kind === "command" ? "authorization-01" : null,
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType, actorId: "owner-subject" },
    ...(kind === "command" ? { idempotencyKey: `idempotency-${type}-${Math.random()}` } : {}),
    payload,
  });
}

const subscribe = (endpoint: string, overrides: Record<string, unknown> = {}) =>
  message("command", "push.subscription.set", {
    action: "subscribe",
    subscriptionId: null,
    endpoint,
    keys: { p256dh: P256DH, auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    locale: "zh-CN",
    deviceLabel: "iPhone 主屏应用",
    kinds: ["reminder", "approval", "run"],
    ...overrides,
  }) as GatewayV2Command;

describe("[WP-5] web push gateway control", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(configured: boolean) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-web-push-control-"));
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
    const tests: string[] = [];
    const presence = new WebPushPresence();
    const control = new ProductionWebPushControl({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      store: repository.webPush(),
      presence,
      push: configured
        ? {
            publicKey:
              "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
            sendTest: async (subscriptionId) => {
              tests.push(subscriptionId);
              return subscriptionId.startsWith("web-push-")
                ? { kind: "sent" }
                : { kind: "gone", code: "WEB_PUSH_SUBSCRIPTION_NOT_FOUND" };
            },
          }
        : undefined,
      clock: { now: () => T0 },
    });
    return { control, presence, tests };
  }

  const status = async (control: ProductionWebPushControl) => {
    const snapshot = await control.query(
      message("query", "push.status.read", {}) as GatewayV2Query,
    );
    gatewayV2MessageSchema.parse(snapshot);
    if (snapshot.type !== "push.status.snapshot") throw new Error("unexpected snapshot");
    return snapshot.payload;
  };

  it("[WP-5] subscribes, lists devices without keys, sends a test and unsubscribes", async () => {
    const { control, tests } = await setup(true);
    const endpoint = "https://web.push.apple.com/QGuQyavXutnMH8Ta";
    const first = await control.execute(subscribe(endpoint));
    const again = await control.execute(
      subscribe(endpoint, { locale: "ja", kinds: ["approval", "approval", "run"] }),
    );
    expect(again.resultRef).toBe(first.resultRef);
    expect(first.resultRef).toBe(webPushSubscriptionId(endpoint));
    expect(webPushSubscriptionId("https://push.example/this-device")).toBe(
      "web-push-13e30baf6fc9963eab79da53",
    );
    const listed = await status(control);
    expect(listed).toMatchObject({
      available: true,
      publicKey: expect.stringMatching(/^B/),
      subscriptions: [
        {
          subscriptionId: first.resultRef,
          endpointHost: "web.push.apple.com",
          locale: "ja",
          kinds: ["approval", "run"],
          state: "active",
          deviceLabel: "iPhone 主屏应用",
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain(P256DH);
    expect(JSON.stringify(listed)).not.toContain("QGuQyavXutnMH8Ta");
    await control.execute(
      message("command", "push.test", { subscriptionId: first.resultRef }) as GatewayV2Command,
    );
    expect(tests).toEqual([first.resultRef]);
    await expect(
      control.execute(
        message("command", "push.test", { subscriptionId: "missing" }) as GatewayV2Command,
      ),
    ).rejects.toThrow("WEB_PUSH_SUBSCRIPTION_NOT_FOUND");
    await control.execute(
      message("command", "push.subscription.set", {
        action: "unsubscribe",
        subscriptionId: first.resultRef,
        endpoint: null,
        keys: null,
        locale: null,
        deviceLabel: null,
        kinds: null,
      }) as GatewayV2Command,
    );
    expect((await status(control)).subscriptions).toEqual([]);
  });

  it("[WP-5] rejects plain http endpoints, incomplete subscriptions and non-owner actors", async () => {
    const { control } = await setup(true);
    expect(() => subscribe("http://push.example/a")).toThrow();
    await expect(
      control.execute(subscribe("https://push.example/a", { keys: null })),
    ).rejects.toThrow("WEB_PUSH_SUBSCRIPTION_INCOMPLETE");
    const foreign = message(
      "command",
      "push.subscription.set",
      {
        action: "subscribe",
        subscriptionId: null,
        endpoint: "https://push.example/a",
        keys: { p256dh: P256DH, auth: "BTBZMqHH6r4Tts7J_aSIgg" },
        locale: "en",
        deviceLabel: "laptop",
        kinds: ["run"],
      },
      "client",
    ) as GatewayV2Command;
    await expect(control.execute(foreign)).rejects.toThrow("WEB_PUSH_OWNER_REQUIRED");
  });

  it("[WP-5] records page presence and reports when the server has no push key", async () => {
    const { control, presence } = await setup(false);
    expect(await status(control)).toMatchObject({
      available: false,
      publicKey: null,
      subscriptions: [],
    });
    await expect(control.execute(subscribe("https://push.example/a"))).rejects.toThrow(
      "WEB_PUSH_NOT_CONFIGURED",
    );
    await control.execute(
      message("command", "presence.heartbeat", {
        clientId: "tab-1",
        visible: true,
      }) as GatewayV2Command,
    );
    expect(presence.anyVisible(T0)).toBe(true);
    expect(presence.anyVisible("2026-10-26T12:00:46.000Z")).toBe(false);
    await control.execute(
      message("command", "presence.heartbeat", {
        clientId: "tab-1",
        visible: true,
      }) as GatewayV2Command,
    );
    await control.execute(
      message("command", "presence.heartbeat", {
        clientId: "tab-1",
        visible: false,
      }) as GatewayV2Command,
    );
    expect(presence.anyVisible(T0)).toBe(false);
  });
});
