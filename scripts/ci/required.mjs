import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aggregate, readReportEnvelopes } from "./aggregate.mjs";
import { resolvePolicySource } from "./check-policy.mjs";
import { createContext, outputPath } from "./context.mjs";
import { parseArguments, readJson, repositoryRoot } from "./contracts.mjs";

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
  return summary;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, ["--reports", "--output", "--base"]);
  if (!args["--reports"] || !args["--output"] || !process.env.CI_NEEDS)
    throw new Error("CI_GATE_INPUT_REQUIRED");
  const summary = required({
    reports: args["--reports"],
    output: args["--output"],
    base: args["--base"],
    needs: JSON.parse(process.env.CI_NEEDS),
  });
  process.stdout.write(
    `${summary.status}: ${summary.observed.length}/${summary.expected.length} reports\n`,
  );
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
