import { createLocalExecutionWorkerProcess } from "@himawari-agent/execution-worker";
import type { ReconcileWorkRequest } from "@himawari-agent/execution-contracts";
import {
  ScriptedExternalActionReconciliationPort,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("external action reconciliation", () => {
  it("maps a stable execution.v1 reconcile request through the replaceable adapter", async () => {
    const adapters = createReferenceAdapterSet();
    const reconciliation = new ScriptedExternalActionReconciliationPort({
      "external-reservation-01": {
        outcome: "confirmed_succeeded",
        resultRef: "payload-reservation-confirmed",
        errorCode: null,
      },
    });
    const worker = createLocalExecutionWorkerProcess({
      handles: adapters.capabilityRegistry,
      capability: adapters.capability,
      secrets: adapters.secret,
      reconciliation,
      clock: adapters.clock,
      ids: adapters.ids,
    });
    await worker.start();
    const request: ReconcileWorkRequest = {
      schemaVersion: "execution.v1",
      kind: "request",
      type: "work.reconcile",
      messageId: "reconcile-reservation-01",
      correlationId: "correlation-reservation-01",
      causationId: "execution-reservation-01",
      dataClassification: "private",
      scope: {
        ownerId: "owner-01",
        agentId: "agent-01",
        runId: "run-01",
        workerRunId: "worker-run-01",
      },
      idempotencyKey: "reconcile-reservation-01",
      payload: {
        externalActionId: "external-reservation-01",
        resultLookupRef: "lookup-reservation-01",
        requestedAt: "2026-08-25T00:00:00.000Z",
      },
    };

    const events = await collect(worker.client.dispatch(request));

    expect(events).toMatchObject([
      {
        type: "work.reconciled",
        payload: {
          requestId: request.messageId,
          externalActionId: request.payload.externalActionId,
          outcome: "confirmed_succeeded",
          resultRef: "payload-reservation-confirmed",
          errorCode: null,
        },
      },
    ]);
    expect(reconciliation.observedRequests()).toEqual([
      {
        externalActionId: request.payload.externalActionId,
        resultLookupRef: request.payload.resultLookupRef,
      },
    ]);
  });
});
