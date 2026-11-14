import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseRemoteReport,
  pullRemoteReport,
  REMOTE_LIMITS,
  remoteShareConfig,
  sshArguments,
} from "../../scripts/ci/remote-share.mjs";
import { collect, main, treeDigest } from "../../scripts/ci/run-share.mjs";

const senderSource = path.resolve(
  import.meta.dirname,
  "../../scripts/operations/ci-runner/send-reports.py",
);
const run = "43003101968-1";
let base;
let armShare;
let vpsShare;
let sender;
let config;

const write = (root, files) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
};
const armReport = (name, files) => write(path.join(armShare, run, name), files);
const send = (request) =>
  spawnSync("python3", ["-I", sender], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: request },
    maxBuffer: 256 * 1024 * 1024,
  });
const fakeSsh = (body) => {
  const file = path.join(base, `ssh-${Math.random().toString(16).slice(2)}`);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};
const sshThroughSender = () =>
  fakeSsh(
    `printf '%s\\n' "$*" >> "${base}/ssh-calls"\nSSH_ORIGINAL_COMMAND="\${@: -1}" exec python3 -I "${sender}"`,
  );
const answering = (value, status = 0) =>
  fakeSsh(`cat <<'JSON'\n${JSON.stringify(value)}\nJSON\nexit ${status}`);
const encoded = (text) => Buffer.from(text).toString("base64");

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "remote-share-"));
  armShare = path.join(base, "arm-share");
  vpsShare = path.join(base, "vps-share");
  mkdirSync(armShare);
  mkdirSync(vpsShare);
  sender = path.join(base, "send-reports");
  writeFileSync(sender, readFileSync(senderSource, "utf8").replaceAll("@SHARE@", armShare));
  const directory = write(path.join(base, "remote-share"), {
    target: "gh-ci-send@192.0.2.7\n",
    id_ed25519: "key",
    known_hosts: "192.0.2.7 ssh-ed25519 AAAA\n",
  });
  config = remoteShareConfig({ HIMAWARI_CI_REMOTE_SHARE: directory });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("ARM 机器上的发送脚本只按固定名字交出普通文件", () => {
  it("把一份报告目录里的普通文件连同子目录打成一段 JSON", () => {
    armReport("policy-default", { "result.json": "{}", "logs/a.txt": "x" });
    const result = send(`${run}/policy-default`);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      run,
      name: "policy-default",
      files: [
        { path: "logs/a.txt", data: encoded("x") },
        { path: "result.json", data: encoded("{}") },
      ],
    });
  });

  it.each([
    "",
    "policy-default",
    `${run}/../${run}/policy-default`,
    `${run}/policy-default/result.json`,
    `${run}/Policy`,
    `0-1/policy-default`,
    `${run}/policy-default; cat /etc/passwd`,
    `/etc/passwd`,
  ])("拒绝不是“运行号-重试号/报告名”的请求：%s", (request) => {
    armReport("policy-default", { "result.json": "{}" });
    const result = send(request);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ error: "REQUEST_INVALID" });
  });

  it("不存在的运行或报告回答 MISSING，报告名是符号链接时也一样", () => {
    expect(JSON.parse(send(`${run}/policy-default`).stdout)).toEqual({ error: "MISSING" });
    armReport("static-default", { "result.json": "{}" });
    symlinkSync(path.join(armShare, run, "static-default"), path.join(armShare, run, "linked"));
    const result = send(`${run}/linked`);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ error: "MISSING" });
  });

  it("目录里有符号链接、硬链接或管道时整份拒绝，不读它指向的内容", () => {
    const report = armReport("policy-default", { "result.json": "{}" });
    symlinkSync("/etc/passwd", path.join(report, "leak"));
    expect(JSON.parse(send(`${run}/policy-default`).stdout)).toEqual({ error: "ENTRY_TYPE" });
    rmSync(path.join(report, "leak"));
    linkSync(path.join(report, "result.json"), path.join(report, "twin.json"));
    expect(JSON.parse(send(`${run}/policy-default`).stdout)).toEqual({ error: "ENTRY_TYPE" });
    rmSync(path.join(report, "twin.json"));
    expect(spawnSync("mkfifo", [path.join(report, "pipe")]).status).toBe(0);
    expect(JSON.parse(send(`${run}/policy-default`).stdout)).toEqual({ error: "ENTRY_TYPE" });
  });

  it("文件数、单个文件大小、合计大小、目录层数超限和空目录都拒绝", () => {
    const many = armReport("many", {});
    mkdirSync(many, { recursive: true });
    for (let index = 0; index <= 500; index += 1) writeFileSync(path.join(many, `f${index}`), "");
    expect(JSON.parse(send(`${run}/many`).stdout)).toEqual({ error: "TOO_MANY_FILES" });

    armReport("large", { big: Buffer.alloc(16 * 1024 * 1024 + 1) });
    expect(JSON.parse(send(`${run}/large`).stdout)).toEqual({ error: "FILE_TOO_LARGE" });

    const chunk = Buffer.alloc(16 * 1024 * 1024);
    armReport("total", { a: chunk, b: chunk, c: chunk, d: chunk, e: "x" });
    expect(JSON.parse(send(`${run}/total`).stdout)).toEqual({ error: "TOTAL_TOO_LARGE" });

    armReport("deep", { "1/2/3/4/5/6/7/8/file": "x" });
    expect(JSON.parse(send(`${run}/deep`).stdout)).toEqual({ error: "TOO_DEEP" });

    mkdirSync(path.join(armShare, run, "empty"), { recursive: true });
    expect(JSON.parse(send(`${run}/empty`).stdout)).toEqual({ error: "EMPTY" });
  });
});

