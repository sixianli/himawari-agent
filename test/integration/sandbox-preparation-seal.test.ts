import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  type SandboxExecutionBrokerCommand,
  type SandboxHostBinding,
  type SandboxRuntimeQualification,
  sandboxExecutionReservationSchema,
} from "@himawari-agent/execution-contracts";
import { SqliteRunPayloadArtifactOperations } from "@himawari-agent/persistence-sqlite";
import { claimJobHostLaunch, type JobHostLaunchContext } from "@himawari-agent/runtime-sandbox";
import { afterEach, expect, it, vi } from "vitest";
import { createProductionSandboxControl } from "../../apps/agent-service/src/production-sandbox-control.ts";
import { ProductionSandboxExecutionV2 } from "../../apps/execution-worker/src/production-sandbox-execution-v2.ts";
import type { ProductionPayloadBrokerClient } from "../../apps/execution-worker/src/production-payload-broker-client.ts";
import { sandboxV2Admission } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  RUN_ID,
  SERVICE_AUTHORITY,
  serviceRequest,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";

const workerMocks = vi.hoisted(() => ({ prepare: vi.fn(), policy: vi.fn(), load: vi.fn() }));
vi.mock("@himawari-agent/runtime-sandbox", async (original) => ({
  ...(await original<object>()),
  prepareSandboxJobHost: workerMocks.prepare,
  prepareJobPolicy: workerMocks.policy,
}));
vi.mock("@himawari-agent/platform-node", async (original) => ({
  ...(await original<object>()),
  CapabilityDeploymentSnapshotLoader: class {
    load = workerMocks.load;
  },
  revalidateCapabilityDeploymentSnapshot: async (admitted: unknown) => admitted,
  verifySandboxHost: async () => undefined,
}));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.resetAllMocks();
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(protocol: boolean | "launch-or-block.v2" = true, backendRef = "srt") {
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
    ...(protocol
      ? { preparationProtocol: protocol === true ? ("register-before-host.v1" as const) : protocol }
      : {}),
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
  const root = await realpath(await mkdtemp(`${testTemporaryRoot()}/hma-seal-`));
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
  const metadata = await lstat(directory);
  const launchContext: JobHostLaunchContext = {
    plan,
    control,
    policyDigest: "b".repeat(64),
    directoryDevice: String(metadata.dev),
    directoryInode: String(metadata.ino),
  };
  return {
    f,
    plan,
    call,
    options,
    controller,
    control,
    preparationKey,
    sealed,
    proof,
    release,
    launchContext,
  };
}

