import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import type { BackgroundCommandView } from "./background-commands.js";
import { executionItems, type RunSummary } from "./execution-view.js";
import type { MessageId } from "./i18n/message-ids.js";
import type { RegisteredFile, RegisteredFileKind } from "./registered-files.js";
import { fileExtension, type TurnFile, turnFiles } from "./turn-files.js";

export interface DeliveredFile {
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly kind: RegisteredFileKind;
  readonly runId: string;
  readonly turn: number;
  readonly source: "write" | "edit" | "bash" | "upload";
  readonly command: string | undefined;
  readonly versions: number;
  readonly registered: RegisteredFile | undefined;
  readonly trace: TurnFile | undefined;
}

export interface DeliveredFileGroup {
  readonly runId: string;
  readonly turn: number;
  readonly title: string | undefined;
  readonly command: string | undefined;
  readonly files: readonly DeliveredFile[];
}

const TRACE_KINDS: Readonly<Record<TurnFile["kind"], RegisteredFileKind>> = {
  markdown: "document",
  csv: "data",
  html: "web",
  code: "code",
  text: "document",
};

export const FILE_KIND_LABELS: Readonly<Record<RegisteredFileKind, MessageId>> = {
  document: "files.kind.document",
  code: "files.kind.code",
  web: "files.kind.html",
  image: "files.kind.image",
  pdf: "files.kind.pdf",
  data: "files.kind.csv",
  other: "files.kind.other",
};

export function fileBadge(name: string): string {
  return fileExtension(name).slice(0, 4).toUpperCase() || "TXT";
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

const firstLine = (text: string | undefined, limit = 48) => {
  const line = text?.split("\n")[0]?.trim();
  if (!line) return undefined;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

function bashCommand(records: readonly ThreadExecutionRecord[], itemId: string) {
  const item = executionItems(records).find(
    (entry) => entry.kind === "tool" && entry.itemId === itemId,
  );
  if (!item) return undefined;
  try {
    const args: unknown = JSON.parse(item.input);
    return args && typeof args === "object" && "command" in args
      ? firstLine(String((args as { command: unknown }).command))
      : undefined;
  } catch {
    return undefined;
  }
}

const tracePathMatches = (trace: TurnFile, path: string) =>
  trace.path === path || trace.path.endsWith(`/${path}`);

export function deliveredFileGroups(input: {
  readonly runs: readonly RunSummary[];
  readonly execution: Readonly<Record<string, readonly ThreadExecutionRecord[]>>;
  readonly registered: readonly RegisteredFile[] | undefined;
  readonly commands: readonly BackgroundCommandView[];
  readonly titles: Readonly<Record<string, string>>;
}): readonly DeliveredFileGroup[] {
  const turnOf = new Map(input.runs.map((run, index) => [run.runId, index + 1]));
  const commandOf = new Map(input.commands.map((command) => [command.key, command]));
  const versions = new Map<string, number>();
  for (const file of input.registered ?? [])
    versions.set(file.path, Math.max(versions.get(file.path) ?? 0, file.version));
  const groups = new Map<string, Map<string, DeliveredFile>>();
  const commandLabels = new Map<string, string | undefined>();
  const add = (runId: string, file: DeliveredFile) => {
    const files = groups.get(runId) ?? new Map<string, DeliveredFile>();
    const current = files.get(file.path);
    if (!current || (file.registered?.version ?? 0) >= (current.registered?.version ?? 0))
      files.set(file.path, file);
    groups.set(runId, files);
  };
  const traces = new Map(
    input.runs.map((run) => [run.runId, turnFiles(run.runId, input.execution[run.runId] ?? [])]),
  );
  const used = new Set<TurnFile>();
  const latestVersion = new Map<string, RegisteredFile>();
  for (const file of input.registered ?? []) {
    const current = latestVersion.get(file.path);
    if (!current || file.version > current.version) latestVersion.set(file.path, file);
  }
  const removed = new Set(
    [...latestVersion.values()].filter((file) => file.deleted).map((file) => file.path),
  );
  for (const file of input.registered ?? []) {
    if (file.deleted) {
      const trace = traces
        .get(file.runId)
        ?.find((candidate) => tracePathMatches(candidate, file.path));
      if (trace) used.add(trace);
      continue;
    }
    const background = file.commandKey ? commandOf.get(file.commandKey) : undefined;
    const runId = background?.noticeRunId ?? file.runId;
    if (!turnOf.has(runId)) continue;
    const trace =
      file.source === "bash"
        ? undefined
        : traces.get(file.runId)?.find((candidate) => tracePathMatches(candidate, file.path));
    if (trace) used.add(trace);
    const command =
      file.source !== "bash"
        ? undefined
        : background
          ? firstLine(background.label)
          : bashCommand(input.execution[file.runId] ?? [], file.toolItemId);
    if (background && runId !== file.runId) commandLabels.set(runId, command);
    add(runId, {
      key: file.id,
      name: file.path,
      path: file.path,
      kind: file.kind,
      runId,
      turn: turnOf.get(runId) ?? file.turn,
      source: file.source,
      command,
      versions: versions.get(file.path) ?? file.version,
      registered: file,
      trace,
    });
  }
  for (const [runId, files] of traces)
    for (const trace of files) {
      if (used.has(trace)) continue;
      if ([...removed].some((path) => tracePathMatches(trace, path))) continue;
      if (
        [...(groups.get(runId)?.values() ?? [])].some((file) => tracePathMatches(trace, file.path))
      )
        continue;
      add(runId, {
        key: trace.key,
        name: trace.name,
        path: trace.path,
        kind: TRACE_KINDS[trace.kind],
        runId,
        turn: turnOf.get(runId) ?? 0,
        source: trace.content !== undefined && !trace.diff.length ? "write" : "edit",
        command: undefined,
        versions: 1,
        registered: undefined,
        trace,
      });
    }
  return input.runs
    .flatMap((run) => {
      const files = groups.get(run.runId);
      if (!files?.size) return [];
      return [
        {
          runId: run.runId,
          turn: turnOf.get(run.runId) ?? 0,
          title: input.titles[run.runId],
          command: commandLabels.get(run.runId),
          files: [...files.values()],
        },
      ];
    })
    .reverse();
}
