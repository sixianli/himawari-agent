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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
import { verifyGovernance } from "../../scripts/ci/sync-governance.mjs";

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
  it("锁定双方平台、完整 Action SHA、扫描工具和 wheel 闭包", () => {
    const lock = loadToolchainLock(root);
    expect(validateToolchainLock(lock)).toBe(lock);
    expect(lock.actions).toHaveLength(5);
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
      ),
    ).rejects.toThrow("下载摘要不匹配");
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
});

describe("治理原始来源闭包", () => {
  function fixture() {
    const directory = temporary();
    cpSync(join(root, "tools/document-governance"), join(directory, "tools/document-governance"), {
      recursive: true,
    });
    return directory;
  }

  it("仓库原始快照及 Owner 授权的摘要可独立验证", () => {
    expect(verifyGovernance(fixture()).files).toBe(5);
  });

  it("缺少任一导入模块则失败", () => {
    const directory = fixture();
    rmSync(join(directory, "tools/document-governance/scripts/runbook.py"));
    expect(() => verifyGovernance(directory)).toThrow("治理文件缺失");
  });

  it("修改原始 validator 则失败", () => {
    const directory = fixture();
    writeFileSync(
      join(directory, "tools/document-governance/scripts/validate_docs.py"),
      "print('passed')\n",
    );
    expect(() => verifyGovernance(directory)).toThrow("治理文件摘要不匹配");
  });

  it("许可状态或授权文本被替换则失败", () => {
    const directory = fixture();
    const path = join(directory, "tools/document-governance/provenance.json");
    const provenance = JSON.parse(readFileSync(path));
    provenance.authorization.status = "unconfirmed";
    writeJson(path, provenance);
    expect(() => verifyGovernance(directory)).toThrow("缺少治理复制与公开分发授权");
  });
});
