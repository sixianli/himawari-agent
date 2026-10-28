import type { HostWorkspaceSnapshot, HostWorkspaceSnapshotEntry } from "../ports/host-files.js";

export type WorkspaceChangeKind = "created" | "modified" | "deleted";

export interface WorkspaceChange {
  readonly path: string;
  readonly change: WorkspaceChangeKind;
  readonly before: HostWorkspaceSnapshotEntry | null;
  readonly after: HostWorkspaceSnapshotEntry | null;
}

export interface WorkspaceChangeSet {
  readonly complete: boolean;
  readonly changes: readonly WorkspaceChange[];
}

const CHANGE_LABELS: Readonly<Record<WorkspaceChangeKind, string>> = Object.freeze({
  created: "新建",
  modified: "修改",
  deleted: "删除",
});

const SUMMARY_PATH_LIMIT = 20;

function sameEntry(left: HostWorkspaceSnapshotEntry, right: HostWorkspaceSnapshotEntry): boolean {
  return (
    left.kind === right.kind &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.inode === right.inode
  );
}

export function diffWorkspaceSnapshots(
  before: HostWorkspaceSnapshot,
  after: HostWorkspaceSnapshot,
): WorkspaceChangeSet {
  const previous = new Map(before.entries.map((entry) => [entry.path, entry]));
  const current = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changes: WorkspaceChange[] = [];
  for (const [path, entry] of current) {
    const old = previous.get(path);
    if (!old) changes.push({ path, change: "created", before: null, after: entry });
    else if (entry.kind !== "directory" && !sameEntry(old, entry))
      changes.push({ path, change: "modified", before: old, after: entry });
  }
  for (const [path, entry] of previous)
    if (!current.has(path)) changes.push({ path, change: "deleted", before: entry, after: null });
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Object.freeze({
    complete: before.complete && after.complete,
    changes: Object.freeze(changes),
  });
}

export function summarizeWorkspaceChanges(changes: WorkspaceChangeSet): string {
  const prefix = changes.complete ? "" : "（工作目录文件太多，只对比了前一部分）";
  if (changes.changes.length === 0) return `工作目录改动：无${prefix}`;
  const groups = (["created", "modified", "deleted"] as const)
    .map((kind) => {
      const paths = changes.changes.filter(({ change }) => change === kind).map(({ path }) => path);
      if (paths.length === 0) return undefined;
      const shown = paths.slice(0, SUMMARY_PATH_LIMIT).join("、");
      const rest = paths.length > SUMMARY_PATH_LIMIT ? ` 等 ${paths.length} 项` : "";
      return `${CHANGE_LABELS[kind]} ${shown}${rest}`;
    })
    .filter((group): group is string => group !== undefined);
  return `工作目录改动：${groups.join("；")}${prefix}`;
}
