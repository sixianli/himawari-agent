import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Lexer } from "marked";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_DIRECTORIES = ["docs"];

function splitOnPipes(line) {
  const parts = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\\" && index + 1 < line.length) {
      current += line[index] + line[index + 1];
      index += 1;
    } else if (line[index] === "|") {
      parts.push(current);
      current = "";
    } else {
      current += line[index];
    }
  }
  parts.push(current);
  return parts;
}

export function cellCount(line) {
  const body = line.trim();
  const parts = splitOnPipes(body);
  if (parts.length > 1 && body.startsWith("|")) parts.shift();
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

function blocksIn(tokens, found) {
  for (const token of tokens) {
    if (token.type === "table" || token.type === "paragraph") found.push(token);
    for (const key of ["tokens", "items"])
      if (Array.isArray(token[key])) blocksIn(token[key], found);
  }
  return found;
}

const withoutContainers = (line) =>
  line.replace(/^\s*(?:(?:>\s?|(?:[-*+]|\d{1,9}[.)])\s+)\s*)*/, "").trim();

function locate(sourceLines, rows, from, to) {
  for (let start = from; start + rows.length <= to; start += 1) {
    if (rows.every((row, offset) => withoutContainers(sourceLines[start + offset]) === row.trim()))
      return start;
  }
  return -1;
}

const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const looksLikeDelimiter = (row) => row.includes("|") && DELIMITER_ROW.test(row.trim());

function problemsInBlock(token) {
  const rows = token.raw.split("\n").filter((row) => row.trim() !== "");
  const problems = [];
  if (token.type === "table") {
    const columns = cellCount(rows[0]);
    rows.forEach((row, offset) => {
      const found = cellCount(row);
      if (found !== columns) problems.push({ offset, found, expected: columns, row: row.trim() });
    });
    return { rows, problems };
  }
  rows.forEach((row, offset) => {
    const next = rows[offset + 1];
    if (row.includes("|") && next !== undefined && looksLikeDelimiter(next)) {
      const expected = cellCount(row);
      const found = cellCount(next);
      if (found !== expected)
        problems.push({ offset: offset + 1, found, expected, row: next.trim() });
    }
  });
  return { rows, problems };
}

export function findTableProblems(text) {
  const sourceLines = text.replace(/\r\n|\r/g, "\n").split("\n");
  const problems = [];
  let blockStart = 0;
  for (const topLevel of Lexer.lex(text, { gfm: true })) {
    const blockEnd = blockStart + topLevel.raw.split("\n").length - 1;
    let cursor = blockStart;
    for (const block of blocksIn([topLevel], [])) {
      const { rows, problems: found } = problemsInBlock(block);
      if (found.length === 0) continue;
      const start = locate(sourceLines, rows, cursor, Math.max(blockEnd, blockStart + 1) + 1);
      if (start >= 0) cursor = start + rows.length;
      for (const { offset, ...problem } of found)
        problems.push({ line: start >= 0 ? start + offset + 1 : null, ...problem });
    }
    blockStart = blockEnd;
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
  if (files.length === 0) errors.push("MARKDOWN_TABLES_NO_FILES docs/ 下没有找到任何 .md 文件");
  for (const relative of files) {
    const text = readFileSync(path.join(root, relative), "utf8");
    for (const problem of findTableProblems(text))
      errors.push(
        `MARKDOWN_TABLE_COLUMNS ${relative}:${problem.line ?? "?"} 这一行有 ${problem.found} 列，表头是 ${problem.expected} 列`,
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
