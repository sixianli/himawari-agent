import type { MessageId } from "./i18n/message-ids.js";

type StepKind =
  | "search"
  | "recall"
  | "fetch"
  | "read"
  | "write"
  | "edit"
  | "list"
  | "find"
  | "grep"
  | "command"
  | "move"
  | "save"
  | "taskStart"
  | "task"
  | "authorized"
  | "other";

const kinds: Readonly<Record<string, StepKind>> = {
  web_search: "search",
  web_fetch: "fetch",
  recall: "recall",
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

function stepKind(name: string): StepKind {
  return kinds[name] ?? (name.startsWith("authorized_") ? "authorized" : "other");
}

function argumentsOf(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const field = (args: Record<string, unknown>, key: string) =>
  typeof args[key] === "string" ? (args[key] as string).trim() : "";
const baseName = (path: string) =>
  path === "." ? "" : (path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
function hostName(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** One plain-language line per tool call; raw names and arguments stay in the step detail. */
export function toolStepSummary(name: string, input: string): { id: MessageId; target: string } {
  const kind = stepKind(name);
  const args = argumentsOf(input);
  const target =
    kind === "search" || kind === "recall"
      ? field(args, "query")
      : kind === "fetch"
        ? hostName(field(args, "url"))
        : kind === "find" || kind === "grep"
          ? field(args, "pattern")
          : ["read", "write", "edit", "list", "move"].includes(kind)
            ? baseName(field(args, "path"))
            : kind === "other"
              ? name
              : "";
  return { id: `step.${kind}` as MessageId, target };
}
