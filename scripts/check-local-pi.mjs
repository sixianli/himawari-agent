import { inspectLocalPi } from "./local-pi-state.mjs";

const rootIndex = process.argv.indexOf("--root");
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();

try {
  const result = await inspectLocalPi(root);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "LOCAL_PI_CHECK_FAILED");
  process.exitCode = 1;
}
