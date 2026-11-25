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

async function createContext(
  fixture: ReturnType<typeof createFixture>,
  scenario?: { readonly previous: string; readonly current: string; readonly runState: unknown },
  runtimeEnvironment?: string,
  memoryDates?: unknown,
  ownerProfile?: string,
): Promise<string> {
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
        ...(scenario?.runState ? { runState: scenario.runState } : {}),
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
        ...(memoryDates === undefined ? {} : { dates: memoryDates }),
      },
      ...(runtimeEnvironment === undefined
        ? []
        : [
            {
              kind: "runtime-environment" as const,
              ref: "runtime-environment",
              payloadRef: "payload-runtime-environment",
              dataClassification: "private" as const,
            },
          ]),
      ...(ownerProfile === undefined
        ? []
        : [
            {
              kind: "owner-profile" as const,
              ref: "owner-profile:agent",
              payloadRef: "payload-owner-profile",
              dataClassification: "private" as const,
            },
          ]),
    ],
  };
  for (const [ref, text] of [
    ["payload-system", "Base system policy"],
    ["payload-policy-product", "Product policy: answer in Chinese"],
    ["payload-current-prompt", scenario?.current ?? "当前触发问题"],
    ["payload-history-owner", scenario?.previous ?? "之前的用户问题"],
    ["payload-history-system", "历史系统材料"],
    ["payload-memory", "非权威记忆摘要"],
    ["payload-worker-result", "Worker result material"],
    ["payload-runtime-environment", runtimeEnvironment ?? ""],
    ["payload-owner-profile", ownerProfile ?? ""],
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
  it.each([
    ["请写一篇约两千字的学习资料文章。不要调用工具。", "现在的天气怎么样？"],
    ["仅调用 bash 执行 sleep 30。", "仅使用 read 读取验收文件，不要运行命令。"],
  ])(
    "marks cancelled history as inactive while preserving the new task: %s",
    async (previous, current) => {
      const fixture = createFixture();
      const contextRef = await createContext(fixture, {
        previous,
        current,
        runState: { runId: RUN_ID, status: "cancelled" },
      });
      const projection = await fixture.service.resolveProjection(request(contextRef));
      expect(projection.prompt.content).toBe(current);
      expect(projection.history[0]?.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining(previous) }),
      ]);
      expect(JSON.stringify(projection.history[0]?.content)).toContain("已取消");
      expect(projection.systemInstruction).toContain("不要自动恢复");
      expect(projection.systemInstruction).toContain("最后一条用户消息");
      expect(fixture.messages[0]?.contentRef).toBe("payload-history-owner");
      expect(
        await new ContextProjectionService(fixture.dependencies).resolveProjection(
          request(contextRef),
        ),
      ).toEqual(projection);
    },
  );

  it.each([
    { runId: RUN_ID, status: "invented" },
    { runId: "run-other", status: "cancelled" },
  ])("rejects invalid or mismatched historical run state", async (runState) => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture, { previous: "old", current: "new", runState });
    await expect(fixture.service.resolveProjection(request(contextRef))).rejects.toMatchObject({
      code: "PORT_INVALID_OPERATION",
    });
  });

  it("[MEMORY-DATE] carries a memory block's dates into the projection and refuses a malformed one", async () => {
    const dates = { recordedAt: NOW, validFrom: "2026-01-01", validTo: null };
    const fixture = createFixture();
    const projection = await fixture.service.resolveProjection(
      request(await createContext(fixture, undefined, undefined, dates)),
    );
    expect(projection.contextBlocks.find(({ ref }) => ref === "memory-projection")?.dates).toEqual(
      dates,
    );
    for (const malformed of [
      { recordedAt: "", validFrom: null, validTo: null },
      { recordedAt: NOW, validFrom: 20260101, validTo: null },
      { recordedAt: NOW, validFrom: "下个月", validTo: null },
      { recordedAt: "2026-11-09 08:00", validFrom: null, validTo: null },
      { recordedAt: NOW, validFrom: null },
      { ...dates, note: "改写" },
    ]) {
      const broken = createFixture();
      await expect(
        broken.service.resolveProjection(
          request(await createContext(broken, undefined, undefined, malformed)),
        ),
      ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    }
  });

  it("materializes one protected envelope without mixing policy or worker material into prompt", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture);
    const projection = await fixture.service.resolveProjection(request(contextRef));

    expect(projection.systemInstruction).toContain("Base system policy");
    expect(projection.systemInstruction).toContain("Product policy: answer in Chinese");
    expect(projection.systemInstruction).not.toContain("当前触发问题");
    expect(projection.ownerAttachments).toBeUndefined();
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

  it("[UI-16] expands only attachment Payloads that a message names and keeps a missing one visible", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture, {
      previous: '看看这个\n\n<file name="old.md" ref="payload-attachment-old" bytes="9"/>',
      current:
        '总结报告\n\n<file name="报告.pdf" ref="payload-attachment-report" bytes="2048"/>\n\n<file name="memo.txt" ref="payload-memory" bytes="9"/>\n\n<file name="gone.csv" ref="payload-attachment-gone" bytes="3"/>',
      runState: undefined,
    });
    for (const [ref, text] of [
      ["payload-attachment-report", "第一页：营收增长 12%"],
      ["payload-attachment-old", "旧笔记"],
    ] as const)
      await fixture.adapters.payload.put(
        await fixture.protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification: "private",
          contentType: "text/x-himawari-attachment",
          plaintext: new TextEncoder().encode(text),
          createdAt: NOW,
        }),
      );
    const projection = await fixture.service.resolveProjection(request(contextRef));
    expect(projection.prompt.content).toBe(
      '总结报告\n\n<file name="报告.pdf">\n第一页：营收增长 12%\n</file>\n\n<file name="memo.txt">\n[附件无法读取]\n</file>\n\n<file name="gone.csv">\n[附件无法读取]\n</file>',
    );
    expect(JSON.stringify(projection.history[0]?.content)).toContain(
      '<file name=\\"old.md\\">\\n旧笔记\\n</file>',
    );
    expect(JSON.stringify(projection)).not.toContain("非权威记忆摘要\\n</file>");
    expect(projection.ownerAttachments).toBe(4);
  });

  it("[REPLY] puts the message being replied to in front of the reply and drops a tag whose message is gone", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture, {
      previous:
        '<reply to="message-deleted"/>\n明天去大阪\n\n<file name="行程.md" ref="payload-attachment-trip" bytes="9"/>',
      current: '<reply to="message-context-owner"/>\n几点出发合适？',
      runState: undefined,
    });
    const projection = await fixture.service.resolveProjection(request(contextRef));
    expect(projection.prompt.content).toBe(
      '<reply-to role="user">\n明天去大阪\n\n[附件 行程.md]\n</reply-to>\n\n几点出发合适？',
    );
    expect(JSON.stringify(projection.history[0]?.content)).not.toContain("reply");
    expect(
      await new ContextProjectionService(fixture.dependencies).resolveProjection(
        request(contextRef),
      ),
    ).toEqual(projection);
  });

  it.each([
    ["a message that no longer exists", "message-gone"],
    ["a system message", "message-context-system"],
  ])("[REPLY] quotes nothing when the reply points at %s", async (_case, messageId) => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture, {
      previous: "之前的用户问题",
      current: `<reply to="${messageId}"/>\n几点出发合适？`,
      runState: undefined,
    });
    const projection = await fixture.service.resolveProjection(request(contextRef));
    expect(projection.prompt.content).toBe("几点出发合适？");
    expect(JSON.stringify(projection)).not.toContain("历史系统材料\\n</reply-to>");
  });

  it("[UI-17] hands the images of the current message to the model and leaves older images as names", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture, {
      previous: '<file name="旧图.png" ref="payload-image-old" bytes="9" kind="image"/>',
      current:
        '这两张图有什么不同\n\n<file name="a.png" ref="payload-image-a" bytes="2048" kind="image"/>\n\n<file name="b.jpg" ref="payload-image-b" bytes="1024" kind="image"/>\n\n<file name="c.png" ref="payload-image-text" bytes="3" kind="image"/>',
      runState: undefined,
    });
    for (const [ref, contentType, text] of [
      ["payload-image-a", "text/x-himawari-image", "data:image/png;base64,iVBORw0KGgo="],
      ["payload-image-b", "text/x-himawari-image", "data:image/jpeg;base64,/9j/4AAQ"],
      ["payload-image-old", "text/x-himawari-image", "data:image/png;base64,b2xk"],
      ["payload-image-text", "text/x-himawari-attachment", "不是图片"],
    ] as const)
      await fixture.adapters.payload.put(
        await fixture.protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification: "private",
          contentType,
          plaintext: new TextEncoder().encode(text),
          createdAt: NOW,
        }),
      );
    const projection = await fixture.service.resolveProjection(request(contextRef));
    expect(projection.prompt.content).toBe(
      '这两张图有什么不同\n\n<image name="a.png" index="1"/>\n\n<image name="b.jpg" index="2"/>\n\n<image name="c.png">[附件无法读取]</image>',
    );
    expect(projection.prompt.images).toEqual([
      { mimeType: "image/png", data: "iVBORw0KGgo=" },
      { mimeType: "image/jpeg", data: "/9j/4AAQ" },
    ]);
    expect(JSON.stringify(projection.history[0]?.content)).toContain(
      '<image name=\\"旧图.png\\"/>',
    );
    expect(JSON.stringify(projection.history)).not.toContain("b2xk");
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

  it("projects the runtime environment block with its fixed ref after the other blocks", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(
      fixture,
      undefined,
      "运行环境说明：\n- 工作目录：本轮没有。",
    );
    const projection = await fixture.service.resolveProjection(request(contextRef));
    const blocks = projection.contextBlocks.filter(({ kind }) => kind !== "worker-result");
    expect(blocks.at(-1)).toEqual({
      authority: "non-authoritative",
      kind: "runtime-environment",
      ref: "runtime-environment",
      content: "运行环境说明：\n- 工作目录：本轮没有。",
      dataClassification: "private",
    });
    expect(projection.systemInstruction).not.toContain("工作目录");
  });

  it("[ADR-0286] still projects a run formed before the memory list replaced the owner profile block", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(
      fixture,
      undefined,
      undefined,
      undefined,
      "主人档案：\n- 住在东京",
    );
    const projection = await fixture.service.resolveProjection(request(contextRef));
    expect(projection.contextBlocks.find(({ kind }) => kind === "owner-profile")?.content).toBe(
      "主人档案：\n- 住在东京",
    );
  });

  it("re-materializes the same protected envelope after a projection service restart", async () => {
    const fixture = createFixture();
    const contextRef = await createContext(fixture);
    const first = await fixture.service.resolveProjection(request(contextRef));
    const restarted = new ContextProjectionService(fixture.dependencies);

    await expect(restarted.resolveProjection(request(contextRef))).resolves.toEqual(first);
  });
});
