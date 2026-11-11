import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type DecisionLedgerPort,
  type DurableMemoryService,
  highestClassification,
  type ModelInvocationRequest,
  modelVisibleCeiling,
  modelVisibleClassifications,
  type OwnerProfileService,
  type PayloadProtectorPort,
  type PayloadRef,
  type PayloadStorePort,
  type ProactiveModelInvoker,
  type ProductMemoryStatePort,
  type RealEvalConfiguration,
  type RealEvalModel,
  type RealEvalRecalledMemory,
  type RealEvalRunRecord,
  type RealEvalRunReport,
  type RealEvalScope,
  type RealEvalStorePort,
  type RealEvalTrigger,
  RealMemoryEvalService,
} from "@himawari-agent/application";
import { REAL_EVAL_QUESTION } from "@himawari-agent/prompt-catalog";
import { quoteRefOfMemory } from "./production-memory-consolidation.js";
import type { MailEmbeddingContext } from "./production-run-memory.js";
import { proactiveCostEstimator } from "./production-proactive.js";
import { maskForExport } from "./production-gap-export.js";

export const REAL_EVAL_TICK_MS = 60 * 60 * 1000;
export const REAL_EVAL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const REAL_EVAL_SAMPLE_SIZE = 30;
export const REAL_EVAL_SAMPLE_FILE = "latest-sample.json";
export const DECISION_EVAL_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export function dueRealEvalTrigger(
  mode: RealEvalConfiguration["mode"],
  runs: readonly Pick<RealEvalRunRecord, "startedAt" | "trigger" | "outcome">[],
  now: string,
): RealEvalTrigger | null {
  if (mode === "off") return null;
  if (mode === "once")
    return runs.some(({ trigger, outcome }) => trigger === "manual" && outcome !== "failed")
      ? null
      : "manual";
  const latest = runs.reduce<number | null>((newest, { startedAt }) => {
    const at = Date.parse(startedAt);
    return newest === null || at > newest ? at : newest;
  }, null);
  return latest === null || Date.parse(now) - latest >= REAL_EVAL_INTERVAL_MS ? "weekly" : null;
}

