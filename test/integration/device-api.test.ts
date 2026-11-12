import { RecentAuthenticationGuard } from "@himawari-agent/application";
import { createSessionId } from "@himawari-agent/domain";
import { PairedDeviceService } from "@himawari-agent/platform-node";
import { generateDeviceTestKeyPair } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  createThread,
  harness,
  ownerId,
  type PairedClient,
  pair,
  pairAndConfirm,
  pairingCode,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
  web,
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

describe("[P1-1] device pairing and signed device API", () => {
  it("pairs as pending, works only after the owner confirms, and never exposes the internal session", async () => {
    const h = await harness();
    const paired = await pair(h);
    expect(paired.response.statusCode).toBe(201);
    const body = paired.response.json() as { device: Record<string, unknown> };
    expect(body.device["status"]).toBe("pending");
    expect(JSON.stringify(body)).not.toMatch(/session|authentication|PublicKey/iu);
    const pending: PairedClient = {
      deviceId: body.device["id"] as string,
      keys: paired.keys,
      confirmKeys: paired.confirmKeys,
      revision: 0,
    };
    const beforeConfirm = await send(
      h,
      signedRequest(h, pending, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(beforeConfirm.statusCode).toBe(403);
    expect(beforeConfirm.json()).toMatchObject({ error: { code: "DEVICE_PENDING" } });

    const confirmed = await web(h, "confirm", {
      deviceId: pending.deviceId,
      expectedRevision: body.device["revision"],
    });
    expect(confirmed.status).toBe(200);
    expect(JSON.stringify(confirmed.body)).not.toMatch(/session|authenticationRef/iu);
    const config = await send(
      h,
      signedRequest(h, pending, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      heartbeatSeconds: 1,
      signatureToleranceSeconds: 60,
    });
    expect((config.json() as { limits: unknown[] }).limits).toHaveLength(10);

    const listed = await web(h, "list");
    expect(listed.body["devices"]).toMatchObject([{ id: pending.deviceId, status: "active" }]);
    const stored = await h.repository.pairedDevices().readDevice(pending.deviceId);
    const internalSession = stored?.webSessionId
      ? await h.repository.sessionDeviceState().readSession(createSessionId(stored.webSessionId))
      : undefined;
    expect(internalSession?.authenticationRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const everything = [
      paired.response.body,
      JSON.stringify(confirmed.body),
      config.body,
      JSON.stringify(listed.body),
    ].join("\n");
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

  it("rejects wrong, expired and used pairing codes and malformed pairing bodies", async () => {
    const h = await harness();
    const first = await pair(h);
    expect(first.response.statusCode).toBe(201);
    const reuse = await h.app.inject({
      method: "POST",
      url: "/api/device/v1/pair",
      headers: { host: "himawari.example", "content-type": "application/json" },
      payload: JSON.stringify({
        pairingCode: first.code,
        kind: "iphone",
        name: "Second",
        releaseChannel: "direct",
        devicePublicKey: generateDeviceTestKeyPair().publicKeySpkiBase64,
        confirmPublicKey: generateDeviceTestKeyPair().publicKeySpkiBase64,
      }),
    });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json()).toMatchObject({ error: { code: "DEVICE_PAIRING_CODE_USED" } });

    const started = await web(h, "pairing-codes");
    h.clock.advance(10 * 60 * 1000);
    const keys = [generateDeviceTestKeyPair(), generateDeviceTestKeyPair()];
    const expired = await h.app.inject({
      method: "POST",
      url: "/api/device/v1/pair",
      headers: { host: "himawari.example", "content-type": "application/json" },
      payload: JSON.stringify({
        pairingCode: pairingCode(started.body["pairingUri"]),
        kind: "mac",
        name: "Mac",
        releaseChannel: "mac_direct",
        devicePublicKey: keys[0]?.publicKeySpkiBase64,
        confirmPublicKey: keys[1]?.publicKeySpkiBase64,
      }),
    });
    expect(expired.statusCode).toBe(410);

    const base = {
      pairingCode: "A".repeat(22),
      kind: "iphone",
      name: "Phone",
      releaseChannel: "direct",
      devicePublicKey: keys[0]?.publicKeySpkiBase64,
      confirmPublicKey: keys[1]?.publicKeySpkiBase64,
    };
    const wrong = await h.app.inject({
      method: "POST",
      url: "/api/device/v1/pair",
      headers: { host: "himawari.example", "content-type": "application/json" },
      payload: JSON.stringify(base),
    });
    expect(wrong.statusCode).toBe(404);
    for (const invalid of [
      { ...base, kind: "ipad" },
      { ...base, releaseChannel: "sideload" },
      { ...base, confirmPublicKey: base.devicePublicKey },
      { ...base, extra: true },
      { ...base, name: "" },
    ]) {
      const response = await h.app.inject({
        method: "POST",
        url: "/api/device/v1/pair",
        headers: { host: "himawari.example", "content-type": "application/json" },
        payload: JSON.stringify(invalid),
      });
      expect(response.statusCode).toBe(400);
    }
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

    for (const pathName of ["/api/device/v1/web-session", "/api/device/v1/rules"]) {
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
