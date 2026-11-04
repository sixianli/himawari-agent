import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateSecurityExceptions,
  verifySyntheticProvenance,
} from "../../scripts/ci/check-security.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const now = new Date("2026-11-04T12:00:00Z");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const vectorValue = ["fixture", "Vector", "0042", "abcd"].join("");
const pat = ["ghp", "_", "Fixture".repeat(5), "0"].join("");
const bearer = ["R2T99", "BEARER", "FIXTURE", "0001"].join("");
const revoked = ["Rv7k", "FixtureDevice", "Key01"].join("");
const threadId = "f504128e-d710-44e1-a304-6b61c370ef24";
const tmpfsOption = ["tmpfs", "size=1048576"].join("-");

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "himawari-exception-classes-"));
  roots.push(root);
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Security Fixture");
  git("config", "user.email", "fixture@example.invalid");
  write(
    root,
    "scripts/machine-secret-scan-baseline.json",
    JSON.stringify([
      { file: "test/eval.json", ruleId: "github-token", digest: sha256(pat), count: 1 },
      {
        file: "test/bearer.test.ts",
        ruleId: "authorization-bearer",
        digest: sha256(`Bearer ${bearer}`),
        count: 1,
        reason: `Synthetic bearer value ${bearer} for withholding tests`,
      },
    ]),
  );
  write(
    root,
    "ci/public-test-vectors.json",
    JSON.stringify([
      {
        digest: sha256(vectorValue),
        rules: ["generic-api-key"],
        source: "https://www.rfc-editor.org/rfc/rfc8291.txt",
        sourceLines: [422],
        description: "公开标准文档里的示例值，仅用于测试夹具。",
      },
    ]),
  );
  write(root, "test/vector.test.ts", `const authSecret = "${vectorValue}";\n`);
  write(root, "test/eval.json", `{"text": "my token is ${pat} ok"}\n`);
  write(root, "test/bearer.test.ts", `run("curl -H 'Authorization: Bearer ${bearer}' x");\n`);
  write(
    root,
    "test/probe.sh",
    `  --mount "type=tmpfs,destination=/work/secrets,${tmpfsOption}" \\\n`,
  );
  write(root, "docs-source/kept.ts", "export const kept = 1;\n");
  const blob = git("hash-object", "-w", join(root, "docs-source/kept.ts"));
  write(
    root,
    ".agents/tasks/demo/evidence.jsonl",
    `{"files": {"docs-source/kept.ts": "${blob}"}}\n`,
  );
  write(
    root,
    "scripts/operations/trace/README.md",
    `node run.mjs /var/lib/secrets thread:${threadId} 4\n`,
  );
  write(root, "test/old-push.test.ts", `const SECRET = { deviceKey: "${revoked}" };\n`);
  write(root, "test/evidence/raw/a.log", "archived log body\n");
  execFileSync("tar", ["-czf", "../raw-logs.tar.gz", "a.log"], {
    cwd: join(root, "test/evidence/raw"),
  });
  rmSync(join(root, "test/evidence/raw"), { recursive: true });
  const logDigest = sha256("archived log body\n");
  write(root, "test/evidence/archive-readback.json", `  "a.log": "${logDigest}",\n`);
  git("add", ".");
  git("commit", "-qm", "fixture sources");
  const sourceCommit = git("rev-parse", "HEAD");
  git(
    "rm",
    "-q",
    ".agents/tasks/demo/evidence.jsonl",
    "scripts/operations/trace/README.md",
    "test/old-push.test.ts",
  );
  git("commit", "-qm", "remove historical fixtures");
  const baseSha = git("rev-parse", "HEAD");
  return { root, git, sourceCommit, baseSha, blob, logDigest };
}