it.each(["deadline-reached", "deadline-passed", "cancelled", "closed"] as const)(
  "[R2-D4] releases preparation when %s before registration acknowledgement without launch or replay",
  async (stop) => {
    const f = await fixture("launch-or-block.v2");
    const root = path.dirname(f.control.directory);
    const { plan } = f;
    let now = T1;
    const calls: string[] = [];
    let registeredControl: JobHostLaunchContext["control"] = f.control;
    const controller = f.controller();
    workerMocks.policy.mockResolvedValue({
      policy: { workspace: root, privateDirectory: root },
      compiled: { cwd: root, policyDigest: f.launchContext.policyDigest },
    });
    workerMocks.load.mockResolvedValue({
      snapshot: {
        capabilities: [
          {
            manifest: { ref: plan.capabilityRef, version: plan.capabilityVersion },
            binding: {
              kind: "sandbox",
              value: {
                privateRoot: root,
                hostId: plan.identity.hostId,
                runtimeRoot: "/runtime",
                readOnlyToolchainPaths: [],
                protectedPaths: [],
                roots: [
                  {
                    canonicalRootId: f.f.scope.directoryGrant.canonicalRootId,
                    canonicalPath: root,
                  },
                ],
                executable: { path: "/bin/true" },
                runner: { path: "/runner" },
              },
            },
            qualification: { sandbox: {} },
          },
        ],
      },
    });
    const base = serviceRequest();
    const request = {
      ...base,
      messageId: plan.identity.invocationId,
      authorizationRef: plan.authorizationRef,
      scope: {
        ...base.scope,
        deploymentId: plan.executionLease.deploymentId,
        authorityEpoch: plan.executionLease.authorityEpoch,
        fencingToken: plan.executionLease.fencingToken,
      },
      payload: {
        ...base.payload,
        capabilityId: plan.capabilityRef,
        capabilityVersion: plan.capabilityVersion,
        capabilityHandleRef: plan.handleRef,
        inputRef: plan.inputRef,
        operation: plan.operation,
        deadlineAt: plan.effectiveDeadlineAt,
        resourceCeiling: plan.resourceCeiling,
        sandboxExecution: {
          schemaVersion: "sandbox-execution.v2" as const,
          mode: plan.mode,
          environmentId: plan.environmentId,
          identity: plan.identity,
        },
      },
    };
    const worker = new ProductionSandboxExecutionV2({
      configuration: { capabilityDeployment: {} as never },
      peer: { workerInstanceId: "worker" } as never,
      clock: { now: () => now },
      payloads: {
        readInput: async () => new Uint8Array(),
        sandboxExecution: async (
          _invocation: unknown,
          _identity: unknown,
          command: SandboxExecutionBrokerCommand,
        ) => {
          calls.push(command.kind);
          if (command.kind === "register_preparation_control") {
            registeredControl = command.control;
            await controller.registerPreparation(plan, command.control, command.policyDigest);
            if (stop.startsWith("deadline"))
              now = new Date(
                Date.parse(plan.effectiveDeadlineAt) + (stop === "deadline-passed" ? 1 : 0),
              ).toISOString();
            else if (stop === "closed") void worker.shutdown();
            else
              await worker.cancel({
                ...base,
                type: "work.cancel",
                scope: request.scope,
                payload: {
                  targetRequestId: request.messageId,
                  reasonCode: "RUN_CANCELLED",
                  requestedAt: T1,
                },
              });
          }
          return {
            record: f.call("readAdmission", plan.identity),
            applied: false,
            resolvedScope:
              command.kind === "resolve" ? { scope: f.f.scope, allowedDomains: [] } : null,
            output: null,
          };
        },
      } as unknown as ProductionPayloadBrokerClient,
    });
    cleanups.push(() => worker.shutdown());
    const outcome = await worker.execute(request);
    expect(outcome.outcome).toBe("result_unknown");
    const decisionPath = path.join(registeredControl.directory, "launch-decision.json");
    const beforeStop = await readFile(decisionPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      },
    );
    expect
      .soft(beforeStop === null || JSON.parse(beforeStop).decision.kind === "blocked")
      .toBe(true);
    expect(workerMocks.prepare).not.toHaveBeenCalled();
    await controller.stopPreparation(plan, undefined, T1);
    expect(JSON.parse(await readFile(decisionPath, "utf8"))).toMatchObject({
      decision: { kind: "blocked", stopRequestedAt: T1 },
    });
    const proof = await f.controller().verifyReservationRelease(plan, T1);
    expect(proof).toMatchObject({ basis: "preparation_launch_blocked" });
    if (!proof) throw new Error("Expected blocked launch proof");
    expect(f.release(proof).applied).toBe(true);
    expect(
      f.f.database
        .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
        .pluck()
        .get(),
    ).toBe(0);
    if (stop !== "closed") expect(await worker.execute(request)).toEqual(outcome);
    else expect(() => worker.execute(request)).toThrow("SANDBOX_V2_UNAVAILABLE");
    expect(calls.filter((kind) => kind === "register_preparation_control")).toHaveLength(1);
    expect(calls).not.toContain("bind");
    expect(calls).not.toContain("operation");
    expect(workerMocks.prepare).not.toHaveBeenCalled();
  },
);

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

