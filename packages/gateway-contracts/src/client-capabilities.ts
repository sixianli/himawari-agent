import {
  GATEWAY_MESSAGE_TYPES,
  GATEWAY_SCHEMA_VERSION,
  gatewayMessageSchema,
} from "./contracts.js";
import {
  GATEWAY_V2_MESSAGE_TYPES,
  GATEWAY_V2_SCHEMA_VERSION,
  gatewayV2MessageSchema,
} from "./contracts-v2.js";
import {
  THREAD_GATEWAY_MESSAGE_TYPES,
  THREAD_GATEWAY_SCHEMA_VERSION,
  threadGatewayMessageSchema,
} from "./thread-contracts-v3.js";

export const CLIENT_GATEWAYS = ["v1", "v2", "thread-v3"] as const;
export type ClientGateway = (typeof CLIENT_GATEWAYS)[number];

export const CLIENT_CAPABILITY_TIERS = [
  "read",
  "routine",
  "tighten",
  "change",
  "not_on_phone",
] as const;
export type ClientCapabilityTier = (typeof CLIENT_CAPABILITY_TIERS)[number];

export type ClientRequestKind = "query" | "command";

export interface ClientCapabilityEntry {
  readonly gateway: ClientGateway;
  readonly type: string;
  readonly kind: ClientRequestKind;
  readonly tier: ClientCapabilityTier;
  readonly tightenPayload?: Readonly<Record<string, boolean>>;
  readonly tightenOpenKeys?: readonly string[];
  readonly tightenEveryItem?: ClientItemTighten;
  readonly reason?: string;
}

export interface ClientItemTighten {
  readonly key: string;
  readonly equals: Readonly<Record<string, string>>;
  readonly nulls: readonly string[];
  readonly openKeys: readonly string[];
}

const READ = "read" as const;
const CHANGE = "change" as const;

function query(gateway: ClientGateway, type: string): ClientCapabilityEntry {
  return { gateway, type, kind: "query", tier: READ };
}

function change(gateway: ClientGateway, type: string): ClientCapabilityEntry {
  return { gateway, type, kind: "command", tier: CHANGE };
}

function routine(gateway: ClientGateway, type: string): ClientCapabilityEntry {
  return { gateway, type, kind: "command", tier: "routine" };
}

function tighten(gateway: ClientGateway, type: string): ClientCapabilityEntry {
  return { gateway, type, kind: "command", tier: "tighten" };
}

function tightenOrChange(
  gateway: ClientGateway,
  type: string,
  tightenPayload: Readonly<Record<string, boolean>>,
  tightenOpenKeys: readonly string[] = [],
): ClientCapabilityEntry {
  return {
    gateway,
    type,
    kind: "command",
    tier: CHANGE,
    tightenPayload,
    ...(tightenOpenKeys.length > 0 ? { tightenOpenKeys } : {}),
  };
}

function tightenWhenEveryItem(
  gateway: ClientGateway,
  type: string,
  tightenEveryItem: ClientItemTighten,
): ClientCapabilityEntry {
  return { gateway, type, kind: "command", tier: CHANGE, tightenEveryItem };
}

function notOnPhone(
  gateway: ClientGateway,
  type: string,
  kind: ClientRequestKind,
  reason: string,
): ClientCapabilityEntry {
  return { gateway, type, kind, tier: "not_on_phone", reason };
}

const VIA_DEVICE_MESSAGES = "手机发消息走设备接口 POST messages，和网页进同一个对话";
const WEB_PUSH_ONLY = "这是网页推送的登记；手机用苹果推送，走设备接口 POST push/register";
const WEB_PRESENCE_ONLY = "这是网页标签页的在线心跳；手机的在线状态由设备事件流的心跳决定";
const DEVICE_FEEDBACK = "手机上的通知反馈走设备接口 POST feedback";
const INTERNAL_ONLY = "只由服务器内部在回答生成完成时调用，网页也不直接发";
const NO_V1_IN_PRODUCTION =
  "生产服务没有装最早那套网关（v1），网页也已改用对话网关和 v2；手机走同样的两套";
const WEB_OPERATIONS_ONLY = "多端分工：运维类页面留在网页（Andy 2026-11-12）";
const WEB_TASKS_ONLY =
  "网页的任务页约定还没定（contractStatus 是 missing），这条命令只在那一页用；网页定了约定后再补原生页";

