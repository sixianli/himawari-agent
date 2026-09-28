import cp from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync } from "node:fs";
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
  const gate = process.env.HIMAWARI_TEST_HOST_FINISH_GATE;
  if (gate && String(file).endsWith("/job-host-main.js") && existsSync(gate)) {
    const stage = readFileSync(gate, "utf8");
    renameSync(gate, `${gate}.consumed`);
    const child = original(file, args, {
      ...options,
      execArgv: [
        ...(options.execArgv ?? []),
        "--import",
        fileURLToPath(new URL("./product-path-finish-gate.mjs", import.meta.url)),
      ],
      env: {
        ...options.env,
        HIMAWARI_TEST_HOST_FINISH_GATE: gate,
        HIMAWARI_TEST_HOST_FINISH_STAGE: stage,
      },
    });
    child.on("message", (message) => {
      if (message.type === "result")
        appendFileSync(`${gate}.result-received`, `${new Date().toISOString()}\n`);
      if (message.type === "output")
        appendFileSync(
          `${gate}.output.jsonl`,
          `${JSON.stringify({ at: new Date().toISOString(), bytes: message.bytes })}\n`,
        );
    });
    return child;
  }
  return original(file, args, options);
};
syncBuiltinESMExports();
