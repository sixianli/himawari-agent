import { createHash } from "node:crypto";
import {
  type AuditLedgerPort,
  type AuthorityFence,
  type ClockPort,
  type GovernedActionIntent,
  type IdempotentAgentCommand,
  judgeOwnerIntent,
  type OwnerIntentCheckConfiguration,
  type OwnerIntentCheckPort,
  type OwnerIntentRejection,
  type ProductConfiguration,
  type RunExecutionSource,
  type RuntimeToolInvocation,
  type ToolActionRow,
} from "@himawari-agent/application";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { appendAuditRecord } from "./owner-policy-authorization.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function ownerIntentCheckKey(intentId: string): string {
  return `owner-intent-check:${intentId}`;
}

export type OwnerIntentGateReason =
  | OwnerIntentRejection
  | "check_failed"
  | "check_timed_out"
  | "not_eligible"
  | "no_owner_words";

export interface OwnerIntentGateResult {
  readonly confirmed: boolean;
  readonly reason: OwnerIntentGateReason | null;
  readonly verdict: string | null;
  readonly confidence: number | null;
  readonly quote: string | null;
}

export interface OwnerIntentGateOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly settings: OwnerIntentCheckConfiguration;
  readonly check: OwnerIntentCheckPort;
  readonly ownerWords: (source: RunExecutionSource) => Promise<readonly string[]>;
  readonly state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
  readonly audit: AuditLedgerPort;
  readonly authority: () => AuthorityFence;
  readonly clock: ClockPort;
}

export interface OwnerIntentGateInput {
  readonly intent: Pick<GovernedActionIntent, "id" | "ownerId" | "agentId" | "finalRisk">;
  readonly source: RunExecutionSource;
  readonly row: ToolActionRow;
  readonly invocation: RuntimeToolInvocation;
  readonly externalSources: readonly string[];
}

export function ownerIntentEligible(input: {
  readonly source: Pick<RunExecutionSource, "sourceType">;
  readonly row: Pick<
    ToolActionRow,
    | "actionKind"
    | "reversible"
    | "disclosure"
    | "ownerPresenceRequired"
    | "standingRuleChange"
    | "targetType"
  >;
  readonly finalRisk: GovernedActionIntent["finalRisk"];
  readonly externalSources: readonly string[];
}): boolean {
  const { source, row, finalRisk, externalSources } = input;
  return (
    source.sourceType === "user_message" &&
    externalSources.length > 0 &&
    row.actionKind === "CREATE_OR_UPDATE" &&
    finalRisk === "MEDIUM" &&
    row.reversible &&
    row.disclosure === "none" &&
    row.targetType !== "managed-task" &&
    !row.ownerPresenceRequired &&
    !row.standingRuleChange
  );
}

export class OwnerIntentGate {
  readonly #options: OwnerIntentGateOptions;

  constructor(options: OwnerIntentGateOptions) {
    this.#options = options;
  }

  async confirm(input: OwnerIntentGateInput): Promise<boolean> {
    const { settings, state, configuration } = this.#options;
    if (!settings.enabled) return false;
    if (
      !ownerIntentEligible({
        source: input.source,
        row: input.row,
        finalRisk: input.intent.finalRisk,
        externalSources: input.externalSources,
      })
    )
      return false;
    const key = ownerIntentCheckKey(input.intent.id);
    const recorded = await state.readScopedState(configuration.ownerId, configuration.agentId, key);
    if (recorded) return recorded.value["confirmed"] === true;
    const result = await this.#run(input);
    await this.#record(input, key, result);
    return result.confirmed;
  }

  async #run(input: OwnerIntentGateInput): Promise<OwnerIntentGateResult> {
    const { settings, check, ownerWords } = this.#options;
    const none = (reason: OwnerIntentGateReason): OwnerIntentGateResult => ({
      confirmed: false,
      reason,
      verdict: null,
      confidence: null,
      quote: null,
    });
    let words: readonly string[];
    try {
      words = (await ownerWords(input.source)).filter((text) => text.trim().length > 0);
    } catch {
      return none("no_owner_words");
    }
    if (words.length === 0) return none("no_owner_words");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), settings.timeoutMs);
    try {
      const raw = await Promise.race([
        check.check(
          {
            ownerWords: words,
            action: {
              tool: input.row.tool,
              capabilityRef: input.invocation.capabilityRef,
              operation: input.row.operation,
              parameters: input.invocation.arguments,
            },
          },
          timeout.signal,
        ),
        new Promise<never>((_, reject) =>
          timeout.signal.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          }),
        ),
      ]);
      const outcome = judgeOwnerIntent(raw, words, settings.minConfidence);
      const answer = outcome.confirmed
        ? outcome.answer
        : ((raw as { verdict?: string; confidence?: number; quote?: string } | null) ?? null);
      return {
        confirmed: outcome.confirmed,
        reason: outcome.confirmed ? null : outcome.reason,
        verdict: typeof answer?.verdict === "string" ? answer.verdict : null,
        confidence: typeof answer?.confidence === "number" ? answer.confidence : null,
        quote: outcome.confirmed ? outcome.answer.quote : null,
      };
    } catch {
      return none(timeout.signal.aborted ? "check_timed_out" : "check_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async #record(
    input: OwnerIntentGateInput,
    key: string,
    result: OwnerIntentGateResult,
  ): Promise<void> {
    const { configuration, state, clock, settings } = this.#options;
    const checkedAt = clock.now();
    const value = {
      intentId: input.intent.id,
      runId: input.source.runId,
      tool: input.row.tool,
      modelRef: settings.modelRef,
      minConfidence: settings.minConfidence,
      externalSources: [...input.externalSources],
      ...result,
      checkedAt,
    };
    await state
      .commitStateAndEvents({
        command: {
          ownerId: configuration.ownerId,
          agentId: configuration.agentId,
          commandType: "authorization.owner_intent.checked",
          idempotencyKey: key as IdempotentAgentCommand["idempotencyKey"],
          commandFingerprint: digest(value),
          authority: this.#options.authority(),
        },
        state: { key, expectedRevision: null, value },
        events: [],
        resultRef: key,
        committedAt: checkedAt,
      })
      .catch(async (error: unknown) => {
        if (!(await state.readScopedState(configuration.ownerId, configuration.agentId, key)))
          throw error;
      });
    await appendAuditRecord(this.#options.audit, {
      id: `owner-intent:${digest([input.intent.id, result.confirmed])}`,
      ownerId: input.intent.ownerId,
      agentId: input.intent.agentId,
      action: "authorization.owner_intent.checked",
      targetRef: key,
      outcome: result.confirmed ? "completed" : "rejected",
      occurredAt: checkedAt,
    });
  }
}
