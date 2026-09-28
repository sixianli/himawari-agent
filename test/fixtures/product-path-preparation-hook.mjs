import cp from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const original = cp.fork;
cp.fork = (file, args, options) => {
  const fault = process.env.HIMAWARI_TEST_PREPARATION_FAILURE;
  if (fault && String(file).endsWith("/job-host-main.js") && existsSync(fault)) {
    renameSync(fault, `${fault}.consumed`);
    return original(file, args, {
      ...options,
      execArgv: [
        "--import",
        fileURLToPath(new URL("./product-path-sdk-failure.mjs", import.meta.url)),
      ],
    });
  }
  return original(file, args, options);
};
syncBuiltinESMExports();
