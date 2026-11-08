import { randomUUID } from "node:crypto";

export const DECISION_SIGNAL_KINDS = ["opened", "undone", "replied"] as const;
export type DecisionSignalKind = (typeof DECISION_SIGNAL_KINDS)[number];

export interface DecisionSignalDatabase {
  prepare(sql: string): { run(...parameters: unknown[]): { changes: number | bigint } };
}

export function recordDecisionSignal(
  database: DecisionSignalDatabase,
  input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly decisionId: string;
    readonly signal: DecisionSignalKind;
    readonly occurredAt: string;
    readonly delayMs: number;
    readonly detail: Readonly<Record<string, string | number | boolean>>;
    readonly sourceRef: string;
    readonly recordedAt: string;
  },
): boolean {
  const delayMs = Number.isFinite(input.delayMs) ? Math.max(0, Math.round(input.delayMs)) : 0;
  return (
    Number(
      database
        .prepare(
          `INSERT INTO decision_signals (
            id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail,
            source_ref, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (decision_id, signal, source_ref) DO NOTHING`,
        )
        .run(
          `signal:${randomUUID()}`,
          input.ownerId,
          input.agentId,
          input.decisionId,
          input.signal,
          input.occurredAt,
          delayMs,
          JSON.stringify(input.detail),
          input.sourceRef,
          input.recordedAt,
        ).changes,
    ) > 0
  );
}