export const CLIENT_CAPABILITY_TABLE: readonly ClientCapabilityEntry[] = Object.freeze([
  notOnPhone("v1", "trigger.admit", "command", NO_V1_IN_PRODUCTION),
  notOnPhone("v1", "thread.create", "command", NO_V1_IN_PRODUCTION),
  notOnPhone("v1", "thread.close", "command", NO_V1_IN_PRODUCTION),
  notOnPhone("v1", "run.cancel", "command", NO_V1_IN_PRODUCTION),
  notOnPhone("v1", "approval.respond", "command", NO_V1_IN_PRODUCTION),
  notOnPhone("v1", "thread.get_snapshot", "query", NO_V1_IN_PRODUCTION),
  notOnPhone("v1", "run.get_snapshot", "query", NO_V1_IN_PRODUCTION),
  notOnPhone("v1", "trace.query", "query", NO_V1_IN_PRODUCTION),

  notOnPhone("v2", "thread.message.submit", "command", VIA_DEVICE_MESSAGES),
  change("v2", "approval.respond"),
  change("v2", "approval.allowance.set"),
  change("v2", "approval.allowance.days.set"),
  tighten("v2", "approval.allowance.revoke"),
  change("v2", "search.authorization.set"),
  query("v2", "search.authorization.read"),
  notOnPhone("v2", "push.subscription.set", "command", WEB_PUSH_ONLY),
  tightenOrChange("v2", "push.kind.set", { enabled: false }, ["kind"]),
  notOnPhone("v2", "push.test", "command", WEB_PUSH_ONLY),
  notOnPhone("v2", "presence.heartbeat", "command", WEB_PRESENCE_ONLY),
  notOnPhone("v2", "push.feedback.record", "command", DEVICE_FEEDBACK),
  query("v2", "push.status.read"),
  query("v2", "proactive.overview.read"),
  change("v2", "proactive.settings.set"),
  tighten("v2", "proactive.pause"),
  change("v2", "proactive.insight.respond"),
  change("v2", "proactive.decision.rate"),
  change("v2", "proactive.audit.respond"),
  query("v2", "proactive.review.read"),
  change("v2", "proactive.review.rate"),
  change("v2", "proactive.review.checkup"),
  change("v2", "proactive.source.manage"),
  query("v2", "proactive.sources.read"),
  change("v2", "proactive.source.settings.set"),
  tighten("v2", "proactive.source.switch_off"),
  query("v2", "muse.overview.read"),
  change("v2", "muse.item.rate"),
  tightenOrChange("v2", "muse.intake.set", { paused: true }),
  change("v2", "muse.data.clear"),
  query("v2", "proactive.weekly.read"),
  change("v2", "proactive.observation.start"),
  change("v2", "proactive.gapcase.mark"),
  query("v2", "owner.preferences.read"),
  change("v2", "owner.preferences.set"),
  query("v2", "quiet_hours.read"),
  change("v2", "quiet_hours.set"),
  query("v2", "perception.status.read"),
  query("v2", "perception.day.read"),
  query("v2", "perception.episode.read"),
  query("v2", "perception.usage.read"),
  change("v2", "perception.settings.change"),
  query("v2", "perception.deletion.plan"),
  query("v2", "perception.deletion.read"),
  change("v2", "perception.records.delete"),
  query("v2", "think.settings.read"),
  change("v2", "think.settings.change"),
  query("v2", "timers.read"),
  routine("v2", "timers.change"),
  query("v2", "sensitive.interceptions.read"),
  change("v2", "sensitive.interceptions.clear"),
  query("v2", "memory.overview.read"),
  query("v2", "memory.basis.read"),
  query("v2", "decision.chain.read"),
  query("v2", "decision.email.read"),
  change("v2", "memory.approval.respond"),
  change("v2", "memory.tidy.undo"),
  change("v2", "memory.reminder.respond"),
  change("v2", "memory.reminder.create"),
  query("v2", "memory.rules.read"),
  change("v2", "memory.rule.respond"),
  change("v2", "memory.create"),
  change("v2", "memory.category.set"),
  tightenOrChange("v2", "memory.settings.set", { capturePaused: true }),
  routine("v2", "memory.page.viewed"),
  change("v2", "memory.person.respond"),
  tightenWhenEveryItem("v2", "memory.external.respond", {
    key: "items",
    equals: { decision: "reject" },
    nulls: ["editedText"],
    openKeys: ["proposalId"],
  }),
  change("v2", "memory.external.undo"),
  change("v2", "memory.mcpSync.projectDecide"),
  change("v2", "memory.mcpSync.noteDecide"),
  change("v2", "memory.mcpSync.attentionResolve"),
  change("v2", "memory.conversationReview.undo"),
  query("v2", "memory.review.read"),
  change("v2", "memory.review.respond"),
  change("v2", "memory.review.reportMissed"),
  query("v2", "memory.classify.read"),
  query("v2", "home.read"),
  query("v2", "search.ask.read"),
  query("v2", "device.list.read"),
  change("v2", "device.pairing.start"),
  change("v2", "device.pairing.confirm"),
  change("v2", "device.rename"),
  change("v2", "device.revoke"),
  query("v2", "server.status.read"),
  query("v2", "login.devices.read"),
  change("v2", "login.device.revoke"),
  change("v2", "login.devices.revoke_others"),
  query("v2", "mcp.connections.read"),
  change("v2", "mcp.connection.create"),
  change("v2", "mcp.connection.change"),
  change("v2", "mcp.connection.rotate"),
  query("v2", "files.list.read"),
  change("v2", "data.export.start"),
  routine("v2", "data.export.cancel"),
  query("v2", "data.export.status.read"),
  query("v2", "memory.import.duplicates.read"),
  change("v2", "memory.import.commit"),
  change("v2", "memory.import.undo"),
  notOnPhone("v2", "github.monitor.set_state", "command", WEB_TASKS_ONLY),
  change("v2", "memory.mutate"),
  change("v2", "grant.revoke"),
  change("v2", "capability.review"),
  change("v2", "capability.install.approve"),
  change("v2", "capability.update.respond"),
  change("v2", "capability.disable"),
  change("v2", "capability.reactivate"),
  change("v2", "capability.rollback"),
  notOnPhone("v2", "host.file.prepare", "command", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "host.file.execute", "command", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "workspace.copy.create", "command", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "workspace.copy.prepare", "command", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "workspace.copy.select", "command", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "workspace.stage", "command", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "workspace.commit", "command", WEB_OPERATIONS_ONLY),
  change("v2", "suggestion.respond"),
  change("v2", "reflection.configure"),
  change("v2", "improvement.review"),
  query("v2", "thread.list"),
  query("v2", "approval.list"),
  query("v2", "approval.detail"),
  query("v2", "capability.list"),
  query("v2", "capability.detail"),
  query("v2", "grant.list"),
  query("v2", "grant.detail"),
  notOnPhone("v2", "host.directory.detail", "query", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "workspace.detail", "query", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "workspace.list", "query", WEB_OPERATIONS_ONLY),
  query("v2", "suggestion.list"),
  query("v2", "suggestion.detail"),
  query("v2", "reflection.detail"),
  notOnPhone("v2", "delegation.detail", "query", WEB_OPERATIONS_ONLY),
  notOnPhone("v2", "delegation.list", "query", WEB_OPERATIONS_ONLY),
  query("v2", "improvement.list"),
  query("v2", "improvement.detail"),

  routine("thread-v3", "thread.create"),
  notOnPhone("thread-v3", "thread.message.submit", "command", VIA_DEVICE_MESSAGES),
  notOnPhone("thread-v3", "thread.message.submit_configured", "command", VIA_DEVICE_MESSAGES),
  tighten("thread-v3", "thread.run.cancel"),
  notOnPhone("thread-v3", "thread.message.commit_assistant", "command", INTERNAL_ONLY),
  routine("thread-v3", "thread.rename"),
  routine("thread-v3", "thread.pin"),
  routine("thread-v3", "thread.archive"),
  routine("thread-v3", "thread.restore"),
  routine("thread-v3", "thread.fork"),
  routine("thread-v3", "thread.set_answer_locale"),
  routine("thread-v3", "thread.trash"),
  change("thread-v3", "thread.delete_permanently"),
  routine("thread-v3", "thread.task.resolve"),
  change("thread-v3", "thread.option.choose"),
  query("thread-v3", "thread.deletion_impact"),
  query("thread-v3", "thread.list"),
  query("thread-v3", "thread.detail"),
  query("thread-v3", "thread.main"),
  query("thread-v3", "thread.execution"),
  query("thread-v3", "thread.execution_state"),
  query("thread-v3", "thread.execution_environment"),
  query("thread-v3", "thread.background_work"),
  query("thread-v3", "thread.search"),
  query("thread-v3", "thread.lineage"),
  query("thread-v3", "thread.checkpoint"),
]);

