import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";
import {
  recoverSandboxExecutionsAtStartup,
  SandboxExecutionReconciliationService,
  type SandboxExecutionRecord,
  type SandboxRecoveryState,
  type SandboxReservationReleaseVerification,
  SandboxResourceRecoveryService,
} from "@himawari-agent/application";
import {
  type SandboxExecutionPlanV2,
  type SandboxHostBinding,
  type SandboxRuntimeQualification,
  sandboxExecutionReservationSchema,
  sandboxExecutionFactsSchema,
  sandboxResourceObservationSchema,
} from "@himawari-agent/execution-contracts";
import {
  applyMigrations,
  assertWritableSchema,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
  readMigrationLedger,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { describe, expect, it, vi } from "vitest";
import { createProductionSandboxControl } from "../../apps/agent-service/src/production-sandbox-control.ts";
import {
  type JobHostControlObservation,
  openJobHostControl,
  queryJobHostControl,
} from "../../packages/runtime-sandbox/src/job-host-control.ts";
import {
  reconciliationBackend,
  sandboxV2Admission,
  sandboxV2Call,
} from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const deadlineAt = new Date(Date.parse(T1) + 1000).toISOString();

async function fixture(reserved = false, withGrant = false) {
  const f = await openSandboxJournal(false, withGrant ? ["api.example.test"] : []);
  const repository = await SqliteProductStateRepository.open({
    stateRoot: f.resource.stateRoot,
    minimumFreeBytes: 0,
  });
  const preparations = repository.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
  const journal = repository.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
  const request = sandboxV2Admission(f);
  if (reserved) {
    const { plan, invocation, workspaces } = request;
    await preparations.reserve({
      plan,
      invocation,
      workspaces,
      reservation: sandboxExecutionReservationSchema.parse({
        schemaVersion: "sandbox-preparation.v1",
        identity: plan.identity,
        environmentId: plan.environmentId,
        resourceRef: null,
        mode: plan.mode,
        workspaceConflictRefs: workspaces.map((x) => x.ref),
        sequence: 1,
        createdAt: plan.requestedAt,
      }),
    });
  } else sandboxV2Call(f, "admit", request);
  const identity = request.plan.identity;
  const requestFor = async () => {
    const admission = await preparations.readAdmission(identity);
    if (!admission) throw new Error("missing admission");
    const record = admission.phase === "bound" ? admission.record : admission;
    return {
      identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      expectedSequence:
        admission.phase === "bound" ? admission.record.facts.resource.sequence : null,
      expectedRecoveryRevision: record.recovery?.revision ?? 0,
    };
  };
  const status = async (): Promise<SandboxRecoveryState | undefined> => {
    const a = await preparations.readAdmission(identity);
    return a?.phase === "bound" ? a.record.recovery : a?.recovery;
  };
  return {
    ...f,
    repository,
    preparations,
    journal,
    identity,
    request,
    requestFor,
    status,
    close: async () => {
      await repository.close();
      await f.close();
    },
  };
}

async function disconnectedPreparation(
  f: Awaited<ReturnType<typeof fixture>>,
  proof: "verified" | "started" | "cleanup-unknown",
  now: () => string,
) {
  const admission = await f.preparations.readAdmission(f.identity);
  if (admission?.phase !== "reserved") throw new Error("missing reservation");
  const root = await realpath(f.resource.stateRoot);
  const directory = path.join(root, "d2-control");
  await mkdir(directory, { mode: 0o700 });
  const binding = {
    directory,
    token: randomBytes(32).toString("hex"),
    sessionId: randomUUID(),
    jobId: f.identity.jobId,
    attemptId: f.identity.attemptId,
  };
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", detached: true });
  const departedPid = child.pid;
  await once(child, "exit");
  if (!departedPid) throw new Error("missing original host PID");
  let sequence = 0;
  const observation: JobHostControlObservation = {
    sessionId: binding.sessionId,
    jobId: binding.jobId,
    attemptId: binding.attemptId,
    bootId: randomUUID(),
    processIdentityRef: `job-host-process:${randomUUID()}`,
    processId: departedPid,
    processStartedAt: now(),
    observedAt: now(),
    sequence: 1,
    phase: "finished",
    policyDigest: f.request.facts.environment.policyDigest,
    privateDirectoryRef: `sandbox-private:${"a".repeat(64)}`,
    linuxNamespace: null,
    taskStarted: proof === "started",
    taskProcessExited: false,
    stdioClosed: false,
    srtReset: proof !== "cleanup-unknown",
    resources: null,
  };
  const server = await openJobHostControl(
    binding,
    () => ({ ...observation, observedAt: now(), sequence: ++sequence }),
    () => {
      throw new Error("disconnected host cannot receive a stop");
    },
  );
  await server.finish();
  await expect(queryJobHostControl(binding, "inspect")).rejects.toMatchObject({
    code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/),
  });
  const artifacts = new Map<string, { ref: string; digest: string; value: unknown }>();
  const host = async () => ({
    binding: {
      privateRoot: root,
      runtimeRoot: "/runtime",
      readOnlyToolchainPaths: [],
      roots: [],
    } as unknown as SandboxHostBinding,
    qualification: { platform: process.platform } as SandboxRuntimeQualification,
  });
  const control = createProductionSandboxControl({
    now,
    machineBootId: async () => "d2-original-machine",
    host,
    admit: host,
    read: async (_plan, key) => structuredClone(artifacts.get(key)),
    write: async (_plan, key, value) => {
      const existing = artifacts.get(key);
      const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      if (existing) {
        if (existing.digest !== digest) throw new Error("changed immutable control artifact");
        return existing;
      }
      const artifact = { ref: key, digest, value: structuredClone(value) };
      artifacts.set(key, artifact);
      return artifact;
    },
  });
  await control.registerPreparation(admission.plan, binding, observation.policyDigest);
  let preparations = f.preparations;
  const stop = vi.fn(async (plan: SandboxExecutionPlanV2, signal: AbortSignal) => {
    const current = await preparations.readAdmission(plan.identity);
    if (current?.phase !== "reserved" || !current.stopRequestedAt)
      throw new Error("missing reservation stop fence");
    await control.stopPreparation(plan, signal, current.stopRequestedAt);
  });
  const verify = vi.fn(control.verifyReservationRelease);
  const recover = () =>
    new SandboxResourceRecoveryService({
      hostId: f.identity.hostId,
      preparations,
      reconciliation: { reconcile: vi.fn() },
      reservations: { stop, verify },
      authority: () => SERVICE_AUTHORITY,
      now,
      timeoutMs: 1000,
    });
  return {
    directory,
    finalPath: path.join(directory, "final.json"),
    withheldPath: path.join(directory, "withheld-final.json"),
    stop,
    verify,
    recover,
    usePreparations: (reopened: typeof preparations) => {
      preparations = reopened;
    },
  };
}

