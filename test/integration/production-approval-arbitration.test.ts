import { rm } from "node:fs/promises";
import path from "node:path";
import {
  actionIntentFingerprint,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
} from "@himawari-agent/application";
import { createDeviceId, createIdempotencyKey } from "@himawari-agent/domain";
import { type GatewayV2Command, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.ts";
import {
  AGENT_ID,
  grantApproval,
  OWNER_ID,
  openRepository,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const resource = await openRepository(true);
  let now = T1;
  const clock = { now: () => now };
  const repositories = [resource.repository];
  const releases: Array<() => void> = [];
  cleanups.push(async () => {
    for (const release of releases) release();
    for (const repository of repositories.reverse()) await repository.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  });
  const open = async () => {
    for (const repository of repositories.splice(0)) await repository.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot: resource.stateRoot,
      minimumFreeBytes: 0,
      now: clock.now,
    });
    repositories.push(repository);
    return repository;
  };
  const second = resource.repository;
  const base = grantApproval();
  const intent: GovernedActionIntent = {
    ...base.intentSnapshot,
    contractVersion: "authorization.v2",
    threadId: "thread-capability-invocation",
    capabilityVersion: "1.0.0",
    actionKind: "READ",
    targets: [{ type: "workspace", ref: base.intentSnapshot.resourceRef }],
    resourceRefs: [base.intentSnapshot.resourceRef],
    disclosure: "none",
    recipients: [],
    credentialOrAccessChange: false,
    expiresAt: T2,
    modelClassification: { actionKind: "READ", suggestedRisk: "HIGH", reasonCode: "fixture" },
    deterministicFacts: [],
    finalRisk: "HIGH",
  };
  const approval: GovernedApprovalRequest = {
    ...base,
    intentSnapshot: intent,
    semanticSnapshotHash: actionIntentFingerprint(intent),
    recentAuthenticationRequired: true,
    recentAuthenticationRef: null,
    finalRisk: "HIGH",
  };
  await resource.repository.authorizationStore().createApproval(approval);
  let beforeAuthentication = async (_device: string) => {};
  const gateway = (repository: SqliteProductStateRepository) =>
    createProductionApprovalGateway({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      repository,
      authority: () => SERVICE_AUTHORITY.product,
      clock,
      access: { authorize: async () => ({ allowed: true, reasonCode: "TEST_OWNER" }) },
      recentAuthentication: {
        assertRecentAuthentication: async ({ authentication, expectedAuthenticationRef }) => {
          expect(expectedAuthenticationRef).toBe(authentication.authenticationRef);
          await beforeAuthentication(authentication.deviceId);
          return {
            source: "provider_step_up",
            externalSubjectRef: "fixture-owner",
            ownerId: OWNER_ID,
            deviceId: createDeviceId(authentication.deviceId),
            authenticationRef: authentication.authenticationRef,
            authenticatedAt: T1,
            expiresAt: new Date(Date.parse(T2) + 3600000).toISOString(),
          };
        },
      },
    });
  const authentication = (device: string) => ({
    ownerId: OWNER_ID,
    subjectId: OWNER_ID,
    deviceId: createDeviceId(device),
    authenticatedAt: T1,
    authenticationRef: `session:${device}`,
  });
  const command = (device: string, decision: "approved" | "denied", key = device) => {
    const parsed = gatewayV2MessageSchema.parse({
      schemaVersion: "gateway.v2",
      kind: "command",
      type: "approval.respond",
      messageId: `message:${device}`,
      correlationId: "approval-arbitration",
      causationId: null,
      dataClassification: "private",
      risk: "high",
      authorizationRef: "owner-session",
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      authority: SERVICE_AUTHORITY.product,
      actor: { actorType: "owner", actorId: OWNER_ID },
      idempotencyKey: key,
      payload: {
        approvalRequestId: approval.id,
        expectedRevision: 1,
        semanticSnapshotHash: approval.semanticSnapshotHash,
        decision,
        editedPayloadRef: null,
        recentAuthenticationRef: `session:${device}`,
      },
    });
    if (parsed.kind !== "command") throw new Error("Expected command");
    return parsed as Extract<GatewayV2Command, { type: "approval.respond" }>;
  };
  const gateways = [gateway(resource.repository), gateway(second)] as const;
  const request = (index: 0 | 1, device: string, decision: "approved" | "denied", key = device) =>
    gateways[index].request(authentication(device), command(device, decision, key));
  const snapshot = () => {
    const db = new Database(path.join(resource.stateRoot, "product.sqlite"), { readonly: true });
    try {
      return {
        approval: JSON.parse(
          (
            db.prepare("SELECT record_json FROM approval_requests WHERE id=?").get(approval.id) as {
              record_json: string;
            }
          ).record_json,
        ),
        grants: db
          .prepare(
            "SELECT id, record_json FROM grants WHERE json_extract(record_json, '$.sourceApprovalRequestId')=?",
          )
          .all(approval.id),
        run: db.prepare("SELECT status FROM runs WHERE id=?").get(RUN_ID),
        completed: db
          .prepare(
            "SELECT COUNT(*) AS count FROM governance_mutation_receipts WHERE phase='completed'",
          )
          .get(),
      };
    } finally {
      db.close();
    }
  };
  return {
    resource,
    second,
    approval,
    intent,
    open,
    gateway,
    authentication,
    command,
    gateways,
    request,
    snapshot,
    setNow: (value: string) => {
      now = value;
    },
    setGate: (hook: (device: string) => Promise<void>) => {
      beforeAuthentication = hook;
    },
    hold() {
      const entered = deferred();
      const resume = deferred();
      releases.push(resume.resolve);
      beforeAuthentication = async () => {
        entered.resolve();
        await resume.promise;
      };
      return { entered: entered.promise, release: resume.resolve };
    },
    async cancel() {
      const runs = second.runLifecycle(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY.product);
      const current = await runs.readRun(RUN_ID);
      if (!current) throw new Error("Missing real Run");
      return runs.cancelRun({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        authority: SERVICE_AUTHORITY.lease,
        expectedRevision: current.revision,
        idempotencyKey: createIdempotencyKey("cancel-approval-race"),
        commandFingerprint: "cancel-approval-race",
        payloadRef: "restart-prompt",
      });
    },
  };
}

