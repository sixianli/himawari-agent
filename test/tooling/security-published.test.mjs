import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ members: [] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original();
  return {
    ...actual,
    spawnSync: (command, args, options) =>
      command === "/synthetic/python"
        ? { status: 0, stdout: "Python 3.12.10\n" }
        : actual.spawnSync(command, args, options),
    // Only the stream transport is synthetic; context, Git policy selection, hashes and scanner are real.
    spawn: (command, args) => {
      expect(command).toBe("/synthetic/python");
      expect(args.slice(0, 2)).toEqual(["-I", "-B"]);
      const child = new EventEmitter();
      child.stderr = Readable.from([]);
      child.stdout = Readable.from(
        boundary.members.flatMap(({ name, bytes }) => [
          Buffer.from(`${JSON.stringify({ name, size: bytes.length })}\n`),
          bytes,
        ]),
      );
      child.kill = () => child.emit("close", 0);
      child.stdout.once("end", () => setImmediate(() => child.emit("close", 0)));
      return child;
    },
  };
});

import { createContext } from "../../scripts/ci/context.mjs";
import { createPublishedFixtureReview } from "../../scripts/ci/security-published-fixtures.mjs";
import { assertPublicArtifacts } from "../../scripts/ci/security-redaction.mjs";
import { findBuildSecrets } from "../../scripts/ci/security-source.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = new Date("2026-09-03T14:00:00Z");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directories = [];
const json = (path, value) => writeFileSync(path, JSON.stringify(value));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "himawari-published-fixture-"));
  directories.push(root);
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "fixture.txt"), "synthetic repository\n");
  git("add", ".");
  git("commit", "-qm", "synthetic initial source");
  cpSync(join(repository, "ci"), join(root, "ci"), { recursive: true });
  const name = "runtime/node_modules/example/README.md";
  const bytes = Buffer.from(['const apiKey = "', 'HIMAWARISYNTHETICONLY_PUBLIC";\n'].join(""));
  const findings = findBuildSecrets({ name, bytes });
  const dependency = {
    version: "1.0.0",
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
  };
  const lock = { lockfileVersion: 3, packages: { "node_modules/example": dependency } };
  json(join(root, "package-lock.json"), lock);
  const entry = {
    kind: "published-synthetic-fixture",
    id: "published-synthetic-fixture",
    path: name,
    package: "example",
    version: "1.0.0",
    packageLockPath: "node_modules/example",
    integrity: dependency.integrity,
    sourceUrl: dependency.resolved,
    archiveMember: "package/README.md",
    fileSha256: sha(bytes),
    findings: findings.map(({ rule, digest }) => ({ rule, digest, count: 1 })),
    reason: "明确合成的隔离单元测试输入，只用于验证例外判定合同。",
    owner: "sixianli",
    reviewReference: `https://github.com/example/repository/commit/${git("rev-parse", "HEAD")}`,
    expiresAt: "2026-10-03T00:00:00Z",
    sourceProofSha256: "a".repeat(64),
    sourceReview: "此来源为隔离测试的合成边界，不冒充真实 npm 下载或 Owner 审阅。",
  };
  const document = {
    schemaVersion: 1,
    proposal: {
      status: "proposed_owner_review_required",
      proposedAt: "2026-09-03T00:00:00Z",
      owner: "sixianli",
      reviewEvidence: "此为仅在隔离测试使用的合成例外提案，不是真实包的来源证明。",
    },
    exceptions: [entry],
  };
  const save = () => json(join(root, "ci/security-exceptions.json"), document);
  save();
  const context = () => createContext({ root, env: {}, now: now.getTime() });
  const review = () => createPublishedFixtureReview({ root, context: context(), now });
  const accept = () => {
    const coverage = JSON.parse(readFileSync(join(root, "ci/coverage-policy.json")));
    coverage.baseline = {
      sourceSha: "a".repeat(40),
      sourceTreeSha256: "b".repeat(64),
      reportSha256: "c".repeat(64),
      groups: {
        "scripts/ci": Object.fromEntries(
          ["lines", "branches", "functions", "statements"].map((key) => [
            key,
            { total: 1, covered: 1, pct: 100 },
          ]),
        ),
      },
    };
    json(join(root, "ci/coverage-policy.json"), coverage);
    save();
    git("add", ".");
    git("commit", "-qm", "accepted synthetic policy fixture");
  };
  return { root, git, name, bytes, findings, entry, document, lock, save, context, review, accept };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("published fixture admission", () => {
  it("初始化双缺失仅接受精确成员并保留待Owner审阅状态", () => {
    const f = fixture(),
      review = f.review();
    review.inspect(f);
    expect(review.finish()).toMatchObject({
      memberCount: 1,
      findingCount: 1,
      sourceSha: null,
      approvalBasis: "initialization_proposal",
      reviewStatus: "proposed_owner_review_required",
    });
    expect(createPublishedFixtureReview()).toBeNull();
  });
  it("已接受base阻止候选自加例外改善结果", () => {
    const f = fixture();
    f.document.exceptions = [];
    f.accept();
    f.document.exceptions = [f.entry];
    f.save();
    const review = f.review();
    expect(() => review.inspect(f)).toThrow("PUBLIC_ARTIFACT_CONTAINS_SECRET");
    expect(review.finish()).toMatchObject({
      memberCount: 0,
      candidateDiffers: true,
      approvalBasis: "accepted_base",
    });
  });
  it("候选扩大摘要和次数不改变已接受base", () => {
    const f = fixture();
    f.accept();
    f.entry.findings[0].count = 2;
    f.save();
    const review = f.review();
    review.inspect(f);
    expect(review.finish()).toMatchObject({
      memberCount: 1,
      candidateDiffers: true,
      reviewStatus: "accepted_base",
    });
  });
  it("只有例外存在的base不能冒充初始化", () => {
    const f = fixture();
    f.git("add", "ci/security-exceptions.json");
    f.git("commit", "-qm", "partial policy");
    expect(f.review).toThrow("SECURITY_PARTIAL_INITIALIZATION");
  });
  it("上下文必须绑定本次工具链和目标base", () => {
    const f = fixture();
    expect(() =>
      createPublishedFixtureReview({
        root: f.root,
        context: { ...f.context(), toolchainSha256: "0".repeat(64) },
        now,
      }),
    ).toThrow("CI_CONTEXT_MISMATCH");
  });
  it.each([
    [
      "过期",
      (e) => {
        e.expiresAt = "2026-09-03T00:00:00Z";
      },
    ],
    [
      "超过初始化30天",
      (e) => {
        e.expiresAt = "2026-10-04T00:00:00Z";
      },
    ],
    [
      "Owner漂移",
      (e) => {
        e.owner = "another-owner";
      },
    ],
    [
      "通配路径",
      (e) => {
        e.path += "*";
      },
    ],
    [
      "非包成员",
      (e) => {
        e.archiveMember = "README.md";
      },
    ],
    [
      "路径不对应",
      (e) => {
        e.archiveMember = "package/OTHER.md";
      },
    ],
    [
      "未知依赖",
      (e) => {
        e.package = "other";
      },
    ],
    [
      "不同版本",
      (e) => {
        e.version = "2.0.0";
      },
    ],
    [
      "不同integrity",
      (e) => {
        e.integrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
      },
    ],
    [
      "不同官方URL",
      (e) => {
        e.sourceUrl = "https://registry.npmjs.org/other/-/other-1.0.0.tgz";
      },
    ],
    [
      "非官方URL",
      (e) => {
        e.sourceUrl = "https://example.invalid/package.tgz";
      },
    ],
    [
      "未知规则",
      (e) => {
        e.findings[0].rule = "unknown";
      },
    ],
    [
      "哨兵例外",
      (e) => {
        e.findings[0].rule = "sentinel";
      },
    ],
    [
      "重复命中",
      (e) => {
        e.findings.push({ ...e.findings[0] });
      },
    ],
  ])("拒绝非法政策：%s", (_name, mutate) => {
    const f = fixture();
    mutate(f.entry);
    f.save();
    expect(f.review).toThrow();
  });
  it("拒绝重复成员例外", () => {
    const f = fixture();
    f.document.exceptions.push(structuredClone(f.entry));
    f.save();
    expect(f.review).toThrow("SECURITY_EXCEPTION_DUPLICATE");
  });
  it.each([
    [
      "内容变化",
      (f) => ({ ...f, bytes: Buffer.concat([f.bytes, Buffer.from("//changed")]) }),
      "PUBLIC_FIXTURE_MEMBER_CHANGED",
    ],
    [
      "未知路径",
      (f) => ({ ...f, name: "runtime/node_modules/example/OTHER.md" }),
      "PUBLIC_ARTIFACT_CONTAINS_SECRET",
    ],
    [
      "增加同一命中",
      (f) => ({ ...f, findings: [...f.findings, ...f.findings] }),
      "PUBLIC_FIXTURE_FINDINGS_CHANGED",
    ],
    ["减少命中", (f) => ({ ...f, findings: [] }), "PUBLIC_FIXTURE_FINDINGS_CHANGED"],
    [
      "换字面量",
      (f) => ({ ...f, findings: [{ ...f.findings[0], digest: "b".repeat(64) }] }),
      "PUBLIC_FIXTURE_FINDINGS_CHANGED",
    ],
    [
      "敏感哨兵",
      (f) => ({
        ...f,
        findings: [...f.findings, { rule: "sentinel", digest: "b".repeat(64), line: null }],
      }),
      "PUBLIC_ARTIFACT_CONTAINS_SECRET",
    ],
  ])("拒绝成员变化：%s", (_name, mutate, code) => {
    const f = fixture();
    expect(() => f.review().inspect(mutate(f))).toThrow(code);
  });
  it("拒绝缺失和重复成员，未知干净成员仍接受完整扫描", () => {
    const f = fixture(),
      review = f.review();
    review.inspect({ name: "runtime/clean.txt", bytes: Buffer.from("clean"), findings: [] });
    expect(() => review.finish()).toThrow("PUBLIC_FIXTURE_MEMBER_MISSING");
    review.inspect(f);
    expect(() => review.inspect(f)).toThrow("PUBLIC_FIXTURE_MEMBER_DUPLICATE");
  });
  it("公开guard传递已核验context及独立policyRoot，并输出无原文审阅元数据", async () => {
    const f = fixture();
    const output = join(f.root, ".ci-output");
    mkdirSync(output);
    const bytes = Buffer.from("synthetic archive transport");
    writeFileSync(join(output, "fixture.tar.gz"), bytes);
    const entries = [
      { path: "fixture.tar.gz", kind: "artifact", classification: "build", sha256: sha(bytes) },
    ];
    const allowed = [{ path: "fixture.tar.gz", kind: "artifact" }];
    const options = {
      root: output,
      policyRoot: f.root,
      entries,
      allowed,
      python: "/synthetic/python",
      now,
    };
    boundary.members = [f];
    await expect(assertPublicArtifacts(options)).rejects.toThrow("PUBLIC_ARTIFACT_CONTAINS_SECRET");
    const reviews = [];
    await expect(
      assertPublicArtifacts({
        ...options,
        context: f.context(),
        onReview: (review) => reviews.push(review),
      }),
    ).resolves.toEqual(entries);
    expect(reviews).toMatchObject([
      {
        path: "fixture.tar.gz",
        memberCount: 1,
        findingCount: 1,
        reviewStatus: "proposed_owner_review_required",
      },
    ]);
    expect(JSON.stringify(reviews)).not.toContain("HIMAWARISYNTHETICONLY_PUBLIC");
    await expect(
      assertPublicArtifacts({
        ...options,
        context: f.context(),
        sentinels: ["HIMAWARISYNTHETICONLY_PUBLIC"],
      }),
    ).rejects.toThrow("PUBLIC_ARTIFACT_CONTAINS_SECRET");
    await expect(
      assertPublicArtifacts({
        ...options,
        context: f.context(),
        entries: [{ ...entries[0], classification: "synthetic" }],
      }),
    ).rejects.toThrow("PUBLIC_ARTIFACT_CONTAINS_SECRET");
  });
});
