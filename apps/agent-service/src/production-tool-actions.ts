import {
  type CapabilityAuthorizationFacts,
  type DataClassification,
  type JsonObject,
  type ToolActionLocale,
  ToolActionRegistry,
  type ToolActionRow,
} from "@himawari-agent/application";
import {
  RUNTIME_CONTEXT_EXECUTOR,
  TOOL_RESULT_RECALL_CAPABILITY_REF,
} from "./production-context-recall.js";
import { MANAGED_TASK_ACTIONS } from "./production-managed-tasks.js";
import { MEMORY_RECALL_CAPABILITY_REF } from "./production-memory-recall.js";
import {
  RULE_LIST_CAPABILITY_REF,
  RULE_SET_CAPABILITY_REF,
  RULE_UNDO_CAPABILITY_REF,
} from "./production-owner-rules.js";
import {
  DEVICE_ACTION_CAPABILITY_REF,
  PERCEPTION_READ_CAPABILITY_REF,
} from "./production-perception-tools.js";
import {
  REMINDER_CANCEL_CAPABILITY_REF,
  REMINDER_LIST_CAPABILITY_REF,
  REMINDER_SET_CAPABILITY_REF,
} from "./production-reminder-writer.js";

export const BUILT_IN_CAPABILITY_VERSION = "1.0.0";

const ALL_CLASSIFICATIONS: readonly DataClassification[] = Object.freeze([
  "public",
  "private",
  "sensitive",
  "restricted",
]);

type Wording = Readonly<Record<ToolActionLocale, string>>;

const DETAIL_LIMIT = 120;

