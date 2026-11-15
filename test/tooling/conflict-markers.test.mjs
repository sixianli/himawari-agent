import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConflictMarkers, scan } from "../../scripts/check-conflict-markers.mjs";

const conflicted = [
  "keep",
  "<<<<<<< HEAD",
  "ours",
  "=======",
  "theirs",
  ">>>>>>> origin/main",
  "keep",
].join("\n");

describe("conflict markers left in tracked files", () => {
  it("finds a complete marker block and reports where it starts and ends", () => {
    expect(findConflictMarkers(conflicted)).toEqual([{ start: 2, end: 6 }]);
  });

  it("finds every block when a file has several", () => {
    expect(findConflictMarkers(`${conflicted}\n${conflicted}`)).toHaveLength(2);
  });

  it("ignores a lone separator line, an indented marker and a start line with no end", () => {
    expect(findConflictMarkers("a\n=======\nb")).toEqual([]);
    expect(findConflictMarkers("  <<<<<<< HEAD\n  >>>>>>> x")).toEqual([]);
    expect(findConflictMarkers("<<<<<<< HEAD\nonly the start")).toEqual([]);
  });

  it("fails a file with markers, passes a clean file and skips binary files", () => {
    const files = new Map([
      ["bad.swift", Buffer.from(conflicted)],
      ["good.swift", Buffer.from("let x = 1\n")],
      ["image.png", Buffer.from([0, 1, ...Buffer.from(conflicted)])],
    ]);
    const failures = scan([...files.keys()], (path) => files.get(path));
    expect(failures).toEqual([{ path: "bad.swift", start: 2, end: 6 }]);
  });

  it("rethrows a read error other than a missing file", () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(() =>
      scan(["a"], () => {
        throw denied;
      }),
    ).toThrow("denied");
  });

  it("makes the command exit 1 on a committed CRLF block and 0 once it is removed", () => {
    const repo = mkdtempSync(join(tmpdir(), "markers-"));
    cpSync("scripts/check-conflict-markers.mjs", join(repo, "scripts/check-conflict-markers.mjs"));
    writeFileSync(join(repo, "bad.swift"), conflicted.replaceAll("\n", "\r\n"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["add", "."], { cwd: repo });
    const run = () =>
      spawnSync("node", ["scripts/check-conflict-markers.mjs"], { cwd: repo, encoding: "utf8" });
    expect(run().stderr).toContain("CONFLICT_MARKERS_LEFT bad.swift:2-6");
    writeFileSync(join(repo, "bad.swift"), "let x = 1\n");
    expect(run().status).toBe(0);
  });
});
