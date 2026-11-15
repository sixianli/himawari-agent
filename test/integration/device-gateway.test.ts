import { DEFAULT_SEARCH_ASK, type ProductMemoryRecord } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionSearchControl } from "../../apps/agent-service/src/production-search.ts";
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
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

let sequence = 0;

function gatewayBody(input: {
  readonly gateway: "v1" | "v2" | "thread-v3";
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly command?: boolean;
  readonly extra?: Record<string, unknown>;
}) {
  sequence += 1;
  return {
    gateway: input.gateway,
    type: input.type,
    messageId: `device-message-${sequence}`,
    ...(input.command === false ? {} : { idempotencyKey: `device-idempotency-${sequence}` }),
    ...(input.gateway === "v2" ? { dataClassification: "private", risk: "low" } : {}),
    payload: input.payload,
    ...input.extra,
  };
}

async function text(h: Harness, client: PairedClient, content: string) {
  sequence += 1;
  const response = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/payloads/text/new",
      body: JSON.stringify({
        idempotencyKey: `device-text-key-${sequence}-padding`,
        content,
        dataClassification: "private",
      }),
    }),
  );
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { payloadRef: string }).payloadRef;
}

async function challenge(h: Harness, client: PairedClient) {
  const response = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/approvals/challenge",
      body: "{}",
    }),
  );
  expect(response.statusCode).toBe(201);
  return response.json() as { challenge: string; expiresAt: string };
}

async function gateway(
  h: Harness,
  client: PairedClient,
  body: unknown,
  confirm?: { readonly nonce: string } | "random",
) {
  return send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/gateway",
      body: JSON.stringify(body),
      ...(confirm
        ? {
            confirmKey: client.confirmKeys.privateKey,
            ...(confirm === "random" ? {} : { nonce: confirm.nonce }),
          }
        : {}),
    }),
  );
}

