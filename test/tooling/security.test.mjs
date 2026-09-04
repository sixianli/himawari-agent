import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySecurityExceptions,
  enumerateLockDependencies,
  evaluateAdvisories,
  fetchAdvisories,
  loadReviewedExceptions,
  parseGitleaksReport,
  parseSemgrepReport,
  validateGitleaksExecution,
  validateSecurityExceptions,
  verifySyntheticProvenance,
} from "../../scripts/ci/check-security.mjs";
import { assertPublicArtifacts, redactText } from "../../scripts/ci/security-redaction.mjs";
import { findBuildSecrets } from "../../scripts/ci/security-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const semver = createRequire(import.meta.url)("semver");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const temporaryDirectories = [];
const now = new Date("2026-09-03T12:00:00Z");
const ruleIds = ["himawari.dynamic-code-evaluation"];
const dependencies = [
  { path: "node_modules/example", name: "example", version: "1.2.0", dev: false },
  {
    path: "node_modules/parent/node_modules/example",
    name: "example",
    version: "1.3.0",
    dev: true,
  },
  { path: "node_modules/new-example", name: "example", version: "2.0.0", dev: false },
];

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "himawari-security-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function exception(overrides = {}) {
  return {
    kind: "advisory",
    id: "GHSA-aaaa-bbbb-cccc",
    path: dependencies[0].path,
    package: "example",
    version: "1.2.0",
    reason: "测试中构造的精确审阅例外，不会写入正式例外。",
    owner: "fixture-owner",
    reviewReference: "https://github.com/example/repository/pull/1",
    expiresAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function advisory(severity = "high") {
  return {
    id: 1234567,
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    title: "Synthetic vulnerability fixture",
    severity,
    vulnerable_versions: "<2.0.0",
  };
}

function secretFinding(secret = "fixture-token-value") {
  return {
    RuleID: "generic-api-key",
    File: "test/fixture.ts",
    Secret: secret,
    StartLine: 2,
    Commit: "a".repeat(40),
  };
}

function provenanceFixture() {
  const directory = temporary();
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Security Fixture");
  git("config", "user.email", "fixture@example.invalid");
  json(join(directory, "scripts/machine-secret-scan-baseline.json"), []);
  const literal = "synthetic-request-deduplication";
  mkdirSync(join(directory, "test"));
  writeFileSync(join(directory, "test/fixture.ts"), `const idempotencyKey = "${literal}";\n`);
  git("add", ".");
  git("commit", "-qm", "synthetic source");
  const baseSha = git("rev-parse", "HEAD");
  const occurrence = { sourceCommit: baseSha, lines: [1], count: 1 };
  const entry = {
    kind: "synthetic-secret",
    id: "generic-api-key",
    path: "test/fixture.ts",
    digest: sha256(literal),
    count: 2,
    reason: "合成幂等去重测试值的精确初始化提案。",
    owner: "sixianli",
    reviewReference: `https://github.com/example/repository/commit/${baseSha}`,
    expiresAt: "2026-10-03T00:00:00Z",
    provenance: {
      classification: "idempotency-fixture",
      current: occurrence,
      history: [{ ...occurrence }],
    },
  };
  const findings = ["current", "history"].map((scope) => ({
    kind: "secret",
    id: entry.id,
    path: entry.path,
    digest: entry.digest,
    line: 1,
    scope,
    commit: scope === "history" ? baseSha : null,
    synthetic: false,
    blocking: true,
  }));
  return { root: directory, baseSha, entry, findings };
}

function zip(name, content) {
  const bytes = Buffer.from(content);
  const compressed = deflateRawSync(bytes);
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("构建包源码与日志有各自的检测语义", () => {
  const literal = ["synthetic", "private", "credential"].join("_");
  const scan = (bytes, name = "source.ts", sentinels = []) =>
    findBuildSecrets({ name, bytes, sentinels });
  it("保留代码变量、函数调用、类型与短占位符", () => {
    const code = [
      "const apiKey = ",
      "resolveApiKey(options); const result = { api_key: ",
      "credential.value }; interface C { client_secret: ",
      'ClientSecretType; } const password = "short";',
    ].join("");
    expect(scan(code)).toEqual([]);
    expect(redactText(code)).not.toBe(code);
  });
  it.each([
    (v) => `const apiKey = "${v}";`,
    (v) => `const x = { "api_key": '${v}' };`,
    (v) => `config.access_token = '${v}';`,
    (v) => `config['refreshToken'] = '${v}';`,
    (v) => `const { password = '${v}' } = config;`,
    (v) => `class X { clientSecret = '${v}'; }`,
    (v) => `const webhookSecret = ('${v}' as const);`,
    (v) => `const apiKey = <string>'${v}';`,
    (v) => `const password = '${v}' satisfies string;`,
    (v) => `const apiKey = '${v}' + variable;`,
    (v) => `const apiKey = \`${v}\`;`,
    (v) => `const apiKey = \`${v}\${variable}\`;`,
  ])("语法树只把赋值字符串作为credential字面量", (code) => {
    const findings = scan(code(literal));
    expect(
      findings.some(
        (finding) => finding.rule === "credential-literal" && finding.digest === sha256(literal),
      ),
    ).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(literal);
  });
  it("JSON及source map嵌入源码仍检测解码后的字面量", () => {
    expect(redactText(JSON.stringify({ password: literal }))).not.toContain(literal);
    expect(
      scan(JSON.stringify({ auth: { password: literal }, irrelevant: 12 }), "config.json"),
    ).toHaveLength(1);
    expect(
      scan(
        JSON.stringify({
          version: 3,
          sources: ["input.ts"],
          sourcesContent: [`const apiKey = '${literal}';`],
        }),
        "source.js.map",
      ),
    ).toHaveLength(1);
    expect(scan("null", "null.json")).toEqual([]);
    expect(
      scan(
        '{ // JSONC configuration\n "compilerOptions": { "strict": true, },\n}',
        "tsconfig.json",
      ),
    ).toEqual([]);
    expect(scan(`{ /* JSONC literal */ "password": "${literal}", }`, "config.json")).toHaveLength(
      1,
    );
    expect(
      scan(
        ['interface Config { client_secret: "', 'public-protocol-type"; }'].join(""),
        "index.d.cts",
      ),
    ).toEqual([]);
    expect(scan(`const apiKey = "${literal}";`, "index.mts")).toHaveLength(1);
  });
  it("文档引用不误判，完整quoted/配置值继续检测", () => {
    expect(scan(["apiKey: ", "readCredentialFromEnv()"].join(""), "README.md")).toEqual([]);
    expect(scan(`apiKey: '${literal}'`, "README.md")).toHaveLength(1);
    expect(scan(`password=${literal}\n`, ".env.example")).toHaveLength(1);
  });
  it("credential常量拼接不能通过把字面量拆短来绕过", () => {
    expect(scan('const password = "part-one" + "part-two";')[0].digest).toBe(
      sha256("part-onepart-two"),
    );
  });
  it("unknown binary也检查完整token与sentinel且只输出摘要", () => {
    const token = `ghp_${"A0b1".repeat(9)}`;
    expect(
      scan(Buffer.from(`\0${token}\0`), "binary.bin").some(
        (finding) => finding.rule === "github-token",
      ),
    ).toBe(true);
    expect(
      scan("public marker", "binary.bin", ["marker"]).some(
        (finding) => finding.rule === "sentinel",
      ),
    ).toBe(true);
    expect(() => scan("", "binary.bin", [""])).toThrow("PUBLIC_SENTINEL_INVALID");
  });
  it.each([
    ["const apiKey = ;", "bad.js"],
    ["{broken", "bad.json"],
  ])("源码或结构解析失败保持关闭", (bytes, name) => {
    expect(() => scan(bytes, name)).toThrow("PUBLIC_SOURCE_PARSE_FAILED");
  });
});

describe("完整锁文件与官方 advisory", () => {
  it("枚举所有生产、开发、传递与其他平台依赖", () => {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
    const actual = enumerateLockDependencies(lock);
    const expected = Object.entries(lock.packages).filter(
      ([path, entry]) => path.includes("node_modules/") && !entry.link,
    );
    expect(actual).toHaveLength(expected.length);
    expect(actual.some((entry) => entry.dev)).toBe(true);
    expect(actual.some((entry) => entry.optional)).toBe(true);
    expect(actual.some((entry) => entry.path.includes("pi-coding-agent/node_modules/"))).toBe(true);
  });

  it("空锁文件不能当作零漏洞", () => {
    expect(() => enumerateLockDependencies({ lockfileVersion: 3, packages: {} })).toThrow(
      "ADVISORY_EMPTY_LOCK",
    );
  });

  it.each(["info", "low", "moderate", "high", "critical"])(
    "逐实际版本判定 %s advisory，保留开发依赖",
    (severity) => {
      const findings = evaluateAdvisories({
        response: { example: [advisory(severity)] },
        dependencies,
        ...semver,
      });
      expect(findings).toHaveLength(2);
      expect(
        findings.every((finding) => finding.blocking === ["high", "critical"].includes(severity)),
      ).toBe(true);
      expect(findings.map((finding) => finding.version)).toEqual(["1.2.0", "1.3.0"]);
    },
  );

  it.each([
    ["未知package", { unknown: [advisory()] }],
    ["缺字段", { example: [{ id: 1 }] }],
    ["非法severity", { example: [advisory("none")] }],
    ["非法范围", { example: [{ ...advisory(), vulnerable_versions: "invalid" }] }],
    ["重复finding", { example: [advisory(), advisory()] }],
  ])("拒绝%s响应", (_, response) => {
    expect(() => evaluateAdvisories({ response, dependencies, ...semver })).toThrow();
  });

  it("零漏洞响应仍记录完整请求数量、UTC和请求响应摘要", async () => {
    let request;
    const result = await fetchAdvisories({
      dependencies,
      ...semver,
      now,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response("{}", { status: 200 });
      },
    });
    expect(result.scannedCount).toBe(3);
    expect(result.fetchedAt).toBe(now.toISOString());
    expect(result.responseSha256).toBe(sha256("{}"));
    expect(request.url).toBe("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk");
    expect(request.options.method).toBe("POST");
    expect(request.options.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(request.options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request.options.body)).toEqual({ example: ["1.2.0", "1.3.0", "2.0.0"] });
    expect(result.findings).toEqual([]);
  });

  it("单次 fetch 失败只保留三层已知网络身份与请求摘要", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("private message", {
        cause: Object.assign(new Error("private nested"), {
          code: "EAI_AGAIN",
          cause: Object.assign(new Error("third"), {
            code: "ECONNRESET",
            cause: new Error("fourth must not appear"),
          }),
        }),
      });
    });
    const error = await fetchAdvisories({ dependencies, ...semver, fetchImpl }).catch((e) => e);
    expect(error.message).toBe("ADVISORY_NETWORK_UNAVAILABLE");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, options] = fetchImpl.mock.calls[0];
    expect(error.diagnostic).toEqual({
      endpoint,
      requestSha256: sha256(options.body),
      timeoutMs: 60000,
      elapsedMs: expect.any(Number),
      phase: "fetch-response",
      signal: { aborted: false, reason: null },
      errors: [
        { name: "TypeError", code: "unknown" },
        { name: "Error", code: "EAI_AGAIN" },
        { name: "Error", code: "ECONNRESET" },
      ],
    });
    expect(error.diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(error)).not.toMatch(/private|fourth/);
  });

  it.each(["TimeoutError", "AbortError"])("记录 %s 的 signal，仍请求固定 60000ms", async (name) => {
    const reason = new DOMException("private timeout detail", name);
    const controller = new AbortController();
    controller.abort(reason);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const error = await fetchAdvisories({
      dependencies,
      ...semver,
      fetchImpl: async () => {
        throw reason;
      },
    }).catch((e) => e);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(60000);
    expect(error.diagnostic.signal).toEqual({ aborted: true, reason: { name, code: reason.code } });
    expect(error.diagnostic.errors).toEqual([{ name, code: reason.code }]);
    expect(JSON.stringify(error)).not.toContain("private timeout detail");
  });

  it.each([null, { name: "untrusted-name", code: "untrusted-code", message: "untrusted-message" }])(
    "未知异常字段不能进入公开诊断 %#",
    async (thrown) => {
      const controller = new AbortController();
      controller.abort(thrown);
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      const error = await fetchAdvisories({
        dependencies,
        ...semver,
        fetchImpl: async () => {
          throw thrown;
        },
      }).catch((e) => e);
      expect(error.diagnostic.errors).toEqual([{ name: "unknown", code: "unknown" }]);
      expect(error.diagnostic.signal.reason).toEqual({ name: "unknown", code: "unknown" });
      expect(JSON.stringify(error)).not.toContain("untrusted");
    },
  );

  it("读取响应体失败保留独立阶段并继续失败，不重发请求", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => {
        throw Object.assign(new Error("private body"), { code: "UND_ERR_BODY_TIMEOUT" });
      },
    }));
    const error = await fetchAdvisories({ dependencies, ...semver, fetchImpl }).catch((e) => e);
    expect(error.message).toBe("ADVISORY_RESPONSE_BODY_UNAVAILABLE");
    expect(error.diagnostic.phase).toBe("response-body");
    expect(error.diagnostic.errors).toEqual([{ name: "Error", code: "UND_ERR_BODY_TIMEOUT" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toContain("private body");
  });

  it.each([
    [
      "网络失败",
      async () => {
        throw new Error("offline");
      },
    ],
    ["限流", async () => new Response("{}", { status: 429 })],
    ["空响应", async () => new Response("", { status: 200 })],
    ["截断响应", async () => new Response('{"example":', { status: 200 })],
  ])("%s必须失败", async (_, fetchImpl) => {
    await expect(fetchAdvisories({ dependencies, ...semver, fetchImpl })).rejects.toThrow();
  });
});

