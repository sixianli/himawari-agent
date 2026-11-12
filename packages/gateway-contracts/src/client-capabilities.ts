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
  readonly reason?: string;
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
): ClientCapabilityEntry {
  return { gateway, type, kind: "command", tier: CHANGE, tightenPayload };
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
const WEB_TASKS_ONLY =
  "网页的任务页约定还没定（contractStatus 是 missing），这条命令只在那一页用；网页定了约定后再补原生页";

export const CLIENT_CAPABILITY_TABLE: readonly ClientCapabilityEntry[] = Object.freeze([
  change("v1", "trigger.admit"),
  change("v1", "thread.create"),
  change("v1", "thread.close"),
  tighten("v1", "run.cancel"),
  change("v1", "approval.respond"),
  query("v1", "thread.get_snapshot"),
  query("v1", "run.get_snapshot"),
  query("v1", "trace.query"),

  notOnPhone("v2", "thread.message.submit", "command", VIA_DEVICE_MESSAGES),
  change("v2", "approval.respond"),
  change("v2", "search.authorization.set"),
  query("v2", "search.authorization.read"),
  notOnPhone("v2", "push.subscription.set", "command", WEB_PUSH_ONLY),
  change("v2", "push.kind.set"),
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
  change("v2", "proactive.backoff.restore"),
  query("v2", "muse.overview.read"),
  change("v2", "muse.item.rate"),
  tightenOrChange("v2", "muse.intake.set", { paused: true }),
  change("v2", "muse.data.clear"),
  query("v2", "proactive.weekly.read"),
  change("v2", "proactive.observation.start"),
  change("v2", "proactive.gapcase.mark"),
  query("v2", "owner.preferences.read"),
  change("v2", "owner.preferences.set"),
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
  { gateway: "v2", type: "memory.page.viewed", kind: "command", tier: READ },
  change("v2", "memory.person.respond"),
  change("v2", "memory.import.commit"),
  change("v2", "memory.import.undo"),
  notOnPhone("v2", "github.monitor.set_state", "command", WEB_TASKS_ONLY),
  change("v2", "memory.mutate"),
  change("v2", "grant.revoke"),
  change("v2", "capability.review"),
  change("v2", "capability.install.approve"),
  change("v2", "capability.update.respond"),
  change("v2", "capability.disable"),
  change("v2", "capability.rollback"),
  change("v2", "host.file.prepare"),
  change("v2", "host.file.execute"),
  change("v2", "workspace.copy.create"),
  change("v2", "workspace.copy.prepare"),
  change("v2", "workspace.copy.select"),
  change("v2", "workspace.stage"),
  change("v2", "workspace.commit"),
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
  query("v2", "host.directory.detail"),
  query("v2", "workspace.detail"),
  query("v2", "workspace.list"),
  query("v2", "suggestion.list"),
  query("v2", "suggestion.detail"),
  query("v2", "reflection.detail"),
  query("v2", "delegation.detail"),
  query("v2", "delegation.list"),
  query("v2", "improvement.list"),
  query("v2", "improvement.detail"),

  routine("thread-v3", "thread.create"),
  routine("thread-v3", "thread.message.submit"),
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
  query("thread-v3", "thread.deletion_impact"),
  query("thread-v3", "thread.list"),
  query("thread-v3", "thread.detail"),
  query("thread-v3", "thread.execution"),
  query("thread-v3", "thread.execution_state"),
  query("thread-v3", "thread.execution_environment"),
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
      "thread.search_snapshot",
      "thread.lineage_snapshot",
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
): payload is Record<string, boolean> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const actual = payload as Record<string, unknown>;
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => Object.hasOwn(expected, key) && actual[key] === expected[key])
  );
}

export function requiredClientTier(
  entry: ClientCapabilityEntry,
  payload: unknown,
): ClientCapabilityTier {
  if (entry.tightenPayload && sameFlags(payload, entry.tightenPayload)) return "tighten";
  return entry.tier;
}

export type ClientPageEntry =
  | { readonly webPage: string; readonly nativePage: string; readonly noGatewayTypes?: string }
  | { readonly webPage: string; readonly notOnPhone: string };

const WEB_CONTRACT_MISSING = "网页自己还没有约定，没有任何查询或命令；网页定了约定后补原生页";

export const CLIENT_PAGE_TABLE: readonly ClientPageEntry[] = Object.freeze([
  { webPage: "threads", nativePage: "chat" },
  { webPage: "approvals", nativePage: "today.approvals" },
  { webPage: "tasks", notOnPhone: WEB_TASKS_ONLY },
  { webPage: "inbox-digest", notOnPhone: WEB_CONTRACT_MISSING },
  { webPage: "memory", nativePage: "memory" },
  { webPage: "capabilities-adapters", nativePage: "settings.capabilities" },
  { webPage: "authorizations-grants", nativePage: "settings.authorizations" },
  { webPage: "host-workspaces", nativePage: "settings.workspaces" },
  { webPage: "suggestions", nativePage: "today.suggestions" },
  { webPage: "reflection", nativePage: "memory.reflection" },
  { webPage: "workers", nativePage: "settings.workers" },
  { webPage: "improvements", nativePage: "settings.improvements" },
  { webPage: "trace", notOnPhone: WEB_CONTRACT_MISSING },
  { webPage: "settings", notOnPhone: WEB_CONTRACT_MISSING },
  {
    webPage: "sessions-devices",
    nativePage: "settings.devices",
    noGatewayTypes: "等设备管理的网关类型",
  },
  {
    webPage: "health-deployment",
    nativePage: "settings.health",
    noGatewayTypes: "等服务器状态查询",
  },
]);
