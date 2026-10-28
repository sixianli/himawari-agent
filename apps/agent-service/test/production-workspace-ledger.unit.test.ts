import { createHash } from "node:crypto";
import type {
  HostDirectoryGrant,
  HostReadOnlyPort,
  HostWorkspaceSnapshot,
  HostWorkspaceSnapshotPort,
} from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import {
  createProductionWorkspaceLedger,
  WORKSPACE_LEDGER_HASH_LIMIT_BYTES,
} from "../src/production-workspace-ledger.js";

const grant = { id: "directory:test" } as HostDirectoryGrant;

function port(snapshots: HostWorkspaceSnapshot[], files: Record<string, string>) {
  const readFile = vi.fn(async (input: { relativePath: string; maximumBytes: number }) => {
    const content = files[input.relativePath];
    if (content === undefined) throw new Error("HOST_READ_TARGET_MISSING");
    return new TextEncoder().encode(content);
  });
  const value = {
    available: true,
    listDirectory: vi.fn(),
    inspectEntry: vi.fn(),
    readFile,
    snapshotWorkspace: vi.fn(async () => {
      const next = snapshots.shift();
      if (!next) throw new Error("no snapshot");
      return next;
    }),
  } as unknown as HostReadOnlyPort & HostWorkspaceSnapshotPort;
  return { value, readFile };
}

const file = (path: string, size: string, modifiedAtNs: string) => ({
  path,
  kind: "file" as const,
  size,
  modifiedAtNs,
  inode: path,
});

describe("production workspace ledger", () => {
  it("[BW-3] hashes only created and modified files and keeps size and time for deletions", async () => {
    const { value, readFile } = port(
      [
        {
          complete: true,
          entries: [file("keep", "1", "1"), file("edit", "1", "1"), file("gone", "2", "2")],
        },
        {
          complete: true,
          entries: [file("keep", "1", "1"), file("edit", "3", "5"), file("new", "2", "6")],
        },
      ],
      { edit: "abc", new: "hi" },
    );
    const ledger = createProductionWorkspaceLedger({ port: value, warn: () => {} });
    const record = await ledger.record(grant, await ledger.baseline(grant));
    expect(readFile.mock.calls.map(([input]) => input.relativePath).sort()).toEqual([
      "edit",
      "new",
    ]);
    expect(readFile.mock.calls[0]?.[0].maximumBytes).toBe(WORKSPACE_LEDGER_HASH_LIMIT_BYTES);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(record.changes).toEqual([
      {
        path: "edit",
        kind: "file",
        change: "modified",
        before: { size: "1", modifiedAtNs: "1" },
        after: { size: "3", modifiedAtNs: "5", sha256: sha("abc") },
      },
      {
        path: "gone",
        kind: "file",
        change: "deleted",
        before: { size: "2", modifiedAtNs: "2" },
        after: null,
      },
      {
        path: "new",
        kind: "file",
        change: "created",
        before: null,
        after: { size: "2", modifiedAtNs: "6", sha256: sha("hi") },
      },
    ]);
    expect(record.summary).toBe("工作目录改动：新建 new；修改 edit；删除 gone");
  });

  it("[BW-3] records a null digest for a file it cannot read and warns about slow scans", async () => {
    const { value } = port(
      [
        { complete: true, entries: [] },
        { complete: true, entries: [file("big", "9", "9")] },
      ],
      {},
    );
    const times = [0, 250, 1000, 1010];
    const warn = vi.fn();
    const ledger = createProductionWorkspaceLedger({
      port: value,
      now: () => times.shift() ?? 0,
      warn,
    });
    const record = await ledger.record(grant, await ledger.baseline(grant));
    expect(record.changes[0]?.after).toMatchObject({ sha256: null });
    expect(record.beforeScanMs).toBe(250);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "workspace.ledger.scan",
      durationMs: 250,
    });
  });
  it("leaves out the empty mount points the sandbox runtime places in the workspace", async () => {
    const directory = (path: string, modifiedAtNs: string) => ({
      path,
      kind: "directory" as const,
      size: "0",
      modifiedAtNs,
      inode: path,
    });
    const { value } = port(
      [
        { complete: true, entries: [file("keep", "1", "1")] },
        {
          complete: true,
          entries: [
            file("keep", "1", "1"),
            file(".bashrc", "0", "2"),
            file(".gitconfig", "0", "2"),
            file(".mcp.json", "0", "2"),
            file(".idea", "0", "2"),
            file(".vscode", "0", "2"),
            directory(".claude", "2"),
            file("snake.html", "2", "3"),
            file("sub/.bashrc", "2", "3"),
          ],
        },
      ],
      { "snake.html": "hi", "sub/.bashrc": "hi" },
    );
    const ledger = createProductionWorkspaceLedger({ port: value, warn: () => {} });
    const record = await ledger.record(grant, await ledger.baseline(grant));
    expect(record.changes.map(({ path }) => path)).toEqual(["snake.html", "sub/.bashrc"]);
    expect(record.summary).toBe("工作目录改动：新建 snake.html、sub/.bashrc");
  });
});
