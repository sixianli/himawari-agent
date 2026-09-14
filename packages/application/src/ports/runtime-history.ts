import type { RunId } from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

/** A product-authorized, immutable snapshot; native bytes are interpreted only by runtime-pi. */
export interface RuntimeHistoryReference {
  readonly runId: RunId;
  readonly operationKey: string;
  readonly payloadRef: PayloadRef;
  readonly dataClassification: DataClassification;
}

export interface RuntimeHistoryState {
  readonly messages: readonly unknown[];
  readonly coveredRunIds: readonly RunId[];
}

export interface RuntimeHistoryPort {
  save(input: {
    readonly runId: RunId;
    readonly dataClassification: DataClassification;
    readonly messages: readonly unknown[];
    readonly coveredRunIds?: readonly RunId[];
  }): Promise<RuntimeHistoryReference>;
  load(
    reference: RuntimeHistoryReference,
    classification: DataClassification,
  ): Promise<RuntimeHistoryState>;
}
