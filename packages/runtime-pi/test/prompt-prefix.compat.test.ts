import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  RuntimeEvent,
  RuntimeProjection,
  RuntimeProjectionContextBlock,
  RuntimeProjectionPort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";
import { afterEach, describe, expect, it } from "vitest";
import { ConfiguredPiModelBindingPort, PiAgentRuntimeAdapter } from "../src/index.js";
import { allowAdmission, fixtureExecutionLease } from "./helpers/admission.js";
import { testModelEgress } from "./helpers/model-egress.js";
import { findConversationBreak, findPrefixBreak } from "./helpers/prompt-prefix.js";

const NOW = "2026-11-02T00:44:00.000Z";
const CARD = "4111 1111 1111 1111";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

type Reply = { readonly text: string } | { readonly tool: string; readonly input: string };

async function readBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function loopback(reply: (index: number, body: string) => Reply) {
  const bodies: string[] = [];
  const server = createServer(async (incoming, response) => {
    const raw = await readBody(incoming);
    const index = bodies.push(raw) - 1;
    const answer = reply(index, raw);
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

interface Turn {
  readonly prompt: string;
  readonly blocks?: readonly RuntimeProjectionContextBlock[];
  readonly occurredAt?: string;
  readonly systemInstruction?: string;
}

class ConversationProjection implements RuntimeProjectionPort {
  saved: readonly unknown[] = [];
  covered: RuntimeRequest["runId"][] = [];
  turn: Turn = { prompt: "" };
  rewriteSaved: ((messages: readonly unknown[]) => readonly unknown[]) | undefined;

  async resolveProjection(): Promise<RuntimeProjection> {
    return {
      systemInstruction: this.turn.systemInstruction ?? "你是 Himawari，主人的个人助手。",
      history: [],
      ...(this.saved.length > 0
        ? { nativeHistory: { messages: this.saved, coveredRunIds: this.covered } }
        : {}),
      prompt: { id: "prompt", content: this.turn.prompt, occurredAt: this.turn.occurredAt ?? NOW },
      contextBlocks: this.turn.blocks ?? [],
    };
  }

  async captureHistory(input: { runId: RuntimeRequest["runId"]; messages: readonly unknown[] }) {
    const messages = JSON.parse(JSON.stringify(input.messages)) as unknown[];
    this.saved = this.rewriteSaved ? this.rewriteSaved(messages) : messages;
    this.covered = [input.runId];
    return {
      runId: input.runId,
      operationKey: `snapshot:${input.runId}`,
      payloadRef: `native-${input.runId}`,
      dataClassification: "private" as const,
    };
  }

  async capture(): Promise<string> {
    return "captured";
  }

  async captureFinalAnswer(): Promise<string> {
    return "final-answer";
  }

  async proposeCompaction(): Promise<string> {
    return "compaction";
  }
}

class SearchTools implements RuntimeToolPort {
  async preflight() {
    return { allowed: true, permissionDecisionRef: "permission", reasonCode: "grant_allows" };
  }

  async execute() {
    return {
      outcome: "succeeded" as const,
      resultRef: "payload-tool-result",
      errorCode: null,
      externalActionId: null,
      modelContent: "搜索结果：傍晚阴天，降水概率 30%。",
    };
  }

  async listAuthorized(): Promise<readonly RuntimeToolDescriptor[]> {
    return [
      {
        capabilityRef: "web-search",
        capabilityHandleRef: "handle-web-search",
        name: "web_search",
        description: "Search the web",
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

function runRequest(runId: string): RuntimeRequest {
  return {
    ownerId: "owner-prefix",
    agentId: "agent-prefix",
    runId,
    executionLease: fixtureExecutionLease(),
    sessionId: "session-prefix",
    threadId: "thread-prefix",
    modelRef: "loopback-primary",
    systemInstructionRef: "payload-system",
    contextEnvelopeRef: "payload-context",
    workerResultRefs: [],
    capabilityHandleRefs: ["handle-web-search"],
    budget: { maxTurns: 4 },
    correlationId: "correlation-prefix",
    dataClassification: "private",
  } as unknown as RuntimeRequest;
}

async function conversation(
  turns: readonly Turn[],
  reply: (index: number, body: string) => Reply,
  configure: (projection: ConversationProjection) => void = () => undefined,
) {
  const server = await loopback(reply);
  const models = new ConfiguredPiModelBindingPort({
    descriptors: [
      {
        ref: "loopback-primary",
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
        allowedDataClassifications: ["public", "private"],
        secretRequirement: { secretRef: "k", secretVersion: "v1", purpose: "model-provider-auth" },
      },
    ],
    secretSource: { productionSuitable: true, resolve: async () => "loopback-fixture-key" },
  });
  const projection = new ConversationProjection();
  configure(projection);
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools: new SearchTools(),
    models,
    cwd: process.cwd(),
    timeZone: "Asia/Tokyo",
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (run, ordinal) => `${run.runId}:prefix:${ordinal}`,
  });
  const requestsPerTurn: number[] = [];
  for (const [index, turn] of turns.entries()) {
    projection.turn = turn;
    const before = server.bodies.length;
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.run({
      ...runRequest(`run-prefix-${index + 1}`),
      modelRef: "loopback-primary",
    } as RuntimeRequest))
      events.push(event);
    expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("runtime.completed");
    requestsPerTurn.push(server.bodies.length - before);
  }
  return { bodies: server.bodies, requestsPerTurn, projection };
}

const memoryBlock = (content: string, ref = "memory-1"): RuntimeProjectionContextBlock => ({
  authority: "non-authoritative",
  kind: "memory",
  ref,
  content,
  dataClassification: "private",
});

const ownerProfile: RuntimeProjectionContextBlock = {
  authority: "non-authoritative",
  kind: "owner-profile",
  ref: "owner-profile:agent",
  content: "主人档案：\n身份：\n- 主人住在东京都北区。",
  dataClassification: "private",
};

const THREE_TURNS: readonly Turn[] = [
  {
    prompt: "明天是否需要带伞",
    blocks: [ownerProfile, memoryBlock("主人上周问过天气。")],
    occurredAt: "2026-11-02T00:40:00.000Z",
  },
  {
    prompt: "晚上呢?",
    blocks: [ownerProfile, memoryBlock("主人常骑车通勤。", "memory-2")],
    occurredAt: "2026-11-02T00:44:00.000Z",
  },
  {
    prompt: "那周末呢？",
    blocks: [ownerProfile],
    occurredAt: "2026-11-02T00:50:00.000Z",
  },
];

describe("[I-66] PROMPT-PREFIX every request only appends to the one before it", () => {
  it("keeps a plain multi-turn chat with changing time and memories append-only", async () => {
    const { bodies, requestsPerTurn } = await conversation(THREE_TURNS, (index) => ({
      text: `回答${index}`,
    }));
    expect(requestsPerTurn).toEqual([1, 1, 1]);
    expect(findConversationBreak(bodies)).toBeNull();
    expect(bodies[1]).toContain("明天是否需要带伞");
    expect(bodies[1]).toContain("主人住在东京都北区");
    expect(bodies[2]).toContain("2026-11-02 09:50:00");
  });

  it("keeps turns that call tools append-only, inside a turn and across turns", async () => {
    const { bodies, requestsPerTurn } = await conversation(THREE_TURNS, (index, body) => {
      const lastRole = (JSON.parse(body).messages as { role: string }[]).at(-1)?.role;
      return lastRole === "tool"
        ? { text: `回答${index}` }
        : { tool: "web_search", input: JSON.stringify({ query: `查询${index}` }) };
    });
    expect(requestsPerTurn).toEqual([2, 2, 2]);
    expect(findConversationBreak(bodies)).toBeNull();
    expect(bodies[2]).toContain("搜索结果：傍晚阴天");
  });

  it("keeps a turn that carries a bank card number append-only after redaction", async () => {
    const { bodies } = await conversation(
      [
        { prompt: `我的卡号 ${CARD}，帮我记着`, blocks: [ownerProfile] },
        { prompt: "刚才那张卡是什么类型？", blocks: [ownerProfile] },
        { prompt: "谢谢", blocks: [ownerProfile] },
      ],
      (index) => ({ text: `回答${index}` }),
    );
    expect(bodies.join("")).not.toContain(CARD);
    expect(findConversationBreak(bodies)).toBeNull();
  });

  it("keeps long attachment text and many memories append-only", async () => {
    const attachment = `<file name="报告.txt" ref="payload:1"/>\n${"附件正文第一行。\n".repeat(200)}`;
    const memories = Array.from({ length: 30 }, (_, index) =>
      memoryBlock(`记忆 ${index}：主人的一条长期偏好。`, `memory-${index}`),
    );
    const { bodies } = await conversation(
      [
        { prompt: attachment, blocks: [ownerProfile, ...memories] },
        { prompt: "总结一下", blocks: [ownerProfile, ...memories.slice(10)] },
        { prompt: "再短一点", blocks: [] },
      ],
      (index) => ({ text: `回答${index}` }),
    );
    expect(findConversationBreak(bodies)).toBeNull();
  });

  it("REVERSE: fails when the previous turn's user message is rewritten before it is saved", async () => {
    const { bodies } = await conversation(
      THREE_TURNS,
      (index) => ({ text: `回答${index}` }),
      (projection) => {
        projection.rewriteSaved = (messages) =>
          messages.map((message) => {
            const value = message as { role?: string; content?: unknown };
            if (value.role !== "user") return message;
            return { ...value, content: [{ type: "text", text: "只剩提问" }] };
          });
      },
    );
    const broken = findConversationBreak(bodies);
    expect(broken).toMatchObject({ where: "message-changed", request: 1 });
  });

  it("REVERSE: fails when the system prompt carries a value that changes every turn", async () => {
    const { bodies } = await conversation(
      THREE_TURNS.map((turn, index) => ({
        ...turn,
        systemInstruction: `你是 Himawari。现在是第 ${index} 轮。`,
      })),
      (index) => ({ text: `回答${index}` }),
    );
    expect(findConversationBreak(bodies)).toMatchObject({ where: "message-changed", index: 0 });
  });

  it("REVERSE: the checker reports a deleted, reordered or shortened history", () => {
    const body = (messages: unknown[]) => JSON.stringify({ model: "m", messages, stream: true });
    const a = { role: "user", content: "a" };
    const b = { role: "assistant", content: "b" };
    const c = { role: "user", content: "c" };
    expect(findPrefixBreak(body([a, b]), body([a, b, c]))).toBeNull();
    expect(findPrefixBreak(body([a, b]), body([b, a, c]))).toMatchObject({ index: 0 });
    expect(findPrefixBreak(body([a, b]), body([a]))).toMatchObject({ where: "messages-shortened" });
    expect(findPrefixBreak(body([a, b]), body([a, { ...b, content: "B" }, c]))).toMatchObject({
      index: 1,
    });
  });
});
