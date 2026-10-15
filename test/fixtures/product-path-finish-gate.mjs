import fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const gate = process.env.HIMAWARI_TEST_HOST_FINISH_GATE;
if (!gate) throw new Error("PRODUCT_PATH_FINISH_GATE_REQUIRED");
const stage = process.env.HIMAWARI_TEST_HOST_FINISH_STAGE ?? "after-reset";
const require = createRequire(process.argv[1]);
const { SandboxManager } = await import(
  pathToFileURL(require.resolve("@anthropic-ai/sandbox-runtime")).href
);
const originalRename = fs.rename;
const markEntered = async () => {
  const pending = `${gate}.entered.${process.pid}.tmp`;
  await fs.writeFile(
    pending,
    JSON.stringify({ pid: process.pid, at: new Date().toISOString(), stage }),
  );
  await originalRename(pending, `${gate}.entered`);
};
const pause = async () => {
  await markEntered();
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
  if (["after-reset", "armed"].includes(stage)) await pause();
  return result;
};
fs.rename = async (source, target) => {
  if (String(target).endsWith("/final.json") && stage === "before-final") await pause();
  const result = await originalRename(source, target);
  if (String(target).endsWith("/final.json") && stage === "after-final") await pause();
  return result;
};
const postMessage = Worker.prototype.postMessage;
const emit = Worker.prototype.emit;
let resetRequested = false;
let resetExited = false;
Worker.prototype.postMessage = function (message, ...rest) {
  if (message && typeof message === "object" && message.method === "reset") {
    resetRequested = true;
    if (stage === "before-reset") {
      void pause().then(() => postMessage.call(this, message, ...rest));
      return undefined;
    }
  }
  return postMessage.call(this, message, ...rest);
};
Worker.prototype.emit = function (event, ...args) {
  if (
    event === "exit" &&
    resetRequested &&
    !resetExited &&
    ["after-reset", "armed"].includes(stage)
  ) {
    resetExited = true;
    void pause().then(() => emit.call(this, event, ...args));
    return true;
  }
  return emit.call(this, event, ...args);
};
syncBuiltinESMExports();
const send = process.send?.bind(process);
const disconnect = process.disconnect.bind(process);
let held;
process.send = (...args) => {
  const message = args[0];
  if (message?.type === "completed" && stage === "contradict-result") {
    void markEntered();
    return (
      send?.({ ...message, exitCode: message.exitCode === 0 ? 1 : 0 }, ...args.slice(1)) ?? false
    );
  }
  if (message?.type !== "result" || !["before-result", "after-result"].includes(stage))
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
