import { describe, expect, it } from "vitest";
import { executionV2MessageSchema } from "../src/index.ts";
import {
  array,
  booleanValue,
  enumeration,
  integer,
  machineString,
  nullable,
  object,
  parseJson,
  timestamp,
} from "../src/validation.ts";
import messages from "./fixtures/v2/messages.json" with { type: "json" };

describe("strict wire value boundaries", () => {
  it.each([undefined, null, "true", 1])("does not coerce boolean %j", (value) => {
    expect(() => booleanValue.parse(value, "$.enabled")).toThrow("$.enabled");
  });
  it.each([null, 0, "invalid", "2026-09-14", "2026-09-14T00:00:00+00:00"])(
    "requires canonical timestamp %j",
    (value) => {
      expect(() => timestamp.parse(value, "$.at")).toThrow("$.at");
    },
  );
  it.each([null, "", "a".repeat(129), "contains space", "line\nbreak"])(
    "rejects invalid identifier %j",
    (value) => {
      expect(() => machineString.parse(value)).toThrow();
    },
  );
  it.each([0, 11, 1.5, Number.NaN, Infinity, "2"])(
    "enforces inclusive integer bounds for %j",
    (value) => {
      expect(() => integer(1, 10).parse(value)).toThrow();
    },
  );
  it("preserves primitive types, nullable values, bounds and nested error paths", () => {
    const schema = object({
      enabled: booleanValue,
      count: integer(1, 10),
      state: enumeration(["ready", "waiting"]),
      refs: array(nullable(machineString)),
      at: timestamp,
    });
    const value = {
      enabled: true,
      count: 10,
      state: "ready",
      refs: ["one", null],
      at: "2026-09-14T00:00:00.000Z",
    };
    expect(parseJson(schema, JSON.stringify(value))).toEqual(value);
    expect(Object.isFrozen(schema.parse(value))).toBe(true);
    expect(() => schema.parse({ ...value, refs: ["one", false] })).toThrow("$.refs[1]");
    expect(() => schema.parse({ ...value, refs: "one" })).toThrow("$.refs");
    expect(() => schema.parse({ ...value, extra: true })).toThrow("$.extra");
    const { enabled: _enabled, ...missing } = value;
    expect(() => schema.parse(missing)).toThrow("$.enabled");
    expect(() => schema.parse([])).toThrow("expected an object");
    expect(() => parseJson(schema, "{bad")).toThrow("expected valid JSON");
  });
});

describe("execution outcome and scope consistency", () => {
  const fixture = (type: string) => {
    const value = messages.find((item) => item.type === type);
    if (!value) throw new Error(`Missing execution contract fixture ${type}`);
    return structuredClone(value);
  };
  it.each([null, [], "work.execute", 42])("rejects a non-message %j", (value) => {
    expect(() => executionV2MessageSchema.parse(value)).toThrow(
      "expected an Execution v2 message object",
    );
  });
  it.each(["work.execute", "host.operation.execute", "worker.subtask.execute"])(
    "requires complete owner and run scope for %s",
    (type) => {
      const value = fixture(type);
      for (const key of ["ownerId", "agentId", "runId", "workerRunId"]) {
        expect(() =>
          executionV2MessageSchema.parse({ ...value, scope: { ...value.scope, [key]: null } }),
        ).toThrow("$.scope");
      }
    },
  );
  it.each(["work.result", "host.operation.result", "worker.subtask.result"])(
    "requires %s result references to agree with the outcome",
    (type) => {
      const value = fixture(type);
      const key = type === "worker.subtask.result" ? "workerResultRef" : "outputRef";
      for (const payload of [
        { outcome: "succeeded", [key]: null, errorCode: null },
        { outcome: "failed", [key]: "payload-unexpected", errorCode: "operation_failed" },
        { outcome: "failed", [key]: null, errorCode: null },
      ]) {
        expect(() =>
          executionV2MessageSchema.parse({ ...value, payload: { ...value.payload, ...payload } }),
        ).toThrow("result references");
      }
    },
  );
  it("does not turn unresolved reconciliation into a confirmed result", () => {
    const value = fixture("work.reconciled");
    for (const payload of [
      { outcome: "still_unknown", resultRef: "payload-unconfirmed", errorCode: null },
      { outcome: "confirmed_succeeded", resultRef: null, errorCode: null },
      { outcome: "confirmed_failed", resultRef: null, errorCode: null },
    ])
      expect(() =>
        executionV2MessageSchema.parse({ ...value, payload: { ...value.payload, ...payload } }),
      ).toThrow("reconciliation references");
  });
  it("requires recent authentication for permanent deletion and bounded host deadlines", () => {
    const value = fixture("host.operation.execute");
    expect(() =>
      executionV2MessageSchema.parse({
        ...value,
        payload: {
          ...value.payload,
          operation: "file.permanent_delete",
          recentAuthenticationRef: null,
        },
      }),
    ).toThrow("permanent deletion requires recent authentication");
    expect(() =>
      executionV2MessageSchema.parse({
        ...value,
        payload: { ...value.payload, deadlineAt: value.payload.requestedAt },
      }),
    ).toThrow("must be later than requestedAt");
  });
  it("keeps worker model selection and deadlines inside the frozen delegation", () => {
    const value = fixture("worker.subtask.execute");
    for (const payload of [
      { selectedModelRef: "model-not-delegated" },
      { deadlineAt: value.payload.requestedAt },
    ]) {
      expect(() =>
        executionV2MessageSchema.parse({ ...value, payload: { ...value.payload, ...payload } }),
      ).toThrow("must remain inside the frozen delegation");
    }
  });
});
