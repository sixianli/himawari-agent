import {
  CLIENT_CAPABILITY_TABLE,
  type ClientCapabilityEntry,
  requiredClientTier,
} from "./client-capabilities.js";
import { gatewayV2PayloadSchema } from "./contracts-v2.js";
import { describeSchema, type SchemaDescription } from "./validation.js";

export const CHAT_SETTING_TIERS = [1, 2, 3, 4] as const;
export type ChatSettingTier = (typeof CHAT_SETTING_TIERS)[number];

export interface ChatSettingName {
  readonly zh: string;
  readonly en: string;
  readonly ja: string;
}

export interface ChatPayloadTier {
  readonly when: Readonly<Record<string, string | boolean>>;
  readonly tier: ChatSettingTier;
}

export interface ChatSettingRow {
  readonly type: string;
  readonly kind: "setting";
  readonly name: ChatSettingName;
  readonly read: string;
  readonly tier: ChatSettingTier;
  readonly payloadTiers?: readonly ChatPayloadTier[];
  readonly readPayload?: Readonly<Record<string, unknown>>;
}

export interface ChatNotSettingRow {
  readonly type: string;
  readonly kind: "not_setting";
  readonly reason: string;
}

export type ChatSettingsRow = ChatSettingRow | ChatNotSettingRow;

function setting(
  type: string,
  read: string | { readonly type: string; readonly payload: Readonly<Record<string, unknown>> },
  tier: ChatSettingTier,
  name: ChatSettingName,
  payloadTiers?: readonly ChatPayloadTier[],
): ChatSettingRow {
  return {
    type,
    kind: "setting",
    name,
    read: typeof read === "string" ? read : read.type,
    tier,
    ...(payloadTiers ? { payloadTiers } : {}),
    ...(typeof read === "string" ? {} : { readPayload: read.payload }),
  };
}

function notSetting(type: string, reason: string): ChatNotSettingRow {
  return { type, kind: "not_setting", reason };
}

const ANSWERS_A_CARD = "回答一张具体的确认卡或请求，不是设置；在聊天里用卡片本身回答";
const ACTS_ON_ONE_ITEM =
  "对一条具体的提醒、记忆、建议或评分做一次操作，不是设置；聊天里已有专门的工具";
const MEMORY_CONTENT = "改的是记忆内容，不是设置；记忆走记忆工具";
const OPERATIONS = "装、停、回滚能力是运维操作，只在设置页做";
const EXPORT_FILE = "导出的文件要在设置页下载，读回要带导出编号；聊天里先不做";
const PAGE_SIGNAL = "设置页自己发的“看过了”信号，不是设置";

