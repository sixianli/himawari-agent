import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ContextFormationService,
  ContextProjectionService,
  type DataClassification,
  type ModelInvocationAdmissionInput,
  type ProductContextEnvelopeV1,
  type RuntimeEvent,
  type RuntimeProjectionRequest,
  type RuntimeRequest,
  type RuntimeToolDescriptor,
  type RuntimeToolPort,
  SessionTraceRecorder,
  type ThreadContextSnapshot,
} from "@himawari-agent/application";
import {
  createAgentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import { ConfiguredPiModelBindingPort, PiAgentRuntimeAdapter } from "@himawari-agent/runtime-pi";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowAdmission,
  fixtureExecutionLease,
} from "../../packages/runtime-pi/test/helpers/admission.ts";
import { testModelEgress } from "../../packages/runtime-pi/test/helpers/model-egress.ts";

const OWNER_ID = createOwnerId("owner-memory-visible");
const AGENT_ID = createAgentId("agent-memory-visible");
const SESSION_ID = createSessionId("session-memory-visible");
const THREAD_ID = createThreadId("thread-memory-visible");
const NOW = "2026-11-09T07:00:00.000Z";
const HEALTH = "主人对青霉素过敏";
const PASSWORD = "家里 Wi-Fi 密码：Sunflower-8841";
const SEALED = "受限档案内容不得外发";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function readBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type Reply = { readonly text: string } | { readonly tool: string; readonly input: string };

