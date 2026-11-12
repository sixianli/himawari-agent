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
    expect(
      (await audits(h)).map(({ action, targetRef, outcome }) => ({ action, targetRef, outcome })),
    ).toEqual([
      {
        action: "device.gateway.change",
        targetRef: `${client.deviceId}:v2:muse.data.clear`,
        outcome: "completed",
      },
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
    expect((await audits(h)).length).toBe(1);
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
    expect((await audits(h)).map(({ action, outcome }) => ({ action, outcome }))).toEqual([
      { action: "device.gateway.tighten", outcome: "completed" },
      { action: "device.gateway.change", outcome: "completed" },
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
          authorizationRef: null,
          recentAuthenticationRef: null,
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
          authorizationRef: null,
          recentAuthenticationRef: "sha256:guessed",
          resultRef: "delete-result",
        },
      }),
    );
    expect(presetReference.statusCode).toBe(400);
    expect(await audits(h)).toEqual([]);
    await h.repository.close();
  });
});
