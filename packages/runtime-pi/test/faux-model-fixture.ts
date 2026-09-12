import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelDescriptor } from "@himawari-agent/application/runtime-port";
import type { PiModelBinding, PiModelBindingPort } from "../src/pi-runtime-adapter.js";

interface FauxTool {
  readonly name: string;
  readonly id: string;
  readonly arguments: Record<string, unknown>;
}

/** Real pinned Pi runtime with its local deterministic provider; no network or credentials. */
export async function createFauxModelFixture(
  answer: string,
  tool?: FauxTool | readonly FauxTool[],
  followingBatches: readonly (readonly FauxTool[])[] = [],
) {
  const aiEntry = new URL(
    "../node_modules/@earendil-works/pi-ai/dist/index.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const ai = (await import(aiEntry.href)) as {
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
            observed.push(context);
            return ai.fauxAssistantMessage(
              (Array.isArray(tool) ? tool : [tool]).map((call) => ({ type: "toolCall", ...call })),
              { stopReason: "toolUse" },
            );
          },
        ]
      : []),
    ...followingBatches.map((batch) => (context: unknown) => {
      observed.push(context);
      return ai.fauxAssistantMessage(
        batch.map((call) => ({ type: "toolCall", ...call })),
        { stopReason: "toolUse" },
      );
    }),
    (context: unknown) => {
      observed.push(context);
      return ai.fauxAssistantMessage(answer);
    },
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
    version: "0.84.2-test",
    routingClass: "local",
    priority: 1,
    disclosure: "local_only",
    capabilities: ["text", "tool_calling"],
    allowedDataClassifications: ["private"],
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
