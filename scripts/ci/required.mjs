import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aggregate, readReportEnvelopes } from "./aggregate.mjs";
import { resolvePolicySource } from "./check-policy.mjs";
import { createContext, outputPath } from "./context.mjs";
import { parseArguments, readJson, repositoryRoot } from "./contracts.mjs";
import { encodeGate } from "./gate-log.mjs";
import { redactText } from "./redact-text.mjs";

export function required({
  reports,
  output,
  base,
  needs,
  env = process.env,
  root = repositoryRoot,
}) {
  const directory = outputPath(output, root);
  if (existsSync(directory)) throw new Error("CI_GATE_OUTPUT_EXISTS");
  const context = createContext({ root, base: base || undefined, env });
  const source = resolvePolicySource({ root, base: context.baseSha });
  const summary = aggregate({
    policy: source.policy,
    context,
    needs,
    reports: existsSync(reports) ? readReportEnvelopes(reports) : [],
    toolchainLock: readJson(path.join(root, "ci/toolchain-lock.json")),
  });
  mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries({ context, needs, summary })) {
    writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
  }
  return { context, summary };
}

const cell = (value) => redactText(String(value)).replace(/[\p{Cc}|`]/gu, " ");

export const publicGate = (gate) =>
  JSON.parse(
    JSON.stringify(gate, (_key, value) => (typeof value === "string" ? redactText(value) : value)),
  );

export function gateSummaryMarkdown(summary) {
  const rows = summary.checks.map(
    (check) =>
      `| ${cell(check.checkId)}/${cell(check.matrixKey)} | ${cell(check.status)} | ${cell(check.reasons.join("；") || "-")} |`,
  );
  return [
    `### ci/required：${summary.status === "passed" ? "通过" : "失败"}`,
    "",
    `收到 ${summary.observed.length}/${summary.expected.length} 份报告${summary.missing.length ? `，缺少：${summary.missing.map(cell).join("、")}` : ""}。`,
    "",
    "| 检查 | 结果 | 原因 |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export function main(
  argv = process.argv.slice(2),
  { env = process.env, write = (text) => process.stdout.write(text) } = {},
) {
  const args = parseArguments(argv, ["--reports", "--output", "--base"]);
  if (!args["--reports"] || !args["--output"] || !env.CI_NEEDS)
    throw new Error("CI_GATE_INPUT_REQUIRED");
  const { context, summary } = required({
    reports: args["--reports"],
    output: args["--output"],
    base: args["--base"],
    needs: JSON.parse(env.CI_NEEDS),
    env,
  });
  write(encodeGate(publicGate({ context, summary })));
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, gateSummaryMarkdown(summary));
  write(`${summary.status}: ${summary.observed.length}/${summary.expected.length} reports\n`);
  process.exitCode = summary.status === "passed" ? 0 : 1;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
