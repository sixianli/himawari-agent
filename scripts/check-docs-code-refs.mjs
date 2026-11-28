import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Lexer } from "marked";
import { docsMarkdownFiles } from "./check-docs-links.mjs";
import { globPattern } from "./docs-drift.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORD = /[A-Za-z_$][\w$-]*/g;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const DEPENDENCY_TEXT = /\.(?:d\.ts|d\.mts|js|mjs|cjs|md)$/;
const CODE_FILE =
  /^[\w@-]+\.(?:ts|tsx|mts|mjs|js|cjs|json|jsonl|py|sh|swift|toml|ya?ml|sql|html|css)$/;
const BUILT_FROM_SOURCE = /\.(?:ts|mts|tsx)$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const MAX_CODE_FILE_BYTES = 4 * 1024 * 1024;
const EXCLUDE_FILE = "docs/.governance-exclude";
const IGNORE_FILE = "docs/.governance-references-ignore";
const REFERENCE_EXEMPT_TYPES = new Set(["spec", "plan", "idea", "backlog"]);
const VERIFIED_REQUIRED = ["docs/adr/", "docs/runbooks/"];

export function frontmatterOf(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return { fields: null, body: text };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return { fields, body: text.slice(match[0].length) };
}

export function listOf(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function walkTokens(tokens, visit, external = false) {
  for (const token of tokens) {
    visit(token, external);
    const inside = external || (token.type === "link" && /^[a-z][a-z0-9+.-]*:/i.test(token.href));
    if (token.tokens) walkTokens(token.tokens, visit, inside);
    if (token.items) walkTokens(token.items, visit, inside);
    if (token.type === "table")
      for (const cell of [...token.header, ...token.rows.flat()])
        walkTokens(cell.tokens, visit, inside);
  }
}

export function classifyReference(text, topLevel = null) {
  const value = text.trim();
  if (!value || /[<>*{}$…|]|\.\.\./.test(value)) return null;
  const script = /^npm run ([\w:.-]+)/.exec(value);
  if (script) return { kind: "script", value: script[1] };
  const runner = /^(?:node|python3|bash|sh)\s+(?:\.\/)?([\w./@-]+\.\w+)(?:\s|$)/.exec(value);
  if (runner) return { kind: "path", value: runner[1] };
  if (/\s/.test(value)) return null;
  const bare = value.replace(/:\d+(?:-\d+)?$/, "").replace(/#.*$/, "");
  if (
    bare.includes("/") &&
    /^[\w.@/-]+$/.test(bare) &&
    !/^[./-]/.test(bare) &&
    !bare.includes("//")
  ) {
    if (!topLevel || topLevel.has(bare.split("/")[0])) return { kind: "path", value: bare };
    const last = bare.split("/").at(-1);
    return CODE_FILE.test(last) ? { kind: "file", value: last } : null;
  }
  if (CODE_FILE.test(bare)) return { kind: "file", value: bare };
  const name = value.replace(/\(\)$/, "");
  if (
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name) &&
    /[a-z][A-Z]|_|^[A-Z][a-z]+[A-Z]|\./.test(name) &&
    !/^[a-z]+\.[a-z]{2,4}$/.test(name)
  )
    return { kind: "name", value: name };
  return null;
}

export function referencesIn(markdown, topLevel = null) {
  const references = [];
  walkTokens(new Lexer().lex(markdown), (token, external) => {
    if (token.type !== "codespan" || external) return;
    const reference = classifyReference(token.text, topLevel);
    if (reference) references.push({ ...reference, text: token.text.trim() });
  });
  return references;
}

function trackedFiles(root) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=off", "ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    const files = [];
    const walk = (directory) => {
      for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(relative);
        else files.push(relative);
      }
    };
    walk("");
    return files;
  }
}

function isCodeFile(file) {
  return (
    !file.endsWith(".md") &&
    !file.startsWith("docs/") &&
    !file.startsWith(".agents/") &&
    !file.startsWith("test/qualification/evidence/")
  );
}

