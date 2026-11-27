import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isolatedEnvironment, loadToolchainLock, verifyInstalledTools } from "./install-tools.mjs";
import { hostArch, hostOs, hostPlatform } from "./platforms.mjs";
import { observeResources } from "./resources.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const lifecycleNames = ["preinstall", "install", "postinstall"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function contained(root, path) {
  const offset = relative(root, path);
  return (
    offset === "" ||
    (!offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      offset !== ".." &&
      !isAbsolute(offset))
  );
}

const runnerCacheMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

function rejectSymlinks(target, stop) {
  let current = target;
  while (current !== stop) {
    try {
      assert(!lstatSync(current).isSymbolicLink(), "npm cache 路径不得包含符号链接");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

export function runnerNpmCache(env = process.env, now = Date.now()) {
  assert(
    env.GITHUB_ACTIONS === "true" && env.HOME && isAbsolute(env.HOME),
    "runner npm cache 只能在 GitHub Actions runner 上使用",
  );
  const home = realpathSync(env.HOME);
  const target = join(home, ".cache", "himawari-ci", "npm");
  rejectSymlinks(target, dirname(home));
  const stamp = join(target, ".himawari-created");
  const created = lstatSync(stamp, { throwIfNoEntry: false });
  if (!created?.isFile() || now - created.mtimeMs > runnerCacheMaxAgeMs) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(stamp, "");
    utimesSync(stamp, new Date(now), new Date(now));
  }
  return target;
}

const nativeBinary = join("build", "Release", "better_sqlite3.node");

export function runnerNativeCache(env = process.env) {
  assert(
    env.GITHUB_ACTIONS === "true" && env.HOME && isAbsolute(env.HOME),
    "runner native cache 只能在 GitHub Actions runner 上使用",
  );
  const home = realpathSync(env.HOME);
  const target = join(home, ".cache", "himawari-ci", "native");
  rejectSymlinks(target, dirname(home));
  mkdirSync(target, { recursive: true });
  return target;
}

export function nativeBuildKey({ entry, integrity, installation }) {
  return hash(
    JSON.stringify([
      entry.name,
      entry.version,
      integrity,
      installation.platform,
      installation.node,
      installation.nodeAbi,
      installation.toolchainSha256,
    ]),
  );
}

function restoreNativeBuild(cached, target) {
  const manifestPath = join(cached, "manifest.json");
  const binary = join(cached, "better_sqlite3.node");
  if (!existsSync(manifestPath) || !existsSync(binary)) return false;
  let manifest;
  try {
    manifest = json(manifestPath);
  } catch {
    manifest = null;
  }
  if (manifest?.sha256 !== hash(readFileSync(binary))) {
    rmSync(cached, { recursive: true, force: true });
    return false;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(binary, target);
  assert(hash(readFileSync(target)) === manifest.sha256, "取回的原生模块摘要不匹配");
  return manifest.sha256;
}

function storeNativeBuild(cached, target) {
  assert(existsSync(target), "原生构建没有产出 better_sqlite3.node");
  const staging = `${cached}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  copyFileSync(target, join(staging, "better_sqlite3.node"));
  const sha256 = hash(readFileSync(join(staging, "better_sqlite3.node")));
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify({ sha256 })}\n`);
  rmSync(cached, { recursive: true, force: true });
  renameSync(staging, cached);
  return sha256;
}

function cacheLocation(value, root, env) {
  if (value === "runner") return runnerNpmCache(env);
  const base = join(realpathSync(root), ".ci-output");
  const target = resolve(realpathSync(root), value);
  assert(target !== base && contained(base, target), "npm cache 必须位于仓库 .ci-output 子目录");
  rejectSymlinks(target, dirname(base));
  return target;
}

function scriptsOf(manifest) {
  return Object.fromEntries(
    lifecycleNames
      .filter((name) => manifest.scripts?.[name])
      .map((name) => [name, manifest.scripts[name]]),
  );
}

function sameRecord(left, right) {
  return (
    JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())
  );
}

export function auditManifestDependencies(root, lock = json(join(root, "package-lock.json"))) {
  assert(lock.lockfileVersion === 3 && lock.packages?.[""], "需要 npm v3 workspace 锁文件");
  const rootManifest = json(join(root, "package.json"));
  const directories = [""];
  assert(Array.isArray(rootManifest.workspaces), "workspace 声明缺失");
  for (const pattern of rootManifest.workspaces) {
    assert(/^[a-z-]+\/\*$/.test(pattern), `不支持的 workspace 模式: ${pattern}`);
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json")))
        directories.push(`${parent}/${entry.name}`);
    }
  }
  for (const directory of directories) {
    const manifest = json(join(root, directory, "package.json"));
    const entry = lock.packages[directory];
    assert(entry, `workspace 未被锁文件记录: ${directory}`);
    for (const field of dependencyFields) {
      assert(
        sameRecord(manifest[field] ?? {}, entry[field] ?? {}),
        `manifest 与锁文件不匹配: ${directory || "."}/${field}`,
      );
      for (const [name, version] of Object.entries(manifest[field] ?? {}))
        assert(
          /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version),
          `直接依赖必须是精确版本: ${name}@${version}`,
        );
    }
    const localScripts = [
      "preinstall",
      "install",
      "postinstall",
      "prepublish",
      "preprepare",
      "prepare",
      "postprepare",
    ].filter((name) => manifest.scripts?.[name]);
    assert(
      localScripts.length === 0,
      `workspace 包含未审阅 lifecycle: ${directory || "."}/${localScripts.join(",")}`,
    );
  }
  return directories;
}