it("[R2-D4] keeps an old-protocol accepted registration with lost ACK outside the sealed basis", async () => {
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

it("[R2-D4] blocks a late launch after accepted registration and survives controller recreation", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  await f.controller().stopPreparation(f.plan, undefined, T1);
  const decision = await readFile(path.join(f.control.directory, "launch-decision.json"), "utf8");
  expect(JSON.parse(decision)).toMatchObject({
    decision: { kind: "blocked", stopRequestedAt: T1 },
  });
  expect(decision).not.toContain(f.control.token);
  expect(await claimJobHostLaunch(f.launchContext)).toBe(false);
  await f.controller().stopPreparation(f.plan, undefined, T1);
  expect(await readFile(path.join(f.control.directory, "launch-decision.json"), "utf8")).toBe(
    decision,
  );
  const first = await f.controller().verifyReservationRelease(f.plan, T1);
  const again = await f.controller().verifyReservationRelease(f.plan, T1);
  expect(first).toMatchObject({ basis: "preparation_launch_blocked" });
  expect(again?.evidence).toEqual(first?.evidence);
  if (!first) throw new Error("Expected blocked launch proof");
  expect(f.release(first).applied).toBe(true);
  expect(f.release(first).applied).toBe(false);
  expect(
    f.f.database
      .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
      .pluck()
      .get(),
  ).toBe(0);
});

it("[R2-D4] preserves the original pre-registration seal for a new-protocol plan", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().stopPreparation(f.plan, undefined, T1);
  await expect(
    f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest),
  ).rejects.toThrow();
  const proof = await f.controller().verifyReservationRelease(f.plan, T1);
  expect(proof).toMatchObject({ basis: "preparation_not_authorized" });
  if (!proof) throw new Error("Expected pre-registration seal");
  expect(f.release(proof).applied).toBe(true);
});

it.each(["ref", "digest", "stop", "identity"])(
  "[R2-D4] rejects substituted %s in a blocked release transaction",
  async (field) => {
    const f = await fixture("launch-or-block.v2");
    await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
    await f.controller().stopPreparation(f.plan, undefined, T1);
    const proof = await f.controller().verifyReservationRelease(f.plan, T1);
    if (!proof) throw new Error("Expected block proof");
    const changed =
      field === "ref"
        ? { ...proof, evidence: { ...proof.evidence, ref: "other-payload" } }
        : field === "digest"
          ? { ...proof, evidence: { ...proof.evidence, digest: "e".repeat(64) } }
          : field === "stop"
            ? { ...proof, stopRequestedAt: "2026-09-01T00:00:00.000Z" }
            : { ...proof, identity: { ...proof.identity, runId: "other-run" } };
    expect(() => f.release(changed)).toThrow();
    expect(
      f.f.database
        .prepare("SELECT count(*) FROM sandbox_reservation_release_receipts")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      f.f.database
        .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
        .pluck()
        .get(),
    ).toBeGreaterThan(0);
  },
);

it("[R2-D4] refuses the blocked basis for an old plan and never rewrites its accepted registration", async () => {
  const f = await fixture();
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  const original = await f.options.read(f.plan, f.preparationKey);
  await expect(f.controller().stopPreparation(f.plan, undefined, T1)).rejects.toThrow();
  expect(await f.options.read(f.plan, f.preparationKey)).toEqual(original);
  const evidence = await f.options.write(f.plan, `${f.preparationKey}:launch-blocked`, {
    falseClaim: true,
  });
  expect(() =>
    f.release({
      schemaVersion: "sandbox-reservation-release.v1",
      basis: "preparation_launch_blocked",
      identity: f.plan.identity,
      environmentId: f.plan.environmentId,
      semanticFingerprint: f.plan.semanticFingerprint,
      stopRequestedAt: T1,
      checkedAt: T1,
      validUntil: new Date(Date.parse(T1) + 1000).toISOString(),
      evidence,
    }),
  ).toThrow("SANDBOX_PREPARATION_PROTOCOL_UNAVAILABLE");
});

