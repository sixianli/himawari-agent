import type { SandboxExecutionRecord } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import {
  sandboxV2Admission as admission,
  sandboxV2Call as call,
} from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

function replace<T>(input: T, field: string, value: unknown): T {
  const result = structuredClone(input);
  const parts = field.split(".");
  const last = parts.pop();
  if (!last) throw new Error("Expected fixture field");
  let parent = result as Record<string, unknown>;
  for (const part of parts) parent = parent[part] as Record<string, unknown>;
  parent[last] = value;
  return result;
}

describe("SQLite sandbox request boundaries", () => {
  it("keeps bounded reads scoped and rejects malformed locators before touching a journal", async () => {
    const f = await openSandboxJournal();
    try {
      const execute = (operation: string, input: unknown) =>
        operationsForDatabase(f.database).execute(`capabilityInvocation.sandboxV2.${operation}`, {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input,
        });
      for (const operation of ["listPending", "listAdmissions"]) {
        for (const input of [null, [], "invalid"])
          expect(() => execute(operation, input)).toThrow("Invalid sandbox journal request");
        for (const input of [
          { afterJobId: "bad cursor", limit: 1 },
          { afterJobId: null, limit: 0 },
          { afterJobId: null, limit: 101 },
          { afterJobId: null, limit: 1.5 },
        ])
          expect(() => execute(operation, input)).toThrow("Invalid bounded page");
        expect(execute(operation, { afterJobId: null, limit: 1 })).toEqual([]);
      }
      expect(() =>
        execute("listAdmissions", { afterJobId: null, limit: 1, runId: "bad run" }),
      ).toThrow("Invalid Run locator");
      for (const [operation, field] of [
        ["readAdmissionByResource", "resourceRef"],
        ["readAdmissionByInvocation", "invocationId"],
      ] as const) {
        expect(() => execute(operation, { runId: "bad run", [field]: "valid" })).toThrow("locator");
        expect(() => execute(operation, { runId: "valid", [field]: "bad locator" })).toThrow(
          "locator",
        );
        expect(execute(operation, { runId: "valid", [field]: "missing" })).toBeUndefined();
      }
      const a = admission(f);
      const record = call(f, "admit", a).record;
      for (const operation of ["read", "readAdmission"]) {
        for (const field of ["ownerId", "agentId"])
          expect(() => execute(operation, replace(record.plan.identity, field, "other"))).toThrow(
            "scope mismatch",
          );
        expect(() =>
          execute(operation, replace(record.plan.identity, "attemptId", "other")),
        ).toThrow("identity changed");
        expect(
          execute(operation, replace(record.plan.identity, "jobId", "missing")),
        ).toBeUndefined();
      }
      expect(
        execute("readAdmissionByInvocation", {
          runId: record.plan.identity.runId,
          invocationId: record.plan.identity.invocationId,
        }),
      ).toMatchObject({ phase: "bound", record: { plan: record.plan } });
      expect(
        execute("listAdmissions", {
          runId: record.plan.identity.runId,
          afterJobId: null,
          limit: 1,
        }),
      ).toMatchObject([{ phase: "bound", record: { plan: record.plan } }]);
      expect(
        execute("listAdmissions", { afterJobId: record.plan.identity.jobId, limit: 1 }),
      ).toEqual([]);
      expect(
        f.database.prepare("SELECT count(*) AS count FROM sandbox_execution_records").get(),
      ).toEqual({ count: 1 });
    } finally {
      await f.close();
    }
  });

  it("rolls back consumed authority when directory claims fail validation", async () => {
    const f = await openSandboxJournal();
    try {
      const a = admission(f);
      const original = a.workspaces[0];
      if (!original) throw new Error("Expected workspace claim");
      const invalid: unknown[] = [
        [],
        Array.from({ length: 65 }, () => original),
        [null],
        [{ ...original, ref: "bad ref" }],
        [{ ...original, canonicalRootId: "bad root" }],
        [{ ...original, hostId: "other" }],
        [{ ...original, access: "execute" }],
        [{ ...original, lineage: null }],
        [{ ...original, lineage: [] }],
        [
          {
            ...original,
            lineage: Array.from({ length: 257 }, () => ({ device: "1", inode: "1" })),
          },
        ],
        [
          {
            ...original,
            lineage: [
              { device: "1", inode: "1" },
              { device: "1", inode: "1" },
            ],
          },
        ],
        [{ ...original, lineage: [null] }],
        [{ ...original, lineage: [{ device: "bad device", inode: "1" }] }],
        [{ ...original, lineage: [{ device: "1", inode: "bad inode" }] }],
      ];
      for (const workspaces of invalid) {
        expect(() => call(f, "admit", replace(a, "workspaces", workspaces))).toThrow(
          /workspace coverage|directory identity chain/,
        );
        expect(
          f.database.prepare("SELECT count(*) AS count FROM capability_invocation_receipts").get(),
        ).toEqual({ count: 0 });
        expect(
          f.database.prepare("SELECT count(*) AS count FROM sandbox_workspace_occupancy").get(),
        ).toEqual({ count: 0 });
      }
      for (const workspaces of [
        [original, original],
        [{ ...original, ref: "not-in-frozen-environment" }],
      ])
        expect(() => call(f, "admit", { ...a, workspaces })).toThrow(
          "do not cover frozen environment",
        );
      expect(call(f, "admit", a).applied).toBe(true);
      expect(
        f.database.prepare("SELECT count(*) AS count FROM capability_invocation_receipts").get(),
      ).toEqual({ count: 1 });
      expect(f.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("rejects stale starts, invalid times and unissued intent receipts without modifying execution history", async () => {
    const f = await openSandboxJournal();
    try {
      const record = call(f, "admit", admission(f)).record as SandboxExecutionRecord;
      const request = {
        identity: record.plan.identity,
        expectedSequence: 1,
        policyDigest: record.facts.environment.policyDigest,
        authority: SERVICE_AUTHORITY,
        now: T1,
      };
      for (const now of [null, "invalid", T1.slice(0, 10)])
        expect(() => call(f, "start", replace(request, "now", now))).toThrow(
          "Invalid observation time",
        );
      expect(() => call(f, "start", { ...request, expectedSequence: 2 })).toThrow(
        "Start sequence changed",
      );
      expect(() =>
        call(f, "start", { ...request, identity: { ...request.identity, jobId: "missing" } }),
      ).toThrow("Sandbox execution missing");
      for (const operation of ["acknowledgeIntent", "observeIntent"] as const) {
        expect(() =>
          call(f, operation, { ...request, intentId: "bad id", reasonCode: "reason" }),
        ).toThrow(/Invalid intent/);
        expect(() =>
          call(f, operation, { ...request, intentId: "missing", reasonCode: "reason" }),
        ).toThrow("Intent was not dispatched");
      }
      expect(() =>
        call(f, "observeIntent", { ...request, intentId: "valid", reasonCode: "bad reason" }),
      ).toThrow("Invalid intent observation");
      expect(call(f, "read", record.plan.identity)).toEqual(record);
      expect(
        f.database.prepare("SELECT count(*) AS count FROM sandbox_execution_intents").get(),
      ).toEqual({ count: 0 });
      expect(call(f, "start", request).applied).toBe(true);
      expect(call(f, "start", request).applied).toBe(false);
    } finally {
      await f.close();
    }
  });
});