function packageDirectories(root, parent = "node_modules") {
  if (!existsSync(join(root, parent))) return [];
  const paths = [];
  for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const child of readdirSync(join(root, parent, entry.name))) {
        if (!child.startsWith(".")) paths.push(`${parent}/${entry.name}/${child}`);
      }
    } else paths.push(`${parent}/${entry.name}`);
  }
  return paths.flatMap((path) => {
    assert(existsSync(join(root, path, "package.json")), `已安装包缺少 manifest: ${path}`);
    return [
      path,
      ...(lstatSync(join(root, path)).isSymbolicLink()
        ? []
        : packageDirectories(root, `${path}/node_modules`)),
    ];
  });
}

function platformMatches(entry, platform, arch) {
  const matches = (values, actual) =>
    !values ||
    (!values.includes(`!${actual}`) &&
      (values.every((value) => value.startsWith("!")) || values.includes(actual)));
  return matches(entry.os, platform) && matches(entry.cpu, arch);
}

export function auditInstalledDependencies(
  root,
  toolchain = loadToolchainLock(root),
  { platform = hostOs(), arch = hostArch() } = {},
) {
  const realRoot = realpathSync(root);
  const lock = json(join(root, "package-lock.json"));
  const workspaces = auditManifestDependencies(root, lock);
  const decisions = new Map(toolchain.nativeDependencies.map((entry) => [entry.path, entry]));
  const paths = [
    ...packageDirectories(root),
    ...workspaces
      .filter(Boolean)
      .flatMap((workspace) => packageDirectories(root, `${workspace}/node_modules`)),
  ];
  const installed = new Set(paths);
  const pi = [];
  for (const path of paths) {
    const expected = lock.packages[path];
    assert(expected, `安装树存在未被锁文件记录的包: ${path}`);
    const absolute = join(root, path);
    const actualPath = realpathSync(absolute);
    assert(contained(realRoot, actualPath), `已安装包通过非法外部 symlink 越界: ${path}`);
    const manifest = json(join(absolute, "package.json"));
    if (expected.link) {
      assert(
        workspaces.includes(expected.resolved) &&
          actualPath === realpathSync(join(root, expected.resolved)),
        `workspace 链接目标不匹配: ${path}`,
      );
      assert(
        manifest.name.startsWith("@himawari-agent/"),
        `外部依赖不允许 workspace 链接: ${path}`,
      );
      continue;
    }
    assert(
      actualPath === join(realRoot, path),
      `外部包没有来自其锁定的 node_modules 路径: ${path}`,
    );
    assert(
      manifest.version === expected.version,
      `实际依赖版本与锁文件不匹配: ${path} (${manifest.version} != ${expected.version})`,
    );
    const declaredName = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    assert(manifest.name === declaredName, `实际依赖名称不匹配: ${path}`);
    assert(
      expected.resolved?.startsWith("https://registry.npmjs.org/") &&
        /^sha512-[A-Za-z0-9+/]+=*$/.test(expected.integrity),
      `外部依赖不是带摘要的 npm 发布包: ${path}`,
    );
    const scripts = scriptsOf(manifest);
    const implicitBuild =
      existsSync(join(absolute, "binding.gyp")) && manifest.gypfile !== false && !scripts.install;
    if (expected.hasInstallScript || Object.keys(scripts).length || implicitBuild) {
      const decision = decisions.get(path);
      assert(decision, `未知安装脚本，必须先审阅: ${path}`);
      assert(
        decision.name === manifest.name &&
          decision.version === manifest.version &&
          sameRecord(decision.scripts, scripts),
        `安装脚本身份或内容已变化: ${path}`,
      );
      assert(!implicitBuild, `未审阅的隐式 node-gyp 构建: ${path}`);
      for (const [file, digest] of Object.entries(decision.reviewedFiles))
        assert(
          hash(readFileSync(join(absolute, file))) === digest,
          `安装脚本文件摘要不匹配: ${path}/${file}`,
        );
    }
    if (manifest.name.startsWith("@earendil-works/pi-")) {
      assert(
        !lstatSync(absolute).isSymbolicLink() && actualPath === join(realRoot, path),
        `Pi 发布包不允许源码链接: ${path}`,
      );
      pi.push({
        path,
        name: manifest.name,
        version: manifest.version,
        resolved: expected.resolved,
        integrity: expected.integrity,
      });
    }
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes("node_modules/") || installed.has(path)) continue;
    if (entry.optional === true && entry.peer === true) continue;
    assert(
      entry.optional === true && !platformMatches(entry, platform, arch),
      `锁文件依赖没有安装: ${path}`,
    );
  }
  for (const decision of decisions.values()) {
    const expected = lock.packages[decision.path];
    assert(
      expected && expected.version === decision.version && expected.hasInstallScript,
      `安装脚本审阅清单存在过期条目: ${decision.path}`,
    );
  }
  assert(
    pi.some((entry) => entry.name === "@earendil-works/pi-ai") &&
      pi.some((entry) => entry.name === "@earendil-works/pi-coding-agent"),
    "Pi 发布包缺失",
  );
  return { packages: paths.length, workspaces: workspaces.length - 1, pi };
}

