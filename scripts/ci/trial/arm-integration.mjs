import { performance } from "node:perf_hooks";
import { build } from "../build.mjs";
import { createContext } from "../context.mjs";
import { startHostLoad } from "../host-load.mjs";
import { runTests } from "../test.mjs";

const output = process.argv[2];
const shardIndex = Number(process.argv[3]);
const shardCount = Number(process.argv[4]);
const context = createContext({});
const stopLoad = startHostLoad();
const t0 = performance.now();
const built = await build({ output: `${output}/build`, context });
const t1 = performance.now();
process.stdout.write(
  `TRIAL_BUILD exit=${built.exitCode} seconds=${((t1 - t0) / 1000).toFixed(0)}\n`,
);
const artifact = built.artifact?.path;
const tested = await runTests({
  artifact,
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
