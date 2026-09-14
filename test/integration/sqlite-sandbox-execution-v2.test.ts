import path from "node:path";
import {
  type RunExecutionLeaseClaim,
  recoverSandboxExecutionsAtStartup,
  type SandboxExecutionJournalPort,
  type SandboxExecutionProjectionContext,
  SandboxExecutionReconciliationService,
  type SandboxExecutionRecord,
} from "@himawari-agent/application";
import { createIdempotencyKey, createRunId } from "@himawari-agent/domain";
import {
  type SandboxExecutionFacts,
  sandboxExecutionFactsSchema,
  sandboxExecutionPlanCandidateV2Schema,
} from "@himawari-agent/execution-contracts";
import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
  readMigrationLedger,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { describe, expect, it, vi } from "vitest";
import { createProductionSandboxToolResult } from "../../apps/agent-service/src/production-sandbox-tool-result.ts";
import {
  sandboxV2Admission as admission,
  sandboxV2Call as call,
} from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  outputObservation,
  outputPayload,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

type Fixture = Awaited<ReturnType<typeof openSandboxJournal>>;
const evidence = { ref: "supervision-evidence", digest: "e".repeat(64) };
function context(
  record: SandboxExecutionRecord,
  facts: SandboxExecutionFacts,
): SandboxExecutionProjectionContext {
  return {
    now: T1,
    environment: record.facts.environment,
    operationContract: record.plan.operationContract,
    verification: {
      facts,
      identity: record.plan.identity,
      environmentId: record.plan.environmentId,
      policyDigest: facts.environment.policyDigest,
      resourceSequence: facts.resource.sequence,
      checkedAt: T1,
      validUntil: T2,
      evidence: [evidence],
      outputs: facts.result && facts.result.kind !== "unknown" ? [facts.result.output] : [],
    },
    currentResourceSequence: facts.resource.sequence,
    runState: "active",
    currentAuthority: true,
    currentFence: true,
    userDisclosureAllowed: true,
    modelDisclosureAllowed: true,
    conflictingWorkspaceRisk: false,
    pendingApprovalOrReconciliation: false,
    resultAlreadyDelivered: false,
  };
}
function append(
  f: Fixture,
  record: SandboxExecutionRecord,
  facts: SandboxExecutionFacts,
  operationOnly = false,
) {
  return call(f, operationOnly ? "recordOperation" : "append", {
    identity: record.plan.identity,
    expectedSequence: record.facts.resource.sequence,
    expectedOperationRevision: record.operationRevision,
    facts,
    authority: SERVICE_AUTHORITY,
    now: T1,
    context: context(record, facts),
  }).record;
}
function resource(
  record: SandboxExecutionRecord,
  state: "controlled" | "stopping" | "lost" | "reconciling" | "released",
): SandboxExecutionFacts {
  const old = record.facts.resource;
  const { supervision: _supervision, cleanup: _cleanup, ...common } = old;
  const {
    evidence: _evidence,
    reasonCode: _reason,
    ...base
  } = common as typeof common & { evidence?: unknown; reasonCode?: string };
  const extra =
    state === "controlled" || state === "released"
      ? {
          evidence: {
            ...evidence,
            qualificationRef: record.plan.binding.qualificationRef,
            profileRef: record.plan.binding.profileRef,
            validUntil: T2,
            subject: { kind: "local_process", processIdentityRef: "process" },
          },
        }
      : { reasonCode: "requested" };
  return sandboxExecutionFactsSchema.parse({
    ...record.facts,
    resource: {
      ...base,
      ...extra,
      sequence: old.sequence + 1,
      supervision: state,
      cleanup: state === "released" ? "confirmed" : state === "lost" ? "unknown" : "pending",
    },
  });
}
function start(f: Fixture, a = admission(f)) {
  const record = call(f, "admit", a).record;
  call(f, "start", {
    identity: record.plan.identity,
    expectedSequence: 1,
    policyDigest: record.facts.environment.policyDigest,
    authority: SERVICE_AUTHORITY,
    now: T1,
  });
  return call(f, "read", record.plan.identity) as SandboxExecutionRecord;
}
function result(f: Fixture, record: SandboxExecutionRecord) {
  const output = { ref: "output", digest: "f".repeat(64), byteLength: 0 };
  operationsForDatabase(f.database).execute("capabilityInvocationResult.observeOutput", {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    input: outputObservation({ payload: outputPayload(output.ref, `sha256:${output.digest}`) }),
  });
  return sandboxExecutionFactsSchema.parse({
    ...record.facts,
    effect: { kind: "not_applicable" },
    result: {
      schemaVersion: "sandbox-execution.v2",
      identity: record.plan.identity,
      environmentId: record.plan.environmentId,
      policyDigest: record.facts.environment.policyDigest,
      contract: { ref: "fixed-read", version: "1" },
      occurredAt: T1,
      kind: "result",
      output,
      completion: { type: "value" },
    },
  });
}
describe.each(["worker", "direct"] as const)("SQLite component contracts (%s)", (execution) => {
  useSqliteContractExecution(execution);

  describe("R2 SQLite durable execution resources", () => {
    it("atomically consumes once, rejects changed replay and persists a single starting winner", async () => {
      const f = await openSandboxJournal();
      try {
        const a = admission(f);
        expect(call(f, "admit", a).applied).toBe(true);
        expect(call(f, "admit", a).applied).toBe(false);
        const record = call(f, "read", a.plan.identity) as SandboxExecutionRecord;
        const request = {
          identity: record.plan.identity,
          expectedSequence: 1,
          policyDigest: record.facts.environment.policyDigest,
          authority: SERVICE_AUTHORITY,
          now: T1,
        };
        expect(call(f, "start", request).applied).toBe(true);
        expect(call(f, "start", request).applied).toBe(false);
        expect(() => call(f, "start", { ...request, policyDigest: "0".repeat(64) })).toThrow(
          "policy",
        );
        expect(() =>
          call(f, "admit", {
            ...a,
            workspaces: a.workspaces.map((w) => ({ ...w, access: "read" })),
          }),
        ).toThrow("replay");
        expect(
          f.database.prepare("SELECT count(*) AS count FROM capability_invocation_receipts").get(),
        ).toEqual({ count: 1 });
        expect(f.database.pragma("foreign_key_check")).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it("rolls back Handle consumption, record and occupancy when initial observation fails", async () => {
      const f = await openSandboxJournal();
      try {
        f.database.exec(
          "CREATE TEMP TRIGGER fail_initial BEFORE INSERT ON sandbox_execution_observations BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
        );
        expect(() => call(f, "admit", admission(f))).toThrow("fixture failure");
        for (const table of [
          "capability_invocation_receipts",
          "sandbox_execution_records",
          "sandbox_workspace_occupancy",
        ])
          expect(f.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
            count: 0,
          });
        f.database.exec("DROP TRIGGER fail_initial");
        expect(call(f, "admit", admission(f)).applied).toBe(true);
      } finally {
        await f.close();
      }
    });
    it("blocks nested and aliased directories for a live writer, allows disjoint directories", async () => {
      const f = await openSandboxJournal();
      try {
        call(f, "admit", admission(f));
        const nested = admission(
          f,
          "-next",
          [
            { device: "1", inode: "1" },
            { device: "1", inode: "10" },
            { device: "1", inode: "11" },
          ],
          "read",
        );
        expect(() => call(f, "admit", nested)).toThrow("occupied");
        const alias = admission(f, "-next"); // Root labels cannot bypass filesystem identity.
        expect(() =>
          call(f, "admit", {
            ...alias,
            workspaces: alias.workspaces.map((w) => ({ ...w, canonicalRootId: "alias" })),
          }),
        ).toThrow("occupied");
        expect(
          call(
            f,
            "admit",
            admission(
              f,
              "-next",
              [
                { device: "1", inode: "1" },
                { device: "1", inode: "100" },
              ],
              "read",
            ),
          ).applied,
        ).toBe(true);
      } finally {
        await f.close();
      }
    });
    it("lost supervision quarantines intersecting reads", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f, admission(f, "", undefined, "read"));
        record = append(f, record, resource(record, "controlled"));
        record = append(f, record, resource(record, "lost"));
        expect(() => call(f, "admit", admission(f, "-next", undefined, "read"))).toThrow(
          "occupied",
        );
      } finally {
        await f.close();
      }
    });
    it("known output survives lost supervision; observation CAS and immutable results survive reopen", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "controlled"));
        record = append(f, record, result(f, record), true);
        const known = record.facts.result;
        const stale = record;
        record = append(f, record, resource(record, "lost"));
        expect(record.facts.result).toEqual(known);
        expect(() => append(f, stale, resource(stale, "stopping"))).toThrow();
        f.database.close();
        const repo = await SqliteProductStateRepository.open({
          stateRoot: f.resource.stateRoot,
          minimumFreeBytes: 0,
        });
        try {
          const journal = repo.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
          expect(await journal.read(record.plan.identity)).toMatchObject({
            facts: { result: known, resource: { supervision: "lost" } },
          });
          await expect(journal.admit(admission(f, "-next"))).rejects.toThrow("occupied");
          expect(await journal.listPending({ afterJobId: null, limit: 1 })).toHaveLength(1);
          expect(
            await journal.listPending({ afterJobId: record.plan.identity.jobId, limit: 1 }),
          ).toEqual([]);
        } finally {
          await repo.close();
        }
      } finally {
        await f.close();
      }
    });
    it("stores late operation evidence after release without fabricating resource transitions", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        expect(() => call(f, "admit", admission(f, "-next"))).toThrow("occupied");
        const sequence = record.facts.resource.sequence;
        const previous = record;
        const observed = result(f, record);
        record = append(f, record, observed, true);
        expect(append(f, previous, observed, true)).toEqual(record);
        expect(record.facts.resource.sequence).toBe(sequence);
        expect(record.operationRevision).toBe(1);
        expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toEqual([]);
        expect(call(f, "admit", admission(f, "-next")).applied).toBe(true);
      } finally {
        await f.close();
      }
    });
    it("restores occupancy if late effect evidence becomes uncertain after release", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, result(f, record), true);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        record = append(
          f,
          record,
          { ...record.facts, effect: { kind: "unknown", reasonCode: "late_evidence" } },
          true,
        );
        expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toHaveLength(1);
        expect(() => call(f, "admit", admission(f, "-next"))).toThrow("occupied");
      } finally {
        await f.close();
      }
    });
    it("Run cancellation blocks a prepared continuation but still permits cleanup observations", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "controlled"));
        record = append(f, record, result(f, record), true);
        const request = {
          identity: record.plan.identity,
          intentId: "continue-1",
          kind: "continue" as const,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          now: T1,
          context: context(record, record.facts),
        };
        expect(call(f, "prepareIntent", request)).toEqual({ applied: true });
        f.database
          .prepare("UPDATE runs SET status='cancelled' WHERE id=?")
          .run(record.plan.identity.runId);
        expect(() => call(f, "dispatchIntent", request)).toThrow();
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        expect(record.facts.result?.kind).toBe("result");
      } finally {
        await f.close();
      }
    });
    it("dispatch rechecks sequence, is at most once, and preserves post-dispatch uncertainty", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "controlled"));
        record = append(f, record, result(f, record), true);
        const request = {
          identity: record.plan.identity,
          intentId: "delivery",
          kind: "tool_result" as const,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          now: T1,
          context: context(record, record.facts),
        };
        call(f, "prepareIntent", request);
        expect(call(f, "dispatchIntent", request).applied).toBe(true);
        expect(call(f, "dispatchIntent", request).applied).toBe(false);
        call(f, "observeIntent", {
          identity: record.plan.identity,
          intentId: request.intentId,
          reasonCode: "transport_lost",
          authority: SERVICE_AUTHORITY,
          now: T1,
        });
        expect(() =>
          call(f, "prepareIntent", { ...request, intentId: "continue-2", kind: "continue" }),
        ).toThrow("uncertain");
        record = append(f, record, resource(record, "lost"));
        expect(record.facts.result?.kind).toBe("result");
      } finally {
        await f.close();
      }
    });
    it("keeps post-dispatch uncertainty pending after resource release", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "controlled"));
        record = append(f, record, result(f, record), true);
        const request = {
          identity: record.plan.identity,
          intentId: "inflight",
          kind: "continue" as const,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          now: T1,
          context: context(record, record.facts),
        };
        call(f, "prepareIntent", request);
        call(f, "dispatchIntent", request);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toHaveLength(1);
        expect(() => call(f, "admit", admission(f, "-next"))).toThrow("occupied");
        call(f, "acknowledgeIntent", {
          identity: record.plan.identity,
          intentId: "inflight",
          authority: SERVICE_AUTHORITY,
          now: T1,
          context: context(record, record.facts),
        });
        expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toEqual([]);
        expect(call(f, "admit", admission(f, "-next")).applied).toBe(true);
      } finally {
        await f.close();
      }
    });
    it("v1 unknown and missing journals never acquire v2 execution authority", async () => {
      const f = await openSandboxJournal();
      try {
        f.prepare();
        expect(() => call(f, "admit", admission(f, "-next"))).toThrow("Legacy");
        expect(() => f.database.prepare("DELETE FROM sandbox_jobs").run()).toThrow(
          "Unresolved legacy",
        );
      } finally {
        await f.close();
      }
      const consumed = await openSandboxJournal(true);
      try {
        expect(() => call(consumed, "admit", admission(consumed))).toThrow("without journal");
      } finally {
        await consumed.close();
      }
    });
    it.each(["background", "service"] as const)(
      "persists %s creator, environment and resource handle in the admission transaction",
      async (mode) => {
        const f = await openSandboxJournal();
        try {
          const a = admission(f);
          const contract =
            mode === "background"
              ? { ref: "task-create", version: "1", kind: "task_start" }
              : {
                  ref: "service-create",
                  version: "1",
                  kind: "service_start",
                  readinessProbeRef: "ready",
                };
          const plan = sandboxExecutionPlanCandidateV2Schema.parse({
            ...a.plan,
            mode,
            operationContract: contract,
          });
          const facts = sandboxExecutionFactsSchema.parse({
            ...a.facts,
            environment: { ...a.facts.environment, mode, resourceRef: "resource" },
            resource: {
              ...a.facts.resource,
              resourceRef: "resource",
              status:
                mode === "background"
                  ? { kind: "task", state: "starting" }
                  : { kind: "service", readiness: "starting" },
            },
          });
          const record = call(f, "admit", { ...a, plan, facts }).record;
          expect(record.facts.environment.creator).toEqual(record.plan.identity);
          expect(
            f.database
              .prepare(
                "SELECT environment_id,resource_ref,invocation_id FROM sandbox_execution_records",
              )
              .get(),
          ).toEqual({
            environment_id: plan.environmentId,
            resource_ref: "resource",
            invocation_id: plan.identity.invocationId,
          });
          expect(call(f, "admit", { ...a, plan, facts }).applied).toBe(false);
          // Exercise the SQLite completion transaction independently of RunCoordinator:
          // a resource admitted after its last enumeration must still block completion.
          f.database.prepare("UPDATE runs SET revision=1 WHERE id=?").run(plan.identity.runId);
          const reopened = await SqliteProductStateRepository.open({
            stateRoot: f.resource.stateRoot,
            minimumFreeBytes: 0,
            now: () => T1,
          });
          try {
            const runs = reopened.runLifecycle(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY.product);
            await expect(
              runs.completeRun({
                ownerId: OWNER_ID,
                agentId: AGENT_ID,
                runId: createRunId(plan.identity.runId),
                expectedRevision: 1,
                idempotencyKey: createIdempotencyKey("r6-completion"),
                commandFingerprint: "r6-completion",
                authority: SERVICE_AUTHORITY.lease,
                executionLease: plan.executionLease as RunExecutionLeaseClaim,
                payloadRef: "payload-capability-invocation-trigger",
                output: { kind: "no-answer" },
                dataClassification: "private",
              }),
            ).rejects.toMatchObject({
              code: "PORT_CONFLICT",
              message: "Run still owns unreleased sandbox resources",
            });
            await expect(runs.readRun(createRunId(plan.identity.runId))).resolves.toMatchObject({
              revision: 1,
              run: { status: "running" },
            });
          } finally {
            await reopened.close();
          }
        } finally {
          await f.close();
        }
      },
    );
    it("permits intersecting live readers and rejects a subsequent writer", async () => {
      const f = await openSandboxJournal();
      try {
        call(f, "admit", admission(f, "", undefined, "read"));
        expect(call(f, "admit", admission(f, "-next", undefined, "read")).applied).toBe(true);
        expect(() =>
          call(f, "start", {
            identity: admission(f).plan.identity,
            expectedSequence: 1,
            policyDigest: "d".repeat(64),
            authority: SERVICE_AUTHORITY,
            now: T1,
          }),
        ).not.toThrow();
      } finally {
        await f.close();
      }
    });
    it("rejects a legacy Worker bypass and protects unresolved rows from cascading deletion", async () => {
      const f = await openSandboxJournal();
      try {
        call(f, "admit", admission(f, "-next"));
        expect(() => f.prepare()).toThrow("v2 workspace occupancy");
        expect(() =>
          f.database.prepare("DELETE FROM runs WHERE id=?").run(f.plan.identity.runId),
        ).toThrow("Unresolved sandbox");
        expect(
          f.database.prepare("SELECT count(*) FROM sandbox_workspace_occupancy").pluck().get(),
        ).toBe(1);
      } finally {
        await f.close();
      }
    });
    it("rejects forged supervision and output references without changing either history", async () => {
      const f = await openSandboxJournal();
      try {
        const record = start(f);
        const facts = resource(record, "controlled");
        expect(() =>
          call(f, "append", {
            identity: record.plan.identity,
            expectedSequence: 1,
            expectedOperationRevision: 0,
            facts,
            authority: SERVICE_AUTHORITY,
            now: T1,
            context: { ...context(record, facts), verification: null },
          }),
        ).toThrow();
        const forged = result(f, record);
        const knownResult = forged.result;
        if (knownResult?.kind !== "result") throw new Error("fixture result missing");
        expect(() =>
          append(
            f,
            record,
            {
              ...forged,
              result: { ...knownResult, output: { ...knownResult.output, ref: "unbound" } },
            },
            true,
          ),
        ).toThrow("durably bound");
        expect(call(f, "read", record.plan.identity)?.facts).toEqual(record.facts);
      } finally {
        await f.close();
      }
    });
    it("does not freeze an unverified effect claim as confirmed business evidence", async () => {
      const f = await openSandboxJournal();
      try {
        const a = admission(f);
        const contract = {
          ref: "verified-operation",
          version: "1",
          kind: "verified_effect" as const,
          verifierRef: "verifier",
          verifierVersion: "1",
          targetRef: "target",
        };
        const record = start(f, { ...a, plan: { ...a.plan, operationContract: contract } });
        const observed = result(f, record);
        const known = observed.result;
        if (known?.kind !== "result") throw new Error("fixture result missing");
        const effect = {
          kind: "verified" as const,
          verifierRef: "verifier",
          verifierVersion: "1",
          targetRef: "target",
          evidence: { ref: "effect-proof", digest: "a".repeat(64) },
          occurredAt: T1,
        };
        const facts = {
          ...observed,
          result: { ...known, contract: { ref: contract.ref, version: contract.version } },
          effect,
        };
        expect(() => append(f, record, facts, true)).toThrow("effect evidence");
        const verified = context(record, facts);
        if (!verified.verification) throw new Error("fixture verification missing");
        expect(
          call(f, "recordOperation", {
            identity: record.plan.identity,
            expectedSequence: 1,
            expectedOperationRevision: 0,
            facts,
            authority: SERVICE_AUTHORITY,
            now: T1,
            context: {
              ...verified,
              verification: { ...verified.verification, evidence: [evidence, effect.evidence] },
            },
          }).record.facts.effect,
        ).toEqual(effect);
      } finally {
        await f.close();
      }
    });
    it("rechecks resource sequence and execution fence before dispatch", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "controlled"));
        record = append(f, record, result(f, record), true);
        const request = {
          identity: record.plan.identity,
          intentId: "prepared",
          kind: "continue" as const,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          now: T1,
          context: context(record, record.facts),
        };
        call(f, "prepareIntent", request);
        record = append(f, record, resource(record, "controlled"));
        expect(() => call(f, "dispatchIntent", request)).toThrow("sequence");
        const next = {
          ...request,
          intentId: "fenced",
          expectedSequence: record.facts.resource.sequence,
          context: context(record, record.facts),
        };
        call(f, "prepareIntent", next);
        f.database.prepare("UPDATE run_execution_leases SET revision=revision+1").run();
        expect(() => call(f, "dispatchIntent", next)).toThrow();
        expect(
          f.database
            .prepare(
              "SELECT count(*) FROM sandbox_execution_intents WHERE dispatched_at IS NOT NULL",
            )
            .pluck()
            .get(),
        ).toBe(0);
      } finally {
        await f.close();
      }
    });
    it("serializes concurrent journal requests and rejects a competing state-root owner", async () => {
      const f = await openSandboxJournal();
      try {
        const record = call(f, "admit", admission(f)).record;
        f.database.close();
        const left = await SqliteProductStateRepository.open({
          stateRoot: f.resource.stateRoot,
          minimumFreeBytes: 0,
        });

        try {
          await expect(
            SqliteProductStateRepository.open({
              stateRoot: f.resource.stateRoot,
              minimumFreeBytes: 0,
            }),
          ).rejects.toThrow("already owned");
          const journals = [left, left].map((r) => r.sandboxExecutionJournal(OWNER_ID, AGENT_ID));
          const starts = await Promise.all(
            journals.map((j) =>
              j.start({
                identity: record.plan.identity,
                expectedSequence: 1,
                policyDigest: record.facts.environment.policyDigest,
                authority: SERVICE_AUTHORITY,
                now: T1,
              }),
            ),
          );
          expect(starts.map((s) => s.applied).sort()).toEqual([false, true]);
          const states = ["controlled", "stopping"] as const;
          const writes = await Promise.allSettled(
            journals.map((j, i) => {
              const facts = resource(record, states[i] ?? "stopping");
              return j.append({
                identity: record.plan.identity,
                expectedSequence: 1,
                expectedOperationRevision: 0,
                facts,
                authority: SERVICE_AUTHORITY,
                now: T1,
                context: context(record, facts),
              });
            }),
          );
          expect(writes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
          expect(writes.filter((r) => r.status === "rejected")).toHaveLength(1);
        } finally {
          await left.close();
        }
      } finally {
        await f.close();
      }
    });
    it.each([
      "prepared",
      "starting",
      "quarantined",
      "completed",
      "failed",
      "missing_host",
      "missing_state",
    ])("upgrades populated schema 27 without reinterpreting %s history", async (state) => {
      const f = await openSandboxJournal();
      let old: ReturnType<typeof openQualifiedDatabase> | undefined;
      try {
        f.prepare();
        const migrations = await loadBundledMigrations();
        old = openQualifiedDatabase(path.join(f.resource.stateRoot, "legacy.sqlite"));
        applyMigrations(old, migrations.slice(0, 27));
        // Copy only this test's seeded data into the actual old schema; never drop a migration.
        old.pragma("foreign_keys = OFF");
        const tables = old
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
          )
          .all() as { name: string }[];
        for (const { name } of tables) {
          if ((old.prepare(`SELECT count(*) FROM "${name}"`).pluck().get() as number) > 0) continue;
          const rows = f.database.prepare(`SELECT * FROM "${name}"`).all() as Record<
            string,
            unknown
          >[];
          for (const row of rows) {
            const oldColumns = new Set(
              (old.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
                (column) => column.name,
              ),
            );
            const columns = Object.keys(row).filter((column) => oldColumns.has(column));
            old
              .prepare(
                `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
              )
              .run(...columns.map((column) => row[column]));
          }
        }
        old.pragma("foreign_keys = ON");
        const observation = {
          ...f.prepared,
          state,
          cleanup: state === "completed" || state === "failed" ? "confirmed" : "unknown",
        };
        const plan = JSON.parse(JSON.stringify(f.plan));
        if (state === "missing_host") delete plan.identity.hostId;
        const rawObservation: Record<string, unknown> = { ...observation };
        if (state === "missing_state") delete rawObservation["state"];
        old
          .prepare("UPDATE sandbox_jobs SET plan_json=?,observation_json=?")
          .run(JSON.stringify(plan), JSON.stringify(rawObservation));
        const before = old.prepare("SELECT * FROM sandbox_jobs").all();
        const ledger = readMigrationLedger(old);
        const snapshot = await createVerifiedMigrationSnapshot(
          old,
          path.join(f.resource.stateRoot, "legacy-snapshot.sqlite"),
        );
        expect(applyMigrations(old, migrations, { snapshot }).appliedSequences).toEqual([
          28, 29, 30, 31, 32,
        ]);
        expect(readMigrationLedger(old).slice(0, 27)).toEqual(ledger);
        expect(old.prepare("SELECT * FROM sandbox_jobs").all()).toEqual(before);
        expect(old.prepare("SELECT count(*) FROM sandbox_execution_records").pluck().get()).toBe(0);
        const terminal = state === "completed" || state === "failed";
        expect(
          old
            .prepare("SELECT count(*) FROM sandbox_legacy_occupancy WHERE released_at IS NULL")
            .pluck()
            .get(),
        ).toBe(terminal ? 0 : 1);
        if (state === "missing_host")
          expect(
            old.prepare("SELECT host_id FROM sandbox_legacy_occupancy").pluck().get(),
          ).toBeNull();
        const invoke = () =>
          operationsForDatabase(old as NonNullable<typeof old>).execute(
            "capabilityInvocation.sandboxV2.admit",
            { ownerId: OWNER_ID, agentId: AGENT_ID, input: admission(f, "-next") },
          );
        if (terminal) expect(invoke).not.toThrow();
        else expect(invoke).toThrow("Legacy");
        expect(old.pragma("foreign_key_check")).toEqual([]);
      } finally {
        old?.close();
        await f.close();
      }
    });
  });

  // Characterizes the R1/R2 contract conflict found while composing R3. This is
  // negative evidence, not an acceptance test for the proposed preparation protocol.
  it("records why current v2 cannot bind a policy first compiled after admission", async () => {
    const f = await openSandboxJournal();
    try {
      const input = admission(f);
      expect(() =>
        sandboxExecutionFactsSchema.parse({
          ...input.facts,
          environment: { ...input.facts.environment, policyDigest: null },
        }),
      ).toThrow();
      const saved = call(f, "admit", input).record;
      expect(() =>
        call(f, "start", {
          identity: saved.plan.identity,
          expectedSequence: 1,
          policyDigest: "9".repeat(64),
          authority: SERVICE_AUTHORITY,
          now: T1,
        }),
      ).toThrow("Start policy differs");
      expect(call(f, "read", saved.plan.identity)?.startedAt).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("v2 startup invalidates previous supervision durably without replay or erasing known output", async () => {
    const f = await openSandboxJournal();
    const recoveryAuthority = {
      ...SERVICE_AUTHORITY,
      agentServiceBootId: "recovery-agent-boot",
      workerBootId: "recovery-worker-boot",
    };
    try {
      let record = start(f);
      record = append(f, record, result(f, record), true);
      record = append(f, record, resource(record, "controlled"));
      const continuation = {
        identity: record.plan.identity,
        intentId: "before-restart",
        kind: "continue" as const,
        expectedSequence: record.facts.resource.sequence,
        authority: SERVICE_AUTHORITY,
        now: T1,
        context: context(record, record.facts),
      };
      call(f, "prepareIntent", continuation);
      f.database.close();
      let repo = await SqliteProductStateRepository.open({
        stateRoot: f.resource.stateRoot,
        minimumFreeBytes: 0,
      });
      try {
        let journal = repo.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
        expect(
          await recoverSandboxExecutionsAtStartup({
            journal,
            authority: () => recoveryAuthority,
            now: () => T1,
          }),
        ).toEqual({ examined: 1, quarantined: 1 });
        const lost = await journal.read(record.plan.identity);
        expect(lost?.facts.result).toEqual(record.facts.result);
        expect(lost?.facts.effect).toEqual(record.facts.effect);
        expect(lost?.facts.resource.supervision).toBe("lost");
        expect(lost?.facts.resource.sequence).toBe(record.facts.resource.sequence + 1);
        await expect(journal.admit(admission(f, "-blocked"))).rejects.toThrow("occupied");
        await expect(journal.dispatchIntent(continuation)).rejects.toThrow();
        expect(
          (
            await journal.admit(
              admission(f, "-independent", [
                { device: "1", inode: "1" },
                { device: "1", inode: "20" },
              ]),
            )
          ).applied,
        ).toBe(true);
        await repo.close();
        repo = await SqliteProductStateRepository.open({
          stateRoot: f.resource.stateRoot,
          minimumFreeBytes: 0,
        });
        journal = repo.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
        expect(
          await recoverSandboxExecutionsAtStartup({
            journal,
            authority: () => recoveryAuthority,
            now: () => T1,
          }),
        ).toEqual({ examined: 2, quarantined: 1 });
        expect((await journal.read(record.plan.identity))?.facts).toEqual(lost?.facts);
      } finally {
        await repo.close();
      }
    } finally {
      await f.close();
    }
  });

  for (const scenario of ["verified", "untrusted", "timeout", "concurrent"] as const) {
    it(`reconciliation ${scenario} preserves operation facts and only releases verified risk`, async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, result(f, record), true);
        record = append(f, record, resource(record, "lost"));
        let stops = 0;
        const service = new SandboxExecutionReconciliationService({
          hostId: record.plan.identity.hostId,
          journal: {
            read: async (identity) => call(f, "read", identity),
            append: async (input) => call(f, "append", input),
          },
          now: () => T1,
          timeoutMs: scenario === "timeout" ? 10 : 1000,
          evidence: {
            verify: async ({ facts }) => {
              const proof = context(record, facts).verification;
              if (!proof) throw new Error("missing fixture proof");
              return scenario === "untrusted" ? { ...proof, evidence: [] } : proof;
            },
          },
          backend: {
            inspect: async () => {
              throw new Error("unused");
            },
            stop: async (current, signal) => {
              stops++;
              if (scenario === "timeout") {
                await new Promise((resolve) => setTimeout(resolve, 30));
                expect(signal.aborted).toBe(true);
              }
              return resource(current, "released").resource;
            },
          },
        });
        const request = {
          identity: record.plan.identity,
          expectedSequence: record.facts.resource.sequence,
          authority: { ...SERVICE_AUTHORITY, workerBootId: "current-reconciler" },
          action: "stop" as const,
        };
        const requests =
          scenario === "concurrent"
            ? [service.reconcile(request), service.reconcile(request)]
            : [service.reconcile(request)];
        await Promise.allSettled(requests);
        expect(stops).toBe(1);
        const final = call(f, "read", record.plan.identity);
        expect(final?.facts.result).toEqual(record.facts.result);
        expect(final?.facts.effect).toEqual(record.facts.effect);
        const released = scenario === "verified" || scenario === "concurrent";
        expect(final?.facts.resource.supervision).toBe(released ? "released" : "lost");
        if (released) expect(call(f, "admit", admission(f, "-after-reconcile")).applied).toBe(true);
        else expect(() => call(f, "admit", admission(f, "-after-reconcile"))).toThrow("occupied");
        if (scenario === "timeout") {
          await new Promise((resolve) => setTimeout(resolve, 40));
          expect(call(f, "read", record.plan.identity)?.facts.resource).toEqual(
            final?.facts.resource,
          );
        }
      } finally {
        await f.close();
      }
    });
  }

  // Actual SQLite intents and output bindings; platform verification is synthetic.
  it.each(["deliver", "cancel-before-dispatch", "receipt-fails", "expired-proof"] as const)(
    "Agent foreground result handoff: %s",
    async (scenario) => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, result(f, record), true);
        record = append(f, record, resource(record, "lost"));
        record = append(f, record, resource(record, "reconciling"));
        record = append(f, record, resource(record, "released"));
        const identity = record.plan.identity;
        const journal = Object.fromEntries(
          [
            "read",
            "append",
            "prepareIntent",
            "dispatchIntent",
            "acknowledgeIntent",
            "observeIntent",
          ].map((name) => [
            name,
            async (input: never) => call(f, name as keyof SandboxExecutionJournalPort, input),
          ]),
        ) as unknown as SandboxExecutionJournalPort;
        const complete = createProductionSandboxToolResult({
          journal,
          preparations: {
            readAdmissionByInvocation: async () => ({
              phase: "bound",
              record: call(f, "read", identity) as SandboxExecutionRecord,
            }),
          },
          authority: () => SERVICE_AUTHORITY,
          now: () => (scenario === "expired-proof" ? T2 : T1),
          verifyFresh: async (current) => {
            const facts = resource(current, "released");
            const proof = context(current, facts).verification;
            if (!proof) throw new Error("missing synthetic evidence");
            return proof;
          },
        });
        let checks = 0;
        const receipt = vi.fn(async () => {
          if (scenario === "receipt-fails") throw new Error("receipt unavailable");
        });
        const delivery = {
          assertDisclosure: async () => {
            if (++checks === 3 && scenario === "cancel-before-dispatch")
              f.database
                .prepare("UPDATE runs SET status='cancelled' WHERE id=?")
                .run(identity.runId);
          },
          saveReceipt: receipt,
        };
        const request = { runId: identity.runId, invocationId: identity.invocationId };
        if (scenario === "deliver") {
          expect(await complete(request, delivery)).toMatchObject({
            outcome: "succeeded",
            outputRef: "output",
          });
          expect(receipt).toHaveBeenCalledTimes(1);
          expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toEqual([]);
          await expect(complete(request, delivery)).rejects.toThrow();
          expect(receipt).toHaveBeenCalledTimes(1);
        } else if (scenario === "expired-proof") {
          expect(await complete(request, delivery)).toBeUndefined();
          expect(receipt).not.toHaveBeenCalled();
        } else {
          await expect(complete(request, delivery)).rejects.toThrow();
          if (scenario === "cancel-before-dispatch") expect(receipt).not.toHaveBeenCalled();
          else expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toHaveLength(1);
        }
      } finally {
        await f.close();
      }
    },
  );

  it.each(["subject", "metrics", "revive"])(
    "released proof renewal rejects changed %s",
    async (change) => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, result(f, record), true);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        const fresh = resource(record, "released");
        if (fresh.resource.supervision !== "released") throw new Error("released fixture required");
        const changed = sandboxExecutionFactsSchema.parse({
          ...fresh,
          resource: {
            ...fresh.resource,
            ...(change === "subject"
              ? {
                  evidence: {
                    ...fresh.resource.evidence,
                    subject: { kind: "local_process", processIdentityRef: "replacement" },
                  },
                }
              : {}),
            ...(change === "metrics"
              ? { metrics: { samples: 1, cpuTimeMs: 10, peakMemoryBytes: 20 } }
              : {}),
            ...(change === "revive" ? { supervision: "controlled", cleanup: "pending" } : {}),
          },
        });
        expect(() => append(f, record, changed)).toThrow();
      } finally {
        await f.close();
      }
    },
  );
});
