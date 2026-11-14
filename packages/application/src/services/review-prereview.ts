import type { CalibrationGroup } from "@himawari-agent/calibration";
import {
  acceptsPrereview,
  DEFAULT_PREREVIEW_AGREEMENT_PERMILLE,
  DEFAULT_PREREVIEW_AUDIT_PERMILLE,
  DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE,
  DEFAULT_PREREVIEW_HISTORY_DAYS,
  DEFAULT_PREREVIEW_HISTORY_MINIMUM,
  historyConflict,
  PREREVIEW_GROUPS,
  type PrereviewPair,
  type PrereviewRating,
  prereviewOptions,
  summarizePrereviewAgreement,
  wouldHide,
} from "@himawari-agent/calibration/prereview";
import { REVIEW_PREREVIEW } from "@himawari-agent/prompt-catalog";
import { maskSensitiveText } from "@himawari-agent/sensitive-capture";
import type { ReviewPrereviewConfiguration } from "../ports/configuration.js";
import type { ModelInvocationRequest } from "../ports/intelligence.js";
import type { ProactiveScope } from "../ports/proactive-checks.js";
import type {
  PrereviewDone,
  PrereviewSubjectRef,
  ReviewPrereviewStorePort,
} from "../ports/review-prereview.js";
import type { ClockPort } from "../ports/system.js";
import {
  type DailyReviewCandidate,
  type DailyReviewSubject,
  type DailyReviewSubjectSource,
  parseReviewKey,
  reviewHash,
  reviewKey,
} from "./daily-review.js";
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

const FAILURE_CODE =
  /^(MODEL|PREREVIEW|PORT|SQLITE|DECISION)_[A-Z0-9_]{1,80}(:[A-Z0-9_.-]{1,40})?$/u;

function failureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  const message = error instanceof Error ? error.message : "";
  if (typeof code === "string" && FAILURE_CODE.test(code)) return code;
  return FAILURE_CODE.test(message) ? message : "unknown";
}

export function prereviewPromptId(digest: (text: string) => string): string {
  const options = JSON.stringify(PREREVIEW_GROUPS.map((group) => [group, prereviewOptions(group)]));
  return `${REVIEW_PREREVIEW.id}@${digest(`${REVIEW_PREREVIEW.text}\n${options}`).slice(0, 12)}`;
}

export function prereviewAuditPicked(seed: string, key: string, auditPermille: number): boolean {
  return reviewHash(`prereview-audit|${seed}|${key}`) % 1000 < auditPermille;
}

function subjectRef(key: string): PrereviewSubjectRef | undefined {
  const parsed = parseReviewKey(key);
  if (parsed === undefined || parsed.source === "checkup") return undefined;
  return { source: parsed.source, id: parsed.id };
}

function refKey(ref: PrereviewSubjectRef): string {
  return reviewKey(ref.source, ref.id);
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
  readonly subjects: () => Promise<readonly DailyReviewSubjectSource[]>;
}

export interface PrereviewRunResult {
  readonly attempted: number;
  readonly recorded: number;
  readonly failures: readonly string[];
  readonly skippedClassification: number;
  readonly stoppedBy: "done" | "daily_limit" | "daily_cost" | "disabled";
}

export const PREREVIEW_FAILURE_BACKOFF_MS = DAY_MS;

export class ReviewPrereviewService {
  readonly #options: ReviewPrereviewOptions;
  readonly #storeFailedAt = new Map<string, number>();
  readonly #classificationSkipped = new Map<
    string,
    { classification: ProactiveModelInvoker["allowedDataClassifications"][number]; at: number }
  >();

  constructor(options: ReviewPrereviewOptions) {
    this.#options = options;
  }

