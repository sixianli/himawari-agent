import path from "node:path";
import { verifyChatExport } from "@himawari-agent/persistence-sqlite";
import Fastify from "fastify";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_EXPORT_ARCHIVE_ROOT,
  CHAT_EXPORT_PATH,
  registerChatExportRoute,
} from "../../apps/agent-service/src/production-chat-export.ts";
import { seedThread } from "./chat-export-fixture.ts";
import { openSide, SECRET_BANK_CARD, SECRETS, type Side } from "./data-export-fixture.ts";

const open: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function service(side: Side, protector: Side["protector"] = side.protector) {
  side.database.pragma("wal_checkpoint(TRUNCATE)");
  const app = Fastify();
  registerChatExportRoute(app, {
    authentication: {
      authenticate: async (input) => {
        if (input.sessionToken === "owner-session")
          return {
            subjectId: "subject",
            ownerId: side.ownerId,
            deviceId: "device",
            authenticatedAt: "2026-11-01T00:00:00.000Z",
            authenticationRef: "ref",
          };
        if (input.sessionToken === "other-session")
          return {
            subjectId: "subject",
            ownerId: "someone-else",
            deviceId: "device",
            authenticatedAt: "2026-11-01T00:00:00.000Z",
            authenticationRef: "ref",
          };
        throw new Error("UNAUTHENTICATED");
      },
    },
    sessionCookieName: "himawari_session",
    ownerId: side.ownerId,
    agentId: side.agentId,
    databasePath: path.join(side.directory, "product.sqlite"),
    protector,
    now: () => "2026-11-12T00:00:00.000Z",
  });
  open.push(app);
  return app;
}

const asOwner = { cookie: "himawari_session=owner-session" };

async function seeded(name: string) {
  const side = await openSide(name);
  await seedThread(side, "t-1", {
    title: "咖啡",
    messages: [{ text: "早上好" }, { text: `银行卡 ${SECRET_BANK_CARD}` }, { text: "收到" }],
  });
  await seedThread(side, "t-2", { title: "第二个", messages: [{ text: "你好" }] });
  return side;
}

describe("chat export route", () => {
  it("[多人7] returns a zip whose manifest matches the headers and holds no secret", async () => {
    const side = await seeded("chat-http-positive");
    const app = await service(side);
    const response = await app.inject({ method: "GET", url: CHAT_EXPORT_PATH, headers: asOwner });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="himawari-chats-2026-11-12.zip"',
    );
    const files = new Map<string, Uint8Array>();
    for (const [name, content] of Object.entries(unzipSync(new Uint8Array(response.rawPayload)))) {
      expect(name.startsWith(`${CHAT_EXPORT_ARCHIVE_ROOT}/`)).toBe(true);
      files.set(name.slice(CHAT_EXPORT_ARCHIVE_ROOT.length + 1), content);
    }
    const manifest = verifyChatExport(files, side.migrationSequence);
    expect(Number(response.headers["x-himawari-export-threads"])).toBe(manifest.counts.threads);
    expect(Number(response.headers["x-himawari-export-messages"])).toBe(manifest.counts.messages);
    expect(Number(response.headers["x-himawari-export-withheld"])).toBe(manifest.withheld.messages);
    expect(manifest.counts).toMatchObject({ threads: 2, messages: 4 });
    expect(manifest.withheld.messages).toBe(1);
    expect(files.has("sealed/sealed.enc")).toBe(false);
    const everything = Buffer.concat([...files.values()].map((file) => Buffer.from(file))).toString(
      "utf8",
    );
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
  });

  it("[多人7] an empty database returns a valid zip with zero counts (negative case)", async () => {
    const side = await openSide("chat-http-empty");
    const app = await service(side);
    const response = await app.inject({ method: "GET", url: CHAT_EXPORT_PATH, headers: asOwner });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-himawari-export-threads"]).toBe("0");
    expect(response.headers["x-himawari-export-messages"]).toBe("0");
    expect(response.headers["x-himawari-export-withheld"]).toBe("0");
  });

  it("[多人7] anonymous, another owner and cross-site requests are refused with no data", async () => {
    const side = await seeded("chat-http-negative");
    const app = await service(side);
    const anonymous = await app.inject({ method: "GET", url: CHAT_EXPORT_PATH });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.rawPayload.byteLength).toBe(0);
    const stranger = await app.inject({
      method: "GET",
      url: CHAT_EXPORT_PATH,
      headers: { cookie: "himawari_session=other-session" },
    });
    expect(stranger.statusCode).toBe(401);
    const forged = await app.inject({
      method: "GET",
      url: CHAT_EXPORT_PATH,
      headers: { ...asOwner, "sec-fetch-site": "cross-site" },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.rawPayload.byteLength).toBe(0);
  });

  it("[多人7] only one export runs at a time, and a failure resets the flag", async () => {
    const side = await seeded("chat-http-concurrent");
    const app = await service(side);
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: CHAT_EXPORT_PATH, headers: asOwner }),
      app.inject({ method: "GET", url: CHAT_EXPORT_PATH, headers: asOwner }),
    ]);
    expect([first.statusCode, second.statusCode].toSorted()).toEqual([200, 429]);
    let failures = 1;
    const flaky = new Proxy(side.protector, {
      get(target, property, receiver) {
        if (property === "unprotect")
          return async (...arguments_: Parameters<Side["protector"]["unprotect"]>) => {
            if (failures-- > 0) throw new Error("DATA_EXPORT_PAYLOAD_UNAVAILABLE");
            return target.unprotect(...arguments_);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const flakyApp = await service(side, flaky);
    expect(
      (await flakyApp.inject({ method: "GET", url: CHAT_EXPORT_PATH, headers: asOwner }))
        .statusCode,
    ).toBe(500);
    expect(
      (await flakyApp.inject({ method: "GET", url: CHAT_EXPORT_PATH, headers: asOwner }))
        .statusCode,
    ).toBe(200);
  });
});
