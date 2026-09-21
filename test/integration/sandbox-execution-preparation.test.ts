import type {
  SandboxExecutionAdmissionRecord,
  SandboxExecutionPreparationPort,
} from "@himawari-agent/application";
import {
  recoverSandboxExecutionsAtStartup,
  WorkerDelegationAdmissionService,
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
  T1,
  T2,
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

function reservationReleaseProof(admission: ReturnType<typeof reserved>) {
  return {
    schemaVersion: "sandbox-reservation-release.v1" as const,
    basis: "host_never_started" as const,
    identity: admission.plan.identity,
    environmentId: admission.plan.environmentId,
    semanticFingerprint: admission.plan.semanticFingerprint,
    stopRequestedAt: T1,
    checkedAt: T1,
    validUntil: new Date(Date.parse(T1) + 1000).toISOString(),
    processIdentityRef: "job-host-process:original",
    controlSessionId: "00000000-0000-4000-8000-000000000001",
    evidence: { ref: "protected-never-started-proof", digest: "a".repeat(64) },
  };
}

describe("atomic execution reservation and runtime binding", () => {
  it("fences a stopped reservation durably without fabricating release or execution", async () => {
    const f = await openSandboxJournal();
    try {
      const request = input(f);
      call(f, "reserve", request);
      const stop = {
        identity: request.plan.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
        reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN" as const,
      };
      const first = call(f, "interruptReservation", stop);
      expect(first.applied).toBe(true);
      expect(reserved(first.admission).recovery).toMatchObject({
        status: "unresolved",
        action: "stop",
        attempts: 0,
        finishedAt: T1,
      });
      expect(call(f, "interruptReservation", { ...stop, now: T2 })).toEqual({
        ...first,
        applied: false,
      });
      expect(() => call(f, "bindAndStart", binding(f))).toThrow("reservation stopped");
      expect(() =>
        f.database
          .prepare(
            "UPDATE sandbox_execution_records SET reservation_stopped_at=NULL WHERE job_id=?",
          )
          .run(stop.identity.jobId),
      ).toThrow("cannot be revoked");
      expect(() =>
        f.database
          .prepare(
            "UPDATE sandbox_execution_records SET preparation_state='bound',started_at=?,start_policy_digest=? WHERE job_id=?",
          )
          .run(T1, "9".repeat(64), stop.identity.jobId),
      ).toThrow("cannot bind");
      expect(
        f.database.prepare("SELECT count(*) FROM sandbox_release_receipts").pluck().get(),
      ).toBe(0);
      expect(
        f.database
          .prepare("SELECT count(*) FROM sandbox_execution_observations WHERE sequence>1")
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        f.database
          .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
          .pluck()
          .get(),
      ).toBe(request.workspaces.length);
      expect(() =>
        call(f, "interruptReservation", {
          ...stop,
          identity: { ...stop.identity, ownerId: "other" },
        }),
      ).toThrow();
    } finally {
      await f.close();
    }
  });

  it("returns a concurrent bound attempt for normal cleanup instead of overwriting it", async () => {
    const f = await openSandboxJournal();
    try {
      const request = input(f);
      call(f, "reserve", request);
      const bound = call(f, "bindAndStart", binding(f));
      expect(
        call(f, "interruptReservation", {
          identity: request.plan.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
        }),
      ).toEqual({ admission: { phase: "bound", record: bound.record }, applied: false });
      expect(call(f, "readAdmission", request.plan.identity)).toEqual({
        phase: "bound",
        record: bound.record,
      });
    } finally {
      await f.close();
    }
  });

  it("finds an unbound prior attempt at startup and keeps its start fence after reopening", async () => {
    const f = await openSandboxJournal();
    try {
      const request = input(f),
        start = binding(f);
      call(f, "reserve", request);
      f.database.close();
      let repo = await SqliteProductStateRepository.open({ stateRoot: f.resource.stateRoot });
      try {
        let preparations = repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
        expect(
          await recoverSandboxExecutionsAtStartup({
            preparations,
            journal: repo.sandboxExecutionJournal(OWNER_ID, AGENT_ID),
            authority: () => SERVICE_AUTHORITY,
            now: () => T1,
          }),
        ).toEqual({ examined: 1, quarantined: 1 });
        const first = await preparations.readAdmission(request.plan.identity);
        expect(first).toMatchObject({
          phase: "reserved",
          recovery: {
            status: "unresolved",
            reasonCode: "SANDBOX_PREVIOUS_BOOT_UNKNOWN",
            finishedAt: T1,
          },
        });
        await repo.close();
        repo = await SqliteProductStateRepository.open({ stateRoot: f.resource.stateRoot });
        preparations = repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
        expect(await preparations.readAdmission(request.plan.identity)).toEqual(first);
        expect(
          await recoverSandboxExecutionsAtStartup({
            preparations,
            journal: repo.sandboxExecutionJournal(OWNER_ID, AGENT_ID),
            authority: () => SERVICE_AUTHORITY,
            now: () => T1,
          }),
        ).toEqual({ examined: 1, quarantined: 0 });
        await expect(preparations.bindAndStart(start)).rejects.toThrow("reservation stopped");
        await expect(preparations.reserve(input(f, "-conflict"))).rejects.toThrow(
          "pending preparation",
        );
      } finally {
        await repo.close();
      }
    } finally {
      await f.close();
    }
  });

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

  it.each([
    "different",
    "same-slot",
    "same-inode",
    "atomic-read",
    "inplace-read",
    "directory-write",
  ] as const)("coordinates concrete file resources: %s", async (scenario) => {
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
      if (scenario === "inplace-read")
        first.workspaces.forEach((claim) => {
          claim.file.atomicPublish = false;
        });
      const second =
        scenario === "directory-write"
          ? input(f, "-b")
          : file(
              "-b",
              ["same-slot", "atomic-read", "inplace-read"].includes(scenario) ? "a.txt" : "b.txt",
              ["same-inode", "atomic-read", "inplace-read"].includes(scenario) ? "801" : "802",
              ["atomic-read", "inplace-read"].includes(scenario) ? "read" : "write",
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
  });
  it("reserves every directory move resource atomically and prevents descendant overtaking", async () => {
    const f = await openSandboxJournal();
    try {
      f.database
        .prepare("UPDATE capability_handles SET record_json=json_set(record_json, '$.maxUses', 10)")
        .run();
      const ancestor = { device: "1", inode: "100" };
      const moved = { device: "1", inode: "101" };
      const file = (suffix: string, name: string, child = true) => {
        const value = input(f, suffix);
        return {
          ...value,
          workspaces: value.workspaces.map((claim) => ({
            ...claim,
            lineage: child ? [ancestor, moved] : [ancestor],
            file: { name, identity: null, atomicPublish: true },
          })),
        };
      };
      const first = file("-first", "a.txt");
      const second = file("-second", "b.txt");
      const moving = input(f, "-moving");
      const base = moving.workspaces[0];
      if (!base) throw new Error("missing fixture workspace");
      const claims = [
        { ...base, ref: "move-tree", lineage: [ancestor, moved] },
        {
          ...base,
          ref: "move-source",
          lineage: [ancestor],
          file: { name: "reports", identity: moved, atomicPublish: false },
        },
        {
          ...base,
          ref: "move-destination",
          lineage: [ancestor],
          file: { name: "archive", identity: null, atomicPublish: false },
        },
      ];
      const move = {
        ...moving,
        workspaces: claims,
        reservation: { ...moving.reservation, workspaceConflictRefs: claims.map((c) => c.ref) },
      };
      const newer = file("-newer", "c.txt");
      const unrelated = file("-sibling", "sibling.txt", false);
      for (const request of [first, second, move, newer, unrelated]) call(f, "enqueue", request);
      expect(call(f, "reserve", first).applied).toBe(true);
      expect(call(f, "reserve", second).applied).toBe(true);
      expect(() => call(f, "reserve", move)).toThrow();
      expect(() => call(f, "reserve", newer)).toThrow("earlier conflicting request");
      expect(call(f, "reserve", unrelated).applied).toBe(true);
      expect(
        f.database.prepare("SELECT COUNT(*) FROM sandbox_workspace_occupancy").pluck().get(),
      ).toBe(3);
      for (const request of [first, second]) {
        const stopped = reserved(
          call(f, "interruptReservation", {
            identity: request.plan.identity,
            authority: SERVICE_AUTHORITY,
            now: T1,
            reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
          }).admission,
        );
        expect(
          call(f, "releaseReservation", {
            identity: request.plan.identity,
            authority: SERVICE_AUTHORITY,
            now: T1,
            verification: reservationReleaseProof(stopped),
          }).applied,
        ).toBe(true);
      }
      expect(call(f, "reserve", move).applied).toBe(true);
      expect(
        f.database
          .prepare("SELECT COUNT(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
          .pluck()
          .get(),
      ).toBe(4);
      expect(() => call(f, "reserve", newer)).toThrow();
    } finally {
      await f.close();
    }
  });

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
  it("reads one owner-scoped Run inventory without consuming queue or admission state", async () => {
    const f = await openSandboxJournal();
    try {
      const request = input(f);
      call(f, "enqueue", request);
      const read = () =>
        operationsForDatabase(f.database).execute(
          "capabilityInvocation.sandboxV2.readRunInventory",
          { ownerId: OWNER_ID, agentId: AGENT_ID, input: { runId: request.plan.identity.runId } },
        );
      const before = read();
      expect(before).toMatchObject({
        admissions: [],
        queue: [{ status: "queued", plan: request.plan }],
      });
      expect(read()).toEqual(before);
      expect(call(f, "readAdmission", request.plan.identity)).toBeUndefined();
      call(f, "reserve", request);
      expect(read()).toMatchObject({
        admissions: [{ phase: "reserved" }],
        queue: [{ status: "admitted" }],
      });
      call(f, "bindAndStart", binding(f));
      expect(read()).toMatchObject({
        admissions: [{ phase: "bound" }],
        queue: [{ status: "admitted" }],
      });
      expect(
        operationsForDatabase(f.database).execute(
          "capabilityInvocation.sandboxV2.readRunInventory",
          {
            ownerId: OWNER_ID,
            agentId: "other-agent",
            input: { runId: request.plan.identity.runId },
          },
        ),
      ).toEqual({ admissions: [], queue: [], legacyResourcesPending: false });
      f.database.close();
      const repo = await SqliteProductStateRepository.open({ stateRoot: f.resource.stateRoot });
      try {
        const snapshot = await repo
          .sandboxExecutionPreparations(OWNER_ID, AGENT_ID)
          .readRunInventory({ runId: request.plan.identity.runId });
        expect(snapshot).toMatchObject({
          admissions: [{ phase: "bound" }],
          queue: [{ status: "admitted" }],
        });
      } finally {
        await repo.close();
      }
    } finally {
      await f.close();
    }
  });

  it("does not hide an older sandbox obligation behind an empty v2 inventory", async () => {
    const f = await openSandboxJournal();
    try {
      f.prepare();
      expect(call(f, "readRunInventory", { runId: f.plan.identity.runId })).toEqual({
        admissions: [],
        queue: [],
        legacyResourcesPending: true,
      });
      expect(call(f, "readRunInventory", { runId: "other-run" })).toEqual({
        admissions: [],
        queue: [],
        legacyResourcesPending: false,
      });
    } finally {
      await f.close();
    }
  });

  it("retains cancelled queue history and rejects corrupted identities or truncated inventories", async () => {
    const f = await openSandboxJournal();
    try {
      const request = input(f);
      call(f, "enqueue", request);
      call(f, "cancelQueued", {
        identity: request.plan.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
      });
      const read = () => call(f, "readRunInventory", { runId: request.plan.identity.runId });
      expect(read()).toMatchObject({ admissions: [], queue: [{ status: "cancelled" }] });
      const original = f.database
        .prepare("SELECT request_json FROM sandbox_admission_queue")
        .get() as { request_json: string };
      const changed = JSON.parse(original.request_json);
      changed.plan.identity.agentId = "other-agent";
      // Fault injection bypasses the write guard to test independent corruption detection.
      // The binding tests separately verify that ordinary UPDATE is rejected.
      f.database.exec("DROP TRIGGER sandbox_queue_original_request_immutable");
      f.database
        .prepare("UPDATE sandbox_admission_queue SET request_json=?")
        .run(JSON.stringify(changed));
      expect(read).toThrow("SANDBOX_RUN_INVENTORY_SCOPE_MISMATCH");
      f.database
        .prepare("UPDATE sandbox_admission_queue SET request_json=?")
        .run(original.request_json);
      // Deliberately oversized test database: the reader must fail before returning a partial history.
      f.database.exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10000)
        INSERT INTO sandbox_admission_queue(job_id,owner_id,agent_id,run_id,host_id,handle_ref,deadline_at,status,request_json,claims_json)
        SELECT job_id || '-' || n,owner_id,agent_id,run_id,host_id,handle_ref,deadline_at,status,request_json,claims_json
        FROM sandbox_admission_queue, numbers WHERE sequence=1`);
      expect(read).toThrow("SANDBOX_RUN_INVENTORY_LIMIT");
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

it("releases stopped never-started reservations durably without manufacturing runtime facts", async () => {
  const f = await openSandboxJournal();
  try {
    const request = input(f);
    const admission = reserved(call(f, "reserve", request).admission);
    const stopped = reserved(
      call(f, "interruptReservation", {
        identity: admission.plan.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
        reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
      }).admission,
    );
    const verification = reservationReleaseProof(admission);
    const release = {
      identity: stopped.plan.identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      verification,
    };
    const accepted = call(f, "releaseReservation", release);
    expect(accepted.applied).toBe(true);
    expect(accepted.admission).toMatchObject({
      phase: "reserved",
      stopRequestedAt: T1,
      workspaceBlocked: false,
      releaseReceipt: { acceptedAt: T1, verification },
      recovery: { status: "resolved", reasonCode: "SANDBOX_RESERVATION_RELEASE_CONFIRMED" },
    });
    expect(call(f, "releaseReservation", { ...release, now: T2 })).toEqual({
      ...accepted,
      applied: false,
    });
    expect(() => call(f, "bindAndStart", binding(f))).toThrow("reservation stopped");
    expect(
      f.database.prepare("SELECT started_at FROM sandbox_execution_records").pluck().get(),
    ).toBeNull();
    expect(
      f.database
        .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
        .pluck()
        .get(),
    ).toBe(0);
    expect(f.database.prepare("SELECT count(*) FROM sandbox_release_receipts").pluck().get()).toBe(
      0,
    );
    expect(
      f.database
        .prepare("SELECT count(*) FROM sandbox_execution_observations WHERE sequence>1")
        .pluck()
        .get(),
    ).toBe(0);
    expect(() =>
      f.database.prepare("UPDATE sandbox_reservation_release_receipts SET accepted_at=?").run(T2),
    ).toThrow("immutable");
    f.database.close();
    const repo = await SqliteProductStateRepository.open({ stateRoot: f.resource.stateRoot });
    try {
      const preparations = repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
      expect(await preparations.readAdmission(admission.plan.identity)).toEqual(accepted.admission);
      expect(
        await recoverSandboxExecutionsAtStartup({
          preparations,
          journal: repo.sandboxExecutionJournal(OWNER_ID, AGENT_ID),
          authority: () => SERVICE_AUTHORITY,
          now: () => T2,
        }),
      ).toEqual({ examined: 1, quarantined: 0 });
      expect(await preparations.readAdmission(admission.plan.identity)).toEqual(accepted.admission);
      await expect(preparations.bindAndStart(binding(f))).rejects.toThrow("reservation stopped");
      expect((await preparations.reserve(input(f, "-after-release"))).applied).toBe(true);
    } finally {
      await repo.close();
    }
  } finally {
    await f.close();
  }
});

it.each([
  "not-stopped",
  "attempt",
  "intent",
  "stop-fence",
  "expired",
  "future",
  "evidence",
  "authority",
  "claim-write",
] as const)(
  "retains reservation protection when release verification fails: %s",
  async (scenario) => {
    const f = await openSandboxJournal();
    try {
      const admission = reserved(call(f, "reserve", input(f)).admission);
      if (scenario !== "not-stopped")
        call(f, "interruptReservation", {
          identity: admission.plan.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
        });
      const original = reservationReleaseProof(admission);
      const verification = {
        ...original,
        ...(scenario === "attempt"
          ? { identity: { ...original.identity, attemptId: "another-attempt" } }
          : {}),
        ...(scenario === "intent" ? { semanticFingerprint: "another-intent" } : {}),
        ...(scenario === "stop-fence" ? { stopRequestedAt: T2 } : {}),
        ...(scenario === "expired" ? { validUntil: T1 } : {}),
        ...(scenario === "future"
          ? { checkedAt: T2, validUntil: new Date(Date.parse(T2) + 1000).toISOString() }
          : {}),
        ...(scenario === "evidence" ? { evidence: { ref: "", digest: "invalid" } } : {}),
      };
      if (scenario === "claim-write")
        f.database.exec(
          "CREATE TRIGGER refuse_release BEFORE UPDATE OF released_at ON sandbox_workspace_occupancy BEGIN SELECT RAISE(ABORT, 'release storage failed'); END",
        );
      const authority =
        scenario === "authority"
          ? {
              ...SERVICE_AUTHORITY,
              product: { ...SERVICE_AUTHORITY.product, fencingToken: 999 },
            }
          : SERVICE_AUTHORITY;
      expect(() =>
        call(f, "releaseReservation", {
          identity: admission.plan.identity,
          authority,
          now: T1,
          verification,
        }),
      ).toThrow();
      expect(
        f.database
          .prepare("SELECT count(*) FROM sandbox_reservation_release_receipts")
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        f.database
          .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
          .pluck()
          .get(),
      ).toBeGreaterThan(0);
      expect(call(f, "readAdmission", admission.plan.identity)).toMatchObject({
        phase: "reserved",
      });
    } finally {
      await f.close();
    }
  },
);

describe("unadmitted queue authority binding", () => {
  it("retains the original queue snapshot and consumes only once after Worker boot changes", async () => {
    const f = await openSandboxJournal();
    try {
      const original = input(f);
      const position = call(f, "enqueue", original);
      expect(position.status).toBe("queued");
      expect(
        f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(0);
      expect(
        f.database.prepare("SELECT count(*) FROM sandbox_execution_records").pluck().get(),
      ).toBe(0);
      const saved = f.database
        .prepare("SELECT request_json FROM sandbox_admission_queue")
        .pluck()
        .get();
      const current = {
        ...original,
        invocation: {
          ...original.invocation,
          authority: { ...SERVICE_AUTHORITY, workerBootId: "worker-new-boot" },
        },
      };
      const rebound = call(f, "rebindQueued", { ...current, expectedBindingRevision: 0 });
      expect(rebound).toMatchObject({
        sequence: position.sequence,
        status: "queued",
        bindingRevision: 1,
      });
      expect(
        f.database.prepare("SELECT request_json FROM sandbox_admission_queue").pluck().get(),
      ).toBe(saved);
      expect(
        f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(0);
      expect(() => call(f, "reserve", original)).toThrow();
      expect(call(f, "reserve", current).applied).toBe(true);
      expect(call(f, "reserve", current).applied).toBe(false);
      expect(
        f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(1);
      expect(
        call(f, "readQueuedByInvocation", {
          runId: original.plan.identity.runId,
          invocationId: original.invocation.invocationId,
        }),
      ).toMatchObject({
        bindingRevision: 1,
        status: "admitted",
        sequence: position.sequence,
        plan: {
          requestedAt: original.plan.requestedAt,
          effectiveDeadlineAt: original.plan.effectiveDeadlineAt,
        },
      });
    } finally {
      await f.close();
    }
  });
  it.each(["cancelled", "admitted", "target", "deadline"])(
    "does not rebind %s queue inputs",
    async (state) => {
      const f = await openSandboxJournal();
      try {
        const original = input(f);
        call(f, "enqueue", original);
        if (state === "cancelled")
          call(f, "cancelQueued", {
            identity: original.plan.identity,
            authority: SERVICE_AUTHORITY,
            now: T1,
          });
        if (state === "admitted") call(f, "reserve", original);
        const current = {
          ...original,
          plan: {
            ...original.plan,
            ...(state === "target" ? { inputRef: "different-input" } : {}),
            ...(state === "deadline"
              ? {
                  effectiveDeadlineAt: new Date(
                    Date.parse(original.plan.effectiveDeadlineAt) + 1000,
                  ).toISOString(),
                }
              : {}),
          },
          invocation: {
            ...original.invocation,
            authority: { ...SERVICE_AUTHORITY, workerBootId: "worker-new-boot" },
          },
          expectedBindingRevision: 0,
        };
        if (state === "deadline")
          expect(current.plan.effectiveDeadlineAt).not.toBe(original.plan.effectiveDeadlineAt);
        expect(() => call(f, "rebindQueued", current)).toThrow();
      } finally {
        await f.close();
      }
    },
  );
});

it.each([
  "stale-cas",
  "stale-lease",
  "revoked",
  "expired",
  "used-handle",
  "storage-failure",
] as const)(
  "rejects queue rebind without changing the original Handle or queue: %s",
  async (scenario) => {
    const f = await openSandboxJournal();
    try {
      const original = input(f);
      call(f, "enqueue", original);
      if (scenario === "revoked")
        f.database
          .prepare(
            "UPDATE capability_handles SET revoked_at=?, record_json=json_set(record_json,'$.revokedAt',?) WHERE id=?",
          )
          .run(T1, T1, original.plan.handleRef);
      if (scenario === "used-handle")
        f.database
          .prepare(
            "UPDATE capability_handles SET record_json=json_set(record_json,'$.uses',1) WHERE id=?",
          )
          .run(original.plan.handleRef);
      if (scenario === "storage-failure")
        f.database.exec(
          "CREATE TRIGGER refuse_queue_binding BEFORE INSERT ON sandbox_queue_authority_bindings BEGIN SELECT RAISE(ABORT, 'binding storage failed'); END",
        );
      const handle = f.database
        .prepare("SELECT record_json FROM capability_handles WHERE id=?")
        .pluck()
        .get(original.plan.handleRef);
      const saved = f.database
        .prepare("SELECT request_json FROM sandbox_admission_queue")
        .pluck()
        .get();
      const current = {
        ...original,
        plan: {
          ...original.plan,
          ...(scenario === "stale-lease"
            ? { executionLease: { ...original.plan.executionLease, expectedLeaseRevision: 99 } }
            : {}),
        },
        invocation: {
          ...original.invocation,
          consumedAt: scenario === "expired" ? T2 : T1,
          authority: { ...SERVICE_AUTHORITY, workerBootId: "next-worker" },
        },
        expectedBindingRevision: scenario === "stale-cas" ? 1 : 0,
      };
      expect(() => call(f, "rebindQueued", current)).toThrow();
      expect(
        f.database
          .prepare("SELECT record_json FROM capability_handles WHERE id=?")
          .pluck()
          .get(original.plan.handleRef),
      ).toBe(handle);
      expect(
        f.database.prepare("SELECT request_json FROM sandbox_admission_queue").pluck().get(),
      ).toBe(saved);
      expect(
        f.database.prepare("SELECT count(*) FROM sandbox_queue_authority_bindings").pluck().get(),
      ).toBe(0);
      expect(
        f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it("retains the binding across database reopen and serializes competing rebinds", async () => {
  const f = await openSandboxJournal();
  try {
    const original = input(f);
    call(f, "enqueue", original);
    const current = {
      ...original,
      invocation: {
        ...original.invocation,
        authority: { ...SERVICE_AUTHORITY, workerBootId: "next-worker" },
      },
    };
    call(f, "rebindQueued", { ...current, expectedBindingRevision: 0 });
    expect(() =>
      f.database.prepare("UPDATE sandbox_queue_authority_bindings SET revision=2").run(),
    ).toThrow("immutable");
    expect(() =>
      f.database.prepare("UPDATE sandbox_admission_queue SET request_json=request_json").run(),
    ).toThrow("immutable");
    f.database.close();
    const repo = await SqliteProductStateRepository.open({ stateRoot: f.resource.stateRoot });
    try {
      const preparations = repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
      expect(
        await preparations.readQueuedByInvocation({
          runId: original.plan.identity.runId,
          invocationId: original.invocation.invocationId,
        }),
      ).toMatchObject({
        bindingRevision: 1,
        invocation: { authority: { workerBootId: "next-worker" } },
      });
      const attempt = {
        ...current,
        invocation: {
          ...current.invocation,
          authority: { ...SERVICE_AUTHORITY, workerBootId: "third-worker" },
        },
        expectedBindingRevision: 1,
      };
      const outcomes = await Promise.allSettled([
        preparations.rebindQueued(attempt),
        preparations.rebindQueued(attempt),
      ]);
      expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
      await expect(preparations.reserve(current)).rejects.toThrow("changed");
      expect((await preparations.reserve(attempt)).applied).toBe(true);
      expect((await preparations.reserve(attempt)).applied).toBe(false);
    } finally {
      await repo.close();
    }
  } finally {
    await f.close();
  }
});
