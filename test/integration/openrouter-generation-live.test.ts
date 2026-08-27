import {
  type DataClassification,
  ModelRouterService,
  SessionTraceRecorder,
} from "@himawari-agent/application";
import {
  createAgentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import { MacOsKeychainProviderSecretSource } from "@himawari-agent/platform-node";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import { createProductionModelCompositionFromConfiguration } from "../../apps/agent-service/src/production-model-composition.js";
import {
  createOpenRouterLiveConfiguration,
  OPENROUTER_FALLBACK_MODEL,
  OPENROUTER_FALLBACK_ROUTING,
  OPENROUTER_LIVE_BUDGET_MICROS,
  OPENROUTER_PRIMARY_MODEL,
} from "./fixtures/openrouter-live-configuration.js";

interface LiveEnvironment {
  readonly HIMAWARI_LIVE_GENERATION_PRINT_EVIDENCE?: string;
  readonly HIMAWARI_LIVE_GENERATION_SMOKE?: string;
}

interface GenerationRequestBody {
  readonly model?: unknown;
  readonly provider?: unknown;
}

interface SafeRequestObservation {
  readonly model: string | null;
  readonly status: number;
  readonly syntheticFailure: boolean;
  readonly providerRouting: unknown;
}

const environment = process.env as unknown as LiveEnvironment;
const LIVE_ENABLED = environment.HIMAWARI_LIVE_GENERATION_SMOKE === "1";
const OWNER_ID = createOwnerId("owner-openrouter-live-qualification");
const AGENT_ID = createAgentId("agent-openrouter-live-qualification");
const SESSION_ID = createSessionId("session-openrouter-live-qualification");
const THREAD_ID = createThreadId("thread-openrouter-live-qualification");
const CLOCK = new ManualClock("2026-08-28T02:00:00.000Z");
const QUALITY_MARKER = "HIMAWARI";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requestBody(init: RequestInit | undefined): GenerationRequestBody | undefined {
  if (typeof init?.body !== "string") return undefined;
  try {
    return record(JSON.parse(init.body)) as GenerationRequestBody | undefined;
  } catch {
    return undefined;
  }
}

function routeRequest(input: {
  readonly runId: ReturnType<typeof createRunId>;
  readonly inputRef: string;
  readonly dataClassification: DataClassification;
}) {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId: input.runId,
    taskProfile: "primary" as const,
    requiredCapabilities: ["text"],
    inputRef: input.inputRef,
    dataClassification: input.dataClassification,
    maxDisclosure: "external_remote" as const,
    allowedDisclosureRef: "task20-owner-approved-openrouter-live-eval",
    forbidFallbackDisclosureExpansion: true,
    correlationId: `correlation-${input.runId}`,
    causationId: `context-${input.runId}`,
    parentEventId: null,
    actorId: "task20-live-qualification",
    deadlineAt: "2026-08-28T02:05:00.000Z",
  };
}

