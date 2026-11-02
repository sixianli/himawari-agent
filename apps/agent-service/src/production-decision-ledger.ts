import { randomUUID } from "node:crypto";
import type { DecisionLedgerPort, DecisionLedgerWrite } from "@himawari-agent/application";

export function retrievalDegradeRecorder(options: {
  readonly ledger: Pick<DecisionLedgerPort, "append">;
  readonly now: () => string;
  readonly onFailure: (error: unknown) => void;
}): (
  error: unknown,
  scope: {
    readonly ownerId: DecisionLedgerWrite["ownerId"];
    readonly agentId: DecisionLedgerWrite["agentId"];
  },
) => void {
  return (_error, scope) => {
    void options.ledger
      .append({
        id: `ledger:${randomUUID()}`,
        ownerId: scope.ownerId,
        agentId: scope.agentId,
        kind: "retrieval_degrade",
        decidedAt: options.now(),
        outcome: "degraded",
        reasonCode: "vector_search_unavailable",
        subjectRef: null,
        inputs: { memoryIds: [], ruleIds: [] },
        reasonRef: null,
        contentRef: null,
        costMicros: 0,
        durationMs: 0,
      })
      .catch(options.onFailure);
  };
}
