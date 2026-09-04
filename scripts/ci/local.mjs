import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, outputPath, verifyContext } from "./context.mjs";
import { parseArguments, readJson, repositoryRoot } from "./contracts.mjs";
import { runCheck } from "./run.mjs";

export async function local({
  check,
  output,
  toolsDirectory,
  base,
  context,
  artifact,
  root = repositoryRoot,
}) {
  if (
    !(
      (process.platform === "darwin" && process.arch === "arm64") ||
      (process.platform === "linux" && process.arch === "x64")
    )
  )
    throw new Error("CI_LOCAL_PLATFORM_UNSUPPORTED");
  if (check && !["policy", "static", "test", "build", "coverage", "security"].includes(check))
    throw new Error("CI_LOCAL_CHECK_UNSUPPORTED");
  if (!existsSync(path.join(toolsDirectory, "installation.json")))
    throw new Error("CI_LOCAL_TOOLS_REQUIRED: npm run ci:tools，然后使用 --tools 指定该目录");
  if (process.env.GITHUB_ACTIONS === "true")
    throw new Error("CI_LOCAL_SCOPE_CANNOT_REPLACE_HOSTED_GATE");
  const identity = context ? verifyContext(context, { root }) : createContext({ root, base });
  const directory = outputPath(output, root);
  if (existsSync(directory)) throw new Error("CI_LOCAL_OUTPUT_EXISTS");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "context.json"), `${JSON.stringify(identity, null, 2)}\n`);
  const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
  const results = [];
  const execute = async (checkId, matrixKey = "default", input) => {
    const result = await runCheck({
      root,
      checkId,
      matrixKey,
      context: identity,
      output: path.join(directory, `${checkId}-${matrixKey}`),
      toolsDirectory,
      artifact: input,
      hosted: false,
    });
    results.push(result);
    process.stdout.write(`${checkId}/${matrixKey}: ${result.status}\n`);
    return result;
  };
  let built = artifact;
  const requiresBuild = !check || check === "build" || (check === "test" && !built);
  if (!check || check === "policy") await execute("policy");
  if (!check || check === "static") await execute("static");
  if (requiresBuild) {
    const result = await execute("build", platform);
    if (result.status === "passed")
      built = path.join(directory, `build-${platform}`, result.artifacts[0].path);
  }
  if ((!check || check === "test") && built) await execute("test", platform, built);
  if (!check && built)
    for (const engine of ["chromium", "firefox", "webkit"]) await execute("browser", engine, built);
  if (!check || check === "coverage") await execute("coverage");
  if (!check || check === "security") await execute("security");
  const summary = {
    schemaVersion: 1,
    scope: "local-platform-validation",
    context: identity,
    status:
      results.length > 0 && results.every((result) => result.status === "passed")
        ? "local_passed"
        : "failed",
    platform,
    checks: results.map((result) => ({
      checkId: result.checkId,
      matrixKey: result.matrixKey,
      status: result.status,
      durationMs: result.durationMs,
    })),
    hostedGate: "not_executed",
    enforcement: "not_configured",
    pending: [
      "真实 GitHub Linux/macOS 完整矩阵",
      "Linux Node floor",
      "真实取消、fork 审批与 Ruleset 拒绝合并",
      "S9 生产资格与签署",
    ],
  };
  writeFileSync(
    path.join(directory, "local-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, [
    "--check",
    "--output",
    "--tools",
    "--base",
    "--context",
    "--artifact",
  ]);
  const summary = await local({
    check: args["--check"],
    output: args["--output"] ?? `.ci-output/local-${Date.now()}`,
    toolsDirectory: path.resolve(
      args["--tools"] ?? process.env.HIMAWARI_CI_TOOLS ?? ".ci-output/tools",
    ),
    base: args["--base"],
    context: args["--context"] && readJson(args["--context"]),
    artifact: args["--artifact"] && path.resolve(args["--artifact"]),
  });
  process.stdout.write(`${summary.status}; hosted gate: ${summary.hostedGate}\n`);
  process.exitCode = summary.status === "local_passed" ? 0 : 1;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
