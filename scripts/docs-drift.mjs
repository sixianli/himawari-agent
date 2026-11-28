import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const COMMENT_MARKER = "<!-- docs-drift -->";
const SHOWN_FILES = 5;

function frontmatterFields(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z_]\w*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return fields;
}

function markdownFiles(root, directory) {
  const files = [];
  if (!existsSync(path.join(root, directory))) return files;
  for (const entry of readdirSync(path.join(root, directory)).sort()) {
    const relative = `${directory}/${entry}`;
    const stat = lstatSync(path.join(root, relative));
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) files.push(...markdownFiles(root, relative));
    else if (entry.endsWith(".md")) files.push(relative);
  }
  return files;
}

export function coveredDocuments(root = repositoryRoot) {
  const documents = [];
  for (const file of markdownFiles(root, "docs")) {
    const fields = frontmatterFields(readFileSync(path.join(root, file), "utf8"));
    const covers = (fields?.covers ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/\/$/, ""))
      .filter(Boolean);
    if (covers.length) documents.push({ file, covers, verifiedAt: fields.verified_at ?? "" });
  }
  return documents;
}

export function globPattern(glob) {
  let pattern = "";
  for (let position = 0; position < glob.length; position += 1) {
    const character = glob[position];
    if (character === "*" && glob[position + 1] === "*") {
      pattern += ".*";
      position += 1;
    } else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

export function touches(covers, changedFile) {
  return covers.some((covered) =>
    /[*?]/.test(covered)
      ? globPattern(covered).test(changedFile)
      : changedFile === covered || changedFile.startsWith(`${covered}/`),
  );
}

export function driftAgainstChanges(documents, changedFiles) {
  const changed = new Set(changedFiles);
  return documents
    .filter((document) => !changed.has(document.file))
    .map((document) => ({
      file: document.file,
      code: changedFiles.filter((changedFile) => touches(document.covers, changedFile)),
    }))
    .filter((entry) => entry.code.length);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
}

function lines(text) {
  return text.split("\n").filter(Boolean);
}

export function driftInPullRequest(root, base) {
  return driftAgainstChanges(
    coveredDocuments(root),
    lines(git(root, ["diff", "--name-only", `${base}...HEAD`])),
  );
}

export function driftSinceVerified(root) {
  const drift = [];
  for (const document of coveredDocuments(root)) {
    if (!document.verifiedAt) continue;
    let changed;
    try {
      changed = lines(
        git(root, ["diff", "--name-only", document.verifiedAt, "HEAD", "--", ...document.covers]),
      );
    } catch {
      drift.push({ file: document.file, code: [], unknownCommit: document.verifiedAt });
      continue;
    }
    if (changed.length) drift.push({ file: document.file, code: changed });
  }
  return drift;
}

export function renderMarkdown(drift, heading) {
  if (!drift.length) return "";
  const rows = drift.map((entry) => {
    if (entry.unknownCommit)
      return `- \`${entry.file}\`：找不到它写的 verified_at 提交 \`${entry.unknownCommit}\``;
    const shown = entry.code.slice(0, SHOWN_FILES).map((file) => `\`${file}\``);
    const more = entry.code.length > SHOWN_FILES ? ` 等 ${entry.code.length} 个文件` : "";
    return `- \`${entry.file}\`：${shown.join("、")}${more}`;
  });
  return [COMMENT_MARKER, `### ${heading}`, "", ...rows, ""].join("\n");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = argument("--base");
  const drift = base
    ? driftInPullRequest(repositoryRoot, base)
    : driftSinceVerified(repositoryRoot);
  const heading = base
    ? "这个 PR 改了下面这些文档覆盖的代码，文档没有跟着改（只是提醒，不拦合并）"
    : "下面这些文档覆盖的代码在它们写的 verified_at 之后改过，要对着代码核一遍，核完把 verified_at 改成这个分支最近一次合进来的 main 提交";
  process.stdout.write(renderMarkdown(drift, heading));
  if (!base) process.stderr.write(`DOCS_DRIFT documents=${drift.length}\n`);
}
