import { createHash, randomBytes } from "node:crypto";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import {
  APPLE_PUSH_CONFIGURATION_DEFAULTS,
  type ApplePushConfiguration,
  actionIntentFingerprint,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  type NotificationAction,
} from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { notificationActionHash } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentId,
  createThread,
  type Harness,
  harness,
  ownerId,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
  web,
} from "../fixtures/device-api-harness.ts";
import { grantApproval } from "../fixtures/sqlite-capability-invocation-fixture.ts";

const scope = { ownerId, agentId };
const TOPIC = "win.siyi.himawari";
const applePush: ApplePushConfiguration = {
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  secretRef: "apple-push-key",
  topics: [TOPIC],
  environments: ["production"],
  ...APPLE_PUSH_CONFIGURATION_DEFAULTS,
};
const INVALID = { error: { code: "NOTIFICATION_ACTION_INVALID" } };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await removeDeviceHarnessDirectories();
});

async function start(
  configuration: ApplePushConfiguration | null = applePush,
  revokeHookFails?: "prepare" | "wipe",
) {
  const h = await harness({
    ...(configuration ? { applePush: configuration } : {}),
    ...(revokeHookFails ? { revokeHookFails } : {}),
  });
  closers.push(async () => {
    await h.app.close();
    await h.repository.close();
  });
  return h;
}

function post(
  h: Harness,
  client: PairedClient,
  route: string,
  body: unknown,
  confirm?: { readonly nonce: string },
) {
  return send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: `/api/device/v1/${route}`,
      body: JSON.stringify(body),
      ...(confirm ? { confirmKey: client.confirmKeys.privateKey, nonce: confirm.nonce } : {}),
    }),
  );
}

async function challenge(h: Harness, client: PairedClient) {
  const response = await post(h, client, "approvals/challenge", {});
  expect(response.statusCode).toBe(201);
  return (response.json() as { challenge: string }).challenge;
}

