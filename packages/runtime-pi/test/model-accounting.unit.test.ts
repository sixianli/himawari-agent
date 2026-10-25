import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  ModelInvocationAdmissionPort,
  ModelInvocationPermit,
  RuntimeEvent,
  RuntimeRequest,
} from "@himawari-agent/application/runtime-port";
import { describe, expect, it, vi } from "vitest";
import {
  PiAgentRuntimeAdapter,
  type PiAgentRuntimeAdapterDependencies,
  type PiModelBinding,
} from "../src/pi-runtime-adapter.ts";

const model: Model<Api> = {
  id: "accounting",
  name: "Accounting",
  api: "faux",
  provider: "fixture",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 128,
};
const now = "2026-09-14T00:00:00.000Z";
const request = {
  ownerId: "owner-accounting",
  agentId: "agent-accounting",
  runId: "run-accounting",
  sessionId: "session-accounting",
  threadId: "thread-accounting",
  modelRef: "model-accounting",
  systemInstructionRef: "system",
  contextEnvelopeRef: "context",
  capabilityHandleRefs: [],
  workerResultRefs: [],
  budget: { maxTurns: 2 },
  correlationId: "accounting",
  dataClassification: "private",
  executionLease: Object.freeze({
    executionLeaseId: "execution-accounting",
    expectedLeaseRevision: 1,
    authorityLeaseId: "authority-accounting",
    authorityFencingToken: 1,
    deploymentId: "deployment-accounting",
    authorityEpoch: 1,
    fencingToken: 1,
    consumerId: "accounting",
  }),
} as unknown as RuntimeRequest;
function message(chosenModel = model): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Accounted answer" }],
    api: chosenModel.api,
    provider: chosenModel.provider,
    model: chosenModel.id,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.parse(now),
  };
}
function fixture(chosenModel = model) {
  const permit = {
    assertActive: vi.fn(async () => {}),
    markStarted: vi.fn(async () => {}),
    releaseReserved: vi.fn(async () => {}),
    settle: vi.fn<ModelInvocationPermit["settle"]>(async () => {}),
    markUnknown: vi.fn<ModelInvocationPermit["markUnknown"]>(async () => {}),
  };
  const begin = vi.fn<ModelInvocationAdmissionPort["begin"]>(async () => ({
    disposition: "fresh",
    permit,
    identity: {} as never,
  }));
  const binding: PiModelBinding = {
    model: chosenModel,
    modelRuntime: {} as never,
    descriptor: {
      ref: request.modelRef,
      provider: chosenModel.provider,
      model: chosenModel.id,
      version: "1",
      routingClass: chosenModel.provider === "vercel-ai-gateway" ? "primary" : "local",
      priority: 1,
      disclosure: chosenModel.provider === "vercel-ai-gateway" ? "external_remote" : "local_only",
      capabilities: ["text"],
      allowedDataClassifications: ["private"],
      secretRequirement: null,
      ...(chosenModel.provider === "vercel-ai-gateway"
        ? { providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" as const } }
        : {}),
    },
    admissionCost: {
      estimatedCostMicros: 10,
      pricing: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    },
  };
  const original = vi.fn<
    (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ) =>
      | ReturnType<typeof createAssistantMessageEventStream>
      | Promise<ReturnType<typeof createAssistantMessageEventStream>>
  >(() => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: message(chosenModel) });
    return stream;
  });
  let streamOptions: SimpleStreamOptions = {};
  let gate: ModelInvocationAdmissionPort | undefined = {
    context: {
      ownerId: request.ownerId,
      agentId: request.agentId,
      runId: request.runId,
      executionLease: request.executionLease,
    },
    begin,
  };
  const terminals: string[] = [];
  let logicalSlot = "accounting:1";
  const dependencies: PiAgentRuntimeAdapterDependencies = {
    cwd: process.cwd(),
    now: () => now,
    logicalSlot: () => logicalSlot,
    models: { resolve: async () => binding },
    admission: async () => gate,
    projection: {
      resolveProjection: async () => ({
        systemInstruction: "Use governed execution.",
        history: [],
        prompt: { id: "prompt", content: "Answer", occurredAt: now },
        contextBlocks: [],
      }),
      capture: async () => "protected-message",
      captureFinalAnswer: async () => "protected-answer",
      proposeCompaction: async () => "compaction",
    },
    tools: {
      listAuthorized: async () => [],
      preflight: async () => {
        throw new Error("No tools expected");
      },
      execute: async () => {
        throw new Error("No tools expected");
      },
    },
    createSession: async () => {
      let listener = (_event: unknown) => {};
      const agent = {
        streamFunction: original as (
          model: Model<Api>,
          context: { messages: [] },
          options: SimpleStreamOptions,
        ) => ReturnType<typeof original> | Promise<ReturnType<typeof original>>,
      };
      return {
        session: {
          agent,
          subscribe: (next: typeof listener) => {
            listener = next;
            return () => {};
          },
          prompt: async () => {
            const stream = await agent.streamFunction(chosenModel, { messages: [] }, streamOptions);
            for await (const event of stream) {
              if (event.type === "done" || event.type === "error") {
                terminals.push(event.type);
                listener({
                  type: "message_end",
                  message: event.type === "done" ? event.message : event.error,
                });
              }
            }
            listener({ type: "agent_settled" });
          },
          waitForIdle: async () => {},
          abort: async () => {},
          dispose: () => {},
        },
      } as unknown as Awaited<
        ReturnType<NonNullable<PiAgentRuntimeAdapterDependencies["createSession"]>>
      >;
    },
  };
  return {
    permit,
    begin,
    binding,
    original,
    dependencies,
    terminals,
    setGate: (value: typeof gate) => {
      gate = value;
    },
    getGate: () => gate,
    setLogicalSlot: (value: string) => {
      logicalSlot = value;
    },
    setOptions: (value: SimpleStreamOptions) => {
      streamOptions = value;
    },
    run: async () => {
      const events: RuntimeEvent[] = [];
      for await (const event of new PiAgentRuntimeAdapter(dependencies).run(request))
        events.push(event);
      return events;
    },
  };
}
function failure(events: RuntimeEvent[]) {
  expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  expect(events.some((event) => event.type === "runtime.completed")).toBe(false);
}