  get promptId(): string {
    return prereviewPromptId(this.#options.digest);
  }

  async run(): Promise<PrereviewRunResult> {
    const { scope, store, settings, clock } = this.#options;
    if (!settings.enabled)
      return {
        attempted: 0,
        recorded: 0,
        failures: [],
        skippedClassification: 0,
        stoppedBy: "disabled",
      };
    const now = clock.now();
    const nowMs = Date.parse(now);
    const dayStart = startOfZonedDay(now, this.#options.timeZone);
    const version = { modelRef: this.#options.model.modelRef, promptId: this.promptId };
    const spent = await store.countSince({ ...scope, since: dayStart });
    if (spent.attempts >= settings.dailyLimit)
      return {
        attempted: 0,
        recorded: 0,
        failures: [],
        skippedClassification: 0,
        stoppedBy: "daily_limit",
      };
    for (const [key, at] of this.#storeFailedAt)
      if (nowMs - at >= PREREVIEW_FAILURE_BACKOFF_MS) this.#storeFailedAt.delete(key);
    for (const [key, { at }] of this.#classificationSkipped)
      if (nowMs - at >= PREREVIEW_FAILURE_BACKOFF_MS) this.#classificationSkipped.delete(key);
    const subjects = (await this.#options.subjects()).flatMap((source) => {
      const ref = subjectRef(source.key);
      return ref === undefined ? [] : [{ source, ref }];
    });
    const refs = subjects.map(({ ref }) => ref);
    const done = new Set(
      (await store.listDone({ ...scope, ...version, subjects: refs })).map(({ subject }) =>
        refKey(subject),
      ),
    );
    const failedRecently = new Set(
      (
        await store.listRecentFailures({
          ...scope,
          ...version,
          subjects: refs,
          since: new Date(nowMs - PREREVIEW_FAILURE_BACKOFF_MS).toISOString(),
        })
      ).map(refKey),
    );
    const pending = subjects
      .filter(
        ({ source }) =>
          !done.has(source.key) &&
          !failedRecently.has(source.key) &&
          !this.#storeFailedAt.has(source.key),
      )
      .sort(
        (left, right) =>
          Number(left.source.rated) - Number(right.source.rated) ||
          (left.source.key < right.source.key ? -1 : left.source.key > right.source.key ? 1 : 0),
      );
    let attempts = spent.attempts;
    let costMicros = spent.costMicros;
    let attempted = 0;
    let recorded = 0;
    const failures: string[] = [];
    let skippedClassification = 0;
    for (const { source, ref } of pending) {
      if (attempted >= settings.perRun) break;
      if (attempts >= settings.dailyLimit)
        return { attempted, recorded, failures, skippedClassification, stoppedBy: "daily_limit" };
      const allowedClassifications = this.#options.model.allowedDataClassifications;
      const knownSkip = this.#classificationSkipped.get(source.key);
      if (knownSkip !== undefined) {
        if (!allowedClassifications.includes(knownSkip.classification)) {
          skippedClassification += 1;
          continue;
        }
        this.#classificationSkipped.delete(source.key);
      }
      const subject = await source.build().catch(() => undefined);
      if (subject === undefined) continue;
      if (!allowedClassifications.includes(subject.dataClassification)) {
        this.#classificationSkipped.set(source.key, {
          classification: subject.dataClassification,
          at: nowMs,
        });
        skippedClassification += 1;
        continue;
      }
      const prompt = prereviewPrompt(subject);
      if (costMicros + this.#options.estimateCostMicros(prompt) > settings.dailyCostMicros)
        return { attempted, recorded, failures, skippedClassification, stoppedBy: "daily_cost" };
      attempted += 1;
      attempts += 1;
      const startedAt = Date.parse(clock.now());
      const id = `review-prereview:${this.#options.digest(subject.key).slice(0, 16)}:${startedAt}`;
      const result = await this.#invoke(id, startedAt, subject, prompt).catch((error: unknown) => ({
        reply: undefined,
        failure: `PREREVIEW_FAILED:${failureCode(error)}`,
        costMicros: 0,
        durationMs: Math.max(0, Date.parse(clock.now()) - startedAt),
      }));
      costMicros += result.costMicros;
      const attempt = {
        ...scope,
        id,
        subject: ref,
        group: subject.group,
        category: subject.category,
        ...version,
        textDigest: this.#options.digest(subject.text),
        dataClassification: subject.dataClassification,
        costMicros: result.costMicros,
        durationMs: result.durationMs,
        createdAt: clock.now(),
      };
      try {
        if (result.reply === undefined) {
          failures.push(result.failure);
          await store.recordFailure({ ...attempt, failureCode: result.failure.slice(0, 128) });
          continue;
        }
        const since = new Date(nowMs - settings.historyDays * DAY_MS).toISOString();
        const history = await store.ownerHistory({
          ...scope,
          group: subject.group,
          category: subject.category,
          since,
        });
        await store.record({
          ...attempt,
          rating: result.reply.rating,
          confidencePermille: result.reply.confidencePermille,
          historyConflict: historyConflict(result.reply.rating, history, settings.historyMinimum),
        });
        recorded += 1;
      } catch (error) {
        const failure = `PREREVIEW_STORE_FAILED:${failureCode(error)}`;
        failures.push(failure);
        if (result.reply !== undefined)
          await store
            .recordFailure({ ...attempt, failureCode: failure.slice(0, 128) })
            .then(() => undefined)
            .catch(() => this.#storeFailedAt.set(subject.key, nowMs));
        else this.#storeFailedAt.set(subject.key, nowMs);
      }
    }
    return { attempted, recorded, failures, skippedClassification, stoppedBy: "done" };
  }

  async hiddenByModel(candidates: readonly DailyReviewCandidate[]): Promise<ReadonlySet<string>> {
    const { scope, store, settings, clock } = this.#options;
    const hidden = new Set<string>();
    if (!settings.enabled || !settings.reduction.enabled) return hidden;
    const reduction = settings.reduction;
    const since = new Date(Date.parse(clock.now()) - reduction.windowDays * DAY_MS).toISOString();
    const version = { modelRef: this.#options.model.modelRef, promptId: this.promptId };
    const pairs = await store.listPairs({ ...scope, ...version, since });
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
    const reducible = candidates.flatMap((candidate) => {
      const ref = subjectRef(candidate.key);
      return candidate.group !== null && open.has(candidate.group) && ref !== undefined
        ? [{ candidate, ref }]
        : [];
    });
    const records = new Map<string, PrereviewDone>(
      (
        await store.listDone({ ...scope, ...version, subjects: reducible.map(({ ref }) => ref) })
      ).map((record) => [refKey(record.subject), record]),
    );
    const seed = `${scope.ownerId}:${scope.agentId}`;
    for (const { candidate } of reducible) {
      const record = records.get(candidate.key);
      if (record === undefined || record.group !== candidate.group) continue;
      if (prereviewAuditPicked(seed, candidate.key, reduction.auditPermille)) continue;
      if (
        !wouldHide(
          {
            model: record.rating,
            confidencePermille: record.confidencePermille,
            historyConflict: record.historyConflict,
          },
          reduction.confidencePermille,
        )
      )
        continue;
      const text = await candidate.text().catch(() => undefined);
      if (text !== undefined && this.#options.digest(text) === record.textDigest)
        hidden.add(candidate.key);
    }
    return hidden;
  }

  async #invoke(
    invocationId: string,
    startedAt: number,
    subject: DailyReviewSubject,
    prompt: string,
  ): Promise<{
    readonly reply: PrereviewModelReply | undefined;
    readonly failure: string;
    readonly costMicros: number;
    readonly durationMs: number;
  }> {
    const { model, clock, settings } = this.#options;
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
      await authority.release().catch(() => undefined);
      await Promise.all(
        [authority.inputRef, ...outputs].map((ref) => model.release([ref]).catch(() => undefined)),
      );
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