it("[R2-D4] rejects a blocked proof if main Host registration appears before the release transaction", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  await f.controller().stopPreparation(f.plan, undefined, T1);
  const proof = await f.controller().verifyReservationRelease(f.plan, T1);
  if (!proof) throw new Error("Expected blocked proof");
  await f.options.write(f.plan, f.preparationKey.replace(/:preparation$/, ""), {
    conflictingHost: true,
  });
  expect(() => f.release(proof)).toThrow();
  await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow();
  expect(
    f.f.database.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
  ).toBe(0);
});

it("[R2-D4] rejects a blocked proof after the machine boot changes", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  await f.controller().stopPreparation(f.plan, undefined, T1);
  const restarted = createProductionSandboxControl({
    ...f.options,
    machineBootId: async () => "different-machine-boot",
  });
  await expect(restarted.verifyReservationRelease(f.plan, T1)).rejects.toThrow(
    "SANDBOX_PREPARATION_MACHINE_CHANGED",
  );
  expect(
    f.f.database.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
  ).toBe(0);
});

it("[R2-D4] never grants a repeated launch or claims release after launch won", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  expect(await claimJobHostLaunch(f.launchContext)).toBe(true);
  expect(await claimJobHostLaunch(f.launchContext)).toBe(false);
  await expect(f.controller().stopPreparation(f.plan, undefined, T1)).rejects.toThrow();
  await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow();
  expect(
    f.f.database.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
  ).toBe(0);
  expect(
    f.f.database
      .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
      .pluck()
      .get(),
  ).toBeGreaterThan(0);
});

it("[R2-D4] gives exactly one winner to concurrent launch and public stop", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  const [launch, stop] = await Promise.allSettled([
    claimJobHostLaunch(f.launchContext),
    f.controller().stopPreparation(f.plan, undefined, T1),
  ]);
  expect(launch.status).toBe("fulfilled");
  if (launch.status !== "fulfilled") throw new Error("Launch arbitration failed");
  const decision = JSON.parse(
    await readFile(path.join(f.control.directory, "launch-decision.json"), "utf8"),
  );
  if (launch.value) {
    expect(decision.decision.kind).toBe("launch");
    expect(stop.status).toBe("rejected");
    await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow();
  } else {
    expect(decision.decision).toEqual({ kind: "blocked", stopRequestedAt: T1 });
    expect(stop.status).toBe("fulfilled");
    const proof = await f.controller().verifyReservationRelease(f.plan, T1);
    if (!proof) throw new Error("Expected winning stop proof");
    expect(f.release(proof).applied).toBe(true);
  }
});

it("[R2-D4] retains a block across release rollback and does not reacquire launch authority", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  await f.controller().stopPreparation(f.plan, undefined, T1);
  const proof = await f.controller().verifyReservationRelease(f.plan, T1);
  if (!proof) throw new Error("Expected blocked proof");
  f.f.database.exec(
    "CREATE TEMP TRIGGER fail_launch_release BEFORE UPDATE OF released_at ON sandbox_workspace_occupancy BEGIN SELECT RAISE(ABORT,'injected rollback'); END",
  );
  expect(() => f.release(proof)).toThrow("injected rollback");
  expect(await claimJobHostLaunch(f.launchContext)).toBe(false);
  expect(
    f.f.database.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
  ).toBe(0);
  expect(
    f.f.database
      .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
      .pluck()
      .get(),
  ).toBeGreaterThan(0);
  f.f.database.exec("DROP TRIGGER fail_launch_release");
  const retry = await f.controller().verifyReservationRelease(f.plan, T1);
  if (!retry) throw new Error("Expected retained block proof");
  expect(retry.evidence).toEqual(proof.evidence);
  expect(f.release(retry).applied).toBe(true);
});