describe("model stream admission and uncertain accounting", () => {
  it("settles actual usage before publishing a completed response", async () => {
    const f = fixture();
    expect((await f.run()).at(-1)).toMatchObject({ type: "runtime.completed" });
    expect(f.permit.settle).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 4,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
    });
    expect(f.permit.markStarted).toHaveBeenCalledOnce();
    expect(f.permit.releaseReserved).not.toHaveBeenCalled();
    expect(f.permit.markUnknown).not.toHaveBeenCalled();
  });
  it.each(["ownerId", "agentId", "runId", "missing-gate", "mutable-lease", "empty-slot"])(
    "refuses a mismatched admission boundary (%s) before contacting the provider",
    async (field) => {
      const f = fixture();
      const gate = f.getGate();
      if (!gate) throw new Error("Missing gate");
      if (field === "missing-gate") f.setGate(undefined);
      else if (field === "empty-slot") f.setLogicalSlot(" ");
      else
        f.setGate({
          ...gate,
          context: {
            ...gate.context,
            ...(field === "mutable-lease"
              ? { executionLease: { ...request.executionLease } }
              : { [field]: "other" }),
          },
        });
      failure(await f.run());
      expect(f.begin).not.toHaveBeenCalled();
      expect(f.original).not.toHaveBeenCalled();
    },
  );
  it.each(["replay", "blocked"] as const)(
    "does not reissue an invocation with disposition %s",
    async (disposition) => {
      const f = fixture();
      f.begin.mockResolvedValue({ disposition } as never);
      failure(await f.run());
      expect(f.original).not.toHaveBeenCalled();
      expect(f.permit.markStarted).not.toHaveBeenCalled();
    },
  );
  it.each(["input", "output", "cacheRead", "cacheWrite", "missing-usage"])(
    "does not turn invalid usage %s into a free successful response",
    async (field) => {
      const f = fixture();
      f.original.mockImplementation(() => {
        const stream = createAssistantMessageEventStream();
        const value = message();
        if (field === "missing-usage") Object.assign(value, { usage: undefined });
        else Object.assign(value.usage, { [field]: -1 });
        stream.push({ type: "done", reason: "stop", message: value });
        return stream;
      });
      failure(await f.run());
      expect(f.permit.settle).not.toHaveBeenCalled();
      expect(f.permit.markUnknown).toHaveBeenCalledExactlyOnceWith(
        field === "missing-usage" ? "transport_unresolved" : "provider_unresolved",
      );
    },
  );
  it.each([false, true])(
    "retains uncertainty when settlement fails (unknown write fails=%s)",
    async (unknownFails) => {
      const f = fixture();
      f.permit.settle.mockRejectedValue(new Error("settlement failed"));
      if (unknownFails) f.permit.markUnknown.mockRejectedValue(new Error("state unavailable"));
      failure(await f.run());
      expect(f.permit.markUnknown).toHaveBeenCalledExactlyOnceWith("transport_unresolved");
      expect(f.terminals).toEqual(["error"]);
      expect(f.permit.releaseReserved).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "does not claim a rejected pre-start release succeeded (unknown fails=%s)",
    async (unknownFails) => {
      const f = fixture();
      f.permit.assertActive.mockRejectedValue(new Error("lease lost"));
      f.permit.releaseReserved.mockRejectedValue(new Error("uncertain start"));
      if (unknownFails) f.permit.markUnknown.mockRejectedValue(new Error("state unavailable"));
      failure(await f.run());
      expect(f.permit.releaseReserved).toHaveBeenCalledOnce();
      expect(f.permit.markUnknown).toHaveBeenCalledExactlyOnceWith("transport_unresolved");
      expect(f.original).not.toHaveBeenCalled();
    },
  );
  it.each(["before", "after-secret", "after-start"])(
    "handles cancellation %s with the correct accounting state",
    async (phase) => {
      const f = fixture();
      const controller = new AbortController();
      f.setOptions({ signal: controller.signal });
      if (phase === "before") controller.abort();
      if (phase === "after-secret")
        f.permit.assertActive
          .mockImplementationOnce(async () => {})
          .mockImplementationOnce(async () => {
            controller.abort();
          });
      if (phase === "after-start")
        f.permit.markStarted.mockImplementation(async () => {
          controller.abort();
        });
      failure(await f.run());
      expect(f.original).not.toHaveBeenCalled();
      if (phase === "after-start") {
        expect(f.permit.markUnknown).toHaveBeenCalledExactlyOnceWith("cancel_unresolved");
        expect(f.permit.releaseReserved).not.toHaveBeenCalled();
      } else {
        expect(f.permit.releaseReserved).toHaveBeenCalledOnce();
        expect(f.permit.markUnknown).not.toHaveBeenCalled();
      }
    },
  );
  it.each(["throws", "no-terminal", "provider-error"])(
    "records an unresolved provider outcome (%s)",
    async (kind) => {
      const f = fixture();
      f.original.mockImplementation(() => {
        if (kind === "throws") throw new Error("private provider failure");
        const stream = createAssistantMessageEventStream();
        if (kind === "provider-error")
          stream.push({
            type: "error",
            reason: "error",
            error: { ...message(), stopReason: "error", errorMessage: "503 provider unavailable" },
          });
        else stream.end();
        return stream;
      });
      failure(await f.run());
      expect(f.permit.markUnknown).toHaveBeenCalledExactlyOnceWith(
        kind === "provider-error" ? "provider_unresolved" : "transport_unresolved",
      );
      expect(f.permit.settle).not.toHaveBeenCalled();
      expect(f.permit.releaseReserved).not.toHaveBeenCalled();
    },
  );
});