function clip(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

function detail(wording: Wording, field?: string): ToolActionRow["detail"] {
  return (input: JsonObject, locale: ToolActionLocale) => {
    const value = field === undefined ? "" : clip(input[field]);
    return value.length === 0 ? wording[locale] : `${wording[locale]}: ${value}`;
  };
}

const READ_DEFAULTS = {
  actionKind: "READ",
  reversible: true,
  sideEffect: "none",
  disclosure: "none",
  ownerPresenceRequired: false,
  standingRuleChange: false,
  mayFollowExternalContent: true,
} as const;

const OWNER_WRITE_DEFAULTS = {
  family: "builtin",
  actionKind: "CREATE_OR_UPDATE",
  reversible: true,
  sideEffect: "reversible",
  disclosure: "none",
  ownerPresenceRequired: false,
  resultOrigin: "owner_data",
  mayFollowExternalContent: true,
  authorization: "owner_scope",
  executor: "owner_scoped",
  deduplication: "run_and_tool_call",
} as const;

const GOVERNED_DEFAULTS = {
  capabilityRef: null,
  disclosure: "named_recipients",
  ownerPresenceRequired: false,
  standingRuleChange: false,
  mayFollowExternalContent: true,
  authorization: "governed_workflow",
} as const;

function codingRead(tool: "read" | "ls" | "find" | "grep", wording: Wording): ToolActionRow {
  return {
    ...GOVERNED_DEFAULTS,
    tool,
    family: "coding",
    operation: tool,
    actionKind: "READ",
    reversible: true,
    sideEffect: "none",
    targetType: "workspace-file",
    resultOrigin: "external",
    executor: "coding_workflow",
    deduplication: "coding_intent",
    detail: detail(wording, tool === "read" ? "path" : tool === "ls" ? "path" : "pattern"),
  };
}

function codingWrite(tool: "write" | "edit" | "move_directory", wording: Wording): ToolActionRow {
  return {
    ...GOVERNED_DEFAULTS,
    tool,
    family: "coding",
    operation: tool,
    actionKind: "CREATE_OR_UPDATE",
    reversible: true,
    sideEffect: "reversible",
    targetType: "workspace-file",
    resultOrigin: "owner_data",
    executor: "coding_workflow",
    deduplication: "coding_intent",
    detail: detail(wording, "path"),
  };
}

function taskManagement(action: (typeof MANAGED_TASK_ACTIONS)[number]): ToolActionRow {
  const wording: Readonly<Record<(typeof MANAGED_TASK_ACTIONS)[number], Wording>> = {
    status: { zh: "查看任务状态", en: "Check task status", ja: "タスクの状態を確認" },
    output: { zh: "读取任务输出", en: "Read task output", ja: "タスクの出力を読む" },
    cancel: { zh: "停止任务", en: "Stop task", ja: "タスクを停止" },
  };
  return {
    ...GOVERNED_DEFAULTS,
    tool: `execution_task_${action}`,
    family: "task_management",
    capabilityRef: `execution.task.${action}`,
    operation: action,
    actionKind: action === "cancel" ? "CREATE_OR_UPDATE" : "READ",
    reversible: action !== "cancel",
    sideEffect: action === "cancel" ? "irreversible" : "none",
    disclosure: "none",
    targetType: "managed-task",
    resultOrigin: action === "cancel" ? "owner_data" : "external",
    ...(action === "cancel" ? { authorization: "owner_scope" as const } : {}),
    executor: "managed_tasks",
    deduplication: "task_resource_authority",
    detail: detail(wording[action], "resourceRef"),
  };
}

export const PRODUCTION_TOOL_ACTION_ROWS: readonly ToolActionRow[] = Object.freeze([
  codingRead("read", { zh: "读文件", en: "Read file", ja: "ファイルを読む" }),
  codingRead("ls", { zh: "列目录", en: "List folder", ja: "フォルダを一覧" }),
  codingRead("find", { zh: "找文件", en: "Find files", ja: "ファイルを探す" }),
  codingRead("grep", { zh: "搜文件内容", en: "Search file contents", ja: "ファイル内を検索" }),
  codingWrite("write", { zh: "写文件", en: "Write file", ja: "ファイルを書く" }),
  codingWrite("edit", { zh: "改文件", en: "Edit file", ja: "ファイルを編集" }),
  codingWrite("move_directory", { zh: "移动文件夹", en: "Move folder", ja: "フォルダを移動" }),
  {
    ...GOVERNED_DEFAULTS,
    tool: "bash",
    family: "coding",
    operation: "bash",
    actionKind: "INSTALL_OR_EXECUTE_CODE",
    reversible: false,
    sideEffect: "irreversible",
    targetType: "workspace-command",
    resultOrigin: "external",
    executor: "coding_workflow",
    deduplication: "coding_intent",
    detail: detail({ zh: "运行命令", en: "Run command", ja: "コマンドを実行" }, "command"),
  },
  {
    ...GOVERNED_DEFAULTS,
    tool: "save_copy",
    family: "coding",
    operation: "save_copy",
    actionKind: "DELETE",
    reversible: true,
    sideEffect: "reversible",
    targetType: "workspace-file",
    resultOrigin: "owner_data",
    executor: "coding_workflow",
    deduplication: "prepared_file_operation",
    detail: detail(
      { zh: "把副本里的改动存回原处", en: "Save copy changes back", ja: "コピーの変更を元に保存" },
      "operationId",
    ),
  },
  {
    ...GOVERNED_DEFAULTS,
    tool: "web_search",
    family: "web",
    operation: "web_search",
    actionKind: "READ",
    reversible: true,
    sideEffect: "none",
    targetType: "web",
    resultOrigin: "external",
    executor: "coding_workflow",
    deduplication: "coding_intent",
    detail: detail({ zh: "联网搜索", en: "Web search", ja: "ウェブ検索" }, "query"),
  },
  {
    ...GOVERNED_DEFAULTS,
    tool: "web_fetch",
    family: "web",
    operation: "web_fetch",
    actionKind: "READ",
    reversible: true,
    sideEffect: "none",
    targetType: "web",
    resultOrigin: "external",
    executor: "coding_workflow",
    deduplication: "coding_intent",
    detail: detail({ zh: "打开网页", en: "Open web page", ja: "ウェブページを開く" }, "url"),
  },
  {
    ...GOVERNED_DEFAULTS,
    tool: "authorized_",
    toolIsPrefix: true,
    family: "authorized_handle",
    operation: "invoke",
    actionKind: "INSTALL_OR_EXECUTE_CODE",
    reversible: false,
    sideEffect: "irreversible",
    targetType: "capability-handle",
    resultOrigin: "external",
    executor: "capability_handle",
    deduplication: "capability_invocation_receipt",
    detail: detail({
      zh: "使用已授权的能力",
      en: "Use an authorized capability",
      ja: "許可済みの機能を使う",
    }),
  },
  {
    ...GOVERNED_DEFAULTS,
    tool: "execution_task_start",
    family: "task_management",
    capabilityRef: "execution.task.start",
    operation: "start",
    actionKind: "INSTALL_OR_EXECUTE_CODE",
    reversible: false,
    sideEffect: "irreversible",
    targetType: "capability-handle",
    resultOrigin: "external",
    executor: "capability_handle",
    deduplication: "capability_invocation_receipt",
    detail: detail({ zh: "启动任务", en: "Start task", ja: "タスクを開始" }),
  },
  ...MANAGED_TASK_ACTIONS.map(taskManagement),
  {
    ...READ_DEFAULTS,
    tool: "recall",
    family: "builtin",
    capabilityRef: MEMORY_RECALL_CAPABILITY_REF,
    operation: "recall",
    targetType: "owner-memory",
    resultOrigin: "owner_data",
    authorization: "read",
    executor: "owner_scoped",
    deduplication: "run_and_tool_call",
    detail: detail({ zh: "查记忆", en: "Search memories", ja: "記憶を検索" }, "query"),
  },
  {
    ...OWNER_WRITE_DEFAULTS,
    tool: "reminder_set",
    himawariSideOnly: true,
    capabilityRef: REMINDER_SET_CAPABILITY_REF,
    operation: "set",
    targetType: "owner-reminder",
    standingRuleChange: false,
    detail: detail({ zh: "建提醒", en: "Set reminder", ja: "リマインダーを作成" }, "text"),
  },
  {
    ...READ_DEFAULTS,
    tool: "reminder_list",
    family: "builtin",
    capabilityRef: REMINDER_LIST_CAPABILITY_REF,
    operation: "list",
    targetType: "owner-reminder",
    resultOrigin: "owner_data",
    authorization: "read",
    executor: "owner_scoped",
    deduplication: "run_and_tool_call",
    detail: detail({ zh: "列出提醒", en: "List reminders", ja: "リマインダーを一覧" }),
  },
  {
    ...OWNER_WRITE_DEFAULTS,
    tool: "reminder_cancel",
    capabilityRef: REMINDER_CANCEL_CAPABILITY_REF,
    operation: "cancel",
    targetType: "owner-reminder",
    standingRuleChange: false,
    detail: detail(
      { zh: "取消提醒", en: "Cancel reminder", ja: "リマインダーを取り消す" },
      "reminderId",
    ),
  },
  {
    ...OWNER_WRITE_DEFAULTS,
    tool: "rule_set",
    capabilityRef: RULE_SET_CAPABILITY_REF,
    operation: "set",
    targetType: "owner-rule",
    standingRuleChange: true,
    detail: detail({ zh: "立规则", en: "Set rule", ja: "ルールを設定" }, "text"),
  },
  {
    ...READ_DEFAULTS,
    tool: "rule_list",
    family: "builtin",
    capabilityRef: RULE_LIST_CAPABILITY_REF,
    operation: "list",
    targetType: "owner-rule",
    resultOrigin: "owner_data",
    authorization: "read",
    executor: "owner_scoped",
    deduplication: "run_and_tool_call",
    detail: detail({ zh: "列出规则", en: "List rules", ja: "ルールを一覧" }),
  },
  {
    ...OWNER_WRITE_DEFAULTS,
    tool: "rule_undo",
    capabilityRef: RULE_UNDO_CAPABILITY_REF,
    operation: "undo",
    targetType: "owner-rule",
    standingRuleChange: true,
    detail: detail({ zh: "撤销规则", en: "Undo rule", ja: "ルールを取り消す" }, "ruleId"),
  },
  {
    ...READ_DEFAULTS,
    tool: "tool_result_recall",
    family: "builtin",
    capabilityRef: TOOL_RESULT_RECALL_CAPABILITY_REF,
    operation: "read",
    targetType: "conversation-context",
    resultOrigin: "owner_data",
    authorization: "read",
    executor: RUNTIME_CONTEXT_EXECUTOR,
    deduplication: "run_and_tool_call",
    detail: detail(
      {
        zh: "取回已清理的工具结果",
        en: "Recall a cleared tool result",
        ja: "整理済みのツール結果を取り戻す",
      },
      "toolCallId",
    ),
  },
  {
    ...READ_DEFAULTS,
    tool: "perception_read",
    family: "builtin",
    capabilityRef: PERCEPTION_READ_CAPABILITY_REF,
    operation: "read",
    targetType: "owner-perception",
    resultOrigin: "owner_data",
    authorization: "read",
    executor: "owner_scoped",
    deduplication: "run_and_tool_call",
    detail: detail(
      { zh: "查感知记录", en: "Read perception records", ja: "感知の記録を調べる" },
      "query",
    ),
  },
  {
    ...OWNER_WRITE_DEFAULTS,
    tool: "device_action",
    capabilityRef: DEVICE_ACTION_CAPABILITY_REF,
    operation: "act",
    targetType: "owner-perception",
    standingRuleChange: false,
    detail: detail(
      { zh: "让设备做一件事", en: "Ask a device to act", ja: "デバイスに操作を依頼" },
      "action",
    ),
  },
] satisfies ToolActionRow[]);

export function productionToolActionRegistry(
  extra: readonly ToolActionRow[] = [],
): ToolActionRegistry {
  return new ToolActionRegistry([...PRODUCTION_TOOL_ACTION_ROWS, ...extra]);
}

export function builtInCapabilityFacts(
  registry: ToolActionRegistry,
  capabilityRef: string,
): CapabilityAuthorizationFacts | undefined {
  const row = registry.forCapability(capabilityRef);
  if (!row || (row.family !== "builtin" && row.authorization !== "owner_scope")) return undefined;
  return Object.freeze({
    lifecycle: "active",
    manifest: Object.freeze({
      version: BUILT_IN_CAPABILITY_VERSION,
      operations: Object.freeze([row.operation]),
      health: Object.freeze({ status: "healthy", checkedAt: null }),
      scopes: Object.freeze({ dataClassifications: ALL_CLASSIFICATIONS }),
    }),
  });
}
