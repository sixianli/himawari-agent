import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const platforms = ["darwin-arm64", "linux-x64"];
const downloadHosts = new Set([
  "nodejs.org",
  "github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "files.pythonhosted.org",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fields(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} 必须是对象`);
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} 字段缺失或未知`,
  );
}

function digest(value, label) {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), `${label} 必须是 SHA256`);
}

function officialUrl(value) {
  const url = new URL(value);
  assert(
    url.protocol === "https:" && !url.username && !url.password && downloadHosts.has(url.hostname),
    "工具 URL 必须指向已审阅的 HTTPS 发布源",
  );
}

function artifact(value) {
  fields(value, ["filename", "url", "sha256"], "下载物");
  assert(
    typeof value.filename === "string" && /^[\w.+-]+$/.test(value.filename),
    "下载物文件名非法",
  );
  officialUrl(value.url);
  assert(
    decodeURIComponent(new URL(value.url).pathname.split("/").at(-1)) === value.filename,
    "下载物 URL 与文件名不匹配",
  );
  digest(value.sha256, "下载物摘要");
}

function license(value) {
  fields(value, ["identifier", "url", "sha256"], "许可证据");
  assert(typeof value.identifier === "string" && value.identifier.length > 0, "许可证标识缺失");
  officialUrl(value.url);
  digest(value.sha256, "许可证据摘要");
}

function platformArtifacts(value) {
  fields(value, platforms, "平台下载物");
  for (const item of Object.values(value)) artifact(item);
}

/** Tool identity validation is shared by the installer and policy gate. */
export function validateToolchainLock(lock) {
  fields(
    lock,
    [
      "schemaVersion",
      "node",
      "npm",
      "python",
      "actions",
      "tools",
      "nativeDependencies",
      "governance",
      "rules",
    ],
    "ToolchainLock",
  );
  assert(lock.schemaVersion === 1, "不支持的 ToolchainLock schema");
  fields(lock.node, ["baseline", "floor", "license", "releases"], "Node");
  assert(
    lock.node.baseline === "22.22.3" && lock.node.floor === "22.19.0",
    "Node 基线或最低版本不符合已确认合同",
  );
  license(lock.node.license);
  fields(lock.node.releases, [lock.node.baseline, lock.node.floor], "Node releases");
  for (const release of Object.values(lock.node.releases)) {
    fields(release, ["artifacts", "headers"], "Node release");
    platformArtifacts(release.artifacts);
    artifact(release.headers);
  }
  fields(lock.npm, ["version", "artifact", "license"], "npm");
  assert(lock.npm.version === "11.8.0", "npm 版本不符合已确认合同");
  artifact(lock.npm.artifact);
  license(lock.npm.license);
  fields(
    lock.python,
    ["version", "distribution", "release", "license", "buildLicense", "artifacts"],
    "Python",
  );
  assert(
    /^3\.(1[0-9]|[2-9][0-9])\.\d+$/.test(lock.python.version),
    "Python 必须固定为 3.10 以上精确版本",
  );
  assert(
    lock.python.distribution === "astral-sh/python-build-standalone" &&
      /^\d{8}$/.test(lock.python.release),
    "Python 发行物身份不完整",
  );
  license(lock.python.license);
  license(lock.python.buildLicense);
  platformArtifacts(lock.python.artifacts);
  assert(Array.isArray(lock.actions), "Actions 清单缺失");
  const expectedActions = [
    "actions/checkout",
    "actions/setup-node",
    "actions/setup-python",
    "actions/upload-artifact",
    "actions/download-artifact",
  ].sort();
  assert(
    JSON.stringify(lock.actions.map((action) => action.repository).sort()) ===
      JSON.stringify(expectedActions),
    "Action 集合缺失、重复或未知",
  );
  for (const action of lock.actions) {
    fields(action, ["repository", "version", "sha", "license"], "Action");
    assert(
      /^v\d+\.\d+\.\d+$/.test(action.version) && /^[a-f0-9]{40}$/.test(action.sha),
      "Action 必须固定版本与完整提交 SHA",
    );
    license(action.license);
  }
  fields(lock.tools, ["actionlint", "gitleaks", "semgrep"], "tools");
  for (const name of ["actionlint", "gitleaks"]) {
    const tool = lock.tools[name];
    fields(tool, ["version", "license", "artifacts"], name);
    assert(/^\d+\.\d+\.\d+$/.test(tool.version), `${name} 版本不精确`);
    license(tool.license);
    platformArtifacts(tool.artifacts);
  }
  const semgrep = lock.tools.semgrep;
  fields(semgrep, ["version", "edition", "license", "wheels"], "Semgrep");
  assert(
    semgrep.edition === "CE" && /^\d+\.\d+\.\d+$/.test(semgrep.version),
    "只允许固定版本 Semgrep CE",
  );
  license(semgrep.license);
  fields(semgrep.wheels, platforms, "Semgrep wheels");
  for (const wheels of Object.values(semgrep.wheels)) {
    assert(Array.isArray(wheels) && wheels.length > 0, "Semgrep wheel 闭包缺失");
    const names = new Set();
    for (const wheel of wheels) {
      fields(wheel, ["name", "version", "filename", "url", "sha256"], "wheel");
      assert(
        /^[A-Za-z0-9_.-]+$/.test(wheel.name) && /^\d[\w.+-]*$/.test(wheel.version),
        "wheel 身份非法",
      );
      const name = wheel.name.toLowerCase().replace(/[_.]/g, "-");
      assert(!names.has(name), "重复 wheel 包");
      names.add(name);
      artifact({ filename: wheel.filename, url: wheel.url, sha256: wheel.sha256 });
      assert(
        wheel.filename.endsWith(".whl") && new URL(wheel.url).hostname === "files.pythonhosted.org",
        "只允许官方 PyPI wheel",
      );
    }
    assert(
      wheels.some((wheel) => wheel.name === "semgrep" && wheel.version === semgrep.version),
      "Semgrep 本体版本与闭包不匹配",
    );
  }
  assert(
    Array.isArray(lock.nativeDependencies) && lock.nativeDependencies.length > 0,
    "安装脚本审阅清单缺失",
  );
  const nativePaths = new Set();
  for (const entry of lock.nativeDependencies) {
    fields(
      entry,
      ["path", "name", "version", "scripts", "decision", "reviewedFiles", "reason"],
      "安装脚本审阅记录",
    );
    assert(
      entry.path.startsWith("node_modules/") &&
        !entry.path.split("/").includes("..") &&
        !nativePaths.has(entry.path),
      "原生依赖路径重复或非法",
    );
    nativePaths.add(entry.path);
    assert(/^\d+\.\d+\.\d+$/.test(entry.version) && entry.name.length > 0, "原生依赖版本不精确");
    assert(
      ["build", "omit"].includes(entry.decision) && entry.reason.length > 0,
      "安装脚本缺少审阅决定",
    );
    assert(
      Object.keys(entry.scripts).every((key) =>
        ["preinstall", "install", "postinstall"].includes(key),
      ),
      "未知 lifecycle 类型",
    );
    for (const [path, hash] of Object.entries(entry.reviewedFiles)) {
      assert(!path.startsWith("/") && !path.split("/").includes(".."), "安装审阅文件路径非法");
      digest(hash, "安装审阅文件摘要");
    }
  }
  assert(
    lock.nativeDependencies
      .filter((entry) => entry.decision === "build")
      .every((entry) => entry.name === "better-sqlite3"),
    "存在未实现的原生构建入口",
  );
  fields(lock.governance, ["manifest", "entrypoint", "permission"], "governance");
  assert(
    lock.governance.manifest === "tools/document-governance/provenance.json" &&
      lock.governance.entrypoint === "tools/document-governance/scripts/validate_docs.py" &&
      lock.governance.permission === "tools/document-governance/PERMISSION.md",
    "治理来源路径不匹配",
  );
  fields(lock.rules, ["version", "license", "files"], "规则闭包");
  assert(/^\d+$/.test(lock.rules.version), "规则版本不精确");
  fields(lock.rules.license, ["identifier", "path", "sha256"], "自有规则许可证据");
  assert(
    lock.rules.license.identifier === "LicenseRef-Himawari-Project-Owned" &&
      lock.rules.license.path === "ci/rules/NOTICE.md",
    "自有规则许可来源不匹配",
  );
  digest(lock.rules.license.sha256, "规则许可证据摘要");
  assert(Array.isArray(lock.rules.files) && lock.rules.files.length > 0, "规则文件闭包为空");
  const rulePaths = new Set();
  for (const file of lock.rules.files) {
    fields(file, ["path", "sha256"], "规则文件");
    assert(
      file.path.startsWith("ci/rules/") &&
        !file.path.split("/").some((part) => ["", ".", ".."].includes(part)) &&
        !rulePaths.has(file.path),
      "规则路径重复或非法",
    );
    rulePaths.add(file.path);
    digest(file.sha256, "规则文件摘要");
  }
  assert(
    rulePaths.has("ci/rules/semgrep.yml") &&
      rulePaths.has("ci/rules/gitleaks.toml") &&
      rulePaths.has(lock.rules.license.path),
    "扫描规则闭包不完整",
  );
  return lock;
}

export function loadToolchainLock(root = repositoryRoot) {
  return validateToolchainLock(
    JSON.parse(readFileSync(join(root, "ci/toolchain-lock.json"), "utf8")),
  );
}

export function verifyDownload(bytes, expected) {
  const actual = sha256(bytes);
  assert(actual === expected.sha256, `下载摘要不匹配: ${expected.filename ?? expected.url}`);
  return actual;
}

/** Verified downloads only; a corrupt existing entry fails instead of becoming a cache hit. */
export async function downloadArtifact(expected, directory) {
  artifact(expected);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, expected.filename);
  if (existsSync(path)) {
    verifyDownload(readFileSync(path), expected);
    return path;
  }
  const response = await fetch(expected.url, { signal: AbortSignal.timeout(120_000) });
  assert(response.ok, `工具下载失败: ${expected.filename} (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyDownload(bytes, expected);
  writeFileSync(path, bytes, { flag: "wx" });
  return path;
}

export function isolatedEnvironment(directory, binDirectory, { temporaryDirectory } = {}) {
  const home = join(directory, "home");
  const temporary = temporaryDirectory ?? join(directory, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  return {
    HOME: home,
    TMPDIR: temporary,
    PATH: [binDirectory, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":"),
    LANG: "C.UTF-8",
    CI: "true",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_CONFIG_FILE: "/dev/null",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    SEMGREP_SEND_METRICS: "off",
    SEMGREP_ENABLE_VERSION_CHECK: "0",
  };
}

export function verifyRuleFiles(root = repositoryRoot, lock = loadToolchainLock(root)) {
  for (const file of lock.rules.files) {
    const path = join(root, file.path);
    assert(
      realpathSync(path) === join(realpathSync(root), file.path),
      "扫描规则不能通过 symlink 替换",
    );
    assert(sha256(readFileSync(path)) === file.sha256, `扫描规则摘要不匹配: ${file.path}`);
  }
  assert(
    sha256(readFileSync(join(root, lock.rules.license.path))) === lock.rules.license.sha256,
    "扫描规则许可摘要不匹配",
  );
  return lock.rules;
}

/** Revalidate downloads and executable identities after a policy-only lock change. */
export function verifyInstalledTools({ directory, root = repositoryRoot }) {
  const prefix = realpathSync(directory);
  const installation = JSON.parse(readFileSync(join(prefix, "installation.json"), "utf8"));
  const lock = loadToolchainLock(root);
  assert(installation.platform === `${process.platform}-${process.arch}`, "已安装工具平台不匹配");
  assert([lock.node.baseline, lock.node.floor].includes(installation.node), "已安装 Node 不受支持");
  const version = installation.node;
  const platform = installation.platform;
  const expectedDownloads = [
    lock.node.releases[version].artifacts[platform],
    lock.node.releases[version].headers,
    lock.npm.artifact,
    lock.python.artifacts[platform],
  ];
  for (const name of ["actionlint", "gitleaks"])
    if (installation.executables[name])
      expectedDownloads.push(lock.tools[name].artifacts[platform]);
  for (const expected of expectedDownloads)
    verifyDownload(readFileSync(join(prefix, "downloads", expected.filename)), expected);
  if (installation.executables.semgrep)
    for (const expected of lock.tools.semgrep.wheels[platform])
      verifyDownload(readFileSync(join(prefix, "wheels", expected.filename)), expected);
  for (const executable of Object.values(installation.executables))
    assert(realpathSync(executable).startsWith(`${prefix}/`), "工具路径越过安装前缀");
  const env = isolatedEnvironment(prefix, join(prefix, "bin"));
  if (installation.executables.semgrep)
    env.SSL_CERT_FILE = join(
      prefix,
      "semgrep",
      "lib",
      `python${lock.python.version.split(".").slice(0, 2).join(".")}`,
      "site-packages/certifi/cacert.pem",
    );
  const run = (command, args) =>
    execFileSync(command, args, {
      cwd: prefix,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  const { executables } = installation;
  assert(run(executables.node, ["--version"]) === `v${version}`, "Node 实际身份不匹配");
  assert(
    run(executables.node, [executables.npmCli, "--version"]) === lock.npm.version,
    "npm 实际身份不匹配",
  );
  assert(
    run(executables.python, ["--version"]) === `Python ${lock.python.version}`,
    "Python 实际身份不匹配",
  );
  const members = [
    [
      lock.node.releases[version].artifacts[platform],
      `node-v${version}-${platform}/bin/node`,
      executables.node,
    ],
    [lock.npm.artifact, "package/bin/npm-cli.js", executables.npmCli],
    [lock.npm.artifact, "package/node_modules/node-gyp/bin/node-gyp.js", executables.nodeGyp],
    [
      lock.python.artifacts[platform],
      `python/bin/python${lock.python.version.split(".").slice(0, 2).join(".")}`,
      executables.python,
    ],
  ];
  for (const name of ["actionlint", "gitleaks"]) {
    if (!executables[name]) continue;
    assert(
      run(executables[name], name === "actionlint" ? ["-version"] : ["version"]).split("\n")[0] ===
        lock.tools[name].version,
      `${name} 实际身份不匹配`,
    );
    members.push([lock.tools[name].artifacts[platform], name, executables[name]]);
  }
  for (const [archive, member, actual] of members) {
    const expected = execFileSync(
      "tar",
      ["-xOf", join(prefix, "downloads", archive.filename), member],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    assert(
      sha256(readFileSync(actual)) === sha256(expected),
      `工具 executable 与固定归档不匹配: ${member}`,
    );
  }
  if (executables.semgrep)
    assert(
      run(executables.semgrep, ["--version"]).split("\n").at(-1) === lock.tools.semgrep.version,
      "Semgrep 实际身份不匹配",
    );
  verifyRuleFiles(root, lock);
  const record = {
    ...installation,
    schemaVersion: 1,
    toolchainSha256: sha256(readFileSync(join(root, "ci/toolchain-lock.json"))),
    originalInstallationSha256: sha256(readFileSync(join(prefix, "installation.json"))),
    verification: "download-digests-executable-bytes-and-runtime-versions",
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(join(prefix, "verification.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function extractArchive(archive, directory) {
  mkdirSync(directory, { recursive: true });
  const entries = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  assert(
    entries.length > 0 &&
      entries.every((path) => path && !path.startsWith("/") && !path.split("/").includes("..")),
    "工具归档包含非法路径",
  );
  execFileSync("tar", ["-xzf", archive, "--no-same-owner", "-C", directory], { stdio: "pipe" });
}

/** Installs into a fresh explicit prefix. It does not change global tools or the repository. */
export async function installTools({
  directory,
  root = repositoryRoot,
  nodeVersion,
  includeScanners = true,
}) {
  assert(directory && resolve(directory) !== root, "必须提供独立工具安装目录");
  const prefix = resolve(directory);
  assert(!existsSync(prefix) || readdirSync(prefix).length === 0, "工具安装目录必须为空");
  const lock = loadToolchainLock(root);
  const version = nodeVersion ?? lock.node.baseline;
  assert([lock.node.baseline, lock.node.floor].includes(version), "不支持的 Node 版本");
  const platform = `${process.platform}-${process.arch}`;
  assert(platforms.includes(platform), `不支持的平台: ${platform}`);
  mkdirSync(prefix, { recursive: true });
  const downloads = join(prefix, "downloads");
  const bin = join(prefix, "bin");
  mkdirSync(bin);
  const installs = [
    ["node", lock.node.releases[version].artifacts[platform]],
    ["npm", lock.npm.artifact],
    ["python", lock.python.artifacts[platform]],
    ["headers", lock.node.releases[version].headers],
  ];
  if (includeScanners)
    for (const name of ["actionlint", "gitleaks"])
      installs.push([name, lock.tools[name].artifacts[platform]]);
  for (const [name, item] of installs)
    extractArchive(await downloadArtifact(item, downloads), join(prefix, name));
  const executables = {
    node: join(prefix, "node", `node-v${version}-${platform}`, "bin/node"),
    npmCli: join(prefix, "npm/package/bin/npm-cli.js"),
    nodeGyp: join(prefix, "npm/package/node_modules/node-gyp/bin/node-gyp.js"),
    python: join(prefix, "python/python/bin/python3"),
    nodeHeaders: join(prefix, "headers", `node-v${version}`),
  };
  for (const [name, target] of [
    ["node", executables.node],
    ["npm", executables.npmCli],
    ["python3", executables.python],
  ])
    symlinkSync(target, join(bin, name));
  const env = isolatedEnvironment(prefix, bin);
  const run = (command, args) =>
    execFileSync(command, args, {
      env,
      cwd: prefix,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  assert(run(executables.node, ["--version"]) === `v${version}`, "Node 下载物实际版本不匹配");
  assert(
    run(executables.node, [executables.npmCli, "--version"]) === lock.npm.version,
    "npm 下载物实际版本不匹配",
  );
  assert(
    run(executables.python, ["--version"]) === `Python ${lock.python.version}`,
    "Python 下载物实际版本不匹配",
  );
  if (includeScanners) {
    for (const name of ["actionlint", "gitleaks"]) {
      executables[name] = join(prefix, name, name);
      symlinkSync(executables[name], join(bin, name));
      const actual = run(executables[name], name === "actionlint" ? ["-version"] : ["version"]);
      assert(actual.split("\n")[0] === lock.tools[name].version, `${name} 实际版本不匹配`);
    }
    const wheelsDirectory = join(prefix, "wheels");
    for (const wheel of lock.tools.semgrep.wheels[platform])
      await downloadArtifact(
        { filename: wheel.filename, url: wheel.url, sha256: wheel.sha256 },
        wheelsDirectory,
      );
    const requirements = join(prefix, "semgrep-requirements.txt");
    writeFileSync(
      requirements,
      `${lock.tools.semgrep.wheels[platform].map((wheel) => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`).join("\n")}\n`,
    );
    const venv = join(prefix, "semgrep");
    run(executables.python, ["-I", "-m", "venv", venv]);
    run(join(venv, "bin/python"), [
      "-I",
      "-m",
      "pip",
      "install",
      "--no-index",
      "--no-deps",
      "--require-hashes",
      "--no-cache-dir",
      "--no-compile",
      "--find-links",
      wheelsDirectory,
      "-r",
      requirements,
    ]);
    run(join(venv, "bin/python"), ["-I", "-m", "pip", "check"]);
    executables.semgrep = join(venv, "bin/semgrep");
    env.SSL_CERT_FILE = join(
      venv,
      "lib",
      `python${lock.python.version.split(".").slice(0, 2).join(".")}`,
      "site-packages/certifi/cacert.pem",
    );
    symlinkSync(executables.semgrep, join(bin, "semgrep"));
    assert(
      run(executables.semgrep, ["--version"]).split("\n").at(-1) === lock.tools.semgrep.version,
      "Semgrep 实际版本不匹配",
    );
  }
  const record = {
    schemaVersion: 1,
    platform,
    node: version,
    npm: lock.npm.version,
    python: lock.python.version,
    nodeAbi: run(executables.node, ["-p", "process.versions.modules"]),
    toolchainSha256: sha256(readFileSync(join(root, "ci/toolchain-lock.json"))),
    executables,
  };
  writeFileSync(join(prefix, "installation.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--check") {
      loadToolchainLock();
      console.log("ToolchainLock validation passed");
    } else {
      const options = {};
      for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === "--without-scanners") options.includeScanners = false;
        else if (argument === "--directory" && args[index + 1]) options.directory = args[++index];
        else if (argument === "--node" && args[index + 1]) options.nodeVersion = args[++index];
        else throw new Error(`未知工具安装参数: ${argument}`);
      }
      console.log(JSON.stringify(await installTools(options), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
