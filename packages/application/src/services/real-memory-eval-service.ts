import type { CalibrationDecisionRow } from "@himawari-agent/calibration";
import type { DataClassification } from "../ports/common.js";
import type { ProductMemoryRecord } from "../ports/memory-projection.js";
import type {
  RealEvalItemKind,
  RealEvalQuestionRecord,
  RealEvalRunOutcome,
  RealEvalScope,
  RealEvalStorePort,
  RealEvalTrigger,
} from "../ports/real-eval.js";
import {
  answerPrompt,
  type DecisionEvalGroup,
  summarizeDecisionEval,
  fastPathVerdict,
  judgePrompt,
  leakJudgePrompt,
  parseGeneratedQuestion,
  parseLeakVerdict,
  parseJudgeVerdict,
  pickNewMemories,
  questionPrompt,
  RealEvalBudget,
  RealEvalBudgetExceededError,
  type RealEvalVerdict,
  retireReason,
  type ScoredItem,
  scoreItems,
} from "./real-memory-eval.js";
import { highestClassification } from "./model-visibility.js";

export interface RealEvalModelCall {
  readonly output: string;
  readonly costMicros: number;
}

export interface RealEvalModel {
  readonly modelRef: string;
  estimateMicros(prompt: string, maxOutputTokens: number): number;
  generate(input: {
    readonly invocationId: string;
    readonly prompt: string;
    readonly maxOutputTokens: number;
    readonly dataClassification: DataClassification;
  }): Promise<RealEvalModelCall>;
}

export interface RealEvalRecalledMemory {
  readonly id: string;
  readonly text: string;
  readonly dataClassification: DataClassification;
}

export interface RealEvalRecall {
  readonly memories: readonly RealEvalRecalledMemory[];
  readonly costMicros: number;
}

export interface RealEvalProfile {
  readonly memoryIds: readonly string[];
  readonly texts: readonly string[];
  readonly dataClassification: DataClassification;
}

export interface RealMemoryEvalDependencies {
  readonly scope: RealEvalScope;
  readonly store: RealEvalStorePort;
  readonly model: RealEvalModel;
  readonly now: () => string;
  readonly newId: () => string;
  readonly promptSha256: string;
  readonly maxSelectedMemories: number;
  readonly recallEstimateMicros: number;
  readonly listMemories: () => Promise<readonly ProductMemoryRecord[]>;
  readonly readMemoryText: (record: ProductMemoryRecord) => Promise<string | undefined>;
  readonly readQuote: (record: ProductMemoryRecord) => Promise<string | undefined>;
  readonly storeQuestion: (input: {
    readonly memory: ProductMemoryRecord;
    readonly kind: RealEvalItemKind;
    readonly text: string;
    readonly createdAt: string;
  }) => Promise<string>;
  readonly readQuestion: (ref: string) => Promise<string | undefined>;
  readonly discardQuestion: (ref: string) => Promise<void>;
  readonly recall: (
    question: string,
    dataClassification: DataClassification,
  ) => Promise<RealEvalRecall>;
  readonly profile: () => Promise<RealEvalProfile>;
  readonly decisions?: () => Promise<readonly CalibrationDecisionRow[]>;
}

export type RealEvalSampleReport = Pick<
  RealEvalRunReport,
  "runId" | "outcome" | "costMicros" | "sample"
>;

export interface RealEvalRunLimits {
  readonly runId?: string;
  readonly capMicros: number;
  readonly newMemoriesPerRun: number;
  readonly sampleSize?: number;
  readonly writeSample?: (report: RealEvalSampleReport) => Promise<void>;
}

export interface RealEvalSampleItem {
  readonly panel: "fixed" | "fresh";
  readonly kind: RealEvalItemKind;
  readonly question: string;
  readonly response: string;
  readonly verdict: RealEvalVerdict;
  readonly quote: string;
  readonly memory: string;
}

export const QUESTION_OUTPUT_TOKENS = 400;
export const ANSWER_OUTPUT_TOKENS = 300;
export const JUDGE_OUTPUT_TOKENS = 100;
export const LEAK_JUDGE_OUTPUT_TOKENS = 60;
export const RECENT_RUNS_FOR_DECLINES = 520;
export const SOURCE_READS_PER_SLOT = 4;

