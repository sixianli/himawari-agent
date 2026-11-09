import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  RuntimeEvent,
  RuntimeProjection,
  RuntimeProjectionContextBlock,
  RuntimeProjectionPort,
  RuntimePromptBundle,
  RuntimePromptBundlePort,
  RuntimePromptBundleResolveInput,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfiguredPiModelBindingPort,
  PiAgentRuntimeAdapter,
  type PiAgentRuntimeAdapterDependencies,
} from "../src/index.js";
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
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "x-magpie-model": `opencode-go/model-${index % 2}`,
    });
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

  async execute(invocation: { readonly capabilityRef: string }) {
    return {
      outcome: "succeeded" as const,
      resultRef: "payload-tool-result",
      errorCode: null,
      externalActionId: null,
      modelContent:
        invocation.capabilityRef === "reminder.set"
          ? '{"created":true,"reminderId":"reminder:a","due":"2026-11-06 15:00（Asia/Tokyo）"}'
          : "搜索结果：傍晚阴天，降水概率 30%。",
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
      {
        capabilityRef: "reminder.set",
        capabilityHandleRef: null,
        name: "reminder_set",
        description: "Set a reminder for the owner",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            due: { type: "string" },
            repeat: { type: "string", enum: ["none", "yearly"] },
          },
          required: ["text", "due"],
          additionalProperties: false,
        },
      },
    ];
  }
}

class FrozenPromptBundles implements RuntimePromptBundlePort {
  frozen: (RuntimePromptBundle & { readonly toolNames: string }) | undefined;
  readonly resolved: RuntimePromptBundleResolveInput[] = [];

  async resolve(input: RuntimePromptBundleResolveInput): Promise<RuntimePromptBundle> {
    this.resolved.push(input);
    const toolNames = JSON.stringify(input.identity.toolNames);
    if (!this.frozen || this.frozen.toolNames !== toolNames)
      this.frozen = {
        generation: (this.frozen?.generation ?? 0) + 1,
        toolNames,
        ...input.candidate,
      };
    return this.frozen;
  }
}

class RulesetPromptBundles extends FrozenPromptBundles {
  readonly #rulesets: readonly number[];

  constructor(rulesets: readonly number[]) {
    super();
    this.#rulesets = rulesets;
  }

  override async resolve(input: RuntimePromptBundleResolveInput): Promise<RuntimePromptBundle> {
    const bundle = await super.resolve(input);
    return {
      ...bundle,
      redactionRuleset:
        this.#rulesets[Math.min(this.resolved.length, this.#rulesets.length) - 1] ?? 2,
    };
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

class TaskHandleTools extends SearchTools {
  override async listAuthorized(runId?: string): Promise<readonly RuntimeToolDescriptor[]> {
    const [, reminder] = await super.listAuthorized();
    const task = (action: string): RuntimeToolDescriptor => ({
      capabilityRef: `execution.task.${action}`,
      capabilityHandleRef: null,
      handleBound: true,
      name: `execution_task_${action}`,
      description: `Task ${action}`,
      parameters: {
        type: "object",
        properties: { resourceRef: { type: "string" } },
        required: ["resourceRef"],
        additionalProperties: false,
      },
    });
    return runId === "run-prefix-2"
      ? [reminder as RuntimeToolDescriptor]
      : [
          reminder as RuntimeToolDescriptor,
          task("status"),
          task("output"),
          task("cancel"),
          task("start"),
        ];
  }
}

async function conversation(
  turns: readonly Turn[],
  reply: (index: number, body: string) => Reply,
  configure: (projection: ConversationProjection) => void = () => undefined,
  dependencies: Partial<PiAgentRuntimeAdapterDependencies> = {},
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
    ...dependencies,
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
    expect(
      bodies.some((body) => body.includes("servedModel") || body.includes("opencode-go/model-")),
    ).toBe(false);
    expect(bodies[1]).toContain("明天是否需要带伞");
    expect(bodies[1]).toContain("主人住在东京都北区");
    expect(bodies[2]).toContain("2026-11-02 09:50:00");
  });

