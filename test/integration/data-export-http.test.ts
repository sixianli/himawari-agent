import path from "node:path";
import { crc32 } from "node:zlib";
import { parsePortable, verifyIntegrity } from "@himawari-agent/persistence-sqlite";
import Fastify from "fastify";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStoredZip,
  DATA_EXPORT_ARCHIVE_ROOT,
  DATA_EXPORT_PATH,
  registerDataExportRoute,
} from "../../apps/agent-service/src/production-data-export.ts";
import { openSide, SECRETS, type Side, seedEverything } from "./data-export-fixture.ts";

const open: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function service(side: Side, protector: Side["protector"] = side.protector) {
  side.database.pragma("wal_checkpoint(TRUNCATE)");
  const app = Fastify();
  registerDataExportRoute(app, {
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
    now: () => "2026-11-02T00:00:00.000Z",
  });
  open.push(app);
  return app;
}

const asOwner = { cookie: "himawari_session=owner-session" };

describe("[P1-6] 网页导出接口", () => {
  it("登录后下载 zip：清单校验通过，条目数与响应头一致，且不含任何机密明文", async () => {
    const side = await openSide("http-positive");
    await seedEverything(side);
    const app = await service(side);
    const response = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="himawari-export-2026-11-02.zip"',
    );
    const entries = unzipSync(new Uint8Array(response.rawPayload));
    const files = new Map<string, Uint8Array>();
    for (const [name, content] of Object.entries(entries)) {
      expect(name.startsWith(`${DATA_EXPORT_ARCHIVE_ROOT}/`)).toBe(true);
      files.set(name.slice(DATA_EXPORT_ARCHIVE_ROOT.length + 1), content);
    }
    const manifest = verifyIntegrity(files, side.migrationSequence);
    parsePortable(files, side.migrationSequence);
    expect(Number(response.headers["x-himawari-export-memories"])).toBe(manifest.counts.memories);
    expect(manifest.counts.memories).toBeGreaterThan(0);
    expect(manifest.withheld.memories).toBe(3);
    expect(manifest.withheld.texts).toBe(6);
    expect(Number(response.headers["x-himawari-export-withheld"])).toBe(6);
    expect(files.has("sealed/sealed.enc")).toBe(false);
    const everything = Buffer.concat([...files.values()].map((file) => Buffer.from(file))).toString(
      "utf8",
    );
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
  });

  it("反向：没有登录、换了主人、跨站来源都被拒，且不返回任何数据", async () => {
    const side = await openSide("http-negative");
    await seedEverything(side);
    const app = await service(side);
    const anonymous = await app.inject({ method: "GET", url: DATA_EXPORT_PATH });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.rawPayload.byteLength).toBe(0);
    const stranger = await app.inject({
      method: "GET",
      url: DATA_EXPORT_PATH,
      headers: { cookie: "himawari_session=other-session" },
    });
    expect(stranger.statusCode).toBe(401);
    const forged = await app.inject({
      method: "GET",
      url: DATA_EXPORT_PATH,
      headers: { ...asOwner, "sec-fetch-site": "cross-site" },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.rawPayload.byteLength).toBe(0);
  });

  it("同时只生成一份：第二个并发请求得到 429", async () => {
    const side = await openSide("http-concurrent");
    await seedEverything(side);
    const app = await service(side);
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner }),
      app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner }),
    ]);
    expect([first.statusCode, second.statusCode].toSorted()).toEqual([200, 429]);
  });

  it("生成失败（解密抛错）后标志复位，下一次请求照常成功", async () => {
    const side = await openSide("http-reset");
    await seedEverything(side);
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
    const app = await service(side, flaky);
    const failed = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(failed.statusCode).toBe(500);
    expect(failed.rawPayload.byteLength).toBe(0);
    const retried = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(retried.statusCode).toBe(200);
  });

  it("只读 HEAD 请求不会触发生成", async () => {
    const side = await openSide("http-head");
    await seedEverything(side);
    const app = await service(side);
    const response = await app.inject({ method: "HEAD", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(response.statusCode).toBe(404);
  });

  it("压缩包头：UTF-8 标志、CRC 和中央目录偏移与内容一致", () => {
    const content = new TextEncoder().encode("喜欢喝茶");
    const archive = createStoredZip(
      new Map([["memory/偏好.md", content]]),
      "2026-11-02T00:00:00.000Z",
    );
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true)).toBe(0x0800);
    expect(view.getUint32(14, true)).toBe(crc32(content));
    const endOffset = archive.byteLength - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    const directoryOffset = view.getUint32(endOffset + 16, true);
    expect(view.getUint32(directoryOffset, true)).toBe(0x02014b50);
    expect(view.getUint16(directoryOffset + 8, true)).toBe(0x0800);
    expect(view.getUint32(directoryOffset + 16, true)).toBe(crc32(content));
    expect(view.getUint32(directoryOffset + 42, true)).toBe(0);
  });

  it("压缩包写法：非 ASCII 文件名和内容都能被标准解压器还原", () => {
    const files = new Map([
      ["memory/偏好.md", new TextEncoder().encode("喜欢喝茶")],
      ["data/a.jsonl", new Uint8Array()],
    ]);
    const entries = unzipSync(createStoredZip(files, "2026-11-02T00:00:00.000Z"));
    expect(new TextDecoder().decode(entries[`${DATA_EXPORT_ARCHIVE_ROOT}/memory/偏好.md`])).toBe(
      "喜欢喝茶",
    );
    expect(entries[`${DATA_EXPORT_ARCHIVE_ROOT}/data/a.jsonl`]?.byteLength).toBe(0);
  });
});