export interface RealEvalRunReport {
  readonly runId: string;
  readonly outcome: RealEvalRunOutcome;
  readonly costMicros: number;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly sample: readonly RealEvalSampleItem[];
}

interface PendingItem {
  readonly question: RealEvalQuestionRecord;
  readonly panel: "fixed" | "fresh";
}

function declinedKey(memoryId: string, revision: number): string {
  return `${memoryId}@${revision}`;
}

function declinedFromRuns(
  runs: readonly { readonly summary: Readonly<Record<string, unknown>> }[],
): Set<string> {
  const keys = new Set<string>();
  for (const run of runs) {
    const declined = run.summary["declined"];
    if (!Array.isArray(declined)) continue;
    for (const entry of declined) if (typeof entry === "string") keys.add(entry);
  }
  return keys;
}

function unreadableOfLatestRun(
  runs: readonly { readonly summary: Readonly<Record<string, unknown>> }[],
): string[] {
  const keys = runs[0]?.summary["unreadable"];
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
}

function undiscardedOfRuns(
  runs: readonly { readonly summary: Readonly<Record<string, unknown>> }[],
): string[] {
  const refs = new Set<string>();
  for (const run of runs) {
    const entries = run.summary["undiscarded"];
    if (!Array.isArray(entries)) continue;
    for (const ref of entries) if (typeof ref === "string" && ref.length > 0) refs.add(ref);
  }
  return [...refs];
}

export class RealMemoryEvalService {
  readonly #dependencies: RealMemoryEvalDependencies;

  constructor(dependencies: RealMemoryEvalDependencies) {
    this.#dependencies = dependencies;
  }

