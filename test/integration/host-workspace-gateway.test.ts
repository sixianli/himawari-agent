import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableHostWorkspaceProjectionAdapter,
  DurableHostWorkspaceStateAdapter,
  FileOperationService,
  HostFileReadService,
  HostWorkspaceGatewayV2ControlPlane,
  HostWorkspaceGatewayV2ReadModel,
  type CommitGateService,
  type GatewayAuthenticationContext,
  type GatewayV2ControlPlanePort,
  type GatewayV2ReadModelPort,
  type GovernanceMutationReceipt,
  type GovernanceMutationReceiptStorePort,
  type WorkspaceService,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  gatewayV2MessageSchema,
  type GatewayV2Command,
  type GatewayV2Query,
} from "@himawari-agent/gateway-contracts";
import { ConstrainedHostFileSystem } from "@himawari-agent/platform-node";
import { InMemoryStateStore } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryReceipts implements GovernanceMutationReceiptStorePort {
  readonly records = new Map<string, GovernanceMutationReceipt>();
  failCompleteOnce = false;
  async get(
    _ownerId: GovernanceMutationReceipt["ownerId"],
    _agentId: GovernanceMutationReceipt["agentId"],
    key: string,
  ) {
    return this.records.get(key);
  }
  async create(receipt: GovernanceMutationReceipt) {
    if (this.records.has(receipt.idempotencyKey)) throw new Error("duplicate");
    this.records.set(receipt.idempotencyKey, receipt);
    return receipt;
  }
  async complete(receipt: GovernanceMutationReceipt, expectedRevision: number) {
    if (this.failCompleteOnce) {
      this.failCompleteOnce = false;
      throw new Error("fixture crash before receipt completion");
    }
    if (this.records.get(receipt.idempotencyKey)?.revision !== expectedRevision)
      throw new Error("conflict");
    this.records.set(receipt.idempotencyKey, receipt);
    return receipt;
  }
}

const ownerId = createOwnerId("owner-host-gateway");
const agentId = createAgentId("agent-host-gateway");
const authentication: GatewayAuthenticationContext = {
  ownerId,
  subjectId: ownerId,
  deviceId: "device-01",
  authenticatedAt: "2026-08-29T00:00:00.000Z",
  authenticationRef: "authentication:recent",
};

function envelope(kind: "command" | "query", type: string) {
  return {
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `message:${type}`,
    correlationId: "correlation:host-gateway",
    causationId: null,
    dataClassification: "private",
    risk: kind === "command" ? "high" : "low",
    authorizationRef: kind === "command" ? "authorization:host-gateway" : null,
    scope: { ownerId, agentId },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: ownerId },
  };
}

function command(type: GatewayV2Command["type"], payload: unknown, key: string): GatewayV2Command {
  const parsed = gatewayV2MessageSchema.parse({
    ...envelope("command", type),
    idempotencyKey: key,
    payload,
  });
  if (parsed.kind !== "command") throw new TypeError("command fixture invalid");
  return parsed;
}

function query(type: GatewayV2Query["type"], payload: unknown): GatewayV2Query {
  const parsed = gatewayV2MessageSchema.parse({ ...envelope("query", type), payload });
  if (parsed.kind !== "query") throw new TypeError("query fixture invalid");
  return parsed;
}

describe("host workspace Gateway v2", () => {
  it("persists prepare/execute projections, verifies Trash, and replays a completed command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-host-gateway-"));
    roots.push(root);
    await writeFile(path.join(root, "note.txt"), "owner-data\n");
    const store = new InMemoryStateStore();
    const state = new DurableHostWorkspaceStateAdapter(store);
    const projections = new DurableHostWorkspaceProjectionAdapter(store);
    const platform = new ConstrainedHostFileSystem();
    let sequence = 0;
    const clock = { now: () => "2026-08-29T00:00:00.000Z" };
    const files = new FileOperationService({
      state,
      platform,
      digest: {
        digest: (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        digestCanonical: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
      },
      clock,
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
      hostId: "host-mac",
    });
    const grant = await files.grant({
      hostId: "host-mac",
      displayPath: root,
      operations: ["read", "trash", "restore"],
      dataClassification: "private",
      disclosure: "model",
      pathPolicy: "same_filesystem_no_links",
      mountPolicy: "fixed_device",
      authorizationRef: "authorization:directory",
      expiresAt: "2026-08-29T01:00:00.000Z",
      revokedAt: null,
    });
    const payloads = new Map([["payload:path", new TextEncoder().encode("note.txt")]]);
    const receipts = new MemoryReceipts();
    const delegateControl: GatewayV2ControlPlanePort = {
      execute: async () => {
        throw new Error("unexpected delegate");
      },
    };
    const delegateReads: GatewayV2ReadModelPort = {
      query: async () => {
        throw new Error("unexpected delegate");
      },
      async *subscribe() {},
    };
    const control = new HostWorkspaceGatewayV2ControlPlane({
      delegate: delegateControl,
      files,
      reads: new HostFileReadService({
        state,
        platform,
        hostId: "host-mac",
        clock,
        disclosure: { protect: async () => "payload:protected-read" },
      }),
      workspaces: {} as WorkspaceService,
      commits: {} as CommitGateService,
      hostState: state,
      workspaceState: state,
      projections,
      payloads: {
        readBytes: async (ref) => payloads.get(ref) ?? new Uint8Array(),
        readText: async (ref) => new TextDecoder().decode(payloads.get(ref)),
        protectJson: async () => "payload:json",
      },
      receipts,
      clock,
      ownerId,
      agentId,
    });
    const prepare = command(
      "host.file.prepare",
      {
        grantId: grant.id,
        expectedGrantRevision: 1,
        operation: "trash",
        relativePathRef: "payload:path",
        destinationPathRef: null,
        candidatePayloadRef: null,
        redactedDiffRef: null,
        irreversibleScopeRef: null,
        expiresAt: "2026-08-29T00:30:00.000Z",
      },
      "host-prepare-01",
    );
    const prepared = await control.execute({ authentication, command: prepare });
    expect((await control.execute({ authentication, command: prepare })).replayed).toBe(true);
    const operation = await state.readPrepared(prepared.resultRef);
    if (!operation) throw new TypeError("prepared operation missing");
    const execute = command(
      "host.file.execute",
      {
        operationPlanRef: operation.id,
        expectedRevision: operation.revision,
        operation: "trash",
        canonicalHash: operation.canonicalHash,
        recentAuthenticationRef: null,
      },
      "host-execute-01",
    );
    receipts.failCompleteOnce = true;
    await expect(control.execute({ authentication, command: execute })).rejects.toThrow(
      "fixture crash before receipt completion",
    );
    const result = await control.execute({ authentication, command: execute });
    expect(result.replayed).toBe(true);
    expect(result.resultRef).toMatch(/^host-trash:/);
    await expect(readFile(path.join(root, "note.txt"))).rejects.toThrow();

    const reads = new HostWorkspaceGatewayV2ReadModel({
      delegate: delegateReads,
      hostState: state,
      workspaceState: state,
      projections,
      clock,
      ownerId,
      agentId,
    });
    const snapshot = await reads.query(query("host.directory.detail", { grantId: grant.id }));
    expect(snapshot).toMatchObject({
      type: "host.directory.snapshot",
      payload: {
        preparedOperationRefs: [operation.id],
        trashRecordRefs: [result.resultRef.replace("host-trash:", "")],
      },
    });
  });
});
