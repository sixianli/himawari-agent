import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findConflictMarkers,
  scan,
  trackedTextFiles,
} from "../../scripts/check-conflict-markers.mjs";

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

  it("skips a tracked file that is gone from the work tree but rethrows other read errors", () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(
      scan(["gone.swift"], () => {
        throw missing;
      }),
    ).toEqual([]);
    expect(() =>
      scan(["locked.swift"], () => {
        throw denied;
      }),
    ).toThrow("denied");
  });

  it("lists tracked files of this repository and finds no markers in them", () => {
    const paths = trackedTextFiles();
    expect(paths.length).toBeGreaterThan(0);
    expect(scan(paths)).toEqual([]);
  });

  it("makes the command exit 1 on a committed marker block and 0 once it is removed", () => {
    const repo = mkdtempSync(join(tmpdir(), "conflict-markers-"));
    try {
      mkdirSync(join(repo, "scripts"));
      mkdirSync(join(repo, ".agents", "reviews"), { recursive: true });
      copyFileSync(
        new URL("../../scripts/check-conflict-markers.mjs", import.meta.url),
        join(repo, "scripts", "check-conflict-markers.mjs"),
      );
      writeFileSync(join(repo, "bad.swift"), conflicted.replaceAll("\n", "\r\n"));
      writeFileSync(join(repo, ".agents", "reviews", "answer.md"), conflicted);
      const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      git("init", "-q");
      git("add", ".");
      const run = () =>
        spawnSync("node", ["scripts/check-conflict-markers.mjs"], { cwd: repo, encoding: "utf8" });
      const failed = run();
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("CONFLICT_MARKERS_LEFT bad.swift:2-6");
      expect(failed.stderr).not.toContain("answer.md");
      writeFileSync(join(repo, "bad.swift"), "let x = 1\n");
      const passed = run();
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain("CONFLICT_MARKERS_NONE");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
