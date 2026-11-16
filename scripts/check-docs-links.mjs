import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Lexer } from "marked";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIRECTORY = "docs";
const ARCHIVE_DIRECTORY = "docs/archive";
const EXPLICIT_ANCHOR = /<a id="([^"]+)">/g;
const DELETED_VERSION_SECTION_LABEL = /「([^」]+)」（已删除，链接指向删除前的版本）$/;
const GOVERNED_DOCUMENT_PATH = /^docs\/(?:backlog|execution|runbooks)\/[^\s*<>…]+\.md$/;

function plainText(tokens) {
  return tokens
    .map((token) => {
      if (token.type === "html") return "";
      if (token.tokens) return plainText(token.tokens);
      return token.text ?? token.raw;
    })
    .join("");
}

function headingSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function walkTokens(tokens, visit) {
  for (const token of tokens) {
    visit(token);
    if (token.tokens) walkTokens(token.tokens, visit);
    if (token.items) walkTokens(token.items, visit);
    if (token.type === "table")
      for (const cell of [...token.header, ...token.rows.flat()]) walkTokens(cell.tokens, visit);
  }
}

function lex(text) {
  return new Lexer().lex(text);
}

export function anchorsOf(text) {
  const anchors = new Set();
  const used = new Map();
  walkTokens(lex(text), (token) => {
    if (token.type === "html")
      for (const match of token.raw.matchAll(EXPLICIT_ANCHOR)) anchors.add(match[1]);
    if (token.type !== "heading") return;
    const base = headingSlug(plainText(token.tokens));
    let slug = base;
    while (used.has(slug)) {
      used.set(base, used.get(base) + 1);
      slug = `${base}-${used.get(base)}`;
    }
    used.set(slug, 0);
    anchors.add(slug);
  });
  return anchors;
}

function linkTargets(text) {
  const targets = new Set();
  walkTokens(lex(text), (token) => {
    if ((token.type === "link" || token.type === "image") && !/^!?\[\^[^\]]*\]$/.test(token.raw))
      targets.add(token.href);
    if (token.type === "def" && !token.tag.startsWith("^")) targets.add(token.href);
  });
  return targets;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function deletedVersionLinksWithoutSection(text) {
  const targets = new Set();
  walkTokens(lex(text), (token) => {
    if (token.type !== "link") return;
    const section = DELETED_VERSION_SECTION_LABEL.exec(token.text)?.[1];
    if (section && !decode(token.href).endsWith(`#${section}`)) targets.add(token.href);
  });
  return targets;
}

function governedPathsInCode(text) {
  const paths = new Set();
  walkTokens(lex(text), (token) => {
    if (token.type === "codespan" && GOVERNED_DOCUMENT_PATH.test(token.text)) paths.add(token.text);
  });
  return paths;
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
    const text = readFileSync(path.join(root, file), "utf8");
    const directory = path.dirname(path.join(root, file));
    for (const target of deletedVersionLinksWithoutSection(text))
      errors.push(`DOCS_DELETED_LINK_SECTION_MISSING ${file} -> ${target}`);
    for (const mentioned of governedPathsInCode(text))
      if (!existsSync(path.join(root, mentioned)))
        errors.push(`DOCS_PATH_MISSING ${file} -> ${mentioned}`);
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
      if (
        inside === ".." ||
        inside.startsWith(`..${path.sep}`) ||
        path.isAbsolute(inside) ||
        !existsSync(destination)
      ) {
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