function sql<T>(h: Harness, run: (database: ReturnType<typeof openQualifiedDatabase>) => T): T {
  const database = openQualifiedDatabase(`${h.stateRoot}/product.sqlite`);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

async function seedApproval(
  h: Harness,
  client: PairedClient,
  id: string,
  presenceRequired: boolean,
): Promise<GovernedApprovalRequest> {
  const threadId = `thread-${id}`;
  await createThread(h, threadId);
  const messageId = `message-${id}-0000000000`;
  const submitted = await post(h, client, "messages", {
    messageId,
    threadId,
    expectedRevision: 1,
    text: "帮我把这封邮件发出去",
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  const runId = createRunId(
    `run:${createHash("sha256").update(`${client.deviceId}\n${messageId}`).digest("hex").slice(0, 40)}`,
  );
  const base = grantApproval();
  const expiresAt = new Date(Date.parse(h.clock.now()) + 3_600_000).toISOString();
  const intent: GovernedActionIntent = {
    ...base.intentSnapshot,
    id: `intent-${id}`,
    ownerId,
    agentId,
    runId,
    requestedAt: h.clock.now(),
    contractVersion: "authorization.v2",
    threadId,
    capabilityVersion: "1.0.0",
    actionKind: "READ",
    targets: [{ type: "workspace", ref: base.intentSnapshot.resourceRef }],
    resourceRefs: [base.intentSnapshot.resourceRef],
    disclosure: "none",
    recipients: [],
    credentialOrAccessChange: false,
    expiresAt,
    modelClassification: { actionKind: "READ", suggestedRisk: "HIGH", reasonCode: "fixture" },
    deterministicFacts: [],
    finalRisk: "HIGH",
  };
  const approval: GovernedApprovalRequest = {
    ...base,
    id: `approval-${id}`,
    ownerId,
    agentId,
    runId,
    intentId: intent.id,
    intentSnapshot: intent,
    semanticSnapshotHash: actionIntentFingerprint(intent),
    requestedAt: h.clock.now(),
    expiresAt,
    recentAuthenticationRequired: presenceRequired,
    recentAuthenticationRef: null,
    finalRisk: "HIGH",
  };
  await h.repository.authorizationStore().createApproval(approval);
  return approval;
}

async function issue(
  h: Harness,
  deviceId: string,
  approval: GovernedApprovalRequest,
  options: { readonly lifetimeSeconds?: number; readonly snapshotHash?: string } = {},
) {
  const tokens = {
    approve: randomBytes(32).toString("base64url"),
    deny: randomBytes(32).toString("base64url"),
  } satisfies Record<NotificationAction, string>;
  await h.repository.applePush().issueActionTokens({
    ...scope,
    deviceId,
    sourceKey: `approval:${approval.id}:${approval.revision}`,
    tokens: (["approve", "deny"] as const).map((action) => ({
      tokenHash: notificationActionHash(tokens[action]),
      action,
      ownerPresence: action === "approve" && approval.recentAuthenticationRequired,
      approval: {
        requestId: approval.id,
        revision: approval.revision,
        snapshotHash: options.snapshotHash ?? approval.semanticSnapshotHash,
      },
    })),
    now: h.clock.now(),
    expiresAt: new Date(
      Date.parse(h.clock.now()) + (options.lifetimeSeconds ?? 3_600) * 1_000,
    ).toISOString(),
  });
  return tokens;
}

async function status(h: Harness, approval: GovernedApprovalRequest) {
  const current = await h.repository.authorizationStore().getApproval(approval.id);
  return { status: current?.status, revision: current?.revision };
}

function usedTokens(h: Harness) {
  return sql(
    h,
    (database) =>
      database
        .prepare("SELECT count(*) FROM notification_action_tokens WHERE used_at IS NOT NULL")
        .pluck()
        .get() as number,
  );
}

describe("[IOS-4] 通知按钮的一次性凭据", () => {
  it("锁屏上点“不同意”只凭凭据就生效，同一个凭据再用被拒，并留下审计记录", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const approval = await seedApproval(h, client, "deny", false);
    const tokens = await issue(h, client.deviceId, approval);

    const denied = await post(h, client, "approvals/respond", { token: tokens.deny });
    expect(denied.statusCode, denied.body).toBe(200);
    expect(await status(h, approval)).toEqual({ status: "denied", revision: 2 });

    const again = await post(h, client, "approvals/respond", { token: tokens.deny });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual(INVALID);
    const stale = await post(h, client, "approvals/respond", { token: tokens.approve });
    expect(stale.statusCode).toBe(410);
    expect(await status(h, approval)).toEqual({ status: "denied", revision: 2 });

    const audits = (await h.repository.auditLedger().listByAgent(agentId as never, null))
      .filter(({ action }) => action === "device.notification.action")
      .map(({ targetRef, outcome }) => `${targetRef}:${outcome}`)
      .sort();
    expect(audits).toEqual([
      `${client.deviceId}:v2:approval.respond:accepted`,
      `${client.deviceId}:v2:approval.respond:accepted`,
      `${client.deviceId}:v2:approval.respond:completed`,
      `${client.deviceId}:v2:approval.respond:failed`,
    ]);
  });

  it("不要求本人在场的审批，点“同意”只凭凭据就通过", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const approval = await seedApproval(h, client, "approve", false);
    const tokens = await issue(h, client.deviceId, approval);
    const approved = await post(h, client, "approvals/respond", { token: tokens.approve });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await status(h, approval)).toEqual({ status: "approved", revision: 2 });
  });

  it("要本人在场的审批没有确认密钥签名被拒（风险档位是 HIGH 时也一样），凭据不作废；带一次性挑战值的确认签名才通过，挑战值用过或过期都被拒", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const approval = await seedApproval(h, client, "present", true);
    expect(approval.finalRisk).toBe("HIGH");
    const tokens = await issue(h, client.deviceId, approval);

    const blind = await post(h, client, "approvals/respond", { token: tokens.approve });
    expect(blind.statusCode).toBe(403);
    expect(blind.json()).toEqual({ error: { code: "NOTIFICATION_ACTION_CONFIRM_REQUIRED" } });
    expect(usedTokens(h)).toBe(0);
    expect(await status(h, approval)).toEqual({ status: "pending", revision: 1 });

    const late = await challenge(h, client);
    h.clock.set(
      new Date(
        Date.parse(h.clock.now()) +
          (h.configuration.current.signatureToleranceSeconds + 600) * 1_000,
      ).toISOString(),
    );
    const expired = await post(
      h,
      client,
      "approvals/respond",
      { token: tokens.approve },
      {
        nonce: late,
      },
    );
    expect(expired.statusCode).toBeGreaterThanOrEqual(400);
    expect(usedTokens(h)).toBe(0);
    expect(await status(h, approval)).toEqual({ status: "pending", revision: 1 });

    const nonce = await challenge(h, client);
    const confirmed = await post(
      h,
      client,
      "approvals/respond",
      { token: tokens.approve },
      {
        nonce,
      },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await status(h, approval)).toEqual({ status: "approved", revision: 2 });

    const second = await seedApproval(h, client, "present-2", true);
    const secondTokens = await issue(h, client.deviceId, second);
    const reused = await post(
      h,
      client,
      "approvals/respond",
      { token: secondTokens.approve },
      {
        nonce,
      },
    );
    expect(reused.statusCode).toBeGreaterThanOrEqual(400);
    expect(await status(h, second)).toEqual({ status: "pending", revision: 1 });
  });

  it("要本人在场的审批，点“不同意”不需要确认密钥", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const approval = await seedApproval(h, client, "present-deny", true);
    const tokens = await issue(h, client.deviceId, approval);
    const denied = await post(h, client, "approvals/respond", { token: tokens.deny });
    expect(denied.statusCode, denied.body).toBe(200);
    expect(await status(h, approval)).toEqual({ status: "denied", revision: 2 });
  });

  it("过期的、别的设备的、不存在的、格式不对的凭据都被拒，审批保持原样", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const other = await pairAndConfirm(h, "Second iPhone");
    const approval = await seedApproval(h, client, "reject", false);
    const shortLived = await issue(h, client.deviceId, approval, { lifetimeSeconds: 60 });
    const tokens = await issue(h, client.deviceId, approval);

    const foreign = await post(h, other, "approvals/respond", { token: tokens.approve });
    expect(foreign.statusCode).toBe(410);
    expect(foreign.json()).toEqual(INVALID);
    const unknown = await post(h, client, "approvals/respond", {
      token: randomBytes(32).toString("base64url"),
    });
    expect(unknown.statusCode).toBe(410);
    const malformed = await post(h, client, "approvals/respond", { token: "short" });
    expect(malformed.statusCode).toBe(400);
    const extra = await post(h, client, "approvals/respond", {
      token: tokens.approve,
      decision: "approved",
    });
    expect(extra.statusCode).toBe(400);

    h.clock.set(new Date(Date.parse(h.clock.now()) + 61_000).toISOString());
    const expired = await post(h, client, "approvals/respond", { token: shortLived.approve });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toEqual(INVALID);
    expect(usedTokens(h)).toBe(0);
    expect(await status(h, approval)).toEqual({ status: "pending", revision: 1 });
  });

  it("审批内容变了以后，旧通知上的凭据被拒", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const approval = await seedApproval(h, client, "changed", false);
    const tokens = await issue(h, client.deviceId, approval, { snapshotHash: "older-content" });
    const response = await post(h, client, "approvals/respond", { token: tokens.approve });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual(INVALID);
    expect(await status(h, approval)).toEqual({ status: "pending", revision: 1 });
  });

  it("同一个凭据同时点两次，只有一次成功", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const approval = await seedApproval(h, client, "double", false);
    const tokens = await issue(h, client.deviceId, approval);
    const results = await Promise.all([
      post(h, client, "approvals/respond", { token: tokens.approve }),
      post(h, client, "approvals/respond", { token: tokens.approve }),
    ]);
    expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([200, 410]);
    expect(await status(h, approval)).toEqual({ status: "approved", revision: 2 });
    expect(usedTokens(h)).toBe(1);
  });

  it("发给 iPhone 的凭据，和它配对的那块手表也能用；别人的手表不能用；设备被吊销后凭据作废", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const watch = await pairAndConfirm(h, "Andy Watch", "watch");
    const stranger = await pairAndConfirm(h, "Other Watch", "watch");
    const fromWatch = await post(h, watch, "companions", { watchDeviceId: watch.deviceId });
    expect(fromWatch.statusCode).toBe(409);
    expect(fromWatch.json()).toEqual({ error: { code: "DEVICE_COMPANION_INVALID" } });
    const linked = await post(h, client, "companions", { watchDeviceId: watch.deviceId });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json()).toEqual({ linked: true });
    expect((await post(h, client, "companions", { watchDeviceId: watch.deviceId })).json()).toEqual(
      { linked: false },
    );
    const second = await pairAndConfirm(h, "Second iPhone");
    const taken = await post(h, second, "companions", { watchDeviceId: watch.deviceId });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: { code: "DEVICE_COMPANION_LINKED_ELSEWHERE" } });
    const notWatch = await post(h, client, "companions", { watchDeviceId: second.deviceId });
    expect(notWatch.statusCode).toBe(409);

    const first = await seedApproval(h, client, "watch", false);
    const firstTokens = await issue(h, client.deviceId, first);
    const refused = await post(h, stranger, "approvals/respond", { token: firstTokens.deny });
    expect(refused.statusCode).toBe(410);
    const onWrist = await post(h, watch, "approvals/respond", { token: firstTokens.deny });
    expect(onWrist.statusCode, onWrist.body).toBe(200);
    expect(await status(h, first)).toEqual({ status: "denied", revision: 2 });

    const next = await seedApproval(h, client, "revoked", false);
    const nextTokens = await issue(h, client.deviceId, next);
    const device = (await h.repository.pairedDevices().listDevices(scope)).find(
      ({ id }) => id === client.deviceId,
    );
    const stale = await web(h, "revoke", {
      deviceId: client.deviceId,
      expectedRevision: (device?.revision ?? 0) + 1,
    });
    expect(stale.status).toBe(409);
    expect(h.wiped).toEqual([]);
    const revoked = await web(h, "revoke", {
      deviceId: client.deviceId,
      expectedRevision: device?.revision,
    });
    expect(revoked.status).toBe(200);
    expect(h.revoking).toEqual([client.deviceId, client.deviceId]);
    expect(h.wiped).toEqual([client.deviceId]);
    const afterRevoke = await post(h, watch, "approvals/respond", { token: nextTokens.deny });
    expect(afterRevoke.statusCode).toBe(410);
    expect(await status(h, next)).toEqual({ status: "pending", revision: 1 });
    expect(
      sql(h, (database) =>
        database
          .prepare("SELECT count(*) FROM notification_action_tokens WHERE device_id = ?")
          .pluck()
          .get(client.deviceId),
      ),
    ).toBe(0);
  });
});