describe.each(["worker", "direct"] as const)("resource recovery scheduling (%s)", (mode) => {
  useSqliteContractExecution(mode);

  it.each(["completed", "failed", "cancelled", "reconciling_external_result"])(
    "discovers and schedules original resources independently of Run status %s",
    async (runStatus) => {
      const f = await fixture();
      try {
        expect(
          await f.preparations.listRecoveryCandidates({ now: T1, afterJobId: null, limit: 100 }),
        ).toEqual([]);
        f.database.prepare("UPDATE runs SET status=? WHERE id=?").run(runStatus, f.identity.runId);
        const page = await f.preparations.listRecoveryCandidates({
          now: T1,
          afterJobId: null,
          limit: 100,
        });
        expect(page).toHaveLength(1);
        const scheduled = await f.preparations.scheduleRecovery(await f.requestFor());
        expect(scheduled).toMatchObject({
          status: "scheduled",
          action: "stop",
          nextAttemptAt: T1,
          startedAt: null,
          deadlineAt: null,
          finishedAt: null,
          attempts: 0,
        });
        expect(await f.preparations.scheduleRecovery(await f.requestFor())).toEqual(scheduled);
        expect(await f.status()).toEqual(scheduled);
        const before = await f.journal.read(f.identity);
        expect(before?.workspaceBlocked).toBe(true);
        expect(before?.releaseReceipt).toBeUndefined();
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    [false, "grant"],
    [true, "grant"],
    [false, "handle"],
    [true, "handle"],
    [false, "capability"],
    [true, "capability"],
  ] as const)(
    "schedules original-resource stop for withdrawn authority (reserved=%s, %s)",
    async (reserved, kind) => {
      const f = await fixture(reserved, kind === "grant");
      try {
        expect(
          await f.preparations.listRecoveryCandidates({ now: T1, afterJobId: null, limit: 100 }),
        ).toEqual([]);
        if (kind === "grant") {
          const grants = await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID);
          const grant = grants.find(({ id }) => id === f.request.plan.authorizationRef);
          if (!grant) throw new Error("missing test Grant");
          await f.repository
            .authorizationStore()
            .revokeGrant(grant.id, T1, "owner_revoked", grant.revision);
        } else if (kind === "handle") {
          await f.repository
            .capabilityStore(OWNER_ID, AGENT_ID)
            .revokeExecutionHandle(f.request.plan.handleRef, T1);
        } else {
          f.database
            .prepare(
              "UPDATE capability_declarations SET status='disabled', record_json=json_set(record_json,'$.lifecycle','disabled') WHERE id=?",
            )
            .run(f.request.plan.capabilityRef);
        }
        expect(
          await f.preparations.listRecoveryCandidates({ now: T1, afterJobId: null, limit: 100 }),
        ).toHaveLength(1);
        expect(await f.preparations.scheduleRecovery(await f.requestFor())).toMatchObject({
          status: "scheduled",
          action: "stop",
          attempts: 0,
          nextAttemptAt: T1,
        });
        expect(
          f.database.prepare("SELECT status FROM runs WHERE id=?").get(f.identity.runId),
        ).toEqual({ status: "running" });
        const admission = await f.preparations.readAdmission(f.identity);
        const record = admission?.phase === "bound" ? admission.record : admission;
        expect(
          f.database
            .prepare(
              "SELECT count(*) AS n FROM sandbox_workspace_occupancy WHERE job_id=? AND released_at IS NULL",
            )
            .get(f.identity.jobId),
        ).toEqual({ n: 1 });
        expect(record?.releaseReceipt).toBeUndefined();
        if (reserved) expect(admission).toMatchObject({ stopRequestedAt: T1 });
      } finally {
        await f.close();
      }
    },
  );

  it("fences unbound starts before queuing cleanup without inventing process identity", async () => {
    const f = await fixture(true);
    try {
      f.database.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(f.identity.runId);
      expect(await f.preparations.scheduleRecovery(await f.requestFor())).toMatchObject({
        status: "scheduled",
        action: "stop",
        attempts: 0,
      });
      const admission = await f.preparations.readAdmission(f.identity);
      expect(admission).toMatchObject({ phase: "reserved", stopRequestedAt: T1 });
      expect(
        f.database
          .prepare(
            "SELECT count(*) AS n FROM sandbox_workspace_occupancy WHERE job_id=? AND released_at IS NULL",
          )
          .get(f.identity.jobId),
      ).toEqual({ n: 1 });
      expect(admission).not.toHaveProperty("releaseReceipt");
      await expect(
        f.preparations.bindAndStart({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          expectedSequence: 1,
          facts: f.request.facts,
        }),
      ).rejects.toThrow("reservation stopped");
    } finally {
      await f.close();
    }
  });

  it.each(["observation-first", "schedule-first"] as const)(
    "rechecks a discovery candidate around a resource observation: %s",
    async (order) => {
      const f = await fixture();
      try {
        f.database.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.identity.runId);
        const stale = await f.requestFor();
        const before = await f.journal.read(f.identity);
        if (!before) throw new Error("missing candidate");
        const scheduled =
          order === "schedule-first" ? await f.preparations.scheduleRecovery(stale) : undefined;
        const facts = sandboxExecutionFactsSchema.parse({
          ...before.facts,
          resource: {
            ...before.facts.resource,
            sequence: before.facts.resource.sequence + 1,
            supervision: "lost",
            cleanup: "unknown",
            reasonCode: "SANDBOX_CONTROL_UNCONFIRMED",
          },
        });
        const observed = await f.journal.append({
          identity: f.identity,
          expectedSequence: before.facts.resource.sequence,
          expectedOperationRevision: before.operationRevision,
          facts,
          authority: SERVICE_AUTHORITY,
          now: T1,
          context: {
            now: T1,
            environment: facts.environment,
            operationContract: before.plan.operationContract,
            verification: null,
            currentResourceSequence: facts.resource.sequence,
            runState: "terminated",
            currentAuthority: false,
            currentFence: false,
            userDisclosureAllowed: false,
            modelDisclosureAllowed: false,
            conflictingWorkspaceRisk: true,
            pendingApprovalOrReconciliation: true,
            resultAlreadyDelivered: false,
          },
        });
        if (order === "observation-first")
          await expect(f.preparations.scheduleRecovery(stale)).rejects.toMatchObject({
            code: "PORT_CONFLICT",
          });
        else {
          if (!scheduled) throw new Error("missing scheduled request");
          await expect(
            f.journal.beginRecovery({
              ...stale,
              action: scheduled.action,
              expectedSequence: before.facts.resource.sequence,
              expectedRecoveryRevision: scheduled.revision,
              deadlineAt,
            }),
          ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
        }
        const fresh = await f.preparations.scheduleRecovery(await f.requestFor());
        expect(fresh).toMatchObject({ status: "scheduled", attempts: 0 });
        expect((await f.journal.read(f.identity))?.facts).toEqual(observed.record.facts);
        expect((await f.journal.read(f.identity))?.startedAt).toBeNull();
        expect(
          f.database.prepare("SELECT count(*) AS n FROM sandbox_release_receipts").get(),
        ).toEqual({ n: 0 });
      } finally {
        await f.close();
      }
    },
  );

  it("pauses a failed attempt durably and only schedules a later distinct stop obligation", async () => {
    const f = await fixture();
    try {
      await recoverSandboxExecutionsAtStartup({
        preparations: f.preparations,
        journal: f.journal,
        authority: () => SERVICE_AUTHORITY,
        now: () => T1,
      });
      const scheduled = await f.preparations.scheduleRecovery(await f.requestFor());
      expect(scheduled).toMatchObject({ status: "scheduled", action: "inspect" });
      const record = await f.journal.read(f.identity);
      if (!record || !scheduled) throw new Error("missing queued recovery");
      const attempt = await f.journal.beginRecovery({
        identity: f.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
        deadlineAt,
        action: "inspect",
        expectedSequence: record.facts.resource.sequence,
        expectedRecoveryRevision: scheduled.revision,
      });
      await f.journal.finishRecovery({
        identity: f.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
        expectedSequence: record.facts.resource.sequence,
        expectedRecoveryRevision: attempt.revision,
        reasonCode: "SANDBOX_RECONCILIATION_PERMISSION_DENIED",
      });
      const paused = await f.status();
      expect(paused).toMatchObject({ status: "unresolved", nextAttemptAt: null, attempts: 1 });
      expect(await f.preparations.scheduleRecovery(await f.requestFor())).toBeUndefined();
      await recoverSandboxExecutionsAtStartup({
        preparations: f.preparations,
        journal: f.journal,
        authority: () => SERVICE_AUTHORITY,
        now: () => T1,
      });
      expect(await f.status()).toEqual(paused);
      f.database.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.identity.runId);
      expect(await f.preparations.scheduleRecovery(await f.requestFor())).toMatchObject({
        status: "scheduled",
        action: "stop",
        attempts: 1,
      });
      await expect(
        f.journal.beginRecovery({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          deadlineAt,
          action: "inspect",
          expectedSequence: record.facts.resource.sequence,
          expectedRecoveryRevision: scheduled.revision,
        }),
      ).rejects.toThrow("Scheduled recovery changed");
    } finally {
      await f.close();
    }
  });

  it.each(["completed", "revoked_grant"])(
    "runs one bounded original-resource stop and preserves a pause: %s",
    async (reason) => {
      const f = await fixture(false, reason === "revoked_grant");
      try {
        if (reason === "completed")
          f.database.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.identity.runId);
        else {
          const grant = (await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID))[0];
          if (!grant) throw new Error("missing Grant");
          await f.repository
            .authorizationStore()
            .revokeGrant(grant.id, T1, "owner_revoked", grant.revision);
        }
        const stop = vi.fn(async (_record: SandboxExecutionRecord) => {
          throw new Error("SANDBOX_HOST_UNAVAILABLE");
        });
        const reconciliation = new SandboxExecutionReconciliationService({
          hostId: f.identity.hostId,
          journal: f.journal,
          now: () => T1,
          timeoutMs: 1000,
          backend: reconciliationBackend({ inspect: stop, stop }),
          evidence: {
            verify: async () => {
              throw new Error("unexpected proof");
            },
          },
        });
        const reservations = { stop: vi.fn(), verify: vi.fn() };
        const service = new SandboxResourceRecoveryService({
          hostId: f.identity.hostId,
          preparations: f.preparations,
          reconciliation,
          reservations,
          authority: () => SERVICE_AUTHORITY,
          now: () => T1,
          timeoutMs: 1000,
        });
        const signal = new AbortController().signal;
        await service.pump(signal, 1);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(await f.status()).toMatchObject({
          status: "unresolved",
          action: "stop",
          attempts: 1,
          nextAttemptAt: null,
          reasonCode: "SANDBOX_HOST_UNAVAILABLE",
          finishedAt: T1,
        });
        await service.pump(signal, 1);
        await service.pump(signal, 1);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(reservations.stop).not.toHaveBeenCalled();
        expect((await f.journal.read(f.identity))?.workspaceBlocked).toBe(true);
      } finally {
        await f.close();
      }
    },
  );
  it("releases an unbound original reservation once without replaying a tool", async () => {
    const f = await fixture(true);
    try {
      f.database.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.identity.runId);
      const admission = await f.preparations.readAdmission(f.identity);
      if (admission?.phase !== "reserved") throw new Error("reservation missing");
      const proof: SandboxReservationReleaseVerification = {
        schemaVersion: "sandbox-reservation-release.v1",
        basis: "host_never_started",
        identity: f.identity,
        environmentId: f.request.plan.environmentId,
        semanticFingerprint: admission.plan.semanticFingerprint,
        stopRequestedAt: T1,
        checkedAt: T1,
        validUntil: deadlineAt,
        processIdentityRef: "job-host-process:original",
        controlSessionId: "12345678-1234-1234-1234-123456789012",
        evidence: { ref: "protected:release-proof", digest: "a".repeat(64) },
      };
      const stop = vi.fn(async () => {});
      const verify = vi.fn(async () => proof);
      const reconcile = vi.fn();
      const service = new SandboxResourceRecoveryService({
        hostId: f.identity.hostId,
        preparations: f.preparations,
        reconciliation: { reconcile },
        reservations: { stop, verify },
        authority: () => SERVICE_AUTHORITY,
        now: () => T1,
        timeoutMs: 1000,
      });
      await service.pump(new AbortController().signal, 1);
      const saved = await f.preparations.readAdmission(f.identity);
      expect(saved).toMatchObject({
        phase: "reserved",
        workspaceBlocked: false,
        recovery: {
          status: "resolved",
          attempts: 1,
          startedAt: T1,
          deadlineAt,
          nextAttemptAt: null,
        },
        releaseReceipt: { acceptedAt: T1, verification: proof },
      });
      expect(
        f.database
          .prepare(
            "SELECT count(*) AS n FROM sandbox_workspace_occupancy WHERE released_at IS NULL",
          )
          .get(),
      ).toEqual({ n: 0 });
      await service.pump(new AbortController().signal, 1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
      expect(await f.preparations.readAdmission(f.identity)).toEqual(saved);
    } finally {
      await f.close();
    }
  });

  it("[R2-L4][prod-sandbox-D2] releases a disconnected never-started host from authenticated final evidence", async (context) => {
    const f = await fixture(true);
    try {
      f.database
        .prepare("UPDATE runs SET status='reconciling_external_result' WHERE id=?")
        .run(f.identity.runId);
      const host = await disconnectedPreparation(f, "verified", () => T1);
      const finalBefore = await readFile(host.finalPath, "utf8");
      await host.recover().pump(new AbortController().signal, 1);
      const admission = await f.preparations.readAdmission(f.identity);
      expect(admission).toMatchObject({
        phase: "reserved",
        recovery: { status: "resolved", attempts: 1 },
        releaseReceipt: { verification: { basis: "host_never_started" } },
      });
      const readback = f.database
        .prepare(`SELECT r.preparation_state AS phase,r.started_at AS startedAt,
          (SELECT count(*) FROM sandbox_reservation_release_receipts rr WHERE rr.job_id=r.job_id) AS receipts,
          (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims
          FROM sandbox_execution_records r WHERE r.job_id=?`)
        .get(f.identity.jobId);
      expect(readback).toEqual({
        phase: "reserved",
        startedAt: null,
        receipts: 1,
        activeClaims: 0,
      });
      expect(host.stop).toHaveBeenCalledTimes(1);
      expect(host.verify).toHaveBeenCalledTimes(1);
      expect(await readFile(host.finalPath, "utf8")).toBe(finalBefore);
      Object.assign(context.task.meta, { reservationRecoveryReadback: readback });
    } finally {
      await f.close();
    }
  });

  it("[R2-L4][prod-sandbox-D2] verifies original final evidence even when its stop connection failed", async (context) => {
    const f = await fixture(true);
    try {
      f.database
        .prepare("UPDATE runs SET status='reconciling_external_result' WHERE id=?")
        .run(f.identity.runId);
      const host = await disconnectedPreparation(f, "verified", () => T1);
      const stop = host.stop.getMockImplementation();
      if (!stop) throw new Error("missing original stop implementation");
      host.stop.mockImplementationOnce(async (plan, signal) => {
        await rename(host.finalPath, host.withheldPath);
        try {
          await stop(plan, signal);
        } finally {
          await rename(host.withheldPath, host.finalPath);
        }
      });
      await host.recover().pump(new AbortController().signal, 1);
      const admission = await f.preparations.readAdmission(f.identity);
      expect(admission).toMatchObject({
        phase: "reserved",
        recovery: { status: "resolved", attempts: 1 },
        releaseReceipt: { verification: { basis: "host_never_started" } },
      });
      const readback = f.database
        .prepare(`SELECT r.started_at AS startedAt,
          (SELECT count(*) FROM sandbox_reservation_release_receipts rr WHERE rr.job_id=r.job_id) AS receipts,
          (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims
          FROM sandbox_execution_records r WHERE r.job_id=?`)
        .get(f.identity.jobId);
      expect(readback).toEqual({ startedAt: null, receipts: 1, activeClaims: 0 });
      expect(host.verify).toHaveBeenCalledTimes(1);
      Object.assign(context.task.meta, { disconnectedStopIndependentReadback: readback });
    } finally {
      await f.close();
    }
  });

  it("[R2-L4][prod-sandbox-D2] retries disconnected preparation cleanup after its original final becomes readable", async (context) => {
    const f = await fixture(true);
    let clock = T1;
    try {
      await f.preparations.interruptReservation({
        identity: f.identity,
        authority: SERVICE_AUTHORITY,
        now: clock,
        reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
      });
      const host = await disconnectedPreparation(f, "verified", () => clock);
      const next = sandboxV2Admission(f, "-d2-after-release");
      const nextRequest = {
        plan: next.plan,
        invocation: next.invocation,
        workspaces: next.workspaces,
        reservation: sandboxExecutionReservationSchema.parse({
          schemaVersion: "sandbox-preparation.v1",
          identity: next.plan.identity,
          environmentId: next.plan.environmentId,
          resourceRef: null,
          mode: next.plan.mode,
          workspaceConflictRefs: next.workspaces.map(({ ref }) => ref),
          sequence: 1,
          createdAt: next.plan.requestedAt,
        }),
      };
      const finalBefore = await readFile(host.finalPath, "utf8");
      await rename(host.finalPath, host.withheldPath);
      await host.recover().pump(new AbortController().signal, 1);
      const unresolved = await f.preparations.readAdmission(f.identity);
      if (unresolved?.phase !== "reserved") throw new Error("reservation unexpectedly bound");
      expect(unresolved).toMatchObject({
        phase: "reserved",
        recovery: {
          status: "unresolved",
          attempts: 1,
          action: "stop",
          reasonCode: "SANDBOX_SUPERVISOR_UNAVAILABLE",
        },
      });
      expect(unresolved?.releaseReceipt).toBeUndefined();
      const retained = f.database
        .prepare(`SELECT r.started_at AS startedAt,
          (SELECT count(*) FROM sandbox_reservation_release_receipts rr WHERE rr.job_id=r.job_id) AS receipts,
          (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims
          FROM sandbox_execution_records r WHERE r.job_id=?`)
        .get(f.identity.jobId);
      expect(retained).toEqual({ startedAt: null, receipts: 0, activeClaims: 1 });
      await expect(f.preparations.reserve(nextRequest)).rejects.toThrow("pending preparation");
      Object.assign(context.task.meta, {
        pendingReservationRetryReadback: { unresolved, retained },
      });
      const scheduled = await f.preparations.scheduleRecovery(await f.requestFor());
      expect(scheduled).toMatchObject({ status: "scheduled", action: "stop", attempts: 1 });
      if (scheduled?.status !== "scheduled")
        throw new Error("missing persistent reservation retry");
      expect(scheduled.nextAttemptAt > clock).toBe(true);
      expect(Date.parse(scheduled.nextAttemptAt) - Date.parse(clock)).toBeLessThanOrEqual(30000);
      await f.repository.close();
      const reopened = await SqliteProductStateRepository.open({
        stateRoot: f.resource.stateRoot,
        minimumFreeBytes: 0,
      });
      try {
        const preparations = reopened.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
        expect(await preparations.readAdmission(f.identity)).toMatchObject({ recovery: scheduled });
        expect(
          await preparations.scheduleRecovery({
            identity: f.identity,
            now: clock,
            expectedSequence: null,
            expectedRecoveryRevision: scheduled.revision,
            authority: { ...SERVICE_AUTHORITY, agentServiceBootId: "d2-restarted-agent" },
          }),
        ).toMatchObject({
          status: "scheduled",
          attempts: 1,
          nextAttemptAt: scheduled.nextAttemptAt,
        });
      } finally {
        await reopened.close();
      }
      await rename(host.withheldPath, host.finalPath);
      const resumedRepository = await SqliteProductStateRepository.open({
        stateRoot: f.resource.stateRoot,
        minimumFreeBytes: 0,
      });
      try {
        const preparations = resumedRepository.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
        host.usePreparations(preparations);
        const current = await preparations.readAdmission(f.identity);
        if (current?.phase !== "reserved") throw new Error("reservation unexpectedly bound");
        await preparations.scheduleRecovery({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: clock,
          expectedSequence: null,
          expectedRecoveryRevision: current.recovery?.revision ?? 0,
        });
        const service = new SandboxResourceRecoveryService({
          hostId: f.identity.hostId,
          preparations,
          reconciliation: { reconcile: vi.fn() },
          reservations: { stop: host.stop, verify: host.verify },
          authority: () => SERVICE_AUTHORITY,
          now: () => clock,
          timeoutMs: 1000,
        });
        await service.pump(new AbortController().signal, 1);
        expect(host.stop).toHaveBeenCalledTimes(1);
        const waiting = await preparations.readAdmission(f.identity);
        if (waiting?.phase !== "reserved") throw new Error("reservation unexpectedly bound");
        expect(
          f.database
            .prepare(
              "SELECT count(*) AS activeClaims FROM sandbox_workspace_occupancy WHERE job_id=? AND released_at IS NULL",
            )
            .get(f.identity.jobId),
        ).toEqual({ activeClaims: 1 });
        clock = scheduled.nextAttemptAt;
        await service.pump(new AbortController().signal, 1);
        await service.pump(new AbortController().signal, 1);
        const released = await preparations.readAdmission(f.identity);
        expect(released).toMatchObject({
          phase: "reserved",
          recovery: { status: "resolved", attempts: 2 },
          releaseReceipt: { verification: { basis: "host_never_started" } },
        });
        expect(host.stop).toHaveBeenCalledTimes(2);
        expect(await readFile(host.finalPath, "utf8")).toBe(finalBefore);
        const readback = f.database
          .prepare(`SELECT r.started_at AS startedAt,
            (SELECT count(*) FROM sandbox_reservation_release_receipts rr WHERE rr.job_id=r.job_id) AS receipts,
            (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims
            FROM sandbox_execution_records r WHERE r.job_id=?`)
          .get(f.identity.jobId);
        expect(readback).toEqual({ startedAt: null, receipts: 1, activeClaims: 0 });
        expect((await preparations.reserve(nextRequest)).applied).toBe(true);
        expect(
          f.database
            .prepare("SELECT started_at AS startedAt FROM sandbox_execution_records WHERE job_id=?")
            .get(next.plan.identity.jobId),
        ).toEqual({ startedAt: null });
        Object.assign(context.task.meta, {
          reservationRetryReadback: { unresolved, scheduled, released, readback },
        });
      } finally {
        await resumedRepository.close();
      }
    } finally {
      await f.close();
    }
  });

  it("[R2-L4][prod-sandbox-D2] backs off reservation stop retries through 1, 2, 4, 8, 16 and capped 30 seconds", async (context) => {
    const f = await fixture(true);
    try {
      let clock = T1;
      await f.preparations.interruptReservation({
        identity: f.identity,
        authority: SERVICE_AUTHORITY,
        now: clock,
        reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
      });
      let scheduled = await f.preparations.scheduleRecovery(await f.requestFor());
      const observations: unknown[] = [];
      const delays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
      for (const [index, delay] of delays.entries()) {
        if (!scheduled) throw new Error("retry schedule missing");
        const running = await f.preparations.beginReservationRecovery({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: clock,
          deadlineAt: new Date(Date.parse(clock) + 1000).toISOString(),
          expectedRecoveryRevision: scheduled.revision,
        });
        expect(running.attempts).toBe(index + 1);
        const failed = await f.preparations.finishReservationRecovery({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: clock,
          expectedRecoveryRevision: running.revision,
          reasonCode: "SANDBOX_SUPERVISOR_UNAVAILABLE",
        });
        expect(failed).toMatchObject({ status: "unresolved", attempts: index + 1 });
        const retryAt = new Date(Date.parse(clock) + delay).toISOString();
        const retry = await f.preparations.scheduleRecovery({
          ...(await f.requestFor()),
          now: clock,
        });
        expect(retry).toMatchObject({
          status: "scheduled",
          action: "stop",
          attempts: index + 1,
          nextAttemptAt: retryAt,
        });
        if (!retry) throw new Error("retry schedule missing");
        const tooEarly = new Date(Date.parse(retryAt) - 1).toISOString();
        await expect(
          f.preparations.beginReservationRecovery({
            identity: f.identity,
            authority: SERVICE_AUTHORITY,
            now: tooEarly,
            deadlineAt: new Date(Date.parse(tooEarly) + 1000).toISOString(),
            expectedRecoveryRevision: retry.revision,
          }),
        ).rejects.toThrow("Scheduled recovery changed");
        expect(await f.status()).toEqual(retry);
        observations.push({ failed, retry, delay });
        scheduled = retry;
        clock = retryAt;
      }
      const readback = f.database
        .prepare(`SELECT r.started_at AS startedAt,
          (SELECT count(*) FROM sandbox_reservation_release_receipts rr WHERE rr.job_id=r.job_id) AS receipts,
          (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims
          FROM sandbox_execution_records r WHERE r.job_id=?`)
        .get(f.identity.jobId);
      expect(readback).toEqual({ startedAt: null, receipts: 0, activeClaims: 1 });
      Object.assign(context.task.meta, { reservationBackoffReadback: { observations, readback } });
    } finally {
      await f.close();
    }
  });

  it.each([
    ["SANDBOX_SUPERVISOR_UNAVAILABLE", true],
    ["SANDBOX_HOST_UNAVAILABLE", true],
    ["SANDBOX_CONTROL_UNCONFIRMED", true],
    ["SANDBOX_CONTROL_TIMED_OUT", true],
    ["SANDBOX_RECONCILIATION_TIMED_OUT", true],
    ["SANDBOX_RECONCILIATION_INTERRUPTED", true],
    ["SANDBOX_RECONCILIATION_INCONCLUSIVE", true],
    ["SANDBOX_CONTROL_IDENTITY_CHANGED", false],
    ["SANDBOX_CONTROL_EVIDENCE_INVALID", false],
    ["SANDBOX_RECONCILIATION_PERMISSION_DENIED", false],
    ["SANDBOX_CONTROL_DIRECTORY_CHANGED", false],
    ["SANDBOX_CONTROL_BINDING_UNAVAILABLE", false],
    ["SANDBOX_CONTROL_ARTIFACT_CHANGED", false],
    ["SANDBOX_RECONCILIATION_UNCONFIRMED", false],
  ] as const)(
    "[R2-L4][prod-sandbox-D2] applies reserved retry policy to %s (retry=%s)",
    async (reasonCode, retryable) => {
      const f = await fixture(true);
      try {
        await f.preparations.interruptReservation({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
        });
        const scheduled = await f.preparations.scheduleRecovery(await f.requestFor());
        if (!scheduled) throw new Error("schedule missing");
        const running = await f.preparations.beginReservationRecovery({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          deadlineAt,
          expectedRecoveryRevision: scheduled.revision,
        });
        const failed = await f.preparations.finishReservationRecovery({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          expectedRecoveryRevision: running.revision,
          reasonCode,
        });
        expect(failed).toMatchObject({ status: "unresolved", attempts: 1, reasonCode });
        const retry = await f.preparations.scheduleRecovery(await f.requestFor());
        if (retryable)
          expect(retry).toMatchObject({
            status: "scheduled",
            action: "stop",
            attempts: 1,
            nextAttemptAt: deadlineAt,
          });
        else {
          expect(retry).toBeUndefined();
          expect(await f.status()).toEqual(failed);
        }
        const readback = f.database
          .prepare(`SELECT r.started_at AS startedAt,
            (SELECT count(*) FROM sandbox_reservation_release_receipts rr WHERE rr.job_id=r.job_id) AS receipts,
            (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims
            FROM sandbox_execution_records r WHERE r.job_id=?`)
          .get(f.identity.jobId);
        expect(readback).toEqual({ startedAt: null, receipts: 0, activeClaims: 1 });
      } finally {
        await f.close();
      }
    },
  );

  it("[R2-L4][prod-sandbox-D2] pauses recovery when the original control directory disappears", async (context) => {
    const f = await fixture(true);
    try {
      f.database
        .prepare("UPDATE runs SET status='reconciling_external_result' WHERE id=?")
        .run(f.identity.runId);
      const host = await disconnectedPreparation(f, "verified", () => T1);
      const originalFinal = await readFile(host.finalPath);
      const movedDirectory = `${host.directory}-moved`;
      await rename(host.directory, movedDirectory);
      await expect(readFile(host.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(movedDirectory, "final.json"))).toEqual(originalFinal);
      await host.recover().pump(new AbortController().signal, 1);
      const admission = await f.preparations.readAdmission(f.identity);
      expect(admission).toMatchObject({
        phase: "reserved",
        recovery: {
          status: "unresolved",
          attempts: 1,
          reasonCode: "SANDBOX_CONTROL_DIRECTORY_CHANGED",
          nextAttemptAt: null,
        },
      });
      expect(await f.preparations.scheduleRecovery(await f.requestFor())).toBeUndefined();
      const readback = f.database
        .prepare(`SELECT r.started_at AS startedAt,
          (SELECT count(*) FROM sandbox_reservation_release_receipts rr WHERE rr.job_id=r.job_id) AS receipts,
          (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims
          FROM sandbox_execution_records r WHERE r.job_id=?`)
        .get(f.identity.jobId);
      expect(readback).toEqual({ startedAt: null, receipts: 0, activeClaims: 1 });
      expect(await readFile(path.join(movedDirectory, "final.json"))).toEqual(originalFinal);
      Object.assign(context.task.meta, { disappearedControlDirectoryReadback: readback });
    } finally {
      await f.close();
    }
  });

  it.each(["started", "cleanup-unknown"] as const)(
    "[R2-L4][prod-sandbox-D2] retains occupancy when a disconnected final contradicts never-started release: %s",
    async (proof) => {
      const f = await fixture(true);
      try {
        f.database
          .prepare("UPDATE runs SET status='reconciling_external_result' WHERE id=?")
          .run(f.identity.runId);
        const host = await disconnectedPreparation(f, proof, () => T1);
        await host.recover().pump(new AbortController().signal, 1);
        const admission = await f.preparations.readAdmission(f.identity);
        if (admission?.phase !== "reserved") throw new Error("reservation unexpectedly bound");
        expect(admission).toMatchObject({
          phase: "reserved",
          recovery: {
            status: "unresolved",
            attempts: 1,
            reasonCode: "SANDBOX_CONTROL_UNCONFIRMED",
          },
        });
        expect(admission?.releaseReceipt).toBeUndefined();
        const readback = f.database
          .prepare(`SELECT r.started_at AS startedAt,
            (SELECT count(*) FROM sandbox_reservation_release_receipts rr WHERE rr.job_id=r.job_id) AS receipts,
            (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims
            FROM sandbox_execution_records r WHERE r.job_id=?`)
          .get(f.identity.jobId);
        expect(readback).toEqual({ startedAt: null, receipts: 0, activeClaims: 1 });
      } finally {
        await f.close();
      }
    },
  );

  it.each(["bound", "reserved"])(
    "cancels a %s check and rejects late backend effects",
    async (phase) => {
      const f = await fixture(phase === "reserved");
      let release!: () => void;
      try {
        f.database.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.identity.runId);
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached!: () => void;
        const entered = new Promise<void>((resolve) => {
          reached = resolve;
        });
        let backendSignal: AbortSignal | undefined;
        const waiting = async (_record: unknown, signal?: AbortSignal) => {
          backendSignal = signal;
          reached();
          await pending;
          throw new Error("late host response");
        };
        const evidence = { verify: vi.fn() };
        const reconciliation = new SandboxExecutionReconciliationService({
          hostId: f.identity.hostId,
          journal: f.journal,
          now: () => T1,
          timeoutMs: 1000,
          backend: reconciliationBackend({ inspect: waiting, stop: waiting }),
          evidence,
        });
        const verify = vi.fn();
        const service = new SandboxResourceRecoveryService({
          hostId: f.identity.hostId,
          preparations: f.preparations,
          reconciliation,
          reservations: { stop: waiting, verify },
          authority: () => SERVICE_AUTHORITY,
          now: () => T1,
          timeoutMs: 1000,
        });
        const controller = new AbortController();
        const pumping = service.pump(controller.signal, 1);
        await entered;
        const running = await f.status();
        if (!running || running.status !== "running") throw new Error("recovery did not start");
        controller.abort();
        await pumping;
        expect(backendSignal?.aborted).toBe(true);
        expect(await f.status()).toMatchObject({
          status: "unresolved",
          attempts: 1,
          reasonCode: "SANDBOX_RECONCILIATION_INTERRUPTED",
          nextAttemptAt: null,
          finishedAt: T1,
        });
        const before = await f.preparations.readAdmission(f.identity);
        release();
        // A real subsequent journal read is queued after promise continuations.
        expect(await f.preparations.readAdmission(f.identity)).toEqual(before);
        expect(verify).not.toHaveBeenCalled();
        expect(evidence.verify).not.toHaveBeenCalled();
        expect(
          f.database
            .prepare(
              "SELECT count(*) AS n FROM sandbox_workspace_occupancy WHERE released_at IS NULL",
            )
            .get(),
        ).toEqual({ n: 1 });
        if (phase === "reserved") {
          await expect(
            f.preparations.releaseReservation({
              identity: f.identity,
              authority: SERVICE_AUTHORITY,
              now: T1,
              expectedRecoveryRevision: running.revision,
              verification: {} as SandboxReservationReleaseVerification,
            }),
          ).rejects.toThrow("ownership changed");
        }
      } finally {
        release?.();
        await f.close();
      }
    },
  );

  it("releases verified bound resources while preserving unknown operation results", async () => {
    const f = await fixture();
    try {
      f.database.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.identity.runId);
      const before = await f.journal.read(f.identity);
      const queued = await f.preparations.scheduleRecovery(await f.requestFor());
      if (!queued) throw new Error("missing schedule");
      const proof = { ref: "protected:host-proof", digest: "b".repeat(64) };
      const stop = vi.fn(async (record: SandboxExecutionRecord) => {
        const { reasonCode: _reason, ...resource } = record.facts
          .resource as typeof record.facts.resource & { reasonCode?: string };
        return sandboxResourceObservationSchema.parse({
          ...resource,
          sequence: record.facts.resource.sequence + 1,
          supervision: "released",
          cleanup: "confirmed",
          evidence: {
            ...proof,
            validUntil: deadlineAt,
            qualificationRef: record.plan.binding.qualificationRef,
            profileRef: record.plan.binding.profileRef,
            subject: { kind: "local_process", processIdentityRef: "original" },
          },
        });
      });
      const reconciliation = new SandboxExecutionReconciliationService({
        hostId: f.identity.hostId,
        journal: f.journal,
        now: () => T1,
        timeoutMs: 1000,
        backend: reconciliationBackend({ inspect: stop, stop }),
        evidence: {
          verify: async ({ plan, facts, now }) => ({
            facts,
            identity: plan.identity,
            environmentId: plan.environmentId,
            policyDigest: facts.environment.policyDigest,
            resourceSequence: facts.resource.sequence,
            checkedAt: now,
            validUntil: deadlineAt,
            evidence: [proof],
            outputs: [],
          }),
        },
      });
      const service = new SandboxResourceRecoveryService({
        hostId: f.identity.hostId,
        preparations: f.preparations,
        reconciliation,
        reservations: { stop: vi.fn(), verify: vi.fn() },
        authority: () => SERVICE_AUTHORITY,
        now: () => T1,
        timeoutMs: 1000,
      });
      await service.pump(new AbortController().signal, 1);
      const after = await f.journal.read(f.identity);
      expect(after).toMatchObject({
        workspaceBlocked: false,
        facts: { resource: { supervision: "released" } },
        recovery: {
          status: "resolved",
          attempts: 1,
          nextAttemptAt: null,
          reasonCode: "SANDBOX_RECONCILIATION_CONFIRMED",
        },
      });
      expect(after?.facts.result).toEqual(before?.facts.result);
      expect(after?.facts.effect).toEqual(before?.facts.effect);
      // Fault injection: a queue snapshot can lag an independently accepted
      // release. Closing that queue must not manufacture another host attempt.
      f.database
        .prepare("UPDATE sandbox_execution_records SET recovery_json=? WHERE job_id=?")
        .run(JSON.stringify(queued), f.identity.jobId);
      expect(await f.preparations.scheduleRecovery(await f.requestFor())).toMatchObject({
        status: "resolved",
        attempts: 0,
        startedAt: null,
        deadlineAt: null,
        nextAttemptAt: null,
        finishedAt: T1,
        reasonCode: "SANDBOX_RECONCILIATION_CONFIRMED",
      });
      expect(
        f.database.prepare("SELECT count(*) AS n FROM sandbox_release_receipts").get(),
      ).toEqual({ n: 1 });
      await service.pump(new AbortController().signal, 1);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it("retains queued work across a repository reopen and rejects its stale revision", async () => {
    const f = await fixture(true);
    try {
      f.database.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(f.identity.runId);
      const scheduled = await f.preparations.scheduleRecovery(await f.requestFor());
      if (!scheduled) throw new Error("missing schedule");
      const rediscovery = await f.requestFor();
      await f.repository.close();
      const reopened = await SqliteProductStateRepository.open({
        stateRoot: f.resource.stateRoot,
        minimumFreeBytes: 0,
      });
      try {
        const preparations = reopened.sandboxExecutionPreparations(OWNER_ID, AGENT_ID);
        expect(await preparations.readAdmission(f.identity)).toMatchObject({ recovery: scheduled });
        // Scheduling state is durable; rediscovery does not reset its time or count.
        expect(await preparations.scheduleRecovery(rediscovery)).toEqual(scheduled);
        const attempt = await preparations.beginReservationRecovery({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          deadlineAt,
          expectedRecoveryRevision: scheduled.revision,
        });
        expect(attempt.attempts).toBe(1);
        await expect(
          preparations.beginReservationRecovery({
            identity: f.identity,
            authority: SERVICE_AUTHORITY,
            now: T1,
            deadlineAt,
            expectedRecoveryRevision: scheduled.revision,
          }),
        ).rejects.toThrow("already running");
      } finally {
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  });

  it.each(["inspect", "stop"] as const)(
    "prioritizes an explicit stop over %s without duplicating an active stop",
    async (previousAction) => {
      const f = await fixture();
      let release = () => {};
      let initial: Promise<unknown> | undefined;
      try {
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        let enter = () => {};
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const lost = (record: SandboxExecutionRecord) =>
          sandboxResourceObservationSchema.parse({
            ...record.facts.resource,
            sequence: record.facts.resource.sequence + 1,
            supervision: "lost",
            cleanup: "unknown",
            reasonCode: "SANDBOX_CONTROL_UNCONFIRMED",
          });
        const held = vi.fn(async (record: SandboxExecutionRecord) => {
          enter();
          await pending;
          return lost(record);
        });
        const stop =
          previousAction === "stop"
            ? held
            : vi.fn(async (record: SandboxExecutionRecord) => lost(record));
        const service = new SandboxExecutionReconciliationService({
          hostId: f.identity.hostId,
          journal: f.journal,
          now: () => T1,
          timeoutMs: 30000,
          backend: reconciliationBackend({ inspect: held, stop }),
          evidence: { verify: vi.fn() },
        });
        const before = await f.journal.read(f.identity);
        if (!before) throw new Error("missing original resource");
        initial = service.reconcile({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          expectedSequence: before.facts.resource.sequence,
          action: previousAction,
        });
        void initial.catch(() => {});
        await entered;
        const current = await f.journal.read(f.identity);
        if (!current) throw new Error("missing running recovery");
        const stopping = service.reconcile({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          expectedSequence: current.facts.resource.sequence,
          action: "stop",
        });
        if (previousAction === "stop") {
          await expect(stopping).rejects.toThrow("Recovery already running");
          expect(stop).toHaveBeenCalledOnce();
          release();
          await initial;
          expect(await f.status()).toMatchObject({
            status: "unresolved",
            action: "stop",
            attempts: 1,
          });
        } else {
          const stopped = await stopping;
          expect(stop).toHaveBeenCalledOnce();
          expect(stopped.record.recovery).toMatchObject({
            status: "unresolved",
            action: "stop",
            attempts: 2,
          });
          expect(stopped.record.workspaceBlocked).toBe(true);
          release();
          await expect(initial).rejects.toThrow("SANDBOX_RECONCILIATION_OWNERSHIP_CHANGED");
          expect(await f.journal.read(f.identity)).toEqual(stopped.record);
        }
      } finally {
        release();
        await initial?.catch(() => {});
        await f.close();
      }
    },
  );

  it("[R2-L4][prod-sandbox-D2] expires an abandoned reservation attempt and schedules its next stop after backoff", async () => {
    const f = await fixture(true);
    try {
      f.database.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(f.identity.runId);
      const scheduled = await f.preparations.scheduleRecovery(await f.requestFor());
      if (!scheduled) throw new Error("schedule missing");
      await f.preparations.beginReservationRecovery({
        identity: f.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
        deadlineAt,
        expectedRecoveryRevision: scheduled.revision,
      });
      expect(await f.preparations.scheduleRecovery(await f.requestFor())).toBeUndefined();
      expect(
        await f.preparations.scheduleRecovery({ ...(await f.requestFor()), now: deadlineAt }),
      ).toMatchObject({
        status: "unresolved",
        attempts: 1,
        reasonCode: "SANDBOX_RECONCILIATION_TIMED_OUT",
        nextAttemptAt: null,
      });
      const retry = await f.preparations.scheduleRecovery({
        ...(await f.requestFor()),
        now: deadlineAt,
      });
      const retryAt = new Date(Date.parse(deadlineAt) + 1000).toISOString();
      expect(retry).toMatchObject({
        status: "scheduled",
        action: "stop",
        attempts: 1,
        nextAttemptAt: retryAt,
      });
      if (!retry) throw new Error("retry missing");
      await expect(
        f.preparations.beginReservationRecovery({
          identity: f.identity,
          authority: SERVICE_AUTHORITY,
          now: deadlineAt,
          deadlineAt: new Date(Date.parse(deadlineAt) + 30_000).toISOString(),
          expectedRecoveryRevision: retry.revision,
        }),
      ).rejects.toThrow("Scheduled recovery changed");
      expect(await f.status()).toEqual(retry);
    } finally {
      await f.close();
    }
  });
});

it("migrates populated schema 42 without restarting old recovery or weakening its writer fence", async () => {
  const f = await fixture(true);
  let old: ReturnType<typeof openQualifiedDatabase> | undefined;
  try {
    const migrations = await loadBundledMigrations();
    old = openQualifiedDatabase(path.join(f.resource.stateRoot, "schema42.sqlite"));
    applyMigrations(old, migrations.slice(0, 42));
    old.pragma("foreign_keys = OFF");
    const tables = old
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'",
      )
      .all() as { name: string }[];
    for (const { name } of tables) {
      if ((old.prepare(`SELECT count(*) FROM "${name}"`).pluck().get() as number) > 0) continue;
      const columns = (old.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      for (const row of f.database.prepare(`SELECT * FROM "${name}"`).all() as Record<
        string,
        unknown
      >[])
        old
          .prepare(
            `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          )
          .run(...columns.map((c) => row[c]));
    }
    old.pragma("foreign_keys = ON");
    const historical = {
      revision: 7,
      owner: "previous-boot",
      attempts: 3,
      status: "unresolved",
      action: "stop",
      startedAt: T1,
      deadlineAt,
      finishedAt: deadlineAt,
      reasonCode: "SANDBOX_RECONCILIATION_PERMISSION_DENIED",
    };
    old
      .prepare("UPDATE sandbox_execution_records SET recovery_json=?")
      .run(JSON.stringify(historical));
    const claims = old.prepare("SELECT * FROM sandbox_workspace_occupancy").all();
    const ledger = readMigrationLedger(old);
    const snapshot = await createVerifiedMigrationSnapshot(
      old,
      path.join(f.resource.stateRoot, "schema42-snapshot.sqlite"),
    );
    expect(applyMigrations(old, migrations, { snapshot })).toEqual({
      appliedSequences: [43, 44, 45, 46, 47, 48, 49],
      currentSequence: 49,
    });
    expect(readMigrationLedger(old).slice(0, 42)).toEqual(ledger);
    const json = old
      .prepare("SELECT recovery_json FROM sandbox_execution_records")
      .pluck()
      .get() as string;
    expect(JSON.parse(json)).toEqual({ ...historical, nextAttemptAt: null });
    expect(old.prepare("SELECT * FROM sandbox_workspace_occupancy").all()).toEqual(claims);
    expect(old.prepare("SELECT count(*) FROM sandbox_release_receipts").pluck().get()).toBe(0);
    expect(
      old.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
    ).toBe(0);
    const migrated = old;
    expect(() => assertWritableSchema(migrated, 42)).toThrow();
    expect(() => assertWritableSchema(migrated, 49)).not.toThrow();
    expect(old.pragma("foreign_key_check")).toEqual([]);
  } finally {
    old?.close();
    await f.close();
  }
});

it("advances past a full page of paused jobs and foreign hosts while respecting cleanup concurrency", async () => {
  const f = await fixture();
  try {
    const original = await f.preparations.readAdmission(f.identity);
    if (original?.phase !== "bound") throw new Error("bound fixture missing");
    const rows = Array.from({ length: 103 }, (_, index) => ({
      ...original,
      record: {
        ...original.record,
        plan: {
          ...original.record.plan,
          identity: {
            ...f.identity,
            jobId: `job-${String(index).padStart(3, "0")}`,
            hostId: index === 100 ? "another-host" : f.identity.hostId,
          },
        },
      },
    }));
    const listRecoveryCandidates = vi.fn(
      async ({ afterJobId, limit }: { afterJobId: string | null; limit: number }) =>
        rows
          .filter((r) => afterJobId === null || r.record.plan.identity.jobId > afterJobId)
          .slice(0, limit),
    );
    const scheduleRecovery = vi.fn(
      async ({
        identity,
      }: {
        identity: typeof f.identity;
      }): Promise<SandboxRecoveryState | undefined> =>
        identity.jobId < "job-101"
          ? undefined
          : {
              revision: 1,
              owner: SERVICE_AUTHORITY.agentServiceBootId,
              attempts: 0,
              status: "scheduled",
              action: "stop",
              scheduledAt: T1,
              nextAttemptAt: T1,
              startedAt: null,
              deadlineAt: null,
              finishedAt: null,
              reasonCode: "SANDBOX_RESOURCE_STOP_REQUIRED",
            },
    );
    const reconcile = vi.fn(async () => ({ record: original.record, applied: false }));
    const service = new SandboxResourceRecoveryService({
      hostId: f.identity.hostId,
      preparations: { ...f.preparations, listRecoveryCandidates, scheduleRecovery },
      reconciliation: { reconcile },
      reservations: { stop: vi.fn(), verify: vi.fn() },
      authority: () => SERVICE_AUTHORITY,
      now: () => T1,
      timeoutMs: 1000,
    });
    const signal = new AbortController().signal;
    await service.pump(signal, 1);
    expect(reconcile).not.toHaveBeenCalled();
    await service.pump(signal, 1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenLastCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ jobId: "job-101" }) }),
    );
    expect(scheduleRecovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ hostId: "another-host" }) }),
    );
    await service.pump(signal, 1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenLastCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ jobId: "job-102" }) }),
    );
  } finally {
    await f.close();
  }
});
