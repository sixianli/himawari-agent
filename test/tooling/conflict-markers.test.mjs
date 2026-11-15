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
});
