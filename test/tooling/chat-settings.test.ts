import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHAT_SETTINGS_TABLE,
  type ChatSettingsRow,
  CLIENT_CAPABILITY_TABLE,
  chatSettingsCatalog,
  chatSettingsCommands,
  chatSettingTier,
  findChatSetting,
  findClientCapability,
  gatewayV2PayloadSchema,
} from "../../packages/gateway-contracts/src/index.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const APPLE_SOURCES = join(ROOT, "clients/apple/Sources");
const SETTINGS_PAGES = join(APPLE_SOURCES, "HimawariManage/Settings");

function registrationGaps(
  commands: readonly { readonly type: string }[],
  table: readonly ChatSettingsRow[],
): readonly string[] {
  const listed = table.map((row) => row.type);
  const known = new Set(commands.map((entry) => entry.type));
  const gaps: string[] = [];
  for (const { type } of commands)
    if (!listed.includes(type)) gaps.push(`CHAT_SETTING_UNREGISTERED ${type}`);
  for (const type of listed) {
    if (!known.has(type)) gaps.push(`CHAT_SETTING_NOT_A_PHONE_COMMAND ${type}`);
    if (listed.indexOf(type) !== listed.lastIndexOf(type))
      gaps.push(`CHAT_SETTING_DUPLICATE ${type}`);
  }
  for (const row of table) {
    if (row.kind === "not_setting" && row.reason.trim() === "")
      gaps.push(`CHAT_SETTING_REASON_MISSING ${row.type}`);
    if (row.kind !== "setting") continue;
    const read = findClientCapability("v2", row.read);
    if (!read || read.kind !== "query" || read.tier === "not_on_phone")
      gaps.push(`CHAT_SETTING_READ_INVALID ${row.type} ${row.read}`);
    else {
      try {
        gatewayV2PayloadSchema(row.read)?.parse(row.readPayload ?? {});
      } catch {
        gaps.push(`CHAT_SETTING_READ_PAYLOAD_INVALID ${row.type} ${row.read}`);
      }
    }
    if ([row.name.zh, row.name.en, row.name.ja].some((name) => name.trim() === ""))
      gaps.push(`CHAT_SETTING_NAME_MISSING ${row.type}`);
  }
  return [...new Set(gaps)].sort();
}

function swiftFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return swiftFiles(path);
    return name.endsWith(".swift") ? [path] : [];
  });
}

function swiftV2Commands(files: readonly string[]): readonly { file: string; type: string }[] {
  const pattern = /\.command\(\s*\.v2\s*,\s*"([a-zA-Z0-9_.]+)"/gu;
  return files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(pattern)].map((match) => ({
      file: relative(ROOT, file),
      type: match[1] as string,
    })),
  );
}

const DELETES_OR_SIGNS_OUT = [
  "sensitive.interceptions.clear",
  "device.revoke",
  "login.device.revoke",
  "login.devices.revoke_others",
];
const LOOSENS = [
  "search.authorization.set",
  "approval.allowance.days.set",
  "perception.settings.change",
  "mcp.connection.change",
  "device.rename",
];

function tierViolations(catalog: ReturnType<typeof chatSettingsCatalog>): readonly string[] {
  const tierOf = (type: string) => catalog.find((setting) => setting.row.type === type)?.row.tier;
  return [
    ...DELETES_OR_SIGNS_OUT.filter((type) => tierOf(type) !== 4).map(
      (type) => `CHAT_SETTING_DELETE_BELOW_4 ${type}`,
    ),
    ...LOOSENS.filter((type) => (tierOf(type) ?? 0) < 3).map(
      (type) => `CHAT_SETTING_LOOSEN_BELOW_3 ${type}`,
    ),
    ...catalog
      .filter((setting) => setting.row.tier >= 3)
      .flatMap((setting) =>
        (setting.row.payloadTiers ?? [])
          .filter((rule) => rule.tier < setting.row.tier && rule.tier !== 1)
          .map(() => `CHAT_SETTING_PAYLOAD_TIER_LOWERED ${setting.row.type}`),
      ),
  ];
}