it("accepts a valid production approval and independently reads its one grant", async () => {
  const f = await fixture();
  await expect(f.request(0, "device-one", "approved")).resolves.toMatchObject({ replayed: false });
  expect(f.snapshot()).toMatchObject({
    approval: { status: "approved", revision: 2 },
    completed: { count: 1 },
  });
  expect(f.snapshot().grants).toHaveLength(1);
});

it("arbitrates two devices that both read pending through the production SQLite writer", async () => {
  const f = await fixture();
  const arrived = deferred();
  let count = 0;
  f.setGate(async () => {
    if (++count === 2) arrived.resolve();
    await arrived.promise;
  });
  const results = await Promise.all([
    f.request(0, "device-one", "approved"),
    f.request(1, "device-two", "approved"),
  ]);
  expect(count).toBe(2);
  for (const result of results)
    expect(result).toMatchObject({ resultRef: `approval:${f.approval.id}:revision-2` });
  const before = f.snapshot();
  expect(before).toMatchObject({
    approval: { status: "approved", revision: 2 },
    completed: { count: 2 },
  });
  expect(before.grants).toHaveLength(1);
  f.setGate(async () => {});
  const reopened = await f.open();
  await expect(
    f
      .gateway(reopened)
      .request(f.authentication("device-one"), f.command("device-one", "approved")),
  ).resolves.toMatchObject({ replayed: true });
  expect(f.snapshot()).toEqual(before);
});

it.each(["denied", "cancelled", "expired"] as const)(
  "refuses an in-flight approval after %s wins durable order",
  async (winner) => {
    const f = await fixture();
    const gate = f.hold();
    const pending = f.request(0, "device-one", "approved");
    const settled = Promise.allSettled([pending]);
    await gate.entered;
    if (winner === "denied") await f.request(1, "device-two", "denied");
    else if (winner === "cancelled") await f.cancel();
    else {
      f.setNow(T2);
      await f.second.authorizationStore().resolveApproval({
        approvalRequestId: f.approval.id,
        expectedRevision: 1,
        semanticSnapshotHash: f.approval.semanticSnapshotHash,
        resolution: "expired",
        decidedAt: T2,
        grant: null,
      });
    }
    gate.release();
    const rejectionCode = {
      denied: "PORT_CONFLICT",
      cancelled: "PORT_NOT_AUTHORITATIVE",
      expired: "PORT_INVALID_OPERATION",
    }[winner];
    expect((await settled)[0]).toMatchObject({
      status: "rejected",
      reason: { code: rejectionCode },
    });
    const stored = f.snapshot();
    expect(stored.grants).toHaveLength(0);
    if (winner === "cancelled") expect(stored.run).toEqual({ status: "cancelled" });
    else expect(stored.approval).toMatchObject({ status: winner, revision: 2 });
    const reopened = await f.open();
    await expect(
      f
        .gateway(reopened)
        .request(f.authentication("device-one"), f.command("device-one", "approved")),
    ).rejects.toMatchObject({ code: rejectionCode });
    expect(f.snapshot()).toEqual(stored);
  },
);