export const CLIENT_RESPONSE_ONLY_TYPES: Readonly<Record<ClientGateway, readonly string[]>> =
  Object.freeze({
    v1: ["events.subscribe", "thread.snapshot", "run.snapshot", "stream.event"],
    v2: GATEWAY_V2_MESSAGE_TYPES.filter(
      (type) => type.endsWith(".snapshot") || type === "stream.event",
    ),
    "thread-v3": [
      "thread.events",
      "thread.execution_events",
      "thread.snapshot",
      "thread.collection_snapshot",
      "thread.detail_snapshot",
      "thread.execution_snapshot",
      "thread.execution_state_snapshot",
      "thread.execution_environment_snapshot",
      "thread.background_work_snapshot",
      "thread.search_snapshot",
      "thread.lineage_snapshot",
      "thread.main_snapshot",
      "thread.checkpoint_snapshot",
      "thread.deletion_impact_snapshot",
      "thread.command_result",
      "thread.conflict",
      "thread.event",
      "thread.execution_changed",
      "thread.execution_text",
    ],
  });

export const CLIENT_GATEWAY_MESSAGE_TYPES: Readonly<Record<ClientGateway, readonly string[]>> =
  Object.freeze({
    v1: GATEWAY_MESSAGE_TYPES,
    v2: GATEWAY_V2_MESSAGE_TYPES,
    "thread-v3": THREAD_GATEWAY_MESSAGE_TYPES,
  });

