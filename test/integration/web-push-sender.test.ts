import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  classifyWebPushResponse,
  createWebPushSender,
  webPushPublicKey,
} from "@himawari-agent/platform-node";
import { importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { webPushPayload } from "../../apps/agent-service/src/production-web-push.ts";

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
const expand = (prk: Buffer, info: Buffer, length: number) =>
  hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

function decryptAes128gcm(body: Buffer, userPrivate: ReturnType<typeof createECDH>, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyIdLength = body[20] ?? 0;
  const serverPublic = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);
  const shared = userPrivate.computeSecret(serverPublic);
  const userPublic = userPrivate.getPublicKey();
  const ikm = expand(
    hmac(auth, shared),
    Buffer.concat([Buffer.from("WebPush: info\0"), userPublic, serverPublic]),
    32,
  );
  const prk = hmac(salt, ikm);
  const key = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(2);
  return { recordSize, plaintext: padded.subarray(0, end).toString("utf8") };
}

describe("[WP-4] web push sender", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function pushService(status: number, extraHeaders: Record<string, string> = {}) {
    const received: { headers: IncomingHttpHeaders; body: Buffer; url: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          headers: request.headers,
          body: Buffer.concat(chunks),
          url: request.url ?? "",
        });
        response.writeHead(status, extraHeaders).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { received, origin };
  }

  it("[WP-4] encrypts the declarative payload so only the subscribed device can read it, signed with VAPID", async () => {
    const service = await pushService(201);
    const device = createECDH("prime256v1");
    device.generateKeys();
    const auth = randomBytes(16);
    const vapidPrivate = randomBytes(32);
    const sender = createWebPushSender({
      privateKey: vapidPrivate,
      subject: "mailto:owner@example.com",
    });
    expect(sender.publicKey).toBe(webPushPublicKey(vapidPrivate));
    const payload = webPushPayload({
      title: "Himawari 提醒",
      body: "交房租\n11/1周六 09:00",
      navigate: "https://himawari.siyi.win/memory",
      lang: "zh-CN",
      tag: "topic-1",
      badge: 2,
    });
    const result = await sender.send({
      endpoint: `${service.origin}/push/device-1`,
      p256dh: device.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
      payload,
      ttlSeconds: 3_600,
      urgency: "high",
      topic: "abcdefghijklmnopqrstuvwxyz012345",
    });
    expect(result).toEqual({ kind: "sent" });
    const [request] = service.received;
    if (!request) throw new Error("push service received nothing");
    expect(request.url).toBe("/push/device-1");
    expect(request.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      ttl: "3600",
      urgency: "high",
      topic: "abcdefghijklmnopqrstuvwxyz012345",
    });
    const decrypted = decryptAes128gcm(request.body, device, auth);
    expect(JSON.parse(decrypted.plaintext)).toEqual({
      web_push: 8030,
      notification: {
        title: "Himawari 提醒",
        body: "交房租\n11/1周六 09:00",
        navigate: "https://himawari.siyi.win/memory",
        lang: "zh-CN",
        tag: "topic-1",
        app_badge: "2",
      },
    });
    expect(request.body.includes(Buffer.from("交房租"))).toBe(false);

    const authorization = String(request.headers.authorization);
    const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
    expect(match?.[2]).toBe(sender.publicKey);
    const raw = Buffer.from(sender.publicKey, "base64url");
    const key = await importJWK(
      {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      "ES256",
    );
    const { payload: claims } = await jwtVerify(match?.[1] ?? "", key, {
      audience: service.origin,
      subject: "mailto:owner@example.com",
    });
    expect(Number(claims.exp) - Date.now() / 1_000).toBeLessThanOrEqual(24 * 3_600);
  });

  it("[WP-4] maps push service answers to delivery outcomes", async () => {
    const gone = await pushService(410);
    const device = createECDH("prime256v1");
    device.generateKeys();
    const sender = createWebPushSender({
      privateKey: randomBytes(32),
      subject: "https://himawari.siyi.win",
    });
    expect(
      await sender.send({
        endpoint: `${gone.origin}/x`,
        p256dh: device.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
        payload: "{}",
        ttlSeconds: 60,
        urgency: "normal",
        topic: "t",
      }),
    ).toEqual({ kind: "gone", code: "WEB_PUSH_HTTP_410" });
    const now = Date.parse("2026-10-26T12:00:00.000Z");
    expect(classifyWebPushResponse(404, null, now).kind).toBe("gone");
    expect(classifyWebPushResponse(413, null, now).kind).toBe("too_large");
    expect(classifyWebPushResponse(429, "120", now)).toEqual({
      kind: "rate_limited",
      code: "WEB_PUSH_HTTP_429",
      retryAfterSeconds: 120,
    });
    expect(classifyWebPushResponse(429, "Mon, 26 Oct 2026 12:05:00 GMT", now)).toMatchObject({
      retryAfterSeconds: 300,
    });
    expect(classifyWebPushResponse(403, null, now)).toEqual({
      kind: "rejected",
      code: "WEB_PUSH_HTTP_403",
    });
    expect(classifyWebPushResponse(502, null, now).kind).toBe("retry");
    expect(() => webPushPublicKey(new Uint8Array(31))).toThrow("WEB_PUSH_PRIVATE_KEY_INVALID");
  });

  it("[WP-4] keeps the payload under 3 KB by shortening only the body", () => {
    const payload = webPushPayload({
      title: "Himawari 提醒",
      body: "很长的提醒".repeat(400),
      navigate: "https://himawari.siyi.win/memory",
      lang: "zh-CN",
      tag: "topic",
      badge: 0,
    });
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(3_072);
    const parsed = JSON.parse(payload) as { notification: Record<string, string> };
    expect(parsed.notification["body"]?.endsWith("…")).toBe(true);
    expect(parsed.notification["app_badge"]).toBeUndefined();
  });
});
