import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE_MODE_ENTRIES = [
  "packages/runtime-sandbox/src/job-host-main.ts",
  "packages/runtime-sandbox/src/egress-proxy-main.ts",
];

const SPECIFIER =
  /^[ \t]*(import|export)(\s+type)?\b[^;]*?\bfrom\s+"(\.{1,2}\/[^"]+)"|^[ \t]*import\s+"(\.{1,2}\/[^"]+)"/gms;

export function checkSourceModeImports({
  root = repositoryRoot,
  entries = SOURCE_MODE_ENTRIES,
} = {}) {
  const problems = [];
  const seen = new Set();
  const queue = entries.map((entry) => path.join(root, entry));
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) {
      problems.push({ file: path.relative(root, file), specifier: null, reason: "missing" });
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      if (match[2]) continue;
      const specifier = match[3] ?? match[4];
      const target = path.resolve(path.dirname(file), specifier);
      if (!existsSync(target)) {
        problems.push({
          file: path.relative(root, file),
          specifier,
          reason: "not-found-in-source-mode",
        });
        continue;
      }
      if (target.endsWith(".ts")) queue.push(target);
    }
  }
  return { checked: seen.size, problems, passed: problems.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkSourceModeImports();
  for (const problem of result.problems)
    process.stderr.write(
      `SOURCE_MODE_IMPORT_UNRESOLVED ${problem.file} 导入 ${problem.specifier}：Node 直接运行 .ts 源码时不会把 .js 改成 .ts，子进程会报 ERR_MODULE_NOT_FOUND。把导入写成真实存在的 .ts 路径（事故 I-57）。\n`,
    );
  process.stdout.write(
    `SOURCE_MODE_IMPORTS ${result.passed ? "passed" : "failed"} files=${result.checked} problems=${result.problems.length}\n`,
  );
  process.exitCode = result.passed ? 0 : 1;
}