describe.skipIf(!LIVE_ENABLED)("OpenRouter generation live qualification", () => {
  it("records bounded primary and fixed-fallback identity, quality, usage and cost", async () => {
    const adapters = createReferenceAdapterSet({ clock: CLOCK });
    const requests: SafeRequestObservation[] = [];
    const nativeFetch = globalThis.fetch;
    let injectPrimaryFailure = false;
    const observedFetch: typeof globalThis.fetch = async (input, init) => {
      const body = requestBody(init);
      const model = typeof body?.model === "string" ? body.model : null;
      if (injectPrimaryFailure && model === OPENROUTER_PRIMARY_MODEL) {
        const response = new Response(
          JSON.stringify({ error: { message: "task20 synthetic retryable failure" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
        requests.push({
          model,
          status: response.status,
          syntheticFailure: true,
          providerRouting: body?.provider ?? null,
        });
        return response;
      }
      const response = await nativeFetch(input, init);
      requests.push({
        model,
        status: response.status,
        syntheticFailure: false,
        providerRouting: body?.provider ?? null,
      });
      return response;
    };
    const composition = createProductionModelCompositionFromConfiguration({
      configuration: createOpenRouterLiveConfiguration(
        "/private/tmp/himawari-openrouter-live-qualification",
      ),
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      handles: adapters.secret,
      secretSource: new MacOsKeychainProviderSecretSource({
        servicePrefix: "himawari-provider",
        account: "himawari-agent",
      }),
      payloads: adapters.payload,
      protector: adapters.payloadProtector,
      ids: adapters.ids,
      clock: CLOCK,
      fetch: observedFetch,
      maxOutputTokens: 256,
      requestTimeoutMs: 120_000,
      temperature: 0,
    });
    const trace = new SessionTraceRecorder({
      trace: adapters.trace,
      payloads: adapters.payload,
      protector: adapters.payloadProtector,
      audit: adapters.audit,
      clock: CLOCK,
      ids: adapters.ids,
    });
    const router = new ModelRouterService({
      model: composition.composition.model,
      secrets: adapters.secret,
      trace,
      clock: CLOCK,
      ids: adapters.ids,
    });
    const prepareInput = async (ref: string, dataClassification: DataClassification) => {
      const payload = await adapters.payloadProtector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref,
        dataClassification,
        contentType: "text/plain",
        plaintext: new TextEncoder().encode(
          `Return exactly this ASCII token and nothing else: ${QUALITY_MARKER}`,
        ),
        createdAt: CLOCK.now(),
      });
      await adapters.payload.put(payload);
      return ref;
    };
    const readOutput = async (refs: readonly string[]) =>
      (
        await Promise.all(refs.map((ref) => composition.composition.payloadBoundary.readText(ref)))
      ).join("");

    try {
      const primaryRunId = createRunId("run-openrouter-live-primary");
      const primary = await router.route(
        routeRequest({
          runId: primaryRunId,
          inputRef: await prepareInput("payload-openrouter-live-primary", "public"),
          dataClassification: "public",
        }),
      );
      if (
        environment.HIMAWARI_LIVE_GENERATION_PRINT_EVIDENCE === "1" &&
        primary.status !== "completed"
      ) {
        process.stdout.write(
          `${JSON.stringify({ phase: "primary", result: primary, requests })}\n`,
        );
      }
      expect(primary).toMatchObject({
        status: "completed",
        selectedModelRef: "model-primary",
        attempts: 1,
      });
      if (primary.status !== "completed") throw new Error("Primary live qualification failed");
      const primaryOutput = await readOutput(primary.outputRefs);

      injectPrimaryFailure = true;
      const fallbackRunId = createRunId("run-openrouter-live-fallback");
      const fallback = await router.route(
        routeRequest({
          runId: fallbackRunId,
          inputRef: await prepareInput("payload-openrouter-live-fallback", "private"),
          dataClassification: "private",
        }),
      );
      if (
        environment.HIMAWARI_LIVE_GENERATION_PRINT_EVIDENCE === "1" &&
        fallback.status !== "completed"
      ) {
        process.stdout.write(
          `${JSON.stringify({ phase: "fallback", result: fallback, requests })}\n`,
        );
      }
      expect(fallback).toMatchObject({
        status: "completed",
        selectedModelRef: "model-fallback",
        attempts: 2,
      });
      if (fallback.status !== "completed") throw new Error("Fallback live qualification failed");
      const fallbackOutput = await readOutput(fallback.outputRefs);

      const observations = composition.composition.transport.observations();
      expect(observations).toHaveLength(2);
      expect(observations.map(({ requestedModel }) => requestedModel)).toEqual([
        OPENROUTER_PRIMARY_MODEL,
        OPENROUTER_FALLBACK_MODEL,
      ]);
      expect(
        observations.every(
          ({ generationId, provider, responseModel }) =>
            generationId !== null && provider !== null && responseModel !== null,
        ),
      ).toBe(true);
      expect(
        observations.every(
          ({ requestedModel, responseModel }) =>
            responseModel?.toLowerCase() === requestedModel.toLowerCase(),
        ),
      ).toBe(true);
      const totalCostMicros = observations.reduce((sum, { costMicros }) => sum + costMicros, 0);
      expect(totalCostMicros).toBeGreaterThan(0);
      expect(totalCostMicros).toBeLessThanOrEqual(OPENROUTER_LIVE_BUDGET_MICROS);
      expect(requests).toEqual([
        expect.objectContaining({
          model: OPENROUTER_PRIMARY_MODEL,
          status: 200,
          syntheticFailure: false,
        }),
        expect.objectContaining({
          model: OPENROUTER_PRIMARY_MODEL,
          status: 503,
          syntheticFailure: true,
        }),
        expect.objectContaining({
          model: OPENROUTER_FALLBACK_MODEL,
          status: 200,
          syntheticFailure: false,
          providerRouting: OPENROUTER_FALLBACK_ROUTING,
        }),
      ]);

      if (environment.HIMAWARI_LIVE_GENERATION_PRINT_EVIDENCE === "1") {
        process.stdout.write(
          `${JSON.stringify({
            primary: {
              selectedModelRef: primary.selectedModelRef,
              attempts: primary.attempts,
              usage: primary.usage,
              qualityMarkerPresent: primaryOutput.includes(QUALITY_MARKER),
              outputCharacters: primaryOutput.length,
            },
            fallback: {
              selectedModelRef: fallback.selectedModelRef,
              attempts: fallback.attempts,
              usage: fallback.usage,
              qualityMarkerPresent: fallbackOutput.includes(QUALITY_MARKER),
              outputCharacters: fallbackOutput.length,
            },
            observations,
            requests,
            totalCostMicros,
            budgetLimitMicros: OPENROUTER_LIVE_BUDGET_MICROS,
          })}\n`,
        );
      }
      expect(primaryOutput).toContain(QUALITY_MARKER);
      expect(fallbackOutput).toContain(QUALITY_MARKER);
    } finally {
      await composition.composition.close();
    }
  }, 300_000);
});