function readText(absolute) {
  try {
    if (lstatSync(absolute).size > MAX_CODE_FILE_BYTES) return "";
    const text = readFileSync(absolute, "utf8");
    return text.includes("\0") ? "" : text;
  } catch {
    return "";
  }
}

function declaredDependencies(root, files) {
  const names = new Set();
  for (const file of files.filter((entry) => path.basename(entry) === "package.json")) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
    } catch {
      continue;
    }
    for (const field of DEPENDENCY_FIELDS)
      for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
  }
  return names;
}

function addWords(words, text) {
  for (const word of text.match(WORD) ?? []) words.add(word);
}

export function buildCodeIndex(root = repositoryRoot) {
  const files = trackedFiles(root);
  const paths = new Set();
  const basenames = new Set();
  const words = new Set();
  const scripts = new Set();
  const texts = [];
  for (const file of files) {
    paths.add(file);
    for (
      let directory = path.posix.dirname(file);
      directory !== ".";
      directory = path.posix.dirname(directory)
    )
      paths.add(directory);
    const name = path.posix.basename(file);
    basenames.add(name);
    if (BUILT_FROM_SOURCE.test(name)) {
      basenames.add(name.replace(BUILT_FROM_SOURCE, ".js"));
      basenames.add(name.replace(BUILT_FROM_SOURCE, ".mjs"));
    }
    if (!isCodeFile(file)) continue;
    const text = readText(path.join(root, file));
    texts.push(text);
    addWords(words, text);
    if (name === "package.json")
      try {
        for (const script of Object.keys(JSON.parse(text).scripts ?? {})) scripts.add(script);
      } catch {}
  }
  for (const dependency of declaredDependencies(root, files)) {
    let base;
    try {
      base = realpathSync(path.join(root, "node_modules", dependency));
    } catch {
      continue;
    }
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const absolute = path.join(directory, entry.name);
        paths.add(path.relative(base, absolute).split(path.sep).join("/"));
        if (entry.isDirectory()) walk(absolute);
        else {
          basenames.add(entry.name);
          if (DEPENDENCY_TEXT.test(entry.name)) addWords(words, readText(absolute));
        }
      }
    };
    walk(base);
  }
  const corpus = texts.join("\n");
  const ignored = (value) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", "--", value], {
        cwd: root,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
  const topLevel = new Set(files.map((file) => file.split("/")[0]));
  return { paths, basenames, words, scripts, corpus, ignored, topLevel };
}

function builtFromPrefix(name, corpus) {
  for (let end = name.lastIndexOf("_"); end >= 7; end = name.lastIndexOf("_", end - 1)) {
    const prefix = name.slice(0, end + 1);
    if (['"', "'", "`"].some((quote) => corpus.includes(`${quote}${prefix}`))) return true;
  }
  return false;
}

export function resolves(reference, index) {
  const { kind, value } = reference;
  if (kind === "script") return index.scripts.has(value);
  if (kind === "path" && index.paths.has(value.replace(/\/$/, ""))) return true;
  if (kind === "file" && index.basenames.has(value)) return true;
  if (kind === "name" && value.split(".").every((segment) => index.words.has(segment))) return true;
  if (index.corpus.includes(value)) return true;
  if (kind === "name" && builtFromPrefix(value, index.corpus)) return true;
  return kind === "path" && index.ignored(value);
}

function commitExists(root, commit) {
  try {
    if (isShallow(root)) return true;
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isShallow(root) {
  return (
    execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: root,
      encoding: "utf8",
    }).trim() === "true"
  );
}

