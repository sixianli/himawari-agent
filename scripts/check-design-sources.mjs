#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const designSourceFiles = ["AGENTS.md", "docs/ui-ux-design-guide.md"];

export const designSourceDirectories = [
  ".claude/rules",
  ".agents/instructions",
  "docs/assets/apple-clients",
];

export const webReferencePatterns = [
  { code: "web-code", pattern: /control-center/ },
  { code: "web-baseline", pattern: /web-design-baselines/ },
  { code: "web-rules", pattern: /照网页|网页的规则|网页设计|Himawari 网页|真实网页/ },
];

export function findWebReferences(text, file) {
  const problems = [];
  text.split("\n").forEach((line, index) => {
    for (const { code, pattern } of webReferencePatterns) {
      const match = line.match(pattern);
      if (match) problems.push({ file, line: index + 1, code, text: match[0] });
    }
  });
  return problems;
}

async function markdownFilesUnder(root, directory) {
  const absolute = path.join(root, directory);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

export async function checkDesignSources(root = repositoryRoot) {
  const files = [...designSourceFiles];
  for (const directory of designSourceDirectories)
    files.push(...(await markdownFilesUnder(root, directory)));
  const problems = [];
  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8");
    problems.push(...findWebReferences(text, file));
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await checkDesignSources();
  for (const problem of problems) {
    console.error(
      `DESIGN_SOURCE_WEB ${problem.file}:${problem.line} ${problem.code} “${problem.text}”：网页已决定删除（ADR 0309），设计文档和规则不得拿网页当依据，见 docs/ui-ux-design-guide.md`,
    );
  }
  if (problems.length > 0) process.exit(1);
  console.log("DESIGN_SOURCES_OK");
}
