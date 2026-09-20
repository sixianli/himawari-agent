import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type {
  CapabilityManifest,
  ConsumeCapabilityInvocationInput,
} from "@himawari-agent/application";
import {
  EphemeralSecretPort,
  NodeCapabilityRuntimePort,
  PayloadUdsServer,
} from "@himawari-agent/platform-node";
import { describe, expect, it } from "vitest";
import { ProductionPayloadBrokerHandler } from "../../apps/agent-service/src/production-payload-broker-handler.js";
import { ProductionPayloadBrokerClient } from "../../apps/execution-worker/src/production-payload-broker-client.js";
import {
  AGENT_ID,
  capability,
  grant,
  grantApproval,
  grantHandle,
  invocation,
  OWNER_ID,
  openRepository,
  outputPayload,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

describe("current invocation authority over production Payload broker", () => {
  it.each(["grant", "handle", "expiry", "readonly-retry", "readonly-revoked"] as const)(
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
        if (mode === "readonly-retry" || mode === "readonly-revoked") {
          await checkReadonlyRetry(
            client,
            identity,
            mode === "readonly-revoked"
              ? () =>
                  authorization
                    .revokeGrant(permission.id, T1, "owner_withdrawal", 2)
                    .then(() => undefined)
              : undefined,
          );
          expect(
            (await authorization.listGrants(OWNER_ID, AGENT_ID)).find(
              ({ id }) => id === permission.id,
            )?.uses,
          ).toBe(1);
          expect(await capabilities.getExecutionHandle(handle.ref)).toMatchObject({ uses: 1 });
          expect(await receipts.consume(input)).toMatchObject({ replayed: true });
          return;
        }
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

/** Real HTTP + production UDS + SQLite authority. Input/output boundary is a
 * controlled provider fixture; this does not claim a full model/Worker run. */
async function checkReadonlyRetry(
  client: ProductionPayloadBrokerClient,
  identity: { handleRef: string; invocationId: string },
  revoke?: () => Promise<void>,
) {
  let calls = 0;
  const methods: string[] = [];
  const http = createServer((request, response) => {
    void (async () => {
      methods.push(request.method ?? "");
      calls++;
      if (calls === 1) {
        await revoke?.();
        response.writeHead(503).end("busy");
      } else response.writeHead(200, { "content-type": "application/json" }).end('{"answer":42}');
    })().catch(() => response.writeHead(500).end());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing fixture listener");
  const declaration = capability().declaration;
  const manifest: CapabilityManifest = {
    ...declaration,
    manifestVersion: "capability.v2",
    source: { type: "adapter", locator: "adapter:readonly-fixture" },
    sourceIdentity: "adapter:readonly-fixture",
    isolation: "remote",
    artifact: {
      digest: declaration.integrity,
      signatureStatus: "verified",
      signerRef: "fixture",
      rollbackArtifactRef: null,
    },
    scopes: {
      network: ["127.0.0.1"],
      filesystem: [],
      secrets: [],
      dataClassifications: ["private"],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: T1 },
    reviewedBy: "owner",
    reviewedAt: T1,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "adapter",
      endpointIdentity: "adapter:readonly-fixture",
      protectedReferenceOnly: true,
    },
  };
  const outputs: string[] = [];
  const runtime = new NodeCapabilityRuntimePort({
    manifests: { listActive: async () => [manifest] },
    invocationAuthority: client,
    bindings: {
      resolveProcess: async () => undefined,
      resolveEndpoint: async () => ({
        endpointIdentity: "adapter:readonly-fixture",
        artifactDigest: declaration.integrity,
        url: `http://127.0.0.1:${address.port}`,
        allowedMethods: ["GET"],
        operations: { read: { method: "GET", path: "/read", secretHeaders: {} } },
        productionSuitable: true,
        allowLoopbackQualification: true,
      }),
    },
    isolation: {
      qualify: async () => {
        throw new Error("unexpected process");
      },
      createLaunch: async () => {
        throw new Error("unexpected process");
      },
    },
    payloads: {
      readInput: async () => new TextEncoder().encode("{}"),
      writeOutput: async (_request, bytes) => {
        outputs.push(new TextDecoder().decode(bytes));
        return "payload:readonly-result";
      },
    },
    secretHandles: new EphemeralSecretPort({
      clock: { now: () => T1 },
      ids: { next: () => "unused" },
    }),
    secretSource: {
      resolve: async () => {
        throw new Error("unexpected secret");
      },
    },
    clock: { now: () => T1 },
  });
  try {
    const events = [];
    for await (const event of runtime.invoke({
      invocationId: identity.invocationId,
      capabilityHandleRef: identity.handleRef,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      capabilityRef: declaration.ref,
      operation: "read",
      inputRef: "payload-input-capability-invocation",
      delegatedContextRefs: ["payload-context-capability-invocation"],
      secretHandleRefs: [],
      dataClassification: "private",
      resourceCeiling: {
        maxWallTimeMs: 1000,
        maxCpuTimeMs: 1000,
        maxMemoryBytes: 1000000,
        maxOutputBytes: 4096,
        maxProgressEvents: 10,
      },
    }))
      events.push(event);
    expect(events).toMatchObject([
      revoke
        ? { type: "capability.failed", errorCode: "CAPABILITY_RUNTIME_AUTHORITY_REJECTED" }
        : { type: "capability.completed" },
    ]);
    expect(calls).toBe(revoke ? 1 : 2);
    expect(methods).toEqual(revoke ? ["GET"] : ["GET", "GET"]);
    expect(outputs).toEqual(revoke ? [] : ['{"answer":42}']);
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
