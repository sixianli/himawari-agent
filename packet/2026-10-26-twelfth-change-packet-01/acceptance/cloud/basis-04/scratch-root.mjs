import { lstat, realpath } from "node:fs/promises";

export async function validateScratchRoot(value) {
  if (process.platform !== "linux") throw new Error("LINUX_REQUIRED");
  if (typeof value !== "string" || !/^\/tmp\/h[A-Za-z0-9]{4}$/.test(value))
    throw new Error("SCRATCH_ROOT_NAME_UNSAFE");
  if (Buffer.byteLength(value) !== 10) throw new Error("SCRATCH_ROOT_LENGTH_UNSAFE");
  const metadata = await lstat(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("SCRATCH_ROOT_TYPE_UNSAFE");
  if (metadata.uid !== process.getuid()) throw new Error("SCRATCH_ROOT_OWNER_UNSAFE");
  if ((metadata.mode & 0o7777) !== 0o700) throw new Error("SCRATCH_ROOT_MODE_UNSAFE");
  if ((await realpath(value)) !== value) throw new Error("SCRATCH_ROOT_CANONICAL_UNSAFE");
  if (process.env.TMPDIR !== value || process.env.HIMAWARI_TEST_TEMP_ROOT !== value)
    throw new Error("SCRATCH_ROOT_ENVIRONMENT_MISMATCH");
  return value;
}
