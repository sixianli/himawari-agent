import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIRECTORY = "docs";
const ARCHIVE_DIRECTORY = "docs/archive";
const INLINE_LINK =
  /\]\(\s*(<[^>\n]*>|(?:\\.|[^()\s\\]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DEFINITION = /^[ \t>]*\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm;
const EXPLICIT_ANCHOR = /<a id="([^"]+)"><\/a>/g;
const HEADING = /^#{1,6}[ \t]+(.+)$/gm;
const FENCE_OPEN = /^[ \t>]*(`{3,}|~{3,})/;
const INLINE_CODE = /`[^`\n]*`/g;
const HEADING_LINK = /\[([^\]]*)\]\([^)]*\)/g;

function headingSlug(text) {
  return text
    .replace(HEADING_LINK, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function stripFences(text) {
  const kept = [];
  let open = null;
  for (const line of text.split("\n")) {
    if (open) {
      const close = new RegExp(`^[ \\t>]*${open[0]}{${open.length},}[ \\t]*$`);
      if (close.test(line)) open = null;
      kept.push("");
      continue;
    }
    const match = FENCE_OPEN.exec(line);
    if (match && !(match[1][0] === "`" && line.slice(match[0].length).includes("`"))) {
      open = match[1];
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function withoutCode(text) {
  return stripFences(text).replace(INLINE_CODE, "");
}

function anchorsOf(text) {
  const prose = stripFences(text);
  const anchors = new Set();
  for (const match of prose.matchAll(EXPLICIT_ANCHOR)) anchors.add(match[1]);
  const seen = new Map();
  for (const match of prose.matchAll(HEADING)) {
    const slug = headingSlug(match[1]);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function linkTargets(text) {
  const targets = [];
  for (const [, raw] of text.matchAll(INLINE_LINK)) targets.push(raw);
  for (const [, raw] of text.matchAll(REFERENCE_DEFINITION)) targets.push(raw);
  return targets.map((raw) => {
    const inner = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    return inner.replace(/\\(.)/g, "$1");
  });
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
    for (const target of linkTargets(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      checked += 1;
      const hash = target.indexOf("#");
      const relative = decode(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? "" : decode(target.slice(hash + 1));
      let destination = path.join(root, file);
      if (relative)
        destination = relative.startsWith("/")
          ? path.join(root, relative)
          : path.resolve(directory, relative);
      const inside = path.relative(root, destination);
      if (inside.startsWith("..") || path.isAbsolute(inside) || !existsSync(destination)) {
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
