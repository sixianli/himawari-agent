import { parentPort, workerData } from "node:worker_threads";
import { computePiFileMutation, type PiFilePreparationInput } from "./prepare-file-mutation.ts";

if (parentPort) {
  try {
    parentPort.postMessage({ kind: "started" });
    parentPort.postMessage({
      ok: true,
      value: await computePiFileMutation(workerData as PiFilePreparationInput),
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "PI_PREPARATION_FAILED",
    });
  }
}
