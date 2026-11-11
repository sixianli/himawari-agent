import type { CalibrationGroup, CalibrationRating } from "@himawari-agent/calibration";
import {
  acceptsPrereview,
  DEFAULT_PREREVIEW_AGREEMENT_PERMILLE,
  DEFAULT_PREREVIEW_AUDIT_PERMILLE,
  DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE,
  DEFAULT_PREREVIEW_HISTORY_DAYS,
  DEFAULT_PREREVIEW_HISTORY_MINIMUM,
  historyConflict,
  type PrereviewPair,
  type PrereviewRating,
  prereviewOptions,
  summarizePrereviewAgreement,
  wouldHide,
} from "@himawari-agent/calibration/prereview";
import { REVIEW_PREREVIEW } from "@himawari-agent/prompt-catalog";

import { maskSensitiveText } from "@himawari-agent/sensitive-capture";
import type { DataClassification } from "../ports/common.js";
import type { ReviewPrereviewConfiguration } from "../ports/configuration.js";
import type { ModelInvocationRequest } from "../ports/intelligence.js";
import type { ProactiveScope } from "../ports/proactive-checks.js";
import type { ClockPort } from "../ports/system.js";
import { type DailyReviewCandidate, type DailyReviewSubject, reviewHash } from "./daily-review.js";
import type { ProactiveModelInvoker } from "./proactive-mail-check-service.js";
import { startOfZonedDay } from "./proactive-rules.js";

const MAX_OUTPUT_BYTES = 4_096;

export const DEFAULT_REVIEW_PREREVIEW: ReviewPrereviewConfiguration = Object.freeze({
  enabled: true,
  dailyLimit: 50,
  dailyCostMicros: 100_000,
  perRun: 10,
  requestTimeoutMs: 30_000,
  historyDays: DEFAULT_PREREVIEW_HISTORY_DAYS,
  historyMinimum: DEFAULT_PREREVIEW_HISTORY_MINIMUM,
  reduction: Object.freeze({
    enabled: false,
    hiddenAgreementPermille: DEFAULT_PREREVIEW_AGREEMENT_PERMILLE,
    confidencePermille: DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE,
    auditPermille: DEFAULT_PREREVIEW_AUDIT_PERMILLE,
    windowDays: DEFAULT_PREREVIEW_HISTORY_DAYS,
  }),
});
const DAY_MS = 86_400_000;

export interface PrereviewModelReply {
  readonly rating: PrereviewRating;
  readonly confidencePermille: number;
}

export function prereviewPrompt(
  subject: Pick<DailyReviewSubject, "group" | "category" | "text">,
): string {
  return [
    REVIEW_PREREVIEW.text,
    JSON.stringify({
      group: subject.group,
      options: prereviewOptions(subject.group),
      category: subject.category,
      text: maskSensitiveText(subject.text),
    }),
  ].join("\n");
}

export function parsePrereview(
  output: string,
  group: CalibrationGroup,
): PrereviewModelReply | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const rating = (parsed as Record<string, unknown>)["rating"];
  const confidence = (parsed as Record<string, unknown>)["confidence"];
  if (typeof rating !== "string" || !acceptsPrereview(group, rating)) return undefined;
  if (typeof confidence !== "number" || !Number.isInteger(confidence)) return undefined;
  if (confidence < 0 || confidence > 1000) return undefined;
  return { rating, confidencePermille: rating === "unsure" ? 0 : confidence };
}

export function prereviewAuditPicked(seed: string, key: string, auditPermille: number): boolean {
  return reviewHash(`prereview-audit|${seed}|${key}`) % 1000 < auditPermille;
}

