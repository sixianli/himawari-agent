import {
  ContextProjectionService,
  type RuntimeProjectionRequest,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMessageId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
  type ProductThreadMessage,
} from "@himawari-agent/domain";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-context-projection");
const AGENT_ID = createAgentId("agent-context-projection");
const SESSION_ID = createSessionId("session-context-projection");
const THREAD_ID = createThreadId("thread-context-projection");
const RUN_ID = createRunId("run-context-projection");
const NOW = "2026-09-04T00:00:00.000Z";

function createFixture(
  workerResults: Readonly<Record<string, string>> = {
    "worker-projection": "payload-worker-result",
  },
) {
  const clock = new ManualClock(NOW);
  const adapters = createReferenceAdapterSet({
    clock,
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
  });
  const protector = new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({
      "context-projection-key@v1": new Uint8Array(32).fill(7),
    }),
    activeKey: {
      keyRef: "context-projection-key",
      kekVersion: "v1",
      dekVersion: "v1",
    },
    randomBytes: (length) => new Uint8Array(length).fill(3),
  });
  const messages: ProductThreadMessage[] = [
    {
      id: createMessageId("message-context-owner"),
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      turnId: null,
      runId: RUN_ID,
      sequence: 1,
      role: "owner",
      contentRef: "payload-history-owner",
      dataClassification: "private",
      status: "committed",
      committedAt: NOW,
    },
    {
      id: createMessageId("message-context-system"),
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      turnId: null,
      runId: RUN_ID,
      sequence: 2,
      role: "system",
      contentRef: "payload-history-system",
      dataClassification: "private",
      status: "committed",
      committedAt: NOW,
    },
  ];
  const threads = {
    readCommittedMessagesByIds: async (query: {
      readonly messageIds: readonly ProductThreadMessage["id"][];
    }) => messages.filter((message) => query.messageIds.includes(message.id)),
  };
  const checkpoints = {
    read: async () => ({
      runId: RUN_ID,
      revision: 1,
      checkpoint: {
        phase: "runtime_settled" as const,
        contextRef: "payload-context-envelope",
        workerResults,
        runtimeEventCount: 0,
        lastTraceEventId: null,
        terminalStatus: null,
        output: null,
        diagnosticCode: null,
      },
    }),
  };
  const service = new ContextProjectionService({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threads,
    checkpoints,
    payloads: adapters.payload,
    artifacts: adapters.runPayloadArtifacts,
    protector,
    clock,
    ids: adapters.ids,
  });
  const dependencies = {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threads,
    checkpoints,
    payloads: adapters.payload,
    artifacts: adapters.runPayloadArtifacts,
    protector,
    clock,
    ids: adapters.ids,
  };
  return { adapters, protector, service, messages, dependencies };
}

async function putText(
  fixture: ReturnType<typeof createFixture>,
  ref: string,
  text: string,
): Promise<void> {
  await fixture.adapters.payload.put(
    await fixture.protector.protect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ref,
      dataClassification: "private",
      contentType: "text/plain",
      plaintext: new TextEncoder().encode(text),
      createdAt: NOW,
    }),
  );
}

async function createContext(fixture: ReturnType<typeof createFixture>): Promise<string> {
  const envelope = {
    schemaVersion: "context.v1" as const,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    formedAt: NOW,
    sourceWatermark: 2,
    policyVersion: "context-policy-v1",
    history: [
      {
        messageId: createMessageId("message-context-owner"),
        role: "owner" as const,
        contentRef: "payload-history-owner",
        occurredAt: NOW,
        dataClassification: "private" as const,
      },
      {
        messageId: createMessageId("message-context-system"),
        role: "system" as const,
        contentRef: "payload-history-system",
        occurredAt: NOW,
        dataClassification: "private" as const,
      },
    ],
    prompt: {
      id: "trigger-context-projection",
      sourceType: "user_message" as const,
      payloadRef: "payload-current-prompt",
      occurredAt: NOW,
    },
    systemPolicyRefs: [
      { ref: "policy-product", payloadRef: "payload-policy-product", kind: "policy" as const },
    ],
    contextBlocks: [
      {
        kind: "memory" as const,
        ref: "memory-projection",
        payloadRef: "payload-memory",
        sourceRef: "memory-source",
        dataClassification: "private" as const,
      },
    ],
  };
  for (const [ref, text] of [
    ["payload-system", "Base system policy"],
    ["payload-policy-product", "Product policy: answer in Chinese"],
    ["payload-current-prompt", "当前触发问题"],
    ["payload-history-owner", "之前的用户问题"],
    ["payload-history-system", "历史系统材料"],
    ["payload-memory", "非权威记忆摘要"],
    ["payload-worker-result", "Worker result material"],
  ] as const) {
    await putText(fixture, ref, text);
  }
  const contextRef = "payload-context-envelope";
  const contextPayload = await fixture.protector.protect({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    ref: contextRef,
    dataClassification: "private",
    contentType: "application/json",
    plaintext: new TextEncoder().encode(JSON.stringify(envelope)),
    createdAt: NOW,
  });
  await fixture.adapters.runPayloadArtifacts.commit({
    runId: RUN_ID,
    purpose: "context",
    operationKey: `context:${RUN_ID}`,
    payload: contextPayload,
  });
  return contextRef;
}

