import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ calls: [], run: undefined }));
vi.mock("node:child_process", async (original) => {
  const actual = await original();
  const execFile = (command, args, options, callback) => {
    if (command === "du") return actual.execFile(command, args, options, callback);
    try {
      callback(null, boundary.run(command, args, options), "");
    } catch (error) {
      callback(error);
    }
  };
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (command, args, options) =>
    new Promise((resolve, reject) =>
      execFile(command, args, options, (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr }),
      ),
    );
  return {
    ...actual,
    execFile,
    execFileSync: (command, args, options) => {
      if (command === "tar") return actual.execFileSync(command, args, options);
      boundary.calls.push({ command, args, options });
      if (!boundary.run) throw new Error("UNEXPECTED_SYNTHETIC_COMMAND");
      return boundary.run(command, args, options);
    },
  };
});

import { installDependencies, runnerNpmCache } from "../../scripts/ci/install-dependencies.mjs";
import {
  installTools,
  loadToolchainLock,
  verifyInstalledTools,
} from "../../scripts/ci/install-tools.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directories = [];
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "himawari-toolchain-lifecycle-"));
  directories.push(path);
  return path;
}
function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
function json(path, value) {
  write(path, `${JSON.stringify(value)}\n`);
}

function fixture({ nodeVersion = "22.22.3" } = {}) {
  const directory = temporary();
  const project = join(directory, "project"),
    toolsDirectory = join(directory, "tools");
  mkdirSync(project);
  cpSync(join(root, "ci/rules"), join(project, "ci/rules"), { recursive: true });
  const lock = loadToolchainLock(root),
    platform = `${process.platform}-${process.arch}`,
    downloads = new Map();
  const packageLock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "synthetic-installation-fixture", version: "0.0.0", workspaces: ["packages/*"] },
    },
  };
  json(join(project, "package.json"), packageLock.packages[""]);
  mkdirSync(join(project, "packages"));
  const manifests = [
    { name: "@earendil-works/pi-ai", version: "0.84.2" },
    { name: "@earendil-works/pi-coding-agent", version: "0.84.2" },
    { name: "better-sqlite3", version: "12.8.0", scripts: { install: "synthetic-reviewed-build" } },
  ];
  for (const manifest of manifests)
    packageLock.packages[`node_modules/${manifest.name}`] = {
      version: manifest.version,
      resolved: `https://registry.npmjs.org/${manifest.name}/-/${manifest.name.split("/").at(-1)}-${manifest.version}.tgz`,
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      ...(manifest.scripts ? { hasInstallScript: true } : {}),
    };
  json(join(project, "package-lock.json"), packageLock);
  lock.nativeDependencies = [
    {
      path: "node_modules/better-sqlite3",
      name: "better-sqlite3",
      version: "12.8.0",
      scripts: { install: "synthetic-reviewed-build" },
      decision: "build",
      reviewedFiles: { "fixture-build.js": hash("reviewed synthetic native source") },
      reason: "合成生命周期边界测试专用，不代表真实安装资格。",
    },
  ];
  const pack = (artifact, files) => {
    const source = join(directory, `source-${downloads.size}`);
    mkdirSync(source);
    for (const [name, bytes] of Object.entries(files)) write(join(source, name), bytes);
    const archive = join(directory, artifact.filename);
    execFileSync("tar", ["-czf", archive, "-C", source, ...Object.keys(files)]);
    const bytes = readFileSync(archive);
    artifact.sha256 = hash(bytes);
    downloads.set(artifact.url, bytes);
  };
  pack(lock.node.releases[nodeVersion].artifacts[platform], {
    [`node-v${nodeVersion}-${platform}/bin/node`]: "synthetic node binary",
  });
  pack(lock.node.releases[nodeVersion].headers, {
    [`node-v${nodeVersion}/include/node/node.h`]: "synthetic headers",
  });
  pack(lock.npm.artifact, {
    "package/bin/npm-cli.js": "synthetic npm entrypoint",
    "package/node_modules/node-gyp/bin/node-gyp.js": "synthetic node-gyp entrypoint",
  });
  pack(lock.python.artifacts[platform], {
    "python/bin/python3": "synthetic python binary",
    "python/bin/python3.12": "synthetic python binary",
  });
  for (const name of ["actionlint", "gitleaks"])
    pack(lock.tools[name].artifacts[platform], { [name]: `synthetic ${name} binary` });
  for (const wheel of lock.tools.semgrep.wheels[platform]) {
    const bytes = Buffer.from(`synthetic wheel ${wheel.name}`);
    wheel.sha256 = hash(bytes);
    downloads.set(wheel.url, bytes);
  }
  const saveLock = () => json(join(project, "ci/toolchain-lock.json"), lock);
  saveLock();
  const state = {
    directory,
    root: project,
    toolsDirectory,
    lock,
    downloads,
    saveLock,
    nodeVersion,
    platform,
    failure: null,
    mutateLock: false,
  };
  boundary.calls = [];
  boundary.run = (command, args, options) => {
    const fail = (point) => {
      if (state.failure === point) throw new Error(`SYNTHETIC_${point}_FAILED`);
    };
    if (command.endsWith("/bin/node")) {
      if (args[0] === "--version")
        return state.failure === "node-version" ? "v0.0.0\n" : `v${nodeVersion}\n`;
      if (args[0] === "-p") return "127\n";
      if (args[0].endsWith("npm-cli.js")) {
        if (args[1] === "--version") return "11.8.0\n";
        expect(args).toEqual([
          command.replace(/node\/node-v[^/]+\/bin\/node$/, "npm/package/bin/npm-cli.js"),
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry=https://registry.npmjs.org/",
        ]);
        expect(options.env.npm_config_ignore_scripts).toBe("true");
        expect(options.env.npm_config_userconfig).not.toBe(options.env.npm_config_globalconfig);
        expect(existsSync(options.env.npm_config_cache)).toBe(state.warmCache === true);
        fail("npm-ci");
        for (const manifest of manifests)
          json(join(project, `node_modules/${manifest.name}/package.json`), manifest);
        write(
          join(project, "node_modules/better-sqlite3/fixture-build.js"),
          "reviewed synthetic native source",
        );
        if (state.mutateLock)
          write(
            join(project, "package-lock.json"),
            `${readFileSync(join(project, "package-lock.json"), "utf8")} `,
          );
        return "synthetic npm ci completed; no actual registry or lifecycle executed\n";
      }
      if (args[0].endsWith("node-gyp.js")) {
        expect(options.cwd).toBe(join(project, "node_modules/better-sqlite3"));
        expect(args.slice(1, 3)).toEqual(["rebuild", "--release"]);
        expect(args[3]).toContain("--nodedir=");
        expect(args[4]).toContain("--python=");
        fail("native-build");
        return "synthetic native build\n";
      }
      if (args[0] === "--input-type=module") {
        expect(args[2]).toContain("probeSqlite");
        fail("sqlite-probe");
        return JSON.stringify({ status: "passed", version: "synthetic-sqlite" });
      }
    }
    if (command.endsWith("/python3") && args[0] === "--version") return "Python 3.12.10\n";
    if (command.endsWith("/python3") && args.slice(0, 3).join(" ") === "-I -m venv") {
      write(join(args[3], "bin/python"), "synthetic venv");
      return "";
    }
    if (command.endsWith("/semgrep/bin/python")) {
      expect(args.slice(0, 3)).toEqual(["-I", "-m", "pip"]);
      if (args[3] === "install") {
        expect(args).toEqual(
          expect.arrayContaining([
            "--no-index",
            "--no-deps",
            "--require-hashes",
            "--no-cache-dir",
            "--no-compile",
          ]),
        );
        write(join(toolsDirectory, "semgrep/bin/semgrep"), "synthetic semgrep executable");
        write(
          join(toolsDirectory, "semgrep/lib/python3.12/site-packages/certifi/cacert.pem"),
          "synthetic CA fixture",
        );
      }
      fail("pip");
      return "";
    }
    if (command.endsWith("/actionlint")) return `${lock.tools.actionlint.version}\n`;
    if (command.endsWith("/gitleaks")) return `${lock.tools.gitleaks.version}\n`;
    if (command.endsWith("/semgrep")) return `${lock.tools.semgrep.version}\n`;
    throw new Error("UNEXPECTED_SYNTHETIC_COMMAND");
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const bytes = downloads.get(url);
      if (!bytes) throw new Error("UNEXPECTED_NETWORK_URL");
      return new Response(bytes, { status: 200 });
    }),
  );
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
  boundary.run = undefined;
  boundary.calls = [];
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("合成工具包的安装过程", () => {
  it.each([false, true])("固定安装及独立复验（includeScanners=%s）", async (includeScanners) => {
    const f = fixture();
    const installed = await installTools({
      root: f.root,
      directory: f.toolsDirectory,
      includeScanners,
    });
    expect(Boolean(installed.executables.semgrep)).toBe(includeScanners);
    const original = readFileSync(join(f.toolsDirectory, "installation.json"));
    f.lock.rules.version = "2";
    f.saveLock();
    const verified = verifyInstalledTools({ directory: f.toolsDirectory, root: f.root });
    expect(verified.toolchainSha256).not.toBe(installed.toolchainSha256);
    expect(verified.originalInstallationSha256).toBe(hash(original));
    expect(readFileSync(join(f.toolsDirectory, "installation.json"))).toEqual(original);
    expect(JSON.parse(readFileSync(join(f.toolsDirectory, "verification.json")))).toEqual(verified);
    expect(
      boundary.calls.every((call) => !call.options.env.NODE_OPTIONS && !call.options.env.NODE_PATH),
    ).toBe(true);
  });
  it("只装锁定的基准 Node，退役的最低版本 22.19.0 被拒绝", async () => {
    const f = fixture();
    await expect(
      installTools({
        root: f.root,
        directory: f.toolsDirectory,
        nodeVersion: "22.19.0",
        includeScanners: false,
      }),
    ).rejects.toThrow("不支持的 Node 版本");
  });
  it("版本输出正确但实际executable内容篡改仍失败", async () => {
    const f = fixture();
    const r = await installTools({
      root: f.root,
      directory: f.toolsDirectory,
      includeScanners: false,
    });
    write(r.executables.node, "tampered binary");
    expect(() => verifyInstalledTools({ directory: f.toolsDirectory, root: f.root })).toThrow(
      "工具 executable 与固定归档不匹配",
    );
    expect(existsSync(join(f.toolsDirectory, "verification.json"))).toBe(false);
  });
  it("实际版本错误和pip失败均传播", async () => {
    const f = fixture();
    f.failure = "node-version";
    await expect(
      installTools({ root: f.root, directory: f.toolsDirectory, includeScanners: false }),
    ).rejects.toThrow("Node 下载物实际版本不匹配");
    const other = fixture();
    other.failure = "pip";
    await expect(
      installTools({ root: other.root, directory: other.toolsDirectory }),
    ).rejects.toThrow("SYNTHETIC_pip_FAILED");
  });
  it("仅复用下载缓存，重新安装并独立校验工具", async () => {
    const f = fixture();
    await installTools({ root: f.root, directory: f.toolsDirectory, includeScanners: false });
    const target = join(f.directory, "warm-tools");
    mkdirSync(target);
    cpSync(join(f.toolsDirectory, "downloads"), join(target, "downloads"), { recursive: true });
    await installTools({ root: f.root, directory: target, includeScanners: false });
    expect(verifyInstalledTools({ root: f.root, directory: target }).verification).toBe(
      "download-digests-executable-bytes-and-runtime-versions",
    );
  });
  it("拒绝非空目标和未支持版本", async () => {
    const f = fixture();
    mkdirSync(f.toolsDirectory);
    write(join(f.toolsDirectory, "keep"), "user data");
    await expect(installTools({ root: f.root, directory: f.toolsDirectory })).rejects.toThrow(
      "工具安装目录必须为空",
    );
    expect(readFileSync(join(f.toolsDirectory, "keep"), "utf8")).toBe("user data");
    await expect(
      installTools({ root: f.root, directory: join(f.directory, "other"), nodeVersion: "24.11.1" }),
    ).rejects.toThrow("不支持的 Node 版本");
  });
});

