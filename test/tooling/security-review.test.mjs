import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadReviewedExceptions } from "../../scripts/ci/security-exceptions.mjs";
import { applyMachineReview } from "../../scripts/ci/security-owner-review.mjs";

const roots = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const now = new Date("2026-09-14T12:00:00Z");
const repository = "sixianli/himawari-agent";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "himawari-owner-review-"));
  roots.push(root);
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic Fixture");
  git("config", "user.email", "fixture@example.invalid");
  cpSync(resolve("ci"), join(root, "ci"), { recursive: true });
  writeFileSync(
    join(root, "ci/security-exceptions.json"),
    JSON.stringify({ schemaVersion: 1, exceptions: [] }),
  );
  git("add", ".");
  git("commit", "-qm", "synthetic accepted policy");
  const sourceHead = git("rev-parse", "HEAD");
  const entry = {
    kind: "machine-secret",
    id: "credential-assignment",
    path: "apps/admin-cli/src/account-command.ts",
    digest: "a".repeat(64),
    count: 1,
  };
  const manifest = {
    status: "pending_owner_approval",
    repository,
    pullRequest: 4,
    sourceHead,
    entries: [entry],
  };
  mkdirSync(join(root, ".github"));
  const manifestPath = join(root, ".github/security-review-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(
    join(root, ".github/security-review-comment.json"),
    JSON.stringify({ commentId: 123 }),
  );
  const approval = {
    schemaVersion: 1,
    decision: "approved",
    repository,
    pullRequest: 4,
    sourceHead,
    manifestSha256: digest(readFileSync(manifestPath)),
    expiresAt: "2026-10-03T00:00:00Z",
  };
  const comment = {
    id: 123,
    user: { id: 30715326, login: "sixianli", type: "User" },
    issue_url: `https://api.github.com/repos/${repository}/issues/4`,
    html_url: `https://github.com/${repository}/pull/4#issuecomment-123`,
    created_at: "2026-09-14T10:00:00Z",
  };
  const options = {
    root,
    context: { repository, baseSha: sourceHead, headSha: sourceHead, initialization: false },
    now,
    dependencies: [],
    ruleIds: [],
    readReviewComment: () => ({
      ...comment,
      body: `<!-- himawari-security-review-v1 -->\n\x60\x60\x60json\n${JSON.stringify(approval)}\n\x60\x60\x60`,
    }),
  };
  return { root, git, manifestPath, manifest, entry, approval, comment, options };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("独立 Owner 精确清单审批", () => {
  it("加载真实边界返回的 Owner 审批，清单自己的 pending 状态不能充当审批", () => {
    const f = fixture();
    const result = loadReviewedExceptions(f.options);
    expect(result.approvalBasis).toBe("owner_pr_comment");
    expect(result.machineExceptions).toEqual([f.entry]);
    expect(result.sourceSha).toBe(f.manifest.sourceHead);
  });
  it.each(["author", "repository", "pr", "source", "digest", "expired", "decision", "missing"])(
    "拒绝 %s 的审批",
    (change) => {
      const f = fixture();
      if (change === "author") f.comment.user.id = 42;
      if (change === "repository") f.approval.repository = "example/other";
      if (change === "pr")
        f.comment.issue_url = `https://api.github.com/repos/${repository}/issues/5`;
      if (change === "source") f.approval.sourceHead = "b".repeat(40);
      if (change === "digest") f.approval.manifestSha256 = "c".repeat(64);
      if (change === "expired") f.approval.expiresAt = "2026-09-13T00:00:00Z";
      if (change === "decision") f.approval.decision = "rejected";
      if (change === "missing")
        f.options.readReviewComment = () => {
          throw new Error("unavailable");
        };
      expect(() => loadReviewedExceptions(f.options)).toThrow();
    },
  );
  it("批准后修改数量仍拒绝", () => {
    const f = fixture();
    f.manifest.entries[0].count = 2;
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    expect(() => loadReviewedExceptions(f.options)).toThrow();
  });
});

describe("审批范围的真实消费", () => {
  it("machine 发现保留审计信息，未知摘要继续阻塞", () => {
    const f = fixture();
    const findings = [
      { ...f.entry, blocking: true },
      { ...f.entry, digest: "b".repeat(64), blocking: true },
    ];
    expect(applyMachineReview(findings, [f.entry])).toEqual([
      { ...findings[0], excepted: true, classification: "owner-reviewed-machine-finding" },
      findings[1],
    ]);
  });
  it.each([0, 2])("machine 实际数量 %s 不能消费批准的单条", (count) => {
    const f = fixture();
    expect(() => applyMachineReview(count ? [{ ...f.entry, count }] : [], [f.entry])).toThrow();
  });
  it("machine 重复发现不能重复消费", () => {
    const f = fixture();
    expect(() => applyMachineReview([f.entry, f.entry], [f.entry])).toThrow();
  });
  it("其他 PR 不能复用审批", () => {
    const f = fixture();
    f.options.context.event = "pull_request";
    const path = join(f.root, "event.json");
    writeFileSync(
      path,
      JSON.stringify({ number: 5, pull_request: { head: { sha: f.manifest.sourceHead } } }),
    );
    vi.stubEnv("GITHUB_EVENT_PATH", path);
    expect(() => loadReviewedExceptions(f.options)).toThrow("SECURITY_REVIEW_PR_MISMATCH");
  });
  it("当前 PR 的事件和提交均匹配", () => {
    const f = fixture();
    f.options.context.event = "pull_request";
    const path = join(f.root, "event.json");
    writeFileSync(
      path,
      JSON.stringify({ number: 4, pull_request: { head: { sha: f.manifest.sourceHead } } }),
    );
    vi.stubEnv("GITHUB_EVENT_PATH", path);
    expect(loadReviewedExceptions(f.options).approvalBasis).toBe("owner_pr_comment");
  });
});

