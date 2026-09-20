import { mkdtemp, rm } from "node:fs/promises";
import type { ConsumeCapabilityInvocationInput } from "@himawari-agent/application";
import { PayloadUdsServer } from "@himawari-agent/platform-node";
import { describe, expect, it } from "vitest";
import { ProductionPayloadBrokerHandler } from "../../apps/agent-service/src/production-payload-broker-handler.js";
import { ProductionPayloadBrokerClient } from "../../apps/execution-worker/src/production-payload-broker-client.js";
import {
  OWNER_ID,
  AGENT_ID,
  T1,
  T2,
  SERVICE_AUTHORITY,
  openRepository,
  capability,
  grantApproval,
  grant,
  grantHandle,
  invocation,
  outputPayload,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

describe("current invocation authority over production Payload broker", () => {
  it.each(["grant", "handle", "expiry"] as const)(
    "rejects %s withdrawal without another use or loss of original effects",
    async (mode) => {
      const resource = await openRepository();
      const directory = await mkdtemp("/tmp/hla-");
      let now = T1;
      const common = {
        credential: { tokenRef: "live-authority", tokenValue: "0123456789abcdef0123456789abcdef" },
        agentServiceInstanceId: SERVICE_AUTHORITY.agentServiceInstanceId,
        agentServiceBootId: SERVICE_AUTHORITY.agentServiceBootId,
        authorityEpoch: SERVICE_AUTHORITY.product.authorityEpoch,
        fencingToken: SERVICE_AUTHORITY.product.fencingToken,
        maximumBodyBytes: 16384,
        maximumPayloadBytes: 4096,
        requestTimeoutMs: 3000,
      };
      const authorization = resource.repository.authorizationStore();
      const capabilities = resource.repository.capabilityStore(OWNER_ID, AGENT_ID);
      const receipts = resource.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID);
      const results = resource.repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID);
      const handler = new ProductionPayloadBrokerHandler({
        receipts,
        results,
        payloadsFor: () => {
          throw new Error("Validation must not read payloads");
        },
        protector: {
          protect: async () => {
            throw new Error("unexpected protection");
          },
          unprotect: async () => {
            throw new Error("unexpected disclosure");
          },
          rewrap: async () => {
            throw new Error("unexpected rewrap");
          },
        },
        currentAuthority: () => SERVICE_AUTHORITY,
        clock: { now: () => now },
        ids: { next: () => "authority:test" },
        agentServiceInstanceId: common.agentServiceInstanceId,
        agentServiceBootId: common.agentServiceBootId,
        maximumPayloadBytes: 4096,
        allowedContentTypes: ["application/json"],
      });
      const worker = {
        workerInstanceId: SERVICE_AUTHORITY.workerInstanceId,
        workerBootId: SERVICE_AUTHORITY.workerBootId,
      };
      const server = new PayloadUdsServer({
        ...common,
        runtimeDirectory: directory,
        allowedWorkerIdentities: [worker],
        handler,
      });
      let sequence = 0;
      const client = new ProductionPayloadBrokerClient({
        ...common,
        ...worker,
        socketPath: server.socketPath,
        nextId: () => `authority:${++sequence}`,
      });
      try {
        await capabilities.create(capability());
        const approved = grantApproval();
        const permission = grant();
        await authorization.createApproval(approved);
        await authorization.resolveApproval({
          approvalRequestId: approved.id,
          expectedRevision: 1,
          semanticSnapshotHash: approved.semanticSnapshotHash,
          resolution: "approved",
          decidedAt: T1,
          grant: permission,
        });
        await authorization.consumeGrant({
          grantId: permission.id,
          expectedRevision: 1,
          costMicros: 0,
          consumedAt: T1,
          usageId: "usage:authority-test",
          operation: "read",
        });
        const handle = grantHandle();
        await capabilities.createExecutionHandle(handle);
        const input = invocation({
          handleRef: handle.ref,
          authorizationRef: permission.id,
        }) as unknown as ConsumeCapabilityInvocationInput;
        await receipts.consume(input);
        const identity = { handleRef: handle.ref, invocationId: input.invocationId };
        await server.start();
        await client.connect();
        await client.assertCurrent(identity);
        await client.assertCurrent(identity);
        if (mode === "grant")
          await authorization.revokeGrant(permission.id, T1, "owner_withdrawal", 2);
        else if (mode === "handle") await capabilities.revokeExecutionHandle(handle.ref, T1);
        else now = T2;
        await expect(client.assertCurrent(identity)).rejects.toThrow();
        await expect(client.assertCurrent(identity)).rejects.toThrow();
        const storedGrant = (await authorization.listGrants(OWNER_ID, AGENT_ID)).find(
          ({ id }) => id === permission.id,
        );
        expect(storedGrant?.uses).toBe(1);
        expect(await capabilities.getExecutionHandle(handle.ref)).toMatchObject({ uses: 1 });
        // Withdrawal denies new execution/disclosure, not retention of already produced evidence.
        const lookup = { ...identity, authority: SERVICE_AUTHORITY, now };
        expect(await results.lookupFrozen(lookup)).toMatchObject({
          invocationId: input.invocationId,
        });
        expect(
          await results.observeOutput({
            ...lookup,
            payload: outputPayload(),
            plaintextByteLength: 2,
          }),
        ).toMatchObject({ replayed: false });
        expect(await results.lookupOutput(lookup)).toMatchObject({
          payloadRef: outputPayload().ref,
        });
      } finally {
        client.disconnect();
        await server.stop();
        await resource.repository.close();
        await rm(directory, { recursive: true, force: true });
        await rm(resource.stateRoot, { recursive: true, force: true });
      }
    },
  );
});
