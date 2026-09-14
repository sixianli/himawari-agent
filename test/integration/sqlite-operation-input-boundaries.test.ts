import { createDeploymentId } from "@himawari-agent/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ID,
  invocation,
  OWNER_ID,
  T0,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";
import { SqliteCapabilityInvocationOperations } from "../../packages/persistence-sqlite/src/sqlite-capability-invocation-operations.ts";
import { SqliteModelBudgetOperations } from "../../packages/persistence-sqlite/src/sqlite-model-budget-operations.ts";
import { SqliteModelInvocationOperations } from "../../packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts";
import { SqliteRunDispatchOperations } from "../../packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts";

// Malformed IPC values must be rejected before a database operation begins.
// Real persistence, leases and budget accounting are exercised by integration tests.
let database: Database.Database;
let disk: ReturnType<typeof vi.fn<() => void>>;
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
beforeEach(() => {
  database = new Database(":memory:");
  disk = vi.fn();
});
afterEach(() => database.close());
function changed(value: Record<string, unknown>, field: string, invalid: unknown) {
  const result = structuredClone(value);
  const keys = field.split(".");
  const last = keys.pop();
  if (!last) throw new Error("Missing test field");
  let parent = result;
  for (const key of keys) parent = parent[key] as Record<string, unknown>;
  parent[last] = invalid;
  return result;
}
function rejected(run: () => unknown, field: string) {
  expect(run).toThrow(
    expect.objectContaining({
      code: "PORT_INVALID_OPERATION",
      message: expect.stringContaining(field),
    }),
  );
  expect(disk).not.toHaveBeenCalled();
  expect(database.prepare("SELECT total_changes() AS changes").get()).toEqual({ changes: 0 });
  expect(database.prepare("SELECT count(*) AS count FROM sqlite_schema").get()).toEqual({
    count: 0,
  });
}
function budget<T extends Record<string, unknown>>(input: T) {
  return {
    scope: {
      ownerId: "owner-budget",
      agentId: "agent-budget",
      authority: {
        deploymentId: createDeploymentId("deployment-budget"),
        authorityEpoch: 1,
        fencingToken: 1,
      },
      authorityLease: { leaseId: "lease-budget", fencingToken: 1 },
    },
    input,
  };
}
function reserve() {
  return budget({
    parent: {
      kind: "run",
      runId: "run-budget",
      executionLease: {
        executionLeaseId: "execution-budget",
        expectedLeaseRevision: 1,
        authorityLeaseId: "lease-budget",
        authorityFencingToken: 1,
        deploymentId: "deployment-budget",
        authorityEpoch: 1,
        fencingToken: 1,
        consumerId: "consumer-budget",
      },
    },
    operationKey: "call-budget",
    modelRef: "model-budget",
    dataClassification: "private",
    estimatedCostMicros: 10,
    reservedAt: T0,
    limits: {
      accountCostMicros: 100,
      globalCostMicros: 1000,
      perClassificationCostMicros: {
        public: 1000,
        private: 1000,
        sensitive: 1000,
        restricted: 1000,
      },
    },
  });
}
describe("model budget IPC validation", () => {
  it.each([
    ["scope", null, "scope"],
    ["scope.ownerId", "contains space", "ownerId"],
    ["scope.agentId", "", "agentId"],
    ["scope.authority.authorityEpoch", 0, "authorityEpoch"],
    ["scope.authorityLease.fencingToken", 0, "lease.fencingToken"],
    ["input", [], "model budget input"],
    ["input.parent.kind", "other", "parent kind"],
    ["input.parent.executionLease", null, "executionLease"],
    ["input.parent.executionLease.expectedLeaseRevision", -1, "expectedLeaseRevision"],
    ["input.operationKey", "", "operationKey"],
    ["input.operationKey", "x".repeat(513), "operationKey"],
    ["input.modelRef", 42, "modelRef"],
    ["input.dataClassification", "unclassified", "dataClassification"],
    ["input.estimatedCostMicros", -1, "estimatedCostMicros"],
    ["input.estimatedCostMicros", 1.5, "estimatedCostMicros"],
    ["input.estimatedCostMicros", Number.MAX_SAFE_INTEGER + 1, "estimatedCostMicros"],
    ["input.limits", null, "limits"],
    ["input.limits.perClassificationCostMicros", [], "perClassificationCostMicros"],
    ["input.limits.accountCostMicros", -1, "accountCostMicros"],
    ["input.limits.globalCostMicros", "100", "globalCostMicros"],
    ["input.limits.perClassificationCostMicros.restricted", -1, "restricted"],
    ["input.reservedAt", "2026-09-14", "reservedAt"],
    ["input.reservedAt", "invalid", "reservedAt"],
  ])("rejects malformed reservation %s without touching state", (field, value, label) => {
    const operations = new SqliteModelBudgetOperations(database, fail, disk);
    rejected(
      () => operations.execute("modelBudget.reserve", changed(reserve(), field as string, value)),
      label as string,
    );
  });
  it.each([0, -1, 1001, 1.5, "10"])("rejects invalid read page size %s", (limit) => {
    const operations = new SqliteModelBudgetOperations(database, fail, disk);
    rejected(
      () =>
        operations.execute(
          "modelBudget.read",
          budget({ parent: { kind: "run", runId: "run-budget" }, limit, afterOperationKey: null }),
        ),
      "limit",
    );
  });
  it.each([
    "modelBudget.markStarted",
    "modelBudget.settle",
    "modelBudget.releaseReserved",
    "modelBudget.finalize",
  ])("does not accept missing parent identity for %s", (operation) => {
    const operations = new SqliteModelBudgetOperations(database, fail, disk);
    rejected(
      () => operations.execute(operation, budget({ parent: { kind: "other" } })),
      "parent kind",
    );
  });
  it("requires a known uncertainty reason and a run parent for finalization", () => {
    const operations = new SqliteModelBudgetOperations(database, fail, disk);
    rejected(
      () => operations.execute("modelBudget.markUnknown", budget({ reasonCode: "ignore-error" })),
      "reasonCode",
    );
    rejected(
      () =>
        operations.execute(
          "modelBudget.finalize",
          budget({ parent: { kind: "occurrence", occurrenceId: "occurrence-budget" } }),
        ),
      "requires a Run parent",
    );
    rejected(
      () => operations.execute("modelBudget.other", budget({})),
      "Unknown model budget operation",
    );
  });
});