describe("汇总作业从 ARM 机器取报告", () => {
  it("配置目录不存在时没有远端；有目录就要求地址、钥匙和主机密钥三样齐全", () => {
    expect(remoteShareConfig({ HIMAWARI_CI_REMOTE_SHARE: path.join(base, "nope") })).toBe(
      undefined,
    );
    expect(() => remoteShareConfig({ HIMAWARI_CI_REMOTE_SHARE: "relative" })).toThrow(
      "CI_REMOTE_SHARE_DIRECTORY_INVALID",
    );
    const directory = path.join(base, "remote-share");
    rmSync(path.join(directory, "known_hosts"));
    expect(() => remoteShareConfig({ HIMAWARI_CI_REMOTE_SHARE: directory })).toThrow(
      "CI_REMOTE_SHARE_CONFIG_MISSING:known_hosts",
    );
    write(directory, { known_hosts: "x", target: "gh-ci-send@192.0.2.7 -oProxyCommand=id\n" });
    expect(() => remoteShareConfig({ HIMAWARI_CI_REMOTE_SHARE: directory })).toThrow(
      "CI_REMOTE_SHARE_TARGET_INVALID",
    );
  });

  it("ssh 固定主机密钥、只用这一把钥匙、不读任何 ssh 配置，请求是最后一个参数", () => {
    const args = sshArguments(config, `${run}/policy-default`);
    expect(args.slice(0, 2)).toEqual(["-F", "none"]);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain(`UserKnownHostsFile=${config.knownHosts}`);
    expect(args).toContain("GlobalKnownHostsFile=/dev/null");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain(`ConnectTimeout=${REMOTE_LIMITS.connectSeconds}`);
    expect(args.slice(-2)).toEqual(["gh-ci-send@192.0.2.7", `${run}/policy-default`]);
  });

  it("本机共享目录里没有的报告从 ARM 取回，按摘要核对后交给汇总", async () => {
    const report = armReport("policy-default", { "result.json": '{"ok":true}', "logs/a.txt": "x" });
    const digest = await treeDigest(report);
    const needs = { policy: { result: "success", outputs: { default: digest } } };
    const to = path.join(base, "reports");
    const result = await collect({
      root: vpsShare,
      run,
      needs,
      to,
      remote: {
        jobs: ["policy"],
        config,
        pull: (input) => pullRemoteReport({ ...input, command: sshThroughSender() }),
      },
    });
    expect(result).toEqual({ collected: 1, pulled: 1, missing: [] });
    expect(readFileSync(path.join(to, "policy-default/logs/a.txt"), "utf8")).toBe("x");
    expect(readdirSync(path.join(vpsShare, run))).toEqual(["policy-default"]);
    expect(readFileSync(path.join(base, "ssh-calls"), "utf8")).toMatch(
      new RegExp(` gh-ci-send@192\\.0\\.2\\.7 ${run}/policy-default\n$`),
    );
  });

  it("本机已有的报告不去远端取；不在名单里的作业也不取", async () => {
    const local = write(path.join(base, "local"), { "result.json": "{}" });
    const digest = await treeDigest(local);
    write(path.join(vpsShare, run, "policy-default"), { "result.json": "{}" });
    const pull = () => {
      throw new Error("must not pull");
    };
    const needs = {
      policy: { result: "success", outputs: { default: digest } },
      build: { result: "success", outputs: { "linux-x64": "a".repeat(64) } },
    };
    const result = await collect({
      root: vpsShare,
      run,
      needs,
      to: path.join(base, "reports"),
      remote: { jobs: ["policy"], config, pull },
    });
    expect(result).toEqual({
      collected: 1,
      pulled: 0,
      missing: ["CI_SHARE_MISSING:build-linux-x64"],
    });
  });

  it("途中被改的报告摘要对不上，汇总缺这一份，不会被当成通过", async () => {
    const report = armReport("policy-default", { "result.json": '{"ok":true}' });
    const digest = await treeDigest(report);
    writeFileSync(path.join(report, "result.json"), '{"ok":false}');
    const to = path.join(base, "reports");
    const result = await collect({
      root: vpsShare,
      run,
      needs: { policy: { result: "success", outputs: { default: digest } } },
      to,
      remote: {
        jobs: ["policy"],
        config,
        pull: (input) => pullRemoteReport({ ...input, command: sshThroughSender() }),
      },
    });
    expect(result.collected).toBe(0);
    expect(result.missing).toEqual(["CI_SHARE_DIGEST_MISMATCH:policy-default"]);
    expect(existsSync(path.join(to, "policy-default"))).toBe(false);
  });

  it("没装远端配置、ARM 回答没有这份报告、ssh 连不上，都记成缺失", async () => {
    const needs = { policy: { result: "success", outputs: { default: "b".repeat(64) } } };
    const attempt = (remote) =>
      collect({ root: vpsShare, run, needs, to: path.join(base, `r${Math.random()}`), remote });
    expect((await attempt({ jobs: ["policy"], config: undefined })).missing).toEqual([
      "CI_SHARE_REMOTE_NOT_CONFIGURED:policy-default",
    ]);
    const through = (command) => ({
      jobs: ["policy"],
      config,
      pull: (input) => pullRemoteReport({ ...input, command }),
    });
    expect((await attempt(through(sshThroughSender()))).missing).toEqual([
      "CI_REMOTE_SHARE_REFUSED:MISSING",
    ]);
    expect(
      (await attempt(through(fakeSsh("echo 'Host key verification failed.' >&2; exit 255"))))
        .missing,
    ).toEqual(["CI_REMOTE_SHARE_RESPONSE_INVALID:status=255"]);
    expect((await attempt(through(path.join(base, "no-such-ssh")))).missing).toEqual([
      "CI_REMOTE_SHARE_SSH_UNAVAILABLE",
    ]);
    expect(existsSync(path.join(vpsShare, run, "policy-default"))).toBe(false);
  });

  it("对端迟迟不答就在总时限到时掐断；回答超过上限也掐断", async () => {
    const pull = (command, limits) =>
      pullRemoteReport({
        config,
        root: vpsShare,
        run,
        name: "policy-default",
        command,
        limits: { ...REMOTE_LIMITS, ...limits },
      });
    await expect(pull(fakeSsh("sleep 30"), { totalMilliseconds: 200 })).rejects.toThrow(
      "CI_REMOTE_SHARE_TIMEOUT",
    );
    await expect(
      pull(fakeSsh("head -c 200000 /dev/zero"), { responseBytes: 1000 }),
    ).rejects.toThrow("CI_REMOTE_SHARE_RESPONSE_TOO_LARGE");
  });

  it.each([
    ["不是 JSON", "not json", "RESPONSE_INVALID"],
    ["运行号对不上", { run: "9-9", name: "policy-default", files: [] }, "RESPONSE_MISMATCH"],
    ["没有文件", { run, name: "policy-default", files: [] }, "RESPONSE_EMPTY"],
    [
      "路径往上跳",
      { run, name: "policy-default", files: [{ path: "../x", data: "" }] },
      "PATH_INVALID",
    ],
    [
      "绝对路径",
      { run, name: "policy-default", files: [{ path: "/etc/x", data: "" }] },
      "PATH_INVALID",
    ],
    [
      "同一路径出现两次",
      {
        run,
        name: "policy-default",
        files: [
          { path: "a", data: "" },
          { path: "a", data: "" },
        ],
      },
      "PATH_DUPLICATE",
    ],
    [
      "只差大小写的路径",
      {
        run,
        name: "policy-default",
        files: [
          { path: "a", data: "" },
          { path: "A", data: "" },
        ],
      },
      "PATH_DUPLICATE",
    ],
    [
      "一个路径既是文件又是目录",
      {
        run,
        name: "policy-default",
        files: [
          { path: "a", data: "" },
          { path: "a/b", data: "" },
        ],
      },
      "PATH_DUPLICATE",
    ],
    [
      "内容不是 base64",
      { run, name: "policy-default", files: [{ path: "a", data: "@@" }] },
      "DATA_INVALID",
    ],
  ])("回答%s时拒绝，共享目录里什么都不留", async (_label, answer, code) => {
    const command = typeof answer === "string" ? fakeSsh(`echo '${answer}'`) : answering(answer);
    await expect(
      pullRemoteReport({ config, root: vpsShare, run, name: "policy-default", command }),
    ).rejects.toThrow(`CI_REMOTE_SHARE_${code}`);
    expect(existsSync(path.join(vpsShare, run, "policy-default"))).toBe(false);
  });

  it("文件数、单个文件、合计大小超限时拒绝", () => {
    const parse = (files, limits) =>
      parseRemoteReport(
        { status: 0, body: JSON.stringify({ run, name: "policy-default", files }) },
        { run, name: "policy-default" },
        { ...REMOTE_LIMITS, ...limits },
      );
    const file = (name, text) => ({ path: name, data: encoded(text) });
    expect(() => parse([file("a", "1"), file("b", "2")], { files: 1 })).toThrow("TOO_MANY_FILES");
    expect(() => parse([file("a", "12345")], { fileBytes: 4 })).toThrow("FILE_TOO_LARGE");
    expect(() => parse([file("a", "123"), file("b", "456")], { totalBytes: 5 })).toThrow(
      "TOTAL_TOO_LARGE",
    );
    expect(parse([file("a", "123")], {})).toEqual([{ path: "a", bytes: Buffer.from("123") }]);
  });

  it("运行号和报告名不合规时不发起 ssh；目标已存在时不覆盖", async () => {
    const command = fakeSsh(`touch "${base}/called"`);
    for (const [badRun, badName] of [
      ["../x", "policy-default"],
      [run, "../x"],
      [run, "Policy"],
    ])
      await expect(
        pullRemoteReport({ config, root: vpsShare, run: badRun, name: badName, command }),
      ).rejects.toThrow(/CI_REMOTE_SHARE_(RUN|NAME)_INVALID/);
    write(path.join(vpsShare, run, "policy-default"), { keep: "1" });
    await expect(
      pullRemoteReport({ config, root: vpsShare, run, name: "policy-default", command }),
    ).rejects.toThrow("CI_REMOTE_SHARE_ALREADY_PRESENT");
    expect(existsSync(path.join(base, "called"))).toBe(false);
  });

  it("命令行的 --remote-jobs 只收作业名清单；不写它时行为和以前一样", async () => {
    const env = {
      HIMAWARI_CI_SHARE: vpsShare,
      HIMAWARI_CI_REMOTE_SHARE: path.join(base, "nope"),
      GITHUB_RUN_ID: "43003101968",
      GITHUB_RUN_ATTEMPT: "1",
      CI_NEEDS: JSON.stringify({
        policy: { result: "success", outputs: { default: "c".repeat(64) } },
      }),
    };
    await expect(
      main(["collect", "--to", path.join(base, "o1"), "--remote-jobs", "policy;id"], env),
    ).rejects.toThrow("CI_SHARE_REMOTE_JOBS_INVALID");
    expect(await main(["collect", "--to", path.join(base, "o2")], env)).toBe(
      "CI_SHARE_COLLECT 0\nCI_SHARE_MISSING:policy-default",
    );
    expect(
      await main(["collect", "--to", path.join(base, "o3"), "--remote-jobs", "policy"], env),
    ).toBe("CI_SHARE_COLLECT 0\nCI_SHARE_REMOTE_NOT_CONFIGURED:policy-default");
  });
});
