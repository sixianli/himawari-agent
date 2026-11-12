import { describe, expect, it } from "vitest";
import {
  CLIENT_CAPABILITY_TABLE,
  CLIENT_GATEWAY_MESSAGE_TYPES,
  CLIENT_GATEWAY_SCHEMAS,
  CLIENT_GATEWAYS,
  CLIENT_RESPONSE_ONLY_TYPES,
  ContractValidationError,
  findClientCapability,
  requiredClientTier,
} from "../src/index.ts";

function kindErrorPath(gateway: (typeof CLIENT_GATEWAYS)[number], type: string, kind: string) {
  const { schemaVersion, schema } = CLIENT_GATEWAY_SCHEMAS[gateway];
  try {
    schema.parse({ schemaVersion, kind, type });
  } catch (error) {
    if (error instanceof ContractValidationError) return error.path;
    throw error;
  }
  return null;
}

describe("[第11批] 客户端能力表", () => {
  for (const gateway of CLIENT_GATEWAYS) {
    it(`${gateway} 的每种请求类型都登记了一次，回应类型都不登记`, () => {
      const registered = CLIENT_CAPABILITY_TABLE.filter((entry) => entry.gateway === gateway).map(
        (entry) => entry.type,
      );
      expect(new Set(registered).size).toBe(registered.length);
      const responses = CLIENT_RESPONSE_ONLY_TYPES[gateway];
      expect(registered.filter((type) => responses.includes(type))).toEqual([]);
      expect([...registered, ...responses].sort()).toEqual(
        [...CLIENT_GATEWAY_MESSAGE_TYPES[gateway]].sort(),
      );
    });
  }

  it("登记的 kind 和网关契约里的一致", () => {
    for (const entry of CLIENT_CAPABILITY_TABLE) {
      expect(kindErrorPath(entry.gateway, entry.type, entry.kind), entry.type).not.toBe("$.kind");
      const other = entry.kind === "query" ? "command" : "query";
      expect(kindErrorPath(entry.gateway, entry.type, other), entry.type).toBe("$.kind");
    }
  });

  it("手机上不做的写了原因，能收紧的只在要面容的命令上", () => {
    for (const entry of CLIENT_CAPABILITY_TABLE) {
      if (entry.tier === "not_on_phone") expect(entry.reason?.length ?? 0).toBeGreaterThan(0);
      else expect(entry.reason).toBeUndefined();
      if (entry.tightenPayload) {
        expect(entry.kind).toBe("command");
        expect(entry.tier).toBe("change");
      }
    }
  });

  it("对话里能撤回的日常操作只用设备密钥，让它停下算收紧，永久删除仍要面容", () => {
    expect(findClientCapability("thread-v3", "thread.pin")?.tier).toBe("routine");
    expect(findClientCapability("thread-v3", "thread.trash")?.tier).toBe("routine");
    expect(findClientCapability("thread-v3", "thread.run.cancel")?.tier).toBe("tighten");
    expect(findClientCapability("thread-v3", "thread.message.submit")?.tier).toBe("not_on_phone");
    expect(findClientCapability("thread-v3", "thread.delete_permanently")?.tier).toBe("change");
  });

  it("只有让 Himawari 收集得更少的那个值算收紧，往回打开要面容", () => {
    const memory = findClientCapability("v2", "memory.settings.set");
    const muse = findClientCapability("v2", "muse.intake.set");
    expect(memory && requiredClientTier(memory, { capturePaused: true })).toBe("tighten");
    expect(memory && requiredClientTier(memory, { capturePaused: false })).toBe("change");
    expect(memory && requiredClientTier(memory, { capturePaused: "true" })).toBe("change");
    expect(memory && requiredClientTier(memory, { capturePaused: true, extra: true })).toBe(
      "change",
    );
    expect(muse && requiredClientTier(muse, { paused: true })).toBe("tighten");
    expect(muse && requiredClientTier(muse, { paused: false })).toBe("change");
    const push = findClientCapability("v2", "push.kind.set");
    expect(push && requiredClientTier(push, { kind: "reminder", enabled: false })).toBe("tighten");
    expect(push && requiredClientTier(push, { kind: "run", enabled: true })).toBe("change");
    expect(push && requiredClientTier(push, { kind: "run" })).toBe("change");
    expect(push && requiredClientTier(push, { kind: "run", enabled: "false" })).toBe("change");
    expect(push && requiredClientTier(push, { kind: "run", enabled: null })).toBe("change");
    expect(push && requiredClientTier(push, { kind: "run", enabled: false, extra: false })).toBe(
      "change",
    );
    expect(memory?.tightenOpenKeys).toBeUndefined();
    const rule = findClientCapability("v2", "memory.rule.respond");
    expect(rule && requiredClientTier(rule, {})).toBe("change");
  });

  it("正文还带别的设置的开关整个算改，暂停提醒用只有方向的单独类型", () => {
    const settings = findClientCapability("v2", "proactive.settings.set");
    expect(settings?.tier).toBe("change");
    expect(settings?.tightenPayload).toBeUndefined();
    expect(
      settings &&
        requiredClientTier(settings, { enabled: false, quietHours: [], importantSenders: [] }),
    ).toBe("change");
    expect(findClientCapability("v2", "proactive.pause")?.tier).toBe("tighten");
    const { schemaVersion, schema } = CLIENT_GATEWAY_SCHEMAS.v2;
    expect(() =>
      schema.parse({
        schemaVersion,
        kind: "command",
        type: "proactive.pause",
        payload: { enabled: true },
      }),
    ).toThrow(ContractValidationError);
  });

  it("记忆没有日常动作：memory.mutate 的每种动作都要面容", () => {
    const mutate = findClientCapability("v2", "memory.mutate");
    for (const action of [
      "correct",
      "archive",
      "delete",
      "restore",
      "confirm",
      "recover",
      "pin",
      "unpin",
      "restore_version",
    ])
      expect(mutate && requiredClientTier(mutate, { action }), action).toBe("change");
  });

  it("“读”只给查询；会写状态的命令至少是“日常”", () => {
    for (const entry of CLIENT_CAPABILITY_TABLE)
      if (entry.tier === "read") expect(entry.kind, entry.type).toBe("query");
    expect(findClientCapability("v2", "memory.page.viewed")?.tier).toBe("routine");
  });

  it("生产没有装的 v1 网关整套手机上不做", () => {
    for (const entry of CLIENT_CAPABILITY_TABLE.filter((item) => item.gateway === "v1"))
      expect(entry.tier, entry.type).toBe("not_on_phone");
  });

  it("任务页的 GitHub 监控开关手机上不做", () => {
    expect(findClientCapability("v2", "github.monitor.set_state")?.tier).toBe("not_on_phone");
  });
});