function entryFor(fixture, { classification, id, path, value, current = true, history = true }) {
  const occurrence = { sourceCommit: fixture.sourceCommit, lines: [1], count: 1 };
  const provenance = {
    classification,
    ...(current ? { current: { ...occurrence, sourceCommit: fixture.baseSha } } : {}),
    history: history ? [occurrence] : [],
  };
  const entry = {
    kind: "synthetic-secret",
    id,
    path,
    digest: sha256(value),
    count: (current ? 1 : 0) + (history ? 1 : 0),
    reason: "仓库所有者批准的精确测试或文档值。",
    owner: "sixianli",
    reviewReference: "https://github.com/sixianli/himawari-agent/pull/1#issuecomment-1",
    expiresAt: "2026-12-01T00:00:00Z",
    provenance,
  };
  const findings = [
    ...(current ? [{ scope: "current", commit: null }] : []),
    ...(history ? [{ scope: "history", commit: fixture.sourceCommit }] : []),
  ].map((scope) => ({
    kind: "secret",
    id,
    path,
    digest: entry.digest,
    line: 1,
    synthetic: false,
    blocking: true,
    ...scope,
  }));
  return { entry, findings };
}

function verify(fixture, spec) {
  const { entry, findings } = entryFor(fixture, spec);
  validateSecurityExceptions({ schemaVersion: 1, exceptions: [entry] }, { now });
  return verifySyntheticProvenance({
    root: fixture.root,
    baseSha: fixture.baseSha,
    entry,
    findings,
  });
}

describe("能从内容证明不是密钥的放行分类", () => {
  it("公开示例值表里登记过的值放行，表里没有或规则不符的拒绝", () => {
    const f = repository();
    const spec = {
      classification: "public-test-vector",
      id: "generic-api-key",
      path: "test/vector.test.ts",
      value: vectorValue,
    };
    expect(verify(f, spec)).toBe(true);
    expect(() => verify(f, { ...spec, id: "github-pat" })).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
    write(f.root, "test/vector.test.ts", `const authSecret = "${vectorValue}X";\n`);
    expect(() => verify(f, { ...spec, value: `${vectorValue}X` })).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
  });

  it("机器扫描基线已批准的同一个值可按规则对照放行，规则或值对不上拒绝", () => {
    const f = repository();
    const pathEntry = {
      classification: "machine-baseline-fixture",
      id: "github-pat",
      path: "test/eval.json",
      value: pat,
    };
    expect(verify(f, pathEntry)).toBe(true);
    expect(() => verify(f, { ...pathEntry, id: "generic-api-key" })).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
    const bearerEntry = {
      classification: "machine-baseline-fixture",
      id: "curl-auth-header",
      path: "test/bearer.test.ts",
      value: bearer,
    };
    expect(verify(f, bearerEntry)).toBe(true);
    write(f.root, "test/bearer.test.ts", `run("curl -H 'Authorization: Bearer ${bearer}Z' x");\n`);
    expect(() => verify(f, { ...bearerEntry, value: `${bearer}Z` })).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
  });

  it("值是仓库里真实存在的 git 文件对象时放行，随便一串 40 位十六进制拒绝", () => {
    const f = repository();
    const spec = {
      classification: "git-object-id",
      id: "generic-api-key",
      path: ".agents/tasks/demo/evidence.jsonl",
      value: f.blob,
      current: false,
    };
    expect(verify(f, spec)).toBe(true);
    const fake = "0123456789abcdef0123456789abcdef01234567";
    f.git("checkout", "-q", f.sourceCommit);
    write(
      f.root,
      ".agents/tasks/demo/evidence.jsonl",
      `{"files": {"docs-source/kept.ts": "${fake}"}}\n`,
    );
    f.git("commit", "-qam", "fake object id");
    const fakeCommit = f.git("rev-parse", "HEAD");
    f.git("rm", "-q", ".agents/tasks/demo/evidence.jsonl");
    f.git("commit", "-qm", "remove");
    const fixture = { ...f, sourceCommit: fakeCommit, baseSha: f.git("rev-parse", "HEAD") };
    expect(() => verify(fixture, { ...spec, value: fake })).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
  });

  it("文件摘要能从同目录日志压缩包重新算出时放行，算不出拒绝", () => {
    const f = repository();
    const spec = {
      classification: "archived-file-digest",
      id: "generic-api-key",
      path: "test/evidence/archive-readback.json",
      value: f.logDigest,
    };
    expect(verify(f, spec)).toBe(true);
    const other = sha256("not the archived body");
    write(f.root, "test/evidence/archive-readback.json", `  "a.log": "${other}",\n`);
    f.git("commit", "-qam", "wrong digest");
    const fixture = {
      ...f,
      sourceCommit: f.git("rev-parse", "HEAD"),
      baseSha: f.git("rev-parse", "HEAD"),
    };
    expect(() => verify(fixture, { ...spec, value: other })).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
  });

  it("“名字=纯数字”的参数放行，带字母的值拒绝", () => {
    const f = repository();
    const spec = {
      classification: "numeric-option",
      id: "generic-api-key",
      path: "test/probe.sh",
      value: tmpfsOption,
    };
    expect(verify(f, spec)).toBe(true);
    write(f.root, "test/probe.sh", `  --mount "tmpfs-size=10a48576" \\\n`);
    expect(() => verify(f, { ...spec, value: "tmpfs-size=10a48576" })).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
  });

  it("thread: 后面的会话编号放行，裸 UUID 拒绝", () => {
    const f = repository();
    const spec = {
      classification: "thread-id",
      id: "generic-api-key",
      path: "scripts/operations/trace/README.md",
      value: threadId,
      current: false,
    };
    expect(verify(f, spec)).toBe(true);
    f.git("checkout", "-q", f.sourceCommit);
    write(f.root, "scripts/operations/trace/README.md", `node run.mjs key=${threadId}\n`);
    f.git("commit", "-qam", "bare uuid");
    const bare = f.git("rev-parse", "HEAD");
    f.git("rm", "-q", "scripts/operations/trace/README.md");
    f.git("commit", "-qm", "remove");
    const fixture = { ...f, sourceCommit: bare, baseSha: f.git("rev-parse", "HEAD") };
    expect(() => verify(fixture, spec)).toThrow("REAL_SECRET_CANNOT_BE_EXCEPTED");
  });
});