export const CHAT_SETTINGS_TABLE: readonly ChatSettingsRow[] = Object.freeze([
  notSetting("approval.respond", ANSWERS_A_CARD),
  notSetting("approval.allowance.set", ANSWERS_A_CARD),
  setting("approval.allowance.days.set", "memory.rules.read", 3, {
    zh: "“几天内都行”默认几天",
    en: "Default days for “allow for a few days”",
    ja: "「数日間許可」の既定日数",
  }),
  setting("approval.allowance.revoke", "memory.rules.read", 1, {
    zh: "撤销一项“以后都行”的预授权",
    en: "Revoke a standing allowance",
    ja: "常時許可を取り消す",
  }),
  setting(
    "search.authorization.set",
    "search.authorization.read",
    3,
    { zh: "联网搜索授权", en: "Web search permission", ja: "ウェブ検索の許可" },
    [{ when: { enabled: false }, tier: 1 }],
  ),
  setting("push.kind.set", "push.status.read", 2, {
    zh: "某一类通知开关",
    en: "Notification kind on or off",
    ja: "通知の種類のオンオフ",
  }),
  setting("proactive.settings.set", "proactive.overview.read", 2, {
    zh: "主动提醒总设置",
    en: "Proactive reminder settings",
    ja: "先回り通知の設定",
  }),
  setting("proactive.pause", "proactive.overview.read", 1, {
    zh: "暂停主动提醒",
    en: "Pause proactive reminders",
    ja: "先回り通知を一時停止",
  }),
  notSetting("proactive.insight.respond", ACTS_ON_ONE_ITEM),
  notSetting("proactive.decision.rate", ACTS_ON_ONE_ITEM),
  notSetting("proactive.audit.respond", ACTS_ON_ONE_ITEM),
  notSetting("proactive.review.rate", ACTS_ON_ONE_ITEM),
  notSetting("proactive.review.checkup", ACTS_ON_ONE_ITEM),
  setting(
    "proactive.source.manage",
    "proactive.sources.read",
    3,
    {
      zh: "断开提醒来源或清空它的记录",
      en: "Disconnect a reminder source or clear its records",
      ja: "通知元の切断・記録の消去",
    },
    [{ when: { action: "clear_records" }, tier: 4 }],
  ),
  setting("proactive.source.settings.set", "proactive.sources.read", 2, {
    zh: "提醒来源的开关和每天条数",
    en: "Reminder source switch and daily limits",
    ja: "通知元のオンオフと1日の件数",
  }),
  setting("proactive.source.switch_off", "proactive.sources.read", 1, {
    zh: "关掉一个提醒来源",
    en: "Switch off a reminder source",
    ja: "通知元をオフにする",
  }),
  notSetting("proactive.observation.start", "开始一段观察期要在设置页本人确认，不是开关"),
  setting("owner.preferences.set", "owner.preferences.read", 2, {
    zh: "称呼、回答语言、主题、模型和思考强度",
    en: "Name, answer language, theme, model and thinking level",
    ja: "呼び名・回答言語・テーマ・モデル・思考の深さ",
  }),
  setting(
    "quiet_hours.set",
    "quiet_hours.read",
    2,
    { zh: "勿扰时段", en: "Quiet hours", ja: "おやすみ時間帯" },
    [{ when: { enabled: true }, tier: 1 }],
  ),
  setting("perception.settings.change", "perception.status.read", 3, {
    zh: "感知设置（位置、听等）",
    en: "Perception settings (location, listening)",
    ja: "感知の設定（位置・聞き取りなど）",
  }),
  notSetting(
    "perception.records.delete",
    "删除要先在设置页生成删除计划、核对条数，命令只带计划编号；聊天里先不做",
  ),
  setting("think.settings.change", "think.settings.read", 2, {
    zh: "想一想的设置",
    en: "Thinking-time settings",
    ja: "考える時間の設定",
  }),
  setting("timers.change", "timers.read", 2, {
    zh: "暂停、恢复或取消一个定时任务",
    en: "Pause, resume or cancel a timer",
    ja: "タイマーの一時停止・再開・取消",
  }),
  setting(
    "sensitive.interceptions.clear",
    { type: "sensitive.interceptions.read", payload: { before: null } },
    4,
    {
      zh: "清除拦截记录",
      en: "Clear interception records",
      ja: "遮断記録を消去",
    },
  ),
  notSetting("decision.spoken.rate", ACTS_ON_ONE_ITEM),
  notSetting("memory.approval.respond", ANSWERS_A_CARD),
  notSetting("memory.tidy.undo", MEMORY_CONTENT),
  notSetting("memory.reminder.respond", ACTS_ON_ONE_ITEM),
  notSetting("memory.reminder.create", "建提醒走提醒工具 reminder_set"),
  notSetting("memory.rule.respond", ACTS_ON_ONE_ITEM),
  notSetting("memory.create", MEMORY_CONTENT),
  notSetting("memory.category.set", MEMORY_CONTENT),
  setting("memory.settings.set", "memory.overview.read", 2, {
    zh: "暂停或恢复记忆",
    en: "Pause or resume memory",
    ja: "記憶の一時停止・再開",
  }),
  notSetting("memory.page.viewed", PAGE_SIGNAL),
  notSetting("memory.person.respond", ACTS_ON_ONE_ITEM),
  notSetting("memory.external.respond", ANSWERS_A_CARD),
  notSetting("memory.external.undo", MEMORY_CONTENT),
  notSetting("memory.mcpSync.projectDecide", ANSWERS_A_CARD),
  notSetting("memory.mcpSync.noteDecide", ANSWERS_A_CARD),
  notSetting("memory.mcpSync.attentionResolve", ANSWERS_A_CARD),
  notSetting("memory.conversationReview.undo", MEMORY_CONTENT),
  notSetting("memory.review.respond", ACTS_ON_ONE_ITEM),
  notSetting("memory.review.reportMissed", ACTS_ON_ONE_ITEM),
  setting("device.rename", "device.list.read", 3, {
    zh: "给设备改名",
    en: "Rename a device",
    ja: "デバイス名の変更",
  }),
  setting("device.revoke", "device.list.read", 4, {
    zh: "移除一台设备",
    en: "Remove a device",
    ja: "デバイスを削除",
  }),
  setting("login.device.revoke", "login.devices.read", 4, {
    zh: "退出一台登录设备",
    en: "Sign out one device",
    ja: "ログイン中の端末をサインアウト",
  }),
  setting("login.devices.revoke_others", "login.devices.read", 4, {
    zh: "退出其他所有设备",
    en: "Sign out all other devices",
    ja: "他のすべての端末をサインアウト",
  }),
  setting("mcp.connection.change", "mcp.connections.read", 3, {
    zh: "改一个外部连接",
    en: "Change an external connection",
    ja: "外部接続を変更",
  }),
  notSetting("mcp.grant.approve", ANSWERS_A_CARD),
  notSetting("mcp.grant.deny", ANSWERS_A_CARD),
  notSetting("data.export.start", EXPORT_FILE),
  notSetting("data.export.cancel", EXPORT_FILE),
  notSetting("memory.import.commit", MEMORY_CONTENT),
  notSetting("memory.import.undo", MEMORY_CONTENT),
  notSetting("memory.mutate", MEMORY_CONTENT),
  setting(
    "grant.revoke",
    { type: "grant.list", payload: { includeRevoked: false, afterCursor: null, limit: 100 } },
    1,
    {
      zh: "收回一项授权",
      en: "Revoke a grant",
      ja: "許可を取り消す",
    },
  ),
  notSetting("capability.review", OPERATIONS),
  notSetting("capability.install.approve", OPERATIONS),
  notSetting("capability.update.respond", OPERATIONS),
  notSetting("capability.disable", OPERATIONS),
  notSetting("capability.reactivate", OPERATIONS),
  notSetting("capability.rollback", OPERATIONS),
  notSetting("suggestion.respond", ANSWERS_A_CARD),
  setting(
    "reflection.configure",
    { type: "reflection.detail", payload: { includeCheckpoints: false } },
    2,
    {
      zh: "自我反思的设置",
      en: "Reflection settings",
      ja: "振り返りの設定",
    },
  ),
  notSetting("improvement.review", ANSWERS_A_CARD),
]);