describe("合成npm/native/SQLite子进程边界", () => {
  it("空cache、ignore-scripts、精确native argv及锁不变形成证据", async () => {
    const f = fixture();
    await installTools({ root: f.root, directory: f.toolsDirectory, includeScanners: false });
    f.lock.rules.version = "2";
    f.saveLock();
    const evidence = join(f.directory, "evidence");
    const r = await installDependencies({
      root: f.root,
      toolsDirectory: f.toolsDirectory,
      evidenceDirectory: evidence,
    });
    expect(r.status).toBe("passed");
    expect(r.cache).toBe("cold");
    expect(r.pi).toHaveLength(2);
    expect(r.sqlite.version).toBe("synthetic-sqlite");
    expect(r.resources.status).toBe("measured");
    expect(r.resources.scopes.every((scope) => scope.samples >= 2)).toBe(true);
    expect(r.toolchainSha256).toBe(hash(readFileSync(join(f.root, "ci/toolchain-lock.json"))));
    expect(readFileSync(join(evidence, "npm-ci.log"), "utf8")).toContain("no actual registry");
  });
  it.each(["npm-ci", "native-build", "sqlite-probe"])("%s失败不写成功报告", async (point) => {
    const f = fixture();
    await installTools({ root: f.root, directory: f.toolsDirectory, includeScanners: false });
    f.failure = point;
    const evidence = join(f.directory, "evidence");
    await expect(
      installDependencies({
        root: f.root,
        toolsDirectory: f.toolsDirectory,
        evidenceDirectory: evidence,
      }),
    ).rejects.toThrow(`SYNTHETIC_${point}_FAILED`);
    expect(existsSync(join(evidence, "installation-result.json"))).toBe(false);
    expect(existsSync(join(evidence, "failed-installation-resources.json"))).toBe(true);
  });
  it("安装过程修改lock或证据目录非空必须失败", async () => {
    const f = fixture();
    await installTools({ root: f.root, directory: f.toolsDirectory, includeScanners: false });
    f.mutateLock = true;
    const evidence = join(f.directory, "evidence");
    await expect(
      installDependencies({
        root: f.root,
        toolsDirectory: f.toolsDirectory,
        evidenceDirectory: evidence,
      }),
    ).rejects.toThrow("安装修改了提交的锁文件");
    await expect(
      installDependencies({
        root: f.root,
        toolsDirectory: f.toolsDirectory,
        evidenceDirectory: evidence,
      }),
    ).rejects.toThrow("安装证据目录必须为空");
  });
  it("显式warm cache仅复用下载缓存，每次仍执行完整npm ci并保留缓存", async () => {
    const f = fixture();
    await installTools({ root: f.root, directory: f.toolsDirectory, includeScanners: false });
    const cache = join(f.root, ".ci-output/npm-cache");
    write(join(cache, "keep"), "synthetic cached bytes");
    f.warmCache = true;
    const result = await installDependencies({
      root: f.root,
      toolsDirectory: f.toolsDirectory,
      evidenceDirectory: join(f.directory, "warm-evidence"),
      cacheDirectory: ".ci-output/npm-cache",
    });
    expect(result.cache).toBe("warm");
    expect(readFileSync(join(cache, "keep"), "utf8")).toBe("synthetic cached bytes");
  });
  it.each(["outside", "root", "symlink"])("%s cache路径必须拒绝", async (mode) => {
    const f = fixture();
    await installTools({ root: f.root, directory: f.toolsDirectory, includeScanners: false });
    let cacheDirectory = mode === "outside" ? f.directory : ".ci-output";
    if (mode === "symlink") {
      mkdirSync(join(f.root, ".ci-output"));
      symlinkSync(f.directory, join(f.root, ".ci-output/link"));
      cacheDirectory = ".ci-output/link/cache";
    }
    await expect(
      installDependencies({
        root: f.root,
        toolsDirectory: f.toolsDirectory,
        evidenceDirectory: join(f.directory, "cache-failure"),
        cacheDirectory,
      }),
    ).rejects.toThrow(/npm cache/);
  });
  it("runner 缓存放在 runner 的 HOME 下，跨作业保留，下一次安装是 warm", async () => {
    const f = fixture();
    await installTools({ root: f.root, directory: f.toolsDirectory, includeScanners: false });
    const home = join(f.directory, "home");
    mkdirSync(home);
    const env = { ...process.env, GITHUB_ACTIONS: "true", HOME: home };
    f.warmCache = true;
    const first = await installDependencies({
      root: f.root,
      toolsDirectory: f.toolsDirectory,
      evidenceDirectory: join(f.directory, "runner-first"),
      cacheDirectory: "runner",
      env,
    });
    expect(first.cache).toBe("cold");
    const cache = join(home, ".cache/himawari-ci/npm");
    write(join(cache, "_cacache/index"), "synthetic cached bytes");
    const second = await installDependencies({
      root: f.root,
      toolsDirectory: f.toolsDirectory,
      evidenceDirectory: join(f.directory, "runner-second"),
      cacheDirectory: "runner",
      env,
    });
    expect(second.cache).toBe("warm");
    expect(readFileSync(join(cache, "_cacache/index"), "utf8")).toBe("synthetic cached bytes");
  });
  it("runner 缓存满 7 天整个清空重建", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-cache-"));
    const env = { GITHUB_ACTIONS: "true", HOME: home };
    const start = Date.parse("2026-11-01T00:00:00Z");
    const cache = runnerNpmCache(env, start);
    write(join(cache, "_cacache/index"), "old");
    runnerNpmCache(env, start + 6 * 24 * 60 * 60 * 1000);
    expect(existsSync(join(cache, "_cacache/index"))).toBe(true);
    runnerNpmCache(env, start + 8 * 24 * 60 * 60 * 1000);
    expect(existsSync(join(cache, "_cacache/index"))).toBe(false);
    expect(existsSync(join(cache, ".himawari-created"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
  it.each([
    ["不在 GitHub Actions 里", { HOME: "/tmp" }],
    ["HOME 不是绝对路径", { GITHUB_ACTIONS: "true", HOME: "relative" }],
  ])("runner 缓存%s时拒绝", (_name, env) => {
    expect(() => runnerNpmCache(env)).toThrow(
      "runner npm cache 只能在 GitHub Actions runner 上使用",
    );
  });
  it("runner 缓存路径里有符号链接时拒绝", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-cache-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "runner-cache-target-"));
    symlinkSync(elsewhere, join(home, ".cache"));
    expect(() => runnerNpmCache({ GITHUB_ACTIONS: "true", HOME: home })).toThrow(
      "npm cache 路径不得包含符号链接",
    );
    rmSync(home, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