export interface PrereviewRecord {
  readonly key: string;
  readonly group: CalibrationGroup;
  readonly category: string | null;
  readonly rating: PrereviewRating;
  readonly confidencePermille: number;
  readonly historyConflict: boolean;
  readonly modelRef: string;
  readonly promptId: string;
  readonly textDigest: string;
  readonly dataClassification: DataClassification;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface PrereviewPairRecord {
  readonly group: CalibrationGroup;
  readonly rating: PrereviewRating;
  readonly confidencePermille: number;
  readonly historyConflict: boolean;
  readonly ownerRating: CalibrationRating | null;
}

export interface ReviewPrereviewStorePort {
  listPrereviewed(
    input: ProactiveScope & {
      readonly keys: readonly string[];
      readonly modelRef: string;
      readonly promptId: string;
    },
  ): Promise<ReadonlyMap<string, PrereviewRecord>>;
  countSince(input: ProactiveScope & { readonly since: string }): Promise<{
    readonly items: number;
    readonly costMicros: number;
  }>;
  ownerHistory(
    input: ProactiveScope & {
      readonly group: CalibrationGroup;
      readonly category: string | null;
      readonly since: string;
    },
  ): Promise<readonly CalibrationRating[]>;
  listPairs(
    input: ProactiveScope & {
      readonly since: string;
      readonly modelRef: string;
      readonly promptId: string;
    },
  ): Promise<readonly PrereviewPairRecord[]>;
  record(input: ProactiveScope & PrereviewRecord): Promise<void>;
}

export type ReviewPrereviewSettings = ReviewPrereviewConfiguration;

export interface ReviewPrereviewOptions {
  readonly scope: ProactiveScope;
  readonly store: ReviewPrereviewStorePort;
  readonly model: ProactiveModelInvoker;
  readonly settings: ReviewPrereviewSettings;
  readonly timeZone: string;
  readonly clock: ClockPort;
  readonly digest: (text: string) => string;
  readonly estimateCostMicros: (prompt: string) => number;
  readonly subjects: () => Promise<readonly DailyReviewSubject[]>;
}

export interface PrereviewRunResult {
  readonly attempted: number;
  readonly recorded: number;
  readonly failures: readonly string[];
  readonly stoppedBy: "done" | "daily_limit" | "daily_cost" | "disabled";
}

export const PREREVIEW_FAILURE_BACKOFF_MS = DAY_MS;

export class ReviewPrereviewService {
  readonly #options: ReviewPrereviewOptions;
  readonly #failedAt = new Map<string, number>();

  constructor(options: ReviewPrereviewOptions) {
    this.#options = options;
  }

  get promptId(): string {
    return `${REVIEW_PREREVIEW.id}@${this.#options.digest(REVIEW_PREREVIEW.text).slice(0, 12)}`;
  }

