import path from "node:path";
import { crc32 } from "node:zlib";
import { parsePortable, verifyIntegrity } from "@himawari-agent/persistence-sqlite";
import Fastify from "fastify";
import { unzipSync } from "fflate";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { ApplicationPortError, PORT_ERROR_CODES } from "@himawari-agent/application";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStoredZip,
  DATA_EXPORT_ARCHIVE_ROOT,
  DATA_EXPORT_KEY_LIMIT,
  DATA_EXPORT_PATH,
  DataExportJobs,
  ProductionDataExportControl,
  registerDataExportRoute,
} from "../../apps/agent-service/src/production-data-export.ts";
import {
  openSide,
  SECRET_API_KEY,
  SECRETS,
  type Side,
  seedEverything,
  seedMemory,
} from "./data-export-fixture.ts";

function pausedAt(side: Side, ref: string) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let calls = 0;
  const protector = new Proxy(side.protector, {
    get(target, property, receiver) {
      if (property === "unprotect")
        return async (...arguments_: Parameters<Side["protector"]["unprotect"]>) => {
          calls += 1;
          if (arguments_[0].payload.ref === ref) {
            reached();
            await gate;
          }
          return target.unprotect(...arguments_);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  return { protector, arrived, release, calls: () => calls };
}

const open: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function service(
  side: Side,
  protector: Side["protector"] = side.protector,
  now: () => string = () => "2026-11-02T00:00:00.000Z",
) {
  return (await gateway(side, protector, now)).app;
}

async function gateway(
  side: Side,
  protector: Side["protector"] = side.protector,
  now: () => string = () => "2026-11-02T00:00:00.000Z",
) {
  side.database.pragma("wal_checkpoint(TRUNCATE)");
  const app = Fastify();
  const jobs = new DataExportJobs({
    ownerId: side.ownerId,
    agentId: side.agentId,
    databasePath: path.join(side.directory, "product.sqlite"),
    protector,
    now,
  });
  const control = new ProductionDataExportControl({
    configuration: { ownerId: side.ownerId, agentId: side.agentId },
    jobs,
    clock: { now },
  });
  const message = (
    kind: "command" | "query",
    type: string,
    payload: unknown,
    actorType = "owner",
    key = `key-${randomUUID()}`,
  ) =>
    gatewayV2MessageSchema.parse({
      schemaVersion: "gateway.v2",
      kind,
      type,
      messageId: `message-${type}`,
      correlationId: `correlation-${type}`,
      causationId: null,
      dataClassification: "private",
      risk: kind === "command" ? "high" : "low",
      authorizationRef: kind === "command" ? "authorization-export" : null,
      scope: { ownerId: side.ownerId, agentId: side.agentId },
      authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType, actorId: actorType === "owner" ? side.ownerId : "agent-service" },
      ...(kind === "command" ? { idempotencyKey: key } : {}),
      payload,
    });
  const cancel = (exportId: string) =>
    control.execute(message("command", "data.export.cancel", { exportId }) as never);
  const startWith = (key: string) =>
    control.execute(message("command", "data.export.start", {}, "owner", key) as never);
  const start = async (actorType = "owner") =>
    (await control.execute(message("command", "data.export.start", {}, actorType) as never))
      .resultRef;
  const status = async (exportId: string) => {
    const snapshot = await control.query(
      message("query", "data.export.status.read", { exportId }) as never,
    );
    const parsed = gatewayV2MessageSchema.parse(snapshot);
    if (parsed.type !== "data.export.status.snapshot") throw new Error("snapshot");
    return parsed.payload;
  };
  const settled = async (exportId: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const payload = await status(exportId);
      if (payload.state !== "running") return payload;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("export did not settle");
  };
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
    jobs,
  });
  open.push(app);
  return { app, jobs, start, startWith, cancel, status, settled };
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
    expect(manifest.withheld.texts).toBe(8);
    expect(manifest.withheld.rules).toBe(1);
    expect(Number(response.headers["x-himawari-export-withheld"])).toBe(8);
    expect(Number(response.headers["x-himawari-export-rules"])).toBe(4);
    expect(manifest.counts.enforcedRules).toBe(4);
    expect(files.has("RULES.md")).toBe(true);
    expect(files.has("sealed/sealed.enc")).toBe(false);
    const everything = Buffer.concat([...files.values()].map((file) => Buffer.from(file))).toString(
      "utf8",
    );
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
  });

  it("含机密的短文字（实体名等）换成占位符后，也计入响应头的处数", async () => {
    const side = await openSide("http-short");
    await seedEverything(side);
    side.database
      .prepare("INSERT INTO memory_entities (memory_id, name) VALUES ('m-plain', ?)")
      .run(`密钥 ${SECRET_API_KEY}`);
    const app = await service(side);
    const response = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(response.statusCode).toBe(200);
    expect(Number(response.headers["x-himawari-export-withheld"])).toBe(9);
    const text = Object.values(unzipSync(new Uint8Array(response.rawPayload)))
      .map((file) => Buffer.from(file).toString("utf8"))
      .join("\n");
    expect(text).not.toContain(SECRET_API_KEY);
    expect(text).toContain("[已扣留:");
  });

  it("反向：没有任何规则时，响应头的规则条数是 0，压缩包照常带 RULES.md", async () => {
    const side = await openSide("http-no-rules");
    await seedMemory(side, { id: "m-only", text: "喜欢喝茶" });
    const app = await service(side);
    const response = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-himawari-export-rules"]).toBe("0");
    const entries = unzipSync(new Uint8Array(response.rawPayload));
    expect(
      Buffer.from(entries[`${DATA_EXPORT_ARCHIVE_ROOT}/RULES.md`] ?? []).toString("utf8"),
    ).toContain("共 0 条存下来的规则");
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

  it("[iOS] 经网关开始导出、查进度、取结果：和网页直接下载用同一套生成逻辑", async () => {
    const side = await openSide("gateway-positive");
    await seedEverything(side);
    const { app, start, status, settled } = await gateway(side);
    const exportId = await start();
    expect(exportId).toMatch(/^data-export:[A-Za-z0-9_-]{22}$/u);
    const ready = await settled(exportId);
    expect(ready).toMatchObject({
      exportId,
      state: "ready",
      startedAt: "2026-11-02T00:00:00.000Z",
      finishedAt: "2026-11-02T00:00:00.000Z",
      failureCode: null,
    });
    if (!ready.result) throw new Error("result");
    expect(ready.result.fileName).toBe("himawari-export-2026-11-02.zip");
    expect(ready.result.expiresAt).toBe("2026-11-02T00:10:00.000Z");
    const prepared = await app.inject({
      method: "GET",
      url: ready.result.downloadPath,
      headers: asOwner,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.rawPayload.byteLength).toBe(ready.result.sizeBytes);
    expect(createHash("sha256").update(prepared.rawPayload).digest("hex")).toBe(
      ready.result.sha256,
    );
    const again = await app.inject({
      method: "GET",
      url: ready.result.downloadPath,
      headers: asOwner,
    });
    expect(again.statusCode).toBe(200);
    expect((await status(exportId)).state).toBe("ready");
    const direct = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(Buffer.compare(direct.rawPayload, prepared.rawPayload)).toBe(0);
    expect(ready.result.memories).toBe(Number(direct.headers["x-himawari-export-memories"]));
    expect(ready.result.rules).toBe(Number(direct.headers["x-himawari-export-rules"]));
    expect(ready.result.withheld).toBe(Number(direct.headers["x-himawari-export-withheld"]));
    expect((await status(exportId)).state).toBe("ready");
  });

  it("[iOS] 反向：不认识的编号是 expired 且没有结果；没登录、编号不对、编号不合格都拿不到文件", async () => {
    const side = await openSide("gateway-negative");
    await seedEverything(side);
    const { app, start, status, settled } = await gateway(side);
    const unknown = "data-export:AAAAAAAAAAAAAAAAAAAAAA";
    expect(await status(unknown)).toMatchObject({
      exportId: unknown,
      state: "expired",
      startedAt: null,
      result: null,
    });
    const exportId = await start();
    const ready = await settled(exportId);
    if (!ready.result) throw new Error("result");
    const anonymous = await app.inject({ method: "GET", url: ready.result.downloadPath });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.rawPayload.byteLength).toBe(0);
    const stranger = await app.inject({
      method: "GET",
      url: ready.result.downloadPath,
      headers: { cookie: "himawari_session=other-session" },
    });
    expect(stranger.statusCode).toBe(401);
    const missing = await app.inject({
      method: "GET",
      url: `${DATA_EXPORT_PATH}?exportId=${encodeURIComponent(unknown)}`,
      headers: asOwner,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.rawPayload.byteLength).toBe(0);
    const malformed = await app.inject({
      method: "GET",
      url: `${DATA_EXPORT_PATH}?exportId=not-an-id`,
      headers: asOwner,
    });
    expect(malformed.statusCode).toBe(400);
    await expect(start("system")).rejects.toThrow("DATA_EXPORT_OWNER_REQUIRED");
  });

  it("[iOS] 生成失败时进度是 failed 并带原因，取不到文件；再开始一次可以成功", async () => {
    const side = await openSide("gateway-failed");
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
    const { app, start, settled } = await gateway(side, flaky);
    const failedId = await start();
    const failed = await settled(failedId);
    expect(failed).toMatchObject({
      state: "failed",
      failureCode: "DATA_EXPORT_PAYLOAD_UNAVAILABLE",
      result: null,
    });
    const download = await app.inject({
      method: "GET",
      url: `${DATA_EXPORT_PATH}?exportId=${encodeURIComponent(failedId)}`,
      headers: asOwner,
    });
    expect(download.statusCode).toBe(404);
    const retryId = await start();
    expect(retryId).not.toBe(failedId);
    expect((await settled(retryId)).state).toBe("ready");
    expect((await settled(failedId)).state).toBe("expired");
  });

  it("[iOS] 生成中再点开始得到同一个编号，网页直接下载得到 429；过了保留时间结果作废", async () => {
    const side = await openSide("gateway-running");
    await seedEverything(side);
    let now = "2026-11-02T00:00:00.000Z";
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Proxy(side.protector, {
      get(target, property, receiver) {
        if (property === "unprotect")
          return async (...arguments_: Parameters<Side["protector"]["unprotect"]>) => {
            await gate;
            return target.unprotect(...arguments_);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const { app, start, status, settled } = await gateway(side, held, () => now);
    const first = await start();
    expect((await status(first)).state).toBe("running");
    expect(await start()).toBe(first);
    const busy = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(busy.statusCode).toBe(429);
    release();
    const ready = await settled(first);
    if (!ready.result) throw new Error("result");
    now = "2026-11-02T00:09:59.999Z";
    expect((await status(first)).state).toBe("ready");
    now = "2026-11-02T00:10:00.000Z";
    expect(await status(first)).toMatchObject({ state: "expired", result: null });
    const late = await app.inject({
      method: "GET",
      url: ready.result.downloadPath,
      headers: asOwner,
    });
    expect(late.statusCode).toBe(404);
  });

  it("[iOS] 同一个确认键重发开始，得到同一个编号且不作废已生成的结果；换一个键才重新生成", async () => {
    const side = await openSide("gateway-idempotent");
    await seedEverything(side);
    const { startWith, settled } = await gateway(side);
    const first = await startWith("export-key-1");
    expect(first.replayed).toBe(false);
    expect((await settled(first.resultRef)).state).toBe("ready");
    expect(await startWith("export-key-1")).toEqual({
      resultRef: first.resultRef,
      replayed: true,
    });
    expect((await settled(first.resultRef)).state).toBe("ready");
    const second = await startWith("export-key-2");
    expect(second.resultRef).not.toBe(first.resultRef);
    expect((await settled(second.resultRef)).state).toBe("ready");
    expect((await settled(first.resultRef)).state).toBe("expired");
  });

  it("[iOS] 生成中另一个确认键拿到同一个编号，之后用这个键重发仍是它；失败或过期后同一个键能重新生成", async () => {
    const side = await openSide("gateway-keys");
    await seedEverything(side);
    let now = "2026-11-02T00:00:00.000Z";
    let release = () => {};
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failures = 0;
    const held = new Proxy(side.protector, {
      get(target, property, receiver) {
        if (property === "unprotect")
          return async (...arguments_: Parameters<Side["protector"]["unprotect"]>) => {
            await gate;
            if (failures > 0) {
              failures -= 1;
              throw new Error("DATA_EXPORT_PAYLOAD_UNAVAILABLE");
            }
            return target.unprotect(...arguments_);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const { startWith, settled, status } = await gateway(side, held, () => now);
    const first = await startWith("key-a");
    expect(await startWith("key-b")).toEqual({ resultRef: first.resultRef, replayed: false });
    release();
    expect((await settled(first.resultRef)).state).toBe("ready");
    expect(await startWith("key-b")).toEqual({ resultRef: first.resultRef, replayed: true });
    now = "2026-11-02T00:10:00.000Z";
    expect((await status(first.resultRef)).state).toBe("expired");
    const afterExpiry = await startWith("key-a");
    expect(afterExpiry.replayed).toBe(false);
    expect(afterExpiry.resultRef).not.toBe(first.resultRef);
    expect((await settled(afterExpiry.resultRef)).state).toBe("ready");
    failures = 1;
    gate = Promise.resolve();
    const failing = await startWith("key-c");
    expect((await settled(failing.resultRef)).state).toBe("failed");
    const retried = await startWith("key-c");
    expect(retried.replayed).toBe(false);
    expect(retried.resultRef).not.toBe(failing.resultRef);
    expect((await settled(retried.resultRef)).state).toBe("ready");
  });

  it("[iOS] 网页直接下载正在生成时，经网关开始得到冲突；生成中确认键满了也得到冲突", async () => {
    const side = await openSide("gateway-conflict");
    await seedEverything(side);
    let release = () => {};
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Proxy(side.protector, {
      get(target, property, receiver) {
        if (property === "unprotect")
          return async (...arguments_: Parameters<Side["protector"]["unprotect"]>) => {
            await gate;
            return target.unprotect(...arguments_);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const { app, startWith, settled } = await gateway(side, held);
    const direct = app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const conflict = await startWith("key-a").catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ApplicationPortError);
    expect(conflict).toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
    release();
    expect((await direct).statusCode).toBe(200);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await startWith("key-0");
    for (let index = 1; index < DATA_EXPORT_KEY_LIMIT; index += 1)
      expect((await startWith(`key-${index}`)).resultRef).toBe(first.resultRef);
    const full = await startWith("key-full").catch((error: unknown) => error);
    expect(full).toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
    expect(await startWith("key-1")).toEqual({ resultRef: first.resultRef, replayed: true });
    release();
    expect((await settled(first.resultRef)).state).toBe("ready");
  });

  it("[iOS] 已生成的网关导出不被网页直接下载作废：网页每次重新生成最新的一份，失败也不影响它", async () => {
    const side = await openSide("gateway-direct-keeps");
    await seedEverything(side);
    let now = "2026-11-02T00:00:00.000Z";
    let failures = 0;
    const flaky = new Proxy(side.protector, {
      get(target, property, receiver) {
        if (property === "unprotect")
          return async (...arguments_: Parameters<Side["protector"]["unprotect"]>) => {
            if (failures > 0) {
              failures -= 1;
              throw new Error("DATA_EXPORT_PAYLOAD_UNAVAILABLE");
            }
            return target.unprotect(...arguments_);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const { app, startWith, settled, status } = await gateway(side, flaky, () => now);
    const first = await startWith("key-a");
    const ready = await settled(first.resultRef);
    if (!ready.result) throw new Error("result");
    failures = 1;
    const failed = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(failed.statusCode).toBe(500);
    expect(await status(first.resultRef)).toMatchObject({ state: "ready" });
    expect(await startWith("key-a")).toEqual({ resultRef: first.resultRef, replayed: true });
    await seedMemory(side, { id: "memory-after-export", text: "导出之后新记下的一条" });
    now = "2026-11-02T00:05:00.000Z";
    const fresh = await app.inject({ method: "GET", url: DATA_EXPORT_PATH, headers: asOwner });
    expect(fresh.statusCode).toBe(200);
    expect(Number(fresh.headers["x-himawari-export-memories"])).toBe(ready.result.memories + 1);
    expect(await status(first.resultRef)).toMatchObject({ state: "ready" });
  });

  it("[iOS] 生成中的进度是真实计数：已读出几段文字、一共几段，结束后不再给进度", async () => {
    const side = await openSide("gateway-progress");
    await seedEverything(side);
    const paused = pausedAt(side, "payload-m-plain");
    const { start, status, settled } = await gateway(side, paused.protector);
    const exportId = await start();
    await paused.arrived;
    const running = await status(exportId);
    expect(running.state).toBe("running");
    expect(running.result).toBeNull();
    if (!running.progress) throw new Error("progress");
    expect(running.progress.textsTotal).toBeGreaterThan(running.progress.textsRead);
    expect(running.progress.textsRead).toBe(paused.calls() - 1);
    paused.release();
    const ready = await settled(exportId);
    expect(ready.state).toBe("ready");
    expect(ready.progress).toBeNull();
  });

  it("[iOS] 取消正在生成的导出：状态变成 cancelled，不再解密，放开后也不会变回 ready；重发取消是 replayed，之后能重新开始", async () => {
    const side = await openSide("gateway-cancel");
    await seedEverything(side);
    const paused = pausedAt(side, "payload-m-plain");
    const { app, jobs, start, cancel, status, settled } = await gateway(side, paused.protector);
    const exportId = await start();
    await paused.arrived;
    expect(await cancel(exportId)).toEqual({ resultRef: exportId, replayed: false });
    const callsAtCancel = paused.calls();
    expect(await status(exportId)).toMatchObject({
      state: "cancelled",
      progress: null,
      result: null,
      finishedAt: "2026-11-02T00:00:00.000Z",
    });
    paused.release();
    for (let attempt = 0; attempt < 200 && jobs.busy; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(jobs.busy).toBe(false);
    expect(paused.calls()).toBe(callsAtCancel);
    expect((await status(exportId)).state).toBe("cancelled");
    expect(await cancel(exportId)).toEqual({ resultRef: exportId, replayed: true });
    const download = await app.inject({
      method: "GET",
      url: `${DATA_EXPORT_PATH}?exportId=${encodeURIComponent(exportId)}`,
      headers: asOwner,
    });
    expect(download.statusCode).toBe(404);
    const again = await start();
    expect(again).not.toBe(exportId);
    const ready = await settled(again);
    if (!ready.result) throw new Error("result");
    expect(await cancel(again)).toEqual({ resultRef: again, replayed: false });
    expect(await status(again)).toMatchObject({ state: "cancelled", result: null });
    const dropped = await app.inject({
      method: "GET",
      url: ready.result.downloadPath,
      headers: asOwner,
    });
    expect(dropped.statusCode).toBe(404);
  });

  it("[iOS] 反向：取消不认识的编号是 404，取消已失败的是冲突", async () => {
    const side = await openSide("gateway-cancel-negative");
    await seedEverything(side);
    const broken = new Proxy(side.protector, {
      get(target, property, receiver) {
        if (property === "unprotect")
          return async () => {
            throw new Error("DATA_EXPORT_PAYLOAD_UNAVAILABLE");
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const { start, cancel, settled } = await gateway(side, broken);
    await expect(cancel("data-export:AAAAAAAAAAAAAAAAAAAAAA")).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_FOUND,
    });
    const failed = await start();
    expect((await settled(failed)).state).toBe("failed");
    await expect(cancel(failed)).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
    expect((await settled(failed)).state).toBe("failed");
  });

  it("[iOS] 读完文字后才取消（例如正在打包），生成完的结果也不会把状态改回 ready", async () => {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const jobs = new DataExportJobs({
      ownerId: "owner" as never,
      agentId: "agent" as never,
      databasePath: "unused",
      protector: {} as never,
      now: () => "2026-11-02T00:00:00.000Z",
      build: async () => {
        await finished;
        return {
          archive: Buffer.from("zip"),
          fileName: "himawari-export-2026-11-02.zip",
          sha256: "0".repeat(64),
          memories: 1,
          rules: 0,
          withheld: 0,
        };
      },
    });
    const { exportId } = jobs.start("key-1");
    expect(jobs.cancel(exportId)).toEqual({ exportId, replayed: false });
    finish();
    for (let attempt = 0; attempt < 100 && jobs.busy; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(jobs.view(exportId)).toMatchObject({ state: "cancelled", built: null, progress: null });
  });
});