  it("[NAME-1] keeps the conversation append-only when the owner changes how to be addressed mid-conversation", async () => {
    const named = (name: string): RuntimeProjectionContextBlock => ({
      authority: "non-authoritative",
      kind: "owner-rules",
      ref: "owner-rules:agent",
      content: `主人对 Himawari 的要求（主人亲口说过或在设置里填写的，回答时遵守）：\n- 主人在设置里填写的称呼是「${name}」，称呼主人时用它；对话里出现过不同的称呼时，以最后出现的为准。`,
      dataClassification: "private",
    });
    const { bodies } = await conversation(
      [
        { prompt: "早上好", blocks: [named("Andy"), ownerProfile] },
        { prompt: "以后叫我小安", blocks: [named("Andy"), ownerProfile] },
        { prompt: "今天做什么好", blocks: [named("小安"), ownerProfile] },
      ],
      (index) => ({ text: `回答${index}` }),
    );
    expect(findConversationBreak(bodies)).toBeNull();
    const last = (body: string) => JSON.stringify((JSON.parse(body).messages as unknown[]).at(-1));
    expect(last(bodies[0] ?? "")).toContain("称呼是「Andy」");
    expect(last(bodies[2] ?? "")).toContain("称呼是「小安」");
    const third = bodies[2] ?? "";
    expect(third.indexOf("称呼是「Andy」")).toBeGreaterThan(-1);
    expect(third.lastIndexOf("称呼是「小安」")).toBeGreaterThan(
      third.lastIndexOf("称呼是「Andy」"),
    );
    const system = (body: string) =>
      JSON.stringify(
        (JSON.parse(body).messages as { role: string }[]).filter(
          ({ role }) => role === "system" || role === "developer",
        ),
      );
    expect(system(bodies[2] ?? "")).not.toContain("小安");
    expect(system(bodies[0] ?? "")).toBe(system(bodies[2] ?? ""));
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

  it("keeps turns that set a reminder append-only, with the reminder tool listed in every request", async () => {
    const { bodies, requestsPerTurn } = await conversation(THREE_TURNS, (index, body) => {
      const lastRole = (JSON.parse(body).messages as { role: string }[]).at(-1)?.role;
      return lastRole === "tool"
        ? { text: `已设好${index}` }
        : {
            tool: "reminder_set",
            input: JSON.stringify({ text: `交周报${index}`, due: "2026-11-06T15:00" }),
          };
    });
    expect(requestsPerTurn).toEqual([2, 2, 2]);
    expect(findConversationBreak(bodies)).toBeNull();
    for (const body of bodies) {
      const names = (JSON.parse(body).tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      expect(names).toEqual(["web_search", "reminder_set"]);
    }
    expect(bodies[2]).toContain("2026-11-06 15:00（Asia/Tokyo）");
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

  it("[SI-2] records a masked card once per request with the same identity, and sends the same bytes as without recording", async () => {
    const turns = [
      { prompt: `我的卡号 ${CARD}，帮我记着`, blocks: [ownerProfile] },
      { prompt: "刚才那张卡是什么类型？", blocks: [ownerProfile] },
      { prompt: "谢谢", blocks: [ownerProfile] },
    ];
    const reports: { context: unknown; sightings: readonly unknown[] }[] = [];
    const recorded = await conversation(turns, (index) => ({ text: `回答${index}` }), undefined, {
      egress: testModelEgress(undefined, (context, sightings) =>
        reports.push({ context, sightings }),
      ),
    });
    const plain = await conversation(turns, (index) => ({ text: `回答${index}` }));
    expect(recorded.bodies).toEqual(plain.bodies);
    expect(reports).toHaveLength(recorded.bodies.length);
    for (const report of reports) {
      expect(report.context).toEqual({
        ownerId: "owner-prefix",
        agentId: "agent-prefix",
        threadId: "thread-prefix",
        source: "chat",
        purpose: "chat",
      });
      expect(report.sightings).toEqual([reports[0]?.sightings[0]]);
    }
    expect(reports[0]?.sightings[0]).toMatchObject({
      part: "owner_message",
      category: "bank-card",
      ruleId: "bank-card",
    });
    expect(JSON.stringify(reports)).not.toContain(CARD.replaceAll(" ", ""));
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

  it("sends the runtime environment only on the first turn and when it changes, always in the last message", async () => {
    const environment = (workspace: string): RuntimeProjectionContextBlock => ({
      authority: "non-authoritative",
      kind: "runtime-environment",
      ref: "runtime-environment",
      content: `运行环境说明：\n- 工作目录：${workspace}\n以上运行环境说明由 Himawari 系统生成，和系统提示里的规则一样约束本轮的工具使用。`,
      dataClassification: "private",
    });
    const { bodies } = await conversation(
      [
        { prompt: "看看目录", blocks: [ownerProfile, environment("/home/andy/demo。")] },
        { prompt: "再看一次", blocks: [ownerProfile, environment("/home/andy/demo。")] },
        {
          prompt: "现在呢",
          blocks: [ownerProfile, environment("本轮没有。")],
          occurredAt: "2026-11-04T16:00:00.000Z",
        },
      ],
      (index) => ({ text: `回答${index}` }),
    );
    expect(findConversationBreak(bodies)).toBeNull();
    const parsed = bodies.map(
      (body) =>
        JSON.parse(body) as { messages: { role: string; content: unknown }[]; tools?: unknown },
    );
    const last = (index: number) => JSON.stringify(parsed[index]?.messages.at(-1));
    const head = (index: number) =>
      JSON.stringify([
        parsed[index]?.messages.filter(({ role }) => role === "system" || role === "developer"),
        parsed[index]?.tools,
      ]);
    expect(last(0)).toContain("工作目录：/home/andy/demo。");
    expect(last(1)).not.toContain("以上运行环境说明");
    expect(last(1)).not.toContain("工作目录：");
    expect(last(2)).toContain("工作目录：本轮没有。");
    expect(last(2)).toContain("2026-11-05 01:00:00 GMT+09:00，星期四。");
    expect(last(2).indexOf("工作目录：")).toBeGreaterThan(last(2).indexOf("主人档案"));
    expect(last(2).indexOf("以上运行环境说明")).toBeLessThan(
      last(2).indexOf("</himawari-context>"),
    );
    expect(head(0)).toBe(head(2));
    expect(head(0)).not.toContain("/home/andy/demo");
  });

  it("REVERSE: fails when the workspace is written back into the system prompt", async () => {
    const { bodies } = await conversation(
      ["/home/andy/demo", "/home/andy/demo", "没有工作目录"].map((workspace, index) => ({
        prompt: `第${index}轮`,
        blocks: [ownerProfile],
        systemInstruction: `你是 Himawari。工作目录是 ${workspace}。`,
      })),
      (index) => ({ text: `回答${index}` }),
    );
    expect(findConversationBreak(bodies)).toMatchObject({
      where: "message-changed",
      index: 0,
      request: 2,
    });
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

  it("keeps the request head byte-identical when the configured system instruction changes, because the conversation's prompt is frozen", async () => {
    const bundles = new FrozenPromptBundles();
    const { bodies } = await conversation(
      ["请用中文回答。", "请用中文回答，语气更轻松。", "请用中文回答，语气更轻松。"].map(
        (instruction, index) => ({
          prompt: `第${index}轮`,
          blocks: [ownerProfile],
          systemInstruction: `你是 Himawari。${instruction}`,
        }),
      ),
      (index) => ({ text: `回答${index}` }),
      () => undefined,
      { promptBundles: bundles },
    );
    expect(findConversationBreak(bodies)).toBeNull();
    expect(bundles.frozen?.generation).toBe(1);
    expect(bodies[2]).toContain("你是 Himawari。请用中文回答。");
    expect(bodies[2]).not.toContain("语气更轻松");
    expect(bundles.resolved.map(({ identity }) => identity.toolNames)).toEqual([
      ["reminder_set"],
      ["reminder_set"],
      ["reminder_set"],
    ]);
  });

  const WIFI_TURNS: readonly Turn[] = [
    { prompt: "家里 Wi-Fi 密码 abc12345，记一下", blocks: [ownerProfile] },
    { prompt: "刚才那个是什么？", blocks: [ownerProfile] },
    { prompt: "谢谢", blocks: [ownerProfile] },
  ];

  it("[ADR-0188] keeps an old conversation's bytes when the masking rules grow, because its bundle carries the old ruleset", async () => {
    const { bodies } = await conversation(
      WIFI_TURNS,
      (index) => ({ text: `回答${index}` }),
      () => undefined,
      { promptBundles: new RulesetPromptBundles([1, 1, 1]) },
    );
    expect(bodies.every((body) => body.includes("abc12345"))).toBe(true);
    expect(findConversationBreak(bodies)).toBeNull();
  });

  it("[ADR-0188] masks the looser password form from the first turn in a new conversation", async () => {
    const { bodies } = await conversation(
      WIFI_TURNS,
      (index) => ({ text: `回答${index}` }),
      () => undefined,
      { promptBundles: new RulesetPromptBundles([2, 2, 2]) },
    );
    expect(bodies.join("")).not.toContain("abc12345");
    expect(findConversationBreak(bodies)).toBeNull();
  });

  it("[ADR-0188] REVERSE: switching an old conversation to the new ruleset in the middle breaks its prefix", async () => {
    const { bodies } = await conversation(
      WIFI_TURNS,
      (index) => ({ text: `回答${index}` }),
      () => undefined,
      { promptBundles: new RulesetPromptBundles([1, 1, 2]) },
    );
    expect(findConversationBreak(bodies)).not.toBeNull();
  });

  it("REVERSE: the same change breaks the head when the conversation's prompt is not frozen", async () => {
    const { bodies } = await conversation(
      ["请用中文回答。", "请用中文回答，语气更轻松。", "请用中文回答，语气更轻松。"].map(
        (instruction, index) => ({
          prompt: `第${index}轮`,
          blocks: [ownerProfile],
          systemInstruction: `你是 Himawari。${instruction}`,
        }),
      ),
      (index) => ({ text: `回答${index}` }),
    );
    expect(findConversationBreak(bodies)).toMatchObject({
      where: "message-changed",
      index: 0,
      request: 1,
    });
  });

  it("appends tools granted by a handle after the frozen tools and reports them for measurement", async () => {
    const bundles = new FrozenPromptBundles();
    const handles: unknown[] = [];
    const { bodies } = await conversation(
      THREE_TURNS,
      (index) => ({ text: `回答${index}` }),
      () => undefined,
      {
        promptBundles: bundles,
        onHandleTools: (request, observation) => handles.push([request.runId, observation]),
      },
    );
    expect(findConversationBreak(bodies)).toBeNull();
    for (const body of bodies) {
      const names = (JSON.parse(body).tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      expect(names).toEqual(["reminder_set", "web_search"]);
    }
    expect(JSON.parse(bundles.frozen?.tools ?? "[]")).toEqual([
      expect.objectContaining({ name: "reminder_set" }),
    ]);
    expect(handles).toEqual([
      ["run-prefix-1", { generation: 1, handleTools: 1 }],
      ["run-prefix-2", { generation: 1, handleTools: 1 }],
      ["run-prefix-3", { generation: 1, handleTools: 1 }],
    ]);
  });

  it("keeps the frozen tools unchanged when task tools come and go with a task handle", async () => {
    const bundles = new FrozenPromptBundles();
    const handles: unknown[] = [];
    const { bodies } = await conversation(
      THREE_TURNS,
      (index) => ({ text: `回答${index}` }),
      () => undefined,
      {
        tools: new TaskHandleTools(),
        promptBundles: bundles,
        onHandleTools: (request, observation) => handles.push([request.runId, observation]),
      },
    );
    expect(bundles.resolved.map(({ identity }) => identity.toolNames)).toEqual([
      ["reminder_set"],
      ["reminder_set"],
      ["reminder_set"],
    ]);
    expect(bundles.frozen?.generation).toBe(1);
    expect(JSON.parse(bundles.frozen?.tools ?? "[]")).toEqual([
      expect.objectContaining({ name: "reminder_set" }),
    ]);
    const names = bodies.map((body) =>
      (JSON.parse(body).tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      ),
    );
    expect(names[1]).toEqual(["reminder_set"]);
    expect(names[2]).toEqual([
      "reminder_set",
      "execution_task_status",
      "execution_task_output",
      "execution_task_cancel",
      "execution_task_start",
    ]);
    expect(handles).toEqual([
      ["run-prefix-1", { generation: 1, handleTools: 4 }],
      ["run-prefix-3", { generation: 1, handleTools: 4 }],
    ]);
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
