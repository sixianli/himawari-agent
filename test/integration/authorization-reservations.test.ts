import { rm } from "node:fs/promises";
import path from "node:path";
import {
  actionIntentFingerprint,
  type ConsumeCapabilityInvocationInput,
  type GovernedActionIntent,
  type GovernedGrantRecord,
  type GovernedCapabilityExecutionHandle,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";
import {
  OWNER_ID,
  AGENT_ID,
  T0,
  T1,
  T2,
  openRepository,
  capability,
  grantApproval,
  grant,
  grantHandle,
  invocation,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

async function fixture(longTerm = false) {
  const resource = await openRepository();
  const store = resource.repository.authorizationStore();
  const capabilities = resource.repository.capabilityStore(OWNER_ID, AGENT_ID);
  await capabilities.create(capability());
  const base = grantApproval();
  const intent: GovernedActionIntent = {
    ...base.intentSnapshot,
    contractVersion: "authorization.v2",
    threadId: "thread-capability-invocation",
    capabilityVersion: "1.0.0",
    actionKind: "READ",
    targets: [{ type: "file", ref: "resource-capability-invocation" }],
    resourceRefs: [base.intentSnapshot.resourceRef],
    disclosure: "none",
    recipients: [],
    credentialOrAccessChange: false,
    expiresAt: T2,
    modelClassification: { actionKind: "READ", suggestedRisk: "LOW", reasonCode: "read" },
    deterministicFacts: [],
    finalRisk: "LOW",
  };
  const approved = {
    ...base,
    intentSnapshot: intent,
    semanticSnapshotHash: actionIntentFingerprint(intent),
  };
  const value: GovernedGrantRecord = {
    ...grant(),
    kind: longTerm ? "long_term" : "one_time",
    intentFingerprint: longTerm ? null : actionIntentFingerprint(intent),
    scope: {
      ...grant().scope,
      exactResourceRef: intent.resourceRef,
      capabilityVersion: "1.0.0",
      resourceIdentities: intent.resourceRefs,
      disclosure: "none",
      recipients: [],
      credentialOrAccessChange: false,
    },
  };
  await store.createApproval(approved);
  await store.resolveApproval({
    approvalRequestId: approved.id,
    expectedRevision: 1,
    semanticSnapshotHash: approved.semanticSnapshotHash,
    resolution: "approved",
    decidedAt: T0,
    grant: value,
  });
  if (
    !store.reserveAuthorization ||
    !store.releaseAuthorization ||
    !capabilities.endRunExecutionHandles
  )
    throw new Error("Fixture requires reservation and termination ports");
  return {
    ...resource,
    store: {
      ...store,
      reserveAuthorization: store.reserveAuthorization,
      releaseAuthorization: store.releaseAuthorization,
    },
    capabilities: { ...capabilities, endRunExecutionHandles: capabilities.endRunExecutionHandles },
    intent,
    grant: value,
    cleanup: async () => {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    },
  };
}

async function reserveAndBind(f: Awaited<ReturnType<typeof fixture>>) {
  const reservation = await f.store.reserveAuthorization({
    grantId: f.grant.id,
    intent: f.intent,
    now: T0,
  });
  const handle: GovernedCapabilityExecutionHandle = {
    ...grantHandle(),
    maxUses: 1,
    maxTotalCostMicros: 0,
  };
  await f.capabilities.createExecutionHandle(handle, {
    authorizationReservationId: reservation.id,
  });
  return { reservation, handle };
}

describe("durable authorization quota lifecycle", () => {
  it("rolls quota and Handle usage back if receipt persistence fails", async () => {
    const f = await fixture();
    const db = openQualifiedDatabase(path.join(f.stateRoot, "product.sqlite"));
    try {
      const { reservation, handle } = await reserveAndBind(f);
      db.exec(
        "CREATE TRIGGER reject_test_receipt BEFORE INSERT ON capability_invocation_receipts BEGIN SELECT RAISE(ABORT, 'test receipt persistence failure'); END",
      );
      const input = invocation({
        handleRef: handle.ref,
        authorizationRef: f.grant.id,
      }) as unknown as ConsumeCapabilityInvocationInput;
      await expect(
        f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID).consume(input),
      ).rejects.toThrow();
      expect(
        db.prepare("SELECT status FROM authorization_reservations WHERE id=?").get(reservation.id),
      ).toEqual({ status: "reserved" });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM authorization_usage WHERE grant_id=?")
          .get(f.grant.id),
      ).toEqual({ count: 0 });
      expect((await f.store.listGrants(OWNER_ID, AGENT_ID))[0]).toMatchObject({ uses: 0 });
      expect(await f.capabilities.getExecutionHandle(handle.ref)).toMatchObject({ uses: 0 });
      db.exec("DROP TRIGGER reject_test_receipt");
      await expect(
        f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID).consume(input),
      ).resolves.toMatchObject({ replayed: false });
    } finally {
      db.close();
      await f.cleanup();
    }
  });
  it("releases unbound and bound reservations when the Run ends", async () => {
    const f = await fixture();
    try {
      const { reservation, handle } = await reserveAndBind(f);
      await f.capabilities.endRunExecutionHandles(f.intent.runId, T1);
      expect(
        await f.store.releaseAuthorization({
          reservationId: reservation.id,
          now: T1,
          reasonCode: "repeat",
        }),
      ).toMatchObject({ status: "released", reasonCode: "run_ended_before_dispatch" });
      expect(await f.capabilities.getExecutionHandle(handle.ref)).toMatchObject({ revokedAt: T1 });
      expect((await f.store.listGrants(OWNER_ID, AGENT_ID))[0]).toMatchObject({ uses: 0 });
    } finally {
      await f.cleanup();
    }
  });
  it("rejects quota commit after revocation and preserves a retry's original snapshot", async () => {
    const f = await fixture();
    try {
      const { handle } = await reserveAndBind(f);
      await expect(
        f.store.reserveAuthorization({
          grantId: f.grant.id,
          intent: { ...f.intent, threadId: "another-thread" },
          now: T1,
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
      await f.store.revokeGrant(f.grant.id, T1, "owner_revoked");
      await expect(
        f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID).consume(
          invocation({
            handleRef: handle.ref,
            authorizationRef: f.grant.id,
          }) as unknown as ConsumeCapabilityInvocationInput,
        ),
      ).rejects.toThrow();
      expect((await f.store.listGrants(OWNER_ID, AGENT_ID))[0]).toMatchObject({ uses: 0 });
    } finally {
      await f.cleanup();
    }
  });
  it("holds one quota through concurrent queue retries without consuming it", async () => {
    const f = await fixture(true);
    try {
      const request = { grantId: f.grant.id, intent: f.intent, now: T0 };
      const values = await Promise.all([
        f.store.reserveAuthorization(request),
        f.store.reserveAuthorization(request),
      ]);
      expect(values[0]).toEqual(values[1]);
      expect((await f.store.listGrants(OWNER_ID, AGENT_ID))[0]).toMatchObject({
        uses: 0,
        spentCostMicros: 0,
      });
      await expect(
        f.store.reserveAuthorization({ ...request, intent: { ...f.intent, id: "competing" } }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
      await expect(
        f.store.consumeGrant({
          grantId: f.grant.id,
          expectedRevision: 1,
          costMicros: 0,
          consumedAt: T0,
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
      await f.store.releaseAuthorization({
        reservationId: values[0].id,
        now: T1,
        reasonCode: "not_dispatched",
      });
      expect(
        await f.store.reserveAuthorization({
          ...request,
          intent: { ...f.intent, id: "next-operation" },
          now: T1,
        }),
      ).toMatchObject({ status: "reserved" });
    } finally {
      await f.cleanup();
    }
  });
  it("withdraws an unused Handle before refunding a not-dispatched reservation", async () => {
    const f = await fixture();
    try {
      const { reservation, handle } = await reserveAndBind(f);
      await f.store.releaseAuthorization({
        reservationId: reservation.id,
        now: T1,
        reasonCode: "not_dispatched",
      });
      expect(await f.capabilities.getExecutionHandle(handle.ref)).toMatchObject({ revokedAt: T1 });
      const port = f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID);
      await expect(
        port.consume(
          invocation({
            handleRef: handle.ref,
            authorizationRef: f.grant.id,
          }) as unknown as ConsumeCapabilityInvocationInput,
        ),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
      expect((await f.store.listGrants(OWNER_ID, AGENT_ID))[0]).toMatchObject({ uses: 0 });
    } finally {
      await f.cleanup();
    }
  });
  it("atomically commits quota with a receipt, survives restart, and refuses an uncertain refund", async () => {
    const f = await fixture();
    try {
      const { reservation, handle } = await reserveAndBind(f);
      const input = invocation({
        handleRef: handle.ref,
        authorizationRef: f.grant.id,
      }) as unknown as ConsumeCapabilityInvocationInput;
      const first = await f.repository
        .capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID)
        .consume(input);
      expect(first).toMatchObject({ replayed: false });
      expect((await f.store.listGrants(OWNER_ID, AGENT_ID))[0]).toMatchObject({ uses: 1 });
      await expect(
        f.store.releaseAuthorization({
          reservationId: reservation.id,
          now: T1,
          reasonCode: "ack_missing",
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
      await f.repository.close();
      const reopened = await SqliteProductStateRepository.open({
        stateRoot: f.stateRoot,
        minimumFreeBytes: 0,
        now: () => T1,
      });
      try {
        expect(
          await reopened.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID).consume(input),
        ).toMatchObject({ replayed: true });
        expect(
          (await reopened.authorizationStore().listGrants(OWNER_ID, AGENT_ID))[0],
        ).toMatchObject({ uses: 1 });
        const db = openQualifiedDatabase(path.join(f.stateRoot, "product.sqlite"));
        try {
          expect(
            db
              .prepare("SELECT status FROM authorization_reservations WHERE id=?")
              .get(reservation.id),
          ).toEqual({ status: "committed" });
          expect(
            db
              .prepare("SELECT COUNT(*) AS count FROM authorization_usage WHERE grant_id=?")
              .get(f.grant.id),
          ).toEqual({ count: 1 });
        } finally {
          db.close();
        }
      } finally {
        await reopened.close();
      }
    } finally {
      await f.cleanup();
    }
  });
});
