import process from "node:process";
import { PI_RESIDENT_RUNNER_FLAG } from "@himawari-agent/execution-contracts";
import { PI_RUNNER_INPUT_LIMIT_BYTES, runPiCodingRequest } from "./pi-coding-request.js";
import { serveResidentPiRunner } from "./pi-resident-runner.js";

// Installed program only. Worker launches it under SRT with fixed host identities.
// Import Pi only after its process-local offline and private-directory settings.
const [hostId, workerInstanceId, ...extra] = process.argv.slice(2);
const residentRuntimeRoot =
  extra.length === 2 && extra[0] === PI_RESIDENT_RUNNER_FLAG && extra[1]?.startsWith("/")
    ? extra[1]
    : undefined;
try {
  if (!hostId || !workerInstanceId || (extra.length && !residentRuntimeRoot))
    throw new Error("PI_RUNNER_IDENTITY_INVALID");
  if (residentRuntimeRoot)
    await serveResidentPiRunner({ hostId, workerInstanceId, runtimeRoot: residentRuntimeRoot });
  else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > PI_RUNNER_INPUT_LIMIT_BYTES) throw new Error("PI_RUNNER_INPUT_LIMIT");
      chunks.push(bytes);
    }
    const exitCode = await runPiCodingRequest(
      Buffer.concat(chunks),
      { hostId, workerInstanceId },
      (bytes) => process.stdout.write(bytes),
    );
    if (exitCode !== 0) process.exitCode = exitCode;
  }
} catch {
  process.stderr.write("PI_RUNNER_EXECUTION_FAILED\n");
  process.exitCode = 1;
}
