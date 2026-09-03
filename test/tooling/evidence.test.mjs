import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregate, readReportEnvelopes } from "../../scripts/ci/aggregate.mjs";
import { createContext } from "../../scripts/ci/context.mjs";
import {
  expectedMembers,
  fileSha256,
  readJson,
  repositoryRoot,
} from "../../scripts/ci/contracts.mjs";
import {
  exportEvidence,
  readHostedMetadata,
  validateRunMetadata,
} from "../../scripts/ci/export-evidence.mjs";
import { reportEntry } from "../../scripts/ci/run.mjs";

const directories = [];
const write = (filename, value) => {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
};
const count = () => ({ files: 1, executed: 1, passed: 1, failed: 0, skipped: 0 });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "himawari-evidence-"));
  directories.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  write(path.join(root, "README.md"), "fixture");
  git("add", "README.md");
  git("commit", "-qm", "fixture");
  mkdirSync(path.join(root, "ci"));
  for (const name of [
    "policy.json",
    "coverage-policy.json",
    "quality-policy.json",
    "evidence.schema.json",
    "toolchain-lock.json",
  ])
    copyFileSync(path.join(repositoryRoot, "ci", name), path.join(root, "ci", name));
  const context = { ...createContext({ root }), event: "push" };
  const policy = readJson(path.join(root, "ci/policy.json"));
  const toolchainLock = readJson(path.join(root, "ci/toolchain-lock.json"));
  const reports = path.join(root, ".ci-output/reports");
  const gate = path.join(root, ".ci-output/gate");
  const now = Date.now();
  for (const { check, member } of expectedMembers(policy)) {
    const output = path.join(reports, check.id, member.key);
    mkdirSync(output, { recursive: true });
    const projects = check.projects.map((id) => ({ id, counts: count() }));
    const total = Math.max(1, projects.length);
    const platform = check.id === "browser" ? "linux-x64" : member.key;
    const items = check.outputs.map((kind) => {
      const name = check.id === "security" ? "security-report.json" : `report.${kind}`;
      write(
        path.join(output, name),
        kind === "artifact"
          ? `synthetic ${platform} artifact`
          : check.id === "security"
            ? { status: "passed", scannedAt: new Date(now).toISOString(), context }
            : { fixture: true },
      );
      return reportEntry(path.join(output, name), kind, output);
    });
    const artifact = items.find((entry) => entry.kind === "artifact");
    write(path.join(output, "result.json"), {
      schemaVersion: 1,
      checkId: check.id,
      matrixKey: member.key,
      ...context,
      toolchain: {
        node: member.node,
        npm: "11.8.0",
        os: member.os,
        arch: member.arch,
        abi: "127",
        runnerImage: "synthetic-fixture",
      },
      status: "passed",
      exitCode: 0,
      durationMs: 1,
      retryCount: 0,
      counts: { files: total, executed: total, passed: total, failed: 0, skipped: 0 },
      projects,
      reports: items,
      artifacts: artifact
        ? [
            {
              role: check.id === "build" ? "produced" : "consumed",
              platform,
              path: artifact.path,
              sha256: artifact.sha256,
            },
          ]
        : [],
    });
  }
  const needs = Object.fromEntries(
    policy.checks
      .filter((check) => check.id !== "required")
      .map((check) => [check.id, { result: "success" }]),
  );
  const summarize = () => {
    const summary = aggregate({
      policy,
      context,
      needs,
      reports: readReportEnvelopes(reports),
      toolchainLock,
    });
    write(path.join(gate, "summary.json"), summary);
    return summary;
  };
  write(path.join(gate, "context.json"), context);
  write(path.join(gate, "needs.json"), needs);
  expect(summarize().status).toBe("passed");
  const metadata = {
    id: Number(context.runId),
    run_attempt: context.attempt,
    head_sha: context.testedSha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    repository: { full_name: context.repository },
    path: ".github/workflows/ci.yml",
    html_url: `https://github.com/${context.repository}/actions/runs/${context.runId}`,
    created_at: new Date(now - 1000).toISOString(),
  };
  return {
    root,
    context,
    reports,
    gate,
    now,
    metadata,
    output: ".ci-output/evidence.json",
    summarize,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("S9 CI证据交接边界", () => {
  it("完整默认分支对照可导出，但只声明CI证据，仍明确生产资格与持久转存待办", () => {
    const input = fixture();
    const evidence = exportEvidence(input);
    expect(evidence.status).toBe("ci_verified");
    expect(evidence.productQualification).toBe("not_assessed");
    expect(evidence.platforms).toHaveLength(2);
    expect(evidence.checks).toHaveLength(12);
    expect(evidence.pending).toHaveLength(5);
    expect(evidence.persistence).toBe("transfer_required_before_expiry");
    expect(readJson(path.join(input.root, input.output))).toEqual(evidence);
  });
  it.each([
    "id",
    "run_attempt",
    "head_sha",
    "head_branch",
    "event",
    "status",
    "conclusion",
    "repository",
    "path",
    "html_url",
  ])("拒绝外部run元数据的%s身份替换", (field) => {
    const input = fixture();
    input.metadata[field] = "wrong";
    expect(() => validateRunMetadata(input.metadata, input.context, "main")).toThrow();
  });
  it("拒绝PR产物、过期保留期限、未完成项和伪造汇总", () => {
    const input = fixture();
    write(path.join(input.gate, "context.json"), { ...input.context, event: "pull_request" });
    expect(() => exportEvidence(input)).toThrow("PUSH_EVIDENCE");
    write(path.join(input.gate, "context.json"), input.context);
    expect(() => exportEvidence({ ...input, now: input.now + 31 * 86_400_000 })).toThrow("EXPIRED");
    expect(() => exportEvidence({ ...input, pending: ["missing check"] })).toThrow("WORK_PENDING");
    write(path.join(input.gate, "summary.json"), { status: "passed" });
    expect(() => exportEvidence(input)).toThrow("GATE_INCOMPLETE_OR_CHANGED");
  });
  it("重新核验归档bytes，拒绝混合SHA、平台和缺少必需报告", () => {
    const input = fixture();
    const filename = path.join(input.reports, "build/linux-x64/report.artifact");
    write(filename, "tampered");
    expect(() => exportEvidence(input)).toThrow("GATE_INCOMPLETE");
  });
  it("安全报告超过24小时、来自未来或未绑定tested SHA都不能交接", () => {
    const input = fixture();
    const directory = path.join(input.reports, "security/default");
    const filename = path.join(directory, "security-report.json");
    const resultPath = path.join(directory, "result.json");
    const update = (data) => {
      write(filename, data);
      const result = readJson(resultPath);
      result.reports = [reportEntry(filename, "json", directory)];
      write(resultPath, result);
      input.summarize();
    };
    for (const report of [
      {
        status: "passed",
        context: input.context,
        scannedAt: new Date(input.now - 25 * 3_600_000).toISOString(),
      },
      {
        status: "passed",
        context: input.context,
        scannedAt: new Date(input.now + 1000).toISOString(),
      },
      {
        status: "passed",
        context: { ...input.context, testedSha: "f".repeat(40) },
        scannedAt: new Date(input.now).toISOString(),
      },
      { status: "failed", context: input.context, scannedAt: new Date(input.now).toISOString() },
    ]) {
      update(report);
      expect(() => exportEvidence(input)).toThrow("SECURITY_STALE_OR_UNBOUND");
    }
  });
  it("GitHub只读查询保留必要字段并校验身份，不输出token", async () => {
    const input = fixture();
    const env = {
      GITHUB_REPOSITORY: input.context.repository,
      GITHUB_TOKEN: "synthetic",
      GITHUB_OUTPUT: path.join(input.root, "outputs"),
    };
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...input.metadata, unnecessary: "do not retain" }),
    }));
    vi.stubGlobal("fetch", request);
    const value = await readHostedMetadata({
      root: input.root,
      runId: input.context.runId,
      output: ".ci-output/metadata.json",
      env,
    });
    expect(value).not.toHaveProperty("unnecessary");
    expect(request.mock.calls[0][0]).toContain(`/actions/runs/${input.context.runId}`);
    expect(readFileSync(path.join(input.root, "outputs"), "utf8")).toContain(
      `attempt=${input.context.attempt}`,
    );
    expect(fileSha256(path.join(input.root, ".ci-output/metadata.json"))).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    await expect(
      readHostedMetadata({ root: input.root, runId: "1\n2", output: ".ci-output/bad.json", env }),
    ).rejects.toThrow("RUN_ID_REQUIRED");
    await expect(
      readHostedMetadata({
        root: input.root,
        runId: "1",
        output: ".ci-output/bad.json",
        env: { ...env, GITHUB_TOKEN: "" },
      }),
    ).rejects.toThrow("READ_TOKEN_REQUIRED");
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403 }));
    await expect(
      readHostedMetadata({ root: input.root, runId: "1", output: ".ci-output/bad.json", env }),
    ).rejects.toThrow("METADATA_HTTP:403");
  });
});
