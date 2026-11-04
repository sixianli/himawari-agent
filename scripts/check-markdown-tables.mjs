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

function tablesIn(tokens, found) {
  for (const token of tokens) {
    if (token.type === "table") found.push(token.raw);
    for (const key of ["tokens", "items"])
      if (Array.isArray(token[key])) tablesIn(token[key], found);
  }
  return found;
}

const withoutContainers = (line) => line.replace(/^\s*(>\s?)*/, "").trim();

function locate(sourceLines, rows, from) {
  for (let start = from; start + rows.length <= sourceLines.length; start += 1) {
    if (rows.every((row, offset) => withoutContainers(sourceLines[start + offset]) === row.trim()))
      return start;
  }
  return -1;
}

export function findTableProblems(text) {
  const sourceLines = text.split("\n");
  const problems = [];
  let cursor = 0;
  for (const raw of tablesIn(Lexer.lex(text, { gfm: true }), [])) {
    const rows = raw.split("\n").filter((row) => row.trim() !== "");
    const start = locate(sourceLines, rows, cursor);
    if (start >= 0) cursor = start + rows.length;
    const columns = cellCount(rows[0]);
    rows.forEach((row, offset) => {
      const found = cellCount(row);
      if (found !== columns)
        problems.push({
          line: start >= 0 ? start + offset + 1 : null,
          found,
          expected: columns,
          row: row.trim(),
        });
    });
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
