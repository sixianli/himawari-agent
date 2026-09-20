import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readThreadExecutionResources } from "../../packages/application/src/services/thread-execution-resources.js";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  openSandboxJournal,
  OWNER_ID,
  AGENT_ID,
  T1,
  T2,
  SERVICE_AUTHORITY,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";
import {
  ThreadExecutionProjection,
  type SandboxExecutionRunInventory,
} from "@himawari-agent/application";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("historical resource display", () => {
  it("authenticates parent tool identity and refuses to call a dispatch CAS actual execution", async () => {
    const f = await openSandboxJournal();
    try {
      const a = sandboxV2Admission(f);
      const threadId = f.plan.identity.threadId;
      if (!threadId) throw new Error("expected thread");
      const { record } = sandboxV2Call(f, "admit", a);
      const scope = { ...f.scope, parentToolCallId: "outer-tool" };
      const payload = await f.protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: f.scopePayload.ref,
        dataClassification: "private",
        contentType: "application/json",
        plaintext: new TextEncoder().encode(JSON.stringify(scope)),
        createdAt: T1,
      });
      const stored = {
        ...record,
        startedAt: T1,
        plan: {
          ...record.plan,
          binding: { ...record.plan.binding, scopeDigest: payload.contentDigest.slice(7) },
        },
      };
      const inventory: SandboxExecutionRunInventory = {
        legacyResourcesPending: false,
        queue: [],
        admissions: [{ phase: "bound", record: stored }],
      };
      const read = (snapshot = inventory, now = T1) =>
        readThreadExecutionResources({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          threadId: threadId,
          runId: f.plan.identity.runId,
          inventory: snapshot,
          now,
          payloads: { get: async () => payload },
          protector: f.protector,
          digest,
          itemId: (id: string) => `display:${id}`,
        });
      expect(await read()).toMatchObject({
        allReleased: false,
        pendingResources: true,
        operations: [{ itemId: "display:outer-tool", phase: "preparing" }],
      });
      const recovery = {
        revision: 1,
        owner: "recovery-owner",
        attempts: 1,
        status: "running" as const,
        action: "stop" as const,
        startedAt: T1,
        deadlineAt: new Date(Date.parse(T1) + 1000).toISOString(),
        finishedAt: null,
        reasonCode: "STOP_REQUESTED",
      };
      const stopping: SandboxExecutionRunInventory = {
        ...inventory,
        admissions: [{ phase: "bound", record: { ...stored, recovery } }],
      };
      expect(await read(stopping)).toMatchObject({ phase: "stopping", allReleased: false });
      expect(await read(stopping, recovery.deadlineAt)).toMatchObject({ phase: "unresolved" });
      expect(await read({ ...inventory, admissions: [] })).toMatchObject({ allReleased: false });
      expect(
        await read({ ...inventory, admissions: [], legacyResourcesPending: true }),
      ).toMatchObject({
        allReleased: false,
        phase: "unresolved",
        reasonCode: "LEGACY_RESOURCE_STATE_UNCONFIRMED",
      });
      await expect(
        read({
          ...inventory,
          admissions: [
            {
              phase: "bound",
              record: {
                ...stored,
                plan: {
                  ...stored.plan,
                  identity: { ...stored.plan.identity, threadId: "other-thread" },
                },
              },
            },
          ],
        }),
      ).rejects.toThrow("THREAD_EXECUTION_RESOURCE_SCOPE_MISMATCH");
    } finally {
      await f.close();
    }
  });
});

it("projects the production queue and reservation from SQLite without renewing authority", async () => {
  const { productionSandboxScope } = await import("../fixtures/production-sandbox-scope.ts");
  const f = await productionSandboxScope({
    operation: "bash",
    mode: "foreground",
    contract: { ref: "bash", version: "1", kind: "command" },
    backendRef: "srt",
    scopeSource: "grant_targets",
    directoryOperations: ["read", "create", "update"],
    network: "grant_targets",
  });
  try {
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in prepared)) throw new Error("expected v2");
    const threadId = prepared.plan.identity.threadId;
    const authorizationRef = f.input.authorizationRef;
    if (!threadId || !authorizationRef) throw new Error("expected authorized thread");
    const port = f.services.brokerV2.preparations;
    const readInventory = () => port.readRunInventory({ runId: f.call.runId });
    const read = async (inventory: SandboxExecutionRunInventory, now = T1) =>
      readThreadExecutionResources({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: threadId,
        runId: f.call.runId,
        inventory,
        now,
        payloads: f.repository.payloadStore(OWNER_ID, AGENT_ID),
        protector: f.f.protector,
        digest,
        itemId: (id) => `display:${id}`,
      });
    await port.enqueue({ ...prepared, invocation: f.input });
    const queued = await readInventory();
    expect(await read(queued)).toMatchObject({ phase: "queued", allReleased: false });
    expect(await readInventory()).toEqual(queued);
    await port.reserve({ ...prepared, invocation: f.input });
    const admitted = await readInventory();
    expect(admitted.queue[0]?.status).toBe("admitted");
    const projection = new ThreadExecutionProjection({
      threads: f.repository.threadRepository(),
      trace: f.repository.traceStore(),
      payloads: () => f.repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: f.f.protector,
      resources: { readInventory, now: () => T1, digest },
    });
    expect(
      await projection.readState({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: threadId,
        runId: f.call.runId,
        canCancelRun: true,
      }),
    ).toMatchObject({ displayPhase: "preparing", reasonCode: "RESOURCE_START_UNCONFIRMED" });
    expect(await read(admitted)).toMatchObject({ phase: "preparing", allReleased: false });
    expect((await read(admitted)).operations).toHaveLength(1);
    await expect(
      read({
        ...admitted,
        queue: admitted.queue.map((row) => ({
          ...row,
          plan: { ...row.plan, identity: { ...row.plan.identity, threadId: "wrong-thread" } },
        })),
      }),
    ).rejects.toThrow("THREAD_EXECUTION_RESOURCE_QUEUE_MISMATCH");
    await f.repository.authorizationStore().revokeGrant(authorizationRef, T1, "projection-test");
    expect(await read(admitted)).toMatchObject({ phase: "preparing" });
    await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
    expect(await readInventory()).toEqual(admitted);
    expect(await read(admitted, prepared.plan.effectiveDeadlineAt)).toMatchObject({
      phase: "unresolved",
    });
    const original = admitted.admissions[0];
    if (original?.phase !== "reserved") throw new Error("expected original reservation");
    await port.interruptReservation({
      identity: prepared.plan.identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
    });
    expect(await read(await readInventory())).toMatchObject({
      phase: "unresolved",
      allReleased: false,
    });
    await port.releaseReservation({
      identity: prepared.plan.identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      verification: {
        schemaVersion: "sandbox-reservation-release.v1",
        basis: "host_never_started",
        identity: prepared.plan.identity,
        environmentId: prepared.plan.environmentId,
        semanticFingerprint: original.plan.semanticFingerprint,
        stopRequestedAt: T1,
        checkedAt: T1,
        validUntil: new Date(Date.parse(T1) + 1000).toISOString(),
        processIdentityRef: "job-host-process:original-host",
        controlSessionId: "00000000-0000-4000-8000-000000000001",
        evidence: { ref: "never-started-proof", digest: "a".repeat(64) },
      },
    });
    const released = await readInventory();
    expect(await read(released, T2)).toMatchObject({
      allReleased: true,
      pendingResources: false,
      phase: null,
      operations: [{ phase: "released" }],
    });
    expect(await readInventory()).toEqual(released);
  } finally {
    await f.close();
  }
});
