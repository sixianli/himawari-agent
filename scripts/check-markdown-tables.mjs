import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_DIRECTORIES = ["docs"];

export function cellCount(line) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  let count = 1;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\") index += 1;
    else if (body[index] === "|") count += 1;
  }
  return count;
}

const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export function findTableProblems(text) {
  const lines = text.split("\n");
  const problems = [];
  let fence = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length)
        fence = null;
      index += 1;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    if (line.trimStart().startsWith("|") && next !== undefined && DELIMITER_ROW.test(next)) {
      const columns = cellCount(line);
      if (cellCount(next) !== columns)
        problems.push({ line: index + 2, found: cellCount(next), expected: columns });
      let row = index + 2;
      while (row < lines.length && lines[row].trimStart().startsWith("|")) {
        const found = cellCount(lines[row]);
        if (found !== columns) problems.push({ line: row + 1, found, expected: columns });
        row += 1;
      }
      index = row;
      continue;
    }
    index += 1;
  }
  return problems;
}

function walk(root, relativeDirectory, found) {
  const absolute = path.join(root, relativeDirectory);
  if (!existsSync(absolute)) return;
  for (const name of readdirSync(absolute).sort()) {
    const relative = `${relativeDirectory}/${name}`;
    if (statSync(path.join(root, relative)).isDirectory()) walk(root, relative, found);
    else if (name.endsWith(".md")) found.push(relative);
  }
}

export function checkMarkdownTables({ root = repositoryRoot } = {}) {
  const files = [];
  for (const directory of SCANNED_DIRECTORIES) walk(root, directory, files);
  const errors = [];
  for (const relative of files) {
    const text = readFileSync(path.join(root, relative), "utf8");
    for (const problem of findTableProblems(text))
      errors.push(
        `MARKDOWN_TABLE_COLUMNS ${relative}:${problem.line} 这一行有 ${problem.found} 列，表头是 ${problem.expected} 列`,
      );
  }
  return { errors, scanned: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, scanned } = checkMarkdownTables();
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `MARKDOWN_TABLES ${errors.length === 0 ? "passed" : "failed"} files=${scanned} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