it.each(["denied", "cancelled", "expired"] as const)(
  "preserves a committed approval when %s follows without issuing another grant",
  async (later) => {
    const f = await fixture();
    await f.request(0, "device-one", "approved");
    if (later === "denied")
      await expect(f.request(1, "device-two", "denied")).rejects.toMatchObject({
        code: "PORT_CONFLICT",
      });
    else if (later === "cancelled") await f.cancel();
    else f.setNow(T2);
    const before = f.snapshot();
    await f.request(1, "device-one", "approved");
    expect(f.snapshot()).toEqual(before);
    expect(before.approval).toMatchObject({ status: "approved", revision: 2 });
    expect(before.grants).toHaveLength(1);
    if (later === "cancelled") expect(before.run).toEqual({ status: "cancelled" });
    if (later === "expired")
      expect(JSON.parse((before.grants[0] as { record_json: string }).record_json).expiresAt).toBe(
        T2,
      );
  },
);

it("uses server time when an approval expires while authentication is in flight", async () => {
  const f = await fixture();
  const gate = f.hold();
  const settled = Promise.allSettled([f.request(0, "device-one", "approved")]);
  await gate.entered;
  f.setNow(T2);
  gate.release();
  expect((await settled)[0]).toMatchObject({
    status: "rejected",
    reason: { code: "PORT_INVALID_OPERATION" },
  });
  expect(f.snapshot().grants).toHaveLength(0);
  expect(f.snapshot().approval.status).toBe("pending");
});

it("rejects changed scope, snapshot and idempotency identities without deciding another request", async () => {
  const f = await fixture();
  const command = f.command("device-one", "approved");
  const crossThread: GovernedActionIntent = { ...f.intent, threadId: "another-thread" };
  await expect(
    f.gateways[0].request(
      { ...f.authentication("device-one"), subjectId: "other-subject" },
      command,
    ),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(
    f.gateways[0].request(f.authentication("device-one"), {
      ...command,
      scope: { ...command.scope, agentId: "other-agent" },
    }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(
    f.gateways[0].request(f.authentication("device-one"), {
      ...command,
      payload: {
        ...command.payload,
        semanticSnapshotHash: actionIntentFingerprint(crossThread),
      },
    }),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  expect(f.snapshot().approval).toMatchObject({ status: "pending", revision: 1 });
  expect(f.snapshot().grants).toHaveLength(0);
  await expect(f.request(0, "device-one", "approved")).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  await f.request(0, "device-three", "approved");
  const before = f.snapshot();
  await expect(f.request(0, "device-three", "denied")).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  expect(f.snapshot()).toEqual(before);
});

it("acknowledges simultaneous retransmission of the same command without another receipt or grant", async () => {
  const f = await fixture();
  const arrived = deferred();
  let count = 0;
  f.setGate(async () => {
    if (++count === 2) arrived.resolve();
    await arrived.promise;
  });
  const replies = await Promise.all([
    f.request(0, "same-device", "approved", "same-command"),
    f.request(1, "same-device", "approved", "same-command"),
  ]);
  for (const reply of replies)
    expect(reply).toMatchObject({ resultRef: `approval:${f.approval.id}:revision-2` });
  expect(f.snapshot()).toMatchObject({
    approval: { status: "approved", revision: 2 },
    completed: { count: 1 },
  });
  expect(f.snapshot().grants).toHaveLength(1);
});

it.each([-1, 0, 1])("checks the server deadline at expiry offset %i ms", async (offset) => {
  const f = await fixture();
  f.setNow(new Date(Date.parse(T2) + offset).toISOString());
  const result = f.request(0, "device-one", "approved");
  if (offset < 0) {
    await expect(result).resolves.toMatchObject({ replayed: false });
    expect(f.snapshot().grants).toHaveLength(1);
  } else {
    await expect(result).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    expect(f.snapshot().grants).toHaveLength(0);
  }
});

it("keeps the frozen snapshot when the same intent identity is submitted from another thread", async () => {
  const f = await fixture();
  const before = f.snapshot();
  const changed: GovernedActionIntent = { ...f.intent, threadId: "another-thread" };
  await expect(
    f.second.authorizationStore().createApproval({
      ...f.approval,
      intentSnapshot: changed,
      semanticSnapshotHash: actionIntentFingerprint(changed),
    }),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  expect(f.snapshot()).toEqual(before);
});
