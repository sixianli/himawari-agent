import process from "node:process";
import { scanMachineSecrets } from "@himawari-agent/application";
import { exportPiOutputFile } from "@himawari-agent/platform-node";

export async function writeForegroundPiResult(input: {
  readonly tool: string;
  readonly result: {
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly details?: unknown;
    readonly isError: boolean;
  };
  readonly commandExitCode: number | null;
  readonly verifiedWrite: unknown;
  readonly privateDirectory: string;
  readonly maxOutputBytes: number;
  readonly closing: Readonly<Record<string, unknown>>;
  readonly source: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const details =
    input.result.details && typeof input.result.details === "object"
      ? ({ ...input.result.details } as Record<string, unknown>)
      : {};
  const fullPath = details["fullOutputPath"];
  delete details["fullOutputPath"];
  const fullOutput =
    typeof fullPath === "string"
      ? await exportPiOutputFile(fullPath, input.privateDirectory, input.maxOutputBytes)
      : null;
  const content = input.result.content.map((part) =>
    part.type === "text" && typeof fullPath === "string" && typeof part.text === "string"
      ? { ...part, text: part.text.replaceAll(fullPath, "本次受保护结果的 fullOutput 字段") }
      : part,
  );
  const output = JSON.stringify({
    schemaVersion: "pi-result.v1",
    tool: input.tool,
    content,
    details,
    fullOutput,
    isError: input.result.isError,
    commandExitCode: input.commandExitCode,
    verifiedWrite: input.verifiedWrite,
    ...input.closing,
    source: input.source,
  });
  if (scanMachineSecrets(output).length) throw new Error("PI_RESULT_SECRET_REJECTED");
  if (Buffer.byteLength(output) > input.maxOutputBytes) throw new Error("PI_RESULT_OUTPUT_LIMIT");
  process.stdout.write(output);
  if (input.result.isError)
    process.exitCode =
      input.commandExitCode && input.commandExitCode > 0 && input.commandExitCode < 256
        ? input.commandExitCode
        : 1;
}
