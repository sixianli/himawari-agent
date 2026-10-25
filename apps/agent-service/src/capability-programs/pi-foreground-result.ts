import process from "node:process";
import { formatForegroundPiResult } from "@himawari-agent/platform-node";

export async function writeForegroundPiResult(
  input: Parameters<typeof formatForegroundPiResult>[0],
): Promise<void> {
  const { output, exitCode } = await formatForegroundPiResult(input);
  process.stdout.write(output);
  if (exitCode !== 0) process.exitCode = exitCode;
}
