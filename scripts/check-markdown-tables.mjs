import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

const hasPipe = (line) => splitOnPipes(line.trim()).length > 1;
const CONTAINER_PREFIX = /^\s*(>\s?)*/;
const content = (line) => line.replace(CONTAINER_PREFIX, "");
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const isDelimiterRow = (line) => {
  const text = content(line).trim();
  return text.includes("|") && text.includes("-") && DELIMITER_ROW.test(text);
};
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

function closesFence(line, fence) {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(match && match[1][0] === fence[0] && match[1].length >= fence.length);
}

export function findTableProblems(text) {
  const lines = text.split("\n");
  const problems = [];
  let fence = null;
  let index = 0;
  while (index < lines.length) {
    const line = content(lines[index]);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      index += 1;
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    if (opening) {
      fence = opening[1];
      index += 1;
      continue;
    }
    const next = lines[index + 1];
    if (hasPipe(line) && next !== undefined && isDelimiterRow(next)) {
      const columns = cellCount(line);
      const delimiterColumns = cellCount(content(next));
      if (delimiterColumns !== columns)
        problems.push({ line: index + 2, found: delimiterColumns, expected: columns });
      let row = index + 2;
      while (
        row < lines.length &&
        content(lines[row]).trim() !== "" &&
        hasPipe(content(lines[row]))
      ) {
        const found = cellCount(content(lines[row]));
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
