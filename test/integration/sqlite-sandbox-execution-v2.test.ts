import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type RunExecutionLeaseClaim,
  recoverSandboxExecutionsAtStartup,
  type SandboxExecutionJournalPort,
  type SandboxExecutionProjectionContext,
  SandboxExecutionReconciliationService,
  type SandboxExecutionRecord,
  type SandboxExecutionRunInventory,
} from "@himawari-agent/application";
import { createIdempotencyKey, createRunId } from "@himawari-agent/domain";
import {
  type SandboxExecutionFacts,
  sandboxExecutionFactsSchema,
  sandboxExecutionPlanCandidateV2Schema,
} from "@himawari-agent/execution-contracts";
import {
  applyMigrations,
  assertWritableSchema,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
  readMigrationLedger,
  SqliteProductStateRepository,
  SqliteUnconfirmedSandboxPurge,
} from "@himawari-agent/persistence-sqlite";
import { describe, expect, it, vi } from "vitest";
import { createProductionSandboxToolResult } from "../../apps/agent-service/src/production-sandbox-tool-result.ts";
import { readThreadExecutionEnvironment } from "../../packages/application/src/services/thread-execution-environment.ts";
import { readThreadExecutionResources } from "../../packages/application/src/services/thread-execution-resources.ts";
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
const execFile = promisify(execFileCallback);
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
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
function freshObservation(
  record: SandboxExecutionRecord,
  facts: SandboxExecutionFacts,
  now: string,
) {
  const proof = context(record, facts);
  if (!proof.verification) throw new Error("test verification missing");
  return {
    identity: record.plan.identity,
    expectedSequence: record.facts.resource.sequence,
    expectedOperationRevision: record.operationRevision,
    facts,
    authority: SERVICE_AUTHORITY,
    now,
    context: { ...proof, now, verification: { ...proof.verification, checkedAt: now } },
  };
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
function readRunInventory(f: Fixture, runId: string) {
  return operationsForDatabase(f.database).execute(
    "capabilityInvocation.sandboxV2.readRunInventory",
    { ownerId: OWNER_ID, agentId: AGENT_ID, input: { runId } },
  ) as SandboxExecutionRunInventory;
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
async function assertCompletionBlocked(f: Fixture, plan: ReturnType<typeof admission>["plan"]) {
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
}
describe.each(["worker", "direct"] as const)("SQLite component contracts (%s)", (execution) => {
  useSqliteContractExecution(execution);

  describe("R2 SQLite durable execution resources", () => {
    it.each([-1, 0, 11, 151])(
      "keeps release after result ACK at evidence expiry %i ms",
      async (delay) => {
        const f = await openSandboxJournal();
        try {
          let record = start(f);
          record = append(f, record, result(f, record), true);
          record = append(f, record, resource(record, "stopping"));
          const facts = resource(record, "released");
          if (facts.resource.supervision !== "released") throw new Error("release required");
          const expiresAt = new Date(Date.parse(T1) + 1000).toISOString();
          const released = {
            ...facts,
            resource: {
              ...facts.resource,
              evidence: { ...facts.resource.evidence, validUntil: expiresAt },
            },
          };
          record = append(f, record, released);
          const readOccupancy = () =>
            f.database
              .prepare(
                "SELECT released_at AS releasedAt FROM sandbox_workspace_occupancy WHERE job_id=?",
              )
              .get(record.plan.identity.jobId) as { releasedAt: string | null };
          expect(readOccupancy().releasedAt).toBe(T1);
          const request = {
            identity: record.plan.identity,
            intentId: "p0-delivery",
            kind: "tool_result" as const,
            expectedSequence: record.facts.resource.sequence,
            authority: SERVICE_AUTHORITY,
            now: T1,
            context: context(record, record.facts),
          };
          call(f, "prepareIntent", request);
          expect(call(f, "dispatchIntent", request).applied).toBe(true);
          const afterDispatch = readOccupancy();
          expect(afterDispatch.releasedAt).toBe(T1);
          const ackAt = new Date(Date.parse(expiresAt) + delay).toISOString();
          call(f, "acknowledgeIntent", {
            identity: request.identity,
            intentId: request.intentId,
            authority: SERVICE_AUTHORITY,
            now: ackAt,
            context: request.context,
          });
          call(f, "acknowledgeIntent", {
            identity: request.identity,
            intentId: request.intentId,
            authority: SERVICE_AUTHORITY,
            now: ackAt,
            context: request.context,
          });
          const current = call(f, "read", request.identity) as SandboxExecutionRecord;
          expect(current.facts.resource.supervision).toBe("released");
          expect(current.facts.resource.cleanup).toBe("confirmed");
          expect(
            f.database
              .prepare(
                "SELECT count(*) AS count FROM sandbox_execution_intents WHERE acknowledged_at IS NULL",
              )
              .get(),
          ).toEqual({ count: 0 });
          const pending = call(f, "listPending", { afterJobId: null, limit: 10 });
          let conflict = "";
          try {
            call(f, "admit", admission(f, "-next"));
          } catch (error) {
            conflict = String(error);
          }
          expect(pending).toEqual([]);
          expect(readOccupancy().releasedAt).toBe(T1);
          expect(conflict).toBe("");
        } finally {
          await f.close();
        }
      },
    );
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
        // Cleanup is independent of whether the read result has arrived.
        expect(record.releaseReceipt?.acceptedAt).toBe(T1);
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
    it.each([0, 1])(
      "protects a fresh contradictory resource observation at +%sms without revoking release",
      async (offset) => {
        const f = await openSandboxJournal();
        try {
          let record = start(f);
          record = append(f, record, result(f, record), true);
          record = append(f, record, resource(record, "stopping"));
          record = append(f, record, resource(record, "released"));
          const released = structuredClone(record);
          const now = new Date(Date.parse(T1) + offset).toISOString();
          const facts = resource(record, "controlled");
          const observed = { ...facts, resource: { ...facts.resource, occurredAt: now } };
          const input = freshObservation(record, observed, now);
          record = call(f, "append", input).record;
          expect(record.facts).toEqual(released.facts);
          expect(record.releaseReceipt).toEqual(released.releaseReceipt);
          expect(record.workspaceBlocked).toBe(true);
          expect(record.recovery).toMatchObject({
            status: "unresolved",
            owner: SERVICE_AUTHORITY.agentServiceBootId,
            reasonCode: "SANDBOX_RELEASE_CONTRADICTED",
          });
          expect(() =>
            call(f, "prepareIntent", {
              identity: record.plan.identity,
              intentId: "after-incident",
              kind: "continue",
              expectedSequence: record.facts.resource.sequence,
              authority: SERVICE_AUTHORITY,
              now,
              context: context(record, record.facts),
            }),
          ).toThrow("Resource incident remains unresolved");
          expect(() =>
            f.database
              .prepare("UPDATE sandbox_workspace_barriers SET resolved_at=? WHERE job_id=?")
              .run(now, record.plan.identity.jobId),
          ).toThrow("Resource incident evidence is immutable");
          expect(call(f, "append", input).applied).toBe(false);
          expect(() => call(f, "admit", admission(f, "-next"))).toThrow("occupied");
          expect(
            call(
              f,
              "admit",
              admission(f, "-unrelated", [
                { device: "1", inode: "1" },
                { device: "1", inode: "90" },
              ]),
            ).applied,
          ).toBe(true);

          expect(
            f.database
              .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
              .get(record.plan.identity.jobId),
          ).toEqual({ released_at: T1 });
          expect(
            f.database
              .prepare(
                "SELECT kind,reason_code FROM sandbox_workspace_barriers WHERE job_id=? AND resolved_at IS NULL",
              )
              .all(record.plan.identity.jobId),
          ).toEqual([
            { kind: "resource_contradiction", reason_code: "SANDBOX_RELEASE_CONTRADICTED" },
          ]);
        } finally {
          await f.close();
        }
      },
    );
    it("records verified new risk after the original execution permission expires", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        const now = new Date(Date.parse(T2) + 1).toISOString();
        const until = new Date(Date.parse(T2) + 1000).toISOString();
        const risk = resource(record, "controlled");
        if (risk.resource.supervision !== "controlled") throw new Error("test state");
        const facts = {
          ...risk,
          resource: {
            ...risk.resource,
            occurredAt: now,
            evidence: { ...risk.resource.evidence, validUntil: until },
          },
        };
        const input = freshObservation(record, facts, now);
        const protectedRecord = call(f, "append", {
          ...input,
          context: {
            ...input.context,
            verification: { ...input.context.verification, validUntil: until },
          },
        }).record;
        expect(protectedRecord.workspaceBlocked).toBe(true);
        expect(protectedRecord.facts).toEqual(record.facts);
        expect(protectedRecord.releaseReceipt).toEqual(record.releaseReceipt);
        expect(() =>
          call(f, "start", {
            identity: record.plan.identity,
            expectedSequence: record.facts.resource.sequence,
            policyDigest: record.facts.environment.policyDigest,
            authority: SERVICE_AUTHORITY,
            now,
          }),
        ).toThrow();
      } finally {
        await f.close();
      }
    });
    it("protects contradiction observed after release even when receipt acceptance was delayed", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "stopping"));
        const at = (ms: number) => new Date(Date.parse(T1) + ms).toISOString();
        record = call(
          f,
          "append",
          freshObservation(record, resource(record, "released"), at(10)),
        ).record;
        expect(record.releaseReceipt?.acceptedAt).toBe(at(10));
        const risk = resource(record, "controlled");
        const facts = { ...risk, resource: { ...risk.resource, occurredAt: at(5) } };
        const updated = call(f, "append", freshObservation(record, facts, at(11))).record;
        expect(updated.workspaceBlocked).toBe(true);
        expect(updated.facts).toEqual(record.facts);
        expect(updated.releaseReceipt).toEqual(record.releaseReceipt);
      } finally {
        await f.close();
      }
    });
    it("keeps an incident across reopen and only clears it with newer stop evidence", async () => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        const receipt = record.releaseReceipt;
        const at = (ms: number) => new Date(Date.parse(T1) + ms).toISOString();
        const risk = resource(record, "controlled");
        const request = freshObservation(
          record,
          { ...risk, resource: { ...risk.resource, occurredAt: at(1) } },
          at(1),
        );
        record = call(f, "append", request).record;
        f.database.close();
        const repo = await SqliteProductStateRepository.open({
          stateRoot: f.resource.stateRoot,
          minimumFreeBytes: 0,
        });
        try {
          const journal = repo.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
          expect(await journal.read(record.plan.identity)).toMatchObject({
            workspaceBlocked: true,
            releaseReceipt: receipt,
          });
          await expect(journal.admit(admission(f, "-next"))).rejects.toThrow("occupied");
          expect(await journal.listPending({ afterJobId: null, limit: 10 })).toHaveLength(1);
          const oldStop = resource(record, "released");
          record = (await journal.append(freshObservation(record, oldStop, at(2)))).record;
          expect(record.workspaceBlocked).toBe(true);
          const service = new SandboxExecutionReconciliationService({
            hostId: record.plan.identity.hostId,
            journal,
            timeoutMs: 100,
            now: () => at(3),
            evidence: {
              verify: async ({ plan, facts, now }) =>
                freshObservation({ ...record, plan }, facts, now).context.verification,
            },
            backend: {
              inspect: async () => {
                throw new Error("stop required");
              },
              stop: async (current) => {
                const stopped = resource(current, "released");
                return { ...stopped.resource, occurredAt: at(3) };
              },
            },
          });
          record = (
            await service.reconcile({
              identity: record.plan.identity,
              expectedSequence: record.facts.resource.sequence,
              authority: SERVICE_AUTHORITY,
              action: "stop",
            })
          ).record;
          expect(record.recovery?.status).toBe("resolved");
          expect(record.workspaceBlocked).toBe(false);
          expect(record.releaseReceipt).toEqual(receipt);
          expect((await journal.admit(admission(f, "-next"))).applied).toBe(true);
        } finally {
          await repo.close();
        }
      } finally {
        await f.close();
      }
    });
    it.each([
      "missing-proof",
      "expired-proof",
      "wrong-subject",
      "stale",
      "future",
      "changed-effect",
    ] as const)("does not create a resource incident from %s evidence", async (scenario) => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        const now = new Date(Date.parse(T1) + 1).toISOString();
        const risk = resource(record, "controlled");
        if (risk.resource.supervision !== "controlled") throw new Error("test state");
        const facts = {
          ...risk,
          ...(scenario === "changed-effect" ? { effect: { kind: "not_applicable" as const } } : {}),
          resource: {
            ...risk.resource,
            occurredAt:
              scenario === "stale"
                ? new Date(Date.parse(T1) - 1).toISOString()
                : scenario === "future"
                  ? T2
                  : now,
            evidence: {
              ...risk.resource.evidence,
              ...(scenario === "wrong-subject"
                ? {
                    subject: {
                      kind: "local_process" as const,
                      processIdentityRef: "other-process",
                    },
                  }
                : {}),
            },
          },
        };
        const input = freshObservation(record, facts, now);
        const verification =
          scenario === "missing-proof"
            ? null
            : {
                ...input.context.verification,
                ...(scenario === "expired-proof" ? { validUntil: now } : {}),
              };
        expect(() =>
          call(f, "append", { ...input, context: { ...input.context, verification } }),
        ).toThrow();
        expect(call(f, "read", record.plan.identity)).toEqual(record);
        expect(call(f, "admit", admission(f, "-next")).applied).toBe(true);
      } finally {
        await f.close();
      }
    });
    it("preserves schema 41 protections and release facts when adding resource incidents", async () => {
      const f = await openSandboxJournal();
      let old: ReturnType<typeof openQualifiedDatabase> | undefined;
      try {
        let record = start(f);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        f.database
          .prepare(
            "INSERT INTO sandbox_workspace_barriers(job_id,barrier_id,kind,reason_code,created_at) VALUES(?,'intent:legacy','control_unacknowledged','SANDBOX_CONTROL_ACK_PENDING',?)",
          )
          .run(record.plan.identity.jobId, T1);
        const migrations = await loadBundledMigrations();
        old = openQualifiedDatabase(path.join(f.resource.stateRoot, "schema41.sqlite"));
        applyMigrations(old, migrations.slice(0, 41));
        old.pragma("foreign_keys = OFF");
        const tables = old
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'",
          )
          .all() as { name: string }[];
        for (const { name } of tables) {
          if ((old.prepare(`SELECT count(*) FROM "${name}"`).pluck().get() as number) > 0) continue;
          const columns = (
            old.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
          ).map((c) => c.name);
          for (const row of f.database.prepare(`SELECT * FROM "${name}"`).all() as Record<
            string,
            unknown
          >[]) {
            old
              .prepare(
                `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
              )
              .run(...columns.map((c) => row[c]));
          }
        }
        old.pragma("foreign_keys = ON");
        const receipts = old.prepare("SELECT * FROM sandbox_release_receipts").all();
        const claims = old.prepare("SELECT * FROM sandbox_workspace_occupancy").all();
        const barriers = old.prepare("SELECT * FROM sandbox_workspace_barriers").all();
        const before = readMigrationLedger(old);
        const snapshot = await createVerifiedMigrationSnapshot(
          old,
          path.join(f.resource.stateRoot, "schema41-snapshot.sqlite"),
        );
        expect(applyMigrations(old, migrations.slice(0, 42), { snapshot })).toEqual({
          appliedSequences: [42],
          currentSequence: 42,
        });
        expect(readMigrationLedger(old).slice(0, 41)).toEqual(before);
        expect(old.prepare("SELECT * FROM sandbox_release_receipts").all()).toEqual(receipts);
        expect(old.prepare("SELECT * FROM sandbox_workspace_occupancy").all()).toEqual(claims);
        expect(
          old
            .prepare(
              "SELECT job_id,barrier_id,kind,reason_code,created_at,resolved_at FROM sandbox_workspace_barriers",
            )
            .all(),
        ).toEqual(barriers);
        expect(
          old
            .prepare(
              "SELECT count(*) FROM sandbox_workspace_barriers WHERE kind='resource_contradiction'",
            )
            .pluck()
            .get(),
        ).toBe(0);
        expect(old.pragma("foreign_key_check")).toEqual([]);
        expect(() => assertWritableSchema(old as NonNullable<typeof old>, 41)).toThrow();
        expect(() =>
          old
            ?.prepare("DELETE FROM sandbox_execution_records WHERE job_id=?")
            .run(record.plan.identity.jobId),
        ).toThrow("Unresolved sandbox barrier");
      } finally {
        old?.close();
        await f.close();
      }
    });
    it("does not turn generic effect uncertainty into a new workspace lock", async () => {
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
        expect(
          f.database
            .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
            .get(record.plan.identity.jobId),
        ).toEqual({ released_at: T1 });
        expect(
          f.database
            .prepare(
              "SELECT kind, reason_code FROM sandbox_workspace_barriers WHERE job_id=? AND resolved_at IS NULL",
            )
            .all(record.plan.identity.jobId),
        ).toEqual([]);
        expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toHaveLength(1);
        expect(call(f, "admit", admission(f, "-next")).applied).toBe(true);
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
    it.each(["foreground", "background", "service"] as const)(
      "persists %s creator, environment and resource handle in the admission transaction",
      async (mode) => {
        const f = await openSandboxJournal();
        try {
          const a = admission(f);
          const contract =
            mode === "foreground"
              ? a.plan.operationContract
              : mode === "background"
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
          const resourceRef = mode === "foreground" ? null : "resource";
          const facts = sandboxExecutionFactsSchema.parse({
            ...a.facts,
            environment: { ...a.facts.environment, mode, resourceRef },
            resource: {
              ...a.facts.resource,
              resourceRef,
              status:
                mode === "foreground"
                  ? { kind: "foreground" }
                  : mode === "background"
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
            resource_ref: resourceRef,
            invocation_id: plan.identity.invocationId,
          });
          expect(call(f, "admit", { ...a, plan, facts }).applied).toBe(false);
          // Exercise the SQLite completion transaction independently of RunCoordinator:
          // a resource admitted after its last enumeration must still block completion.
          await assertCompletionBlocked(f, plan);
        } finally {
          await f.close();
        }
      },
    );
    it.each(["queued", "reserved", "released-incident"] as const)(
      "blocks final completion with %s resources in the same transaction",
      async (phase) => {
        const f = await openSandboxJournal();
        try {
          const a = admission(f);
          if (phase === "released-incident") {
            let record = start(f, a);
            record = append(f, record, resource(record, "stopping"));
            record = append(f, record, resource(record, "released"));
            const receipt = record.releaseReceipt;
            record = call(
              f,
              "append",
              freshObservation(record, resource(record, "controlled"), T1),
            ).record;
            expect(record.releaseReceipt).toEqual(receipt);
            expect(record.workspaceBlocked).toBe(true);
          } else {
            operationsForDatabase(f.database).execute(
              `capabilityInvocation.sandboxV2.${phase === "queued" ? "enqueue" : "reserve"}`,
              {
                ownerId: OWNER_ID,
                agentId: AGENT_ID,
                input: {
                  plan: a.plan,
                  invocation: a.invocation,
                  workspaces: a.workspaces,
                  reservation: {
                    schemaVersion: "sandbox-preparation.v1",
                    identity: a.plan.identity,
                    environmentId: a.plan.environmentId,
                    resourceRef: null,
                    mode: a.plan.mode,
                    workspaceConflictRefs: a.workspaces.map((item) => item.ref),
                    sequence: 1,
                    createdAt: a.plan.requestedAt,
                  },
                },
              },
            );
          }
          await assertCompletionBlocked(f, a.plan);
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
          28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
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
            preparations: repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID),
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
            preparations: repo.sandboxExecutionPreparations(OWNER_ID, AGENT_ID),
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

  for (const scenario of [
    "verified",
    "untrusted",
    "timeout",
    "evidence-timeout",
    "concurrent",
  ] as const) {
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
            beginRecovery: async (input) => call(f, "beginRecovery", input),
            finishRecovery: async (input) => call(f, "finishRecovery", input),
          },
          now: () => T1,
          timeoutMs: scenario.endsWith("timeout") ? 10 : 1000,
          evidence: {
            verify: async ({ facts }) => {
              if (scenario === "evidence-timeout")
                await new Promise((resolve) => setTimeout(resolve, 30));
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
        if (scenario.endsWith("timeout")) {
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

  it.each(["lost", "released"] as const)(
    "ignores late %s observations after recovery timeout without verification or writes",
    async (state) => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "lost"));
        const pending = deferred<ReturnType<typeof resource>["resource"]>();
        const entered = deferred<SandboxExecutionRecord>();
        const verify = vi.fn(async ({ facts }: { facts: SandboxExecutionFacts }) => {
          const proof = context(record, facts).verification;
          if (!proof) throw new Error("fixture proof missing");
          return proof;
        });
        const writes = vi.fn(async (input: Parameters<SandboxExecutionJournalPort["append"]>[0]) =>
          call(f, "append", input),
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const service = new SandboxExecutionReconciliationService({
          hostId: record.plan.identity.hostId,
          journal: {
            read: async (identity) => call(f, "read", identity),
            append: writes,
            beginRecovery: async (input) => call(f, "beginRecovery", input),
            finishRecovery: async (input) => call(f, "finishRecovery", input),
          },
          evidence: { verify },
          now: () => T1,
          timeoutMs: 10,
          backend: {
            inspect: async (current) => {
              entered.resolve(current);
              return pending.promise;
            },
            stop: async () => {
              throw new Error("unexpected stop");
            },
          },
        });
        const request = service.reconcile({
          identity: record.plan.identity,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          action: "inspect",
        });
        const current = await entered.promise;
        await vi.advanceTimersByTimeAsync(10);
        const finished = await request;
        expect(finished.record.recovery).toMatchObject({
          status: "unresolved",
          reasonCode: "SANDBOX_RECONCILIATION_TIMED_OUT",
        });
        const count = writes.mock.calls.length;
        pending.resolve(resource(current, state).resource);
        await vi.advanceTimersByTimeAsync(0);
        expect(writes).toHaveBeenCalledTimes(count);
        expect(verify).not.toHaveBeenCalled();
        expect(call(f, "read", record.plan.identity)).toEqual(finished.record);
        expect(() => call(f, "admit", admission(f, "-still-blocked"))).toThrow("occupied");
      } finally {
        vi.useRealTimers();
        await f.close();
      }
    },
  );

  it("fences recovery writes when another attempt takes ownership before the SQL transaction", async () => {
    const f = await openSandboxJournal();
    try {
      let record = start(f);
      record = append(f, record, resource(record, "lost"));
      let now = T1;
      let successor: SandboxExecutionRecord | undefined;
      const service = new SandboxExecutionReconciliationService({
        hostId: record.plan.identity.hostId,
        journal: {
          read: async (identity) => call(f, "read", identity),
          append: async (input) => {
            if (input.facts.resource.supervision === "released") {
              now = new Date(Date.parse(T1) + 1000).toISOString();
              call(f, "beginRecovery", {
                identity: record.plan.identity,
                expectedSequence: input.expectedSequence,
                authority: SERVICE_AUTHORITY,
                now,
                action: "inspect",
                deadlineAt: new Date(Date.parse(now) + 1000).toISOString(),
              });
              successor = call(f, "read", record.plan.identity);
            }
            return call(f, "append", input);
          },
          beginRecovery: async (input) => call(f, "beginRecovery", input),
          finishRecovery: async (input) => call(f, "finishRecovery", input),
        },
        evidence: {
          verify: async ({ facts }) => {
            const proof = context(record, facts).verification;
            if (!proof) throw new Error("fixture proof missing");
            return proof;
          },
        },
        now: () => now,
        timeoutMs: 1000,
        backend: {
          inspect: async (current) => resource(current, "released").resource,
          stop: async () => {
            throw new Error("unexpected stop");
          },
        },
      });
      const outcome = await Promise.allSettled([
        service.reconcile({
          identity: record.plan.identity,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          action: "inspect",
        }),
      ]);
      expect(successor?.recovery).toMatchObject({ status: "running", attempts: 2 });
      expect(call(f, "read", record.plan.identity)).toEqual(successor);
      expect(() => call(f, "admit", admission(f, "-still-blocked"))).toThrow("occupied");
      expect(outcome[0]).toMatchObject({
        status: "rejected",
        reason: { message: "SANDBOX_RECONCILIATION_OWNERSHIP_CHANGED" },
      });
    } finally {
      await f.close();
    }
  });

  it.each([
    ["SANDBOX_CONTROL_DIRECTORY_CHANGED", "SANDBOX_CONTROL_DIRECTORY_CHANGED"],
    ["SANDBOX_CONTROL_IDENTITY_CHANGED", "SANDBOX_CONTROL_IDENTITY_CHANGED"],
    ["SANDBOX_CONTROL_BINDING_UNAVAILABLE", "SANDBOX_CONTROL_BINDING_UNAVAILABLE"],
    ["SANDBOX_CONTROL_EVIDENCE_CHANGED", "SANDBOX_CONTROL_EVIDENCE_CHANGED"],
    ["SANDBOX_HOST_UNAVAILABLE", "SANDBOX_HOST_UNAVAILABLE"],
    ["private backend diagnostic", "SANDBOX_RECONCILIATION_UNCONFIRMED"],
    ["SANDBOX_PRIVATE_SECRET", "SANDBOX_RECONCILIATION_UNCONFIRMED"],
    ["EACCES", "SANDBOX_RECONCILIATION_PERMISSION_DENIED"],
    ["EPERM", "SANDBOX_RECONCILIATION_PERMISSION_DENIED"],
    ["ECONNREFUSED", "SANDBOX_SUPERVISOR_UNAVAILABLE"],
    ["ETIMEDOUT", "SANDBOX_CONTROL_TIMED_OUT"],
    ["JOB_HOST_CONTROL_TIMEOUT", "SANDBOX_CONTROL_TIMED_OUT"],
    ["JOB_HOST_CONTROL_EVIDENCE_INVALID", "SANDBOX_CONTROL_EVIDENCE_INVALID"],
    ["lost:SANDBOX_CONTROL_UNCONFIRMED", "SANDBOX_CONTROL_UNCONFIRMED"],
    ["lost:SANDBOX_HOST_UNAVAILABLE", "SANDBOX_HOST_UNAVAILABLE"],
    ["lost:SANDBOX_PRIVATE_SECRET", "SANDBOX_RECONCILIATION_UNCONFIRMED"],
  ])("retains safe bounded recovery failure %s", async (message, expected) => {
    const f = await openSandboxJournal();
    try {
      const record = start(f);
      const inspect = vi.fn(async (current: SandboxExecutionRecord) => {
        if (message.startsWith("lost:")) {
          return { ...resource(current, "lost").resource, reasonCode: message.slice(5) };
        }
        if (["EACCES", "EPERM", "ECONNREFUSED", "ETIMEDOUT"].includes(message))
          throw Object.assign(new Error("private path and diagnostic"), { code: message });
        throw new Error(message);
      });
      const service = new SandboxExecutionReconciliationService({
        hostId: record.plan.identity.hostId,
        journal: {
          read: async (identity) => call(f, "read", identity),
          append: async (input) => call(f, "append", input),
          beginRecovery: async (input) => call(f, "beginRecovery", input),
          finishRecovery: async (input) => call(f, "finishRecovery", input),
        },
        evidence: {
          verify: async () => {
            throw new Error("unexpected verification");
          },
        },
        now: () => T1,
        timeoutMs: 1000,
        backend: { inspect, stop: inspect },
      });
      await service.reconcile({
        identity: record.plan.identity,
        expectedSequence: record.facts.resource.sequence,
        authority: SERVICE_AUTHORITY,
        action: "inspect",
      });
      const persisted = call(f, "read", record.plan.identity);
      expect(persisted?.recovery).toMatchObject({
        status: "unresolved",
        reasonCode: expected,
        attempts: 1,
        finishedAt: T1,
      });
      expect(persisted?.facts.resource).toMatchObject({
        supervision: "lost",
        reasonCode: expected,
      });
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(() => call(f, "admit", admission(f, "-still-blocked"))).toThrow("occupied");
    } finally {
      await f.close();
    }
  });

  it.each(["preparation-deadline", "concurrent-result", "concurrent-release"] as const)(
    "finishes bounded recovery using current durable facts: %s",
    async (scenario) => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, resource(record, "lost"));
        let now = T1;
        let concurrent: SandboxExecutionRecord | undefined;
        const inspect = vi.fn(async (current: SandboxExecutionRecord) => {
          concurrent = append(f, current, result(f, current), true);
          if (scenario === "concurrent-release")
            concurrent = append(f, concurrent, resource(concurrent, "released"));
          throw new Error("private backend diagnostic must not become a reason code");
        });
        const service = new SandboxExecutionReconciliationService({
          hostId: record.plan.identity.hostId,
          journal: {
            read: async (identity) => call(f, "read", identity),
            append: async (input) => {
              const mutation = call(f, "append", input);
              if (scenario === "preparation-deadline")
                now = new Date(Date.parse(T1) + 1000).toISOString();
              return mutation;
            },
            beginRecovery: async (input) => call(f, "beginRecovery", input),
            finishRecovery: async (input) => call(f, "finishRecovery", input),
          },
          evidence: {
            verify: async () => {
              throw new Error("unexpected verification");
            },
          },
          now: () => now,
          timeoutMs: 1000,
          backend: { inspect, stop: inspect },
        });
        const finished = await service.reconcile({
          identity: record.plan.identity,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          action: "inspect",
        });
        expect(finished.record.recovery?.status).toBe(
          scenario === "concurrent-release" ? "resolved" : "unresolved",
        );
        if (scenario === "preparation-deadline") {
          expect(inspect).not.toHaveBeenCalled();
          expect(finished.record.recovery?.reasonCode).toBe("SANDBOX_RECONCILIATION_TIMED_OUT");
        } else {
          expect(finished.record.facts.result).toEqual(concurrent?.facts.result);
          expect(finished.record.facts.effect).toEqual(concurrent?.facts.effect);
          expect(finished.record.recovery?.reasonCode).not.toContain("private");
        }
        if (scenario === "concurrent-release") {
          expect(finished.record.releaseReceipt).toEqual(concurrent?.releaseReceipt);
          expect(finished.record.recovery?.reasonCode).toBe("SANDBOX_RECONCILIATION_CONFIRMED");
          expect(call(f, "admit", admission(f, "-released")).applied).toBe(true);
        } else {
          expect(() => call(f, "admit", admission(f, "-still-blocked"))).toThrow("occupied");
        }
      } finally {
        await f.close();
      }
    },
  );

  it.each(["revision", "owner", "finished", "deadline"] as const)(
    "rejects stale recovery proof through the repository port: %s",
    async (scenario) => {
      const f = await openSandboxJournal();
      let repository: SqliteProductStateRepository | undefined;
      try {
        let record = start(f);
        record = append(f, record, resource(record, "lost"));
        f.database.close();
        repository = await SqliteProductStateRepository.open({
          stateRoot: f.resource.stateRoot,
          minimumFreeBytes: 0,
        });
        let journal = repository.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
        const recovery = await journal.beginRecovery({
          identity: record.plan.identity,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          now: T1,
          action: "inspect",
          deadlineAt: new Date(Date.parse(T1) + 1000).toISOString(),
        });
        if (scenario === "finished")
          await journal.finishRecovery({
            identity: record.plan.identity,
            expectedSequence: record.facts.resource.sequence,
            expectedRecoveryRevision: recovery.revision,
            authority: SERVICE_AUTHORITY,
            now: T1,
            reasonCode: "SANDBOX_RECONCILIATION_UNCONFIRMED",
          });
        const before = await journal.read(record.plan.identity);
        const facts = resource(record, "released");
        await expect(
          journal.append({
            identity: record.plan.identity,
            expectedSequence: record.facts.resource.sequence,
            expectedOperationRevision: record.operationRevision,
            expectedRecoveryRevision:
              scenario === "revision" ? recovery.revision + 1 : recovery.revision,
            authority:
              scenario === "owner"
                ? { ...SERVICE_AUTHORITY, agentServiceBootId: "other-recovery" }
                : SERVICE_AUTHORITY,
            now: scenario === "deadline" ? recovery.deadlineAt : T1,
            facts,
            context: context(record, facts),
          }),
        ).rejects.toThrow(
          scenario === "deadline" ? "Recovery deadline elapsed" : "Recovery ownership changed",
        );
        await repository.close();
        repository = await SqliteProductStateRepository.open({
          stateRoot: f.resource.stateRoot,
          minimumFreeBytes: 0,
        });
        journal = repository.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
        expect(await journal.read(record.plan.identity)).toEqual(before);
      } finally {
        await repository?.close();
        await f.close();
      }
    },
  );

  it.each(["fresh", "expired", "changed"] as const)(
    "commits a single host observation with %s proof without repeating verification",
    async (scenario) => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, result(f, record), true);
        record = append(f, record, resource(record, "lost"));
        const repeated = vi.fn(async () => {
          throw new Error("must not repeat host audit");
        });
        const observeVerified = vi.fn(async (current: SandboxExecutionRecord) => {
          const facts = resource(current, "released");
          const proof = context(current, facts).verification;
          if (!proof) throw new Error("missing fixture proof");
          return scenario === "expired"
            ? { ...proof, validUntil: T1 }
            : scenario === "changed"
              ? { ...proof, facts: { ...facts, result: null } }
              : proof;
        });
        const service = new SandboxExecutionReconciliationService({
          hostId: record.plan.identity.hostId,
          journal: {
            read: async (identity) => call(f, "read", identity),
            append: async (input) => call(f, "append", input),
            beginRecovery: async (input) => call(f, "beginRecovery", input),
            finishRecovery: async (input) => call(f, "finishRecovery", input),
          },
          now: () => T1,
          timeoutMs: 1000,
          evidence: { verify: repeated },
          backend: { observeVerified, inspect: repeated, stop: repeated },
        });
        const reconciled = await service.reconcile({
          identity: record.plan.identity,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          action: "inspect",
        });
        expect(observeVerified).toHaveBeenCalledTimes(1);
        expect(repeated).not.toHaveBeenCalled();
        expect(reconciled.record.workspaceBlocked).toBe(scenario !== "fresh");
        expect(reconciled.record.facts.result).toEqual(record.facts.result);
        expect(Boolean(reconciled.record.releaseReceipt)).toBe(scenario === "fresh");
        expect(call(f, "read", record.plan.identity)).toEqual(reconciled.record);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["verified", "expired", "unavailable"] as const)(
    "recovers legacy released occupancy with %s evidence",
    async (scenario) => {
      const f = await openSandboxJournal();
      try {
        let record = start(f);
        record = append(f, record, result(f, record), true);
        record = append(f, record, resource(record, "stopping"));
        record = append(f, record, resource(record, "released"));
        // Construct the schema-32 failure image inside this isolated fixture.
        const trigger = f.database
          .prepare("SELECT sql FROM sqlite_master WHERE name='sandbox_occupancy_release_monotonic'")
          .pluck()
          .get() as string;
        f.database.exec("DROP TRIGGER sandbox_occupancy_release_monotonic");
        f.database
          .prepare("DELETE FROM sandbox_release_receipts WHERE job_id=?")
          .run(record.plan.identity.jobId);
        f.database
          .prepare("UPDATE sandbox_workspace_occupancy SET released_at=NULL WHERE job_id=?")
          .run(record.plan.identity.jobId);
        f.database.exec(trigger);
        expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toHaveLength(1);
        const journal = {
          read: async (identity: SandboxExecutionRecord["plan"]["identity"]) =>
            call(f, "read", identity),
          append: async (input: Parameters<SandboxExecutionJournalPort["append"]>[0]) =>
            call(f, "append", input),
          beginRecovery: async (
            input: Parameters<SandboxExecutionJournalPort["beginRecovery"]>[0],
          ) => call(f, "beginRecovery", input),
          finishRecovery: async (
            input: Parameters<SandboxExecutionJournalPort["finishRecovery"]>[0],
          ) => call(f, "finishRecovery", input),
        };
        const backend = {
          inspect: vi.fn(
            async (current: SandboxExecutionRecord) => resource(current, "released").resource,
          ),
          stop: vi.fn(async () => {
            throw new Error("must not stop released resource");
          }),
        };
        const service = new SandboxExecutionReconciliationService({
          hostId: record.plan.identity.hostId,
          journal,
          now: () => T1,
          timeoutMs: 1000,
          evidence: {
            verify: async ({ facts }) => {
              const proof = context(record, facts).verification;
              if (!proof) throw new Error("fixture proof");
              return scenario === "expired" ? { ...proof, validUntil: T1 } : proof;
            },
          },
          ...(scenario === "unavailable" ? {} : { backend }),
        });
        await service.reconcile({
          identity: record.plan.identity,
          expectedSequence: record.facts.resource.sequence,
          authority: SERVICE_AUTHORITY,
          action: "inspect",
        });
        const final = call(f, "read", record.plan.identity);
        expect(final?.facts.resource.supervision).toBe("released");
        expect(final?.facts.result).toEqual(record.facts.result);
        expect(final?.recovery).toMatchObject({
          status: scenario === "verified" ? "resolved" : "unresolved",
          attempts: 1,
          owner: SERVICE_AUTHORITY.agentServiceBootId,
          finishedAt: T1,
        });
        expect(backend.stop).not.toHaveBeenCalled();
        if (scenario === "verified") {
          expect(final?.releaseReceipt?.acceptedAt).toBe(T1);
          expect(call(f, "admit", admission(f, "-recovered")).applied).toBe(true);
          expect(() =>
            f.database
              .prepare("UPDATE sandbox_workspace_occupancy SET released_at=NULL WHERE job_id=?")
              .run(record.plan.identity.jobId),
          ).toThrow("cannot be revoked");
          expect(() =>
            f.database
              .prepare("UPDATE sandbox_release_receipts SET accepted_at=? WHERE job_id=?")
              .run(T2, record.plan.identity.jobId),
          ).toThrow("immutable");
        } else {
          expect(final?.releaseReceipt).toBeUndefined();
          expect(() => call(f, "admit", admission(f, "-protected"))).toThrow("occupied");
        }
      } finally {
        await f.close();
      }
    },
  );

  it("keeps missing result delivery visible after accepting permanent resource release", async () => {
    const f = await openSandboxJournal();
    try {
      let record = start(f);
      record = append(f, record, resource(record, "lost"));
      record = append(f, record, resource(record, "reconciling"));
      record = append(f, record, resource(record, "released"));
      const threadId = record.plan.identity.threadId;
      if (!threadId) throw new Error("expected thread");
      const projection = await readThreadExecutionResources({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId,
        runId: record.plan.identity.runId,
        now: T2,
        inventory: {
          admissions: [{ phase: "bound", record }],
          queue: [],
          legacyResourcesPending: false,
          deletedPlans: [],
        },
        payloads: { get: async () => f.scopePayload },
        protector: f.protector,
        digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
        itemId: (id) => `tool:${id}`,
      });
      expect(projection).toMatchObject({
        allReleased: true,
        pendingResources: false,
        phase: null,
        unresolvedResultItemIds: [`tool:${f.scope.parentToolCallId ?? f.scope.toolCallId}`],
        operations: [{ phase: "released", reasonCode: "RESOURCE_RELEASE_CONFIRMED" }],
      });
      expect(call(f, "read", record.plan.identity)?.releaseReceipt).toEqual(record.releaseReceipt);
    } finally {
      await f.close();
    }
  });

  it("lists started background and service programs until their release is recorded", async () => {
    const f = await openSandboxJournal();
    try {
      f.database
        .prepare("UPDATE capability_handles SET record_json=json_set(record_json,'$.maxUses',10)")
        .run();
      const longRunning = (suffix: string, mode: "background" | "service") => {
        const a = admission(f, suffix, undefined, "read");
        const plan = sandboxExecutionPlanCandidateV2Schema.parse({
          ...a.plan,
          mode,
          operationContract:
            mode === "background"
              ? { ref: "task-create", version: "1", kind: "task_start" }
              : {
                  ref: "service-create",
                  version: "1",
                  kind: "service_start",
                  readinessProbeRef: "ready",
                },
        });
        const resourceRef = `resource${suffix}`;
        const facts = sandboxExecutionFactsSchema.parse({
          ...a.facts,
          environment: { ...a.facts.environment, mode, resourceRef },
          resource: {
            ...a.facts.resource,
            resourceRef,
            status:
              mode === "background"
                ? { kind: "task", state: "starting" }
                : { kind: "service", readiness: "starting" },
          },
        });
        return { ...a, plan, facts };
      };
      const releasedAs = (
        record: SandboxExecutionRecord,
        cleanup: "confirmed" | "process_group_gone",
      ) => {
        const stopping = append(f, record, resource(record, "stopping"));
        const released = resource(stopping, "released");
        return append(
          f,
          stopping,
          sandboxExecutionFactsSchema.parse({
            ...released,
            resource: {
              ...released.resource,
              cleanup,
              status:
                record.plan.mode === "background"
                  ? { kind: "task", state: "exited" }
                  : { kind: "service", readiness: "unavailable" },
            },
          }),
        );
      };
      const startedAs = (
        suffix: string,
        mode: "background" | "service",
        state: "controlled" | "stopping" | "lost",
      ) => {
        const record = start(f, longRunning(suffix, mode));
        return append(f, record, resource(record, state));
      };
      releasedAs(start(f, longRunning("-d-confirmed", "background")), "confirmed");
      releasedAs(start(f, longRunning("-e-group-gone", "service")), "process_group_gone");
      const foreground = start(f, admission(f, "-f-foreground", undefined, "read"));
      append(f, foreground, resource(foreground, "controlled"));
      call(f, "admit", longRunning("-g-not-started", "background"));
      const running = startedAs("-a-task", "background", "controlled");
      const stoppingService = startedAs("-b-service", "service", "stopping");
      const lostTask = startedAs("-c-lost", "background", "lost");

      const list = (afterJobId: string | null, limit: number) =>
        operationsForDatabase(f.database).execute(
          "capabilityInvocation.sandboxV2.listRunningPrograms",
          { ownerId: OWNER_ID, agentId: AGENT_ID, input: { afterJobId, limit } },
        ) as SandboxExecutionRecord[];
      const jobIds = (records: readonly SandboxExecutionRecord[]) =>
        records.map((record) => record.plan.identity.jobId);
      expect(jobIds(list(null, 100))).toEqual(["job-a-task", "job-b-service", "job-c-lost"]);
      expect(list(null, 100)).toEqual([running, stoppingService, lostTask]);
      expect(jobIds(list(null, 1))).toEqual(["job-a-task"]);
      expect(jobIds(list("job-a-task", 1))).toEqual(["job-b-service"]);
      expect(jobIds(list("job-c-lost", 100))).toEqual([]);
      for (const input of [
        { afterJobId: null, limit: 0 },
        { afterJobId: null, limit: 101 },
        { afterJobId: "", limit: 1 },
      ])
        expect(() =>
          operationsForDatabase(f.database).execute(
            "capabilityInvocation.sandboxV2.listRunningPrograms",
            { ownerId: OWNER_ID, agentId: AGENT_ID, input },
          ),
        ).toThrow();
      expect(
        operationsForDatabase(f.database).execute(
          "capabilityInvocation.sandboxV2.listRunningPrograms",
          { ownerId: OWNER_ID, agentId: "agent-other", input: { afterJobId: null, limit: 100 } },
        ),
      ).toEqual([]);

      const environment = await readThreadExecutionEnvironment({
        programs: {
          listRunningPrograms: async (input) => list(input.afterJobId, input.limit),
        },
        mode: "strict",
        unavailableTools: async () => [
          { toolName: "bash", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" },
        ],
        pageSize: 2,
      });
      expect(environment).toEqual({
        mode: "strict",
        programs: [running, stoppingService, lostTask].map((record) => ({
          threadId: record.plan.identity.threadId,
          kind: record.plan.mode,
          toolName: record.plan.operation,
          startedAt: record.startedAt,
        })),
        unavailableTools: [{ toolName: "bash", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" }],
      });
      await expect(
        readThreadExecutionEnvironment({
          programs: {
            listRunningPrograms: async (input) => list(input.afterJobId, input.limit),
          },
          mode: "srt",
          unavailableTools: async () => [],
          pageSize: 1,
          maximumPrograms: 2,
        }),
      ).rejects.toThrow("THREAD_EXECUTION_ENVIRONMENT_LIMIT");
    } finally {
      await f.close();
    }
  });

  it("names a process-group release a stop without strict confirmation", async () => {
    const f = await openSandboxJournal();
    try {
      let record = start(f);
      record = append(f, record, resource(record, "stopping"));
      const released = resource(record, "released");
      record = append(
        f,
        record,
        sandboxExecutionFactsSchema.parse({
          ...released,
          resource: { ...released.resource, cleanup: "process_group_gone" },
        }),
      );
      expect(record.releaseReceipt?.acceptedAt).toBe(T1);
      const threadId = record.plan.identity.threadId;
      if (!threadId) throw new Error("expected thread");
      const inventory = readRunInventory(f, record.plan.identity.runId);
      const projection = await readThreadExecutionResources({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId,
        runId: record.plan.identity.runId,
        now: T2,
        inventory,
        payloads: { get: async () => f.scopePayload },
        protector: f.protector,
        digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
        itemId: (id) => `tool:${id}`,
      });
      expect(projection).toMatchObject({
        allReleased: true,
        pendingResources: false,
        phase: null,
        operations: [
          {
            itemId: `tool:${f.scope.parentToolCallId ?? f.scope.toolCallId}`,
            phase: "released",
            reasonCode: "RESOURCE_STOP_NOT_STRICTLY_CONFIRMED",
          },
        ],
      });
    } finally {
      await f.close();
    }
  });

  it("shows an owner-purged unconfirmed record as deleted without blocking its Run", async () => {
    const f = await openSandboxJournal();
    try {
      let record = start(f);
      record = append(f, record, resource(record, "lost"));
      const threadId = record.plan.identity.threadId;
      if (!threadId) throw new Error("expected thread");
      const runId = record.plan.identity.runId;
      const project = (inventory: SandboxExecutionRunInventory) =>
        readThreadExecutionResources({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          threadId,
          runId,
          now: T2,
          inventory,
          payloads: { get: async () => f.scopePayload },
          protector: f.protector,
          digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
          itemId: (id) => `tool:${id}`,
        });
      expect(await project(readRunInventory(f, runId))).toMatchObject({
        allReleased: false,
        pendingResources: true,
        phase: "unresolved",
      });
      const purge = new SqliteUnconfirmedSandboxPurge({
        databasePath: path.join(f.resource.stateRoot, "product.sqlite"),
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        now: () => T1,
      });
      const listed = purge.list();
      expect(listed.records.map((entry) => entry.jobId)).toEqual([record.plan.identity.jobId]);
      purge.purge(listed.digest);

      const inventory = readRunInventory(f, runId);
      expect(inventory).toEqual({
        admissions: [],
        queue: [],
        legacyResourcesPending: false,
        deletedPlans: [record.plan],
      });
      const itemId = `tool:${f.scope.parentToolCallId ?? f.scope.toolCallId}`;
      expect(await project(inventory)).toEqual(
        expect.objectContaining({
          allReleased: true,
          pendingResources: false,
          phase: null,
          unresolvedResultItemIds: [],
          operations: [
            {
              itemId,
              phase: "record_deleted",
              reasonCode: "EXECUTION_RECORD_DELETED",
              lastObservedAt: null,
            },
          ],
        }),
      );
    } finally {
      await f.close();
    }
  });

  // Actual SQLite intents and output bindings; platform verification is synthetic.
  it.each([
    "deliver",
    "retained-release",
    "cancel-before-dispatch",
    "receipt-fails",
    "expired-proof",
  ] as const)("Agent foreground result handoff: %s", async (scenario) => {
    const f = await openSandboxJournal();
    try {
      let record = start(f);
      record = append(f, record, result(f, record), true);
      record = append(f, record, resource(record, "lost"));
      record = append(f, record, resource(record, "reconciling"));
      const releasedFacts = resource(record, "released");
      if (releasedFacts.resource.supervision !== "released") throw new Error("fixture");
      record = append(f, record, {
        ...releasedFacts,
        resource: {
          ...releasedFacts.resource,
          evidence: {
            ...releasedFacts.resource.evidence,
            validUntil: new Date(Date.parse(T1) + 1).toISOString(),
          },
        },
      });
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
        now: () =>
          scenario === "expired-proof"
            ? T2
            : scenario === "retained-release"
              ? new Date(Date.parse(T1) + 151).toISOString()
              : T1,
        verifyFresh: async (current) => {
          const facts = current.releaseReceipt ? current.facts : resource(current, "released");
          const proof = context(current, facts).verification;
          if (!proof) throw new Error("missing synthetic evidence");
          return proof;
        },
      });
      let checks = 0;
      const receipt = vi.fn(async () => {
        if (scenario === "receipt-fails" && receipt.mock.calls.length === 1)
          throw new Error("receipt unavailable");
      });
      const delivery = {
        assertDisclosure: async () => {
          if (++checks === 3 && scenario === "cancel-before-dispatch")
            f.database.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(identity.runId);
        },
        saveReceipt: receipt,
      };
      const request = { runId: identity.runId, invocationId: identity.invocationId };
      if (scenario === "deliver" || scenario === "retained-release") {
        expect(await complete(request, delivery)).toMatchObject({
          outcome: "succeeded",
          outputRef: "output",
        });
        expect(receipt).toHaveBeenCalledTimes(1);
        expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toEqual([]);
        if (scenario === "retained-release") {
          expect(await complete(request, delivery)).toMatchObject({
            outcome: "succeeded",
            outputRef: "output",
          });
          expect(call(f, "read", identity)?.facts.resource.sequence).toBe(
            record.facts.resource.sequence,
          );
        } else expect(await complete(request, delivery)).toMatchObject({ outcome: "succeeded" });
        expect(
          f.database
            .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
            .get(identity.jobId),
        ).toEqual({ released_at: T1 });
        expect(receipt).toHaveBeenCalledTimes(2);
      } else if (scenario === "expired-proof") {
        expect(await complete(request, delivery)).toBeUndefined();
        expect(receipt).not.toHaveBeenCalled();
      } else {
        await expect(complete(request, delivery)).rejects.toThrow();
        if (scenario === "cancel-before-dispatch") expect(receipt).not.toHaveBeenCalled();
        else expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toHaveLength(1);
        if (scenario === "receipt-fails") {
          expect(await complete(request, delivery)).toMatchObject({ outcome: "succeeded" });
          expect(call(f, "listPending", { afterJobId: null, limit: 10 })).toEqual([]);
          expect(receipt).toHaveBeenCalledTimes(2);
        }
      }
    } finally {
      await f.close();
    }
  });

  it("retains a failed command as a known failure with unverified file effects", async () => {
    const f = await openSandboxJournal();
    try {
      const workspace = path.join(f.resource.stateRoot, "workspace");
      const changedFile = path.join(workspace, "partial-output.txt");
      await mkdir(workspace, { recursive: true });
      const command = await execFile(
        "/bin/sh",
        ["-c", 'printf "partial" > "$1"; exit 7', "sh", changedFile],
        { cwd: workspace },
      ).catch((error: unknown) => error as NodeJS.ErrnoException);
      expect(command).toMatchObject({ code: 7 });
      expect(await readFile(changedFile, "utf8")).toBe("partial");

      const record = start(
        f,
        admission(f, "-failed-command", undefined, "write", {
          ref: "shell",
          version: "1",
          kind: "command",
        }),
      );
      const output = { ref: "output", digest: "f".repeat(64), byteLength: 0 };
      const observedOutput = operationsForDatabase(f.database).execute(
        "capabilityInvocationResult.observeOutput",
        {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation({
            invocationId: record.plan.identity.invocationId,
            payload: outputPayload(output.ref, `sha256:${output.digest}`),
          }),
        },
      ) as { artifact?: Record<string, unknown> };
      expect(observedOutput.artifact).toMatchObject({
        runId: record.plan.identity.runId,
        purpose: "worker_result",
        operationKey: `capability-output:${record.plan.identity.invocationId}`,
        payloadRef: output.ref,
        contentDigest: `sha256:${output.digest}`,
      });
      const failedCommand = sandboxExecutionFactsSchema.parse({
        ...record.facts,
        effect: { kind: "not_asserted" },
        result: {
          schemaVersion: "sandbox-execution.v2",
          identity: record.plan.identity,
          environmentId: record.plan.environmentId,
          policyDigest: record.facts.environment.policyDigest,
          contract: { ref: "shell", version: "1" },
          occurredAt: T1,
          kind: "error",
          output,
          reasonCode: "exit_failed",
          termination: { type: "exit", exitCode: 7 },
        },
      });
      let settled = append(f, record, failedCommand, true);
      settled = append(f, settled, resource(settled, "stopping"));
      settled = append(f, settled, resource(settled, "released"));
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
            record: call(f, "read", settled.plan.identity) as SandboxExecutionRecord,
          }),
        },
        authority: () => SERVICE_AUTHORITY,
        now: () => T1,
        verifyFresh: async (current) => {
          const facts = current.releaseReceipt ? current.facts : resource(current, "released");
          const proof = context(current, facts).verification;
          if (!proof) throw new Error("missing synthetic evidence");
          return proof;
        },
      });
      const receipt = vi.fn(async () => {});
      const completion = await complete(
        { runId: settled.plan.identity.runId, invocationId: settled.plan.identity.invocationId },
        { assertDisclosure: async () => {}, saveReceipt: receipt },
      );
      expect(completion).toMatchObject({
        outcome: "failed",
        errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
      });
      expect(receipt).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it.each(["subject", "metrics", "revive"])(
    "preserves release safety when observing changed %s",
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
        if (change === "revive") {
          // The approved lifecycle contract records a separate incident rather
          // than discarding contradictory evidence or reviving the old claim.
          const protectedRecord = append(f, record, changed);
          expect(protectedRecord.facts).toEqual(record.facts);
          expect(protectedRecord.releaseReceipt).toEqual(record.releaseReceipt);
          expect(protectedRecord.workspaceBlocked).toBe(true);
          expect(() => call(f, "admit", admission(f, "-after-risk"))).toThrow("occupied");
          expect(
            f.database
              .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
              .get(record.plan.identity.jobId),
          ).toEqual({ released_at: T1 });
        } else expect(() => append(f, record, changed)).toThrow();
      } finally {
        await f.close();
      }
    },
  );
});