async function threadDetail(h: Harness, client: PairedClient, threadId: string) {
  const response = await gateway(
    h,
    client,
    gatewayBody({
      gateway: "thread-v3",
      type: "thread.detail",
      command: false,
      payload: { threadId, afterSequence: 0, limit: 20 },
    }),
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { payload: { thread: { pinOrder: number | null; revision: number } } };
}

async function pin(
  h: Harness,
  client: PairedClient,
  threadId: string,
  expectedRevision: number,
  pinOrder: number,
) {
  const resultRef = await text(h, client, "thread-action:pin");
  return gatewayBody({
    gateway: "thread-v3",
    type: "thread.pin",
    payload: { threadId, expectedRevision, pinOrder, resultRef },
  });
}

async function audits(h: Harness) {
  return (await h.repository.auditLedger().listByAgent(agentId as never, null)).filter((record) =>
    record.action.startsWith("device.gateway."),
  );
}

async function auditTrail(h: Harness) {
  return (await audits(h))
    .map(({ action, targetRef, outcome }) => `${action}:${targetRef}:${outcome}`)
    .sort();
}

describe("[第11批] 原生页面经设备接口走和网页同一个处理程序", () => {
  it("“读”只要设备密钥签名，结果和网页同一个处理程序给的一样", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-gateway-01");
    const detail = await threadDetail(h, client, "thread-gateway-01");
    expect(detail.payload.thread.revision).toBeGreaterThan(0);
    expect(await audits(h)).toEqual([]);
    await h.repository.close();
  });

  it("“改”没有确认签名时被拒，用一次性挑战值加确认签名才执行，并记审计", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const clear = () => gatewayBody({ gateway: "v2", type: "muse.data.clear", payload: {} });

    const unconfirmed = await gateway(h, client, clear());
    expect(unconfirmed.statusCode).toBe(403);
    expect(unconfirmed.json()).toEqual({ error: { code: "DEVICE_GATEWAY_CONFIRM_REQUIRED" } });

    const notIssued = await gateway(h, client, clear(), "random");
    expect(notIssued.statusCode).toBe(401);
    expect(notIssued.json()).toEqual({ error: { code: "DEVICE_CHALLENGE_INVALID" } });
    expect(await audits(h)).toEqual([]);

    const issued = await challenge(h, client);
    const confirmed = await gateway(h, client, clear(), { nonce: issued.challenge });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await auditTrail(h)).toEqual([
      `device.gateway.change:${client.deviceId}:v2:muse.data.clear:accepted`,
      `device.gateway.change:${client.deviceId}:v2:muse.data.clear:completed`,
    ]);
    await h.repository.close();
  });

  it("对话里能撤回的日常操作只用设备密钥，不刷面容也不记审计", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-gateway-02");
    const revision = (await threadDetail(h, client, "thread-gateway-02")).payload.thread.revision;
    const pinned = await gateway(h, client, await pin(h, client, "thread-gateway-02", revision, 7));
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect((await threadDetail(h, client, "thread-gateway-02")).payload.thread.pinOrder).toBe(7);
    expect(await audits(h)).toEqual([]);
    await h.repository.close();
  });

  it("挑战值只能用一次、过期作废、不能拿别的设备的来用", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const other = await pairAndConfirm(h);
    const clear = () => gatewayBody({ gateway: "v2", type: "muse.data.clear", payload: {} });

    const issued = await challenge(h, client);
    const first = await gateway(h, client, clear(), { nonce: issued.challenge });
    expect(first.statusCode, first.body).toBe(200);
    const reused = await gateway(h, client, clear(), { nonce: issued.challenge });
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toEqual({ error: { code: "DEVICE_NONCE_REPLAYED" } });

    const foreign = await challenge(h, other);
    const stolen = await gateway(h, client, clear(), { nonce: foreign.challenge });
    expect(stolen.statusCode).toBe(401);
    expect(stolen.json()).toEqual({ error: { code: "DEVICE_CHALLENGE_INVALID" } });

    const late = await challenge(h, client);
    h.clock.advance((h.configuration.current.signatureToleranceSeconds + 1) * 1000);
    const expired = await gateway(h, client, clear(), { nonce: late.challenge });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ error: { code: "DEVICE_CHALLENGE_INVALID" } });
    expect((await audits(h)).length).toBe(2);
    await h.repository.close();
  });

  it("“收紧”只在让 Himawari 收集得更少时免面容；往回打开要确认签名", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const pause = await gateway(
      h,
      client,
      gatewayBody({ gateway: "v2", type: "muse.intake.set", payload: { paused: true } }),
    );
    expect(pause.statusCode, pause.body).toBe(200);
    const overview = async () => {
      const response = await gateway(
        h,
        client,
        gatewayBody({ gateway: "v2", type: "muse.overview.read", command: false, payload: {} }),
      );
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { payload: { channel: { state: string } } }).payload.channel.state;
    };
    expect(await overview()).toBe("paused");

    const resumeWithoutFace = await gateway(
      h,
      client,
      gatewayBody({ gateway: "v2", type: "muse.intake.set", payload: { paused: false } }),
    );
    expect(resumeWithoutFace.statusCode).toBe(403);
    expect(resumeWithoutFace.json()).toEqual({
      error: { code: "DEVICE_GATEWAY_CONFIRM_REQUIRED" },
    });
    expect(await overview()).toBe("paused");

    const issued = await challenge(h, client);
    const resume = await gateway(
      h,
      client,
      gatewayBody({ gateway: "v2", type: "muse.intake.set", payload: { paused: false } }),
      { nonce: issued.challenge },
    );
    expect(resume.statusCode, resume.body).toBe(200);
    expect(await overview()).not.toBe("paused");
    expect(await auditTrail(h)).toEqual([
      `device.gateway.change:${client.deviceId}:v2:muse.intake.set:accepted`,
      `device.gateway.change:${client.deviceId}:v2:muse.intake.set:completed`,
      `device.gateway.tighten:${client.deviceId}:v2:muse.intake.set:accepted`,
      `device.gateway.tighten:${client.deviceId}:v2:muse.intake.set:completed`,
    ]);
    await h.repository.close();
  });

  it("外部提议全部拒绝免面容；含保留或改写的要确认签名且不留审计", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const respond = (items: unknown[]) =>
      gatewayBody({ gateway: "v2", type: "memory.external.respond", payload: { items } });
    const keep = await gateway(
      h,
      client,
      respond([{ proposalId: "p1", decision: "keep", editedText: null }]),
    );
    expect(keep.statusCode).toBe(403);
    expect(keep.json()).toEqual({ error: { code: "DEVICE_GATEWAY_CONFIRM_REQUIRED" } });
    expect(await auditTrail(h)).toEqual([]);
    const reject = await gateway(
      h,
      client,
      respond([{ proposalId: "p1", decision: "reject", editedText: null }]),
    );
    expect(reject.json()).not.toEqual({ error: { code: "DEVICE_GATEWAY_CONFIRM_REQUIRED" } });
    expect((await auditTrail(h))[0]).toContain(
      `device.gateway.tighten:${client.deviceId}:v2:memory.external.respond:accepted`,
    );
    await h.repository.close();
  });

  it("关掉一种推送只用设备密钥就过了面容这一关，打开要确认签名", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const off = await gateway(
      h,
      client,
      gatewayBody({
        gateway: "v2",
        type: "push.kind.set",
        payload: { kind: "run", enabled: false },
      }),
    );
    expect(off.statusCode).toBe(501);
    expect(off.json()).toEqual({ error: { code: "PORT_OPERATION_NOT_INSTALLED" } });
    const on = await gateway(
      h,
      client,
      gatewayBody({
        gateway: "v2",
        type: "push.kind.set",
        payload: { kind: "run", enabled: true },
      }),
    );
    expect(on.statusCode).toBe(403);
    expect(on.json()).toEqual({ error: { code: "DEVICE_GATEWAY_CONFIRM_REQUIRED" } });
    expect(await auditTrail(h)).toEqual([
      `device.gateway.tighten:${client.deviceId}:v2:push.kind.set:accepted`,
      `device.gateway.tighten:${client.deviceId}:v2:push.kind.set:failed`,
    ]);
    await h.repository.close();
  });

  it("确认签名算近期身份验证：永久删除对话只有确认过的请求能做", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-gateway-04");
    const revision = (await threadDetail(h, client, "thread-gateway-04")).payload.thread.revision;
    const deletion = async () =>
      gatewayBody({
        gateway: "thread-v3",
        type: "thread.delete_permanently",
        payload: {
          threadId: "thread-gateway-04",
          expectedRevision: revision,
          reasonCode: "OWNER_REQUESTED",
          authorizationRef: "device",
          recentAuthenticationRef: "device",
          resultRef: await text(h, client, "thread-action:delete"),
        },
      });
    const unconfirmed = await gateway(h, client, await deletion());
    expect(unconfirmed.statusCode).toBe(403);
    expect(unconfirmed.json()).toEqual({ error: { code: "DEVICE_GATEWAY_CONFIRM_REQUIRED" } });

    const issued = await challenge(h, client);
    const confirmed = await gateway(h, client, await deletion(), { nonce: issued.challenge });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await h.repository.close();
  });

  it("正文带别的设置的开关和记忆的每种动作都算“改”，只用设备密钥签被拒", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const requests = [
      gatewayBody({
        gateway: "v2",
        type: "proactive.settings.set",
        payload: { enabled: false, quietHours: [], importantSenders: [] },
      }),
      ...[
        "correct",
        "archive",
        "delete",
        "restore",
        "confirm",
        "recover",
        "pin",
        "unpin",
        "restore_version",
      ].map((action) =>
        gatewayBody({
          gateway: "v2",
          type: "memory.mutate",
          payload: { action, memoryId: "memory-x" },
        }),
      ),
      gatewayBody({ gateway: "v2", type: "muse.intake.set", payload: { paused: false } }),
      gatewayBody({
        gateway: "v2",
        type: "memory.settings.set",
        payload: { capturePaused: true, extra: true },
      }),
    ];
    for (const body of requests) {
      const response = await gateway(h, client, body);
      expect(response.statusCode, JSON.stringify(body.payload)).toBe(403);
      expect(response.json()).toEqual({ error: { code: "DEVICE_GATEWAY_CONFIRM_REQUIRED" } });
    }
    expect(await audits(h)).toEqual([]);
    await h.repository.close();
  });

  it("同一个挑战值并发用两次，只有一次成功", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const issued = await challenge(h, client);
    const clear = () => gatewayBody({ gateway: "v2", type: "muse.data.clear", payload: {} });
    const results = await Promise.all([
      gateway(h, client, clear(), { nonce: issued.challenge }),
      gateway(h, client, clear(), { nonce: issued.challenge }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    expect(results.find((response) => response.statusCode === 401)?.json()).toEqual({
      error: { code: "DEVICE_NONCE_REPLAYED" },
    });
    expect((await audits(h)).length).toBe(2);
    await h.repository.close();
  });

  it("v2 的查询经设备网关读到的就是网页那份", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const response = await gateway(
      h,
      client,
      gatewayBody({ gateway: "v2", type: "muse.overview.read", command: false, payload: {} }),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as { type: string }).type).toBe("muse.overview.snapshot");
    expect(await audits(h)).toEqual([]);
    await h.repository.close();
  });

  it("确认过的“改”执行失败时，审计先记了受理、再记失败", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const issued = await challenge(h, client);
    const stale = await gateway(
      h,
      client,
      gatewayBody({
        gateway: "v2",
        type: "memory.mutate",
        payload: {
          memoryId: "memory-missing",
          action: "archive",
          expectedRevision: 1,
          contentRef: null,
          historyId: null,
        },
      }),
      { nonce: issued.challenge },
    );
    expect(stale.statusCode).not.toBe(200);
    expect(await auditTrail(h)).toEqual([
      `device.gateway.change:${client.deviceId}:v2:memory.mutate:accepted`,
      `device.gateway.change:${client.deviceId}:v2:memory.mutate:failed`,
    ]);
    await h.repository.close();
  });

  it("上传文字和网页那条一样拒绝空的、太长的、多字段的和分级不对的", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const upload = (body: Record<string, unknown>) =>
      send(
        h,
        signedRequest(h, client, {
          method: "POST",
          path: "/api/device/v1/payloads/text/new",
          body: JSON.stringify(body),
        }),
      );
    const valid = {
      idempotencyKey: "device-text-key-reverse-01",
      content: "x",
      dataClassification: "private",
    };
    for (const body of [
      { ...valid, content: "" },
      { ...valid, content: "x".repeat(64 * 1024 + 1) },
      { ...valid, extra: true },
      { ...valid, dataClassification: "secret" },
      { ...valid, idempotencyKey: "short" },
      { content: "x", dataClassification: "private" },
    ]) {
      const response = await upload(body);
      expect(response.statusCode, JSON.stringify(Object.keys(body))).toBe(400);
    }
    const accepted = await upload({ ...valid, content: "x".repeat(64 * 1024) });
    expect(accepted.statusCode, accepted.body).toBe(201);
    await h.repository.close();
  });

  it("拒绝手机上不做的、不认识的、自带身份字段的和自带近期验证引用的请求", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const notOnPhone = await gateway(
      h,
      client,
      gatewayBody({
        gateway: "v2",
        type: "presence.heartbeat",
        payload: { clientId: "phone", visible: true },
      }),
    );
    expect(notOnPhone.statusCode).toBe(403);
    expect(notOnPhone.json()).toEqual({ error: { code: "DEVICE_GATEWAY_NOT_ON_PHONE" } });
    const legacy = await gateway(
      h,
      client,
      gatewayBody({ gateway: "v1", type: "trace.query", command: false, payload: {} }),
    );
    expect(legacy.statusCode).toBe(403);
    expect(legacy.json()).toEqual({ error: { code: "DEVICE_GATEWAY_NOT_ON_PHONE" } });

    const issued = await challenge(h, client);
    const commit = await gateway(
      h,
      client,
      gatewayBody({ gateway: "v2", type: "workspace.commit", payload: {} }),
      { nonce: issued.challenge },
    );
    expect(commit.statusCode).toBe(403);
    expect(commit.json()).toEqual({ error: { code: "DEVICE_GATEWAY_NOT_ON_PHONE" } });
    expect(await auditTrail(h)).toEqual([]);

    const unknown = await gateway(
      h,
      client,
      gatewayBody({ gateway: "v2", type: "memory.everything.delete", payload: {} }),
    );
    expect(unknown.statusCode).toBe(404);

    const response = await gateway(
      h,
      client,
      gatewayBody({ gateway: "v2", type: "muse.snapshot", command: false, payload: {} }),
    );
    expect(response.statusCode).toBe(404);

    for (const extra of [
      { scope: { ownerId: "someone-else", agentId } },
      { actor: { actorType: "owner", actorId: ownerId } },
      { authorizationRef: "authorization-from-device" },
    ]) {
      const spoofed = await gateway(
        h,
        client,
        gatewayBody({ gateway: "v2", type: "muse.intake.set", payload: { paused: true }, extra }),
      );
      expect(spoofed.statusCode, JSON.stringify(extra)).toBe(400);
    }

    for (const references of [
      { authorizationRef: "device", recentAuthenticationRef: "sha256:guessed" },
      { authorizationRef: "authorization-guessed", recentAuthenticationRef: "device" },
      { authorizationRef: null, recentAuthenticationRef: "device" },
      { authorizationRef: "device", recentAuthenticationRef: null },
    ]) {
      const issued = await challenge(h, client);
      const presetReference = await gateway(
        h,
        client,
        gatewayBody({
          gateway: "thread-v3",
          type: "thread.delete_permanently",
          payload: {
            threadId: "thread-x",
            expectedRevision: 1,
            reasonCode: "OWNER_REQUESTED",
            ...references,
            resultRef: "delete-result",
          },
        }),
        { nonce: issued.challenge },
      );
      expect(presetReference.statusCode, JSON.stringify(references)).toBe(400);
    }
    expect(await audits(h)).toEqual([]);
    await h.repository.close();
  });
});

