import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactOutput } from "../../scripts/ci/artifact-output.mjs";
import { createContext } from "../../scripts/ci/context.mjs";
import { fileSha256, repositoryRoot, validateRecord } from "../../scripts/ci/contracts.mjs";
import { execute, sumCounts, vitestCounts } from "../../scripts/ci/execute.mjs";
import { publish, publishQuality } from "../../scripts/ci/publish.mjs";
import { validateQualityPolicy } from "../../scripts/ci/quality.mjs";
import { required } from "../../scripts/ci/required.mjs";
import { reportEntry, runCheck, selectCheck } from "../../scripts/ci/run.mjs";

const directories = [];
const directory = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "himawari-runner-"));
  directories.push(root);
  return root;
};
const write = (filename, value) => {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
};
const read = (filename) => JSON.parse(readFileSync(filename, "utf8"));
const fixture = () => {
  const root = directory();
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  write(path.join(root, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-qm", "fixture");
  mkdirSync(path.join(root, "ci"));
  for (const file of [
    "policy.json",
    "coverage-policy.json",
    "toolchain-lock.json",
    "quality-policy.json",
  ])
    copyFileSync(path.join(repositoryRoot, "ci", file), path.join(root, "ci", file));
  return { root, context: createContext({ root }) };
};
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("受控子进程与真实报告", () => {
  it("保留非零退出码并在完整分块后脱敏", async () => {
    const root = directory();
    const log = path.join(root, "failure.log");
    const outcome = await execute(
      process.execPath,
      [
        "-e",
        "process.stdout.write('Bearer ');process.stderr.write('a'.repeat(24));process.exitCode=7",
      ],
      { cwd: root, env: { PATH: process.env.PATH }, log },
    );
    expect(outcome.exitCode).toBe(7);
    expect(readFileSync(log, "utf8")).toContain("[REDACTED]");
    expect(readFileSync(log, "utf8")).not.toContain("a".repeat(24));
  });
  it("区分启动失败及超时，并终止子进程组", async () => {
    const root = directory();
    expect(
      await execute(path.join(root, "missing"), [], {
        cwd: root,
        env: {},
        log: path.join(root, "missing.log"),
      }),
    ).toMatchObject({ exitCode: 127, error: "ENOENT" });
    expect(
      await execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: root,
        env: {},
        log: path.join(root, "timeout.log"),
        timeoutMs: 50,
      }),
    ).toMatchObject({ termination: "timeout", exitCode: 128 });
  });
  it("输出过大不能吞掉资源失败", async () => {
    const root = directory();
    expect(
      await execute(
        process.execPath,
        ["-e", "const b=Buffer.alloc(1024*1024,65);setInterval(()=>process.stdout.write(b),1)"],
        { cwd: root, env: {}, log: path.join(root, "limit.log") },
      ),
    ).toMatchObject({ termination: "output_limit", exitCode: 128 });
  });
  it("从执行记录计数，拒绝空项目和自相矛盾的成功", () => {
    const report = { success: true, testResults: [{ assertionResults: [{ status: "passed" }] }] };
    expect(vitestCounts(report)).toEqual({
      files: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    for (const value of [
      null,
      {},
      { testResults: [] },
      { testResults: [{}] },
      { testResults: [{ assertionResults: [] }] },
      { success: true, testResults: [{ assertionResults: [{ status: "todo" }] }] },
      { success: true, testResults: [{ assertionResults: [{ status: "failed" }] }] },
    ])
      expect(() => vitestCounts(value)).toThrow();
    const failed = vitestCounts({
      success: false,
      testResults: [{ assertionResults: [{ status: "failed" }, { status: "pending" }] }],
    });
    expect(failed).toMatchObject({ failed: 1, skipped: 1 });
    expect(sumCounts([{ counts: failed }, { counts: vitestCounts(report) }])).toMatchObject({
      files: 2,
      executed: 2,
      passed: 1,
      failed: 1,
      skipped: 1,
    });
  });
});

describe("受控检查与公开输出", () => {
  it("拒绝未知检查、平台和不安全报告路径", () => {
    const policy = read(path.join(repositoryRoot, "ci/policy.json"));
    expect(selectCheck(policy, "policy").member.key).toBe("default");
    expect(() => selectCheck(policy, "required")).toThrow("UNSUPPORTED");
    expect(() => selectCheck(policy, "build", "windows")).toThrow("UNSUPPORTED");
    const root = directory();
    const output = path.join(root, "output");
    mkdirSync(output);
    write(path.join(root, "outside.json"), "{}");
    symlinkSync(path.join(root, "outside.json"), path.join(output, "link"));
    expect(() => reportEntry(path.join(output, "link"), "json", output)).toThrow("OUTSIDE");
    expect(() => reportEntry(output, "json", output)).toThrow("OUTSIDE");
  });
  it("安装失败也留下严格schema的非成功结果，不覆盖既有输出", async () => {
    const { root, context } = fixture();
    const options = {
      root,
      context,
      checkId: "policy",
      output: ".ci-output/result",
      toolsDirectory: path.join(root, "missing"),
    };
    const result = await runCheck(options);
    expect(result.status).toBe("infrastructure_failed");
    expect(result.counts.executed).toBe(0);
    validateRecord("CheckResult", result);
    expect(read(path.join(root, ".ci-output/result/result.json"))).toEqual(result);
    await expect(runCheck(options)).rejects.toThrow("EXISTS");
    await expect(
      runCheck({ ...options, checkId: "test", matrixKey: "linux-x64", output: ".ci-output/test" }),
    ).rejects.toThrow("ARTIFACT_REQUIRED");
    await expect(
      runCheck({ ...options, artifact: path.join(root, "missing"), output: ".ci-output/bad" }),
    ).rejects.toThrow("ARTIFACT_INVALID");
    await expect(runCheck({ ...options, output: "outside" })).rejects.toThrow("OUTPUT_OUTSIDE");
  });
  it("只公开经过hash核验的声明材料，脱敏后更新摘要", async () => {
    const { root, context } = fixture();
    const input = path.join(root, ".ci-output/input");
    const result = await runCheck({
      root,
      context,
      checkId: "policy",
      output: input,
      toolsDirectory: path.join(root, "missing"),
    });
    const report = path.join(input, "log.txt");
    write(report, "Bearer " + "x".repeat(24));
    result.reports.push(reportEntry(report, "diagnostic", input));
    write(path.join(input, "result.json"), result);
    write(path.join(input, "environment-dump.txt"), "never publish");
    const published = await publish({ root, input, output: ".ci-output/public" });
    const entry = published.reports.find((item) => item.path === "log.txt");
    expect(readFileSync(path.join(root, ".ci-output/public/reports/log.txt"), "utf8")).toBe(
      "[REDACTED]",
    );
    expect(entry.sha256).toBe(fileSha256(path.join(root, ".ci-output/public/reports/log.txt")));
    await expect(publish({ root, input, output: ".ci-output/public" })).rejects.toThrow("EXISTS");
    write(report, "modified");
    await expect(publish({ root, input, output: ".ci-output/modified" })).rejects.toThrow(
      "SOURCE_CHANGED",
    );
    expect(existsSync(path.join(root, ".ci-output/modified"))).toBe(false);
  });
  it("被拒绝的二进制诊断不会留在workflow可上传目录", async () => {
    const root = directory();
    const input = path.join(root, ".ci-output/input");
    const screenshot = path.join(input, "failure.png");
    const sentinel = "synthetic-private-sentinel-for-test";
    write(screenshot, sentinel);
    write(path.join(input, "quality.json"), {
      commands: [],
      observations: [{ reports: [{ path: screenshot, kind: "diagnostic" }] }],
    });
    await expect(
      publishQuality({ root, input, output: ".ci-output/public", sentinels: [sentinel] }),
    ).rejects.toThrow("CONTAINS_SECRET");
    expect(existsSync(path.join(root, ".ci-output/public"))).toBe(false);
  });
  it("质量报告也只公开本次显式证据", async () => {
    const root = directory();
    const input = path.join(root, ".ci-output/input");
    write(path.join(input, "quality.json"), { commands: [{ name: "scale" }], observations: [] });
    write(path.join(input, "scale.log"), "done");
    write(path.join(input, "measurement.json"), { count: 42 });
    const entries = await publishQuality({ root, input, output: ".ci-output/public" });
    expect(entries.map((entry) => entry.path)).toEqual([
      "reports/quality.json",
      "reports/measurement.json",
      "reports/scale.log",
    ]);
  });
});

describe("required 失败证据和平台 artifact ID", () => {
  it("依赖全部失败或报告目录缺失仍有明确GateSummary", () => {
    const { root, context } = fixture();
    const summary = required({
      root,
      reports: path.join(root, "missing"),
      output: ".ci-output/gate",
      base: context.baseSha,
      needs: { policy: { result: "failure" } },
      env: {},
    });
    expect(summary.status).toBe("failed");
    expect(summary.missing).toHaveLength(12);
    expect(read(path.join(root, ".ci-output/gate/summary.json"))).toEqual(summary);
    expect(() =>
      required({ root, reports: root, output: ".ci-output/gate", needs: {}, env: {} }),
    ).toThrow("EXISTS");
  });
  it("只传递当前平台的真实数字artifact ID，拒绝shell或多行内容", () => {
    expect(artifactOutput({ CI_MATRIX: "linux-x64", CI_ARTIFACT_ID: "123" })).toBe("linux=123\n");
    expect(artifactOutput({ CI_MATRIX: "macos-arm64", CI_ARTIFACT_ID: "456" })).toBe("macos=456\n");
    for (const id of ["", "0", "1\nmalicious=2", "$(echo) "])
      expect(() => artifactOutput({ CI_MATRIX: "linux-x64", CI_ARTIFACT_ID: id })).toThrow(
        "INVALID",
      );
    expect(() => artifactOutput({ CI_MATRIX: "windows", CI_ARTIFACT_ID: "1" })).toThrow("PLATFORM");
  });
  it("计划中的schedule保持停用，保留期限和观察集合不能暗改", () => {
    const policy = read(path.join(repositoryRoot, "ci/quality-policy.json"));
    expect(validateQualityPolicy(policy)).toBe(policy);
    for (const value of [
      { ...policy, schemaVersion: 2 },
      { ...policy, defaultBranch: "other" },
      { ...policy, schedule: { ...policy.schedule, enabled: true } },
      { ...policy, checks: [] },
      { ...policy, brands: [] },
      { ...policy, retentionDays: { reports: 31, diagnostics: 7 } },
      { ...policy, securityFreshnessHours: 25 },
    ])
      expect(() => validateQualityPolicy(value)).toThrow();
  });
});
