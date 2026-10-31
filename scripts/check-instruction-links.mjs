import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INSTRUCTION_ROOTS = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/rules",
  ".agents/instructions",
]);
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;
const REPOSITORY_PATH =
  /`((?:docs|assets|scripts|apps|packages|test|ci|\.claude|\.agents)\/[A-Za-z0-9_./-]*)`/g;
export const NOT_REPOSITORY_PATHS = Object.freeze(["docs/TODO.md", "assets/templates/"]);
const LOOKS_LIKE_FILE_OR_DIRECTORY = /(\/|\.[A-Za-z0-9]+)$/;
const EXPLICIT_ANCHOR = /<a id="([^"]+)"><\/a>/g;
const HEADING = /^#{1,6}\s+(.+)$/gm;

export function instructionFiles(root = repositoryRoot) {
  const files = [];
  for (const entry of INSTRUCTION_ROOTS) {
    const absolute = path.join(root, entry);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) {
      for (const name of readdirSync(absolute).sort())
        if (name.endsWith(".md")) files.push(path.join(entry, name));
    } else files.push(entry);
  }
  return files;
}

function headingSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(text) {
  const anchors = new Set();
  for (const match of text.matchAll(EXPLICIT_ANCHOR)) anchors.add(match[1]);
  for (const match of text.matchAll(HEADING)) anchors.add(headingSlug(match[1]));
  return anchors;
}

export function checkInstructionLinks({ root = repositoryRoot } = {}) {
  const errors = [];
  let checked = 0;
  for (const file of instructionFiles(root)) {
    const text = readFileSync(path.join(root, file), "utf8");
    const directory = path.dirname(path.join(root, file));
    for (const [, target] of text.matchAll(MARKDOWN_LINK)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      checked += 1;
      const [relative, anchor] = target.split("#");
      const destination = relative ? path.resolve(directory, relative) : path.join(root, file);
      if (!existsSync(destination)) {
        errors.push(`INSTRUCTION_LINK_MISSING ${file} -> ${target}`);
        continue;
      }
      if (
        anchor &&
        destination.endsWith(".md") &&
        !anchorsOf(readFileSync(destination, "utf8")).has(anchor)
      )
        errors.push(`INSTRUCTION_ANCHOR_MISSING ${file} -> ${target}`);
    }
    for (const [, relative] of text.matchAll(REPOSITORY_PATH)) {
      if (/[<>*{}]/.test(relative) || !LOOKS_LIKE_FILE_OR_DIRECTORY.test(relative)) continue;
      if (NOT_REPOSITORY_PATHS.some((excluded) => relative.startsWith(excluded))) continue;
      checked += 1;
      if (!existsSync(path.join(root, relative)))
        errors.push(`INSTRUCTION_PATH_MISSING ${file} -> ${relative}`);
    }
  }
  return { checked, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checked, errors } = checkInstructionLinks();
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `INSTRUCTION_LINKS ${errors.length === 0 ? "passed" : "failed"} checked=${checked} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