function request(contextEnvelopeRef: string): RuntimeProjectionRequest {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    systemInstructionRef: "payload-system",
    contextEnvelopeRef,
    workerResultRefs: [{ workerRunId: "worker-projection", resultRef: "payload-worker-result" }],
    dataClassification: "private",
  };
}

describe("ContextProjectionService", () => {
  it("materializes one protected envelope without mixing policy or worker material into prompt", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture);
    const projection = await fixture.service.resolveProjection(request(contextRef));

    expect(projection.systemInstruction).toContain("Base system policy");
    expect(projection.systemInstruction).toContain("Product policy: answer in Chinese");
    expect(projection.systemInstruction).not.toContain("当前触发问题");
    expect(projection.prompt).toEqual({
      id: "trigger-context-projection",
      content: "当前触发问题",
      occurredAt: NOW,
    });
    expect(projection.history).toMatchObject([{ id: "message-context-owner", role: "user" }]);
    expect(projection.contextBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "system-history", productRole: "system" }),
        expect.objectContaining({ kind: "memory", authority: "non-authoritative" }),
        expect.objectContaining({
          kind: "worker-result",
          sourceRef: "worker-projection",
          authority: "non-authoritative",
        }),
      ]),
    );
  });

  it("fails closed for scope, missing selected message, and deleted Payloads", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture);
    await expect(
      fixture.service.resolveProjection({
        ...request(contextRef),
        ownerId: createOwnerId("owner-other"),
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });

    await fixture.adapters.payload.delete("payload-history-owner");
    await expect(fixture.service.resolveProjection(request(contextRef))).rejects.toMatchObject({
      code: "PORT_NOT_FOUND",
    });

    const missing = createFixture();
    const missingContextRef = await createContext(missing);
    missing.messages.pop();
    await expect(
      missing.service.resolveProjection(request(missingContextRef)),
    ).rejects.toMatchObject({
      code: "PORT_NOT_FOUND",
    });
  });

  it.each([
    ["role", (message: ProductThreadMessage) => ({ ...message, role: "agent" as const })],
    [
      "content reference",
      (message: ProductThreadMessage) => ({ ...message, contentRef: "payload-history-system" }),
    ],
    [
      "occurred time",
      (message: ProductThreadMessage) => ({
        ...message,
        committedAt: "2026-09-04T00:00:01.000Z",
      }),
    ],
  ])("fails closed when a selected message %s changes", async (_field, mutate) => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture);
    const first = fixture.messages[0];
    if (!first) throw new Error("Expected a selected message");
    fixture.messages[0] = mutate(first);

    await expect(fixture.service.resolveProjection(request(contextRef))).rejects.toMatchObject({
      code: "PORT_INVALID_OPERATION",
    });
  });

  it("requires Worker results to be recorded for this Run before projection", async () => {
    const fixture = createFixture({ "worker-other": "payload-worker-result" });
    const contextRef = await createContext(fixture);

    await expect(fixture.service.resolveProjection(request(contextRef))).rejects.toMatchObject({
      code: "PORT_NOT_AUTHORITATIVE",
    });
  });

  it("re-materializes the same protected envelope after a projection service restart", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture);
    const first = await fixture.service.resolveProjection(request(contextRef));
    const restarted = new ContextProjectionService(fixture.dependencies);

    await expect(restarted.resolveProjection(request(contextRef))).resolves.toEqual(first);
  });
});
