import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTER_FILE = "docs/meaning-word-lists.md";
export const SCANNED_ROOTS = ["apps", "packages", "clients"];
export const ALLOWED_KINDS = ["格式解析", "安全底线", "检索分词", "主人自定义规则", "待删除"];
export const REMOVAL_KIND = "待删除";

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mjs|swift)$/u;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".build", "test", "Tests"]);
const SKIPPED_PATHS = ["packages/prompt-catalog/", "apps/control-center/src/i18n/"];
const SKIPPED_FILE = /\.test\./u;

const NATURAL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const NAMED_LIST =
  /\b(?:const|let|static let|var)\s+([A-Z][A-Z0-9_]*(?:MARKERS?|KEYWORDS?|PHRASES|STOPWORDS|LEXICON|WORDS))\b/u;
const NAMED_VALUE = /^[^=]*=\s*(?:Object\.freeze\(\s*)?(?:\[|new Set|\/[^/\n]+\/)/u;
const DECLARATION = /\b(?:const|let|static let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/u;
const SIMPLE_LITERAL = /^\s*["']([^"'\n]{1,24})["'],?\s*$/u;
const ENGLISH_WORDS =
  /\b(?:ignore|remind|always|never|reply|answer|respond|please|tomorrow|tonight)\b/iu;
const RUN_MINIMUM = 4;
const ALTERNATIVES_MINIMUM = 3;
const LOOKBACK_LINES = 200;

function isNaturalAlternative(alternative) {
  return NATURAL.test(alternative) || /[A-Za-z]{4,}/u.test(alternative);
}

function declarationAbove(lines, index) {
  for (let cursor = index; cursor >= Math.max(0, index - LOOKBACK_LINES); cursor -= 1) {
    const match = DECLARATION.exec(lines[cursor] ?? "");
    if (match) return match[1];
  }
  return null;
}

function isNaturalLiteral(line) {
  const match = SIMPLE_LITERAL.exec(line);
  if (!match) return false;
  return NATURAL.test(match[1]) || /^[A-Za-z]+(?: [A-Za-z']+)+$/u.test(match[1]);
}

export function findWordLists(text, file) {
  const lines = text.split("\n");
  const hits = new Map();
  const add = (symbol, line, shape) => {
    const key = `${file}::${symbol}`;
    if (!hits.has(key)) hits.set(key, { file, symbol, line, shape });
  };
  lines.forEach((line, index) => {
    if (/^\s*(?:\/\/|\*|\/\*)/u.test(line)) return;
    const named = NAMED_LIST.exec(line);
    if (named && NAMED_VALUE.test(line.slice(named.index))) add(named[1], index + 1, "named-list");
    for (const match of line.matchAll(/\/((?:[^/\\\n]|\\.){6,})\/[dgimsuvy]*/gu)) {
      const body = match[1];
      const alternatives = body.split("|").filter(isNaturalAlternative);
      if (alternatives.length < ALTERNATIVES_MINIMUM) continue;
      if (!NATURAL.test(body) && !ENGLISH_WORDS.test(body)) continue;
      const symbol = declarationAbove(lines, index) ?? body.slice(0, 30);
      add(symbol, index + 1, "regex-alternatives");
    }
  });
  let run = 0;
  let start = 0;
  const closeRun = () => {
    if (run >= RUN_MINIMUM) {
      const symbol = declarationAbove(lines, start - 1) ?? `line-${start}`;
      add(symbol, start, "literal-array");
    }
    run = 0;
  };
  lines.forEach((line, index) => {
    if (isNaturalLiteral(line)) {
      if (run === 0) start = index + 1;
      run += 1;
    } else closeRun();
  });
  closeRun();
  return [...hits.values()];
}

function walk(root, relativeDirectory, found) {
  const absolute = path.join(root, relativeDirectory);
  if (!existsSync(absolute)) return;
  for (const name of readdirSync(absolute).sort()) {
    const relative = `${relativeDirectory}/${name}`;
    if (SKIPPED_PATHS.some((prefix) => `${relative}/`.startsWith(prefix))) continue;
    const stats = statSync(path.join(root, relative));
    if (stats.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(name)) walk(root, relative, found);
    } else if (SOURCE_EXTENSIONS.test(name) && !SKIPPED_FILE.test(name)) found.push(relative);
  }
}

export function scanWordLists(root) {
  const files = [];
  for (const scanned of SCANNED_ROOTS) walk(root, scanned, files);
  return files.flatMap((file) => findWordLists(readFileSync(path.join(root, file), "utf8"), file));
}

function cells(line) {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

const backticked = (cell) => /`([^`]+)`/u.exec(cell ?? "")?.[1] ?? "";

export function readRegister(text) {
  const rows = [];
  const errors = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const [fileCell, symbolCell, kind, reason, deadline] = cells(line);
    const file = backticked(fileCell);
    const symbol = backticked(symbolCell);
    if (!file || !symbol) continue;
    const where = `${file}::${symbol}`;
    if (!ALLOWED_KINDS.includes(kind ?? ""))
      errors.push(`WORD_LIST_KIND_INVALID ${where} 类别只能是：${ALLOWED_KINDS.join("、")}`);
    if (!reason) errors.push(`WORD_LIST_REASON_EMPTY ${where}`);
    if (kind === REMOVAL_KIND && !/^\d{4}-\d{2}-\d{2}$/u.test(deadline ?? ""))
      errors.push(`WORD_LIST_DEADLINE_MISSING ${where} “待删除”要写期限（YYYY-MM-DD）`);
    if (rows.some((row) => row.file === file && row.symbol === symbol))
      errors.push(`WORD_LIST_ROW_REPEATED ${where}`);
    rows.push({ file, symbol, kind, reason, deadline: deadline ?? "" });
  }
  return { rows, errors };
}

export function checkWordLists({ root = repositoryRoot, today = new Date() } = {}) {
  const registerPath = path.join(root, REGISTER_FILE);
  if (!existsSync(registerPath))
    return { hits: [], errors: [`WORD_LIST_REGISTER_MISSING ${REGISTER_FILE}`] };
  const { rows, errors } = readRegister(readFileSync(registerPath, "utf8"));
  const hits = scanWordLists(root);
  const registered = new Map(rows.map((row) => [`${row.file}::${row.symbol}`, row]));
  for (const hit of hits) {
    const key = `${hit.file}::${hit.symbol}`;
    const row = registered.get(key);
    if (!row)
      errors.push(
        `WORD_LIST_UNREGISTERED ${hit.file}:${hit.line} ${hit.symbol}（${hit.shape}）：判断用户话里的意思不许写词表，改成交给模型判断；确实只是格式解析等，到 ${REGISTER_FILE} 登记类别和理由`,
      );
    else if (row.kind === REMOVAL_KIND && row.deadline < today.toISOString().slice(0, 10))
      errors.push(`WORD_LIST_DEADLINE_PASSED ${key} 期限 ${row.deadline} 已过，词表还在`);
  }
  const found = new Set(hits.map((hit) => `${hit.file}::${hit.symbol}`));
  for (const row of rows)
    if (row.kind !== REMOVAL_KIND && !found.has(`${row.file}::${row.symbol}`))
      errors.push(
        `WORD_LIST_ROW_STALE ${row.file}::${row.symbol} 登记了但代码里已找不到，删掉这一行`,
      );
  if (rows.length === 0) errors.push("WORD_LIST_REGISTER_EMPTY");
  return { hits, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { hits, errors } = checkWordLists();
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `MEANING_WORD_LISTS ${errors.length === 0 ? "passed" : "failed"} found=${hits.length} errors=${errors.length}\n`,
  );
  process.exit(errors.length === 0 ? 0 : 1);
}
