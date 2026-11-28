import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { ConfiguredPiModelBindingPort, type ConfiguredPiModelDescriptor } from "../src/index.js";
import { restoreModelStream, withPlaceholderLegend } from "../src/egress-context.js";
import { testModelEgress } from "./helpers/model-egress.js";

const KEY = ["loopback", "fixture", "key"].join("-");
const PASSWORD = "Qz7mWx42Lp";
const PLACEHOLDER = /\[(?:密码|验证码|证件号|银行卡 尾号\d{4})#[a-z]{8}\]/u;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function loopback(): Promise<{ baseUrl: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    const raw = await readBody(request);
    bodies.push(raw);
    const placeholder = [...raw.matchAll(new RegExp(PLACEHOLDER, "gu"))].at(-1)?.[0] ?? "无";
    const reply = `你的密码是 ${placeholder} 。`;
    const cut = Math.max(1, reply.indexOf("#") + 3);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta: Record<string, unknown>, finish?: string) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        model: "group/main",
        choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
        ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
      })}\n\n`;
    response.write(frame({ role: "assistant", content: reply.slice(0, cut) }));
    response.write(frame({ content: reply.slice(cut) }));
    response.write(frame({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies };
}

function descriptor(baseUrl: string): ConfiguredPiModelDescriptor {
  return {
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
    allowedDataClassifications: ["public", "private"],
    secretRequirement: { secretRef: "k", secretVersion: "v1", purpose: "model-provider-auth" },
  };
}

async function run(context: Context, baseUrl: string, egress = testModelEgress()) {
  const ports = new ConfiguredPiModelBindingPort({
    descriptors: [descriptor(baseUrl)],
    secretSource: { productionSuitable: true, resolve: async () => KEY },
  });
  const binding = await ports.resolve("loopback-primary");
  const exchange = egress.exchange();
  const source = binding.modelRuntime.stream(binding.model, withPlaceholderLegend(context), {
    apiKey: KEY,
    fetch: exchange.wrapFetch(globalThis.fetch),
    maxRetries: 0,
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of restoreModelStream(source, exchange)) events.push(event);
  return events;
}

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

it("masks a real request from the pinned Pi runtime and shows the user the original value", async () => {
  const server = await loopback();
  const events = await run(
    { systemPrompt: "你是 Himawari", messages: [user(`我的密码：${PASSWORD}`)] },
    server.baseUrl,
  );

  expect(server.bodies).toHaveLength(1);
  expect(server.bodies[0]).not.toContain(PASSWORD);
  expect(server.bodies[0]).toMatch(PLACEHOLDER);

  const deltas = events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []));
  expect(deltas.join("")).toBe(`你的密码是 ${PASSWORD} 。`);
  for (const delta of deltas) expect(delta).not.toMatch(/#[a-z]{8}/u);

  const done = events.find((event) => event.type === "done");
  expect(done?.type === "done" && done.message.content[0]).toMatchObject({
    type: "text",
    text: `你的密码是 ${PASSWORD} 。`,
  });
  const end = events.find((event) => event.type === "text_end");
  expect(end?.type === "text_end" && end.content).toBe(`你的密码是 ${PASSWORD} 。`);
  for (const event of events) {
    if ("partial" in event) {
      const text = event.partial.content.find((block) => block.type === "text");
      expect(text && "text" in text ? text.text : "").not.toMatch(/#[a-z]{8}/u);
    }
  }
});

it("masks the restored reply to the same bytes on the next turn, so the cached prefix holds", async () => {
  const server = await loopback();
  const first = await run(
    { systemPrompt: "S", messages: [user(`我的密码：${PASSWORD}`)] },
    server.baseUrl,
  );
  const done = first.find((event) => event.type === "done");
  if (done?.type !== "done") throw new Error("no done event");
  await run(
    { systemPrompt: "S", messages: [user(`我的密码：${PASSWORD}`), done.message, user("谢谢")] },
    server.baseUrl,
  );

  const turnOne = JSON.parse(server.bodies[0] ?? "{}").messages as unknown[];
  const turnTwo = JSON.parse(server.bodies[1] ?? "{}").messages as {
    role: string;
    content: string;
  }[];
  expect(server.bodies[1]).not.toContain(PASSWORD);
  expect(JSON.stringify(turnTwo.slice(0, turnOne.length))).toBe(JSON.stringify(turnOne));
  expect(turnTwo[2]?.content).toMatch(PLACEHOLDER);
});

it("sends the same bytes for the same conversation on every call", async () => {
  const server = await loopback();
  const context = { systemPrompt: "S", messages: [user(`密码：${PASSWORD}，验证码 482910`)] };
  await run(context, server.baseUrl);
  await run(context, server.baseUrl);
  expect(server.bodies[0]).toBe(server.bodies[1]);
});
