import { WorkerDelegationAdmissionService } from "@himawari-agent/application";
import type {
  SandboxExecutionAdmissionRecord,
  SandboxExecutionPreparationPort,
} from "@himawari-agent/application";
import {
  sandboxExecutionFactsSchema,
  sandboxExecutionReservationSchema,
} from "@himawari-agent/execution-contracts";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  SERVICE_AUTHORITY,
  serviceRequest,
  T2,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

type Fixture = Awaited<ReturnType<typeof openSandboxJournal>>;
function call<K extends keyof SandboxExecutionPreparationPort>(
  f: Fixture,
  method: K,
  input: Parameters<SandboxExecutionPreparationPort[K]>[0],
): Awaited<ReturnType<SandboxExecutionPreparationPort[K]>> {
  return operationsForDatabase(f.database).execute(`capabilityInvocation.sandboxV2.${method}`, {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    input,
  }) as Awaited<ReturnType<SandboxExecutionPreparationPort[K]>>;
}
function input(f: Fixture, suffix = "") {
  const { plan, invocation, workspaces } = sandboxV2Admission(f, suffix);
  return {
    plan,
    invocation,
    workspaces,
    reservation: sandboxExecutionReservationSchema.parse({
      schemaVersion: "sandbox-preparation.v1",
      identity: plan.identity,
      environmentId: plan.environmentId,
      resourceRef: null,
      mode: plan.mode,
      workspaceConflictRefs: workspaces.map((item) => item.ref),
      sequence: 1,
      createdAt: plan.requestedAt,
    }),
  };
}
function binding(f: Fixture) {
  const { plan, facts } = sandboxV2Admission(f);
  return {
    identity: plan.identity,
    expectedSequence: 1 as const,
    authority: SERVICE_AUTHORITY,
    now: T1,
    facts: sandboxExecutionFactsSchema.parse({
      ...facts,
      environment: { ...facts.environment, policyDigest: "9".repeat(64) },
      resource: { ...facts.resource, policyDigest: "9".repeat(64), sequence: 2 },
    }),
  };
}
function reserved(value: SandboxExecutionAdmissionRecord) {
  if (value.phase !== "reserved") throw new Error("expected an unbound reservation");
  return value;
}

