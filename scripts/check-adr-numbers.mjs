import { existsSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADR_DIRECTORY = "docs/adr";
const ADR_FILE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;

export function findAdrNumberProblems(names) {
  const byNumber = new Map();
  const errors = [];
  for (const name of [...names].sort()) {
    if (!name.endsWith(".md")) continue;
    const match = ADR_FILE.exec(name);
    if (!match) {
      errors.push(`ADR_NUMBER_NAME ${ADR_DIRECTORY}/${name} 文件名不是“四位编号-小写短名.md”`);
      continue;
    }
    const number = match[1];
    byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  for (const [number, files] of byNumber)
    if (files.length > 1)
      errors.push(
        `ADR_NUMBER_DUPLICATE ${number} 被 ${files.length} 份 ADR 同时使用：${files.map((file) => `${ADR_DIRECTORY}/${file}`).join("、")}`,
      );
  return { errors, adrs: byNumber.size };
}

const DOCS_DIRECTORY = "docs";
const ARCHIVE_DIRECTORY = "docs/archive";
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;
const EXPLICIT_ANCHOR = /<a id="([^"]+)"><\/a>/g;
const HEADING = /^#{1,6}\s+(.+)$/gm;
const TITLE = /^#\s+(.+)$/m;
const TITLE_NUMBER = /^ADR\s+(\d{4})(?!\d)/;

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

function markdownFiles(directory, root) {
  const files = [];
  for (const entry of readdirSync(path.join(root, directory)).sort()) {
    const relative = `${directory}/${entry}`;
    if (relative === ARCHIVE_DIRECTORY) continue;
    if (lstatSync(path.join(root, relative)).isDirectory())
      files.push(...markdownFiles(relative, root));
    else if (entry.endsWith(".md") && !lstatSync(path.join(root, relative)).isSymbolicLink())
      files.push(relative);
  }
  return files;
}

export function findAdrTitleProblems(files) {
  const errors = [];
  for (const [name, text] of files) {
    const match = ADR_FILE.exec(name);
    if (!match) continue;
    const title = TITLE.exec(text)?.[1] ?? "";
    const titleNumber = TITLE_NUMBER.exec(title)?.[1];
    if (titleNumber !== match[1])
      errors.push(
        `ADR_NUMBER_TITLE ${ADR_DIRECTORY}/${name} 标题写的编号是 ${titleNumber ?? "（没有）"}，文件名编号是 ${match[1]}`,
      );
  }
  return errors;
}

export function findAdrLinkProblems(root) {
  const errors = [];
  if (!existsSync(path.join(root, DOCS_DIRECTORY))) return errors;
  for (const file of markdownFiles(DOCS_DIRECTORY, root)) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const [, target] of text.matchAll(MARKDOWN_LINK)) {
      const [relative, anchor] = target.split("#");
      if (!relative || /^[a-z][a-z0-9+.-]*:/i.test(relative)) continue;
      const destination = path.resolve(path.dirname(path.join(root, file)), relative);
      if (
        path.basename(path.dirname(destination)) !== "adr" ||
        !ADR_FILE.test(path.basename(destination))
      )
        continue;
      if (!existsSync(destination)) {
        errors.push(`ADR_LINK_MISSING ${file} -> ${target}`);
        continue;
      }
      if (anchor && !anchorsOf(readFileSync(destination, "utf8")).has(anchor))
        errors.push(`ADR_LINK_ANCHOR_MISSING ${file} -> ${target}`);
    }
  }
  return errors;
}

export function checkAdrNumbers({ root = repositoryRoot } = {}) {
  const directory = path.join(root, ADR_DIRECTORY);
  if (!existsSync(directory))
    return { errors: [`ADR_NUMBER_NO_DIRECTORY ${ADR_DIRECTORY} 不存在`], adrs: 0 };
  const result = findAdrNumberProblems(readdirSync(directory));
  if (result.adrs === 0)
    return {
      errors: [...result.errors, `ADR_NUMBER_NO_FILES ${ADR_DIRECTORY} 下没有 ADR`],
      adrs: 0,
    };
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const titles = names.map((name) => [name, readFileSync(path.join(directory, name), "utf8")]);
  return {
    errors: [...result.errors, ...findAdrTitleProblems(titles), ...findAdrLinkProblems(root)],
    adrs: result.adrs,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = process.argv.slice(2);
  const usage = options.length === 0 || (options.length === 2 && options[0] === "--root");
  if (!usage || (options.length === 2 && (!options[1] || options[1].startsWith("--")))) {
    process.stderr.write("ADR_NUMBER_ROOT_MISSING 只接受“--root <仓库目录>”或不带参数\n");
    process.exit(2);
  }
  const rootValue = options.length === 2 ? options[1] : undefined;
  const { errors, adrs } = checkAdrNumbers(
    rootValue === undefined ? {} : { root: path.resolve(rootValue) },
  );
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `ADR_NUMBERS ${errors.length === 0 ? "passed" : "failed"} adrs=${adrs} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
