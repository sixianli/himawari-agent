import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "vitest";
import { startExecutionUdsChild } from "../integration/fixtures/execution-uds-child.js";

describe("Execution UDS child process fixture", () => {
  it("serves until the parent writes the stop marker", async () => {
    const { HIMAWARI_EXECUTION_TEST_STOP: stopPath } = process.env;
    if (!stopPath) throw new Error("Missing HIMAWARI_EXECUTION_TEST_STOP");
    const server = await startExecutionUdsChild();
    process.stdout.write(`${JSON.stringify({ ready: true, socketPath: server.socketPath })}\n`);
    while (true) {
      try {
        await access(stopPath);
        break;
      } catch {
        await delay(20);
      }
    }
    await server.stop();
  }, 30_000);
});