export const CLIENT_GATEWAY_SCHEMAS = Object.freeze({
  v1: { schemaVersion: GATEWAY_SCHEMA_VERSION, schema: gatewayMessageSchema },
  v2: { schemaVersion: GATEWAY_V2_SCHEMA_VERSION, schema: gatewayV2MessageSchema },
  "thread-v3": { schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION, schema: threadGatewayMessageSchema },
} as const);

export function findClientCapability(
  gateway: ClientGateway,
  type: string,
): ClientCapabilityEntry | undefined {
  return CLIENT_CAPABILITY_TABLE.find((entry) => entry.gateway === gateway && entry.type === type);
}

function sameFlags(
  payload: unknown,
  expected: Readonly<Record<string, boolean>>,
  openKeys: readonly string[],
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const actual = payload as Record<string, unknown>;
  const keys = Object.keys(actual).filter((key) => !openKeys.includes(key));
  return (
    openKeys.every((key) => Object.hasOwn(actual, key)) &&
    keys.length === Object.keys(expected).length &&
    keys.every((key) => Object.hasOwn(expected, key) && actual[key] === expected[key])
  );
}

export function requiredClientTier(
  entry: ClientCapabilityEntry,
  payload: unknown,
): ClientCapabilityTier {
  if (entry.tightenPayload && sameFlags(payload, entry.tightenPayload, entry.tightenOpenKeys ?? []))
    return "tighten";
  if (entry.tightenEveryItem && everyItemTightens(payload, entry.tightenEveryItem))
    return "tighten";
  return entry.tier;
}

function everyItemTightens(payload: unknown, rule: ClientItemTighten): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const fields = payload as Record<string, unknown>;
  const keys = Object.keys(fields);
  const items = fields[rule.key];
  if (keys.length !== 1 || keys[0] !== rule.key || !Array.isArray(items) || items.length === 0)
    return false;
  const expectedKeys = [...Object.keys(rule.equals), ...rule.nulls, ...rule.openKeys].sort();
  return items.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return (
      Object.keys(entry).sort().join("\n") === expectedKeys.join("\n") &&
      Object.entries(rule.equals).every(([key, value]) => entry[key] === value) &&
      rule.nulls.every((key) => entry[key] === null)
    );
  });
}

export type ClientPageEntry =
  | { readonly webPage: string; readonly nativePage: string; readonly noGatewayTypes?: string }
  | { readonly webPage: string; readonly notOnPhone: string };

const WEB_CONTRACT_MISSING = "网页自己还没有约定，没有任何查询或命令；网页定了约定后补原生页";
const NOT_IN_THIS_PHONE_VERSION =
  "这一版手机上不做，留在电脑网页：下一版范围清单和界面基线第 4 版都没有这一页（ADR 0258）";

export const CLIENT_PAGE_TABLE: readonly ClientPageEntry[] = Object.freeze([
  { webPage: "threads", nativePage: "chat" },
  { webPage: "approvals", nativePage: "chat" },
  { webPage: "tasks", notOnPhone: WEB_TASKS_ONLY },
  { webPage: "inbox-digest", notOnPhone: WEB_CONTRACT_MISSING },
  { webPage: "memory", nativePage: "memory" },
  { webPage: "capabilities-adapters", notOnPhone: NOT_IN_THIS_PHONE_VERSION },
  { webPage: "authorizations-grants", nativePage: "settings.authorizations" },
  { webPage: "host-workspaces", notOnPhone: WEB_OPERATIONS_ONLY },
  { webPage: "suggestions", nativePage: "chat" },
  { webPage: "reflection", nativePage: "memory.reflection" },
  { webPage: "workers", notOnPhone: WEB_OPERATIONS_ONLY },
  { webPage: "improvements", notOnPhone: NOT_IN_THIS_PHONE_VERSION },
  { webPage: "trace", notOnPhone: WEB_CONTRACT_MISSING },
  { webPage: "settings", notOnPhone: WEB_CONTRACT_MISSING },
  {
    webPage: "sessions-devices",
    nativePage: "settings.devices",
    noGatewayTypes: "网页自己没有设备管理的查询和命令；手机用设备接口自己的 device.* 类型",
  },
  { webPage: "health-deployment", notOnPhone: WEB_OPERATIONS_ONLY },
]);
