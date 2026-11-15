import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const apple = join(repositoryRoot, "clients/apple");

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "apple-xcode-cache-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "xcodebuild"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_XCODEBUILD_ARGS"\n[ -z "$FAKE_XCODEBUILD_SLEEP" ] || sleep "$FAKE_XCODEBUILD_SLEEP"\n',
  );
  chmodSync(join(bin, "xcodebuild"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HIMAWARI_APPLE_CACHE: join(root, "cache"),
    HIMAWARI_XCODE_LOCK_WAIT: "0",
    FAKE_XCODEBUILD_ARGS: join(root, "args.txt"),
  };
  return { root, env };
}

function build(env, ...args) {
  const child = spawnSync(join(apple, "scripts/xcode-build.sh"), args, { env, encoding: "utf8" });
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

describe("Xcode build cache (ADR 0276)", () => {
  it("builds into one fixed cache per platform outside the repository and releases the lock", () => {
    const { root, env } = sandbox();
    const result = build(env, "ios", "-scheme", "Himawari", "build");
    expect(result.status).toBe(0);
    const derived = join(root, "cache/DerivedData/ios");
    expect(result.output).toContain(`XCODE_BUILD_DERIVED_DATA ${derived}`);
    expect(readFileSync(env.FAKE_XCODEBUILD_ARGS, "utf8").split("\n")).toEqual([
      "-derivedDataPath",
      derived,
      "-scheme",
      "Himawari",
      "build",
      "",
    ]);
    expect(existsSync(join(derived, ".himawari-last-used"))).toBe(true);
    expect(existsSync(`${derived}.lock`)).toBe(false);
    expect(build(env, "ios", "build").status).toBe(0);
  });

  it("refuses a caller-chosen -derivedDataPath and an unknown platform", () => {
    const { env } = sandbox();
    expect(build(env, "ios", "-derivedDataPath", "/tmp/dd-518-ios", "build").output).toContain(
      "XCODE_BUILD_DERIVED_DATA_GIVEN",
    );
    const joined = build(env, "ios", "-derivedDataPath=/tmp/dd-518-ios", "build");
    expect(joined.status).toBe(2);
    expect(joined.output).toContain("XCODE_BUILD_DERIVED_DATA_GIVEN");
    const unknown = build(env, "tvos", "build");
    expect(unknown.status).not.toBe(0);
    expect(unknown.output).toContain("XCODE_CACHE_PLATFORM_INVALID tvos");
  });

  it("makes a second build of the same platform wait while the first one holds the cache", async () => {
    const { env } = sandbox();
    const first = spawn(join(apple, "scripts/xcode-build.sh"), ["mac", "build"], {
      env: { ...env, FAKE_XCODEBUILD_SLEEP: "3" },
    });
    const lock = join(env.HIMAWARI_APPLE_CACHE, "DerivedData/mac.lock");
    for (let tries = 0; tries < 50 && !existsSync(lock); tries += 1)
      await new Promise((done) => setTimeout(done, 50));
    expect(existsSync(lock)).toBe(true);
    const second = build(env, "mac", "build");
    expect(second.status).not.toBe(0);
    expect(second.output).toContain("XCODE_CACHE_LOCK_TIMEOUT");
    expect(build(env, "ios", "build").status).toBe(0);
    await new Promise((done) => first.on("exit", done));
    expect(build(env, "mac", "build").status).toBe(0);
  });

  it("takes over a lock left by a build that no longer runs", () => {
    const { env } = sandbox();
    const lock = join(env.HIMAWARI_APPLE_CACHE, "DerivedData/watch.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "999999\n");
    expect(build(env, "watch", "build").status).toBe(0);
  });
});

describe("ui-review.sh --approve (ADR 0276)", () => {
  function approveFixture() {
    const { root, env } = sandbox();
    const copy = join(root, "apple");
    mkdirSync(join(copy, "Sources/HimawariShell"), { recursive: true });
    cpSync(join(apple, "scripts"), join(copy, "scripts"), { recursive: true });
    writeFileSync(
      join(copy, "Sources/HimawariShell/DemoScenes.swift"),
      'enum DemoScene: String {\n    case today = "01-today"\n    case chat = "03-chat"\n    case shimmer = "motion-shimmer"\n}\n',
    );
    const snapshots = join(copy, "Tests/Snapshots/iPhone-390");
    mkdirSync(snapshots, { recursive: true });
    for (const name of [
      "01-today-light.png",
      "01-today-dark.png",
      "03-chat-light.png",
      "03-chat-dark.png",
    ])
      writeFileSync(join(snapshots, name), "old");
    const out = join(root, "shots");
    mkdirSync(out);
    return { env, copy, snapshots, out };
  }

  function approve(fixture) {
    const child = spawnSync(
      join(fixture.copy, "scripts/ui-review.sh"),
      ["--approve", "--out", fixture.out],
      {
        env: fixture.env,
        encoding: "utf8",
      },
    );
    return { status: child.status, output: `${child.stdout}${child.stderr}` };
  }

  it("replaces every snapshot at once when the new batch is complete", () => {
    const fixture = approveFixture();
    for (const name of [
      "01-today-light.png",
      "01-today-dark.png",
      "03-chat-light.png",
      "03-chat-dark.png",
    ])
      writeFileSync(join(fixture.out, name), "new");
    const result = approve(fixture);
    expect(result.status).toBe(0);
    expect(result.output).toContain("UI_REVIEW_APPROVED 4 snapshots");
    expect(readFileSync(join(fixture.snapshots, "03-chat-dark.png"), "utf8")).toBe("new");
    expect(readdirSync(dirname(fixture.snapshots)).sort()).toEqual(["iPhone-390"]);
  });

  it("leaves the old snapshots untouched when the new batch is missing a scene", () => {
    const fixture = approveFixture();
    writeFileSync(join(fixture.out, "01-today-light.png"), "new");
    const result = approve(fixture);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("UI_REVIEW_FAILED");
    expect(readFileSync(join(fixture.snapshots, "01-today-light.png"), "utf8")).toBe("old");
    expect(readdirSync(fixture.snapshots)).toHaveLength(4);
  });
});
