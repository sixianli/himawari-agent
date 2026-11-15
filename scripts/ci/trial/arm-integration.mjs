import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { build } from "../build.mjs";
import { createContext } from "../context.mjs";
import { repositoryRoot } from "../contracts.mjs";
import { startHostLoad } from "../host-load.mjs";
import { isolatedEnvironment, verifyInstalledTools } from "../install-tools.mjs";
import { runTests } from "../test.mjs";
import { cacheEnvironment } from "../verified-download.mjs";

const output = path.resolve(process.argv[2]);
const toolsDirectory = path.resolve(process.argv[3]);
const shardIndex = Number(process.argv[4]);
const shardCount = Number(process.argv[5]);
const context = createContext({});
const installation = await verifyInstalledTools({
  directory: toolsDirectory,
  root: repositoryRoot,
});
const tools = installation.executables;
const temporaryDirectory = mkdtempSync(`${testTemporaryRoot()}/hci-`);
process.env = {
  ...isolatedEnvironment(path.join(output, "environment"), path.join(toolsDirectory, "bin"), {
    temporaryDirectory,
  }),
  ...Object.fromEntries(
    [
      "HIMAWARI_TEST_TEMP_ROOT",
      "GITHUB_ACTIONS",
      "GITHUB_EVENT_NAME",
      "GITHUB_EVENT_PATH",
      "GITHUB_SHA",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  ),
  ...cacheEnvironment(process.env),
  HIMAWARI_CI_PYTHON: tools.python,
  HIMAWARI_CI_NPM: tools.npmCli,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
};
const stopLoad = startHostLoad();
const t0 = performance.now();
const built = await build({ output: `${output}/build`, context });
const t1 = performance.now();
process.stdout.write(
  `TRIAL_BUILD exit=${built.exitCode} seconds=${((t1 - t0) / 1000).toFixed(0)}\n`,
);
const focus = process.argv[6];
if (focus) {
  const contextPath = path.join(output, "focus-context.json");
  writeFileSync(contextPath, `${JSON.stringify(context)}\n`);
  const focused = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.workspace.ts",
      "--project",
      "integration",
      "--reporter",
      "verbose",
      ...focus.split(","),
    ],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_PATH: "",
        NODE_OPTIONS: "",
        HIMAWARI_TEST_ARTIFACT: built.artifact.path,
        HIMAWARI_TEST_CONTEXT: contextPath,
      },
    },
  );
  process.stdout.write(`TRIAL_FOCUS exit=${focused.status}\n`);
  process.stdout.write(`${stopLoad()}\n`);
  process.exit(focused.status ?? 1);
}
const tested = await runTests({
  artifact: built.artifact.path,
  output: `${output}/tests`,
  context,
  projects: ["integration"],
  shard: { index: shardIndex, count: shardCount },
});
const t2 = performance.now();
process.stdout.write(
  `TRIAL_TESTS exit=${tested.exitCode} counts=${JSON.stringify(tested.counts)} seconds=${((t2 - t1) / 1000).toFixed(0)}\n`,
);
process.stdout.write(`${stopLoad()}\n`);
process.exitCode = tested.exitCode;