  async run(trigger: RealEvalTrigger, limits: RealEvalRunLimits): Promise<RealEvalRunReport> {
    const deps = this.#dependencies;
    const runId = limits.runId ?? deps.newId();
    const startedAt = deps.now();
    const budget = new RealEvalBudget(limits.capMicros);
    const rejected: Record<string, number> = {};
    const declined: string[] = [];
    const undiscarded: string[] = [];
    const unreadable: string[] = [];
    const scored: ScoredItem[] = [];
    const sample: RealEvalSampleItem[] = [];
    let retired = 0;
    let added = 0;
    let judged = 0;
    let fastPath = 0;
    let unanswerable = 0;
    let unanswered = 0;
    let planned = 0;
    let outcome: RealEvalRunOutcome = "completed";
    let failure: string | null = null;

    const call = async (
      prompt: string,
      maxOutputTokens: number,
      classification: DataClassification,
    ) => {
      const estimate = deps.model.estimateMicros(prompt, maxOutputTokens);
      budget.reserve(estimate);
      let result: Awaited<ReturnType<RealEvalModel["generate"]>>;
      try {
        result = await deps.model.generate({
          invocationId: deps.newId(),
          prompt,
          maxOutputTokens,
          dataClassification: classification,
        });
      } catch (error) {
        budget.absorb(estimate);
        throw error;
      }
      budget.record(result.costMicros);
      return result.output;
    };

    const readSource = async (memory: ProductMemoryRecord) => {
      try {
        return {
          text: await deps.readMemoryText(memory),
          quote: await deps.readQuote(memory),
          unreadable: false,
        };
      } catch {
        return { text: undefined, quote: undefined, unreadable: true };
      }
    };

    try {
      const recentRuns = await deps.store.listRuns({
        ...deps.scope,
        limit: RECENT_RUNS_FOR_DECLINES,
      });
      for (const ref of undiscardedOfRuns(recentRuns))
        await deps.discardQuestion(ref).catch(() => {
          if (!undiscarded.includes(ref)) undiscarded.push(ref);
        });
      const memories = await deps.listMemories();
      const byId = new Map<string, ProductMemoryRecord>(
        memories.map((record) => [record.id, record]),
      );
      const active: RealEvalQuestionRecord[] = [];
      for (const question of await deps.store.listQuestions(deps.scope)) {
        if (question.retiredAt !== null) continue;
        const reason = retireReason(question, byId.get(question.memoryId), startedAt);
        if (reason) {
          await deps.store.retireQuestion({
            ...deps.scope,
            id: question.id,
            reason,
            at: startedAt,
          });
          retired += 1;
        } else active.push(question);
      }
      const pending: PendingItem[] = [];
      planned = active.length;
      const skip = declinedFromRuns(recentRuns);
      const candidates = memories.filter(
        (record) => !skip.has(declinedKey(record.id, record.revision)),
      );
      const banked = new Set(active.map(({ memoryId }) => memoryId));
      const deferred = new Set(unreadableOfLatestRun(recentRuns));
      const ordered = pickNewMemories(candidates, banked, startedAt, candidates.length);
      const queue = [
        ...ordered.filter((record) => !deferred.has(declinedKey(record.id, record.revision))),
        ...ordered.filter((record) => deferred.has(declinedKey(record.id, record.revision))),
      ];
      const attempted = new Set<string>();
      let asked = 0;
      let reads = 0;
      for (const memory of queue) {
        if (
          asked >= limits.newMemoriesPerRun ||
          reads >= limits.newMemoriesPerRun * SOURCE_READS_PER_SLOT
        )
          break;
        reads += 1;
        attempted.add(declinedKey(memory.id, memory.revision));
        const source = await readSource(memory);
        if (source.unreadable) {
          rejected["source_unreadable"] = (rejected["source_unreadable"] ?? 0) + 1;
          unreadable.push(declinedKey(memory.id, memory.revision));
          continue;
        }
        asked += 1;
        if (source.text === undefined || source.quote === undefined) {
          rejected["source_missing"] = (rejected["source_missing"] ?? 0) + 1;
          declined.push(declinedKey(memory.id, memory.revision));
          continue;
        }
        const { text, quote } = source;
        const output = await call(
          questionPrompt({ memory: text, quote }),
          QUESTION_OUTPUT_TOKENS,
          memory.dataClassification,
        );
        const generated = parseGeneratedQuestion(output, { memory: text, quote });
        if ("rejected" in generated) {
          rejected[generated.rejected] = (rejected[generated.rejected] ?? 0) + 1;
          if (generated.rejected !== "response_invalid")
            declined.push(declinedKey(memory.id, memory.revision));
          continue;
        }
        const leaksToModel = async (questionText: string) => {
          try {
            return (
              (parseLeakVerdict(
                await call(
                  leakJudgePrompt({ question: questionText, memory: text, quote }),
                  LEAK_JUDGE_OUTPUT_TOKENS,
                  memory.dataClassification,
                ),
              ) ?? true) === true
            );
          } catch (error) {
            if (error instanceof RealEvalBudgetExceededError) throw error;
            return true;
          }
        };
        if (await leaksToModel(generated.question)) {
          rejected["leak"] = (rejected["leak"] ?? 0) + 1;
          declined.push(declinedKey(memory.id, memory.revision));
          continue;
        }
        const entries: [RealEvalItemKind, string][] = [[generated.kind, generated.question]];
        if (generated.abstainQuestion !== null) {
          if (await leaksToModel(generated.abstainQuestion))
            rejected["leak"] = (rejected["leak"] ?? 0) + 1;
          else entries.push(["abstain", generated.abstainQuestion]);
        }
        for (const [kind, questionText] of entries) {
          const createdAt = deps.now();
          const questionRef = await deps.storeQuestion({
            memory,
            kind,
            text: questionText,
            createdAt,
          });
          const question = {
            id: deps.newId(),
            memoryId: memory.id,
            memoryRevision: memory.revision,
            kind,
            questionRef,
            questionModel: deps.model.modelRef,
            promptSha256: deps.promptSha256,
            createdAt,
          };
          let stored = false;
          try {
            stored = await deps.store.addQuestion({ ...deps.scope, question });
          } finally {
            if (!stored)
              await deps.discardQuestion(questionRef).catch(() => {
                rejected["discard_failed"] = (rejected["discard_failed"] ?? 0) + 1;
                undiscarded.push(questionRef);
              });
          }
          if (!stored) {
            rejected["already_banked"] = (rejected["already_banked"] ?? 0) + 1;
            const key = declinedKey(memory.id, memory.revision);
            if (!declined.includes(key)) declined.push(key);
          } else {
            added += 1;
            planned += 1;
            pending.push({
              question: { ...question, retiredAt: null, retiredReason: null },
              panel: "fresh",
            });
          }
        }
      }
      for (const key of deferred)
        if (
          !attempted.has(key) &&
          candidates.some((record) => declinedKey(record.id, record.revision) === key)
        )
          unreadable.push(key);
      pending.push(...active.map((question) => ({ question, panel: "fixed" as const })));

      const profile = await deps.profile();
      for (const { question, panel } of pending) {
        const memory = byId.get(question.memoryId);
        const questionText = await deps
          .readQuestion(question.questionRef)
          .catch((): undefined => undefined);
        const { text, quote } = memory
          ? await readSource(memory)
          : { text: undefined, quote: undefined };
        if (!memory || questionText === undefined || text === undefined || quote === undefined) {
          unanswerable += 1;
          continue;
        }
        const abstain = question.kind === "abstain";
        budget.ensureRemaining();
        budget.reserve(deps.recallEstimateMicros);
        let recall: RealEvalRecall;
        try {
          recall = await deps.recall(questionText, memory.dataClassification);
        } catch (error) {
          budget.absorb(deps.recallEstimateMicros);
          throw error;
        }
        budget.record(recall.costMicros);
        const inProfile = new Set(profile.memoryIds);
        const recalled = recall.memories
          .filter(({ id }) => !inProfile.has(id))
          .slice(0, deps.maxSelectedMemories);
        const classification = highestClassification(memory.dataClassification, [
          profile.dataClassification,
          ...recalled.map(({ dataClassification }) => dataClassification),
        ]);
        const response = await call(
          answerPrompt({
            profile: profile.texts,
            memories: recalled.map(({ text }) => text),
            question: questionText,
            now: deps.now(),
          }),
          ANSWER_OUTPUT_TOKENS,
          classification,
        );
        let verdict: RealEvalVerdict | null = fastPathVerdict({ response, quote, abstain });
        if (verdict) fastPath += 1;
        else {
          verdict = parseJudgeVerdict(
            await call(
              judgePrompt({ question: questionText, quote, memory: text, response, abstain }),
              JUDGE_OUTPUT_TOKENS,
              classification,
            ),
          );
          if (verdict === null) {
            rejected["judge_invalid"] = (rejected["judge_invalid"] ?? 0) + 1;
            continue;
          }
          judged += 1;
        }
        scored.push({
          panel,
          kind: question.kind,
          verdict,
          retrievedReference: abstain
            ? null
            : recalled.some(({ id }) => id === question.memoryId) ||
              inProfile.has(question.memoryId),
        });
        if (sample.length < (limits.sampleSize ?? 0))
          sample.push({
            panel,
            kind: question.kind,
            question: questionText,
            response,
            verdict,
            quote,
            memory: text,
          });
      }
    } catch (error) {
      if (error instanceof RealEvalBudgetExceededError) {
        outcome = "budget_exceeded";
        unanswered = Math.max(
          0,
          planned - scored.length - unanswerable - (rejected["judge_invalid"] ?? 0),
        );
      } else {
        outcome = "failed";
        failure = error instanceof Error ? error.name : "unknown";
      }
    }

    if (limits.writeSample)
      try {
        await limits.writeSample({ runId, outcome, costMicros: budget.spentMicros, sample });
      } catch (error) {
        outcome = "failed";
        failure = error instanceof Error ? error.name : "unknown";
      }

    let decisions: readonly DecisionEvalGroup[] | null = null;
    if (deps.decisions && outcome !== "failed")
      try {
        decisions = summarizeDecisionEval(await deps.decisions());
      } catch {
        decisions = null;
      }
    const summary = {
      scores: scoreItems(scored),
      decisions,
      items: scored.length,
      retired,
      added,
      judged,
      fastPath,
      unanswerable,
      unanswered,
      rejected,
      declined,
      undiscarded,
      unreadable,
      ...(failure === null ? {} : { failure }),
    };
    await deps.store.recordRun({
      ...deps.scope,
      run: {
        id: runId,
        startedAt,
        finishedAt: deps.now(),
        outcome,
        trigger,
        model: deps.model.modelRef,
        costMicros: budget.spentMicros,
        summary,
      },
    });
    return { runId, outcome, costMicros: budget.spentMicros, summary, sample };
  }
}
