import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildInfo } from "../../apps/control-center/build-info.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function directory(commit) {
  const root = mkdtempSync(path.join(tmpdir(), "build-info-"));
  directories.push(root);
  if (!commit) return root;
  const git = (...args) =>
    execFileSync(
      "git",
      ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      {
        env: { ...process.env, GIT_COMMITTER_DATE: "2026-11-02T00:00:00Z" },
      },
    );
  git("init", "-q");
  writeFileSync(path.join(root, "a"), "a");
  git("add", "a");
  git("commit", "-q", "-m", "a", "--date", "2026-11-02T00:00:00Z");
  return root;
}

describe("[UI-S3] build information baked into the browser build", () => {
  it("takes the revision and date from the build environment when given", () => {
    expect(
      resolveBuildInfo(
        { HIMAWARI_BUILD_REVISION: "abcdef1", HIMAWARI_BUILD_DATE: "2026-11-02" },
        directory(false),
      ),
    ).toEqual({ revision: "abcdef1", date: "2026-11-02" });
  });
  it("reads the checkout when the environment says nothing, and falls back to it when the environment values are malformed", () => {
    const root = directory(true);
    for (const environment of [
      {},
      { HIMAWARI_BUILD_REVISION: "not-a-hash", HIMAWARI_BUILD_DATE: "2026-11-02" },
      { HIMAWARI_BUILD_REVISION: "abcdef1", HIMAWARI_BUILD_DATE: "yesterday" },
    ]) {
      const info = resolveBuildInfo(environment, root);
      expect(info?.revision).toMatch(/^[0-9a-f]{7,40}$/);
      expect(info?.date).toBe("2026-11-02");
    }
  });
  it("returns nothing, rather than a made-up value, when neither source is usable", () => {
    expect(resolveBuildInfo({}, directory(false))).toBeNull();
    expect(
      resolveBuildInfo(
        { HIMAWARI_BUILD_REVISION: "not-a-hash", HIMAWARI_BUILD_DATE: "2026-11-02" },
        directory(false),
      ),
    ).toBeNull();
  });
});
