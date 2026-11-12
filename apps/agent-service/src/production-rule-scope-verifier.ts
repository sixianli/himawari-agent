import {
  type ClockPort,
  type IdGeneratorPort,
  type ModelInvocationRequest,
  type ProactiveModelInvoker,
  type RuleScopeConfiguration,
  parseRuleScopeVerdict,
  zonedParts,
} from "@himawari-agent/application";
import { RULE_SCOPE_VERIFY } from "@himawari-agent/prompt-catalog";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import type { ProductionModelComposition } from "./production-model-composition.js";
import {
  RULE_SCOPE_DEFAULT_MAX_DAYS,
  type RuleScopeVerifier,
  type RuleScopeVerifierInput,
} from "./production-rule-scope.js";

export type RuleScopeVerifierKind = "model" | "jev";

export const RULE_SCOPE_INPUT_VERSION = "rule-scope-input.v1";
const MAX_OUTPUT_BYTES = 8_192;
const RULE_SCOPE_MAX_OUTPUT_TOKENS = 400;

export interface RuleScopeVerifierOptions {
  readonly kind: RuleScopeVerifierKind;
  readonly invoker: ProactiveModelInvoker;
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
  readonly timeoutMs: number;
  readonly onFailure?: (code: string) => void;
}

function localNow(now: string, timeZone: string): string {
  const parts = zonedParts(now, timeZone);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}（${timeZone}）`;
}

export function ruleScopePrompt(
  kind: RuleScopeVerifierKind,
  input: RuleScopeVerifierInput,
): string {
  const local = localNow(input.now, input.timeZone);
  if (kind === "jev")
    return JSON.stringify({
      schemaVersion: RULE_SCOPE_INPUT_VERSION,
      quote: input.quote,
      context: input.context,
      localNow: local,
    });
  return `${RULE_SCOPE_VERIFY.text}\n${JSON.stringify({ quote: input.quote, context: input.context })}\n当前当地时间和时区：${local}`;
}

export function createRuleScopeVerifier(options: RuleScopeVerifierOptions): RuleScopeVerifier {
  const { invoker } = options;
  return Object.freeze<RuleScopeVerifier>({
    async verify(input) {
      const prompt = ruleScopePrompt(options.kind, input);
      const dataClassification = classificationWithIdentifiers(
        `${input.quote}\n${input.context}`,
        "private",
      );
      const invocationId = options.ids.next("rule-scope");
      const deadlineAt = new Date(
        Date.parse(options.clock.now()) + options.timeoutMs,
      ).toISOString();
      let output = "";
      let completed = false;
      try {
        const authority = await invoker.prepare({
          invocationId,
          prompt,
          deadlineAt,
          dataClassification,
        });
        try {
          const request: ModelInvocationRequest = {
            signal: AbortSignal.timeout(options.timeoutMs),
            invocationId,
            runId: authority.runId,
            modelRef: invoker.modelRef,
            inputRef: authority.inputRef,
            dataClassification,
            allowedDisclosureRef: authority.allowedDisclosureRef,
            secretHandleRefs: [...authority.secretHandleRefs],
            correlationId: invocationId as ModelInvocationRequest["correlationId"],
          };
          for await (const event of invoker.model.invoke(request)) {
            if (event.invocationId !== invocationId) break;
            if (event.type === "model.failed") {
              options.onFailure?.(event.errorCode);
              return undefined;
            }
            if (event.type === "model.output") {
              output += await invoker.readOutput(event.payloadRef);
              if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) return undefined;
            }
            if (event.type === "model.completed") {
              completed = true;
              break;
            }
          }
        } finally {
          await authority.release();
        }
      } catch (error) {
        options.onFailure?.(
          error instanceof Error ? error.message.slice(0, 80) : "RULE_SCOPE_FAILED",
        );
        return undefined;
      }
      if (!completed) return undefined;
      const verdict = parseRuleScopeVerdict(output, input.quote);
      if (!verdict) return undefined;
      if (options.kind === "model" && verdict.scope !== "unclear" && verdict.evidence === null)
        return undefined;
      return verdict;
    },
  });
}

export interface RuleScopeWiring {
  readonly verifier?: RuleScopeVerifier;
  readonly maxDays: number;
}

export function ruleScopeWiring(input: {
  readonly configuration: RuleScopeConfiguration | undefined;
  readonly composition: Pick<ProductionModelComposition, "proactiveModel">;
  readonly ids: IdGeneratorPort;
  readonly clock: ClockPort;
  readonly onFailure: (code: string) => void;
}): RuleScopeWiring {
  const { configuration } = input;
  if (!configuration) return { maxDays: RULE_SCOPE_DEFAULT_MAX_DAYS };
  if (configuration.verifier === "off" || configuration.modelRef === undefined)
    return { maxDays: configuration.maxDays };
  try {
    const invoker = input.composition.proactiveModel(configuration.modelRef, {
      maxOutputTokens: RULE_SCOPE_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: configuration.timeoutMs,
      purpose: "rule-scope",
      allowChoiceModel: configuration.verifier === "jev",
    });
    return {
      maxDays: configuration.maxDays,
      verifier: createRuleScopeVerifier({
        kind: configuration.verifier,
        invoker,
        ids: input.ids,
        clock: input.clock,
        timeoutMs: configuration.timeoutMs,
        onFailure: input.onFailure,
      }),
    };
  } catch (error) {
    input.onFailure(error instanceof Error ? error.message.slice(0, 80) : "RULE_SCOPE_UNAVAILABLE");
    return {
      maxDays: configuration.maxDays,
      verifier: Object.freeze<RuleScopeVerifier>({ verify: async () => undefined }),
    };
  }
}
