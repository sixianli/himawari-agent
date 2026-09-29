import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import {
  ApplicationPortError,
  type PayloadRecord,
  type PortErrorCode,
  type RunPayloadArtifact,
  type RunPayloadArtifactCommitResult,
  type SandboxExecutionPreparationPort,
  type SandboxReservationReleaseVerification,
} from "@himawari-agent/application";
import {
  type SandboxExecutionPlanV2,
  type SandboxHostBinding,
  type SandboxRuntimeQualification,
  sandboxExecutionReservationSchema,
} from "@himawari-agent/execution-contracts";
import { SqliteRunPayloadArtifactOperations } from "@himawari-agent/persistence-sqlite";
import { afterEach, expect, it } from "vitest";
import { createProductionSandboxControl } from "../../apps/agent-service/src/production-sandbox-control.ts";
import { sandboxV2Admission } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(protocol = true, backendRef = "srt") {
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const operations = operationsForDatabase(f.database);
  const call = <K extends keyof SandboxExecutionPreparationPort>(
    method: K,
    input: Parameters<SandboxExecutionPreparationPort[K]>[0],
  ) =>
    operations.execute(`capabilityInvocation.sandboxV2.${method}`, {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      input,
    }) as Awaited<ReturnType<SandboxExecutionPreparationPort[K]>>;
  const base = sandboxV2Admission(f);
  const candidate = {
    ...base.plan,
    backendRef,
    ...(protocol ? { preparationProtocol: "register-before-host.v1" as const } : {}),
  };
  const admission = call("reserve", {
    ...base,
    plan: candidate,
    reservation: sandboxExecutionReservationSchema.parse({
      schemaVersion: "sandbox-preparation.v1",
      identity: candidate.identity,
      environmentId: candidate.environmentId,
      resourceRef: null,
      mode: candidate.mode,
      workspaceConflictRefs: base.workspaces.map((entry) => entry.ref),
      sequence: 1,
      createdAt: candidate.requestedAt,
    }),
  }).admission;
  if (admission.phase !== "reserved") throw new Error("Expected reserved");
  const plan = admission.plan;
  call("interruptReservation", {
    identity: plan.identity,
    authority: SERVICE_AUTHORITY,
    now: T1,
    reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
  });
  const root = await realpath(await mkdtemp("/tmp/hma-seal-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "control");
  await mkdir(directory, { mode: 0o700 });
  const control = {
    directory,
    jobId: plan.identity.jobId,
    attemptId: plan.identity.attemptId,
    sessionId: randomUUID(),
    token: "a".repeat(64),
  };
  const payloads = new Map<string, PayloadRecord>();
  const artifacts = new SqliteRunPayloadArtifactOperations(
    f.database,
    (code, message, details) => {
      throw new ApplicationPortError(code as PortErrorCode, message, details);
    },
    () => undefined,
  );
  const artifactInput = (operationKey: string) => ({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    purpose: "trace",
    operationKey,
    authority: {
      product: SERVICE_AUTHORITY.product,
      leaseId: SERVICE_AUTHORITY.lease.leaseId,
      leaseFencingToken: SERVICE_AUTHORITY.lease.fencingToken,
    },
    now: T1,
  });
  const host = async () => ({
    binding: {
      privateRoot: root,
      runtimeRoot: "/runtime",
      readOnlyToolchainPaths: [],
      roots: [],
    } as unknown as SandboxHostBinding,
    qualification: { platform: process.platform } as SandboxRuntimeQualification,
  });
  const options = {
    now: () => T1,
    machineBootId: async () => "boot",
    host,
    admit: host,
    read: async (_plan: SandboxExecutionPlanV2, key: string) => {
      const saved = artifacts.execute("runPayloadArtifact.lookup", artifactInput(key)) as
        | RunPayloadArtifact
        | undefined;
      if (!saved) return undefined;
      const payload = payloads.get(saved.payloadRef);
      if (!payload) throw new Error("Missing protected payload");
      const value = JSON.parse(
        Buffer.from(
          await f.protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }),
        ).toString(),
      );
      return { ref: saved.payloadRef, digest: hash(value), value };
    },
    write: async (_plan: SandboxExecutionPlanV2, key: string, value: unknown) => {
      const payload = await f.protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: randomUUID(),
        dataClassification: "restricted",
        contentType: "application/json",
        plaintext: Buffer.from(JSON.stringify(value)),
        createdAt: T1,
      });
      const saved = artifacts.execute("runPayloadArtifact.commit", {
        ...artifactInput(key),
        payload,
      }) as RunPayloadArtifactCommitResult;
      if (!saved.replayed) payloads.set(saved.ref, payload);
      return { ref: saved.ref, digest: hash(value) };
    },
  };
  const controller = () => createProductionSandboxControl(options);
  const preparationKey = `sandbox-control:${hash(plan.identity)}:preparation`;
  const sealed = {
    version: "sandbox-preparation-sealed.v1",
    identity: plan.identity,
    fingerprint: plan.semanticFingerprint,
    environmentId: plan.environmentId,
    executionLease: plan.executionLease,
    stopRequestedAt: T1,
  };
  const proof = async () =>
    ({
      schemaVersion: "sandbox-reservation-release.v1",
      basis: "preparation_not_authorized",
      identity: plan.identity,
      environmentId: plan.environmentId,
      semanticFingerprint: plan.semanticFingerprint,
      stopRequestedAt: T1,
      checkedAt: T1,
      validUntil: new Date(Date.parse(T1) + 1000).toISOString(),
      evidence: await options.write(plan, preparationKey, sealed),
    }) as unknown as SandboxReservationReleaseVerification;
  const release = (verification: SandboxReservationReleaseVerification) =>
    call("releaseReservation", {
      identity: plan.identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      verification,
    });
  return { f, plan, call, options, controller, control, preparationKey, sealed, proof, release };
}

