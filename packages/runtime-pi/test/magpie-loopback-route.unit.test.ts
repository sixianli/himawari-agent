import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelInvocationEvent } from "@himawari-agent/application/runtime-port";
import { afterEach, expect, it } from "vitest";
import {
  ConfiguredPiModelBindingPort,
  type ConfiguredPiModelDescriptor,
  PiModelTransport,
} from "../src/index.js";
import { testModelEgress } from "./helpers/model-egress.js";

const GATEWAY_KEY = ["magpie", "fixture", "key"].join("-");
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function fakeMagpie(): Promise<{
  readonly baseUrl: string;
  readonly requests: {
    url: string;
    auth: string | undefined;
    session: string | string[] | undefined;
    body: Record<string, unknown>;
  }[];
}> {
  const requests: {
    url: string;
    auth: string | undefined;
    session: string | string[] | undefined;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer(async (request, response) => {
    requests.push({
      url: request.url ?? "",
      auth: request.headers.authorization,
      session: request.headers["x-session-affinity"],
      body: await body(request),
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frames = [
      {
        id: "chatcmpl-magpie-01",
        model: "group/himawari-main",
        choices: [{ index: 0, delta: { role: "assistant", content: "こんにちは" } }],
      },
      {
        id: "chatcmpl-magpie-01",
        model: "group/himawari-main",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      },
    ];
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

it("streams through a loopback Magpie route with the pinned Pi runtime and prices tokens locally", async () => {
  const magpie = await fakeMagpie();
  const descriptor: ConfiguredPiModelDescriptor = {
    ref: "magpie-primary",
    routingClass: "primary",
    priority: 1,
    provider: "magpie",
    model: "group/himawari-main",
    version: "magpie-group-2026-10-29",
    name: "Himawari main group",
    api: "openai-completions",
    baseUrl: magpie.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.45, output: 1.8, cacheRead: 0.055, cacheWrite: 0.45 },
    contextWindow: 1_000_000,
    maxTokens: 32768,
    capabilities: ["text"],
    disclosure: "external_remote",
    secretRequirement: {
      secretRef: "magpie-gateway-key",
      secretVersion: "v1",
      purpose: "model-provider-auth",
    },
  };
  const writes: string[] = [];
  const transport = new PiModelTransport({
    egress: testModelEgress(),
    models: new ConfiguredPiModelBindingPort({
      descriptors: [descriptor],
      secretSource: { productionSuitable: true, resolve: async () => GATEWAY_KEY },
    }),
    payloads: {
      readText: async () => "挨拶して",
      writeText: async (input) => {
        writes.push(input.content);
        return `payload-${input.sequence}`;
      },
    },
    clock: { now: () => "2026-10-29T08:00:00.000Z" },
    maxOutputTokens: 256,
  });

  const events: ModelInvocationEvent[] = [];
  for await (const event of transport.invoke({
    descriptor,
    request: {
      invocationId: "invocation-magpie-01",
      runId: "run-magpie-01" as never,
      modelRef: descriptor.ref,
      inputRef: "payload-input-01",
      dataClassification: "private",
      allowedDisclosureRef: "disclosure-magpie-01",
      secretHandleRefs: ["handle-magpie-01"],
      correlationId: "correlation-magpie-01",
    },
    secretValues: [GATEWAY_KEY],
  })) {
    events.push(event);
  }

  expect(events.at(-1)).toMatchObject({
    type: "model.completed",
    inputTokens: 1000,
    outputTokens: 100,
    costMicros: 630,
    providerObservation: { provider: "magpie", model: "group/himawari-main" },
  });
  expect(writes.join("")).toBe("こんにちは");
  expect(magpie.requests).toHaveLength(1);
  expect(magpie.requests[0]?.url).toBe("/v1/chat/completions");
  expect(magpie.requests[0]?.auth).toBe(`Bearer ${GATEWAY_KEY}`);
  expect(magpie.requests[0]?.session).toBe("run-magpie-01");
  expect(magpie.requests[0]?.body["model"]).toBe("group/himawari-main");
  expect(magpie.requests[0]?.body).not.toHaveProperty("providerOptions");
});
