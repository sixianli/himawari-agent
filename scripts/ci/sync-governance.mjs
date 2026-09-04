import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRepository = "https://github.com/sixianli/agent-skills";
const sourceDirectory = "document-governance";
const sourceRevision = "70dce9fbf5dd3bd1f44db3327dcf0571fe4f2655";
const copiedFiles = [
  "SKILL.md",
  "references/validation-rules.md",
  "scripts/idea_backlog.py",
  "scripts/runbook.py",
  "scripts/validate_docs.py",
];
const localImports = {
  "scripts/idea_backlog.py": [],
  "scripts/runbook.py": [],
  "scripts/validate_docs.py": ["idea_backlog", "runbook"],
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function regularFile(root, path) {
  assert(!path.startsWith("/") && !path.split("/").includes(".."), `非法治理路径: ${path}`);
  const absolute = join(root, path);
  assert(
    existsSync(absolute) && lstatSync(absolute).isFile(),
    `治理文件缺失或不是普通文件: ${path}`,
  );
  assert(
    !relative(realpathSync(root), realpathSync(absolute)).startsWith(".."),
    `治理路径越界: ${path}`,
  );
  return readFileSync(absolute);
}

function listFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `治理目录不接受符号链接: ${path}`);
    return entry.isDirectory() ? listFiles(root, path) : [path];
  });
}

/** CI reads the complete snapshot and permission evidence; it never synchronizes or reseals it. */
export function verifyGovernance(root = repositoryRoot) {
  const directory = join(root, "tools/document-governance");
  const provenance = JSON.parse(regularFile(directory, "provenance.json"));
  assert(provenance.schemaVersion === 1, "未知治理来源 schema");
  assert(provenance.repository === sourceRepository, "治理来源仓库不匹配");
  assert(/^[a-f0-9]{40}$/.test(provenance.revision), "治理来源必须是完整提交 SHA");
  assert(provenance.directory === sourceDirectory, "治理来源目录不匹配");
  assert(provenance.entrypoint === "scripts/validate_docs.py", "治理入口不匹配");
  assert(provenance.authorization?.status === "owner_authorized", "缺少治理复制与公开分发授权");
  assert(provenance.authorization.path === "PERMISSION.md", "治理授权路径不匹配");
  assert(
    hash(regularFile(directory, "PERMISSION.md")) === provenance.authorization.sha256,
    "治理授权证据摘要不匹配",
  );
  assert(Array.isArray(provenance.files), "治理来源文件清单缺失");
  assert(
    JSON.stringify(provenance.files.map((file) => file.path).sort()) ===
      JSON.stringify(copiedFiles),
    "治理来源文件闭包不完整或重复",
  );
  for (const file of provenance.files) {
    assert(
      hash(regularFile(directory, file.path)) === file.sha256,
      `治理文件摘要不匹配: ${file.path}`,
    );
    assert(
      file.source ===
        `${sourceRepository}/blob/${provenance.revision}/${sourceDirectory}/${file.path}`,
      `治理文件来源不匹配: ${file.path}`,
    );
  }
  assert(
    JSON.stringify(provenance.localImports) === JSON.stringify(localImports),
    "治理模块依赖闭包不匹配",
  );
  const expected = [...copiedFiles, "PERMISSION.md", "provenance.json"].sort();
  assert(
    JSON.stringify(listFiles(directory).sort()) === JSON.stringify(expected),
    "治理快照包含未登记文件",
  );
  return {
    revision: provenance.revision,
    files: provenance.files.length,
    sha256: hash(JSON.stringify(provenance)),
  };
}

/** Explicit maintenance only. The source must be a clean, exact upstream checkout. */
export function syncGovernance({
  source,
  root = repositoryRoot,
  revision = sourceRevision,
  python = "python3",
}) {
  assert(source, "同步必须显式提供 --source 源仓库目录");
  const sourceRoot = realpathSync(source);
  const git = (...args) =>
    execFileSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" }).trim();
  assert(git("rev-parse", "HEAD") === revision, "治理源码不是声明的来源提交");
  assert(
    git("remote", "get-url", "origin").replace(/\.git$/, "") === sourceRepository,
    "治理源仓库 origin 不匹配",
  );
  assert(git("status", "--porcelain", "--", sourceDirectory) === "", "治理源码有未提交变更");
  const directory = join(root, "tools/document-governance");
  const permission = regularFile(directory, "PERMISSION.md");
  assert(permission.toString().includes("Owner 的明确回复"), "缺少明确的 Owner 授权记录");
  const closureScript = [
    "import ast,json,pathlib,sys",
    "root=pathlib.Path(sys.argv[1])",
    "result={}",
    "for path in sorted(root.glob('*.py')):",
    " tree=ast.parse(path.read_text()); names=set()",
    " for node in ast.walk(tree):",
    "  if isinstance(node,ast.Import): names.update(a.name.split('.')[0] for a in node.names)",
    "  elif isinstance(node,ast.ImportFrom) and node.module: names.add(node.module.split('.')[0])",
    " result['scripts/'+path.name]=sorted(names-set(sys.stdlib_module_names))",
    "print(json.dumps(result,sort_keys=True))",
  ].join("\n");
  const imports = JSON.parse(
    execFileSync(
      python,
      ["-I", "-B", "-c", closureScript, join(sourceRoot, sourceDirectory, "scripts")],
      { encoding: "utf8" },
    ),
  );
  for (const [path, expected] of Object.entries(localImports)) {
    assert(
      JSON.stringify(imports[path]) === JSON.stringify(expected),
      `上游模块闭包变化，需要重新审阅: ${path}`,
    );
  }
  const files = copiedFiles.map((path) => {
    const bytes = regularFile(join(sourceRoot, sourceDirectory), path);
    return {
      path,
      source: `${sourceRepository}/blob/${revision}/${sourceDirectory}/${path}`,
      sha256: hash(bytes),
    };
  });
  for (const { path } of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    copyFileSync(join(sourceRoot, sourceDirectory, path), join(directory, path));
  }
  const provenanceText = `${JSON.stringify(
    {
      schemaVersion: 1,
      repository: sourceRepository,
      revision,
      directory: sourceDirectory,
      entrypoint: "scripts/validate_docs.py",
      pythonMinimum: "3.10.0",
      authorization: {
        status: "owner_authorized",
        date: "2026-09-03",
        scope: "在 himawari-agent 中复制和公开分发该校验器",
        path: "PERMISSION.md",
        sha256: hash(permission),
      },
      files,
      localImports,
    },
    null,
    2,
  )}\n`;
  // Reuse the repository formatter for owned metadata; copied upstream bytes stay untouched.
  const formattedProvenance = execFileSync(
    join(root, "node_modules/.bin/biome"),
    ["format", "--stdin-file-path", join(directory, "provenance.json")],
    { input: provenanceText, encoding: "utf8" },
  );
  writeFileSync(join(directory, "provenance.json"), formattedProvenance);
  return verifyGovernance(root);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--check") console.log(JSON.stringify(verifyGovernance()));
    else if (args.length === 3 && args[0] === "--sync" && args[1] === "--source")
      console.log(JSON.stringify(syncGovernance({ source: args[2] })));
    else
      throw new Error(
        "用法: node scripts/ci/sync-governance.mjs --check | --sync --source <源仓库>",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
