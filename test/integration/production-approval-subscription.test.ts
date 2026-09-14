import { createDeploymentId } from "@himawari-agent/domain";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.js";
import {
  AGENT_ID,
  OWNER_ID,
  T1,
  T2,
  grantApproval,
  openRepository,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

describe("production approval subscription", () => {
  it("distinguishes an uninstalled operation from a denied identity", async () => {
    const resource = await openRepository();
    let allowed = true;
    const authority = {
      deploymentId: createDeploymentId("deployment-test"),
      authorityEpoch: 1,
      fencingToken: 1,
    };
    const gateway = createProductionApprovalGateway({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      repository: resource.repository,
      access: { authorize: async () => ({ allowed, reasonCode: "TEST_OWNER" }) },
      recentAuthentication: {
        assertRecentAuthentication: async () => {
          throw new Error("unused");
        },
      },
      clock: { now: () => T1 },
      authority: () => authority,
    });
    const authentication = {
      ownerId: OWNER_ID,
      subjectId: OWNER_ID,
      deviceId: "device-test",
      authenticatedAt: T1,
      authenticationRef: "session-test",
    };
    const query = {
      schemaVersion: "gateway.v2" as const,
      kind: "query" as const,
      type: "inbox.list" as const,
      messageId: "inbox-query",
      correlationId: "inbox-query",
      causationId: null,
      dataClassification: "private" as const,
      risk: "low" as const,
      authorizationRef: null,
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      authority,
      actor: { actorType: "owner" as const, actorId: OWNER_ID },
      payload: { unreadOnly: false, afterCursor: null, limit: 100 },
    };
    try {
      await expect(gateway.request(authentication, query)).rejects.toMatchObject({
        code: "PORT_OPERATION_NOT_INSTALLED",
      });
      allowed = false;
      await expect(gateway.request(authentication, query)).rejects.toMatchObject({
        code: "PORT_NOT_AUTHORITATIVE",
      });
    } finally {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true, force: true });
    }
  });

  it("stays idle without ending, invalidates after persisted changes, and cancels promptly", async () => {
    const resource = await openRepository();
    const controller = new AbortController();
    let allowed = true;
    let now = T1;
    const gateway = createProductionApprovalGateway({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      repository: resource.repository,
      access: { authorize: async () => ({ allowed, reasonCode: "TEST_OWNER" }) },
      recentAuthentication: {
        assertRecentAuthentication: async () => {
          throw new Error("unused");
        },
      },
      clock: { now: () => now },
      authority: () => ({
        deploymentId: createDeploymentId("deployment-test"),
        authorityEpoch: 1,
        fencingToken: 1,
      }),
    });
    const iterator = gateway
      .subscribe(
        {
          ownerId: OWNER_ID,
          subjectId: OWNER_ID,
          deviceId: "device-test",
          authenticatedAt: T1,
          authenticationRef: "session-test",
        },
        "cursor-before-restart",
        controller.signal,
      )
      [Symbol.asyncIterator]();
    try {
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: { kind: "snapshot_required", scope: { ownerId: OWNER_ID, agentId: AGENT_ID } },
      });
      let settled = false;
      const next = iterator.next().finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(settled).toBe(false);
      await resource.repository.authorizationStore().createApproval(grantApproval());
      expect(await next).toMatchObject({ done: false, value: { kind: "snapshot_required" } });
      now = T2;
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: { kind: "snapshot_required" },
      });
      const idle = iterator.next();
      controller.abort();
      expect(await idle).toEqual({ done: true, value: undefined });
      const revoked = gateway
        .subscribe(
          {
            ownerId: OWNER_ID,
            subjectId: OWNER_ID,
            deviceId: "device-test",
            authenticatedAt: T1,
            authenticationRef: "session-test",
          },
          null,
        )
        [Symbol.asyncIterator]();
      expect((await revoked.next()).done).toBe(false);
      allowed = false;
      await expect(revoked.next()).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    } finally {
      controller.abort();
      await iterator.return?.();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true, force: true });
    }
  });
});