describe("atomic execution reservation and runtime binding", () => {
  it.each(["claim", "contract", "deadline"] as const)(
    "rejects changing the persisted queued request at admission: %s",
    async (change) => {
      const f = await openSandboxJournal();
      try {
        const queued = input(f);
        call(f, "enqueue", queued);
        const changed = structuredClone(queued);
        if (change === "claim")
          changed.workspaces = changed.workspaces.map((claim) => ({ ...claim, access: "read" }));
        if (change === "contract")
          changed.plan = { ...changed.plan, backendRef: "another-backend" };
        if (change === "deadline")
          changed.plan = {
            ...changed.plan,
            effectiveDeadlineAt: new Date(
              Date.parse(queued.plan.effectiveDeadlineAt) - 1,
            ).toISOString(),
          };
        expect(() => call(f, "reserve", changed)).toThrow();
        expect(
          f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
        ).toBe(0);
        expect(
          f.database.prepare("SELECT count(*) FROM sandbox_workspace_occupancy").pluck().get(),
        ).toBe(0);
        expect(f.database.prepare("SELECT status FROM sandbox_admission_queue").pluck().get()).toBe(
          "queued",
        );
      } finally {
        await f.close();
      }
    },
  );

  it("does not give one invocation two queue identities or two places in line", async () => {
    const f = await openSandboxJournal();
    try {
      const first = input(f);
      call(f, "enqueue", first);
      const identity = { ...first.plan.identity, jobId: "different-job" };
      expect(() =>
        call(f, "enqueue", {
          ...first,
          plan: { ...first.plan, identity },
          reservation: { ...first.reservation, identity },
        }),
      ).toThrow();
      expect(f.database.prepare("SELECT count(*) FROM sandbox_admission_queue").pluck().get()).toBe(
        1,
      );
    } finally {
      await f.close();
    }
  });

  it.each(["different", "same-slot", "same-inode", "atomic-read", "directory-write"] as const)(
    "coordinates concrete file resources: %s",
    async (scenario) => {
      const f = await openSandboxJournal();
      try {
        const file = (
          suffix: string,
          name: string,
          inode: string,
          access: "read" | "write" = "write",
        ) => {
          const value = input(f, suffix);
          return {
            ...value,
            workspaces: value.workspaces.map((claim) => ({
              ...claim,
              access,
              file: { name, identity: { device: "1", inode }, atomicPublish: access === "write" },
            })),
          };
        };
        const first = file("-a", "a.txt", "801");
        const second =
          scenario === "directory-write"
            ? input(f, "-b")
            : file(
                "-b",
                scenario === "same-slot" || scenario === "atomic-read" ? "a.txt" : "b.txt",
                scenario === "same-inode" || scenario === "atomic-read" ? "801" : "802",
                scenario === "atomic-read" ? "read" : "write",
              );
        call(f, "enqueue", first);
        call(f, "enqueue", second);
        call(f, "reserve", first);
        if (["different", "atomic-read"].includes(scenario))
          expect(call(f, "reserve", second).applied).toBe(true);
        else expect(() => call(f, "reserve", second)).toThrow();
      } finally {
        await f.close();
      }
    },
  );
  it("allows two read-only preparations over the same workspace", async () => {
    const f = await openSandboxJournal();
    try {
      const first = input(f, "-read-first");
      const second = input(f, "-read-second");
      const readOnly = (value: ReturnType<typeof input>) => ({
        ...value,
        workspaces: value.workspaces.map((claim) => ({ ...claim, access: "read" as const })),
      });
      call(f, "enqueue", readOnly(first));
      call(f, "enqueue", readOnly(second));
      expect(call(f, "reserve", readOnly(first)).applied).toBe(true);
      expect(call(f, "reserve", readOnly(second)).applied).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each(["available", "cancelled", "expired"] as const)(
    "revalidates a queued production admission before consuming: %s",
    async (outcome) => {
      const f = await openSandboxJournal();
      try {
        const older = input(f, "-first");
        call(f, "enqueue", older);
        const waiting = input(f);
        let now = T1;
        let waits = 0;
        let checks = 0;
        const preparations = {
          enqueue: async (value: Parameters<SandboxExecutionPreparationPort["enqueue"]>[0]) =>
            call(f, "enqueue", value),
          reserve: async (value: Parameters<SandboxExecutionPreparationPort["reserve"]>[0]) =>
            call(f, "reserve", value),
          cancelQueued: async (
            value: Parameters<SandboxExecutionPreparationPort["cancelQueued"]>[0],
          ) => {
            call(f, "cancelQueued", value);
          },
          readAdmission: async (
            value: Parameters<SandboxExecutionPreparationPort["readAdmission"]>[0],
          ) => call(f, "readAdmission", value),
        };
        const admission = new WorkerDelegationAdmissionService({
          invocations: {
            consume: async () => {
              throw new Error("uncoordinated consume");
            },
            read: async () => undefined,
          },
          invocationAuthority: () => SERVICE_AUTHORITY,
          now: () => now,
          nextId: (kind) =>
            kind === "capability-invocation-receipt" ? "generated-after-reentry" : `test-${kind}`,
          waitForWorkspace: async () => {
            waits++;
            expect(waits).toBe(1);
            expect(
              f.database
                .prepare("SELECT COUNT(*) FROM capability_invocation_receipts")
                .pluck()
                .get(),
            ).toBe(0);
            if (outcome === "expired") now = T2;
            else if (outcome === "cancelled")
              f.database
                .prepare("UPDATE runs SET status='cancelled' WHERE id=?")
                .run(waiting.plan.identity.runId);
            call(f, "cancelQueued", {
              identity: older.plan.identity,
              authority: SERVICE_AUTHORITY,
              now,
            });
          },
          sandbox: {
            journal: {
              admit: async () => {
                throw new Error("legacy admission");
              },
            },
            preparations,
            prepare: async () => waiting,
            scopes: {
              read: async () => {
                checks++;
                return f.scope as import("@himawari-agent/execution-contracts").SandboxScope;
              },
            },
          },
        });
        const original = serviceRequest();
        const invocation = waiting.invocation;
        const request = {
          ...original,
          messageId: invocation.invocationId,
          idempotencyKey: invocation.idempotencyKey,
          scope: invocation.requestScope,
          authorizationRef: invocation.authorizationRef,
          payload: {
            ...original.payload,
            requestedAt: invocation.requestedAt,
            deadlineAt: invocation.deadlineAt,
            capabilityHandleRef: invocation.handleRef,
            capabilityId: invocation.capabilityRef,
            capabilityVersion: invocation.capabilityVersion,
            operation: invocation.operation,
            inputRef: invocation.inputRef,
            resourceCeiling: invocation.resourceCeiling,
          },
        };
        if (outcome === "available")
          expect((await admission.admit(request)).disposition).toBe("consumed");
        else await expect(admission.admit(request)).rejects.toThrow();
        expect(waits).toBe(1);
        expect(checks).toBe(2);
        expect(
          f.database.prepare("SELECT COUNT(*) FROM capability_invocation_receipts").pluck().get(),
        ).toBe(outcome === "available" ? 1 : 0);
        expect(
          f.database
            .prepare("SELECT status FROM sandbox_admission_queue WHERE job_id=?")
            .pluck()
            .get(waiting.plan.identity.jobId),
        ).toBe(outcome === "available" ? "admitted" : "cancelled");
      } finally {
        await f.close();
      }
    },
  );

  it("queues without effects and prevents a newer conflicting request from jumping ahead", async () => {
    const f = await openSandboxJournal();
    try {
      const older = input(f, "-older");
      const newer = input(f, "-newer");
      expect(call(f, "enqueue", older)).toMatchObject({ status: "queued" });
      expect(call(f, "enqueue", older)).toEqual(call(f, "enqueue", older));
      call(f, "enqueue", newer);
      expect(
        f.database.prepare("SELECT COUNT(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(0);
      expect(
        f.database.prepare("SELECT COUNT(*) FROM sandbox_workspace_occupancy").pluck().get(),
      ).toBe(0);
      expect(() => call(f, "reserve", newer)).toThrow("earlier conflicting request");
      expect(
        f.database.prepare("SELECT COUNT(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(0);
      call(f, "cancelQueued", {
        identity: older.plan.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
      });
      expect(call(f, "reserve", newer).applied).toBe(true);
      expect(() => call(f, "reserve", older)).toThrow();
    } finally {
      await f.close();
    }
  });

  it("does not place unrelated resources behind an older queued request", async () => {
    const f = await openSandboxJournal();
    try {
      call(f, "enqueue", input(f, "-waiting"));
      const unrelated = input(f, "-unrelated");
      const workspaces = unrelated.workspaces.map((claim) => ({
        ...claim,
        lineage: [
          { device: "1", inode: "1" },
          { device: "1", inode: "20" },
        ],
      }));
      const ready = { ...unrelated, workspaces };
      call(f, "enqueue", ready);
      expect(call(f, "reserve", ready).applied).toBe(true);
      expect(
        f.database
          .prepare("SELECT status FROM sandbox_admission_queue WHERE job_id=?")
          .pluck()
          .get("job-waiting"),
      ).toBe("queued");
    } finally {
      await f.close();
    }
  });

  it("rejects changed queue identities and revoked Handles without creating occupancy", async () => {
    const f = await openSandboxJournal();
    try {
      const queued = input(f, "-queue");
      call(f, "enqueue", queued);
      expect(() =>
        call(f, "enqueue", {
          ...queued,
          workspaces: queued.workspaces.map((claim) => ({ ...claim, access: "read" })),
        }),
      ).toThrow();
      f.database
        .prepare(
          "UPDATE capability_handles SET revoked_at=?, record_json=json_set(record_json,'$.revokedAt',?) WHERE id=?",
        )
        .run(T1, T1, queued.plan.handleRef);
      expect(() => call(f, "reserve", queued)).toThrow();
      expect(
        f.database.prepare("SELECT COUNT(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(0);
      expect(
        f.database.prepare("SELECT COUNT(*) FROM sandbox_workspace_occupancy").pluck().get(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("preserves reservations and fixed start bindings across database reopen", async () => {
    const f = await openSandboxJournal();
    try {
      const reserve = input(f),
        start = binding(f);
      call(f, "reserve", reserve);
      f.database.close();
      let repo = await SqliteProductStateRepository.open({ stateRoot: f.resource.stateRoot });
      try {
        let port = repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
        expect((await port.readAdmission(reserve.plan.identity))?.phase).toBe("reserved");
        const attempts = await Promise.all([port.bindAndStart(start), port.bindAndStart(start)]);
        expect(attempts.filter((value) => value.applied)).toHaveLength(1);
        await repo.close();
        repo = await SqliteProductStateRepository.open({ stateRoot: f.resource.stateRoot });
        port = repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
        expect((await port.readAdmission(reserve.plan.identity))?.phase).toBe("bound");
        expect((await port.bindAndStart(start)).applied).toBe(false);
        await expect(port.reserve(input(f, "-conflict"))).rejects.toThrow("occupied");
      } finally {
        await repo.close();
      }
    } finally {
      await f.close();
    }
  });
  it("reads the original unconsumed queue snapshot after reopening the database", async () => {
    const f = await openSandboxJournal();
    try {
      const queued = input(f);
      const position = call(f, "enqueue", queued);
      const locator = {
        runId: queued.plan.identity.runId,
        invocationId: queued.invocation.invocationId,
      };
      f.database.close();
      const repo = await SqliteProductStateRepository.open({ stateRoot: f.resource.stateRoot });
      try {
        const port = repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
        const saved = await port.readQueuedByInvocation(locator);
        expect(saved).toMatchObject({
          ...position,
          plan: queued.plan,
          reservation: queued.reservation,
          workspaces: queued.workspaces,
        });
        expect(saved?.invocation).not.toHaveProperty("consumedAt");
        expect(await port.readAdmission(queued.plan.identity)).toBeUndefined();
        expect(
          await repo
            .sandboxExecutionPreparations(OWNER_ID, "other-agent" as typeof AGENT_ID)
            .readQueuedByInvocation(locator),
        ).toBeUndefined();
        const admission = await port.reserve(queued);
        expect(admission.applied).toBe(true);
        expect((await port.reserve(queued)).applied).toBe(false);
        expect(await port.readQueuedByInvocation(locator)).toMatchObject({
          sequence: position.sequence,
          status: "admitted",
        });
      } finally {
        await repo.close();
      }
    } finally {
      await f.close();
    }
  });
  it("admits without fabricated runtime values, then fixes the actual binding exactly once", async () => {
    const f = await openSandboxJournal();
    try {
      const first = call(f, "reserve", input(f));
      expect(first.applied).toBe(true);
      expect(JSON.stringify(reserved(first.admission).reservation)).not.toMatch(
        /policyDigest|supervisor|privateDirectory/,
      );
      expect(call(f, "reserve", input(f)).applied).toBe(false);
      expect(() =>
        sandboxV2Call(f, "start", {
          identity: input(f).plan.identity,
          expectedSequence: 1,
          policyDigest: "d".repeat(64),
          authority: SERVICE_AUTHORITY,
          now: T1,
        }),
      ).toThrow("has not been bound");
      const started = call(f, "bindAndStart", binding(f));
      expect(started.applied).toBe(true);
      expect(started.record.facts.environment.policyDigest).toBe("9".repeat(64));
      expect(call(f, "bindAndStart", binding(f)).applied).toBe(false);
      expect(call(f, "reserve", input(f))).toMatchObject({
        applied: false,
        admission: { phase: "bound" },
      });
      const changed = binding(f);
      expect(() =>
        call(f, "bindAndStart", {
          ...changed,
          facts: sandboxExecutionFactsSchema.parse({
            ...changed.facts,
            environment: { ...changed.facts.environment, policyDigest: "8".repeat(64) },
            resource: { ...changed.facts.resource, policyDigest: "8".repeat(64) },
          }),
        }),
      ).toThrow("binding changed");
      expect(
        f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(1);
      expect(
        f.database
          .prepare("SELECT sequence FROM sandbox_execution_observations ORDER BY sequence")
          .pluck()
          .all(),
      ).toEqual([1, 2]);
    } finally {
      await f.close();
    }
  });
  it("retains occupancy before preparation and rolls back a conflicting consume", async () => {
    const f = await openSandboxJournal();
    try {
      call(f, "reserve", input(f));
      expect(() => call(f, "reserve", input(f, "other"))).toThrow("pending preparation");
      expect(
        f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(1);
      expect(
        f.database.prepare("SELECT released_at FROM sandbox_workspace_occupancy").pluck().get(),
      ).toBeNull();
      expect(call(f, "listAdmissions", { afterJobId: null, limit: 10 })).toHaveLength(1);
      expect(() => f.database.prepare("DELETE FROM sandbox_execution_records").run()).toThrow(
        "cannot be deleted",
      );
    } finally {
      await f.close();
    }
  });
  it("rejects revoked authority at binding and keeps the reservation unbound", async () => {
    const f = await openSandboxJournal();
    try {
      call(f, "reserve", input(f));
      f.database
        .prepare(
          "UPDATE capability_handles SET revoked_at=?,record_json=json_set(record_json,'$.revokedAt',?) WHERE id=?",
        )
        .run(T1, T1, input(f).plan.handleRef);
      expect(() => call(f, "bindAndStart", binding(f))).toThrow();
      expect(call(f, "readAdmission", input(f).plan.identity)?.phase).toBe("reserved");
      expect(
        f.database.prepare("SELECT started_at FROM sandbox_execution_records").pluck().get(),
      ).toBeNull();
    } finally {
      await f.close();
    }
  });
  it("does not upgrade an existing unstarted v2 record into permission to launch", async () => {
    const f = await openSandboxJournal();
    try {
      const old = sandboxV2Call(f, "admit", sandboxV2Admission(f)).record;
      expect(call(f, "readAdmission", old.plan.identity)).toEqual({ phase: "bound", record: old });
      expect(() => call(f, "bindAndStart", binding(f))).toThrow("binding changed");
      expect(sandboxV2Call(f, "read", old.plan.identity)).toEqual(old);
    } finally {
      await f.close();
    }
  });
  it("rejects reservation mutation and binding that claims execution before start", async () => {
    const f = await openSandboxJournal();
    try {
      const first = input(f);
      call(f, "reserve", first);
      expect(() =>
        call(f, "reserve", {
          ...first,
          reservation: { ...first.reservation, environmentId: "another" },
        }),
      ).toThrow();
      const start = binding(f);
      expect(() =>
        call(f, "bindAndStart", {
          ...start,
          facts: sandboxExecutionFactsSchema.parse({
            ...start.facts,
            effect: { kind: "not_applicable" },
          }),
        }),
      ).toThrow("cannot assert execution");
      expect(call(f, "readAdmission", first.plan.identity)?.phase).toBe("reserved");
    } finally {
      await f.close();
    }
  });
});
