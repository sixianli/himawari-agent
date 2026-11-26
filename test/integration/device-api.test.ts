import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  PAIRED_DEVICE_KINDS,
  PAIRED_DEVICE_RELEASE_CHANNELS,
  RecentAuthenticationGuard,
} from "@himawari-agent/application";
import { createSessionId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES,
  EnvelopePayloadProtector,
  PairedDeviceService,
} from "@himawari-agent/platform-node";
import { generateDeviceTestKeyPair } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionHttpPayloadAdmission } from "../../apps/agent-service/src/production-http-composition.ts";
import {
  agentId,
  createThread,
  type Harness,
  harness,
  issueSetupCode,
  ownerId,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
  signInRequest,
  threadCommand,
  web,
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

describe("[P1-1] signed device API", () => {
  it("lets a signed-in device call the API and never exposes the internal session", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const config = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      heartbeatSeconds: 1,
      signatureToleranceSeconds: 60,
    });
    expect((config.json() as { limits: unknown[] }).limits).toHaveLength(10);

    const listed = await web(h, "list");
    expect(listed.body["devices"]).toMatchObject([{ id: client.deviceId, status: "active" }]);
    const stored = await h.repository.pairedDevices().readDevice(client.deviceId);
    const internalSession = stored?.webSessionId
      ? await h.repository.sessionDeviceState().readSession(createSessionId(stored.webSessionId))
      : undefined;
    expect(internalSession?.authenticationRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const everything = [config.body, JSON.stringify(listed.body)].join("\n");
    for (const secret of [
      stored?.webSessionId,
      stored?.webDeviceId,
      internalSession?.authenticationRef,
      internalSession?.authenticationRef.slice("sha256:".length),
    ])
      expect(everything).not.toContain(secret);
    const webDevices = await h.repository.sessionDeviceState().listDevices(ownerId, false);
    expect(webDevices.map((device) => device.label)).toContain("Andy iPhone");
    await h.repository.close();
  });

  it("rejects replay, changed body, changed query, other host, clock skew and paths outside the allow list", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const request = signedRequest(h, client, {
      method: "GET",
      path: "/api/device/v1/threads",
    });
    const first = await send(h, request);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await send(h, request);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: "DEVICE_NONCE_REPLAYED" } });

    const changedQuery = signedRequest(h, client, {
      method: "GET",
      path: "/api/device/v1/threads",
      query: "after=thread-cursor:1",
    });
    const tampered = { ...changedQuery, url: changedQuery.url.replace("cursor:1", "cursor:2") };
    expect((await send(h, tampered)).statusCode).toBe(401);

    const changedBody = signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/messages",
      body: JSON.stringify({ messageId: "m".repeat(16) }),
    });
    expect(
      (await send(h, { ...changedBody, body: Buffer.from('{"messageId":"x"}') })).statusCode,
    ).toBe(401);

    const otherHost = signedRequest(h, client, {
      method: "GET",
      path: "/api/device/v1/config",
      signedAuthority: "evil.example",
    });
    expect((await send(h, otherHost)).statusCode).toBe(401);

    const skewed = signedRequest(h, client, {
      method: "GET",
      path: "/api/device/v1/config",
      createdAtSeconds: Math.floor(Date.parse(h.clock.now()) / 1000) - 61,
    });
    const skewResponse = await send(h, skewed);
    expect(skewResponse.statusCode).toBe(401);
    expect(skewResponse.json()).toMatchObject({
      error: { code: "DEVICE_SIGNATURE_CLOCK_SKEW", serverTime: h.clock.now() },
    });

    for (const pathName of [
      "/api/device/v1",
      "/api/device/v1/web-session",
      "/api/device/v1/rules",
    ]) {
      const outside = await send(
        h,
        signedRequest(h, client, { method: "POST", path: pathName, body: "{}" }),
      );
      expect(outside.statusCode).toBe(404);
      expect(outside.json()).toMatchObject({ error: { code: "DEVICE_PATH_NOT_ALLOWED" } });
    }
    await h.repository.close();
  });

  it("revokes a device: its requests and its internal web session are rejected afterwards", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const device = await h.repository.pairedDevices().readDevice(client.deviceId);
    const revoked = await web(h, "revoke", {
      deviceId: client.deviceId,
      expectedRevision: client.revision,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body["device"]).toMatchObject({ status: "revoked" });
    const after = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(after.statusCode).toBe(403);
    expect(after.json()).toMatchObject({ error: { code: "DEVICE_REVOKED" } });
    const session = await h.repository
      .sessionDeviceState()
      .readSession(createSessionId(device?.webSessionId as string));
    expect(session?.status).toBe("revoked");
    await h.repository.close();
  });

  it("rejects every device request while the owner is inactive", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    h.ownerActive.current = false;
    const response = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DEVICE_OWNER_INACTIVE" } });
    await h.repository.close();
  });

  it("the device session carries no recent authentication evidence", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const device = await h.repository.pairedDevices().readDevice(client.deviceId);
    const service = new PairedDeviceService({
      store: h.repository.pairedDevices(),
      sessions: h.repository.sessionDeviceState(),
      configuration: () => h.configuration.current,
      ownerActive: async () => true,
      now: () => new Date(h.clock.now()),
    });
    const request = signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" });
    const url = new URL(request.url);
    const authenticated = await service.authenticate({
      request: {
        method: "GET",
        authority: "himawari.example",
        path: url.pathname,
        rawQuery: "",
        signatureInput: request.headers["signature-input"],
        signature: request.headers["signature"],
        contentDigest: undefined,
        contentType: undefined,
        body: Buffer.alloc(0),
      },
      expectedAuthority: "himawari.example",
    });
    expect(authenticated.authentication.sessionId).toBe(device?.webSessionId);
    expect(authenticated.authentication).not.toHaveProperty("recentAuthenticationEvidence");
    const internal = await h.repository
      .sessionDeviceState()
      .readSession(createSessionId(device?.webSessionId ?? ""));
    expect(internal?.recentAuthenticatedAt).toBe("1970-01-01T00:00:00.000Z");
    const guard = new RecentAuthenticationGuard({
      identityState: h.repository.ownerIdentityState(),
      sessionState: h.repository.sessionDeviceState(),
      policy: { maximumAgeMilliseconds: 10 * 60 * 1000, clockSkewMilliseconds: 0 },
      now: () => h.clock.now(),
    });
    await expect(
      guard.assertRecentAuthentication({
        authentication: authenticated.authentication,
        expectedAuthenticationRef: authenticated.authentication.authenticationRef,
      }),
    ).rejects.toMatchObject({ details: { reasonCode: "RECENT_AUTH_REQUIRED" } });
    await h.repository.close();
  });

  it("stops accepting new requests once the nonce store for a device is full", async () => {
    const h = await harness();
    h.configuration.current = {
      ...h.configuration.current,
      limits: { ...h.configuration.current.limits, "device.nonce.retained": 2 },
    };
    const client = await pairAndConfirm(h);
    for (let index = 0; index < 2; index += 1)
      expect(
        (await send(h, signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" })))
          .statusCode,
      ).toBe(200);
    const full = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(full.statusCode).toBe(429);
    expect(full.json()).toMatchObject({ error: { code: "DEVICE_NONCE_STORE_FULL" } });
    expect(
      (await send(h, signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" })))
        .statusCode,
    ).toBe(429);
    expect(h.warnings).toEqual([
      { event: "device.nonce_store_full", deviceId: client.deviceId, retained: 2 },
    ]);
    h.clock.advance(121_000);
    expect(
      (await send(h, signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" })))
        .statusCode,
    ).toBe(200);
    await h.repository.close();
  });

  it("rejects a request body above device.request.body_bytes", async () => {
    const h = await harness();
    h.configuration.current = {
      ...h.configuration.current,
      limits: { ...h.configuration.current.limits, "device.request.body_bytes": 1024 },
    };
    const client = await pairAndConfirm(h);
    const response = await send(
      h,
      signedRequest(h, client, {
        method: "POST",
        path: "/api/device/v1/messages",
        body: JSON.stringify({ text: "x".repeat(2000) }),
      }),
    );
    expect(response.statusCode).toBe(413);
    await h.repository.close();
  });
});

describe("[P1-1] device messages and event stream", () => {
  it("puts a device message into the existing conversation once, even when sent twice", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-device-01");
    const message = JSON.stringify({
      messageId: "device-message-0001",
      threadId: "thread-device-01",
      expectedRevision: 1,
      text: "周六七点和小林吃饭",
    });
    const first = await send(
      h,
      signedRequest(h, client, { method: "POST", path: "/api/device/v1/messages", body: message }),
    );
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ type: "thread.command_result" });
    const second = await send(
      h,
      signedRequest(h, client, { method: "POST", path: "/api/device/v1/messages", body: message }),
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      type: "thread.command_result",
      payload: { replayed: true },
    });
    const listed = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/threads" }),
    );
    expect(listed.json()).toMatchObject({
      payload: { threads: [{ threadId: "thread-device-01", revision: 2 }] },
    });
    const stored = await h.repository.pairedDevices().readDevice(client.deviceId);
    const session = await h.repository
      .sessionDeviceState()
      .readSession(createSessionId(stored?.webSessionId ?? ""));
    for (const body of [first.body, second.body, listed.body])
      for (const secret of [
        stored?.webSessionId,
        session?.authenticationRef,
        session?.authenticationRef.slice("sha256:".length),
      ])
        expect(body).not.toContain(secret);
    await h.repository.close();
  });

  it("returns the first result when a message is resent with the same messageId and another revision", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-device-01");
    const body = (expectedRevision: number, text = "明天提醒我交房租") =>
      JSON.stringify({
        messageId: "device-message-0002",
        threadId: "thread-device-01",
        expectedRevision,
        text,
      });
    const post = (payload: string) =>
      send(
        h,
        signedRequest(h, client, {
          method: "POST",
          path: "/api/device/v1/messages",
          body: payload,
        }),
      );
    const first = await post(body(1));
    expect(first.statusCode, first.body).toBe(200);
    const resent = await post(body(2));
    expect(resent.statusCode, resent.body).toBe(200);
    expect(resent.json().payload).toMatchObject({
      commandId: first.json().payload.commandId,
      threadRevision: 2,
      replayed: true,
    });
    const changed = await post(body(2, "改了内容"));
    expect(changed.statusCode).toBe(409);
    await h.repository.close();
  });

  it("streams events after a cursor without loss or duplicates and asks for a full refetch when the cursor is unknown", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-device-02");
    await createThread(h, "thread-device-03");
    const read = async (query: string) => {
      const response = await h.app.inject({
        ...(await (async () => {
          const request = signedRequest(h, client, {
            method: "GET",
            path: "/api/device/v1/stream",
            query,
          });
          const url = new URL(request.url);
          return {
            method: "GET" as const,
            url: url.pathname + url.search,
            headers: request.headers,
          };
        })()),
        payloadAsStream: true,
      });
      const chunks: string[] = [];
      const stream = response.stream();
      const done = new Promise<void>((resolve) => {
        stream.on("data", (chunk: Buffer) => {
          chunks.push(chunk.toString("utf8"));
          const text = chunks.join("");
          if (
            text.includes("thread.snapshot_required") ||
            (text.match(/thread-cursor:/gu)?.length ?? 0) >= 1
          )
            resolve();
        });
        stream.on("end", () => resolve());
      });
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 3000))]);
      stream.destroy();
      return chunks.join("");
    };
    const afterFirst = await read("after=thread-cursor:1");
    expect(afterFirst).toContain("thread-cursor:2");
    expect(afterFirst).not.toContain('"cursor":"thread-cursor:1"');
    const unknown = await read("after=thread-cursor:999");
    expect(unknown).toContain("thread.snapshot_required");
    await h.repository.close();
  });

  it("sends only conversation events the device shows and still reports the cursor of skipped ones", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-device-04");
    await threadCommand(h, "thread.pin", "pin:thread-device-04", (resultRef) => ({
      threadId: "thread-device-04",
      expectedRevision: 1,
      pinOrder: 0,
      resultRef,
    }));
    await createThread(h, "thread-device-05");
    const request = signedRequest(h, client, {
      method: "GET",
      path: "/api/device/v1/stream",
      query: "after=thread-cursor:1",
    });
    const url = new URL(request.url);
    const response = await h.app.inject({
      method: "GET",
      url: url.pathname + url.search,
      headers: request.headers,
      payloadAsStream: true,
    });
    const chunks: string[] = [];
    const stream = response.stream();
    await Promise.race([
      new Promise<void>((resolve) => {
        stream.on("data", (chunk: Buffer) => {
          chunks.push(chunk.toString("utf8"));
          if (chunks.join("").includes("thread-cursor:3")) resolve();
        });
      }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    stream.destroy();
    const frames = chunks
      .join("")
      .split("\n\n")
      .filter((frame) => frame.includes("thread-cursor:"));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain("id: thread-cursor:2");
    expect(frames[0]).toContain("event: device.scanned");
    expect(frames[0]).not.toContain("thread.pin");
    expect(frames[1]).toContain("id: thread-cursor:3");
    expect(frames[1]).toContain("event: message");
    expect(frames[1]).toContain('"eventType":"thread.create"');
    await h.repository.close();
  });

  it("drops an open stream at the next heartbeat after the device is revoked", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const request = signedRequest(h, client, {
      method: "GET",
      path: "/api/device/v1/stream",
    });
    const url = new URL(request.url);
    const response = await h.app.inject({
      method: "GET",
      url: url.pathname + url.search,
      headers: request.headers,
      payloadAsStream: true,
    });
    const stream = response.stream();
    const chunks: string[] = [];
    const ended = new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
      stream.on("end", () => resolve());
    });
    await web(h, "revoke", { deviceId: client.deviceId, expectedRevision: client.revision });
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2500))]);
    expect(chunks.join("")).toContain("IDENTITY_SESSION_INVALID");
    stream.destroy();
    await h.repository.close();
  });
});