const gatewayModel: Model<Api> = {
  ...model,
  id: "deepseek/deepseek-v4.1-flash",
  api: "openai-completions",
  provider: "vercel-ai-gateway",
  maxTokens: 32768,
};

function gatewayFrame(cost: unknown = "0.00000019", metadataCost: unknown = cost) {
  return {
    model: gatewayModel.id,
    usage: { cost },
    choices: [
      {
        index: 0,
        delta: {
          provider_metadata: {
            gateway: {
              generationId: "gen-accounting-gateway",
              cost: metadataCost,
              routing: { finalProvider: "deepinfra" },
            },
          },
        },
      },
    ],
  };
}

function gatewayFixture(frames: readonly unknown[] = [gatewayFrame(), "[DONE]"]) {
  const f = fixture(gatewayModel);
  const payloads: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    const body = frames
      .map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\r\n\r\n`)
      .join("");
    const bytes = new TextEncoder().encode(body);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 7)
            controller.enqueue(bytes.slice(offset, offset + 7));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  let options: SimpleStreamOptions = { fetch };
  let repeated = false;
  let beforeDone = () => {};
  f.setOptions(options);
  f.original.mockImplementation(async (chosenModel, _context, current) => {
    const payload = { model: chosenModel.id, messages: [], providerOptions: { retained: true } };
    const replacement = await current?.onPayload?.(payload, chosenModel);
    const send = async () => {
      const response = await current?.fetch?.("http://127.0.0.1:1/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(replacement ?? payload),
      });
      await response?.text();
    };
    await send();
    if (repeated) await send().catch(() => undefined);
    beforeDone();
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: message(chosenModel) });
    return stream;
  });
  return {
    ...f,
    fetch,
    payloads,
    setGatewayOptions(value: SimpleStreamOptions) {
      options = { fetch, ...value };
      f.setOptions(options);
    },
    repeat() {
      repeated = true;
    },
    beforeDone(callback: () => void) {
      beforeDone = callback;
    },
  };
}

describe("[R2-L5] Agent Loop gateway billing", () => {
  it.each([
    { cost: "0", micros: 0 },
    { cost: "0.00000019", micros: 1 },
    { cost: "0.000077", micros: 77 },
  ])("settles the observed $cost USD before publishing done", async ({ cost, micros }) => {
    const f = gatewayFixture([gatewayFrame(cost), "[DONE]"]);
    expect((await f.run()).at(-1)).toMatchObject({ type: "runtime.completed" });
    expect(f.permit.settle).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 4,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      reportedCostMicros: micros,
    });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.permit.markUnknown).not.toHaveBeenCalled();
    expect(f.terminals).toEqual(["done"]);
  });

  it.each([
    { name: "missing billing", frames: [{ model: gatewayModel.id, choices: [] }, "[DONE]"] },
    { name: "missing stream terminator", frames: [gatewayFrame()] },
    { name: "invalid usage fee", frames: [gatewayFrame(-1), "[DONE]"] },
    { name: "invalid metadata fee", frames: [gatewayFrame("0.00000019", "bad"), "[DONE]"] },
    {
      name: "different fees with equal rounded values",
      frames: [gatewayFrame("0.0000001", "0.0000002"), "[DONE]"],
    },
    {
      name: "conflicting terminal frames",
      frames: [gatewayFrame(), gatewayFrame("0.0000002"), "[DONE]"],
    },
    { name: "invalid before valid", frames: [gatewayFrame(-1), gatewayFrame(), "[DONE]"] },
    {
      name: "different model",
      frames: [{ ...gatewayFrame(), model: "unsupported-text-model" }, "[DONE]"],
    },
    { name: "data after terminator", frames: [gatewayFrame(), "[DONE]", gatewayFrame()] },
  ])("retains unknown without resending when $name", async ({ frames }) => {
    const f = gatewayFixture(frames);
    failure(await f.run());
    expect(f.permit.settle).not.toHaveBeenCalled();
    expect(f.permit.markUnknown).toHaveBeenCalledExactlyOnceWith("provider_unresolved");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.terminals).toEqual(["error"]);
  });

  it("applies configured routing after a caller payload hook", async () => {
    const f = gatewayFixture();
    const hook = vi.fn(async (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      temperature: 0,
      providerOptions: {
        retained: true,
        gateway: { order: ["unapproved"], disallowPromptTraining: true },
      },
    }));
    f.setGatewayOptions({ onPayload: hook });
    await f.run();
    expect(hook).toHaveBeenCalledOnce();
    expect(f.payloads).toEqual([
      {
        model: gatewayModel.id,
        messages: [],
        temperature: 0,
        providerOptions: {
          retained: true,
          gateway: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
        },
      },
    ]);
    expect(f.original.mock.calls[0]?.[2]?.maxRetries).toBe(0);
  });

  it.each([32769, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxTokens %s before contacting the provider",
    async (maxTokens) => {
      const f = gatewayFixture();
      f.setGatewayOptions({ maxTokens });
      failure(await f.run());
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.original).not.toHaveBeenCalled();
      expect(f.permit.markStarted).not.toHaveBeenCalled();
    },
  );

  it("does not permit a second physical request even if the provider catches rejection", async () => {
    const f = gatewayFixture();
    f.repeat();
    failure(await f.run());
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.permit.settle).not.toHaveBeenCalled();
    expect(f.permit.markUnknown).toHaveBeenCalledExactlyOnceWith("provider_unresolved");
  });

  it("retains cancellation uncertainty when cancellation arrives before terminal publication", async () => {
    const f = gatewayFixture();
    const controller = new AbortController();
    f.setGatewayOptions({ signal: controller.signal });
    f.beforeDone(() => controller.abort());
    failure(await f.run());
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.permit.settle).not.toHaveBeenCalled();
    expect(f.permit.markUnknown).toHaveBeenCalledExactlyOnceWith("cancel_unresolved");
  });
});
