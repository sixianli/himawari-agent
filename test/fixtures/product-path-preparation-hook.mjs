import cp from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const original = cp.fork;
cp.fork = (file, args, options) => {
  const ackLoss = process.env.HIMAWARI_TEST_PREPARATION_ACK_LOSS;
  if (ackLoss && String(file).endsWith("/job-host-main.js") && existsSync(`${ackLoss}.consumed`))
    appendFileSync(
      `${ackLoss}.hosts.jsonl`,
      `${JSON.stringify({ at: new Date().toISOString() })}\n`,
    );
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

if (isMainThread && process.argv[1].endsWith("/execution-worker/dist/main.js")) {
  const { ProductionPayloadBrokerClient } = await import(
    pathToFileURL(path.join(path.dirname(process.argv[1]), "production-payload-broker-client.js"))
      .href
  );
  const sandboxExecution = ProductionPayloadBrokerClient.prototype.sandboxExecution;
  ProductionPayloadBrokerClient.prototype.sandboxExecution = async function (...args) {
    const command = args[2];
    const ackLoss = process.env.HIMAWARI_TEST_PREPARATION_ACK_LOSS;
    if (ackLoss && command.kind === "register_preparation_control" && existsSync(ackLoss)) {
      renameSync(ackLoss, `${ackLoss}.consumed`);
      await sandboxExecution.apply(this, args);
      writeFileSync(
        `${ackLoss}.entered`,
        JSON.stringify({
          pid: process.pid,
          at: new Date().toISOString(),
          jobId: args[1].jobId,
          attemptId: args[1].attemptId,
          sessionId: command.control.sessionId,
          directory: command.control.directory,
          acceptedBeforeAckLoss: true,
        }),
      );
      throw new Error("PAYLOAD_CHANNEL_DISCONNECTED");
    }
    const gate = process.env.HIMAWARI_TEST_HOST_FINISH_GATE;
    if (
      !gate ||
      command.kind !== "append_output" ||
      command.resourceRef !== null ||
      !command.chunk.end ||
      !existsSync(`${gate}.consumed`)
    )
      return sandboxExecution.apply(this, args);
    const stage = readFileSync(`${gate}.consumed`, "utf8");
    if (!["before-end", "after-end"].includes(stage)) return sandboxExecution.apply(this, args);
    const pause = async () => {
      appendFileSync(
        `${gate}.entered`,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), stage }),
      );
      while (!existsSync(`${gate}.released`)) await setTimeout(10);
    };
    if (stage === "before-end") await pause();
    const result = await sandboxExecution.apply(this, args);
    if (stage === "after-end") await pause();
    return result;
  };
}
