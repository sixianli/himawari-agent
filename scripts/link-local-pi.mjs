import { linkLocalPi } from "./local-pi-state.mjs";

const rootIndex = process.argv.indexOf("--root");
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();

try {
  console.log(JSON.stringify(await linkLocalPi(root), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "LOCAL_PI_LINK_FAILED");
  process.exitCode = 1;
}
