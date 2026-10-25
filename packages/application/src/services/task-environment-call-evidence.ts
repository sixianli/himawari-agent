import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface TaskEnvironmentCall {
  readonly environmentId: string;
  readonly invocationId: string;
  readonly createIntentId: string;
  readonly runtimeInstanceId: string;
  readonly runtimeEnvironmentId: string;
}

export function taskEnvironmentCallEvidence(call: TaskEnvironmentCall): {
  readonly ref: string;
  readonly digest: string;
} {
  const digest = bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "himawari.task-environment-call.v1",
          call.environmentId,
          call.invocationId,
          call.createIntentId,
          call.runtimeInstanceId,
          call.runtimeEnvironmentId,
        ]),
      ),
    ),
  );
  return { ref: `environment-call:${digest.slice(0, 32)}`, digest };
}
