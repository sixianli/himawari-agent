import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GLOSSARY_FILE = "docs/glossary.md";

const SCANNED_FILES = ["AGENTS.md", "README.md", "CLAUDE.md"];
const SCANNED_DIRECTORIES = [
  { directory: ".claude/rules", extensions: [".md"] },
  { directory: ".agents/instructions", extensions: [".md"] },
  { directory: "apps/control-center/src/i18n/resources", extensions: [".ts"] },
  { directory: "docs", extensions: [".md"] },
];
const EXEMPT_PREFIXES = [
  "docs/adr/",
  "docs/archive/",
  "docs/assets/",
  "docs/runbooks/",
  "docs/execution/plans/",
  "docs/product-vision.md",
  "docs/lessons.md",
  GLOSSARY_FILE,
];

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const backticked = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

export function readGlossary(text) {
  const entries = [];
  const errors = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const [id, newCell, oldCell, , scope] = cells(line);
    if (!/^\d+$/.test(id ?? "")) continue;
    const newNames = backticked(newCell ?? "");
    const oldNames = backticked(oldCell ?? "");
    if (newNames.length === 0) errors.push(`GLOSSARY_ROW_WITHOUT_NEW_NAME ${id}`);
    entries.push({ id, newNames, oldNames, interfaceOnly: (scope ?? "").includes("仅界面") });
  }
  if (entries.length === 0) errors.push("GLOSSARY_TABLE_EMPTY");
  return { entries, errors };
}

function walk(root, relativeDirectory, extensions, found) {
  const absolute = path.join(root, relativeDirectory);
  if (!existsSync(absolute)) return;
  for (const name of readdirSync(absolute)) {
    const relative = `${relativeDirectory}/${name}`;
    const stats = statSync(path.join(root, relative));
    if (stats.isDirectory()) {
      if (!EXEMPT_PREFIXES.some((prefix) => `${relative}/`.startsWith(prefix)))
        walk(root, relative, extensions, found);
    } else if (
      extensions.includes(path.extname(name)) &&
      !EXEMPT_PREFIXES.some((prefix) => relative === prefix)
    ) {
      found.push(relative);
    }
  }
}

export function scannedFiles(root) {
  const found = SCANNED_FILES.filter((file) => existsSync(path.join(root, file)));
  for (const { directory, extensions } of SCANNED_DIRECTORIES)
    walk(root, directory, extensions, found);
  return found;
}

function occurrences(text, needle) {
  const spans = [];
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1))
    spans.push([index, index + needle.length]);
  return spans;
}

const INTERFACE_DIRECTORY = "apps/control-center/src/i18n/resources/";

export function findOldTerms(text, entries, { file = "" } = {}) {
  const inInterface = file.startsWith(INTERFACE_DIRECTORY);
  const newSpans = entries.flatMap((entry) =>
    entry.newNames.flatMap((name) => occurrences(text, name)),
  );
  const hits = [];
  for (const entry of entries) {
    if (entry.interfaceOnly && !inInterface) continue;
    for (const term of entry.oldNames) {
      for (const [start, end] of occurrences(text, term)) {
        if (newSpans.some(([newStart, newEnd]) => newStart <= start && end <= newEnd)) continue;
        const line = text.slice(0, start).split("\n").length;
        hits.push({ id: entry.id, term, line, replacement: entry.newNames[0] });
      }
    }
  }
  return hits.sort((left, right) => left.line - right.line);
}

export function checkGlossary({ root = repositoryRoot } = {}) {
  const file = path.join(root, GLOSSARY_FILE);
  if (!existsSync(file)) return { errors: [`GLOSSARY_MISSING ${GLOSSARY_FILE}`], scanned: 0 };
  const { entries, errors } = readGlossary(readFileSync(file, "utf8"));
  const files = scannedFiles(root);
  for (const relative of files) {
    const text = readFileSync(path.join(root, relative), "utf8");
    for (const hit of findOldTerms(text, entries, { file: relative }))
      errors.push(
        `GLOSSARY_OLD_TERM ${relative}:${hit.line} 旧叫法“${hit.term}”应改为“${hit.replacement}”（词表第 ${hit.id} 条）`,
      );
  }
  return { errors, scanned: files.length, terms: entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, scanned, terms } = checkGlossary();
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `GLOSSARY ${errors.length === 0 ? "passed" : "failed"} entries=${terms ?? 0} files=${scanned} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