describe("手机搜索词预处理经设备通道", () => {
  const prepared = {
    queryRef: "payload-search-device-01",
    tokenRefs: ["search-token-device-01"],
    projectionVersion: "thread-search-v1",
  };
  const path = "/api/device/v1/thread-search/prepare";

  it("设备签名通过后调用和网页同一个预处理，用服务器的智能体身份", async () => {
    const calls: string[] = [];
    const h = await harness({
      threadSearch: {
        async prepare(input) {
          calls.push(`${input.authentication.ownerId}:${input.agentId}:${input.query}`);
          return prepared;
        },
      },
    });
    const client = await pairAndConfirm(h);
    const response = await send(
      h,
      signedRequest(h, client, {
        method: "POST",
        path,
        body: JSON.stringify({ query: "私人搜索" }),
      }),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(prepared);
    expect(calls).toEqual([`${ownerId}:${agentId}:私人搜索`]);
    await h.repository.close();
  });

  it("未签名、签名错、空的、超长的、多字段的请求都拒绝且不调用预处理", async () => {
    const calls: string[] = [];
    const h = await harness({
      threadSearch: {
        async prepare(input) {
          calls.push(input.query);
          return prepared;
        },
      },
    });
    const client = await pairAndConfirm(h);
    const signedWith = (body: unknown) =>
      send(h, signedRequest(h, client, { method: "POST", path, body: JSON.stringify(body) }));

    const unsigned = await h.app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "x" }),
    });
    expect(unsigned.statusCode).toBeGreaterThanOrEqual(400);

    const good = signedRequest(h, client, {
      method: "POST",
      path,
      body: JSON.stringify({ query: "x" }),
    });
    const tampered = await h.app.inject({
      method: "POST",
      url: path,
      headers: good.headers,
      payload: JSON.stringify({ query: "y" }),
    });
    expect(tampered.statusCode).toBeGreaterThanOrEqual(400);

    for (const body of [
      { query: "" },
      { query: "   " },
      { query: "x".repeat(2049) },
      { query: "x", extra: true },
      { query: 1 },
      {},
    ]) {
      const response = await signedWith(body);
      expect(response.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await signedWith({ query: "x".repeat(2048) })).statusCode).toBe(200);
    expect(calls).toEqual(["x".repeat(2048)]);
    await h.repository.close();
  });

  it("服务器没有装配搜索预处理时拒绝，不返回空结果", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const response = await send(
      h,
      signedRequest(h, client, { method: "POST", path, body: JSON.stringify({ query: "x" }) }),
    );
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    await h.repository.close();
  });
});