export function mainlineRef(root, env = process.env) {
  const ref = `origin/${env.GITHUB_BASE_REF || "main"}`;
  try {
    if (isShallow(root)) return "";
    execFileSync("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
    return ref;
  } catch {
    return "";
  }
}

function onMainline(root, commit, mainline) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, mainline], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function linesOf(root, file) {
  try {
    return readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function coveredPathExists(entry, index) {
  const bare = entry.replace(/\/$/, "");
  if (!/[*?]/.test(bare)) return index.paths.has(bare);
  const pattern = globPattern(bare);
  for (const known of index.paths) if (pattern.test(known)) return true;
  return false;
}

export function documentType(file, fields) {
  if (fields.document_type) return fields.document_type;
  if (file.startsWith("docs/execution/specs/")) return "spec";
  if (file.startsWith("docs/execution/plans/")) return "plan";
  if (file.startsWith("docs/ideas/")) return "idea";
  if (file.startsWith("docs/backlog/")) return "backlog";
  return "";
}

export function requiresVerification(file) {
  return VERIFIED_REQUIRED.some((prefix) => file.startsWith(prefix));
}

export function checkDocsCodeRefs({
  root = repositoryRoot,
  index = buildCodeIndex(root),
  mainline = "",
} = {}) {
  const errors = [];
  let checked = 0;
  const excluded = linesOf(root, EXCLUDE_FILE).map((entry) => entry.replace(/\/$/, ""));
  const ignores = linesOf(root, IGNORE_FILE).map((entry) => ({
    entry,
    pattern: globPattern(entry),
  }));
  const ignored = (text, value) =>
    ignores.some(
      ({ entry, pattern }) =>
        entry === text || entry === value || pattern.test(text) || pattern.test(value),
    );
  for (const file of docsMarkdownFiles(root)) {
    if (excluded.some((entry) => file === entry || file.startsWith(`${entry}/`))) continue;
    const { fields, body } = frontmatterOf(readFileSync(path.join(root, file), "utf8"));
    if (!fields) continue;
    const inProgress = fields.implementation === "in_progress";
    const verifiedAt = fields.verified_at ?? "";
    if (requiresVerification(file)) {
      if (!("covers" in fields)) errors.push(`DOCS_COVERS_FIELD_MISSING ${file}`);
      if (!verifiedAt) errors.push(`DOCS_VERIFIED_AT_EMPTY ${file}`);
    }
    if (listOf(fields.covers).length && !verifiedAt) errors.push(`DOCS_VERIFIED_AT_EMPTY ${file}`);
    if (verifiedAt && !COMMIT.test(verifiedAt))
      errors.push(`DOCS_VERIFIED_AT_INVALID ${file} -> ${verifiedAt}`);
    else if (verifiedAt && !commitExists(root, verifiedAt))
      errors.push(`DOCS_VERIFIED_AT_UNKNOWN ${file} -> ${verifiedAt}`);
    else if (verifiedAt && mainline && !onMainline(root, verifiedAt, mainline))
      errors.push(`DOCS_VERIFIED_AT_OFF_MAINLINE ${file} -> ${verifiedAt} not on ${mainline}`);
    if (inProgress) continue;
    for (const covered of listOf(fields.covers)) {
      checked += 1;
      if (!coveredPathExists(covered, index))
        errors.push(`DOCS_COVERS_MISSING ${file} -> ${covered}`);
    }
    if (REFERENCE_EXEMPT_TYPES.has(documentType(file, fields))) continue;
    const seen = new Set();
    for (const reference of referencesIn(body, index.topLevel)) {
      const key = `${reference.kind} ${reference.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checked += 1;
      if (ignored(reference.text, reference.value)) continue;
      if (!resolves(reference, index)) errors.push(`DOCS_CODE_REF_MISSING ${file} -> ${key}`);
    }
  }
  return { checked, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checked, errors } = checkDocsCodeRefs({ mainline: mainlineRef(repositoryRoot) });
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (errors.length)
    process.stderr.write(
      "DOCS_CODE_REFS_HINT 文档里写的路径、命令、名字必须在当前代码或已声明的依赖里找得到：改成现在的写法，删掉，或者给历史名字配上固定提交链接；verified_at 要写已经在 main 上的提交，分支上的提交在压缩合并或变基合并后就不存在了（见 .agents/instructions/document-governance.md）\n",
    );
  process.stdout.write(
    `DOCS_CODE_REFS ${errors.length === 0 ? "passed" : "failed"} checked=${checked} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
