import { createDecipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  barkChannel,
  barkCiphertext,
  ProductionReminderPush,
} from "../src/production-reminder-push.js";

const KEY = "12345678901234567890123456789012";
const SECRET = JSON.stringify({ deviceKey: "F5u42Bd3HyW8KxkUqo2gRA", encryptionKey: KEY });

function decrypt(ciphertext: string, iv: string): unknown {
  const decipher = createDecipheriv("aes-256-cbc", Buffer.from(KEY), Buffer.from(iv));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString(
      "utf8",
    ),
  );
}

describe("Bark reminder push", () => {
  it("encrypts like openssl aes-256-cbc with the Owner's key and IV", () => {
    expect(barkCiphertext('{"body":"测试"}', KEY, "abcdefghijklmnop")).toBe(
      "nBkp+odo/tqJlcPfl59b5kKf9whNeV25mAd+zhXb7HY=",
    );
  });

  it("posts only the ciphertext and IV to the device URL", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const channel = barkChannel({
      secret: async () => SECRET,
      iv: () => "abcdefghijklmnop",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ code: 200 }), { status: 200 });
      },
    });
    await channel.send({
      title: "Himawari 提醒",
      body: "交季度报告",
      dataClassification: "private",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.day.app/F5u42Bd3HyW8KxkUqo2gRA");
    const form = new URLSearchParams(String(requests[0]?.init.body));
    expect([...form.keys()].sort()).toEqual(["ciphertext", "iv"]);
    expect(String(requests[0]?.init.body)).not.toContain(encodeURIComponent("交季度报告"));
    expect(decrypt(form.get("ciphertext") ?? "", form.get("iv") ?? "")).toEqual({
      title: "Himawari 提醒",
      body: "交季度报告",
      group: "Himawari",
      level: "timeSensitive",
    });
  });

  it("rejects a malformed secret and a refused push", async () => {
    const ok = async () => new Response(JSON.stringify({ code: 200 }), { status: 200 });
    for (const secret of [
      "not json",
      JSON.stringify({ deviceKey: "F5u42Bd3HyW8KxkUqo2gRA", encryptionKey: "short" }),
      JSON.stringify({ deviceKey: "../other", encryptionKey: KEY }),
    ])
      await expect(
        barkChannel({ secret: async () => secret, fetch: ok }).send({
          title: "t",
          body: "b",
          dataClassification: "private",
        }),
      ).rejects.toThrow("REMINDER_PUSH_SECRET_INVALID");
    await expect(
      barkChannel({
        secret: async () => SECRET,
        fetch: async () => new Response(JSON.stringify({ code: 400 }), { status: 400 }),
      }).send({ title: "t", body: "b", dataClassification: "private" }),
    ).rejects.toThrow("REMINDER_PUSH_HTTP_400");
  });
});

describe("reminder push loop", () => {
  const reminder = (id: string, remindAt: string) => ({
    id: `reminder:${id}`,
    ownerId: "owner" as never,
    agentId: "agent" as never,
    memoryId: id as never,
    dueAt: "2026-10-30T07:00:00.000Z",
    remindAt,
    repeat: "none" as const,
    status: "scheduled" as const,
    dismissedAt: null,
    createdAt: "2026-10-25T12:00:00.000Z",
    updatedAt: "2026-10-25T12:00:00.000Z",
  });
  const memory = (id: string) =>
    ({
      id,
      status: "active",
      contentRef: `payload-${id}`,
      dataClassification: "private",
    }) as never;

  it("pushes each due reminder once, retries failures, skips stale ones and re-pushes after a snooze", async () => {
    let due = [
      reminder("report", "2026-10-30T06:00:00.000Z"),
      reminder("old", "2026-10-29T06:00:00.000Z"),
      reminder("flaky", "2026-10-30T06:00:00.000Z"),
    ];
    const sent: string[] = [];
    const failures: unknown[] = [];
    let flaky = true;
    const push = new ProductionReminderPush({
      ownerId: "owner" as never,
      agentId: "agent" as never,
      reminders: { listDue: async () => due },
      state: { readMany: async ({ memoryIds }) => memoryIds.map((id) => memory(id)) },
      readText: async (record) =>
        ({ "payload-report": "交季度报告", "payload-old": "旧的", "payload-flaky": "取快递" })[
          (record as { contentRef: string }).contentRef
        ],
      channel: {
        send: async ({ body }) => {
          if (body.startsWith("取快递") && flaky) {
            flaky = false;
            throw new Error("REMINDER_PUSH_HTTP_500");
          }
          sent.push(body);
        },
      },
      now: () => "2026-10-30T06:05:00.000Z",
      timeZone: "Asia/Shanghai",
      onFailure: (error) => failures.push(error),
    });
    await push.tick();
    expect(sent).toEqual(["交季度报告\n时间：10/30周五 15:00"]);
    expect(failures).toHaveLength(1);
    await push.tick();
    expect(sent).toEqual(["交季度报告\n时间：10/30周五 15:00", "取快递\n时间：10/30周五 15:00"]);
    due = [reminder("report", "2026-10-30T06:04:00.000Z")];
    await push.tick();
    expect(sent).toHaveLength(3);
    await push.tick();
    expect(sent).toHaveLength(3);
  });

  it("checks on start and stops cleanly", async () => {
    vi.useFakeTimers();
    const listDue = vi.fn(async () => []);
    const push = new ProductionReminderPush({
      ownerId: "owner" as never,
      agentId: "agent" as never,
      reminders: { listDue },
      state: { readMany: async () => [] },
      readText: async () => undefined,
      channel: { send: async () => {} },
      now: () => "2026-10-30T06:05:00.000Z",
      intervalMs: 1000,
      onFailure: () => {},
    });
    push.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(listDue).toHaveBeenCalledTimes(3);
    await push.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listDue).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