export function createRealEvalModel(options: {
  readonly modelRef: string;
  readonly invoker: (maxOutputTokens: number) => ProactiveModelInvoker;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly requestTimeoutMs: number;
  readonly now: () => string;
}): RealEvalModel {
  const invokers = new Map<number, ProactiveModelInvoker>();
  const invokerFor = (maxOutputTokens: number) => {
    const existing = invokers.get(maxOutputTokens);
    if (existing) return existing;
    const created = options.invoker(maxOutputTokens);
    invokers.set(maxOutputTokens, created);
    return created;
  };
  return {
    modelRef: options.modelRef,
    estimateMicros: (prompt, maxOutputTokens) =>
      proactiveCostEstimator(options.cost, maxOutputTokens * 2)(prompt),
    async generate({ invocationId, prompt, maxOutputTokens, dataClassification }) {
      const model = invokerFor(maxOutputTokens);
      const deadlineAt = new Date(
        Date.parse(options.now()) + options.requestTimeoutMs,
      ).toISOString();
      const authority = await model.prepare({
        invocationId,
        prompt,
        deadlineAt,
        dataClassification,
      });
      const payloads: string[] = [authority.inputRef];
      let output = "";
      let costMicros = 0;
      let failure: string | null = null;
      let completed = false;
      try {
        const request: ModelInvocationRequest = {
          signal: AbortSignal.timeout(options.requestTimeoutMs),
          invocationId,
          runId: authority.runId,
          modelRef: model.modelRef,
          inputRef: authority.inputRef,
          dataClassification,
          allowedDisclosureRef: authority.allowedDisclosureRef,
          secretHandleRefs: [...authority.secretHandleRefs],
          correlationId: invocationId as ModelInvocationRequest["correlationId"],
        };
        for await (const event of model.model.invoke(request)) {
          if (event.invocationId !== invocationId) break;
          if (event.type === "model.failed") {
            failure = event.errorCode;
            break;
          }
          if (event.type === "model.output") {
            payloads.push(event.payloadRef);
            output += await model.readOutput(event.payloadRef);
            if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) {
              failure = "OUTPUT_TOO_LARGE";
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
        await model.release(payloads);
      }
      if (failure !== null) throw new RealEvalModelError(failure);
      if (!completed) throw new RealEvalModelError("MODEL_NOT_COMPLETED");
      return { output, costMicros };
    },
  };
}

export class RealEvalModelError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Real eval model call failed: ${code}`);
    this.name = "RealEvalModelError";
    this.code = code;
  }
}

export async function writeRealEvalSample(
  directory: string,
  report: RealEvalRunReport,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(directory, REAL_EVAL_SAMPLE_FILE);
  const temporary = `${file}.${report.runId}.tmp`;
  const body = {
    runId: report.runId,
    outcome: report.outcome,
    costMicros: report.costMicros,
    items: report.sample.map((item) => ({
      panel: item.panel,
      kind: item.kind,
      verdict: item.verdict,
      question: maskForExport(item.question),
      response: maskForExport(item.response),
      quote: maskForExport(item.quote),
      memory: maskForExport(item.memory),
    })),
  };
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return file;
}

export interface ProductionRealEvalOptions {
  readonly configuration: RealEvalConfiguration;
  readonly scope: RealEvalScope;
  readonly store: Pick<RealEvalStorePort, "listRuns">;
  readonly service: Pick<RealMemoryEvalService, "run">;
  readonly sampleDirectory: string;
  readonly now: () => string;
  readonly tickMs?: number;
  readonly onRun?: (report: RealEvalRunReport, trigger: RealEvalTrigger) => void;
  readonly onFailure?: (error: unknown) => void;
}

export class ProductionRealEval {
  readonly #options: ProductionRealEvalOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: ProductionRealEvalOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer || this.#options.configuration.mode === "off") return;
    this.#timer = setInterval(() => void this.tick(), this.#options.tickMs ?? REAL_EVAL_TICK_MS);
    this.#timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  tick(): Promise<void> {
    this.#running ??= this.#tick()
      .catch((error: unknown) => this.#options.onFailure?.(error))
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #tick(): Promise<void> {
    const { configuration, store, service } = this.#options;
    const runs = await store.listRuns({ ...this.#options.scope, limit: 520 });
    const trigger = dueRealEvalTrigger(configuration.mode, runs, this.#options.now());
    if (trigger === null) return;
    const report = await service.run(trigger, {
      capMicros: configuration.weeklyCapMicros,
      newMemoriesPerRun: configuration.newMemoriesPerRun,
      sampleSize: trigger === "manual" ? REAL_EVAL_SAMPLE_SIZE : 0,
    });
    if (trigger === "manual") await writeRealEvalSample(this.#options.sampleDirectory, report);
    this.#options.onRun?.(report, trigger);
  }
}

export interface ProductionRealEvalDependencies {
  readonly configuration: RealEvalConfiguration;
  readonly scope: RealEvalScope;
  readonly maxSelectedMemories: number;
  readonly memoryLimit: number;
  readonly store: RealEvalStorePort;
  readonly state: Pick<ProductMemoryStatePort, "listActive" | "listHistory">;
  readonly payloads: Pick<PayloadStorePort, "get" | "put">;
  readonly protector: Pick<PayloadProtectorPort, "protect" | "unprotect">;
  readonly memory: Pick<DurableMemoryService, "search">;
  readonly embed: <T>(context: MailEmbeddingContext, operation: () => Promise<T>) => Promise<T>;
  readonly profile: (storeText: (ref: string, text: string) => void) => {
    compose: OwnerProfileService["compose"];
  };
  readonly model: RealEvalModel;
  readonly ledger: Pick<DecisionLedgerPort, "readCalibrationRows">;
  readonly sampleDirectory: string;
  readonly now: () => string;
  readonly newId: () => string;
  readonly onRun?: (report: RealEvalRunReport, trigger: RealEvalTrigger) => void;
  readonly onFailure?: (error: unknown) => void;
}

export function createProductionRealEval(deps: ProductionRealEvalDependencies): ProductionRealEval {
  const { scope } = deps;
  const readText = async (ref: string) => {
    const payload = await deps.payloads.get(ref as PayloadRef);
    if (!payload || payload.contentType !== "text/plain") return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await deps.protector.unprotect({ ...scope, payload }),
    );
  };
  const timeout = () => ({
    deadlineAt: new Date(
      Date.parse(deps.now()) + deps.configuration.requestTimeoutMs,
    ).toISOString(),
    signal: AbortSignal.timeout(deps.configuration.requestTimeoutMs),
    costMicros: 0,
  });
  const service = new RealMemoryEvalService({
    scope,
    store: deps.store,
    model: deps.model,
    now: deps.now,
    newId: deps.newId,
    maxSelectedMemories: deps.maxSelectedMemories,
    promptSha256: createHash("sha256")
      .update(JSON.stringify(REAL_EVAL_QUESTION.segments))
      .digest("hex"),
    listMemories: () => deps.state.listActive(scope.ownerId, scope.agentId),
    readMemoryText: (record) => readText(record.contentRef),
    readQuote: async (record) => {
      const events = await deps.state.listHistory({ ...scope, memoryIds: [record.id] });
      const quoteRef = quoteRefOfMemory(events, record.contentRef);
      return quoteRef ? readText(quoteRef) : undefined;
    },
    storeQuestion: async ({ memory, text, createdAt }) => {
      const ref = `real-eval-question:${deps.newId()}`;
      await deps.payloads.put(
        await deps.protector.protect({
          ...scope,
          ref,
          contentType: "text/plain",
          dataClassification: memory.dataClassification,
          plaintext: new TextEncoder().encode(text),
          createdAt,
        }),
      );
      return ref;
    },
    readQuestion: readText,
    decisions: async () => {
      const end = deps.now();
      const rows = await deps.ledger.readCalibrationRows({
        ...scope,
        start: new Date(Date.parse(end) - DECISION_EVAL_WINDOW_MS).toISOString(),
        end,
      });
      return rows.decisions;
    },
    profile: async () => {
      const texts = new Map<string, string>();
      const profile = await deps
        .profile((ref, text) => texts.set(ref, text))
        .compose({ ...scope, maxClassification: modelVisibleCeiling(), now: deps.now() });
      return {
        memoryIds: profile.memoryIds,
        texts: profile.blocks.flatMap(({ payloadRef }) => texts.get(payloadRef) ?? []),
        dataClassification: highestClassification(
          "public",
          profile.blocks.map(({ dataClassification }) => dataClassification),
        ),
      };
    },
    recall: async (question) => {
      const context = timeout();
      const found = await deps.embed(context, () =>
        deps.memory.search({
          ...scope,
          queryRef: "",
          queryText: question,
          recordUse: false,
          policy: {
            limit: deps.memoryLimit,
            allowedClassifications: modelVisibleClassifications(),
          },
        }),
      );
      const memories: RealEvalRecalledMemory[] = [];
      for (const { memory } of found) {
        const text = await readText(memory.contentRef);
        if (text !== undefined)
          memories.push({ id: memory.id, text, dataClassification: memory.dataClassification });
      }
      return { memories, costMicros: context.costMicros };
    },
  });
  return new ProductionRealEval({
    configuration: deps.configuration,
    scope,
    store: deps.store,
    service,
    sampleDirectory: deps.sampleDirectory,
    now: deps.now,
    ...(deps.onRun ? { onRun: deps.onRun } : {}),
    ...(deps.onFailure ? { onFailure: deps.onFailure } : {}),
  });
}