describe("手机搜索页问答经设备通道", () => {
  const memory = {
    id: "memory-allergy",
    ownerId,
    agentId,
    status: "active",
    dataClassification: "private",
    contentRef: "text-allergy",
    sourceRefs: [],
    sourceThreadId: "thread-allergy",
    providerRecordId: "provider-allergy",
    attributes: { category: "preference", entities: ["花生"], validTo: null, supersededBy: null },
    updatedAt: "2026-10-22T00:00:00.000Z",
    recordedAt: "2026-10-21T03:00:00.000Z",
  } as unknown as ProductMemoryRecord;
  const searchControl = () =>
    new ProductionSearchControl({
      ownerId: ownerId as ProductMemoryRecord["ownerId"],
      agentId: agentId as ProductMemoryRecord["agentId"],
      settings: DEFAULT_SEARCH_ASK,
      provider: {
        search: async (input) =>
          input.query.includes("过敏")
            ? [{ productMemoryId: memory.id, providerRecordId: "provider-allergy", score: 1 }]
            : [],
      },
      state: { readMany: async () => [memory], listActive: async () => [memory] },
      readText: async () => "我对花生过敏",
      clock: { now: () => "2026-11-14T03:00:00.000Z" },
    });
  const ask = (h: Harness, client: PairedClient, query: string | null) =>
    gateway(
      h,
      client,
      gatewayBody({
        gateway: "v2",
        type: "search.ask.read",
        command: false,
        payload: { query, locale: "zh-CN" },
      }),
    );
  const payloadOf = (body: string) =>
    (JSON.parse(body) as { payload: Record<string, unknown> }).payload;

  it("问得到：回答、来源对话和时间；问不到：服务器给出没找到的话；不问：给建议", async () => {
    const h = await harness({ searchControl: searchControl() });
    const client = await pairAndConfirm(h);
    const found = await ask(h, client, "我对什么过敏");
    expect(found.statusCode, found.body).toBe(200);
    expect(payloadOf(found.body)).toMatchObject({
      state: "answered",
      answer: "我对花生过敏",
      basis: [
        {
          kind: "conversation",
          label: "10 月 21 日你在对话里说的",
          memoryId: "memory-allergy",
          threadId: "thread-allergy",
        },
      ],
    });
    const missing = await ask(h, client, "我住在哪里");
    expect(payloadOf(missing.body)).toMatchObject({
      state: "not_found",
      answer: null,
      basis: [],
      notFoundText: "没有找到相关的内容。",
    });
    const suggestions = await ask(h, client, null);
    expect(payloadOf(suggestions.body)).toMatchObject({ state: "suggestions", asks: [] });
  });

  it("没有装配搜索时这个操作不可用，不返回空答案", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const response = await ask(h, client, "我对什么过敏");
    expect(response.statusCode).not.toBe(200);
  });
});
