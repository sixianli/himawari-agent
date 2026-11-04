import { existsSync, readdirSync } from "node:fs";
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
  return result;
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
