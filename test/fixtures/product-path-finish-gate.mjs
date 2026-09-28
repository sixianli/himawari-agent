import fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const gate = process.env.HIMAWARI_TEST_HOST_FINISH_GATE;
if (!gate) throw new Error("PRODUCT_PATH_FINISH_GATE_REQUIRED");
const stage = process.env.HIMAWARI_TEST_HOST_FINISH_STAGE ?? "after-reset";
const require = createRequire(process.argv[1]);
const { SandboxManager } = await import(
  pathToFileURL(require.resolve("@anthropic-ai/sandbox-runtime")).href
);
const pause = async () => {
  await fs.writeFile(
    `${gate}.entered`,
    JSON.stringify({ pid: process.pid, at: new Date().toISOString(), stage }),
  );
  for (;;) {
    const released = await fs.readFile(`${gate}.released`, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (released !== null) return;
    await setTimeout(10);
  }
};
const reset = SandboxManager.reset;
SandboxManager.reset = async (...args) => {
  if (stage === "before-reset") await pause();
  const result = await reset(...args);
  if (stage === "after-reset" || stage === "armed") await pause();
  return result;
};
const rename = fs.rename;
fs.rename = async (source, target) => {
  if (String(target).endsWith("/final.json") && stage === "before-final") await pause();
  const result = await rename(source, target);
  if (String(target).endsWith("/final.json") && stage === "after-final") await pause();
  return result;
};
syncBuiltinESMExports();
const send = process.send?.bind(process);
const disconnect = process.disconnect.bind(process);
let held;
process.send = (...args) => {
  if (args[0]?.type !== "result" || !["before-result", "after-result"].includes(stage))
    return send?.(...args) ?? false;
  if (stage === "before-result") held = pause().then(() => send?.(...args));
  else {
    send?.(...args);
    held = pause();
  }
  return true;
};
process.disconnect = () => {
  if (held)
    void held.then(() => {
      if (process.connected) disconnect();
    });
  else disconnect();
};