describe("受审阅的窄范围例外", () => {
  it("初始化合成提案复验源码提交、字面量与每个范围，保留待Owner状态", () => {
    const fixture = provenanceFixture();
    const value = {
      schemaVersion: 1,
      proposal: {
        status: "proposed_owner_review_required",
        proposedAt: "2026-09-03T00:00:00Z",
        owner: "sixianli",
        reviewEvidence: "初始化测试的源码审阅依据；等待Owner逐条审阅并合入。",
      },
      exceptions: [fixture.entry],
    };
    expect(validateSecurityExceptions(value, { now })).toHaveLength(1);
    expect(verifySyntheticProvenance(fixture)).toBe(true);
    expect(
      applySecurityExceptions(fixture.findings, [fixture.entry], fixture).every(
        (finding) => finding.excepted,
      ),
    ).toBe(true);
    value.exceptions[0].expiresAt = "2026-10-04T00:00:00Z";
    expect(() => validateSecurityExceptions(value, { now })).toThrow(
      "SECURITY_PROPOSAL_SCOPE_INVALID",
    );
  });

  it.each(["literal", "classification", "history", "count", "source"])(
    "合成来源%s改变必须拒绝",
    (change) => {
      const fixture = provenanceFixture();
      if (change === "literal")
        writeFileSync(
          join(fixture.root, "test/fixture.ts"),
          'const idempotencyKey = "different";\n',
        );
      if (change === "classification")
        fixture.entry.provenance.classification = "synthetic-boot-token";
      if (change === "history") fixture.findings[1].commit = "b".repeat(40);
      if (change === "count") fixture.findings.push({ ...fixture.findings[0] });
      if (change === "source") fixture.entry.provenance.current.sourceCommit = "b".repeat(40);
      expect(() => verifySyntheticProvenance(fixture)).toThrow();
    },
  );

  it("首次提案不能夹带advisory或无来源的secret豁免", () => {
    const value = {
      schemaVersion: 1,
      proposal: {
        status: "proposed_owner_review_required",
        proposedAt: "2026-09-03T00:00:00Z",
        owner: "fixture-owner",
        reviewEvidence: "合成测试提案，不能作为初始漏洞审阅证明。",
      },
      exceptions: [exception()],
    };
    expect(() => validateSecurityExceptions(value, { now, dependencies })).toThrow(
      "SECURITY_PROPOSAL_SCOPE_INVALID",
    );
    const { entry } = provenanceFixture();
    delete entry.provenance;
    expect(() =>
      validateSecurityExceptions({ schemaVersion: 1, exceptions: [entry] }, { now }),
    ).toThrow();
  });
  it("接纳精确、未到期并有审阅引用的advisory", () => {
    expect(
      validateSecurityExceptions(
        { schemaVersion: 1, exceptions: [exception()] },
        { now, ruleIds, dependencies },
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["到期", { expiresAt: "2026-09-03T00:00:00Z" }],
    ["非法日期", { expiresAt: "2026-02-30T00:00:00Z" }],
    ["通配路径", { path: "node_modules/**" }],
    ["扩大版本", { version: "^1.2.0" }],
    ["未知依赖", { package: "unknown" }],
    ["无审阅引用", { reviewReference: "local-note" }],
    ["未知字段", { approved: true }],
  ])("拒绝%s", (_, overrides) => {
    expect(() =>
      validateSecurityExceptions(
        { schemaVersion: 1, exceptions: [exception(overrides)] },
        { now, ruleIds, dependencies },
      ),
    ).toThrow();
  });

  it("重复记录拒绝", () => {
    expect(() =>
      validateSecurityExceptions(
        { schemaVersion: 1, exceptions: [exception(), exception()] },
        { now, ruleIds, dependencies },
      ),
    ).toThrow("SECURITY_EXCEPTION_DUPLICATE");
  });

  it("真实Secret不能被fixture路径或匹配digest豁免", () => {
    const finding = {
      kind: "secret",
      id: "generic-api-key",
      path: "test/fixture.ts",
      digest: "a".repeat(64),
      synthetic: false,
      blocking: true,
    };
    const entry = {
      kind: "synthetic-secret",
      id: finding.id,
      path: finding.path,
      digest: finding.digest,
      count: 1,
    };
    expect(() => applySecurityExceptions([finding], [entry])).toThrow(
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
  });

  it("精确合成样例也不能增加出现次数", () => {
    const finding = {
      kind: "secret",
      id: "generic-api-key",
      path: "test/fixture.ts",
      digest: "a".repeat(64),
      synthetic: true,
      blocking: true,
    };
    const entry = {
      kind: "synthetic-secret",
      id: finding.id,
      path: finding.path,
      digest: finding.digest,
      count: 1,
    };
    expect(applySecurityExceptions([finding], [entry])[0].excepted).toBe(true);
    expect(() => applySecurityExceptions([finding, finding], [entry])).toThrow(
      "SECURITY_EXCEPTION_SCOPE_EXPANDED",
    );
  });

  it("未知或已失效finding不能保留例外", () => {
    expect(() => applySecurityExceptions([], [exception()])).toThrow(
      "SECURITY_EXCEPTION_FINDING_UNKNOWN",
    );
  });

  it("候选分支自加例外不改变受审阅base", () => {
    const directory = temporary();
    const git = (...args) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    git("config", "user.name", "Security Fixture");
    git("config", "user.email", "fixture@example.invalid");
    mkdirSync(join(directory, "ci"));
    cpSync(join(root, "ci/policy.json"), join(directory, "ci/policy.json"));
    const coverage = JSON.parse(readFileSync(join(root, "ci/coverage-policy.json")));
    coverage.baseline = {
      sourceSha: "a".repeat(40),
      sourceTreeSha256: "b".repeat(64),
      reportSha256: "c".repeat(64),
      groups: {
        "scripts/ci": Object.fromEntries(
          ["lines", "branches", "functions", "statements"].map((name) => [
            name,
            { total: 1, covered: 1, pct: 100 },
          ]),
        ),
      },
    };
    json(join(directory, "ci/coverage-policy.json"), coverage);
    json(join(directory, "ci/security-exceptions.json"), { schemaVersion: 1, exceptions: [] });
    git("add", "ci");
    git("commit", "-qm", "accepted policies");
    const baseSha = git("rev-parse", "HEAD");
    json(join(directory, "ci/security-exceptions.json"), {
      schemaVersion: 1,
      exceptions: [exception()],
    });
    const result = loadReviewedExceptions({
      root: directory,
      context: { baseSha, initialization: false },
      now,
      ruleIds,
      dependencies,
    });
    expect(result.exceptions).toEqual([]);
    expect(result.candidateDiffers).toBe(true);
    rmSync(join(directory, "ci/security-exceptions.json"));
    expect(() =>
      loadReviewedExceptions({
        root: directory,
        context: { baseSha, initialization: false },
        now,
        ruleIds,
        dependencies,
      }),
    ).toThrow();
  });
});

describe("scanner报告失败语义", () => {
  it("Gitleaks内部git报错且exit0也必须失败", () => {
    expect(() =>
      validateGitleaksExecution({
        stderr: 'ERR error="stderr is not empty"\nINF 0 commits scanned.\nINF scanned ~0 bytes (0)',
        scope: "history",
        expectedCommits: 2,
      }),
    ).toThrow("GITLEAKS_INTERNAL_EXECUTION_FAILED");
  });
  it.each([
    "",
    "INF 0 commits scanned.\nINF scanned ~0 bytes (0)",
    "INF 0 commits scanned.\nINF scanned ~1024 bytes (1.02 KB)",
  ])("Gitleaks空或缺执行计数不能假阳性通过", (stderr) => {
    expect(() =>
      validateGitleaksExecution({ stderr, scope: "history", expectedCommits: 2 }),
    ).toThrow();
  });
  it("Gitleaks真实执行计数支持无新增行的提交不计入", () => {
    expect(
      validateGitleaksExecution({
        stderr: "INF 1 commits scanned.\nINF scanned ~1024 bytes (1.02 KB)",
        scope: "history",
        expectedCommits: 2,
      }),
    ).toEqual({ scannedBytes: 1024, scannedCommits: 1 });
  });
  it("历史删除泄漏的报告仍为secret finding且不输出secret", () => {
    const secret = "ghp_" + "HIMAWARISYNTHETICONLY" + "0123456789abcdef";
    const result = parseGitleaksReport({
      bytes: JSON.stringify([secretFinding(secret)]),
      exitCode: 1,
      sourceRoot: "/snapshot",
      scannedCount: 2,
      scope: "history",
    });
    expect(result[0].blocking).toBe(true);
    expect(result[0].synthetic).toBe(true);
    expect(result[0].scope).toBe("history");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result[0].digest).toBe(sha256(secret));
  });

  it.each([
    ["报告缺失", "", 0, 1],
    ["工具异常", "[]", 2, 1],
    ["空扫描", "[]", 0, 0],
    ["退出码吞掉finding", JSON.stringify([secretFinding()]), 0, 1],
    ["失败伪装无finding", "[]", 1, 1],
  ])("Gitleaks拒绝%s", (_, bytes, exitCode, scannedCount) => {
    expect(() =>
      parseGitleaksReport({
        bytes,
        exitCode,
        scannedCount,
        sourceRoot: "/snapshot",
        scope: "current",
      }),
    ).toThrow();
  });

  function semgrepReport() {
    return { results: [], errors: [], paths: { scanned: ["apps/example/src/index.ts"] } };
  }

  it("Semgrep按源码字节重建摘要，不依赖CE隐藏的lines/fingerprint", () => {
    const report = semgrepReport();
    report.results.push({
      check_id: ruleIds[0],
      path: report.paths.scanned[0],
      start: { line: 1, offset: 0 },
      end: { offset: 11 },
      extra: { engine_kind: "OSS", lines: "requires login", fingerprint: "requires login" },
    });
    const findings = parseSemgrepReport({
      bytes: JSON.stringify(report),
      exitCode: 1,
      expectedFiles: report.paths.scanned,
      ruleIds,
      readSource: () => "eval(input);",
    });
    expect(findings[0].digest).toBe(sha256("eval(input)"));
  });

  it.each([
    [
      "解析错误",
      (report) => {
        report.errors.push({ type: "ParseError" });
      },
    ],
    [
      "空扫描",
      (report) => {
        report.paths.scanned = [];
      },
    ],
    [
      "漏扫文件",
      (report) => {
        report.paths.scanned = ["other.ts"];
      },
    ],
    [
      "重复文件",
      (report) => {
        report.paths.scanned.push(report.paths.scanned[0]);
      },
    ],
  ])("Semgrep拒绝%s", (_, mutate) => {
    const report = semgrepReport();
    mutate(report);
    expect(() =>
      parseSemgrepReport({
        bytes: JSON.stringify(report),
        exitCode: 0,
        expectedFiles: ["apps/example/src/index.ts"],
        ruleIds,
      }),
    ).toThrow();
  });

  it("Semgrep报告缺失不能通过", () => {
    expect(() =>
      parseSemgrepReport({ bytes: "", exitCode: 0, expectedFiles: ["x.ts"], ruleIds }),
    ).toThrow("SEMGREP_REPORT_INVALID");
  });
});

describe("公开输出白名单与敏感哨兵", () => {
  const sentinel = "HIMAWARI_PRIVATE_CONTENT_SENTINEL";

  it("正常和失败日志均去除凭据及显式敏感哨兵", () => {
    const token = `ghp_${"A".repeat(36)}`;
    for (const status of ["passed", "failed"]) {
      const output = redactText(JSON.stringify({ status, stdout: token, stderr: sentinel }), {
        sentinels: [sentinel],
      });
      expect(output).not.toContain(token);
      expect(output).not.toContain(sentinel);
      expect(output).toContain("[REDACTED]");
    }
  });

  async function verify(
    bytes,
    { path = "report.json", kind = "json", classification = "redacted", allowed, digest } = {},
  ) {
    const directory = temporary();
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes);
    return assertPublicArtifacts({
      root: directory,
      entries: [{ path, kind, classification, sha256: digest ?? sha256(bytes) }],
      allowed: allowed ?? [{ path, kind }],
      sentinels: [sentinel],
    });
  }

  it("精确白名单中干净报告可以发布", async () => {
    await expect(verify('{"status":"passed"}')).resolves.toHaveLength(1);
  });

  it("不允许新增任意工作区文件", async () => {
    await expect(
      verify("clean", { allowed: [{ path: "other.json", kind: "json" }] }),
    ).rejects.toThrow("PUBLIC_ARTIFACT_NOT_ALLOWLISTED");
  });

  it("路径正确但digest变化也拒绝", async () => {
    await expect(verify("changed", { digest: "a".repeat(64) })).rejects.toThrow(
      "PUBLIC_ARTIFACT_DIGEST_MISMATCH",
    );
  });

  it("不能发布真实状态或声称真实截图已脱敏", async () => {
    await expect(verify("clean", { path: "state/data.json" })).rejects.toThrow(
      "PUBLIC_ARTIFACT_FORBIDDEN_SOURCE",
    );
    await expect(
      verify("clean", { path: "capture.png", kind: "screenshot", classification: "redacted" }),
    ).rejects.toThrow("PUBLIC_ARTIFACT_CLASSIFICATION_INVALID");
  });

  it("截图二进制或元数据里的哨兵不能发布", async () => {
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from(sentinel),
    ]);
    await expect(
      verify(png, { path: "capture.png", kind: "screenshot", classification: "synthetic" }),
    ).rejects.toThrow("PUBLIC_ARTIFACT_CONTAINS_SECRET");
  });

  it("压缩trace中的哨兵也必须被发现", async () => {
    const trace = zip("events.trace", JSON.stringify({ body: sentinel }));
    await expect(
      verify(trace, { path: "trace.zip", kind: "trace", classification: "synthetic" }),
    ).rejects.toThrow("PUBLIC_ARTIFACT_CONTAINS_SECRET");
  });

  it("干净压缩trace可以发布，路径穿越不能", async () => {
    await expect(
      verify(zip("events.trace", '{"status":"passed"}'), {
        path: "trace.zip",
        kind: "trace",
        classification: "synthetic",
      }),
    ).resolves.toHaveLength(1);
    await expect(
      verify(zip("../escape", "clean"), {
        path: "trace.zip",
        kind: "trace",
        classification: "synthetic",
      }),
    ).rejects.toThrow("PUBLIC_ARCHIVE_PATH_INVALID");
  });

  it("gzip包裹内容不能绕过哨兵检查", async () => {
    await expect(
      verify(gzipSync(sentinel), { path: "diagnostic.gz", kind: "log" }),
    ).rejects.toThrow("PUBLIC_ARTIFACT_CONTAINS_SECRET");
  });

  it("符号链接不进入公开上传列表", async () => {
    const directory = temporary();
    writeFileSync(join(directory, "real.json"), "clean");
    symlinkSync(join(directory, "real.json"), join(directory, "link.json"));
    await expect(
      assertPublicArtifacts({
        root: directory,
        entries: [
          { path: "link.json", kind: "json", classification: "redacted", sha256: sha256("clean") },
        ],
        allowed: [{ path: "link.json", kind: "json" }],
      }),
    ).rejects.toThrow("PUBLIC_ARTIFACT_SYMLINK_OR_NOT_FILE");
  });
});
