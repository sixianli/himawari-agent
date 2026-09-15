import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { readReviewComment } from "../../scripts/ci/security-owner-review.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(execFileSync).mockReset();
});

describe("GitHub 审批读取边界", () => {
  it("仅在当前 Actions 仓库内通过标准输入发送临时令牌", () => {
    const credential = ["synthetic", "actions", "credential"].join("_");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REPOSITORY", "sixianli/himawari-agent");
    vi.stubEnv("HIMAWARI_CI_GITHUB_TOKEN", credential);
    vi.mocked(execFileSync).mockImplementationOnce((_command, args) => {
      writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify({ id: 123 }));
      return "200";
    });
    expect(readReviewComment(123)).toEqual({ id: 123 });
    const [, args, options] = vi.mocked(execFileSync).mock.calls.at(-1);
    expect(args).not.toContain(credential);
    expect(args).toEqual(expect.arrayContaining(["--config", "-"]));
    expect(options.input).toBe(`header = "Authorization: Bearer ${credential}"\n`);
    expect(options.env.HIMAWARI_CI_GITHUB_TOKEN).toBeUndefined();
  });
  it.each(["outside-ci", "other-repository", "header-injection"])("拒绝令牌越界：%s", (mode) => {
    vi.stubEnv("GITHUB_ACTIONS", mode === "outside-ci" ? "false" : "true");
    vi.stubEnv(
      "GITHUB_REPOSITORY",
      mode === "other-repository" ? "example/other" : "sixianli/himawari-agent",
    );
    vi.stubEnv(
      "HIMAWARI_CI_GITHUB_TOKEN",
      mode === "header-injection" ? "invalid\nheader" : "synthetic",
    );
    vi.mocked(execFileSync).mockImplementationOnce((_command, args) => {
      writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify({ id: 123 }));
      return "200";
    });
    expect(() => readReviewComment(123)).toThrow(/SECURITY_REVIEW_TOKEN_/);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it("使用固定 HTTPS 地址并禁用隐式 curl 配置，不发送凭据", () => {
    vi.mocked(execFileSync).mockImplementationOnce((_command, args) => {
      writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify({ id: 123 }));
      return "200";
    });
    expect(readReviewComment(123)).toEqual({ id: 123 });
    const [command, args, options] = vi.mocked(execFileSync).mock.calls.at(-1);
    expect(command).toBe("/usr/bin/curl");
    expect(args[0]).toBe("--disable");
    expect(args).toContain("=https");
    expect(args).not.toContain("--insecure");
    expect(args).not.toContain("--location");
    expect(args).toEqual(expect.arrayContaining(["--retry", "2", "--retry-max-time", "40"]));
    expect(options.timeout).toBe(55_000);
    expect(args).toContain("--retry-all-errors");
    expect(args).toEqual(expect.arrayContaining(["--max-filesize", "1048576"]));
    expect(existsSync(args[args.indexOf("--output") + 1])).toBe(false);
    expect(args.at(-1)).toBe(
      "https://api.github.com/repos/sixianli/himawari-agent/issues/comments/123",
    );
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
  it.each([0, -1, "123", "../4", Number.MAX_SAFE_INTEGER + 1])("拒绝无效评论编号 %s", (id) => {
    vi.mocked(execFileSync).mockClear();
    expect(() => readReviewComment(id)).toThrow("SECURITY_REVIEW_COMMENT_INVALID");
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it.each([
    [22, "403", "SECURITY_REVIEW_HTTP_FORBIDDEN"],
    [22, "429", "SECURITY_REVIEW_HTTP_RATE_LIMITED"],
    [22, "503", "SECURITY_REVIEW_HTTP_SERVER_ERROR"],
    [22, "404", "SECURITY_REVIEW_HTTP_NOT_FOUND"],
    [28, "000", "SECURITY_REVIEW_TRANSPORT_TIMEOUT"],
    [60, "000", "SECURITY_REVIEW_TLS_FAILED"],
    [6, "000", "SECURITY_REVIEW_DNS_FAILED"],
    [7, "000", "SECURITY_REVIEW_CONNECT_FAILED"],
    [92, "000", "SECURITY_REVIEW_HTTP_STREAM_FAILED"],
    [63, "000", "SECURITY_REVIEW_RESPONSE_TOO_LARGE"],
  ])("安全区分 curl %s / HTTP %s 的失败", (status, http, code) => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("private diagnostic"), {
        status,
        stdout: `private response\n${http}`,
        stderr: "private diagnostic",
      });
    });
    expect(() => readReviewComment(123)).toThrow(new RegExp(`^${code}$`));
  });
  it("网络错误不泄漏原始错误内容且不能放行", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("private diagnostic");
    });
    expect(() => readReviewComment(123)).toThrow(/^SECURITY_REVIEW_UNAVAILABLE$/);
  });
  it("非 JSON 响应不能充当审批", () => {
    vi.mocked(execFileSync).mockImplementationOnce((_command, args) => {
      writeFileSync(args[args.indexOf("--output") + 1], "not json");
      return "200";
    });
    expect(() => readReviewComment(123)).toThrow("SECURITY_REVIEW_INVALID_RESPONSE");
  });
});

it("CI 仅向需要读取审批的步骤提供现有只读令牌", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.env?.HIMAWARI_CI_GITHUB_TOKEN).toBeUndefined();
  let readers = 0;
  for (const job of Object.values(workflow.jobs)) {
    expect(job.env?.HIMAWARI_CI_GITHUB_TOKEN).toBeUndefined();
    for (const step of job.steps) {
      const needsReview = /scripts\/ci\/publish\.mjs|--check security(?: |$)/.test(step.run ?? "");
      if (needsReview) {
        expect(step.env?.HIMAWARI_CI_GITHUB_TOKEN).toBe(`\${{ github.token }}`);
        readers += 1;
      } else expect(step.env?.HIMAWARI_CI_GITHUB_TOKEN).toBeUndefined();
    }
  }
  expect(readers).toBeGreaterThan(0);
});
