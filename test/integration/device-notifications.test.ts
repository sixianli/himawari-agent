import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  harness,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

const post = (h: Harness, client: PairedClient, path: string, body: unknown) =>
  send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: `/api/device/v1/${path}`,
      body: JSON.stringify(body),
    }),
  );

async function openStream(h: Harness, client: PairedClient) {
  const request = signedRequest(h, client, { method: "GET", path: "/api/device/v1/stream" });
  const url = new URL(request.url);
  const response = await h.app.inject({
    method: "GET",
    url: url.pathname + url.search,
    headers: request.headers,
    payloadAsStream: true,
  });
  const chunks: string[] = [];
  const stream = response.stream();
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { text: () => chunks.join(""), close: () => stream.destroy() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("[IOS-9] one place rings: device notification interface", () => {
  it("records a Mac's last input, clamped to server time, and answers the server time", async () => {
    const h = await harness();
    const mac = await pairAndConfirm(h, "Andy Mac", "mac");
    const now = Date.now();
    const recorded = await post(h, mac, "presence", {
      lastInputAt: new Date(now - 30_000).toISOString(),
    });
    expect(recorded.statusCode).toBe(200);
    const { ok, serverTime } = recorded.json() as { ok: boolean; serverTime: string };
    expect(ok).toBe(true);
    expect(Math.abs(Date.parse(serverTime) - now)).toBeLessThan(5_000);
    expect(h.notifications.presence.recent(now, 60_000)).toEqual([mac.deviceId]);
    expect(h.notifications.presence.recent(now, 10_000)).toEqual([]);
    await post(h, mac, "presence", {
      lastInputAt: new Date(now + 3_600_000).toISOString(),
    });
    expect(h.notifications.presence.recent(now + 10_000, 6_000)).toEqual([]);
    await h.repository.close();
  });

  it("REVERSE: refuses presence from an iPhone, from a malformed time and from extra fields", async () => {
    const h = await harness();
    const phone = await pairAndConfirm(h, "Andy iPhone", "iphone");
    const mac = await pairAndConfirm(h, "Andy Mac", "mac");
    const iso = new Date(Date.now() - 1000).toISOString();
    expect((await post(h, phone, "presence", { lastInputAt: iso })).statusCode).toBe(404);
    expect((await post(h, mac, "presence", { lastInputAt: "yesterday" })).statusCode).toBe(400);
    expect((await post(h, mac, "presence", { lastInputAt: iso, extra: 1 })).statusCode).toBe(400);
    expect(h.notifications.presence.recent(Date.now(), 3_600_000)).toEqual([]);
    await h.repository.close();
  });

  it("sends notification events on a Mac stream without an id line, and not on an iPhone stream", async () => {
    const h = await harness();
    const mac = await pairAndConfirm(h, "Andy Mac", "mac");
    const phone = await pairAndConfirm(h, "Andy iPhone", "iphone");
    const macStream = await openStream(h, mac);
    const phoneStream = await openStream(h, phone);
    await settle();
    expect(h.notifications.hub.connected(mac.deviceId)).toBe(true);
    expect(h.notifications.hub.connected(phone.deviceId)).toBe(false);
    h.notifications.hub.send(mac.deviceId, {
      event: "notification.deliver",
      data: {
        id: "abc_DEF-1",
        kind: "reminder",
        title: "t",
        body: "b",
        homeKey: null,
        createdAt: h.clock.now(),
      },
    });
    await settle();
    const text = macStream.text();
    expect(text).toContain("event: notification.deliver\ndata: ");
    expect(text).toContain('"id":"abc_DEF-1"');
    const frame = text.slice(text.indexOf("event: notification.deliver"));
    expect(frame.split("\n\n")[0]).not.toMatch(/^id:/mu);
    expect(phoneStream.text()).not.toContain("notification.");
    macStream.close();
    phoneStream.close();
    await h.repository.close();
  });

  it("a Mac stream does not count as the app being on screen", async () => {
    const h = await harness();
    const mac = await pairAndConfirm(h, "Andy Mac", "mac");
    const before = h.presence.length;
    const stream = await openStream(h, mac);
    await settle();
    expect(h.presence.length).toBe(before);
    stream.close();
    await h.repository.close();
  });

  it("answers only the ids the server says are settled", async () => {
    const h = await harness();
    const phone = await pairAndConfirm(h, "Andy iPhone", "iphone");
    h.notifications.settledAnswer.current = ["a1", "c3"];
    const answered = await post(h, phone, "notifications/settled", { ids: ["a1", "b2", "c3"] });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual({ settledIds: ["a1", "c3"] });
    expect(h.notifications.settledAsked).toEqual([["a1", "b2", "c3"]]);
    await h.repository.close();
  });

  it("REVERSE: refuses malformed settled requests and sends nothing to the server logic", async () => {
    const h = await harness();
    const phone = await pairAndConfirm(h, "Andy iPhone", "iphone");
    const tooMany = Array.from({ length: 201 }, (_, index) => `id${index}`);
    for (const body of [
      { ids: tooMany },
      { ids: ["bad id!"] },
      { ids: [1] },
      { ids: "a" },
      { ids: ["a"], extra: true },
      {},
    ])
      expect((await post(h, phone, "notifications/settled", body)).statusCode).toBe(400);
    expect(h.notifications.settledAsked).toEqual([]);
    expect((await post(h, phone, "notifications/settled", { ids: [] })).json()).toEqual({
      settledIds: [],
    });
    await h.repository.close();
  });
});