describe("[IOS-4] 登记苹果推送令牌", () => {
  const token = "ab".repeat(32);

  it("三种推送类型各登记一个，换令牌是更新，传 null 是注销", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const register = (body: Record<string, unknown>) => post(h, client, "push/register", body);
    const base = { environment: "production", topic: TOPIC, locale: "zh-CN" };
    for (const pushType of ["alert", "widgets", "liveactivity"]) {
      const response = await register({ ...base, pushType, token });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        registration: { pushType, activityRef: "", status: "active", topic: TOPIC },
      });
    }
    const perRun = await register({
      ...base,
      pushType: "liveactivity",
      activityRef: "run:abc",
      token: "cd".repeat(40),
    });
    expect(perRun.statusCode).toBe(200);
    const replaced = await register({ ...base, pushType: "alert", token: "ef".repeat(32) });
    expect(replaced.statusCode).toBe(200);
    const rows = () =>
      sql(h, (database) =>
        database
          .prepare(
            "SELECT push_type AS pushType, activity_ref AS activityRef, token FROM apns_registrations ORDER BY push_type, activity_ref",
          )
          .all(),
      );
    expect(rows()).toEqual([
      { pushType: "alert", activityRef: "", token: "ef".repeat(32) },
      { pushType: "liveactivity", activityRef: "", token },
      { pushType: "liveactivity", activityRef: "run:abc", token: "cd".repeat(40) },
      { pushType: "widgets", activityRef: "", token },
    ]);
    expect(h.registered.map(({ pushType }) => pushType)).toEqual([
      "alert",
      "widgets",
      "liveactivity",
      "liveactivity",
      "alert",
    ]);
    const removed = await register({ pushType: "widgets", token: null });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ registration: null });
    expect(rows()).toHaveLength(3);
  });

  it("不在配置里的 App 标识或环境、格式不对的令牌、多余的字段都被拒，什么都不存", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const base = {
      pushType: "alert",
      token,
      environment: "production",
      topic: TOPIC,
      locale: "en",
    };
    const cases: readonly [Record<string, unknown>, number, string][] = [
      [{ ...base, topic: "com.example.other" }, 403, "DEVICE_PUSH_TOPIC_NOT_ALLOWED"],
      [{ ...base, environment: "development" }, 403, "DEVICE_PUSH_TOPIC_NOT_ALLOWED"],
      [{ ...base, token: "XYZ" }, 400, "DEVICE_PUSH_REQUEST_INVALID"],
      [{ ...base, token: token.toUpperCase() }, 400, "DEVICE_PUSH_REQUEST_INVALID"],
      [{ ...base, pushType: "voip" }, 400, "DEVICE_PUSH_REQUEST_INVALID"],
      [{ ...base, locale: "fr" }, 400, "DEVICE_PUSH_REQUEST_INVALID"],
      [{ ...base, activityRef: "run:abc" }, 400, "DEVICE_PUSH_REQUEST_INVALID"],
      [{ ...base, deviceId: "dev_other" }, 400, "DEVICE_PUSH_REQUEST_INVALID"],
    ];
    for (const [body, statusCode, code] of cases) {
      const response = await post(h, client, "push/register", body);
      expect([response.statusCode, response.json()], JSON.stringify(body)).toEqual([
        statusCode,
        { error: { code } },
      ]);
    }
    expect(
      sql(h, (database) =>
        database.prepare("SELECT count(*) FROM apns_registrations").pluck().get(),
      ),
    ).toBe(0);
    expect(h.registered).toEqual([]);
  });

  it("服务器没配苹果推送时，登记被拒并说明没配置", async () => {
    const h = await start(null);
    const client = await pairAndConfirm(h);
    const response = await post(h, client, "push/register", {
      pushType: "alert",
      token,
      environment: "production",
      topic: TOPIC,
      locale: "ja",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "DEVICE_PUSH_NOT_CONFIGURED" } });
  });
});

