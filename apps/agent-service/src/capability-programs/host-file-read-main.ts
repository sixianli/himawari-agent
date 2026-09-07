import { ConstrainedHostFileSystem } from "@himawari-agent/platform-node";
import { executeHostFileReadCapability } from "./host-file-read.js";

// Run only as a registered program under the existing qualified isolation backend.
// These host identities come from the deployment's fixed argv, never from stdin.
const [hostId, workerInstanceId, ...extra] = process.argv.slice(2);
try {
  if (!hostId || !workerInstanceId || extra.length) throw new Error("HOST_FILE_BINDING_INVALID");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 48 * 1024) throw new Error("HOST_FILE_INPUT_LIMIT");
    chunks.push(bytes);
  }
  const input: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  const result = await executeHostFileReadCapability(input, {
    hostId,
    workerInstanceId,
    platform: new ConstrainedHostFileSystem(),
    clock: { now: () => new Date().toISOString() },
  });
  process.stdout.write(result);
} catch {
  // Errors may contain private paths or file content. The Worker reports process failure.
  process.stderr.write("HOST_FILE_EXECUTION_FAILED\n");
  process.exitCode = 1;
}
