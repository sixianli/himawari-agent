import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditInstalledDependencies,
  auditManifestDependencies,
  probeSqlite,
} from "../../scripts/ci/install-dependencies.mjs";
import {
  downloadArtifact,
  isolatedEnvironment,
  loadToolchainLock,
  validateToolchainLock,
  verifyDownload,
} from "../../scripts/ci/install-tools.mjs";
import { runnerTracking } from "../../scripts/ci/runner-tracking.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories = [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "himawari-toolchain-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function npmFixture() {
  const directory = temporary();
  mkdirSync(join(directory, "packages"));
  const manifest = { name: "fixture", version: "0.0.0", workspaces: ["packages/*"] };
  writeJson(join(directory, "package.json"), manifest);
  const lock = { lockfileVersion: 3, packages: { "": manifest } };
  const addPackage = (name, version, path = `node_modules/${name}`, scripts = {}) => {
    writeJson(join(directory, path, "package.json"), { name, version, scripts });
    lock.packages[path] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
      integrity,
    };
  };
  addPackage("@earendil-works/pi-ai", "0.84.2");
  addPackage("@earendil-works/pi-coding-agent", "0.84.2");
  addPackage("@earendil-works/pi-telemetry", "0.84.3");
  const save = () => writeJson(join(directory, "package-lock.json"), lock);
  save();
  return { directory, lock, save, addPackage, toolchain: { nativeDependencies: [] } };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("固定工具身份", () => {
  it("通过符号路径调用 CLI 仍执行检查", () => {
    const path = join(temporary(), "install-tools.mjs");
    symlinkSync(join(root, "scripts/ci/install-tools.mjs"), path);
    expect(execFileSync(process.execPath, [path, "--check"], { encoding: "utf8" })).toContain(
      "ToolchainLock validation passed",
    );
  });
  it("锁定每个平台、完整 Action SHA、扫描工具和 wheel 闭包", () => {
    const lock = loadToolchainLock(root);
    expect(validateToolchainLock(lock)).toBe(lock);
    expect(lock.actions.map((action) => action.repository).sort()).toEqual([
      "actions/cache",
      "actions/checkout",
      "actions/setup-node",
      "actions/setup-python",
    ]);
    expect(() =>
      validateToolchainLock({
        ...lock,
        actions: [...lock.actions, { ...lock.actions[0], repository: "actions/upload-artifact" }],
      }),
    ).toThrow("Action 集合缺失、重复或未知");
    expect(lock.tools.semgrep.wheels["linux-x64"].length).toBeGreaterThan(1);
    expect(lock.tools.semgrep.wheels["darwin-arm64"].length).toBeGreaterThan(1);
  });

  it.each([
    [
      "未知字段",
      (lock) => {
        lock.unknown = true;
      },
    ],
    [
      "浮动 Node",
      (lock) => {
        lock.node.baseline = "22";
      },
    ],
    [
      "缩写 SHA",
      (lock) => {
        lock.actions[0].sha = "abcdef0";
      },
    ],
    [
      "重复 Action",
      (lock) => {
        lock.actions.push(lock.actions[0]);
      },
    ],
    [
      "缺失平台",
      (lock) => {
        delete lock.python.artifacts["linux-x64"];
      },
    ],
    [
      "非官方源",
      (lock) => {
        lock.npm.artifact.url = "https://example.com/npm-11.8.0.tgz";
      },
    ],
    [
      "缺失许可证据",
      (lock) => {
        delete lock.tools.gitleaks.license;
      },
    ],
    [
      "空 wheel 闭包",
      (lock) => {
        lock.tools.semgrep.wheels["linux-x64"] = [];
      },
    ],
    [
      "重复 wheel",
      (lock) => {
        lock.tools.semgrep.wheels["linux-x64"].push(lock.tools.semgrep.wheels["linux-x64"][0]);
      },
    ],
  ])("拒绝%s", (_, mutate) => {
    const lock = loadToolchainLock(root);
    mutate(lock);
    expect(() => validateToolchainLock(lock)).toThrow();
  });

  it("下载内容变化时摘要校验失败", () => {
    const bytes = Buffer.from("original artifact");
    const artifact = { filename: "tool.tar.gz", sha256: sha256(bytes) };
    expect(verifyDownload(bytes, artifact)).toBe(artifact.sha256);
    expect(() => verifyDownload(Buffer.from("tampered artifact"), artifact)).toThrow(
      "下载摘要不匹配",
    );
  });

  it("损坏的缓存下载物也必须失败", async () => {
    const directory = temporary();
    writeFileSync(join(directory, "tool.tar.gz"), "corrupt cache");
    await expect(
      downloadArtifact(
        {
          filename: "tool.tar.gz",
          url: "https://github.com/example/tool/releases/download/v1/tool.tar.gz",
          sha256: sha256("expected"),
        },
        directory,
        { cacheDirectory: null },
      ),
    ).rejects.toThrow("下载摘要不匹配");
  });

  describe("网络下载重试", () => {
    const bytes = Buffer.from("published artifact");
    const expected = {
      filename: "tool.tar.gz",
      url: "https://nodejs.org/dist/v1/tool.tar.gz",
      sha256: sha256(bytes),
    };
    const networkError = () =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    const scripted = (...outcomes) => {
      const calls = [];
      const fetch = async (url) => {
        calls.push(url);
        const outcome = outcomes[Math.min(calls.length, outcomes.length) - 1];
        if (outcome instanceof Error) throw outcome;
        return new Response(outcome.body ?? null, { status: outcome.status });
      };
      return { calls, fetch };
    };
    const download = (fetch, waits = []) =>
      downloadArtifact(expected, temporary(), {
        cacheDirectory: null,
        random: () => 0.5,
        budget: { waitedMs: 0 },
        fetch,
        wait: async (attempt) => {
          waits.push(attempt);
        },
      });

    it.each([
      ["连接中断", networkError()],
      ["HTTP 503", { status: 503 }],
      ["HTTP 429", { status: 429 }],
    ])("%s 后重试并拿到正确内容", async (_, firstOutcome) => {
      const { calls, fetch } = scripted(firstOutcome, { status: 200, body: bytes });
      const waits = [];
      const path = await download(fetch, waits);
      expect(readFileSync(path)).toEqual(bytes);
      expect(calls).toEqual([expected.url, expected.url]);
      expect(waits).toEqual([1]);
    });

    it("下载物先写临时文件再改名，缓存目录里不留半截文件", async () => {
      const directory = temporary();
      const { fetch } = scripted({ status: 200, body: bytes });
      const path = await downloadArtifact(expected, directory, { fetch, cacheDirectory: null });
      expect(readFileSync(path)).toEqual(bytes);
      expect(readdirSync(directory)).toEqual([expected.filename]);
    });

    it("摘要不符的下载物不进缓存目录", async () => {
      const directory = temporary();
      const { fetch } = scripted({ status: 200, body: "tampered" });
      await expect(
        downloadArtifact(expected, directory, { fetch, cacheDirectory: null }),
      ).rejects.toThrow("下载摘要不匹配");
      expect(readdirSync(directory)).toEqual([]);
    });

    it("一直连不上时用完重试预算才失败，报错写明主机和底层原因", async () => {
      const { calls, fetch } = scripted(networkError());
      const waits = [];
      await expect(download(fetch, waits)).rejects.toThrow(
        /tool\.tar\.gz.*nodejs\.org.*第 7 次.*ECONNRESET/,
      );
      expect(calls).toHaveLength(7);
      expect(waits).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("HTTP 404 不重试", async () => {
      const { calls, fetch } = scripted({ status: 404 });
      await expect(download(fetch)).rejects.toThrow(/nodejs\.org.*HTTP 404/);
      expect(calls).toHaveLength(1);
    });

    it("下载成功但摘要不符时不重试", async () => {
      const { calls, fetch } = scripted({ status: 200, body: "tampered" });
      await expect(download(fetch)).rejects.toThrow("下载摘要不匹配");
      expect(calls).toHaveLength(1);
    });
  });

  it("子进程只使用临时 HOME 和显式环境，不继承凭据或 Node 注入选项", () => {
    const directory = temporary();
    const env = isolatedEnvironment(directory, "/fixture/bin");
    expect(env.HOME).toBe(join(directory, "home"));
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SEMGREP_SEND_METRICS).toBe("off");
    expect(env.PATH.split(":")[0]).toBe("/fixture/bin");
    expect(runnerTracking({ RUNNER_TRACKING_ID: "github_fixture" })).toEqual({
      RUNNER_TRACKING_ID: "github_fixture",
    });
    expect(runnerTracking({ RUNNER_TRACKING_ID: "" })).toEqual({});
    expect(runnerTracking({})).toEqual({});
    vi.stubEnv("RUNNER_TRACKING_ID", "github_fixture");
    try {
      const tracked = isolatedEnvironment(temporary(), "/fixture/bin");
      expect(tracked.RUNNER_TRACKING_ID).toBe("github_fixture");
      expect(
        execFileSync(
          process.execPath,
          ["-e", "process.stdout.write(process.env.RUNNER_TRACKING_ID)"],
          {
            env: tracked,
            encoding: "utf8",
          },
        ),
      ).toBe("github_fixture");
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("RUNNER_TRACKING_ID", "");
    try {
      expect("RUNNER_TRACKING_ID" in isolatedEnvironment(temporary(), "/fixture/bin")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("npm 发布包身份与 lifecycle", () => {
  it("SQLite真实内存建表、写入、读取及版本探针", () => {
    const result = probeSqlite(root);
    expect(result.status).toBe("passed");
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("按逐项锁版本验收 Pi，并接受仓库内部 workspace 链接", () => {
    const fixture = npmFixture();
    const workspace = { name: "@himawari-agent/example", version: "0.0.0" };
    writeJson(join(fixture.directory, "packages/example/package.json"), workspace);
    fixture.lock.packages["packages/example"] = workspace;
    fixture.lock.packages["node_modules/@himawari-agent/example"] = {
      resolved: "packages/example",
      link: true,
    };
    mkdirSync(join(fixture.directory, "node_modules/@himawari-agent"), { recursive: true });
    symlinkSync(
      join(fixture.directory, "packages/example"),
      join(fixture.directory, "node_modules/@himawari-agent/example"),
    );
    fixture.save();
    const result = auditInstalledDependencies(fixture.directory, fixture.toolchain);
    expect(result.workspaces).toBe(1);
    expect(result.pi.find((entry) => entry.name === "@earendil-works/pi-telemetry").version).toBe(
      "0.84.3",
    );
  });

  it("拒绝错误 Pi 实际版本", () => {
    const fixture = npmFixture();
    writeJson(join(fixture.directory, "node_modules/@earendil-works/pi-ai/package.json"), {
      name: "@earendil-works/pi-ai",
      version: "0.84.1",
    });
    expect(() => auditInstalledDependencies(fixture.directory, fixture.toolchain)).toThrow(
      "实际依赖版本与锁文件不匹配",
    );
  });

  it("拒绝指向相邻源码的 Pi symlink", () => {
    const fixture = npmFixture();
    const outside = temporary();
    writeJson(join(outside, "package.json"), { name: "@earendil-works/pi-ai", version: "0.84.2" });
    const path = join(fixture.directory, "node_modules/@earendil-works/pi-ai");
    rmSync(path, { recursive: true });
    symlinkSync(outside, path);
    expect(() => auditInstalledDependencies(fixture.directory, fixture.toolchain)).toThrow(
      "非法外部 symlink",
    );
  });

  it("拒绝未经登记的安装脚本，即使 lock 未设置 hasInstallScript", () => {
    const fixture = npmFixture();
    fixture.addPackage("unexpected", "1.0.0", "node_modules/unexpected", {
      postinstall: "node setup.js",
    });
    fixture.save();
    expect(() => auditInstalledDependencies(fixture.directory, fixture.toolchain)).toThrow(
      "未知安装脚本",
    );
  });

  it("拒绝本地 prepare 绕过依赖审阅", () => {
    const fixture = npmFixture();
    writeJson(join(fixture.directory, "package.json"), {
      ...fixture.lock.packages[""],
      scripts: { prepare: "node surprise.js" },
    });
    expect(() => auditManifestDependencies(fixture.directory)).toThrow("未审阅 lifecycle");
  });

  it("拒绝 manifest 的版本范围及锁文件不一致", () => {
    const fixture = npmFixture();
    const manifest = { ...fixture.lock.packages[""], dependencies: { example: "^1.0.0" } };
    writeJson(join(fixture.directory, "package.json"), manifest);
    fixture.lock.packages[""] = manifest;
    fixture.save();
    expect(() => auditManifestDependencies(fixture.directory)).toThrow("直接依赖必须是精确版本");
  });

  it("只允许缺席的其他平台 optional 依赖", () => {
    const fixture = npmFixture();
    fixture.lock.packages["node_modules/other-platform"] = {
      version: "1.0.0",
      optional: true,
      os: ["win32"],
    };
    fixture.save();
    expect(auditInstalledDependencies(fixture.directory, fixture.toolchain).pi).toHaveLength(3);
    fixture.lock.packages["node_modules/other-platform"].os = [process.platform];
    fixture.save();
    expect(() => auditInstalledDependencies(fixture.directory, fixture.toolchain)).toThrow(
      "锁文件依赖没有安装",
    );
  });

  it("允许没装的可选对等依赖，但拒绝没装的普通可选依赖", () => {
    const fixture = npmFixture();
    fixture.lock.packages["node_modules/optional-peer"] = {
      version: "1.0.0",
      optional: true,
      peer: true,
      dev: true,
    };
    fixture.save();
    expect(auditInstalledDependencies(fixture.directory, fixture.toolchain).pi).toHaveLength(3);
    delete fixture.lock.packages["node_modules/optional-peer"].peer;
    fixture.save();
    expect(() => auditInstalledDependencies(fixture.directory, fixture.toolchain)).toThrow(
      "锁文件依赖没有安装",
    );
  });
});
