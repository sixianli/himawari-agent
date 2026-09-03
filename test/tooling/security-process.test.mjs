import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ run: undefined, stream: undefined, tools: undefined }));
vi.mock("node:child_process", async (original) => {
  const actual = await original();
  return {
    ...actual,
    spawnSync: (command, args, options) =>
      command === "git"
        ? actual.spawnSync(command, args, options)
        : boundary.run(command, args, options),
    spawn: (command, args, options) => boundary.stream(command, args, options),
  };
});
vi.mock("../../scripts/ci/install-tools.mjs", async (original) => ({
  ...(await original()),
  verifyInstalledTools: () => {
    if (boundary.tools instanceof Error) throw boundary.tools;
    return boundary.tools;
  },
}));

import { runSecurityChecks } from "../../scripts/ci/check-security.mjs";
import { createContext } from "../../scripts/ci/context.mjs";
import { assertPublicArtifacts } from "../../scripts/ci/security-redaction.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directories = [];
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "himawari-security-process-"));
  directories.push(path);
  return path;
}
function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
function json(path, value) {
  write(path, JSON.stringify(value));
}
function securityFixture() {
  // Policy candidates are deliberately uncommitted: base has no CI policy, so this is initialization.
  const directory = temporary(),
    git = (...args) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic Security Boundary");
  git("config", "user.email", "fixture@example.invalid");
  write(join(directory, "packages/example/src/index.ts"), "const input = 1;\n");
  write(
    join(directory, "scripts/scan-machine-secrets.mjs"),
    "// synthetic scanner boundary fixture\n",
  );
  json(join(directory, "scripts/machine-secret-scan-baseline.json"), []);
  git("add", ".");
  git("commit", "-qm", "base source");
  mkdirSync(join(directory, "ci"));
  for (const name of ["policy.json", "coverage-policy.json", "toolchain-lock.json"])
    cpSync(join(root, "ci", name), join(directory, "ci", name));
  cpSync(join(root, "ci/rules"), join(directory, "ci/rules"), { recursive: true });
  json(join(directory, "ci/security-exceptions.json"), { schemaVersion: 1, exceptions: [] });
  json(join(directory, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { name: "synthetic-boundary" },
      "node_modules/example": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      },
    },
  });
  const state = {
    root: directory,
    mode: "passed",
    calls: [],
    context: createContext({ root: directory }),
    toolsDirectory: join(directory, "tools"),
    outputDirectory: ".ci-output/result",
  };
  boundary.tools = {
    executables: {
      node: "/synthetic/node",
      gitleaks: "/synthetic/gitleaks",
      semgrep: "/synthetic/semgrep",
      npmCli: join(root, "node_modules/npm/bin/npm-cli.js"),
    },
  };
  // semver lookup uses the actual installed dependency, without invoking npm or reaching a registry.
  boundary.tools.executables.npmCli = join(root, "node_modules/semver/package.json");
  boundary.run = (command, args, options) => {
    state.calls.push({ command, args, options });
    const complete = (status, stdout, stderr = "") => ({ status, stdout, stderr, signal: null });
    if (command === "/synthetic/node") {
      if (state.mode === "machine-invalid") return complete(0, "not-json");
      if (state.mode === "machine-finding")
        return complete(
          1,
          "",
          JSON.stringify({
            status: "failed",
            findings: [
              {
                file: "packages/example/src/index.ts",
                ruleId: "credential-assignment",
                digest: "a".repeat(64),
                count: 1,
              },
            ],
          }),
        );
      return complete(0, JSON.stringify({ status: "passed", scannedFiles: 12 }));
    }
    if (command === "/synthetic/gitleaks") {
      expect(args).toEqual(
        expect.arrayContaining(["--ignore-gitleaks-allow", "--redact=0", "--log-level", "info"]),
      );
      expect(options.env.TMPDIR).toBeDefined();
      const path = args[args.indexOf("--report-path") + 1];
      if (state.mode === "gitleaks-missing")
        return complete(0, "", "INF scanned ~1024 bytes (1.02 KB)");
      const findings =
        state.mode === "gitleaks-finding"
          ? [
              {
                RuleID: "generic-api-key",
                File: "packages/example/src/index.ts",
                StartLine: 1,
                Secret: ["probe", "unclassified", "credential"].join(""),
                Commit: state.context.baseSha,
              },
            ]
          : [];
      write(path, state.mode === "gitleaks-invalid" ? "not-json" : JSON.stringify(findings));
      const stderr =
        state.mode === "gitleaks-internal"
          ? "ERR git failed\nINF 0 commits scanned.\nINF scanned ~0 bytes (0)"
          : `INF 1 commits scanned.\nINF scanned ~1024 bytes (1.02 KB)\n${findings.length ? "WRN leaks found: 1" : "INF no leaks found"}`;
      return complete(findings.length ? 1 : 0, "", stderr);
    }
    if (command === "/synthetic/semgrep") {
      expect(args).toEqual(
        expect.arrayContaining([
          "--oss-only",
          "--strict",
          "--error",
          "--disable-nosem",
          "--metrics=off",
        ]),
      );
      const files = args.slice(args.indexOf("--json") + 1);
      if (state.mode === "semgrep-process")
        return { status: null, signal: "SIGKILL", error: new Error("synthetic kill") };
      const results =
        state.mode === "semgrep-finding"
          ? [
              {
                check_id: "himawari.dynamic-code-evaluation",
                path: files[0],
                start: { line: 1, offset: 0 },
                end: { offset: 5 },
                extra: { engine_kind: "OSS" },
              },
            ]
          : [];
      return complete(
        results.length ? 1 : 0,
        JSON.stringify({
          results,
          errors: state.mode === "semgrep-invalid" ? [{ type: "ParseError" }] : [],
          paths: { scanned: files },
        }),
      );
    }
    throw new Error("UNEXPECTED_SYNTHETIC_COMMAND");
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (state.mode === "advisory-network") throw new Error("synthetic offline");
      return new Response(
        JSON.stringify(
          state.mode === "advisory-high"
            ? {
                example: [
                  {
                    id: 1,
                    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
                    title: "Synthetic high advisory",
                    severity: "high",
                    vulnerable_versions: "<2.0.0",
                  },
                ],
              }
            : {},
        ),
        { status: 200 },
      );
    }),
  );
  return state;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  boundary.run = undefined;
  boundary.stream = undefined;
  boundary.tools = undefined;
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("安全runner的隔离外部边界", () => {
  it("四个扫描器成功产生新鲜、完整、脱敏且绑定context的报告", async () => {
    const f = securityFixture();
    const result = await runSecurityChecks(f);
    expect(result.status).toBe("passed");
    expect(result.checks.map((c) => c.id)).toEqual([
      "machine-secrets",
      "gitleaks",
      "semgrep",
      "npm-advisories",
    ]);
    const report = JSON.parse(readFileSync(result.reportPath));
    expect(report.context).toEqual(f.context);
    expect(report.scannedAt).toMatch(/Z$/);
    expect(Date.parse(report.completedAt)).toBeGreaterThanOrEqual(Date.parse(report.scannedAt));
    expect(report.exceptions.reviewStatus).toBe("no_exceptions");
    expect(result.reportSha256).toBe(sha(readFileSync(result.reportPath)));
    await expect(runSecurityChecks(f)).rejects.toThrow("SECURITY_REPORT_ALREADY_EXISTS");
  });
  it.each(["machine-finding", "gitleaks-finding", "semgrep-finding", "advisory-high"])(
    "%s必须阻断而不泄露原始匹配内容",
    async (mode) => {
      const f = securityFixture();
      f.mode = mode;
      const result = await runSecurityChecks(f);
      expect(result.status).toBe("failed");
      expect(result.findingCount).toBeGreaterThan(0);
      expect(readFileSync(result.reportPath, "utf8")).not.toContain(
        ["probe", "unclassified", "credential"].join(""),
      );
    },
  );
  it.each([
    "machine-invalid",
    "gitleaks-invalid",
    "gitleaks-internal",
    "gitleaks-missing",
    "semgrep-invalid",
    "semgrep-process",
    "advisory-network",
  ])("%s失败仍执行其他扫描器且不能写成功状态", async (mode) => {
    const f = securityFixture();
    f.mode = mode;
    const result = await runSecurityChecks(f);
    expect(result.status).toBe("infrastructure_failed");
    expect(result.checks).toHaveLength(4);
    expect(result.checks.some((c) => c.status === "passed")).toBe(true);
  });
  it("缺固定扫描器时明确preflight失败", async () => {
    const f = securityFixture();
    delete boundary.tools.executables.semgrep;
    const r = await runSecurityChecks(f);
    expect(r.status).toBe("infrastructure_failed");
    expect(r.checks[0].error).toBe("SECURITY_SCANNER_MISSING");
  });
  it("工具身份复验失败不能被吞掉", async () => {
    const f = securityFixture();
    boundary.tools = new Error("SYNTHETIC_IDENTITY_FAILED");
    const r = await runSecurityChecks(f);
    expect(r.status).toBe("infrastructure_failed");
    expect(r.checks[0].error).toBe("SYNTHETIC_IDENTITY_FAILED");
  });
});

