import { createHash } from "node:crypto";
import type { SandboxOperationBinding } from "@himawari-agent/execution-contracts";
import { afterEach, expect, it } from "vitest";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import {
  AGENT_ID,
  OWNER_ID,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const bash: SandboxOperationBinding = {
  operation: "bash",
  mode: "foreground",
  contract: { ref: "bash", version: "1", kind: "command" },
  backendRef: "srt",
  scopeSource: "grant_targets",
  directoryOperations: ["read", "create", "update"],
  network: "grant_targets",
};

it("gives each SRT tool call its own environment, so a later call in the same Run waits for the earlier occupancy", async () => {
  const f = await productionSandboxScope(bash);
  cleanups.push(f.close);
  const secondToolCallId = "tool-bash-second";
  const secondInvocationId = `runtime-tool:${hash([RUN_ID, secondToolCallId])}`;
  await f.persist(`runtime-tool-intent:${hash([RUN_ID, secondToolCallId])}`, {
    request: {
      schemaVersion: "execution.v2",
      kind: "request",
      type: "work.execute",
      messageId: secondInvocationId,
      correlationId: `run:${RUN_ID}`,
      causationId: RUN_ID,
      dataClassification: f.input.dataClassification,
      risk: "high",
      authorizationRef: f.input.authorizationRef,
      scope: f.input.requestScope,
      idempotencyKey: secondInvocationId,
      payload: {
        inputRef: f.input.inputRef,
        capabilityHandleRef: f.input.handleRef,
        capabilityId: f.input.capabilityRef,
        capabilityVersion: f.input.capabilityVersion,
        operation: f.input.operation,
        delegatedContextRefs: f.input.delegatedContextRefs,
        secretRefs: f.input.secretRefs,
        resourceCeiling: f.input.resourceCeiling,
        requestedAt: f.input.requestedAt,
        deadlineAt: f.input.deadlineAt,
      },
    },
  });
  const calls = [
    { input: f.input, call: f.call },
    {
      input: {
        ...f.input,
        invocationId: secondInvocationId,
        idempotencyKey: secondInvocationId,
        receiptRef: `${f.input.receiptRef}-second`,
      },
      call: { ...f.call, toolCallId: secondToolCallId },
    },
  ];
  const prepared = [];
  for (const { input, call } of calls) {
    const admission = await f.services.runtime.prepare(input, call);
    if (!("reservation" in admission)) throw new Error("expected a sandbox-execution.v2 admission");
    prepared.push({ ...admission, invocation: input });
  }
  expect(prepared.map(({ plan }) => plan.identity.runId)).toEqual([RUN_ID, RUN_ID]);
  expect(prepared.map(({ plan }) => plan.environmentId)).toEqual(
    calls.map(({ input }) => `environment:${hash(input.invocationId)}`),
  );
  expect(new Set(prepared.map(({ plan }) => plan.identity.jobId)).size).toBe(2);
  const [first, second] = prepared;
  if (!first || !second) throw new Error("expected two admissions");
  expect((await f.services.brokerV2.preparations.reserve(first)).applied).toBe(true);
  await expect(f.services.brokerV2.preparations.reserve(second)).rejects.toMatchObject({
    code: "PORT_CONFLICT",
    details: { reasonCode: "WORKSPACE_OCCUPIED" },
  });
  expect(
    await f.services.brokerV2.preparations.readAdmissionByInvocation({
      runId: RUN_ID,
      invocationId: secondInvocationId,
    }),
  ).toBeUndefined();
});

it("keeps SRT reservations and task environment leases on one workspace mutually exclusive", async () => {
  const f = await productionSandboxScope(bash);
  cleanups.push(f.close);
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("expected a sandbox-execution.v2 admission");
  const leases = prepared.workspaces.map((claim) => ({ ...claim, ref: `lease:${claim.ref}` }));
  expect(leases.length).toBeGreaterThan(0);
  const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const authorized = { authority: SERVICE_AUTHORITY, now: T1 };
  const reserve = (generation: number) =>
    store.reserve({
      ...authorized,
      runId: RUN_ID,
      hostId: f.host.binding.hostId,
      role: "primary",
      rotationReason: generation === 1 ? "initial" : "failure",
      backendRef: "fake-container",
      envelope: {
        schemaVersion: "execution-envelope.v1",
        directories: leases.map((lease) => ({
          hostId: lease.hostId,
          grantRef: "grant-environment",
          canonicalRootId: lease.canonicalRootId,
          access: lease.access,
          source: {
            authorizationRef: "grant-environment",
            decidedBy: "user",
            delegationListRef: null,
            expiresAt: T2,
          },
        })),
        network: [],
        resources: {
          cpuMillicores: 1000,
          memoryBytes: 536870912,
          maxProcesses: 128,
          privateStorageBytes: 268435456,
        },
      },
      policyDigest: "a".repeat(64),
      imageDigest: "b".repeat(64),
      runnerDigest: "c".repeat(64),
      deadlineAt: T2,
      leases,
      ids: {
        executionJobId: "execution-job-cross-route",
        environmentId: `environment-cross-route-${generation}`,
        createIntentId: `create-cross-route-${generation}`,
      },
    });
  const first = await reserve(1);
  expect(first.applied).toBe(true);
  const occupied = { code: "PORT_CONFLICT", details: { reasonCode: "WORKSPACE_OCCUPIED" } };
  await expect(
    f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input }),
  ).rejects.toMatchObject(occupied);
  await store.requestStop({
    ...authorized,
    environmentId: first.record.identity.environmentId,
    stopIntentId: "stop-cross-route",
    reason: "failure",
    stoppedResourceRefs: [],
  });
  await store.acceptRelease({
    ...authorized,
    environmentId: first.record.identity.environmentId,
    proof: { basis: "create_not_dispatched" },
  });
  expect(
    (await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input })).applied,
  ).toBe(true);
  await expect(reserve(2)).rejects.toMatchObject(occupied);
  expect((await store.readRun(RUN_ID))?.environments.map((item) => item.state)).toEqual([
    "released",
  ]);
});
