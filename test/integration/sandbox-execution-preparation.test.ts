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
