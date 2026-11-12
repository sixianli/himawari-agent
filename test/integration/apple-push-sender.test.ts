import { createServer } from "node:net";
import type { ApplePushSendRequest } from "@himawari-agent/application";
import {
  applePushTopic,
  classifyApplePushResponse,
  createApplePushSender,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { type ApnsStub, startApnsStub } from "../fixtures/apns-stub.ts";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const request: ApplePushSendRequest = {
  token: "ab".repeat(32),
  environment: "production",
  topic: "win.siyi.himawari",
  pushType: "alert",
  priority: 10,
  expiresAtSeconds: 1_800_000_000,
  collapseId: "collapse-1",
  payload: JSON.stringify({ aps: { alert: { title: "t", body: "b" } } }),
};

async function setup(requestTimeoutSeconds = 5) {
  const apns: ApnsStub = await startApnsStub();
  const clock = { now: Date.parse("2026-11-12T00:00:00.000Z") };
  const sender = createApplePushSender({
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    signingKey: apns.signingKeyPem,
    requestTimeoutSeconds,
    origins: apns.origins,
    now: () => clock.now,
  });
  closers.push(
    () => apns.close(),
    () => sender.close(),
  );
  const issuedAt = (index: number) =>
    (
      JSON.parse(
        Buffer.from(
          String(apns.requests[index]?.headers["authorization"]).split(".")[1] ?? "",
          "base64url",
        ).toString(),
      ) as { iat: number }
    ).iat;
  return { apns, sender, clock, issuedAt };
}

describe("[IOS-4] APNs sender", () => {
  it("[IOS-4] posts to the device path with the Apple headers and derives the topic from the push type", async () => {
    const { apns, sender } = await setup();
    expect(await sender.send(request)).toEqual({ kind: "sent" });
    expect(await sender.send({ ...request, pushType: "widgets", collapseId: null })).toEqual({
      kind: "sent",
    });
    expect(apns.requests[0]?.path).toBe(`/3/device/${request.token}`);
    expect(apns.requests[0]?.headers).toMatchObject({
      ":method": "POST",
      "apns-push-type": "alert",
      "apns-topic": "win.siyi.himawari",
      "apns-priority": "10",
      "apns-expiration": "1800000000",
      "apns-collapse-id": "collapse-1",
    });
    expect(String(apns.requests[0]?.headers["apns-id"])).toMatch(/^[0-9a-f-]{36}$/u);
    expect(apns.requests[0]?.body).toBe(request.payload);
    expect(apns.requests[1]?.headers["apns-topic"]).toBe("win.siyi.himawari.push-type.widgets");
    expect(apns.requests[1]?.headers["apns-collapse-id"]).toBeUndefined();
    expect(applePushTopic("a.b", "liveactivity")).toBe("a.b.push-type.liveactivity");
    expect(applePushTopic("a.b", "background")).toBe("a.b");
  });

  it("[IOS-4] reuses one provider token for 50 minutes and then signs a new one", async () => {
    const { sender, clock, issuedAt, apns } = await setup();
    await sender.send(request);
    clock.now += 49 * 60_000;
    await sender.send(request);
    clock.now += 60_000;
    await sender.send(request);
    expect(apns.requests).toHaveLength(3);
    expect(issuedAt(1)).toBe(issuedAt(0));
    expect(issuedAt(2)).toBe(issuedAt(0) + 50 * 60);
  });

  it("[IOS-4] after Apple calls the provider token expired it retries, and signs a new one only once the old one is 20 minutes old", async () => {
    const { sender, clock, issuedAt, apns } = await setup();
    apns.respond = () => ({ status: 403, reason: "ExpiredProviderToken" });
    expect(await sender.send(request)).toEqual({
      kind: "retry",
      code: "APNS_403_ExpiredProviderToken",
    });
    apns.respond = () => ({ status: 200 });
    clock.now += 60_000;
    await sender.send(request);
    expect(issuedAt(1)).toBe(issuedAt(0));
    clock.now += 20 * 60_000;
    await sender.send(request);
    expect(issuedAt(2)).toBe(issuedAt(0) + 21 * 60);
  });

  it("[IOS-4] maps Apple's answers to what the dispatcher should do next", async () => {
    const { sender, apns } = await setup();
    const cases: readonly [number, string, string, string | undefined][] = [
      [410, "Unregistered", "gone", "APNS_410_Unregistered"],
      [400, "BadDeviceToken", "gone", "APNS_400_BadDeviceToken"],
      [400, "DeviceTokenNotForTopic", "gone", "APNS_400_DeviceTokenNotForTopic"],
      [400, "BadTopic", "rejected", "APNS_400_BadTopic"],
      [403, "InvalidProviderToken", "rejected", "APNS_403_InvalidProviderToken"],
      [413, "PayloadTooLarge", "too_large", "APNS_413_PayloadTooLarge"],
      [429, "TooManyRequests", "rate_limited", "APNS_429_TooManyRequests"],
      [500, "InternalServerError", "retry", "APNS_500_InternalServerError"],
      [503, "Shutdown", "retry", "APNS_503_Shutdown"],
    ];
    for (const [status, reason, kind, code] of cases) {
      apns.respond = () => ({ status, reason });
      expect(await sender.send(request), reason).toEqual({ kind, code });
    }
    apns.respond = () => ({ status: 400, reason: "<script>" });
    expect(await sender.send(request)).toEqual({ kind: "rejected", code: "APNS_400" });
    expect(classifyApplePushResponse(200, "")).toEqual({ kind: "sent" });
  });

  it("[IOS-4] refuses a payload over 4096 bytes without contacting Apple", async () => {
    const { sender, apns } = await setup();
    expect(await sender.send({ ...request, payload: "界".repeat(1_366) })).toEqual({
      kind: "too_large",
      code: "APNS_PAYLOAD_TOO_LARGE",
    });
    const largest = JSON.stringify({ aps: { alert: "a".repeat(4_096 - 20) } });
    expect(Buffer.byteLength(largest)).toBe(4_096);
    expect(await sender.send({ ...request, payload: largest })).toEqual({ kind: "sent" });
    expect(apns.requests).toHaveLength(1);
  });

  it("[IOS-4] reports a retry when Apple cannot be reached or does not answer in time", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as { port: number };
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { apns } = await setup();
    const unreachable = createApplePushSender({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      signingKey: apns.signingKeyPem,
      requestTimeoutSeconds: 5,
      origins: {
        development: `http://127.0.0.1:${port}`,
        production: `http://127.0.0.1:${port}`,
      },
    });
    closers.push(() => unreachable.close());
    expect(await unreachable.send(request)).toEqual({ kind: "retry", code: "APNS_CONNECTION" });

    const silent = createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const silentPort = (silent.address() as { port: number }).port;
    const sockets = new Set<import("node:net").Socket>();
    silent.on("connection", (socket) => sockets.add(socket));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          silent.close(() => resolve());
        }),
    );
    const slow = createApplePushSender({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      signingKey: apns.signingKeyPem,
      requestTimeoutSeconds: 1,
      origins: {
        development: `http://127.0.0.1:${silentPort}`,
        production: `http://127.0.0.1:${silentPort}`,
      },
    });
    closers.push(() => slow.close());
    expect(await slow.send(request)).toEqual({ kind: "retry", code: "APNS_TIMEOUT" });
  });

  it("[IOS-4] refuses a signing key that is not a P-256 key", async () => {
    expect(() =>
      createApplePushSender({
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        signingKey: new TextEncoder().encode("not a key"),
        requestTimeoutSeconds: 5,
      }),
    ).toThrow();
  });
});
