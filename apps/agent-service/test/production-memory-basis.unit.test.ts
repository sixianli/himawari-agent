import type { MemoryBasisChainNode } from "@himawari-agent/application";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { expect, it } from "vitest";
import { ProductionMemoryControl } from "../src/production-memory-control.js";

const OWNER_ID = "owner-basis";
const AGENT_ID = "agent-basis";

const envelope = {
  schemaVersion: "gateway.v2",
  messageId: "message",
  correlationId: "correlation",
  causationId: null,
  dataClassification: "private",
  risk: "medium",
  authorizationRef: null,
  scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
  authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
  actor: { actorType: "owner", actorId: OWNER_ID },
  idempotencyKey: "idempotency",
} as const;

const change = (id: string, memoryId: string, action: "merge" | "reflect") =>
  ({
    id,
    consolidationId: "consolidation",
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    memoryId,
    relatedMemoryId: null,
    action,
    beforeRevision: null,
    afterRevision: 1,
    beforeStatus: null,
    beforeSupersededBy: null,
    beforeValidTo: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    undoneAt: null,
  }) as never;

const leaf = (memoryId: string): MemoryBasisChainNode => ({
  memoryId: memoryId as never,
  change: null,
  ledgerId: null,
  basis: [],
  repeated: false,
  truncated: false,
});

function control(
  readBasisChain: (input: unknown) => Promise<MemoryBasisChainNode>,
  installed = true,
) {
  return new ProductionMemoryControl({
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    ...(installed
      ? {
          consolidation: {
            store: { listChanges: async () => [], readBasisChain },
            undo: async () => undefined,
          },
        }
      : {}),
  } as never);
}

const { idempotencyKey: _unused, ...queryEnvelope } = envelope;
const read = (memoryId: string) =>
  ({ ...queryEnvelope, kind: "query", type: "memory.basis.read", payload: { memoryId } }) as never;

it("[P1-2] returns the whole basis chain of a memory as a flat list that passes the gateway contract", async () => {
  const seen: unknown[] = [];
  const root: MemoryBasisChainNode = {
    memoryId: "insight" as never,
    change: change("c2", "insight", "reflect"),
    ledgerId: "ledger:two",
    repeated: false,
    truncated: false,
    basis: [
      {
        memoryId: "merged" as never,
        change: change("c1", "merged", "merge"),
        ledgerId: "ledger:one",
        repeated: false,
        truncated: false,
        basis: [leaf("origin")],
      },
      leaf("other"),
    ],
  };
  const snapshot = await control(async (input) => {
    seen.push(input);
    return root;
  }).query(read("insight"));
  expect(seen).toEqual([{ ownerId: OWNER_ID, agentId: AGENT_ID, memoryId: "insight" }]);
  if (snapshot.type !== "memory.basis.snapshot") throw new Error("snapshot");
  expect(snapshot.payload.complete).toBe(true);
  expect(
    snapshot.payload.nodes.map(({ memoryId, basisMemoryIds }) => [memoryId, basisMemoryIds]),
  ).toEqual([
    ["insight", ["merged", "other"]],
    ["merged", ["origin"]],
    ["other", []],
    ["origin", []],
  ]);
  expect(snapshot.payload.nodes[0]).toMatchObject({
    changeId: "c2",
    action: "reflect",
    decisionRecordId: "ledger:two",
  });
  expect(gatewayV2MessageSchema.parse(JSON.parse(JSON.stringify(snapshot))).type).toBe(
    "memory.basis.snapshot",
  );
});

it("[P1-2] says so when a chain is cut at the node limit, and gives a memory without a tidy-up a single bare node", async () => {
  const wide: MemoryBasisChainNode = {
    ...leaf("root"),
    change: change("c1", "root", "reflect"),
    basis: Array.from({ length: 250 }, (_, index) => leaf(`basis-${index}`)),
  };
  const cut = await control(async () => wide).query(read("root"));
  if (cut.type !== "memory.basis.snapshot") throw new Error("snapshot");
  expect(cut.payload.complete).toBe(false);
  expect(cut.payload.nodes).toHaveLength(200);
  const bare = await control(async () => leaf("plain")).query(read("plain"));
  if (bare.type !== "memory.basis.snapshot") throw new Error("snapshot");
  expect(bare.payload).toMatchObject({
    complete: true,
    nodes: [{ memoryId: "plain", changeId: null, action: null, decisionRecordId: null }],
  });
});

it("[P1-2] refuses the read when tidy-up is not installed", async () => {
  await expect(control(async () => leaf("x"), false).query(read("x"))).rejects.toThrow(
    "MEMORY_OPERATION_NOT_INSTALLED",
  );
});

it("[P1-2] reports the chain as incomplete when the store cut a branch short", async () => {
  const cutShort: MemoryBasisChainNode = {
    ...leaf("root"),
    change: change("c1", "root", "reflect"),
    basis: [{ ...leaf("deep"), truncated: true }],
  };
  const snapshot = await control(async () => cutShort).query(read("root"));
  if (snapshot.type !== "memory.basis.snapshot") throw new Error("snapshot");
  expect(snapshot.payload.complete).toBe(false);
  expect(snapshot.payload.nodes).toHaveLength(2);
});