export function probeSqlite(root) {
  const require = createRequire(join(root, "package.json"));
  const Database = require("better-sqlite3");
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE ci_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO ci_probe (id, value) VALUES (?, ?)").run(1, "himawari-ci");
    const row = database.prepare("SELECT value FROM ci_probe WHERE id = ?").get(1);
    assert(row?.value === "himawari-ci", "SQLite 内存读写探针失败");
    return {
      status: "passed",
      version: database.prepare("SELECT sqlite_version() AS version").get().version,
    };
  } finally {
    database.close();
  }
}

export async function installDependencies({
  root = repositoryRoot,
  toolsDirectory,
  evidenceDirectory,
  cacheDirectory,
  env: hostEnvironment = process.env,
}) {
  assert(toolsDirectory && evidenceDirectory, "必须指定 --tools 和 --evidence 目录");
  const lock = loadToolchainLock(root);
  const installation = verifyInstalledTools({ directory: toolsDirectory, root });
  assert(installation.platform === hostPlatform(), "工具安装来自其他平台");
  const { node, npmCli, nodeGyp, python, nodeHeaders } = installation.executables;
  for (const executable of [node, npmCli, nodeGyp, python, nodeHeaders])
    assert(
      contained(realpathSync(toolsDirectory), realpathSync(executable)),
      "工具 executable 越出安装目录",
    );
  assert(installation.node === lock.node.baseline, "Node 安装身份不被接受");
  const evidence = resolve(evidenceDirectory);
  assert(
    !existsSync(evidence) || readdirSync(evidence).length === 0,
    "安装证据目录必须为空，不能覆盖已有安装证据",
  );
  mkdirSync(evidence, { recursive: true });
  const cachePath = cacheDirectory
    ? cacheLocation(cacheDirectory, root, hostEnvironment)
    : join(evidence, "npm-cache");
  const cache =
    existsSync(cachePath) && readdirSync(cachePath).some((name) => name !== ".himawari-created")
      ? "warm"
      : "cold";
  const userConfig = join(evidence, "npm-user.conf");
  const globalConfig = join(evidence, "npm-global.conf");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  const env = {
    ...isolatedEnvironment(evidence, join(toolsDirectory, "bin")),
    npm_config_cache: cachePath,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_ignore_scripts: "true",
    npm_config_python: python,
  };
  const run = async (command, args, cwd = root) =>
    (
      await promisify(execFile)(command, args, {
        cwd,
        env,
        stdio: "pipe",
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout;
  assert(
    (await run(node, ["--version"])).trim() === `v${installation.node}`,
    "实际 Node 版本不匹配",
  );
  assert(
    (await run(node, [npmCli, "--version"])).trim() === lock.npm.version,
    "实际 npm 版本不匹配",
  );
  assert(
    (await run(python, ["--version"])).trim() === `Python ${lock.python.version}`,
    "实际 Python 版本不匹配",
  );
  auditManifestDependencies(root);
  const before = hash(readFileSync(join(root, "package-lock.json")));
  const started = performance.now();
  const resourceObserver = await observeResources({ root, toolsDirectory });
  let resources;
  try {
    writeFileSync(
      join(evidence, "npm-ci.log"),
      await run(node, [
        npmCli,
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org/",
      ]),
    );
    const npmCiMs = Math.round(performance.now() - started);
    const dependencies = auditInstalledDependencies(root, lock);
    const nativeCache = cacheDirectory === "runner" ? runnerNativeCache(hostEnvironment) : null;
    const packages = json(join(root, "package-lock.json")).packages;
    const native = [];
    for (const entry of lock.nativeDependencies.filter((item) => item.decision === "build")) {
      assert(entry.name === "better-sqlite3", "未支持的原生构建目标");
      const target = join(root, entry.path, nativeBinary);
      const key = nativeBuildKey({
        entry,
        integrity: packages[entry.path]?.integrity,
        installation,
      });
      const cached = nativeCache && join(nativeCache, key);
      const buildStarted = performance.now();
      const restored = cached && restoreNativeBuild(cached, target);
      if (restored) {
        writeFileSync(join(evidence, "native-build.log"), `restored ${key} ${restored}\n`);
      } else {
        writeFileSync(
          join(evidence, "native-build.log"),
          await run(
            node,
            [nodeGyp, "rebuild", "--release", `--nodedir=${nodeHeaders}`, `--python=${python}`],
            join(root, entry.path),
          ),
        );
        if (cached) storeNativeBuild(cached, target);
      }
      native.push({
        name: entry.name,
        key,
        source: restored ? "cache" : "build",
        durationMs: Math.round(performance.now() - buildStarted),
      });
    }
    const probeScript = `import { probeSqlite } from ${JSON.stringify(new URL("./install-dependencies.mjs", import.meta.url).href)}; console.log(JSON.stringify(probeSqlite(process.argv[1])));`;
    const sqlite = JSON.parse(
      await run(node, ["--input-type=module", "-e", probeScript, realpathSync(root)]),
    );
    assert(
      hash(readFileSync(join(root, "package-lock.json"))) === before,
      "安装修改了提交的锁文件",
    );
    const report = {
      schemaVersion: 1,
      status: "passed",
      platform: installation.platform,
      node: installation.node,
      nodeAbi: installation.nodeAbi,
      npm: lock.npm.version,
      python: lock.python.version,
      packageLockSha256: before,
      toolchainSha256: installation.toolchainSha256,
      cache,
      lifecycle: "ignore-scripts-with-reviewed-native-build",
      native,
      npmCiMs,
      durationMs: Math.round(performance.now() - started),
      sqlite,
      ...dependencies,
    };
    resources = await resourceObserver.stop();
    report.resources = resources;
    writeFileSync(
      join(evidence, "installation-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } finally {
    if (!resources) {
      resources = await resourceObserver.stop();
      writeFileSync(
        join(evidence, "failed-installation-resources.json"),
        `${JSON.stringify(resources, null, 2)}\n`,
      );
    }
  }
}

export function installArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = {
      "--root": "root",
      "--tools": "toolsDirectory",
      "--evidence": "evidenceDirectory",
      "--cache": "cacheDirectory",
    }[args[index]];
    assert(name && args[index + 1], `未知或不完整参数: ${args[index]}`);
    const value = args[++index];
    options[name] = name === "cacheDirectory" && value === "runner" ? value : resolve(value);
  }
  return options;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(await installDependencies(installArguments(process.argv.slice(2))), null, 2),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