describe("[P1-1] device client routes", () => {
  const post = (h: Harness, client: PairedClient, path: string, body: unknown) =>
    send(
      h,
      signedRequest(h, client, {
        method: "POST",
        path: `/api/device/v1/${path}`,
        body: JSON.stringify(body),
      }),
    );
  const get = (h: Harness, client: PairedClient, path: string, query?: string) =>
    send(
      h,
      signedRequest(h, client, {
        method: "GET",
        path: `/api/device/v1/${path}`,
        ...(query ? { query } : {}),
      }),
    );

  it("[iOS-5] remembers which utterance a spoken command came from and refuses a malformed utterance id", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const created = await post(h, client, "threads", {
      requestId: "device-request-0101",
      answerLocale: "zh-CN",
    });
    const threadId = created.json().payload.threadId as string;
    const message = {
      messageId: "device-message-0101",
      threadId,
      expectedRevision: 1,
      text: "帮我把明天的会改到下午",
    };
    const scope = { ownerId, agentId };
    const known = () =>
      h.repository.perception().commandUtterances({
        ...scope,
        utteranceIds: ["utterance-0101", "utterance-0102"],
      });
    expect(
      (await post(h, client, "messages", { ...message, utteranceId: "bad id!" })).statusCode,
    ).toBe(400);
    expect((await post(h, client, "messages", { ...message, utteranceId: 7 })).statusCode).toBe(
      400,
    );
    expect(await known()).toEqual([]);
    const sent = await post(h, client, "messages", { ...message, utteranceId: "utterance-0101" });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(await known()).toEqual(["utterance-0101"]);
    const resent = await post(h, client, "messages", { ...message, utteranceId: "utterance-0101" });
    expect(resent.statusCode, resent.body).toBe(200);
    expect(await known()).toEqual(["utterance-0101"]);
  });

  it("creates a conversation once per requestId and reads its messages and texts back", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const request = { requestId: "device-request-0001", answerLocale: "zh-CN" };
    const created = await post(h, client, "threads", request);
    expect(created.statusCode, created.body).toBe(200);
    const threadId = created.json().payload.threadId as string;
    expect(threadId).toMatch(/^thread-device-[0-9a-f]{32}$/u);
    const again = await post(h, client, "threads", request);
    expect(again.json().payload).toMatchObject({ threadId, replayed: true });
    expect((await post(h, client, "threads", { ...request, answerLocale: "fr" })).statusCode).toBe(
      400,
    );
    expect((await post(h, client, "threads", { ...request, extra: 1 })).statusCode).toBe(400);

    const sent = await post(h, client, "messages", {
      messageId: "device-message-0010",
      threadId,
      expectedRevision: 1,
      text: "周六七点和小林吃饭",
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const detail = await get(h, client, `threads/${threadId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const snapshot = detail.json() as {
      type: string;
      payload: { messages: { role: string; contentRef: string; sequence: number }[] };
    };
    expect(snapshot.type).toBe("thread.detail_snapshot");
    const owner = snapshot.payload.messages.find((message) => message.role === "owner");
    expect(owner?.sequence).toBe(1);
    const later = await get(h, client, `threads/${threadId}`, "after=1");
    expect(later.json().payload.messages).toEqual([]);
    expect((await get(h, client, `threads/${threadId}`, "after=-1")).statusCode).toBe(400);

    const missing = "payload:http:0000000000000000000000000000000000000000000000000000000000000000";
    const texts = await post(h, client, "payloads/text", {
      refs: [owner?.contentRef, missing],
    });
    expect(texts.statusCode, texts.body).toBe(200);
    expect(texts.json()).toEqual({
      items: {
        [owner?.contentRef as string]: {
          text: "周六七点和小林吃饭",
          contentType: "text/plain",
          dataClassification: "private",
        },
        [missing]: null,
      },
      deferred: [],
    });
    expect((await post(h, client, "payloads/text", { refs: [missing, missing] })).statusCode).toBe(
      400,
    );
    expect((await post(h, client, "payloads/text", { refs: [] })).statusCode).toBe(400);
    expect(
      (await post(h, client, "payloads/text", { refs: [missing], extra: true })).statusCode,
    ).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, index) => `payload:test-${index}`);
    expect((await post(h, client, "payloads/text", { refs: tooMany })).statusCode).toBe(413);

    const stored = await h.repository.pairedDevices().readDevice(client.deviceId);
    const session = await h.repository
      .sessionDeviceState()
      .readSession(createSessionId(stored?.webSessionId ?? ""));
    for (const body of [created.body, detail.body, texts.body])
      for (const secret of [
        stored?.webSessionId,
        session?.authenticationRef,
        session?.authenticationRef.slice("sha256:".length),
      ])
        expect(body).not.toContain(secret);
    await h.repository.close();
  });

  it("reads the steps of one run in a conversation", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const created = await post(h, client, "threads", {
      requestId: "device-request-0003",
      answerLocale: "ja",
    });
    const threadId = created.json().payload.threadId as string;
    await post(h, client, "messages", {
      messageId: "device-message-0012",
      threadId,
      expectedRevision: 1,
      text: "hello",
    });
    const detail = await get(h, client, `threads/${threadId}`);
    const runId = detail.json().payload.runs[0].runId as string;
    const steps = await get(h, client, `threads/${threadId}/runs/${runId}/execution`, "after=0");
    expect(steps.statusCode, steps.body).toBe(200);
    expect(steps.json()).toMatchObject({
      type: "thread.execution_snapshot",
      payload: { threadId, runId, records: [] },
    });
    expect(
      (await get(h, client, `threads/${threadId}/runs/${runId}/execution`, "after=x")).statusCode,
    ).toBe(400);
    expect(
      (await get(h, client, `threads/${threadId}/runs/run:missing/execution`)).statusCode,
    ).toBe(404);
    expect((await get(h, client, `threads/${threadId}/runs/${runId}`)).statusCode).toBe(404);
    expect((await get(h, client, `threads/${threadId}/runs/${runId}`)).json()).toMatchObject({
      error: { code: "DEVICE_PATH_NOT_ALLOWED" },
    });
    const stored = await h.repository.pairedDevices().readDevice(client.deviceId);
    const session = await h.repository
      .sessionDeviceState()
      .readSession(createSessionId(stored?.webSessionId ?? ""));
    for (const secret of [stored?.webSessionId, session?.authenticationRef])
      expect(steps.body).not.toContain(secret);
    await createThread(h, "execution-stream");
    const named = await get(h, client, "threads/execution-stream");
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json()).toMatchObject({
      type: "thread.detail_snapshot",
      payload: { thread: { threadId: "execution-stream" } },
    });
    await h.repository.close();
  });

  it("defers the texts that do not fit in one response", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const admission = new ProductionHttpPayloadAdmission({
      ownerId,
      agentId,
      sessions: h.repository.sessionDeviceState(),
      payloads: h.repository.payloadStore(ownerId, agentId),
      protector: new EnvelopePayloadProtector({
        keys: {
          kind: "memory-development",
          productionSuitable: false,
          resolve: async () => new Uint8Array(32).fill(9),
        },
        activeKey: { keyRef: "test-kek", kekVersion: "v1", dekVersion: "v1" },
      }),
      clock: () => h.clock.now(),
    });
    const refs: string[] = [];
    for (let index = 0; index < 70; index += 1)
      refs.push(
        (
          await admission.protect({
            authentication: h.webAuthentication,
            idempotencyKey: `large-text-${index}`,
            content: String(index % 10).repeat(64_000),
            dataClassification: "private",
            contentType: "text/plain",
          })
        ).payloadRef,
      );
    const first = await post(h, client, "payloads/text", { refs });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { items: Record<string, unknown>; deferred: string[] };
    const included = Object.keys(body.items);
    expect(included).toEqual(refs.slice(0, included.length));
    expect(body.deferred).toEqual(refs.slice(included.length));
    expect(included.length * 64_000).toBeLessThanOrEqual(DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES);
    expect(body.deferred.length).toBeGreaterThan(0);
    const rest = await post(h, client, "payloads/text", { refs: body.deferred });
    expect(Object.keys(rest.json().items)).toEqual(body.deferred);
    expect(rest.json().deferred).toEqual([]);
    await h.repository.close();
  });

  it("streams run progress for one conversation and stops after the device is revoked", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const created = await post(h, client, "threads", {
      requestId: "device-request-0002",
      answerLocale: "en",
    });
    const threadId = created.json().payload.threadId as string;
    await post(h, client, "messages", {
      messageId: "device-message-0011",
      threadId,
      expectedRevision: 1,
      text: "hello",
    });
    const request = signedRequest(h, client, {
      method: "GET",
      path: `/api/device/v1/threads/${threadId}/execution-stream`,
    });
    const response = await h.app.inject({
      method: "GET",
      url: new URL(request.url).pathname,
      headers: request.headers,
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    const stream = response.stream();
    const chunks: string[] = [];
    const ended = new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
      stream.on("end", () => resolve());
    });
    await expect
      .poll(() => chunks.join(""), { timeout: 3000 })
      .toContain("event: thread.execution_changed");
    expect(chunks.join("")).toContain(`"threadId":"${threadId}"`);
    await web(h, "revoke", { deviceId: client.deviceId, expectedRevision: client.revision });
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2500))]);
    expect(chunks.join("")).toMatch(/IDENTITY_SESSION_INVALID|DEVICE_REVOKED/u);
    stream.destroy();
    await h.repository.close();
  });

  it("lets a new stream from the same device replace its oldest one when every slot is taken", async () => {
    const h = await harness();
    h.configuration.current = {
      ...h.configuration.current,
      connectionMaxSeconds: 60,
      streamConnections: 1,
    };
    const client = await pairAndConfirm(h);
    const other = await pairAndConfirm(h);
    const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
    const connect = (who: PairedClient) =>
      new Promise<{ status: number; ended: Promise<void>; drop: () => void }>((resolve, reject) => {
        const request = signedRequest(h, who, { method: "GET", path: "/api/device/v1/stream" });
        const url = new URL(request.url);
        const outgoing = httpRequest(
          `${address}${url.pathname}${url.search}`,
          { method: "GET", headers: request.headers },
          (response) => {
            const ended = new Promise<void>((done) => {
              response.on("close", () => done());
              response.on("error", () => done());
            });
            response.resume();
            resolve({ status: response.statusCode ?? 0, ended, drop: () => outgoing.destroy() });
          },
        );
        outgoing.on("error", () => undefined);
        outgoing.once("error", reject);
        outgoing.end();
      });
    const stale = await connect(client);
    expect(stale.status).toBe(200);
    const otherDevice = await connect(other);
    expect(otherDevice.status).toBe(200);
    const fresh = await connect(client);
    expect(fresh.status).toBe(200);
    await stale.ended;
    const newest = await connect(client);
    expect(newest.status).toBe(200);
    await fresh.ended;
    let otherEnded = false;
    void otherDevice.ended.then(() => {
      otherEnded = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(otherEnded).toBe(false);
    const replaced = h.warnings.filter((warning) => warning.event === "device.stream_replaced");
    expect(replaced).toHaveLength(2);
    expect(replaced[0]).toMatchObject({ deviceId: client.deviceId, path: "stream" });
    newest.drop();
    otherDevice.drop();
    await h.app.close();
    await h.repository.close();
  });

  it("records why the device's previous stream ended when it opens the next one", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const request = signedRequest(h, client, {
      method: "GET",
      path: "/api/device/v1/stream",
      query:
        "lastDrop=silent&lastConnected=1834&lastStatus=429&offline=12&attempts=2&lastError=-1005",
    });
    const url = new URL(request.url);
    const response = await h.app.inject({
      method: "GET",
      url: url.pathname + url.search,
      headers: request.headers,
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    response.stream().destroy();
    expect(h.warnings).toContainEqual({
      event: "device.stream_opened",
      deviceId: client.deviceId,
      path: "stream",
      lastDrop: "silent",
      lastConnected: 1834,
      lastStatus: 429,
      lastError: -1005,
      offline: 12,
      attempts: 2,
    });
    await h.repository.close();
  });

  it("answers a refused stream handshake with an error body", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const created = await post(h, client, "threads", {
      requestId: "device-request-0004",
      answerLocale: "zh-CN",
    });
    const threadId = created.json().payload.threadId as string;
    const paths = ["/api/device/v1/stream", `/api/device/v1/threads/${threadId}/execution-stream`];
    for (const path of paths) {
      const skewed = signedRequest(h, client, {
        method: "GET",
        path,
        createdAtSeconds: Math.floor(Date.parse(h.clock.now()) / 1000) - 3600,
      });
      const response = await send(h, skewed);
      expect(response.statusCode).toBe(401);
      expect(response.headers["content-type"]).toMatch(/application\/json/u);
      expect(response.json()).toEqual({
        error: { code: "DEVICE_SIGNATURE_CLOCK_SKEW", serverTime: h.clock.now() },
      });
    }
    await web(h, "revoke", { deviceId: client.deviceId, expectedRevision: client.revision });
    for (const path of paths) {
      const response = await send(h, signedRequest(h, client, { method: "GET", path }));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: "DEVICE_REVOKED" } });
    }
    await h.repository.close();
  });

  it("stores canonical keys and rejects one key used as both device and confirm key", async () => {
    const h = await harness();
    const keys = generateDeviceTestKeyPair();
    const unpadded = keys.publicKeySpkiBase64.replace(/=+$/u, "");
    expect(unpadded).not.toBe(keys.publicKeySpkiBase64);
    const code = await issueSetupCode(h);
    const device = (devicePublicKey: string, confirmPublicKey: string) => ({
      kind: "iphone",
      name: "Andy iPhone",
      releaseChannel: "direct",
      devicePublicKey,
      confirmPublicKey,
    });
    const same = await signInRequest(h, "setup/options", {
      setupCode: code,
      device: device(keys.publicKeySpkiBase64, unpadded),
    });
    expect(same.statusCode).toBe(400);
    const options = await signInRequest(h, "setup/options", {
      setupCode: code,
      device: device(unpadded, generateDeviceTestKeyPair().publicKeySpkiBase64),
    });
    expect(options.statusCode, options.body).toBe(200);
    const started = options.json() as {
      flowId: string;
      publicKey: { challenge: string; rp: { id: string } };
    };
    const finished = await signInRequest(h, "setup/finish", {
      flowId: started.flowId,
      credential: h.passkey.create(started.publicKey),
    });
    expect(finished.statusCode, finished.body).toBe(201);
    const stored = await h.repository.pairedDevices().readDevice(finished.json().device.id);
    expect(stored?.devicePublicKey).toBe(keys.publicKeySpkiBase64);
    await h.repository.close();
  });

  it("rejects unknown fields on the owner's device management routes", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const device = { id: client.deviceId, revision: client.revision };
    expect((await web(h, "list", { extra: 1 })).status).toBe(400);
    for (const action of ["revoke"])
      expect(
        (await web(h, action, { deviceId: device.id, expectedRevision: device.revision, x: 1 }))
          .status,
      ).toBe(400);
    expect(
      (
        await web(h, "rename", {
          deviceId: device.id,
          expectedRevision: device.revision,
          name: "New",
          x: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await web(h, "rename", {
          deviceId: device.id,
          expectedRevision: device.revision,
          name: "New",
        })
      ).status,
    ).toBe(200);
    await h.repository.close();
  });

  it("marks the paired device removed when its signed-in browser entry is revoked from the account page", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const sessions = h.repository.sessionDeviceState();
    const stored = await h.repository.pairedDevices().readDevice(client.deviceId);
    const browser = (await sessions.listDevices(ownerId, false)).find(
      (device) => device.id === stored?.webDeviceId,
    );
    expect(browser).toBeDefined();
    const other = await pairAndConfirm(h);
    await sessions.revokeDevice(browser?.id as never, browser?.revision ?? -1, h.clock.now());
    const listed = (await web(h, "list")).body["devices"] as { id: string; status: string }[];
    expect(listed.find((device) => device.id === client.deviceId)?.status).toBe("revoked");
    expect(listed.find((device) => device.id === other.deviceId)?.status).toBe("active");
    const refused = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(refused.statusCode).toBe(403);
    const allowed = await send(
      h,
      signedRequest(h, other, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(allowed.statusCode).toBe(200);
    await h.repository.close();
  });

  it("rejects device names with hidden characters the same way as the gateway contract", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    for (const name of [
      "Desk\u202eMac",
      "Desk\u0007Mac",
      "Desk\u061cMac",
      "Desk\u2028Mac",
      "Desk\u180eMac",
      "   ",
      "x".repeat(65),
    ]) {
      const renamed = await web(h, "rename", {
        deviceId: client.deviceId,
        expectedRevision: client.revision,
        name,
      });
      expect(renamed.status, name).toBe(400);
    }
    const trimmed = await web(h, "rename", {
      deviceId: client.deviceId,
      expectedRevision: client.revision,
      name: "  Desk Mac  ",
    });
    expect((trimmed.body["device"] as { name: string }).name).toBe("Desk Mac");
    await h.repository.close();
  });

  it("renames the confirmed device and its signed-in browser entry together", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const renamed = await web(h, "rename", {
      deviceId: client.deviceId,
      expectedRevision: client.revision,
      name: "客厅 Mac",
    });
    expect(renamed.status).toBe(200);
    const stored = await h.repository.pairedDevices().readDevice(client.deviceId);
    const browserDevices = await h.repository.sessionDeviceState().listDevices(ownerId, false);
    expect(browserDevices.find((device) => device.id === stored?.webDeviceId)?.label).toBe(
      "客厅 Mac",
    );
    expect(browserDevices.map((device) => device.label)).not.toContain("Andy iPhone");
    await h.repository.close();
  });

  it("stops reading a body without a declared length once it passes the device limit", async () => {
    const h = await harness();
    h.configuration.current = {
      ...h.configuration.current,
      limits: { ...h.configuration.current.limits, "device.request.body_bytes": 4096 },
    };
    const chunked = (size: number) =>
      h.app.inject({
        method: "POST",
        url: "/api/device/v1/sign-in/options",
        headers: { host: "himawari.example", "content-type": "application/json" },
        payload: Readable.from([Buffer.from(JSON.stringify({ name: "x".repeat(size) }))]),
      });
    const large = await chunked(8000);
    expect(large.statusCode, large.body).toBe(413);
    expect(large.json()).toMatchObject({ error: { code: "DEVICE_BODY_TOO_LARGE" } });
    expect((await chunked(100)).statusCode).toBe(400);
    await h.repository.close();
  });

  it("accepts a device body above the browser limit when the device limit allows it", async () => {
    const h = await harness();
    h.configuration.current = {
      ...h.configuration.current,
      limits: { ...h.configuration.current.limits, "device.request.body_bytes": 2 * 1024 * 1024 },
    };
    const client = await pairAndConfirm(h);
    const large = await post(h, client, "messages", { text: "x".repeat(1_500_000) });
    expect(large.statusCode).toBe(400);
    h.configuration.current = {
      ...h.configuration.current,
      limits: { ...h.configuration.current.limits, "device.request.body_bytes": 1024 * 1024 },
    };
    expect((await post(h, client, "messages", { text: "x".repeat(1_500_000) })).statusCode).toBe(
      413,
    );
    await h.repository.close();
  });
});

describe("[P1-1] device kinds in the database", () => {
  it("keeps the kind and release channel lists equal to the program and refuses unregistered values", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-device-kinds-"));
    try {
      const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
      applyMigrations(database, await loadBundledMigrations());
      const column = (sql: string) =>
        (database.prepare(sql).all() as Record<string, string>[]).map(
          (row) => Object.values(row)[0],
        );
      expect(column("SELECT kind FROM paired_device_kinds ORDER BY kind")).toEqual(
        [...PAIRED_DEVICE_KINDS].sort(),
      );
      expect(
        column(
          "SELECT release_channel FROM paired_device_release_channels ORDER BY release_channel",
        ),
      ).toEqual([...PAIRED_DEVICE_RELEASE_CHANNELS].sort());
      database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-kinds', 0)").run();
      database
        .prepare(
          "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-kinds', 'owner-kinds', 0)",
        )
        .run();
      const insert = (kind: string, channel: string, id: string) =>
        database
          .prepare(
            `INSERT INTO paired_devices (id, owner_id, agent_id, revision, kind, name, release_channel,
               device_public_key, confirm_public_key, status, supported_actions, paired_at)
             VALUES (?, 'owner-kinds', 'agent-kinds', 0, ?, 'n', ?, 'a', 'b', 'pending', '[]',
               '2026-11-14T00:00:00.000Z')`,
          )
          .run(id, kind, channel);
      expect(() => insert("iphone", "direct", `dev_${"a".repeat(22)}`)).not.toThrow();
      expect(() => insert("ipad", "direct", `dev_${"b".repeat(22)}`)).toThrow(/not registered/u);
      expect(() => insert("mac", "sideload", `dev_${"c".repeat(22)}`)).toThrow(/not registered/u);
      expect(() =>
        database
          .prepare("UPDATE paired_devices SET kind = 'tv' WHERE id = ?")
          .run(`dev_${"a".repeat(22)}`),
      ).toThrow(/not registered/u);
      database.prepare("INSERT INTO paired_device_kinds (kind) VALUES ('ipad')").run();
      expect(() => insert("ipad", "direct", `dev_${"d".repeat(22)}`)).not.toThrow();
      database.close();
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