describe("capability invocation IPC validation", () => {
  it.each([
    ["receiptRef", "", "receiptRef"],
    ["requestedAt", "invalid", "requestedAt"],
    ["deadlineAt", T0, "deadlineAt"],
    ["requestScope.runId", null, "requestScope.runId"],
    ["requestScope.authorityEpoch", 0, "requestScope.authorityEpoch"],
    ["requestScope.unexpected", true, "requestScope.unexpected"],
    ["dataClassification", "unclassified", "dataClassification"],
    ["delegatedContextRefs", "context", "delegatedContextRefs"],
    ["delegatedContextRefs", ["same", "same"], "duplicates"],
    ["secretRefs", "secret-ref", "secretRefs"],
    ["secretRefs", [null], "secretRefs[0]"],
    [
      "secretRefs",
      [{ secretRef: "secret-one", secretVersion: "1", purpose: "execution", extra: true }],
      "secretRefs[0].extra",
    ],
    [
      "secretRefs",
      [
        { secretRef: "secret-one", secretVersion: "1", purpose: "execution" },
        { secretRef: "secret-one", secretVersion: "1", purpose: "execution" },
      ],
      "duplicate secret identities",
    ],
    ["resourceCeiling.maxOutputBytes", 0, "resourceCeiling.maxOutputBytes"],
    ["resourceCeiling.maxWallTimeMs", "1000", "resourceCeiling.maxWallTimeMs"],
    ["authority.lease.fencingToken", 0, "authority.lease.fencingToken"],
    ["authority.workerBootId", "", "authority.workerBootId"],
  ])("rejects malformed %s before consuming a capability handle", (field, value, label) => {
    const operations = new SqliteCapabilityInvocationOperations(database, fail, disk);
    rejected(
      () =>
        operations.execute("capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: changed(invocation(), field as string, value),
        }),
      label as string,
    );
  });
  it.each(["capabilityInvocation.sandboxPrepare", "capabilityInvocation.unknown"])(
    "does not expose unsupported or non-atomic operation %s",
    (operation) => {
      const operations = new SqliteCapabilityInvocationOperations(database, fail, disk);
      rejected(
        () => operations.execute(operation, { ownerId: OWNER_ID, agentId: AGENT_ID, input: {} }),
        operation.endsWith("sandboxPrepare")
          ? "requires atomic admission"
          : "Unknown Capability invocation operation",
      );
    },
  );
});