function streamFixture({
  content = "synthetic public",
  chunks,
  exitCode = 0,
  pythonVersion = "Python 3.12.10",
  name = "public.txt",
  spawnError = false,
  stall = false,
  onSpawn = () => {},
} = {}) {
  const directory = temporary(),
    path = "artifact.tar.gz";
  write(join(directory, path), "synthetic archive bytes");
  boundary.run = (command, args) => {
    expect(command).toBe("/synthetic/python");
    expect(args).toEqual(["--version"]);
    return { status: 0, stdout: `${pythonVersion}\n` };
  };
  boundary.stream = (command, args, options) => {
    expect(command).toBe("/synthetic/python");
    expect(args.slice(0, 2)).toEqual(["-I", "-B"]);
    expect(args.slice(-2)).toEqual(["stream", join(directory, path)]);
    expect(options.env.PYTHONNOUSERSITE).toBe("1");
    const child = new EventEmitter();
    const payload = Buffer.concat([
      Buffer.from(`${JSON.stringify({ name, size: Buffer.byteLength(content) })}\n`),
      Buffer.from(content),
    ]);
    child.stdout = stall
      ? new Readable({ read() {} })
      : Readable.from(
          chunks ?? [payload.subarray(0, 4), payload.subarray(4, 12), payload.subarray(12)],
        );
    child.stderr = Readable.from([]);
    child.kill = () => {
      child.stdout.destroy();
      queueMicrotask(() => child.emit("close", null));
    };
    child.stdout.on("end", () => queueMicrotask(() => child.emit("close", exitCode)));
    if (spawnError) queueMicrotask(() => child.emit("error", new Error("synthetic process error")));
    onSpawn();
    return child;
  };
  return {
    root: directory,
    entries: [
      {
        path,
        kind: "artifact",
        classification: "synthetic",
        sha256: sha("synthetic archive bytes"),
      },
    ],
    allowed: [{ path, kind: "artifact" }],
    python: "/synthetic/python",
  };
}
describe("归档流式协议边界（不代替真实Python归档证据）", () => {
  it("子进程启动错误不能当作完整流", async () => {
    await expect(assertPublicArtifacts(streamFixture({ spawnError: true }))).rejects.toThrow(
      "PUBLIC_ARCHIVE_STREAM_INCOMPLETE",
    );
  });
  it("超时杀死未结束的流并清理timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let started;
    const spawned = new Promise((resolve) => {
      started = resolve;
    });
    const f = streamFixture({ stall: true, onSpawn: started });
    const outcome = assertPublicArtifacts(f).then(
      () => "unexpected success",
      (error) => error.message,
    );
    await spawned;
    await vi.advanceTimersByTimeAsync(300000);
    expect(await outcome).toBe("PUBLIC_ARCHIVE_STREAM_INCOMPLETE");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("跨chunk header/body扫描成功", async () => {
    const f = streamFixture();
    await expect(assertPublicArtifacts(f)).resolves.toEqual(f.entries);
  });
  it("成员哨兵被拒绝并停止子进程", async () => {
    const sentinel = "PUBLIC_SYNTHETIC_SENTINEL";
    const f = streamFixture({ content: sentinel });
    await expect(assertPublicArtifacts({ ...f, sentinels: [sentinel] })).rejects.toThrow(
      "PUBLIC_ARTIFACT_CONTAINS_SECRET",
    );
  });
  it.each([
    ["bad-header", { chunks: [Buffer.from("not-json\n")] }],
    ["long-header", { chunks: [Buffer.alloc(16384, 65)] }],
    ["truncated", { chunks: [Buffer.from('{"name":"safe.txt","size":20}\nshort')] }],
    ["empty", { chunks: [] }],
    ["failed-child", { exitCode: 1 }],
    ["unsafe-path", { name: "../private" }],
    ["wrong-python", { pythonVersion: "Python 3.13.0" }],
  ])("%s归档协议必须拒绝", async (_, options) => {
    await expect(assertPublicArtifacts(streamFixture(options))).rejects.toThrow();
  });
  it("构建归档必须显式固定Python", async () => {
    const f = streamFixture();
    f.python = "python3";
    await expect(assertPublicArtifacts(f)).rejects.toThrow("PUBLIC_ARCHIVE_LOCKED_PYTHON_REQUIRED");
  });
});
