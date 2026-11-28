import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelDescriptor } from "@himawari-agent/application/runtime-port";
import type { PiModelBinding, PiModelBindingPort } from "../src/pi-runtime-adapter.js";

interface FauxTool {
  readonly name: string;
  readonly id: string;
  readonly arguments: Record<string, unknown>;
}

export function observedRequest(context: unknown) {
  const { messages } = context as TranscriptContext;
  if (messages.slice(1).some((message) => message.role === "system"))
    throw new Error("A system message after the request head reached the provider");
  return {
    systemPrompt: getCurrentSystemPrompt(messages),
    tools: getCurrentTools(messages),
    messages: messages.filter((message) => message.role !== "system"),
    transcript: messages,
  };
}

export async function createFauxModelFixture(
  answer: string,
  tool?: FauxTool | readonly FauxTool[],
  followingBatches: readonly (readonly FauxTool[])[] = [],
  laterAnswers: readonly string[] = [],
) {
  const ai = (await import("@earendil-works/pi-ai")) as unknown as {
    InMemoryCredentialStore: new () => unknown;
    fauxProvider(): {
      provider: unknown;
      getModel(): unknown;
      setResponses(responses: readonly unknown[]): void;
    };
    fauxAssistantMessage(content: unknown, options?: { stopReason: string }): unknown;
  };
  const faux = ai.fauxProvider();
  const observed: unknown[] = [];
  faux.setResponses([
    ...(tool
      ? [
          (context: unknown) => {
            observed.push(observedRequest(context));
            return ai.fauxAssistantMessage(
              (Array.isArray(tool) ? tool : [tool]).map((call) => ({ type: "toolCall", ...call })),
              { stopReason: "toolUse" },
            );
          },
        ]
      : []),
    ...followingBatches.map((batch) => (context: unknown) => {
      observed.push(observedRequest(context));
      return ai.fauxAssistantMessage(
        batch.map((call) => ({ type: "toolCall", ...call })),
        { stopReason: "toolUse" },
      );
    }),
    ...[answer, ...laterAnswers].map((text) => (context: unknown) => {
      observed.push(observedRequest(context));
      return ai.fauxAssistantMessage(text);
    }),
  ]);
  const runtime = await ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore() as never,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerNativeProvider(faux.provider as never);
  const descriptor = {
    ref: "pi-local-test",
    provider: "faux",
    model: "faux-1",
    version: "1.5.0-test",
    routingClass: "local",
    priority: 1,
    disclosure: "local_only",
    capabilities: ["text", "tool_calling"],
    secretRequirement: null,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    estimatedCostMicros: 1,
  } satisfies ModelDescriptor & {
    pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
    estimatedCostMicros: number;
  };
  const models: PiModelBindingPort = {
    resolve: async (ref) => {
      if (ref !== descriptor.ref) throw new Error("Unknown test model");
      return {
        model: faux.getModel(),
        modelRuntime: runtime,
        descriptor,
        admissionCost: {
          pricing: descriptor.pricing,
          estimatedCostMicros: descriptor.estimatedCostMicros,
        },
      } as PiModelBinding;
    },
  };
  return { models, descriptor, observed };
}
