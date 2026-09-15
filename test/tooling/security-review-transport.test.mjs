import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { readReviewComment } from "../../scripts/ci/security-owner-review.mjs";

describe("GitHub 审批读取边界", () => {
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
