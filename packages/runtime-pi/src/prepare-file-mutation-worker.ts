import { parentPort } from "node:worker_threads";
import { computePiFileMutation, type PiFilePreparationInput } from "./prepare-file-mutation.ts";

if (parentPort) {
  const port = parentPort;
  let accepted = false;
  port.on("message", async (message: unknown) => {
    if (accepted) {
      port.postMessage({ ok: false, error: "PI_PREPARATION_INPUT_ALREADY_ACCEPTED" });
      return;
    }
    accepted = true;
    try {
      if (
        !message ||
        typeof message !== "object" ||
        !("kind" in message) ||
        message.kind !== "input" ||
        !("input" in message)
      )
        throw new Error("PI_PREPARATION_INPUT_INVALID");
      port.postMessage({ kind: "started" });
      port.postMessage({
        ok: true,
        value: await computePiFileMutation(message.input as PiFilePreparationInput),
      });
    } catch (error) {
      port.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : "PI_PREPARATION_FAILED",
      });
    }
  });
  port.postMessage({ kind: "ready" });
}
