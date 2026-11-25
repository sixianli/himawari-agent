import { describe, expect, it } from "vitest";
import {
  CLIENT_CAPABILITY_TABLE,
  CLIENT_PAGE_TABLE,
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
      if (entry.tightenPayload || entry.tightenEveryItem) {
        expect(entry.kind).toBe("command");
        expect(entry.tier).toBe("change");
      }
      if (entry.tightenPayload && entry.tightenEveryItem) expect.fail(entry.type);
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
    expect(push && requiredClientTier(push, { enabled: false })).toBe("change");
    expect(push && requiredClientTier(push, { kind: "run", enabled: "false" })).toBe("change");
    expect(push && requiredClientTier(push, { kind: "run", enabled: null })).toBe("change");
    expect(push && requiredClientTier(push, { kind: "run", enabled: false, extra: false })).toBe(
      "change",
    );
    expect(memory?.tightenOpenKeys).toBeUndefined();
    const rule = findClientCapability("v2", "memory.rule.respond");
    expect(rule && requiredClientTier(rule, {})).toBe("change");
    const takeBack = findClientCapability("v2", "approval.allowance.revoke");
    expect(takeBack && requiredClientTier(takeBack, { allowanceId: "allowance:a" })).toBe(
      "tighten",
    );
    const give = findClientCapability("v2", "approval.allowance.set");
    expect(give && requiredClientTier(give, {})).toBe("change");
  });

  it("外部记忆整批全是拒绝且不带改写文字才算收紧，有一条留下或改写就算改", () => {
    const external = findClientCapability("v2", "memory.external.respond");
    const reject = (proposalId: string) => ({ proposalId, decision: "reject", editedText: null });
    const tier = (payload: unknown) => external && requiredClientTier(external, payload);
    expect(tier({ items: [reject("a")] })).toBe("tighten");
    expect(tier({ items: [reject("a"), reject("b")] })).toBe("tighten");
    expect(
      tier({ items: [reject("a"), { proposalId: "b", decision: "keep", editedText: null }] }),
    ).toBe("change");
    expect(tier({ items: [{ proposalId: "a", decision: "keep", editedText: "改过" }] })).toBe(
      "change",
    );
    expect(tier({ items: [{ proposalId: "a", decision: "reject", editedText: "改过" }] })).toBe(
      "change",
    );
    expect(tier({ items: [{ proposalId: "a", decision: "reject" }] })).toBe("change");
    expect(
      tier({ items: [{ proposalId: "a", decision: "reject", editedText: null, extra: 1 }] }),
    ).toBe("change");
    expect(tier({ items: [] })).toBe("change");
    expect(tier({ items: reject("a") })).toBe("change");
    expect(tier({ items: [reject("a")], extra: true })).toBe("change");
    expect(tier({})).toBe("change");
    expect(tier(null)).toBe("change");
  });

  it("设备管理、导出和登录设备的登记档位", () => {
    const tiers = (type: string) => findClientCapability("v2", type)?.tier;
    for (const type of [
      "device.list.read",
      "server.status.read",
      "login.devices.read",
      "files.list.read",
      "data.export.status.read",
      "home.read",
    ])
      expect(tiers(type), type).toBe("read");
    for (const type of [
      "device.pairing.start",
      "device.pairing.confirm",
      "device.rename",
      "device.revoke",
      "login.device.revoke",
      "login.devices.revoke_others",
      "data.export.start",
    ])
      expect(tiers(type), type).toBe("change");
    expect(tiers("data.export.cancel")).toBe("routine");
    expect(tiers("timers.change")).toBe("routine");
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

  it("一个主对话以后：审批和建议进主对话，能力和改进这一版手机上不做", () => {
    const page = (webPage: string) => CLIENT_PAGE_TABLE.find((entry) => entry.webPage === webPage);
    for (const webPage of ["approvals", "suggestions"]) {
      const entry = page(webPage);
      expect(entry && "nativePage" in entry ? entry.nativePage : undefined, webPage).toBe("chat");
    }
    for (const webPage of ["capabilities-adapters", "improvements"]) {
      const entry = page(webPage);
      expect(entry && "notOnPhone" in entry ? entry.notOnPhone : undefined, webPage).toContain(
        "这一版手机上不做",
      );
    }
    const pages = CLIENT_PAGE_TABLE.flatMap((entry) =>
      "nativePage" in entry ? [entry.nativePage] : [],
    );
    expect(pages.filter((name) => name.startsWith("today."))).toEqual([]);
  });

  it("运维类页面留在网页：三页和它们的消息类型手机上不做，点头和服务器状态不受影响", () => {
    for (const webPage of ["host-workspaces", "workers", "health-deployment"]) {
      const page = CLIENT_PAGE_TABLE.find((entry) => entry.webPage === webPage);
      expect(page && "notOnPhone" in page ? page.notOnPhone : undefined, webPage).toContain(
        "多端分工",
      );
    }
    const operations = CLIENT_CAPABILITY_TABLE.filter(
      (entry) =>
        entry.gateway === "v2" &&
        (entry.type.startsWith("workspace.") ||
          entry.type.startsWith("host.") ||
          entry.type.startsWith("delegation.")),
    );
    expect(operations.length).toBeGreaterThanOrEqual(12);
    for (const entry of operations) {
      expect(entry.tier, entry.type).toBe("not_on_phone");
      expect(entry.reason, entry.type).toContain("多端分工");
    }
    expect(findClientCapability("v2", "approval.respond")?.tier).toBe("change");
    expect(findClientCapability("v2", "capability.list")?.tier).toBe("read");
  });
});
