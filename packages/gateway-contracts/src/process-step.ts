export const PROCESS_STEP_KINDS = [
  "search",
  "recall",
  "reminder",
  "rule",
  "fetch",
  "read",
  "write",
  "edit",
  "list",
  "find",
  "grep",
  "command",
  "move",
  "save",
  "taskStart",
  "task",
  "authorized",
  "other",
] as const;

export type ProcessStepKind = (typeof PROCESS_STEP_KINDS)[number];

const KIND_BY_TOOL: Readonly<Record<string, ProcessStepKind>> = {
  web_search: "search",
  web_fetch: "fetch",
  recall: "recall",
  reminder_set: "reminder",
  reminder_list: "reminder",
  reminder_cancel: "reminder",
  rule_set: "rule",
  rule_list: "rule",
  rule_undo: "rule",
  read: "read",
  write: "write",
  edit: "edit",
  ls: "list",
  find: "find",
  grep: "grep",
  bash: "command",
  move_directory: "move",
  save_copy: "save",
  execution_task_start: "taskStart",
  execution_task_status: "task",
  execution_task_output: "task",
  execution_task_cancel: "task",
};

export function processStepKind(toolName: string): ProcessStepKind {
  if (Object.hasOwn(KIND_BY_TOOL, toolName)) return KIND_BY_TOOL[toolName] as ProcessStepKind;
  return toolName.startsWith("authorized_") ? "authorized" : "other";
}

export const PROCESS_STEP_LOCALES = ["zh-CN", "en", "ja"] as const;
export type ProcessStepLocale = (typeof PROCESS_STEP_LOCALES)[number];

export const PROCESS_STEP_TEXT: Readonly<
  Record<ProcessStepLocale, Readonly<Record<ProcessStepKind, string>>>
> = {
  "zh-CN": {
    search: "搜索网页",
    recall: "翻看记忆",
    reminder: "处理提醒",
    rule: "处理长期规则",
    fetch: "打开网页",
    read: "读取文件",
    write: "写入文件",
    edit: "修改文件",
    list: "查看文件夹",
    find: "查找文件",
    grep: "搜索文件内容",
    command: "运行命令",
    move: "移动文件夹",
    save: "保存改动",
    taskStart: "启动后台任务",
    task: "查看后台任务",
    authorized: "执行已授权的操作",
    other: "使用工具",
  },
  en: {
    search: "Searching the web",
    recall: "Checking memory",
    reminder: "Working on reminders",
    rule: "Working on standing rules",
    fetch: "Opening a web page",
    read: "Reading a file",
    write: "Writing a file",
    edit: "Editing a file",
    list: "Looking in a folder",
    find: "Finding files",
    grep: "Searching in files",
    command: "Running a command",
    move: "Moving a folder",
    save: "Saving changes",
    taskStart: "Starting a background task",
    task: "Checking a background task",
    authorized: "Running an approved action",
    other: "Using a tool",
  },
  ja: {
    search: "ウェブ検索",
    recall: "記憶を確認",
    reminder: "リマインダーを操作",
    rule: "常設ルールを操作",
    fetch: "ウェブページ表示",
    read: "ファイル読み込み",
    write: "ファイル書き込み",
    edit: "ファイル編集",
    list: "フォルダ確認",
    find: "ファイル探索",
    grep: "ファイル内検索",
    command: "コマンド実行",
    move: "フォルダ移動",
    save: "変更の保存",
    taskStart: "バックグラウンド作業の開始",
    task: "バックグラウンド作業の確認",
    authorized: "承認済み操作の実行",
    other: "ツール使用",
  },
};

export function processStepText(toolName: string, locale: string): string {
  const texts = (PROCESS_STEP_LOCALES as readonly string[]).includes(locale)
    ? PROCESS_STEP_TEXT[locale as ProcessStepLocale]
    : PROCESS_STEP_TEXT["zh-CN"];
  return texts[processStepKind(toolName)];
}