it("seals before registration, replays identical content and survives a controller restart", async () => {
  const f = await fixture();
  const controller = f.controller();
  await controller.stopPreparation(f.plan, undefined, T1);
  const first = await f.options.read(f.plan, f.preparationKey);
  expect(first?.value).toEqual(f.sealed);
  await f.controller().stopPreparation(f.plan, undefined, T1);
  expect(await f.options.read(f.plan, f.preparationKey)).toEqual(first);
  await expect(
    f.controller().registerPreparation(f.plan, f.control, "b".repeat(64)),
  ).rejects.toThrow();
  const proof = await f.controller().verifyReservationRelease(f.plan, T1);
  expect(proof).toMatchObject({
    basis: "preparation_not_authorized",
    evidence: { ref: first?.ref, digest: first?.digest },
  });
  if (!proof) throw new Error("Expected sealed proof");
  expect(f.release(proof).applied).toBe(true);
  expect(f.release(proof).applied).toBe(false);
  expect(
    f.f.database
      .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
      .pluck()
      .get(),
  ).toBe(0);
});

it("keeps an accepted registration with lost ACK outside the sealed basis", async () => {
  const f = await fixture();
  await f.controller().registerPreparation(f.plan, f.control, "b".repeat(64));
  await expect(f.controller().stopPreparation(f.plan, undefined, T1)).rejects.toThrow();
  await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow();
  expect((await f.options.read(f.plan, f.preparationKey))?.value).toMatchObject({
    version: "sandbox-preparation-control.v1",
  });
  expect(
    f.f.database.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
  ).toBe(0);
});

it("retains the seal across a failed release transaction and releases on a later attempt", async () => {
  const f = await fixture();
  await f.controller().stopPreparation(f.plan, undefined, T1);
  const proof = await f.controller().verifyReservationRelease(f.plan, T1);
  if (!proof) throw new Error("Expected sealed proof");
  f.f.database.exec(
    "CREATE TEMP TRIGGER fail_seal_release BEFORE UPDATE OF released_at ON sandbox_workspace_occupancy BEGIN SELECT RAISE(ABORT,'injected rollback'); END",
  );
  expect(() => f.release(proof)).toThrow("injected rollback");
  expect(
    f.f.database.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
  ).toBe(0);
  await expect(
    f.controller().registerPreparation(f.plan, f.control, "b".repeat(64)),
  ).rejects.toThrow();
  f.f.database.exec("DROP TRIGGER fail_seal_release");
  const retry = await f.controller().verifyReservationRelease(f.plan, T1);
  if (!retry) throw new Error("Expected original seal proof");
  expect(retry.evidence).toEqual(proof.evidence);
  expect(f.release(retry).applied).toBe(true);
});

it("rejects a legacy plan in both the controller and SQLite despite an otherwise matching seal", async () => {
  const f = await fixture(false);
  const proof = await f.proof();
  await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow(
    "SANDBOX_PREPARATION_PROTOCOL_UNAVAILABLE",
  );
  expect(() => f.release(proof)).toThrow("SANDBOX_PREPARATION_PROTOCOL_UNAVAILABLE");
});

