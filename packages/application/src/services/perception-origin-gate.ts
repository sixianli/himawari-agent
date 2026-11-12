import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  TOOL_RESULT_ORIGIN_GATE_CONFIRM,
  TOOL_RESULT_ORIGIN_GATE_DEFERRED,
} from "@himawari-agent/prompt-catalog";
import type { DecisionLedgerPort } from "../ports/decision-ledger.js";
import type {
  PerceptionRunInitiator,
  PerceptionScope,
  PerceptionStorePort,
} from "../ports/perception.js";
import { PERCEPTION_REASON_CODES, type PerceptionProposalPort } from "./perception-extraction.js";

export const ORIGIN_GATED_EFFECTS = [
  "reminder_create",
  "reminder_cancel",
  "rule_change",
  "device_action",
] as const;
export type OriginGatedEffect = (typeof ORIGIN_GATED_EFFECTS)[number];

export const ORIGIN_GATE_VERDICTS = ["proceed", "confirm", "defer"] as const;
export type OriginGateVerdict = (typeof ORIGIN_GATE_VERDICTS)[number];

export const ORIGIN_GATE_ERROR_CODES = Object.freeze({
  confirm: "PERCEPTION_ORIGIN_CONFIRMATION_REQUIRED",
  defer: "PERCEPTION_ORIGIN_DEFERRED",
});

export interface OriginGateAttempt {
  readonly runId: string;
  readonly toolCallId: string;
  readonly capabilityRef: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface OriginGateDecision {
  readonly verdict: OriginGateVerdict;
  readonly effect: OriginGatedEffect;
  readonly initiator: PerceptionRunInitiator;
  readonly recordIds: readonly string[];
  readonly errorCode: string | null;
  readonly note: string | null;
}

export interface PerceptionOriginGateOptions {
  readonly scope: PerceptionScope;
  readonly store: Pick<PerceptionStorePort, "runReadRecordIds" | "runInitiator">;
  readonly ledger: Pick<DecisionLedgerPort, "append">;
  readonly proposals?: PerceptionProposalPort;
  readonly now: () => string;
}

export class PerceptionOriginGate {
  readonly #options: PerceptionOriginGateOptions;

  constructor(options: PerceptionOriginGateOptions) {
    this.#options = options;
  }

  async check(attempt: OriginGateAttempt, effect: OriginGatedEffect): Promise<OriginGateDecision> {
    const { scope, store } = this.#options;
    const { runId } = attempt;
    const recordIds = await store.runReadRecordIds({ ...scope, runId });
    const initiator = (await store.runInitiator({ ...scope, runId })) ?? "background";
    if (recordIds.length === 0)
      return Object.freeze({
        verdict: "proceed",
        effect,
        initiator,
        recordIds,
        errorCode: null,
        note: null,
      });
    if (initiator === "owner")
      return Object.freeze({
        verdict: "confirm",
        effect,
        initiator,
        recordIds,
        errorCode: ORIGIN_GATE_ERROR_CODES.confirm,
        note: TOOL_RESULT_ORIGIN_GATE_CONFIRM.text,
      });
    const key = bytesToHex(sha256(utf8ToBytes(`${runId}\n${attempt.toolCallId}`))).slice(0, 32);
    const decidedAt = this.#options.now();
    await this.#options.ledger.append({
      id: `ledger:perception-gate:${key}`,
      ...scope,
      kind: "proposal",
      decidedAt,
      outcome: "proposed",
      reasonCode: PERCEPTION_REASON_CODES.gateDeferred,
      subjectRef: runId,
      inputs: { memoryIds: [], ruleIds: [] },
      reasonRef: null,
      contentRef: null,
      costMicros: 0,
      durationMs: 0,
    });
    await this.#options.proposals?.receive([
      {
        id: `proposal:gate:${key}`,
        sourceKind: "gated_tool_call",
        sourceId: `${runId}:${attempt.toolCallId}`,
        sourceVersion: "1",
        kind: "gated_action",
        what: null,
        todoId: null,
        quote: null,
        quotedRecordId: null,
        trust: "external",
        source: null,
        observedAt: decidedAt,
        recordIds,
        action: { capabilityRef: attempt.capabilityRef, arguments: attempt.arguments },
      },
    ]);
    return Object.freeze({
      verdict: "defer",
      effect,
      initiator,
      recordIds,
      errorCode: ORIGIN_GATE_ERROR_CODES.defer,
      note: TOOL_RESULT_ORIGIN_GATE_DEFERRED.text,
    });
  }
}
