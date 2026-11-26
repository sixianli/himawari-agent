import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { frontmatterOf } from "./check-docs-code-refs.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTION = "docs/execution";
const SPECS = "docs/execution/specs/";
const PLANS = "docs/execution/plans/";
const SKIPPED = ["docs/assets/"];
const OPEN_BACKLOG_STATES = new Set(["open", "in_progress"]);
const TRACKER = /^docs\/(adr|backlog)\/[^/]+\.md$/;

function markdownUnder(root, directory) {
  const start = path.join(root, directory);
  if (!existsSync(start)) return [];
  const found = [];
  const walk = (relative) => {
    for (const name of readdirSync(path.join(root, relative))) {
      const child = `${relative}/${name}`;
      if (statSync(path.join(root, child)).isDirectory()) walk(child);
      else if (name.endsWith(".md")) found.push(child);
    }
  };
  walk(directory);
  return found.sort();
}

function fieldsOf(root, file) {
  return frontmatterOf(readFileSync(path.join(root, file), "utf8")).fields ?? {};
}

function trackerProblem(root, file, tracker) {
  if (!tracker)
    return `SHORT_LIVED_DOC_UNTRACKED ${file} 没有写 implements（它在做的那份 ADR 或待办）`;
  if (!TRACKER.test(tracker))
    return `SHORT_LIVED_DOC_TRACKER_INVALID ${file} -> ${tracker} implements 只能写一份 docs/adr/ 或 docs/backlog/ 下的 .md`;
  if (!existsSync(path.join(root, tracker)))
    return `SHORT_LIVED_DOC_WORK_CLOSED ${file} -> ${tracker} 已不存在：工作结束了，用 git rm 删掉这份文档`;
  const fields = fieldsOf(root, tracker);
  if (tracker.startsWith("docs/adr/") && fields.implementation !== "in_progress")
    return `SHORT_LIVED_DOC_WORK_CLOSED ${file} -> ${tracker} 没有 implementation: in_progress：代码已做完，用 git rm 删掉这份文档，仍有用的结论先并进 ADR 或现行文档`;
  if (tracker.startsWith("docs/backlog/") && !OPEN_BACKLOG_STATES.has(fields.record_state))
    return `SHORT_LIVED_DOC_WORK_CLOSED ${file} -> ${tracker} 待办状态是 ${fields.record_state || "空"}：工作结束了，用 git rm 删掉这份文档`;
  return null;
}

export function checkShortLivedDocs(root = repositoryRoot) {
  const errors = [];
  const files = new Set(markdownUnder(root, EXECUTION));
  for (const file of markdownUnder(root, "docs")) {
    if (SKIPPED.some((prefix) => file.startsWith(prefix))) continue;
    const type = fieldsOf(root, file).document_type;
    if (type === "spec" || type === "plan") files.add(file);
  }
  let specs = 0;
  for (const file of [...files].sort()) {
    const fields = fieldsOf(root, file);
    if (file.startsWith(PLANS) || fields.document_type === "plan") {
      errors.push(
        `SHORT_LIVED_DOC_PLAN ${file} 不再写计划文件：先后约束写进规格的 Delivery Order 小节，然后删掉它`,
      );
      continue;
    }
    if (!file.startsWith(SPECS)) {
      errors.push(
        `SHORT_LIVED_DOC_MISPLACED ${file} 规格只放在 ${SPECS}；长期有效的约定或基线改放现行文档，并去掉 document_type: spec`,
      );
      continue;
    }
    specs += 1;
    const problem = trackerProblem(root, file, fields.implements);
    if (problem) errors.push(problem);
  }
  return { errors, specs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, specs } = checkShortLivedDocs();
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    `SHORT_LIVED_DOCS ${errors.length === 0 ? "passed" : "failed"} specs=${specs} errors=${errors.length}\n`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