describe("批准清单的解析和来源边界", () => {
  const reload = (f) => {
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    f.approval.manifestSha256 = digest(readFileSync(f.manifestPath));
    return loadReviewedExceptions(f.options);
  };
  it("没有审批文件时沿用 main，单边缺失时拒绝", () => {
    const f = fixture();
    rmSync(f.manifestPath);
    expect(() => loadReviewedExceptions(f.options)).toThrow("SECURITY_REVIEW_INCOMPLETE");
    rmSync(join(f.root, ".github/security-review-comment.json"));
    expect(loadReviewedExceptions(f.options).approvalBasis).toBe("accepted_base");
  });
  it("错误编号与缺失正文均不能作为审批", () => {
    const f = fixture();
    writeFileSync(
      join(f.root, ".github/security-review-comment.json"),
      JSON.stringify({ commentId: "123" }),
    );
    expect(() => loadReviewedExceptions(f.options)).toThrow("SECURITY_REVIEW_COMMENT_INVALID");
    writeFileSync(
      join(f.root, ".github/security-review-comment.json"),
      JSON.stringify({ commentId: 123 }),
    );
    const read = f.options.readReviewComment;
    f.options.readReviewComment = () => ({ ...read(), body: "approved" });
    expect(() => loadReviewedExceptions(f.options)).toThrow("SECURITY_REVIEW_RECORD_MISSING");
  });
  it("非本仓库上下文拒绝", () => {
    const f = fixture();
    f.options.context.repository = "example/repo";
    expect(() => loadReviewedExceptions(f.options)).toThrow("SECURITY_REVIEW_MANIFEST_INVALID");
  });
  it("审批不能指向不在当前提交历史内的来源", () => {
    const f = fixture();
    f.manifest.sourceHead = "b".repeat(40);
    f.approval.sourceHead = f.manifest.sourceHead;
    expect(() => reload(f)).toThrow("SECURITY_REVIEW_SOURCE_UNRELATED");
  });
  it("未知类型、目录通配符与重复 machine 项均拒绝", () => {
    const f = fixture();
    f.manifest.entries = [{ kind: "unknown" }];
    expect(() => reload(f)).toThrow("SECURITY_REVIEW_KIND_INVALID");
    f.manifest.entries = [{ ...f.entry, path: "test/**" }];
    expect(() => reload(f)).toThrow("SECURITY_REVIEW_MACHINE_INVALID");
    f.manifest.entries = [f.entry, f.entry];
    expect(() => reload(f)).toThrow("SECURITY_REVIEW_MACHINE_DUPLICATE");
  });
  it("合成 token 保留当前与历史来源，未知历史范围拒绝", () => {
    const f = fixture();
    const current = {
      kind: "secret",
      id: "generic-api-key",
      path: "test/example.test.ts",
      digest: "d".repeat(64),
      line: 1,
      scope: "current",
      commit: null,
    };
    const history = { ...current, scope: "history", commit: f.manifest.sourceHead };
    f.manifest.entries = [current, history];
    const result = reload(f);
    expect(result.exceptions[0]).toMatchObject({
      count: 2,
      provenance: {
        classification: "synthetic-boot-token",
        current: { sourceCommit: f.manifest.sourceHead, lines: [1], count: 1 },
        history: [{ sourceCommit: f.manifest.sourceHead, lines: [1], count: 1 }],
      },
    });
    f.manifest.entries = [history];
    expect(() => reload(f)).toThrow("SECURITY_REVIEW_SECRET_INVALID");
  });
  it("发布文档例外绑定确切依赖、成员全文与发现摘要", () => {
    const f = fixture();
    const entry = {
      package: "example",
      version: "1.0.0",
      sourceUrl: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      archiveMember: "package/README.md",
      fileSha256: "e".repeat(64),
      findingDigest: "f".repeat(64),
      classification: "published documentation example seed",
      verification: "隔离测试中的模拟来源证明，只验证精确依赖身份及成员摘要传递。",
    };
    f.manifest.entries = [entry];
    f.options.dependencies = [{ path: "node_modules/example", name: "example", version: "1.0.0" }];
    expect(reload(f).exceptions[0]).toMatchObject({
      path: "runtime/node_modules/example/README.md",
      fileSha256: entry.fileSha256,
      findings: [{ rule: "credential-literal", digest: entry.findingDigest, count: 1 }],
    });
    f.options.dependencies[0].version = "2.0.0";
    expect(() => reload(f)).toThrow("SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN");
  });
});

describe("合入 main 后的审批继承", () => {
  it("main 已接受相同清单后，其他 PR 继承精确批准而不要求重复审批", () => {
    const f = fixture();
    f.git("add", ".github");
    f.git("commit", "-qm", "accept reviewed manifest");
    f.options.context.baseSha = f.git("rev-parse", "HEAD");
    f.options.context.headSha = f.options.context.baseSha;
    f.options.context.event = "pull_request";
    const path = join(f.root, "event.json");
    writeFileSync(
      path,
      JSON.stringify({ number: 5, pull_request: { head: { sha: f.options.context.headSha } } }),
    );
    vi.stubEnv("GITHUB_EVENT_PATH", path);
    expect(loadReviewedExceptions(f.options).machineExceptions).toEqual([f.entry]);
    f.manifest.entries[0].count = 2;
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    f.approval.manifestSha256 = digest(readFileSync(f.manifestPath));
    expect(() => loadReviewedExceptions(f.options)).toThrow("SECURITY_REVIEW_PR_MISMATCH");
  });
});
