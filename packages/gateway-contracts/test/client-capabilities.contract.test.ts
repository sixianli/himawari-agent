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
    expect(findClientCapability("v1", "run.cancel")?.tier).toBe("tighten");
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
    const rule = findClientCapability("v2", "memory.rule.respond");
    expect(rule && requiredClientTier(rule, {})).toBe("change");
  });
});
