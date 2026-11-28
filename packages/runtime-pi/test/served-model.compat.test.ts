import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  RuntimeEvent,
  RuntimeProjection,
  RuntimeProjectionPort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";
import { afterEach, describe, expect, it } from "vitest";
import { ConfiguredPiModelBindingPort, PiAgentRuntimeAdapter } from "../src/index.js";
import { allowAdmission, fixtureExecutionLease } from "./helpers/admission.js";
import { testModelEgress } from "./helpers/model-egress.js";

const NOW = "2026-11-02T00:44:00.000Z";
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

async function loopback(servedModels: readonly (string | undefined)[]) {
  let count = 0;
  const server = createServer(async (incoming, response) => {
    await readBody(incoming);
    const index = count++;
    const served = servedModels[index];
    response.writeHead(200, {
      "content-type": "text/event-stream",
      ...(served ? { "x-magpie-model": served } : {}),
    });
    const frame = (delta: Record<string, unknown>, finish?: string) =>
      `data: ${JSON.stringify({
        id: `chatcmpl-${index}`,
        model: "group/main",
        choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
        ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
      })}\n\n`;
    response.write(frame({ role: "assistant", content: `回答${index}` }));
    response.write(frame({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

class CapturingProjection implements RuntimeProjectionPort {
  readonly lastMessageByRun = new Map<string, Record<string, unknown>>();

  async resolveProjection(): Promise<RuntimeProjection> {
    return {
      systemInstruction: "你是 Himawari，主人的个人助手。",
      history: [],
      prompt: { id: "prompt", content: "你好", occurredAt: NOW },
      contextBlocks: [],
    };
  }

  async captureHistory(input: { runId: RuntimeRequest["runId"] }) {
    return {
      runId: input.runId,
      operationKey: `snapshot:${input.runId}`,
      payloadRef: `native-${input.runId}`,
      dataClassification: "private" as const,
    };
  }

  async capture(input: {
    readonly runId: string;
    readonly kind: string;
    readonly value: unknown;
  }): Promise<string> {
    if (input.kind === "message")
      this.lastMessageByRun.set(input.runId, input.value as Record<string, unknown>);
    return "captured";
  }

  async captureFinalAnswer(): Promise<string> {
    return "final-answer";
  }

  async proposeCompaction(): Promise<string> {
    return "compaction";
  }
}

class NoTools implements RuntimeToolPort {
  async preflight() {
    return { allowed: true, permissionDecisionRef: "permission", reasonCode: "grant_allows" };
  }

  async execute(): Promise<never> {
    throw new Error("no tools in this test");
  }

  async listAuthorized(): Promise<readonly RuntimeToolDescriptor[]> {
    return [];
  }
}

async function answers(servedModels: readonly (string | undefined)[]) {
  const baseUrl = await loopback(servedModels);
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
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
        capabilities: ["text"],
        disclosure: "external_remote",
        secretRequirement: { secretRef: "k", secretVersion: "v1", purpose: "model-provider-auth" },
      },
    ],
    secretSource: { productionSuitable: true, resolve: async () => "loopback-fixture-key" },
  });
  const projection = new CapturingProjection();
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools: new NoTools(),
    models,
    cwd: process.cwd(),
    timeZone: "Asia/Tokyo",
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (run, ordinal) => `${run.runId}:served:${ordinal}`,
  });
  for (const [index] of servedModels.entries()) {
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.run({
      ownerId: "owner-served",
      agentId: "agent-served",
      runId: `run-served-${index + 1}`,
      executionLease: fixtureExecutionLease(),
      sessionId: "session-served",
      threadId: "thread-served",
      modelRef: "loopback-primary",
      systemInstructionRef: "payload-system",
      contextEnvelopeRef: "payload-context",
      workerResultRefs: [],
      capabilityHandleRefs: [],
      budget: { maxTurns: 4 },
      correlationId: "correlation-served",
      dataClassification: "private",
    } as unknown as RuntimeRequest))
      events.push(event);
    expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("runtime.completed");
  }
  return [...projection.lastMessageByRun.values()];
}

describe("served model header reaches the saved assistant message through real Pi", () => {
  it("records the model named by x-magpie-model on each answer", async () => {
    const answered = await answers([
      "workbuddy-ai/deepseek-v4.1-flash-sg",
      "opencode-go/glm-5.3-flash",
    ]);
    expect(answered.map((message) => message["servedModel"])).toEqual([
      "workbuddy-ai/deepseek-v4.1-flash-sg",
      "opencode-go/glm-5.3-flash",
    ]);
  });

  it("REVERSE: records nothing when the header is missing or malformed, and never reuses the previous answer's model", async () => {
    const answered = await answers(["opencode-go/glm-5.3-flash", undefined, "bad value"]);
    expect(answered).toHaveLength(3);
    expect(answered.map((message) => "servedModel" in message)).toEqual([true, false, false]);
  });
});
