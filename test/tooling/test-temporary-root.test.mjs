import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";

let root;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "temporary-root-")));
});
afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe("shared test temporary root", () => {
  it("preserves the short /tmp default instead of the operating system temporary directory", () => {
    expect(testTemporaryRoot({})).toBe("/tmp");
  });

  it.each(["", "relative/path"])("rejects a non-absolute root: %s", (value) => {
    expect(() => testTemporaryRoot({ HIMAWARI_TEST_TEMP_ROOT: value })).toThrow(/absolute/);
  });

  it("rejects a missing directory without creating it", () => {
    expect(() =>
      testTemporaryRoot({ HIMAWARI_TEST_TEMP_ROOT: path.join(root, "missing") }),
    ).toThrow(/does not exist/);
  });

  it("rejects a regular file", () => {
    const file = path.join(root, "file");
    writeFileSync(file, "unchanged");
    expect(() => testTemporaryRoot({ HIMAWARI_TEST_TEMP_ROOT: file })).toThrow(/directory/);
    expect(readFileSync(file, "utf8")).toBe("unchanged");
  });

  it("rejects symlinks, including a symlink in a parent component", () => {
    const actual = path.join(root, "actual");
    mkdirSync(path.join(actual, "child"), { recursive: true });
    const link = path.join(root, "link");
    symlinkSync(actual, link);
    for (const value of [link, path.join(link, "child"), `${actual}/../actual`])
      expect(() => testTemporaryRoot({ HIMAWARI_TEST_TEMP_ROOT: value })).toThrow(/realpath/);
  });

  it("rejects a directory that the current user cannot write", () => {
    chmodSync(root, 0o500);
    expect(() => testTemporaryRoot({ HIMAWARI_TEST_TEMP_ROOT: root })).toThrow(/writable/);
  });

  it("allocates a real directory and file under the supplied root", () => {
    const selected = testTemporaryRoot({ HIMAWARI_TEST_TEMP_ROOT: root });
    expect(selected).toBe(root);
    const directory = mkdtempSync(path.join(selected, "fixture-"));
    writeFileSync(path.join(directory, "readback"), "inside explicit root");
    expect(path.dirname(realpathSync(directory))).toBe(root);
    expect(readFileSync(path.join(directory, "readback"), "utf8")).toBe("inside explicit root");
  });
});
