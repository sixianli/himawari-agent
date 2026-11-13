import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIMIT_DIRECTIVE =
  /\b(?:MemoryMax|MemoryHigh|MemoryMin|MemoryLow|MemorySwapMax|CPUQuota|CPUWeight|TasksMax|LimitNOFILE|IOWeight)\s*=\s*(?:[0-9]|infinity)/g;
export const SCANNED = ["scripts/operations/multi-user-exec"];

export function hardcodedLimits(text) {
  return [...text.matchAll(LIMIT_DIRECTIVE)]
    .map((match) => match[0])
    .filter((found) => !/^MemorySwapMax\s*=\s*0$/.test(found));
}

export function scan(repository) {
  const problems = [];
  for (const directory of SCANNED)
    for (const name of readdirSync(path.join(repository, directory)).sort()) {
      const file = path.join(directory, name);
      for (const found of hardcodedLimits(readFileSync(path.join(repository, file), "utf8")))
        problems.push(`MULTI_USER_EXEC_LIMIT_HARDCODED ${file} ${found}`);
    }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const problems = scan(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (problems.length > 0) process.exitCode = 1;
  else process.stdout.write("MULTI_USER_EXEC_CHECK_OK\n");
}