describe("只登记历史和所有者确认作废", () => {
  it("文件已删除时可以只登记历史，文件还在时拒绝", () => {
    const f = repository();
    const spec = {
      classification: "numeric-option",
      id: "generic-api-key",
      path: "test/probe.sh",
      value: tmpfsOption,
      current: false,
    };
    expect(() => verify(f, spec)).toThrow("SECURITY_EXCEPTION_HISTORY_ONLY_INVALID");
  });

  it("原有的启动令牌分类不能只登记历史", () => {
    const f = repository();
    expect(() =>
      verify(f, {
        classification: "synthetic-boot-token",
        id: "generic-api-key",
        path: "test/old-push.test.ts",
        value: revoked,
        current: false,
      }),
    ).toThrow("SECURITY_EXCEPTION_HISTORY_ONLY_INVALID");
  });

  it("所有者确认作废只许已删文件的历史和通用规则", () => {
    const f = repository();
    const spec = {
      classification: "owner-confirmed-revoked",
      id: "generic-api-key",
      path: "test/old-push.test.ts",
      value: revoked,
      current: false,
    };
    expect(verify(f, spec)).toBe(true);
    expect(() => verify(f, { ...spec, id: "github-pat" })).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
    expect(() =>
      verify(f, { ...spec, path: "test/vector.test.ts", value: vectorValue, current: true }),
    ).toThrow("REAL_SECRET_CANNOT_BE_EXCEPTED");
  });

  it("测试目录以外的路径只对 git 文件编号和会话编号放开", () => {
    const f = repository();
    const base = entryFor(f, {
      classification: "git-object-id",
      id: "generic-api-key",
      path: "apps/agent-service/src/evidence.json",
      value: f.blob,
      current: false,
    }).entry;
    expect(() =>
      validateSecurityExceptions({ schemaVersion: 1, exceptions: [base] }, { now }),
    ).toThrow("REAL_SECRET_CANNOT_BE_EXCEPTED");
    const numeric = {
      ...base,
      path: ".agents/tasks/demo/probe.sh",
      provenance: { ...base.provenance, classification: "numeric-option" },
    };
    expect(() =>
      validateSecurityExceptions({ schemaVersion: 1, exceptions: [numeric] }, { now }),
    ).toThrow("REAL_SECRET_CANNOT_BE_EXCEPTED");
  });
});