  async run(): Promise<PrereviewRunResult> {
    const { scope, store, settings, clock } = this.#options;
    if (!settings.enabled)
      return { attempted: 0, recorded: 0, failures: [], stoppedBy: "disabled" };
    const now = clock.now();
    const dayStart = startOfZonedDay(now, this.#options.timeZone);
    const spent = await store.countSince({ ...scope, since: dayStart });
    const subjects = await this.#options.subjects();
    const done = await store.listPrereviewed({
      ...scope,
      keys: subjects.map(({ key }) => key),
      modelRef: this.#options.model.modelRef,
      promptId: this.promptId,
    });
    const nowMs = Date.parse(now);
    for (const [key, at] of this.#failedAt)
      if (nowMs - at >= PREREVIEW_FAILURE_BACKOFF_MS) this.#failedAt.delete(key);
    const pending = subjects
      .filter((subject) => !done.has(subject.key) && !this.#failedAt.has(subject.key))
      .sort(
        (left, right) =>
          Number(left.ownerRating !== null) - Number(right.ownerRating !== null) ||
          (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
      );
    let items = spent.items;
    let costMicros = spent.costMicros;
    let attempted = 0;
    let recorded = 0;
    const failures: string[] = [];
    for (const subject of pending.slice(0, settings.perRun)) {
      if (items >= settings.dailyLimit)
        return { attempted, recorded, failures, stoppedBy: "daily_limit" };
      const prompt = prereviewPrompt(subject);
      if (costMicros + this.#options.estimateCostMicros(prompt) > settings.dailyCostMicros)
        return { attempted, recorded, failures, stoppedBy: "daily_cost" };
      attempted += 1;
      const result = await this.#invoke(subject, prompt).catch((error: unknown) => ({
        reply: undefined,
        failure: `PREREVIEW_FAILED:${error instanceof Error ? error.message : "unknown"}`,
        costMicros: 0,
        durationMs: 0,
      }));
      costMicros += result.costMicros;
      if (result.reply === undefined) {
        this.#failedAt.set(subject.key, nowMs);
        failures.push(result.failure);
        continue;
      }
      const since = new Date(Date.parse(now) - settings.historyDays * DAY_MS).toISOString();
      const history = await store.ownerHistory({
        ...scope,
        group: subject.group,
        category: subject.category,
        since,
      });
      await store.record({
        ...scope,
        key: subject.key,
        group: subject.group,
        category: subject.category,
        rating: result.reply.rating,
        confidencePermille: result.reply.confidencePermille,
        historyConflict: historyConflict(result.reply.rating, history, settings.historyMinimum),
        modelRef: this.#options.model.modelRef,
        promptId: this.promptId,
        textDigest: this.#options.digest(subject.text),
        dataClassification: subject.dataClassification,
        costMicros: result.costMicros,
        durationMs: result.durationMs,
        createdAt: clock.now(),
      });
      items += 1;
      recorded += 1;
    }
    return { attempted, recorded, failures, stoppedBy: "done" };
  }

  async hiddenByModel(candidates: readonly DailyReviewCandidate[]): Promise<ReadonlySet<string>> {
    const { scope, store, settings, clock } = this.#options;
    const hidden = new Set<string>();
    if (!settings.enabled || !settings.reduction.enabled) return hidden;
    const reduction = settings.reduction;
    const since = new Date(Date.parse(clock.now()) - reduction.windowDays * DAY_MS).toISOString();
    const modelRef = this.#options.model.modelRef;
    const pairs = await store.listPairs({ ...scope, since, modelRef, promptId: this.promptId });
    const agreement = summarizePrereviewAgreement(
      pairs.map(
        (pair): PrereviewPair => ({
          group: pair.group,
          model: pair.rating,
          confidencePermille: pair.confidencePermille,
          historyConflict: pair.historyConflict,
          owner: pair.ownerRating,
        }),
      ),
      {
        agreementPermille: reduction.hiddenAgreementPermille,
        confidencePermille: reduction.confidencePermille,
      },
    );
    const open = new Set(agreement.filter(({ gate }) => gate.open).map(({ group }) => group));
    if (open.size === 0) return hidden;
    const reducible = candidates.filter(
      (candidate): candidate is DailyReviewCandidate & { readonly group: CalibrationGroup } =>
        candidate.group !== null && open.has(candidate.group),
    );
    const prereviewed = await store.listPrereviewed({
      ...scope,
      keys: reducible.map(({ key }) => key),
      modelRef,
      promptId: this.promptId,
    });
    const seed = `${scope.ownerId}:${scope.agentId}`;
    for (const candidate of reducible) {
      const record = prereviewed.get(candidate.key);
      if (record === undefined || record.group !== candidate.group) continue;
      if (prereviewAuditPicked(seed, candidate.key, reduction.auditPermille)) continue;
      if (
        wouldHide(
          {
            model: record.rating,
            confidencePermille: record.confidencePermille,
            historyConflict: record.historyConflict,
          },
          reduction.confidencePermille,
        )
      )
        hidden.add(candidate.key);
    }
    return hidden;
  }

  async #invoke(
    subject: DailyReviewSubject,
    prompt: string,
  ): Promise<{
    readonly reply: PrereviewModelReply | undefined;
    readonly failure: string;
    readonly costMicros: number;
    readonly durationMs: number;
  }> {
    const { model, clock, settings } = this.#options;
    const startedAt = Date.parse(clock.now());
    const invocationId = `review-prereview:${subject.key}:${startedAt}`;
    const authority = await model.prepare({
      invocationId,
      prompt,
      deadlineAt: new Date(startedAt + settings.requestTimeoutMs).toISOString(),
      dataClassification: subject.dataClassification,
    });
    const outputs: string[] = [];
    let output = "";
    let failure = "MODEL_NOT_COMPLETED";
    let costMicros = 0;
    let completed = false;
    try {
      const request: ModelInvocationRequest = {
        signal: AbortSignal.timeout(settings.requestTimeoutMs),
        invocationId,
        runId: authority.runId,
        modelRef: model.modelRef,
        inputRef: authority.inputRef,
        dataClassification: subject.dataClassification,
        allowedDisclosureRef: authority.allowedDisclosureRef,
        secretHandleRefs: [...authority.secretHandleRefs],
        correlationId: invocationId as ModelInvocationRequest["correlationId"],
      };
      for await (const event of model.model.invoke(request)) {
        if (event.invocationId !== invocationId) break;
        if (event.type === "model.failed") {
          failure = `MODEL_FAILED:${event.errorCode}`;
          break;
        }
        if (event.type === "model.output") {
          outputs.push(event.payloadRef);
          output += await model.readOutput(event.payloadRef);
          if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) {
            failure = "MODEL_OUTPUT_TOO_LARGE";
            break;
          }
        }
        if (event.type === "model.completed") {
          costMicros = Number.isSafeInteger(event.costMicros) ? Math.max(0, event.costMicros) : 0;
          completed = true;
          break;
        }
      }
    } finally {
      await authority.release();
      await model.release(outputs).catch(() => undefined);
    }
    const durationMs = Math.max(0, Date.parse(clock.now()) - startedAt);
    if (!completed) return { reply: undefined, failure, costMicros, durationMs };
    const reply = parsePrereview(output, subject.group);
    return {
      reply,
      failure: reply === undefined ? "MODEL_OUTPUT_INVALID" : "",
      costMicros,
      durationMs,
    };
  }
}