describe("[ADR 0315] 聊天里改设置的设置目录", () => {
  it("命令表里每条手机能发的 v2 命令都登记了，要么是设置，要么写明不是设置的原因", () => {
    expect(registrationGaps(chatSettingsCommands(), CHAT_SETTINGS_TABLE)).toEqual([]);
  });

  it("反向：漏登记 quiet_hours.set、登记了命令表里没有的类型、读回查询写错，都会被拦下", () => {
    const missing = CHAT_SETTINGS_TABLE.filter((row) => row.type !== "quiet_hours.set");
    expect(registrationGaps(chatSettingsCommands(), missing)).toEqual([
      "CHAT_SETTING_UNREGISTERED quiet_hours.set",
    ]);
    const stray: ChatSettingsRow[] = [
      ...CHAT_SETTINGS_TABLE,
      { type: "thread.message.submit", kind: "not_setting", reason: "x" },
    ];
    expect(registrationGaps(chatSettingsCommands(), stray)).toEqual([
      "CHAT_SETTING_NOT_A_PHONE_COMMAND thread.message.submit",
    ]);
    const wrongRead = CHAT_SETTINGS_TABLE.map((row) =>
      row.type === "memory.settings.set" && row.kind === "setting"
        ? { ...row, read: "memory.settings.set" }
        : row,
    );
    expect(registrationGaps(chatSettingsCommands(), wrongRead)).toEqual([
      "CHAT_SETTING_READ_INVALID memory.settings.set memory.settings.set",
    ]);
    const noReadPayload = CHAT_SETTINGS_TABLE.map((row) =>
      row.type === "grant.revoke" && row.kind === "setting"
        ? { type: row.type, kind: row.kind, name: row.name, read: row.read, tier: row.tier }
        : row,
    );
    expect(registrationGaps(chatSettingsCommands(), noReadPayload)).toEqual([
      "CHAT_SETTING_READ_PAYLOAD_INVALID grant.revoke grant.list",
    ]);
  });

  it("新加一条手机命令却没登记，会被拦下", () => {
    const added = [...chatSettingsCommands(), { type: "memory.settings.extra" }];
    expect(registrationGaps(added, CHAT_SETTINGS_TABLE)).toEqual([
      "CHAT_SETTING_UNREGISTERED memory.settings.extra",
    ]);
  });

  it("iPhone、Mac 发的每条 v2 命令都在聊天表里；设置页发的必须登记成设置", () => {
    const calls = swiftV2Commands(swiftFiles(APPLE_SOURCES));
    expect(calls.length).toBeGreaterThan(0);
    const listed = new Map(CHAT_SETTINGS_TABLE.map((row) => [row.type, row]));
    const unknown = calls.filter(
      ({ type }) =>
        !listed.has(type) &&
        CLIENT_CAPABILITY_TABLE.some(
          (entry) => entry.gateway === "v2" && entry.type === type && entry.kind === "command",
        ),
    );
    expect(unknown).toEqual([]);
    const settingsCalls = swiftV2Commands(swiftFiles(SETTINGS_PAGES));
    expect(settingsCalls.map(({ type }) => type).sort()).toEqual(
      expect.arrayContaining(["owner.preferences.set", "quiet_hours.set"]),
    );
    expect(settingsCalls.filter(({ type }) => listed.get(type)?.kind !== "setting")).toEqual([]);
  });

  it("删除和退出登录都是第 4 档；放宽权限、碰外部的不低于第 3 档", () => {
    expect(tierViolations(chatSettingsCatalog())).toEqual([]);
    const clear = findChatSetting("proactive.source.manage");
    expect(clear && chatSettingTier(clear, { source: "gmail", action: "clear_records" })).toBe(4);
    const search = findChatSetting("search.authorization.set");
    const recipients: string[] = [];
    expect(
      search && chatSettingTier(search, { expectedRevision: 1, enabled: true, recipients }),
    ).toBe(3);
    expect(
      search && chatSettingTier(search, { expectedRevision: 1, enabled: false, recipients }),
    ).toBe(1);
  });

  it("反向：把删除登记成第 2 档、把放宽登记成第 1 档，门槛会报错", () => {
    const wrong = chatSettingsCatalog().map((setting) =>
      setting.row.type === "device.revoke"
        ? { ...setting, row: { ...setting.row, tier: 2 as const } }
        : setting.row.type === "search.authorization.set"
          ? { ...setting, row: { ...setting.row, tier: 1 as const } }
          : setting,
    );
    expect(tierViolations(wrong)).toEqual([
      "CHAT_SETTING_DELETE_BELOW_4 device.revoke",
      "CHAT_SETTING_LOOSEN_BELOW_3 search.authorization.set",
    ]);
  });

  it("档位按参数算：暂停记忆第 1 档、恢复记忆第 2 档；打开勿扰第 1 档、改时段或关掉第 2 档", () => {
    const memory = findChatSetting("memory.settings.set");
    expect(memory && chatSettingTier(memory, { capturePaused: true })).toBe(1);
    expect(memory && chatSettingTier(memory, { capturePaused: false })).toBe(2);
    const quiet = findChatSetting("quiet_hours.set");
    const hours = { expectedVersion: "v1", start: "23:00", end: "07:00" };
    expect(quiet && chatSettingTier(quiet, { ...hours, enabled: true })).toBe(1);
    expect(quiet && chatSettingTier(quiet, { ...hours, enabled: false })).toBe(2);
  });

  it("参数结构直接来自 contracts-v2，设置目录里没有保险箱", () => {
    const quiet = findChatSetting("quiet_hours.set");
    expect(quiet?.parameters).toMatchObject({
      type: "object",
      required: ["expectedVersion", "enabled", "start", "end"],
      properties: { enabled: { type: "boolean" } },
    });
    expect(gatewayV2PayloadSchema("no.such.type")).toBeUndefined();
    expect(chatSettingsCatalog().some((setting) => /vault/iu.test(setting.row.type))).toBe(false);
    expect(chatSettingsCatalog().map((setting) => setting.row.type)).toEqual(
      [...chatSettingsCatalog().map((setting) => setting.row.type)].sort(),
    );
  });
});