describe("[IOS-4] 通知反馈和在线状态", () => {
  it("手机报“点开了”记到那条通知上；不存在的通知不记；格式不对被拒", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const sentAt = h.clock.now();
    sql(h, (database) => {
      database
        .prepare(
          `INSERT INTO web_push_outbox (
            owner_id, agent_id, source_key, kind, source_ref, thread_id, created_at, expires_at,
            channel
          ) VALUES (?, ?, 'reminder:r1', 'reminder', 'r1', NULL, ?, ?, 'apns')`,
        )
        .run(ownerId, agentId, sentAt, new Date(Date.parse(sentAt) + 3_600_000).toISOString());
      database
        .prepare(
          `INSERT INTO web_push_feedback (
            owner_id, agent_id, source_key, tag, kind, source_ref, thread_id, channel,
            first_sent_at, devices, opened_at, dismissed_at, updated_at
          ) VALUES (?, ?, 'reminder:r1', 'tag-r1', 'reminder', 'r1', NULL, 'apns', ?, 1, NULL, NULL, ?)`,
        )
        .run(ownerId, agentId, sentAt, sentAt);
    });
    h.clock.set(new Date(Date.parse(sentAt) + 5_000).toISOString());
    const occurredAt = new Date(Date.parse(sentAt) + 4_000).toISOString();
    const recorded = await post(h, client, "feedback", {
      reactions: [
        { tag: "tag-r1", reaction: "opened", occurredAt },
        { tag: "tag-missing", reaction: "dismissed", occurredAt },
      ],
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json()).toEqual({ recorded: 1 });
    expect(
      sql(h, (database) =>
        database
          .prepare(
            "SELECT opened_at AS openedAt, dismissed_at AS dismissedAt FROM web_push_feedback",
          )
          .all(),
      ),
    ).toEqual([{ openedAt: occurredAt, dismissedAt: null }]);

    for (const body of [
      { reactions: [] },
      { reactions: [{ tag: "tag-r1", reaction: "useful", occurredAt }] },
      { reactions: [{ tag: "tag-r1", reaction: "opened", occurredAt: "yesterday" }] },
      { reactions: [{ tag: "tag-r1", reaction: "opened", occurredAt, deviceId: "x" }] },
    ]) {
      const response = await post(h, client, "feedback", body);
      expect([response.statusCode, response.json()], JSON.stringify(body)).toEqual([
        400,
        { error: { code: "DEVICE_PUSH_REQUEST_INVALID" } },
      ]);
    }
  });

  it("设备事件流连着算“正在看”，断开就不算", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    expect(h.presence).toEqual([]);
    const request = signedRequest(h, client, { method: "GET", path: "/api/device/v1/stream" });
    const url = new URL(request.url);
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    const open = (signed: typeof request) => {
      const target = new URL(signed.url);
      const opened = get({
        host: "127.0.0.1",
        port,
        path: target.pathname + target.search,
        headers: signed.headers,
      });
      opened.on("error", () => undefined);
      opened.on("response", (response) => response.resume());
      return opened;
    };
    expect(url.pathname).toBe("/api/device/v1/stream");
    const connection = open(request);
    await expect
      .poll(() => h.presence.filter(({ visible }) => visible).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2);
    const second = open(signedRequest(h, client, { method: "GET", path: "/api/device/v1/stream" }));
    const seen = h.presence.length;
    await expect.poll(() => h.presence.length, { timeout: 5_000 }).toBeGreaterThan(seen);
    second.destroy();
    const afterSecondClosed = h.presence.length;
    await expect
      .poll(() => h.presence.length, { timeout: 5_000 })
      .toBeGreaterThan(afterSecondClosed + 1);
    expect(
      h.presence.every(({ deviceId, visible }) => deviceId === client.deviceId && visible),
    ).toBe(true);
    connection.destroy();
    await expect
      .poll(() => h.presence.at(-1), { timeout: 5_000 })
      .toEqual({
        deviceId: client.deviceId,
        visible: false,
      });
  });

  it("清除推送准备或发送失败时，设备照样被移除", async () => {
    for (const failing of ["prepare", "wipe"] as const) {
      const h = await start(applePush, failing);
      const client = await pairAndConfirm(h);
      const device = (await h.repository.pairedDevices().listDevices(scope)).find(
        ({ id }) => id === client.deviceId,
      );
      const revoked = await web(h, "revoke", {
        deviceId: client.deviceId,
        expectedRevision: device?.revision,
      });
      expect([failing, revoked.status]).toEqual([failing, 200]);
      expect(h.wiped).toEqual([]);
      expect(
        (await h.repository.pairedDevices().listDevices(scope)).find(
          ({ id }) => id === client.deviceId,
        )?.status,
      ).toBe("revoked");
    }
  });

  it("凭据上的动作不是同意也不是不同意时被拒，凭据不作废，审批保持原样", async () => {
    const h = await start();
    const client = await pairAndConfirm(h);
    const approval = await seedApproval(h, client, "unknown-action", false);
    const tokens = await issue(h, client.deviceId, approval);
    sql(h, (database) =>
      database.prepare("UPDATE notification_action_tokens SET action = 'cancel'").run(),
    );
    const response = await post(h, client, "approvals/respond", { token: tokens.approve });
    expect([response.statusCode, response.json()]).toEqual([410, INVALID]);
    expect(usedTokens(h)).toBe(0);
    expect(await status(h, approval)).toEqual({ status: "pending", revision: 1 });
  });
});
