import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { readReviewComment } from "../../scripts/ci/security-owner-review.mjs";

describe("GitHub 审批读取边界", () => {
  it("使用固定 HTTPS 地址并禁用隐式 curl 配置，不发送凭据", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify({ id: 123 }));
    expect(readReviewComment(123)).toEqual({ id: 123 });
    const [command, args, options] = vi.mocked(execFileSync).mock.calls.at(-1);
    expect(command).toBe("/usr/bin/curl");
    expect(args[0]).toBe("--disable");
    expect(args).toContain("=https");
    expect(args).not.toContain("--insecure");
    expect(args).not.toContain("--location");
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
  it("网络错误不泄漏原始错误内容且不能放行", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("private diagnostic");
    });
    expect(() => readReviewComment(123)).toThrow(/^SECURITY_REVIEW_UNAVAILABLE$/);
  });
  it("非 JSON 响应不能充当审批", () => {
    vi.mocked(execFileSync).mockReturnValueOnce("not json");
    expect(() => readReviewComment(123)).toThrow("SECURITY_REVIEW_UNAVAILABLE");
  });
});