function modelBegin() {
  const base = reserve();
  return {
    scope: base.scope,
    input: {
      ...base.input,
      runId: "run-budget",
      modelVersion: "1",
      provider: "fixture",
      model: "model-budget",
      logicalSlot: "slot-one",
      source: "agent-stream",
      ordinal: 1,
      pricing: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 1 },
      executionLease: base.input.parent.executionLease,
      authority: base.scope.authority,
      authorityLease: base.scope.authorityLease,
    },
  };
}
describe("model invocation durable boundary parsing", () => {
  it.each([
    ["scope", null, "scope"],
    ["scope.ownerId", "contains spaces", "ownerId"],
    ["scope.authorityLease.fencingToken", 0, "authorityLease.fencingToken"],
    ["input", null, "input"],
    ["input.runId", "invalid run", "runId"],
    ["input.modelVersion", 42, "modelVersion"],
    ["input.provider", " ", "provider"],
    ["input.model", "x".repeat(513), "model"],
    ["input.dataClassification", "unknown", "dataClassification"],
    ["input.logicalSlot", "", "logicalSlot"],
    ["input.source", "other", "source"],
    ["input.ordinal", 0, "ordinal"],
    ["input.estimatedCostMicros", 1.5, "estimatedCostMicros"],
    ["input.pricing", [], "pricing"],
    ["input.pricing.input", -1, "pricing.input"],
    ["input.pricing.output", Infinity, "pricing.output"],
    ["input.pricing.cacheRead", "0", "pricing.cacheRead"],
    ["input.pricing.cacheWrite", NaN, "pricing.cacheWrite"],
    ["input.executionLease", null, "executionLease"],
    ["input.executionLease.expectedLeaseRevision", -1, "expectedLeaseRevision"],
    ["input.executionLease.consumerId", "bad consumer", "consumerId"],
    ["input.authority", null, "authority"],
    ["input.authority.fencingToken", 0, "fencingToken"],
    ["input.authorityLease", null, "authorityLease"],
    ["input.limits", null, "limits"],
    ["input.limits.perClassificationCostMicros", null, "perClassificationCostMicros"],
    ["input.limits.globalCostMicros", -1, "globalCostMicros"],
    ["input.limits.perClassificationCostMicros.private", -1, "private"],
    ["input.reservedAt", "invalid", "reservedAt"],
    ["input.reservedAt", "2026-09-14", "reservedAt"],
  ])("rejects invalid model identity %s before writing a reservation", (field, value, label) => {
    const operations = new SqliteModelInvocationOperations(
      database,
      fail,
      disk,
      new SqliteModelBudgetOperations(database, fail, disk),
    );
    rejected(
      () =>
        operations.execute("modelInvocation.begin", changed(modelBegin(), field as string, value)),
      label as string,
    );
  });
  it.each([
    "modelInvocation.markStarted",
    "modelInvocation.releaseReserved",
    "modelInvocation.settle",
    "modelInvocation.markUnknown",
  ])("requires complete transition identity for %s", (operation) => {
    const operations = new SqliteModelInvocationOperations(
      database,
      fail,
      disk,
      new SqliteModelBudgetOperations(database, fail, disk),
    );
    rejected(
      () => operations.execute(operation, budget({ runId: "run-budget", invocationId: "" })),
      "invocationId",
    );
  });
  it("rejects negative settlement and unknown reconciliation reasons", () => {
    const operations = new SqliteModelInvocationOperations(
      database,
      fail,
      disk,
      new SqliteModelBudgetOperations(database, fail, disk),
    );
    const base = {
      runId: "run-budget",
      invocationId: "model-one",
      budgetOperationKey: "budget-one",
      executionLease: modelBegin().input.executionLease,
      at: T0,
    };
    rejected(
      () => operations.execute("modelInvocation.settle", budget({ ...base, actualCostMicros: -1 })),
      "actualCostMicros",
    );
    rejected(
      () =>
        operations.execute(
          "modelInvocation.markUnknown",
          budget({ ...base, reasonCode: "ignore" }),
        ),
      "reasonCode",
    );
    rejected(
      () => operations.execute("modelInvocation.unknown", budget({})),
      "Unknown model invocation operation",
    );
  });
});

describe("dispatch IPC boundary parsing", () => {
  const scope = () => ({ ...budget({}).scope, consumerId: "consumer-budget" });
  it.each([null, [], "request"])("rejects a non-object dispatch request %j", (value) => {
    const operations = new SqliteRunDispatchOperations(database, scope(), fail);
    rejected(() => operations.execute("runDispatch.claim", value), "must be an object");
  });
  it.each([
    ["runId", "bad id", "runId"],
    ["expectedRunRevision", -1, "expectedRunRevision"],
    ["expectedLeaseRevision", 1.5, "expectedLeaseRevision"],
    ["executionLeaseId", "", "executionLeaseId"],
    ["claimedAt", "invalid", "claimedAt"],
    ["expiresAt", T0, "expiresAt"],
  ])("rejects malformed execution claim %s before opening a transaction", (field, value, label) => {
    const operations = new SqliteRunDispatchOperations(database, scope(), fail);
    const claim = {
      runId: "run-budget",
      expectedRunRevision: 1,
      expectedLeaseRevision: 0,
      executionLeaseId: "execution-budget",
      claimedAt: T0,
      expiresAt: "2999-01-01T00:00:00.000Z",
    };
    rejected(
      () => operations.execute("runDispatch.claim", { ...claim, [field as string]: value }),
      label as string,
    );
  });
  it.each(["runDispatch.listClaimable", "runDispatch.listReconciliationRequired"])(
    "bounds the %s page before querying durable state",
    (operation) => {
      const operations = new SqliteRunDispatchOperations(database, scope(), fail);
      rejected(() => operations.execute(operation, { now: T0, limit: 0 }), "limit");
      rejected(() => operations.execute(operation, { now: "invalid", limit: 10 }), "now");
      rejected(
        () => operations.execute("runDispatch.unknown", {}),
        "Unknown Run dispatch operation",
      );
    },
  );
});
