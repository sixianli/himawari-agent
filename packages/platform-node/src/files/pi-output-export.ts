import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { scanMachineSecrets } from "@himawari-agent/application";

/** Read an untrusted Pi output locator only in the owned private directory.
 * Bytes, never a host path, cross the existing protected Payload channel. */
export async function exportPiOutputFile(
  filename: string,
  privateDirectory: string,
  maximumBytes: number,
) {
  if (
    path.dirname(filename) !== privateDirectory ||
    !/^pi-bash-[a-f0-9]+\.log$/.test(path.basename(filename)) ||
    (await realpath(privateDirectory)) !== privateDirectory
  )
    throw new Error("PI_OUTPUT_OWNER_MISMATCH");
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.size > maximumBytes
    )
      throw new Error("PI_OUTPUT_FILE_REJECTED");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("PI_OUTPUT_FILE_CHANGED");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.nlink !== 1)
      throw new Error("PI_OUTPUT_FILE_CHANGED");
    if (scanMachineSecrets(bytes.toString("utf8")).length)
      throw new Error("PI_OUTPUT_SECRET_REJECTED");
    return {
      encoding: "base64",
      data: bytes.toString("base64"),
      byteLength: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex"),
    } as const;
  } finally {
    await handle.close();
  }
}