async function loopback(reply: (index: number) => Reply) {
  const bodies: string[] = [];
  const server = createServer(async (incoming, response) => {
    const index = bodies.push(await readBody(incoming)) - 1;
    const answer = reply(index);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta: Record<string, unknown>, finish?: string) =>
      `data: ${JSON.stringify({
        id: `chatcmpl-${index}`,
        model: "group/main",
        choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
        ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
      })}\n\n`;
    if ("tool" in answer) {
      response.write(
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-${index}`,
              type: "function",
              function: { name: answer.tool, arguments: answer.input },
            },
          ],
        }),
      );
      response.write(frame({}, "tool_calls"));
    } else {
      response.write(frame({ role: "assistant", content: answer.text }));
      response.write(frame({}, "stop"));
    }
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies };
}

function world() {
  return createReferenceAdapterSet({
    clock: new ManualClock(NOW),
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
  });
}

async function formedRun(
  runId: RuntimeRequest["runId"],
  memories: readonly { id: string; text: string; classification: DataClassification }[],
  adapters = world(),
  runtimeHistory?: ProductContextEnvelopeV1["runtimeHistory"],
) {
  const put = async (ref: string, text: string, dataClassification: DataClassification) =>
    (await adapters.payload.get(ref)) ??
    adapters.payload.put(
      await adapters.payloadProtector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref,
        dataClassification,
        contentType: "text/plain",
        plaintext: new TextEncoder().encode(text),
        createdAt: NOW,
      }),
    );
  await put("payload-system", "你是 Himawari，主人的个人助手。", "private");
  await put("payload-trigger", "我能吃阿莫西林吗？顺便告诉我家里 Wi-Fi 是什么", "private");
  for (const memory of memories) {
    await put(`payload-${memory.id}`, memory.text, memory.classification);
    await adapters.memory.proposeWrite({
      id: `proposal-${memory.id}`,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      contentRef: `payload-${memory.id}`,
      sourceRef: `source-${memory.id}`,
      searchTerms: ["阿莫西林", "wifi"],
      dataClassification: memory.classification,
      proposedAt: NOW,
    });
    await adapters.memory.commitWrite(`proposal-${memory.id}`, memory.id, NOW);
  }
  const trace = new SessionTraceRecorder({
    trace: adapters.trace,
    artifacts: adapters.runPayloadArtifacts,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock: adapters.clock,
    ids: adapters.ids,
  });
  const formed = await new ContextFormationService({
    memory: adapters.memory,
    trace,
    artifacts: adapters.runPayloadArtifacts,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    clock: adapters.clock,
    ids: adapters.ids,
    ...(runtimeHistory
      ? {
          threads: {
            readContextSnapshot: async () =>
              ({
                thread: { id: THREAD_ID },
                messages: [],
                runStates: [],
                runtimeHistory,
                sourceWatermark: 0,
              }) as unknown as ThreadContextSnapshot,
          },
        }
      : {}),
  }).form({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId,
    trigger: {
      id: "trigger-visible",
      sourceType: "user_message",
      payloadRef: "payload-trigger",
      occurredAt: NOW,
    },
    threadMessages: [],
    sourceWatermark: null,
    policyVersion: "policy-visible-v1",
    policies: [],
    memoryQueryRef: "payload-trigger",
    memoryQueryTerms: ["阿莫西林", "wifi"],
    memoryLimit: 10,
    capabilities: [],
    correlationId: "correlation-visible",
    causationId: "trigger-visible",
    parentEventId: null,
    actorId: "agent-service",
    dataClassification: "private",
  });
  const projection = new ContextProjectionService({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threads: { readCommittedMessagesByIds: async () => [] },
    checkpoints: { read: async () => undefined },
    payloads: adapters.payload,
    artifacts: adapters.runPayloadArtifacts,
    protector: adapters.payloadProtector,
    clock: adapters.clock,
    ids: adapters.ids,
  });
  const request: RuntimeProjectionRequest = {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    systemInstructionRef: "payload-system",
    contextEnvelopeRef: formed.contextEnvelopeRef,
    workerResultRefs: [],
    dataClassification: "private",
  };
  return { adapters, formed, projection, request };
}

class RecallTools implements RuntimeToolPort {
  readonly classification: DataClassification | undefined;

  constructor(classification: DataClassification | undefined) {
    this.classification = classification;
  }

  async preflight() {
    return { allowed: true, permissionDecisionRef: "permission", reasonCode: "grant_allows" };
  }

  async execute() {
    return {
      outcome: "succeeded" as const,
      resultRef: "payload-recall",
      errorCode: null,
      externalActionId: null,
      modelContent: JSON.stringify({ memories: [{ text: HEALTH, current: true }] }),
      ...(this.classification ? { contentClassification: this.classification } : {}),
    };
  }

  async listAuthorized(): Promise<readonly RuntimeToolDescriptor[]> {
    return [
      {
        capabilityRef: "memory.recall",
        capabilityHandleRef: null,
        name: "recall",
        description: "Recall owner memory",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ];
  }
}

async function runChat(input: {
  readonly allowed: readonly DataClassification[];
  readonly projection: Pick<ContextProjectionService, "resolveProjection"> &
    Partial<Pick<ContextProjectionService, "captureHistory">>;
  readonly runId: RuntimeRequest["runId"];
  readonly reply?: (index: number) => Reply;
  readonly tools?: RuntimeToolPort;
}) {
  const server = await loopback(input.reply ?? (() => ({ text: "不能吃，你对青霉素过敏。" })));
  const admitted: ModelInvocationAdmissionInput["dataClassification"][] = [];
  const saved: DataClassification[] = [];
  const answers: DataClassification[] = [];
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: {
      resolveProjection: (request) => input.projection.resolveProjection(request),
      captureHistory: async (history) => {
        saved.push(history.dataClassification);
        return {
          runId: history.runId,
          operationKey: `snapshot:${history.runId}`,
          payloadRef: `native-${history.runId}`,
          dataClassification: history.dataClassification,
        };
      },
      capture: async () => "captured",
      captureFinalAnswer: async (answer) => {
        answers.push(answer.dataClassification);
        return "final-answer";
      },
      proposeCompaction: async () => "compaction",
    },
    tools: input.tools ?? new RecallTools(undefined),
    models: new ConfiguredPiModelBindingPort({
      descriptors: [
        {
          ref: "loopback-chat",
          routingClass: "primary",
          priority: 1,
          provider: "magpie",
          model: "group/main",
          version: "v1",
          name: "loopback",
          api: "openai-completions",
          baseUrl: server.baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4096,
          capabilities: ["text", "tool_calling"],
          disclosure: "external_remote",
          allowedDataClassifications: input.allowed,
          secretRequirement: {
            secretRef: "k",
            secretVersion: "v1",
            purpose: "model-provider-auth",
          },
        },
      ],
      secretSource: { productionSuitable: true, resolve: async () => "loopback-fixture-key" },
    }),
    cwd: process.cwd(),
    timeZone: "Asia/Tokyo",
    now: () => NOW,
    admission: async (scope) => {
      const gate = allowAdmission(scope);
      return {
        ...gate,
        begin: async (admission) => {
          admitted.push(admission.dataClassification);
          if (!input.allowed.includes(admission.dataClassification))
            throw new Error("Model descriptor does not allow the requested data classification");
          return gate.begin(admission);
        },
      };
    },
    logicalSlot: (run, ordinal) => `${run.runId}:visible:${ordinal}`,
  });
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.run({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: input.runId,
    executionLease: fixtureExecutionLease(),
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    modelRef: "loopback-chat",
    systemInstructionRef: "payload-system",
    contextEnvelopeRef: "unused",
    workerResultRefs: [],
    capabilityHandleRefs: [],
    budget: { maxTurns: 4 },
    correlationId: "correlation-visible",
    dataClassification: "private",
  } as unknown as RuntimeRequest))
    events.push(event);
  return { events, bodies: server.bodies, admitted, saved, answers };
}

describe("[RULE-memory-visible] what is stored as memory reaches the model", () => {
  it("brings a sensitive memory into a private chat, admits the call as sensitive and masks the password", async () => {
    const runId = createRunId("run-visible-sensitive");
    const run = await formedRun(runId, [
      { id: "memory-health", text: HEALTH, classification: "sensitive" },
      { id: "memory-password", text: PASSWORD, classification: "sensitive" },
      { id: "memory-sealed", text: SEALED, classification: "restricted" },
    ]);
    expect(run.formed.selected.map(({ id }) => id).sort()).toEqual([
      "memory-health",
      "memory-password",
    ]);
    const projected = await run.projection.resolveProjection(run.request);
    expect(projected.contentClassification).toBe("sensitive");
    expect(projected.contextBlocks.map(({ content }) => content)).toEqual(
      expect.arrayContaining([HEALTH, PASSWORD]),
    );
    const chat = await runChat({
      allowed: ["public", "private", "sensitive"],
      projection: { resolveProjection: async () => projected },
      runId,
    });
    expect(chat.events.at(-1)?.type).toBe("runtime.completed");
    expect(chat.admitted).toEqual(["sensitive"]);
    expect(chat.saved.every((classification) => classification === "sensitive")).toBe(true);
    const body = chat.bodies.join("\n");
    expect(body).toContain(HEALTH);
    expect(body).not.toContain("Sunflower-8841");
    expect(body).not.toContain(SEALED);
  });

  it("[MEMORY-DATE] writes the memory's date after it in the request, in the configured time zone", async () => {
    const runId = createRunId("run-visible-dated");
    const adapters = world();
    const search = adapters.memory.search.bind(adapters.memory);
    Object.assign(adapters.memory, {
      search: async (request: Parameters<typeof search>[0]) =>
        (await search(request)).map((memory) => ({
          ...memory,
          dates: { recordedAt: "2026-11-08T15:30:00.000Z", validFrom: null, validTo: null },
        })),
    });
    const run = await formedRun(
      runId,
      [{ id: "memory-health", text: HEALTH, classification: "sensitive" }],
      adapters,
    );
    const projected = await run.projection.resolveProjection(run.request);
    expect(projected.contextBlocks.find(({ ref }) => ref === "memory-health")?.dates).toEqual({
      recordedAt: "2026-11-08T15:30:00.000Z",
      validFrom: null,
      validTo: null,
    });
    const chat = await runChat({
      allowed: ["public", "private", "sensitive"],
      projection: { resolveProjection: async () => projected },
      runId,
    });
    expect(chat.events.at(-1)?.type).toBe("runtime.completed");
    expect(chat.bodies.join("\n")).toContain(`${HEALTH}（记于 2026-11-09）`);
  });

  it("REVERSE: a model whose list stops at private refuses the call instead of sending the sensitive memory", async () => {
    const runId = createRunId("run-visible-refused");
    const run = await formedRun(runId, [
      { id: "memory-health", text: HEALTH, classification: "sensitive" },
    ]);
    const projected = await run.projection.resolveProjection(run.request);
    const chat = await runChat({
      allowed: ["public", "private"],
      projection: { resolveProjection: async () => projected },
      runId,
    });
    expect(chat.events.at(-1)?.type).not.toBe("runtime.completed");
    expect(chat.admitted).toEqual(["sensitive"]);
    expect(chat.bodies).toEqual([]);
  });

  it("REVERSE: a chat with only private memories is admitted as private, not raised", async () => {
    const runId = createRunId("run-visible-private");
    const run = await formedRun(runId, [
      { id: "memory-coffee", text: "主人早上喝美式咖啡", classification: "private" },
    ]);
    const projected = await run.projection.resolveProjection(run.request);
    expect(projected.contentClassification).toBe("private");
    const chat = await runChat({
      allowed: ["public", "private"],
      projection: { resolveProjection: async () => projected },
      runId,
    });
    expect(chat.events.at(-1)?.type).toBe("runtime.completed");
    expect(chat.admitted).toEqual(["private"]);
    expect(chat.answers).toEqual(["private"]);
  });

  it("reads a sensitive attachment into the model's view and raises the call, instead of showing it as unreadable", async () => {
    const adapters = world();
    const store = async (
      ref: string,
      text: string,
      dataClassification: DataClassification,
      contentType: string,
    ) =>
      adapters.payload.put(
        await adapters.payloadProtector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification,
          contentType,
          plaintext: new TextEncoder().encode(text),
          createdAt: NOW,
        }),
      );
    await store(
      "payload-report",
      "体检报告：主人对青霉素过敏",
      "sensitive",
      "text/x-himawari-attachment",
    );
    await store(
      "payload-trigger",
      '帮我看看这份报告 <file name="report.txt" ref="payload-report"/>',
      "private",
      "text/plain",
    );
    const runId = createRunId("run-visible-attachment");
    const run = await formedRun(runId, [], adapters);
    const projected = await run.projection.resolveProjection(run.request);
    expect(projected.contentClassification).toBe("sensitive");
    expect(JSON.stringify(projected)).toContain("体检报告：主人对青霉素过敏");
  });

  it("raises the next model call to sensitive once recall returns a sensitive memory, and saves the history at that level", async () => {
    const runId = createRunId("run-visible-recall");
    const run = await formedRun(runId, []);
    const projected = await run.projection.resolveProjection(run.request);
    expect(projected.contentClassification).toBe("private");
    const chat = await runChat({
      allowed: ["public", "private", "sensitive"],
      projection: { resolveProjection: async () => projected },
      runId,
      tools: new RecallTools("sensitive"),
      reply: (index) =>
        index === 0
          ? { tool: "recall", input: JSON.stringify({ query: "过敏" }) }
          : { text: "你对青霉素过敏，不能吃阿莫西林。" },
    });
    expect(chat.events.at(-1)?.type).toBe("runtime.completed");
    expect(chat.admitted).toEqual(["private", "sensitive"]);
    expect(chat.saved.at(-1)).toBe("sensitive");
    expect(chat.answers).toEqual(["sensitive"]);
    expect(chat.bodies[1]).toContain(HEALTH);
  });

  it("keeps a sensitive tool result in the next turn's history instead of dropping or refusing it", async () => {
    const first = createRunId("run-visible-turn-1");
    const run = await formedRun(first, []);
    const reference = await run.projection.captureHistory({
      runId: first,
      dataClassification: "sensitive",
      messages: [
        { role: "user", content: "我对什么过敏？", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "call-0",
          toolName: "recall",
          content: [{ type: "text", text: HEALTH }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    expect(reference.dataClassification).toBe("sensitive");
    const second = createRunId("run-visible-turn-2");
    const next = await formedRun(second, [], run.adapters, {
      reference,
      runState: { runId: first, status: "completed" },
    });
    expect(next.formed.envelope.runtimeHistory?.reference).toEqual(reference);
    const projected = await next.projection.resolveProjection(next.request);
    expect(JSON.stringify(projected.nativeHistory?.messages)).toContain(HEALTH);
    expect(projected.contentClassification).toBe("sensitive");
  });

  it("leaves out the saved runtime history when a failed turn is retried from the thread messages", async () => {
    const first = createRunId("run-fallback-turn-1");
    const run = await formedRun(first, []);
    const reference = await run.projection.captureHistory({
      runId: first,
      dataClassification: "sensitive",
      messages: [
        { role: "user", content: "我对什么过敏？", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "call-0",
          toolName: "recall",
          content: [{ type: "text", text: HEALTH }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    const second = createRunId("run-fallback-turn-2");
    const next = await formedRun(second, [], run.adapters, {
      reference,
      runState: { runId: first, status: "completed" },
    });
    const normal = await next.projection.resolveProjection(next.request);
    expect(normal.nativeHistory).toBeDefined();
    const retried = await next.projection.resolveProjection({
      ...next.request,
      historyFallback: "thread_messages",
    });
    expect(retried.nativeHistory).toBeUndefined();
    expect(JSON.stringify(retried)).not.toContain(HEALTH);
    expect(retried.coveredRunIds).not.toContain(first);
    expect(retried.prompt.content).toBe(normal.prompt.content);
  });
});
