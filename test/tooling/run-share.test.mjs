import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collect,
  get,
  main,
  publishedMembers,
  put,
  remove,
  runName,
  shareRoot,
  treeDigest,
} from "../../scripts/ci/run-share.mjs";

let base;
let root;
const run = "7-1";
const tree = (name, files) => {
  const directory = path.join(base, name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  }
  return directory;
};

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "run-share-"));
  root = path.join(base, "share");
  mkdirSync(root);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("job 之间经 CI 服务器传文件", () => {
  it("放进去的目录按名字和摘要原样取回，目录给同组可写", async () => {
    const from = tree("from", { "result.json": "{}", "a/b.txt": "x" });
    const digest = await put({ root, run, name: "build-linux-x64", from });
    expect(digest).toBe(await treeDigest(from));
    const stored = path.join(root, run, "build-linux-x64");
    expect(statSync(path.join(root, run)).mode & 0o7777).toBe(0o2770);
    expect(statSync(path.join(stored, "a")).mode & 0o7777).toBe(0o2770);
    expect(statSync(path.join(stored, "a/b.txt")).mode & 0o777).toBe(0o660);
    expect(readdirSync(path.join(root, run))).toEqual(["build-linux-x64"]);
    const to = path.join(base, "to");
    await get({ root, run, name: "build-linux-x64", digest, to });
    expect(readFileSync(path.join(to, "a/b.txt"), "utf8")).toBe("x");
  });

  it("同名再放一次、名字不合规、目录为空、含链接时拒绝", async () => {
    const from = tree("from", { "r.json": "1" });
    await put({ root, run, name: "static-default", from });
    await expect(put({ root, run, name: "static-default", from })).rejects.toThrow(
      "CI_SHARE_ALREADY_PUBLISHED",
    );
    for (const name of ["../x", "Static", "", "a/b", "-a"])
      await expect(put({ root, run, name, from })).rejects.toThrow("CI_SHARE_NAME_INVALID");
    mkdirSync(path.join(base, "empty"));
    await expect(put({ root, run, name: "empty", from: path.join(base, "empty") })).rejects.toThrow(
      "CI_SHARE_EMPTY",
    );
    const linked = tree("linked", { "r.json": "1" });
    symlinkSync("/etc/passwd", path.join(linked, "leak"));
    await expect(put({ root, run, name: "linked", from: linked })).rejects.toThrow(
      "ARTIFACT_LINK_FORBIDDEN",
    );
    expect(existsSync(path.join(root, run, "linked"))).toBe(false);
  });

  it("内容被改、摘要不对、目录不存在、目标已存在时取回失败且不留半份文件", async () => {
    const from = tree("from", { "r.json": "1" });
    const digest = await put({ root, run, name: "build-linux-x64", from });
    writeFileSync(path.join(root, run, "build-linux-x64/r.json"), "2");
    const to = path.join(base, "to");
    await expect(get({ root, run, name: "build-linux-x64", digest, to })).rejects.toThrow(
      "CI_SHARE_DIGEST_MISMATCH:build-linux-x64",
    );
    expect(existsSync(to)).toBe(false);
    await expect(get({ root, run, name: "build-linux-x64", digest: "nothex", to })).rejects.toThrow(
      "CI_SHARE_DIGEST_INVALID",
    );
    await expect(get({ root, run, name: "missing", digest, to })).rejects.toThrow(
      "CI_SHARE_MISSING:missing",
    );
    mkdirSync(to);
    writeFileSync(path.join(root, run, "build-linux-x64/r.json"), "1");
    await expect(get({ root, run, name: "build-linux-x64", digest, to })).rejects.toThrow(
      "CI_SHARE_DESTINATION_EXISTS",
    );
  });

  it("复制后核对出错时也不留下半份文件", async () => {
    const digest = await put({
      root,
      run,
      name: "build-linux-x64",
      from: tree("from", { r: "1" }),
    });
    symlinkSync("/etc/passwd", path.join(root, run, "build-linux-x64/leak"));
    const to = path.join(base, "to");
    await expect(get({ root, run, name: "build-linux-x64", digest, to })).rejects.toThrow(
      "ARTIFACT_LINK_FORBIDDEN",
    );
    expect(existsSync(to)).toBe(false);
  });

  it("汇总只收 needs 里给出摘要的成员，缺的逐个列出，不因一个缺失而中断", async () => {
    const digest = await put({ root, run, name: "static-default", from: tree("s", { r: "1" }) });
    const needs = {
      static: { result: "success", outputs: { default: digest } },
      browser: { result: "failure", outputs: { chromium: "f".repeat(64), firefox: "" } },
      policy: { result: "cancelled", outputs: {} },
    };
    expect(publishedMembers(needs)).toEqual([
      { job: "browser", name: "browser-chromium", digest: "f".repeat(64) },
      { job: "static", name: "static-default", digest },
    ]);
    const to = path.join(base, "reports");
    const result = await collect({ root, run, needs, to });
    expect(result).toEqual({
      collected: 1,
      pulled: 0,
      missing: ["CI_SHARE_MISSING:browser-chromium"],
    });
    expect(readFileSync(path.join(to, "static-default/r"), "utf8")).toBe("1");
    expect(await collect({ root, run: "8-1", needs: {}, to: path.join(base, "none") })).toEqual({
      collected: 0,
      pulled: 0,
      missing: [],
    });
  });

  it("删除只删本次运行，不碰别的运行", async () => {
    await put({ root, run, name: "a", from: tree("a", { r: "1" }) });
    await put({ root, run: "7-2", name: "a", from: tree("b", { r: "1" }) });
    remove({ root, run });
    expect(readdirSync(root)).toEqual(["7-2"]);
  });

  it("根目录、运行号必须可信", () => {
    expect(() => shareRoot({})).toThrow("CI_SHARE_ROOT_REQUIRED");
    expect(() => shareRoot({ HIMAWARI_CI_SHARE: "relative" })).toThrow("CI_SHARE_ROOT_REQUIRED");
    expect(() => shareRoot({ HIMAWARI_CI_SHARE: path.join(base, "nope") })).toThrow(
      "CI_SHARE_ROOT_INVALID",
    );
    symlinkSync(root, path.join(base, "alias"));
    expect(() => shareRoot({ HIMAWARI_CI_SHARE: path.join(base, "alias") })).toThrow(
      "CI_SHARE_ROOT_INVALID",
    );
    expect(shareRoot({ HIMAWARI_CI_SHARE: root })).toBe(root);
    expect(runName({ GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "3" })).toBe("9-3");
    for (const [id, attempt] of [
      ["0", "1"],
      ["9/..", "1"],
      ["9", ""],
      ["9", "1\nx"],
    ])
      expect(() => runName({ GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: attempt })).toThrow(
        /CI_SHARE_RUN_(ID|ATTEMPT)_INVALID/u,
      );
  });

  it("命令行在另一个进程的 umask 下也建出同组可写的运行目录，并恢复原 umask", async () => {
    const env = {
      HIMAWARI_CI_SHARE: root,
      GITHUB_RUN_ID: "5",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: path.join(base, "out"),
    };
    const previous = process.umask(0o022);
    try {
      const from = tree("from", { r: "1" });
      const line = await main(
        ["put", "--name", "coverage-default", "--from", from, "--output-key", "default"],
        env,
      );
      expect(line).toMatch(/^CI_SHARE_PUT coverage-default [0-9a-f]{64}$/u);
      expect(statSync(path.join(root, "5-1")).mode & 0o7777).toBe(0o2770);
      expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toMatch(/^default=[0-9a-f]{64}\n$/u);
      expect(process.umask()).toBe(0o022);
      await expect(main(["bogus"], env)).rejects.toThrow("CI_SHARE_COMMAND_INVALID");
      await expect(main(["put", "--from", from], env)).rejects.toThrow(
        "CI_SHARE_PUT_INPUT_REQUIRED",
      );
      await expect(main(["collect", "--to", path.join(base, "c")], env)).rejects.toThrow(
        "CI_SHARE_COLLECT_INPUT_REQUIRED",
      );
      const errors = [];
      const write = process.stderr.write;
      process.stderr.write = (text) => errors.push(String(text));
      try {
        const needs = { browser: { outputs: { chromium: "a".repeat(64) } } };
        const summary = await main(["collect", "--to", path.join(base, "c")], {
          ...env,
          CI_NEEDS: JSON.stringify(needs),
        });
        expect(summary).toBe("CI_SHARE_COLLECT 0\nCI_SHARE_MISSING:browser-chromium");
      } finally {
        process.stderr.write = write;
      }
      expect(errors).toEqual(["CI_SHARE_COLLECT_MISSING CI_SHARE_MISSING:browser-chromium\n"]);
    } finally {
      process.umask(previous);
    }
  });
});
