import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIRECTORY = "docs";
const ARCHIVE_DIRECTORY = "docs/archive";
const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXPLICIT_ANCHOR = /<a id="([^"]+)"><\/a>/g;
const HEADING = /^#{1,6}\s+(.+)$/gm;
const FENCE = /^(```|~~~)[\s\S]*?^\1[^\n]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;

function headingSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function withoutCode(text) {
  return text.replace(FENCE, "").replace(INLINE_CODE, "");
}

function anchorsOf(text) {
  const prose = text.replace(FENCE, "");
  const anchors = new Set();
  for (const match of prose.matchAll(EXPLICIT_ANCHOR)) anchors.add(match[1]);
  for (const match of prose.matchAll(HEADING)) anchors.add(headingSlug(match[1]));
  return anchors;
}

export function docsMarkdownFiles(root = repositoryRoot, directory = DOCS_DIRECTORY) {
  const files = [];
  if (!existsSync(path.join(root, directory))) return files;
  for (const entry of readdirSync(path.join(root, directory)).sort()) {
    const relative = `${directory}/${entry}`;
    if (relative === ARCHIVE_DIRECTORY) continue;
    const stat = lstatSync(path.join(root, relative));
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) files.push(...docsMarkdownFiles(root, relative));
    else if (entry.endsWith(".md")) files.push(relative);
  }
  return files;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function checkDocsLinks({ root = repositoryRoot } = {}) {
  const errors = [];
  let checked = 0;
  const anchorCache = new Map();
  const anchorsFor = (absolute) => {
    if (!anchorCache.has(absolute))
      anchorCache.set(absolute, anchorsOf(readFileSync(absolute, "utf8")));
    return anchorCache.get(absolute);
  };
  for (const file of docsMarkdownFiles(root)) {
    const text = withoutCode(readFileSync(path.join(root, file), "utf8"));
    const directory = path.dirname(path.join(root, file));
    for (const [, target] of text.matchAll(MARKDOWN_LINK)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      checked += 1;
      const hash = target.indexOf("#");
      const relative = decode(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? "" : decode(target.slice(hash + 1));
      const destination = relative ? path.resolve(directory, relative) : path.join(root, file);
      if (!existsSync(destination)) {
        errors.push(`DOCS_LINK_MISSING ${file} -> ${target}`);
        continue;
      }
      if (anchor && destination.endsWith(".md") && lstatSync(destination).isFile())
        if (!anchorsFor(destination).has(anchor))
          errors.push(`DOCS_ANCHOR_MISSING ${file} -> ${target}`);
    }
  }
  return { checked, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checked, errors } = checkDocsLinks();
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `DOCS_LINKS ${errors.length === 0 ? "passed" : "failed"} checked=${checked} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