it("accepts a matching immutable preparation artifact in the SQLite transaction", async () => {
  const f = await fixture();
  expect(f.release(await f.proof()).applied).toBe(true);
});

it.each(["ref", "digest", "job", "attempt", "fingerprint", "stop"])(
  "rejects mismatched sealed release %s without releasing occupancy",
  async (field) => {
    const f = await fixture();
    const proof = await f.proof();
    const invalid = {
      ...proof,
      ...(field === "ref" ? { evidence: { ...proof.evidence, ref: "other" } } : {}),
      ...(field === "digest" ? { evidence: { ...proof.evidence, digest: "f".repeat(64) } } : {}),
      ...(field === "job" ? { identity: { ...proof.identity, jobId: "other" } } : {}),
      ...(field === "attempt" ? { identity: { ...proof.identity, attemptId: "other" } } : {}),
      ...(field === "fingerprint" ? { semanticFingerprint: `sha256:${"f".repeat(64)}` } : {}),
      ...(field === "stop" ? { stopRequestedAt: "2026-09-04T00:00:00.000Z" } : {}),
    };
    expect(() => f.release(invalid)).toThrow();
    expect(
      f.f.database
        .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
        .pluck()
        .get(),
    ).toBeGreaterThan(0);
  },
);

it("refuses the sealed basis for a container plan even with matching evidence", async () => {
  const f = await fixture(true, "container-test");
  const proof = await f.proof();
  await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow();
  expect(() => f.release(proof)).toThrow();
});

it.each(["job", "attempt", "fingerprint", "environment", "lease", "stop"])(
  "rejects a substituted protected seal field: %s",
  async (field) => {
    const f = await fixture();
    const sealed = {
      ...f.sealed,
      ...(field === "job" ? { identity: { ...f.plan.identity, jobId: "other" } } : {}),
      ...(field === "attempt" ? { identity: { ...f.plan.identity, attemptId: "other" } } : {}),
      ...(field === "fingerprint" ? { fingerprint: `sha256:${"f".repeat(64)}` } : {}),
      ...(field === "environment" ? { environmentId: "other" } : {}),
      ...(field === "lease"
        ? { executionLease: { ...f.plan.executionLease, expectedLeaseRevision: 2 } }
        : {}),
      ...(field === "stop" ? { stopRequestedAt: "2026-09-04T00:00:00.000Z" } : {}),
    };
    await f.options.write(f.plan, f.preparationKey, sealed);
    await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow(
      "SANDBOX_CONTROL_BINDING_CHANGED",
    );
    await expect(f.controller().stopPreparation(f.plan, undefined, T1)).rejects.toThrow();
  },
);

it("falls back to authenticated host verification when registration wins the write race", async () => {
  const f = await fixture();
  const originalRead = f.options.read;
  let race = true;
  const controller = createProductionSandboxControl({
    ...f.options,
    read: async (plan, key) => {
      const prior = await originalRead(plan, key);
      if (race && key === f.preparationKey && !prior) {
        race = false;
        await f.controller().registerPreparation(f.plan, f.control, "b".repeat(64));
      }
      return prior;
    },
  });
  await expect(controller.stopPreparation(f.plan, undefined, T1)).rejects.toThrow();
  expect((await originalRead(f.plan, f.preparationKey))?.value).toMatchObject({
    version: "sandbox-preparation-control.v1",
  });
  await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow();
});

it("prevents a registration that read absence before the seal won its write", async () => {
  const f = await fixture();
  let race = true;
  const controller = createProductionSandboxControl({
    ...f.options,
    read: async (plan, key) => {
      const prior = await f.options.read(plan, key);
      if (race && key === f.preparationKey && !prior) {
        race = false;
        await f.controller().stopPreparation(f.plan, undefined, T1);
      }
      return prior;
    },
  });
  await expect(
    controller.registerPreparation(f.plan, f.control, "b".repeat(64)),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  expect((await f.options.read(f.plan, f.preparationKey))?.value).toEqual(f.sealed);
});

it("does not create a seal when an existing main control artifact is present", async () => {
  const f = await fixture();
  await f.options.write(f.plan, f.preparationKey.replace(/:preparation$/, ""), {
    control: "existing",
  });
  await expect(f.controller().stopPreparation(f.plan, undefined, T1)).rejects.toThrow();
  expect(await f.options.read(f.plan, f.preparationKey)).toBeUndefined();
});
