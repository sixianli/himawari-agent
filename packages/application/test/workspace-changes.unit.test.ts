import { describe, expect, it } from "vitest";
import type { HostWorkspaceSnapshotEntry } from "../src/ports/host-files.js";
import {
  diffWorkspaceSnapshots,
  summarizeWorkspaceChanges,
} from "../src/services/workspace-changes.js";

function entry(
  path: string,
  kind: HostWorkspaceSnapshotEntry["kind"] = "file",
  size = "1",
  modifiedAtNs = "1",
  inode = path,
): HostWorkspaceSnapshotEntry {
  return { path, kind, size, modifiedAtNs, inode };
}

describe("workspace change ledger diff", () => {
  it("[BW-3] reports created, modified and deleted entries in path order", () => {
    const before = {
      complete: true,
      entries: [entry("keep.txt"), entry("edit.txt"), entry("gone.txt"), entry("dir", "directory")],
    };
    const after = {
      complete: true,
      entries: [
        entry("keep.txt"),
        entry("edit.txt", "file", "2", "5"),
        entry("dir", "directory", "1", "9"),
        entry("dir/new.txt"),
      ],
    };
    const changes = diffWorkspaceSnapshots(before, after);
    expect(changes.complete).toBe(true);
    expect(changes.changes.map(({ path, change }) => `${change}:${path}`)).toEqual([
      "created:dir/new.txt",
      "modified:edit.txt",
      "deleted:gone.txt",
    ]);
    expect(summarizeWorkspaceChanges(changes)).toBe(
      "工作目录改动：新建 dir/new.txt；修改 edit.txt；删除 gone.txt",
    );
  });

  it("[BW-3] treats a replaced inode with the same size and time as a modification", () => {
    const changes = diffWorkspaceSnapshots(
      { complete: true, entries: [entry("a.txt", "file", "1", "1", "10")] },
      { complete: true, entries: [entry("a.txt", "file", "1", "1", "11")] },
    );
    expect(changes.changes.map(({ change }) => change)).toEqual(["modified"]);
  });

  it("[BW-3] says when nothing changed and when the scan was cut short", () => {
    const unchanged = diffWorkspaceSnapshots(
      { complete: true, entries: [entry("a.txt")] },
      { complete: false, entries: [entry("a.txt")] },
    );
    expect(unchanged.complete).toBe(false);
    expect(summarizeWorkspaceChanges(unchanged)).toBe(
      "工作目录改动：无（工作目录文件太多，只对比了前一部分）",
    );
  });

  it("[BW-3] shortens long change lists in the model summary", () => {
    const after = {
      complete: true,
      entries: Array.from({ length: 25 }, (_, index) =>
        entry(`f${String(index).padStart(2, "0")}`),
      ),
    };
    const summary = summarizeWorkspaceChanges(
      diffWorkspaceSnapshots({ complete: true, entries: [] }, after),
    );
    expect(summary).toContain("f19 等 25 项");
    expect(summary).not.toContain("f20");
  });
});