export function chatSettingsCommands(): readonly ClientCapabilityEntry[] {
  return CLIENT_CAPABILITY_TABLE.filter(
    (entry) => entry.gateway === "v2" && entry.kind === "command" && entry.tier !== "not_on_phone",
  );
}

export interface ChatSetting {
  readonly row: ChatSettingRow;
  readonly entry: ClientCapabilityEntry;
  readonly parameters: SchemaDescription;
}

export const CHAT_SETTINGS_FORBIDDEN = /vault/iu;

export function chatSettingsCatalog(): readonly ChatSetting[] {
  const commands = new Map(chatSettingsCommands().map((entry) => [entry.type, entry]));
  return CHAT_SETTINGS_TABLE.filter((row): row is ChatSettingRow => row.kind === "setting")
    .filter((row) => commands.has(row.type) && !CHAT_SETTINGS_FORBIDDEN.test(row.type))
    .map((row) => {
      const schema = gatewayV2PayloadSchema(row.type);
      return {
        row,
        entry: commands.get(row.type) as ClientCapabilityEntry,
        parameters: schema ? describeSchema(schema) : {},
      };
    })
    .sort((left, right) => (left.row.type < right.row.type ? -1 : 1));
}

export function findChatSetting(type: string): ChatSetting | undefined {
  return chatSettingsCatalog().find((setting) => setting.row.type === type);
}

function matches(payload: unknown, when: Readonly<Record<string, string | boolean>>): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const fields = payload as Record<string, unknown>;
  return Object.entries(when).every(([key, value]) => fields[key] === value);
}

export function chatSettingTier(setting: ChatSetting, payload: unknown): ChatSettingTier {
  const raised = (setting.row.payloadTiers ?? [])
    .filter((rule) => matches(payload, rule.when))
    .map((rule) => rule.tier);
  if (raised.length > 0) return Math.max(...raised) as ChatSettingTier;
  if (requiredClientTier(setting.entry, payload) === "tighten") return 1;
  return setting.row.tier;
}