it("[R2-D4] repairs an interrupted protected block write without permitting late launch", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  const failing = createProductionSandboxControl({
    ...f.options,
    write: async (plan, key, value) => {
      if (key === `${f.preparationKey}:launch-blocked`)
        throw new Error("block artifact interrupted");
      return f.options.write(plan, key, value);
    },
  });
  await expect(failing.stopPreparation(f.plan, undefined, T1)).rejects.toThrow(
    "block artifact interrupted",
  );
  expect(await claimJobHostLaunch(f.launchContext)).toBe(false);
  await f.controller().stopPreparation(f.plan, undefined, T1);
  const proof = await f.controller().verifyReservationRelease(f.plan, T1);
  if (!proof) throw new Error("Expected recovered block proof");
  expect(f.release(proof).applied).toBe(true);
});

it.each(["identity", "environment", "fingerprint", "lease", "session", "token", "policy"])(
  "[R2-D4] rejects a changed %s against the original blocked launch",
  async (field) => {
    const f = await fixture("launch-or-block.v2");
    await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
    await f.controller().stopPreparation(f.plan, undefined, T1);
    const context = structuredClone(f.launchContext);
    const changed: JobHostLaunchContext =
      field === "identity"
        ? {
            ...context,
            plan: { ...context.plan, identity: { ...context.plan.identity, runId: "other-run" } },
          }
        : field === "environment"
          ? { ...context, plan: { ...context.plan, environmentId: "other-environment" } }
          : field === "fingerprint"
            ? {
                ...context,
                plan: { ...context.plan, semanticFingerprint: `sha256:${"c".repeat(64)}` },
              }
            : field === "lease"
              ? {
                  ...context,
                  plan: {
                    ...context.plan,
                    executionLease: {
                      ...context.plan.executionLease,
                      fencingToken: context.plan.executionLease.fencingToken + 1,
                    },
                  },
                }
              : field === "session"
                ? { ...context, control: { ...context.control, sessionId: randomUUID() } }
                : field === "token"
                  ? { ...context, control: { ...context.control, token: "d".repeat(64) } }
                  : { ...context, policyDigest: "e".repeat(64) };
    await expect(claimJobHostLaunch(changed)).rejects.toThrow();
    expect(await claimJobHostLaunch(f.launchContext)).toBe(false);
  },
);

it("[R2-D4] refuses both late launch and release after the original directory is replaced", async () => {
  const f = await fixture("launch-or-block.v2");
  await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
  await f.controller().stopPreparation(f.plan, undefined, T1);
  await rename(f.control.directory, `${f.control.directory}-original`);
  await mkdir(f.control.directory, { mode: 0o700 });
  await expect(claimJobHostLaunch(f.launchContext)).rejects.toThrow(
    "SANDBOX_CONTROL_DIRECTORY_CHANGED",
  );
  await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow(
    "SANDBOX_CONTROL_DIRECTORY_CHANGED",
  );
  expect(
    f.f.database.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
  ).toBe(0);
});

it.each(["truncated", "signature", "symlink", "fifo"])(
  "[R2-D4] refuses a %s launch decision and retains reservation occupancy",
  async (kind) => {
    const f = await fixture("launch-or-block.v2");
    await f.controller().registerPreparation(f.plan, f.control, f.launchContext.policyDigest);
    await f.controller().stopPreparation(f.plan, undefined, T1);
    const filename = path.join(f.control.directory, "launch-decision.json");
    const body = await readFile(filename, "utf8");
    if (kind === "symlink") {
      await rename(filename, `${filename}-original`);
      await symlink(`${filename}-original`, filename);
    } else if (kind === "fifo") {
      await rename(filename, `${filename}-original`);
      execFileSync("mkfifo", [filename]);
    } else {
      await writeFile(
        filename,
        kind === "truncated"
          ? "{"
          : JSON.stringify({ ...JSON.parse(body), signature: "f".repeat(64) }),
      );
    }
    await expect(claimJobHostLaunch(f.launchContext)).rejects.toThrow();
    await expect(f.controller().verifyReservationRelease(f.plan, T1)).rejects.toThrow();
    expect(
      f.f.database
        .prepare("SELECT count(*) FROM sandbox_reservation_release_receipts")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      f.f.database
        .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
        .pluck()
        .get(),
    ).toBeGreaterThan(0);
  },
);

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
