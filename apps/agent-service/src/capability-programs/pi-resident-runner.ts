import process from "node:process";
import {
  PI_RESIDENT_FRAME_LIMIT_BYTES,
  PI_RESIDENT_OUTPUT_CHUNK_BYTES,
} from "@himawari-agent/execution-contracts";
import {
  applyPiRunnerEnvironment,
  type PiRunnerIdentity,
  runPiCodingRequest,
} from "./pi-coding-request.js";

type ResidentFrame =
  | { readonly type: "ready" }
  | {
      readonly type: "output";
      readonly seq: number;
      readonly channel: "stdout" | "stderr";
      readonly bytes: string;
    }
  | { readonly type: "result"; readonly seq: number; readonly exitCode: number };

function emit(frame: ResidentFrame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function emitOutput(seq: number, channel: "stdout" | "stderr", value: string | Uint8Array) {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  for (let offset = 0; offset < bytes.byteLength; offset += PI_RESIDENT_OUTPUT_CHUNK_BYTES)
    emit({
      type: "output",
      seq,
      channel,
      bytes: bytes.subarray(offset, offset + PI_RESIDENT_OUTPUT_CHUNK_BYTES).toString("base64"),
    });
}

function parseRunFrame(line: Buffer, expectedSequence: number): Buffer {
  const frame: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
  if (!frame || typeof frame !== "object" || Array.isArray(frame))
    throw new Error("PI_RESIDENT_FRAME_INVALID");
  const fields = frame as Record<string, unknown>;
  const input = fields["inputBase64"];
  if (
    Object.keys(fields).length !== 3 ||
    fields["type"] !== "run" ||
    fields["seq"] !== expectedSequence ||
    typeof input !== "string" ||
    Buffer.from(input, "base64").toString("base64") !== input
  )
    throw new Error("PI_RESIDENT_FRAME_INVALID");
  return Buffer.from(input, "base64");
}

export async function serveResidentPiRunner(identity: Required<PiRunnerIdentity>) {
  applyPiRunnerEnvironment(identity.runtimeRoot);
  await import("@himawari-agent/runtime-pi");
  emit({ type: "ready" });
  let sequence = 0;
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    for (let newline = pending.indexOf(10); newline >= 0; newline = pending.indexOf(10)) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.byteLength > PI_RESIDENT_FRAME_LIMIT_BYTES)
        throw new Error("PI_RESIDENT_FRAME_LIMIT");
      const request = parseRunFrame(line, sequence + 1);
      sequence++;
      const seq = sequence;
      let exitCode: number;
      try {
        exitCode = await runPiCodingRequest(request, identity, (bytes) =>
          emitOutput(seq, "stdout", bytes),
        );
      } catch {
        emitOutput(seq, "stderr", "PI_RUNNER_EXECUTION_FAILED\n");
        exitCode = 1;
      }
      emit({ type: "result", seq, exitCode });
    }
    if (pending.byteLength > PI_RESIDENT_FRAME_LIMIT_BYTES)
      throw new Error("PI_RESIDENT_FRAME_LIMIT");
  }
}
