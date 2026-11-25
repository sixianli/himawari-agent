import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
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
  type RealEvalSampleReport,
  type RealEvalScope,
  type RealEvalStorePort,
  type RealEvalTrigger,
  RealMemoryEvalService,
} from "@himawari-agent/application";
import { REAL_EVAL_QUESTION } from "@himawari-agent/prompt-catalog";
import { maskForExport } from "./production-gap-export.js";
import { quoteRefOfMemory } from "./production-memory-consolidation.js";
import type { MailEmbeddingContext } from "./production-run-memory.js";

export const REAL_EVAL_TICK_MS = 60 * 60 * 1000;
export const REAL_EVAL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const REAL_EVAL_RETRY_MS = 24 * 60 * 60 * 1000;
export const REAL_EVAL_SAMPLE_TTL_MS = REAL_EVAL_INTERVAL_MS;
export const REAL_EVAL_SAMPLE_SIZE = 30;
export const REAL_EVAL_SAMPLE_FILE = "latest-sample.json";
export const REAL_EVAL_IN_PROGRESS_PREFIX = "in-progress-";
export const DECISION_EVAL_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;

type RunTiming = Pick<RealEvalRunRecord, "startedAt" | "trigger" | "outcome" | "costMicros">;

function startedWithin(run: RunTiming, now: string, windowMs: number): boolean {
  return Date.parse(now) - Date.parse(run.startedAt) < windowMs;
}

export function realEvalSpentMicros(runs: readonly RunTiming[], now: string): number {
  return runs
    .filter((run) => startedWithin(run, now, REAL_EVAL_INTERVAL_MS))
    .reduce((total, { costMicros }) => total + Math.max(0, costMicros), 0);
}

export function dueRealEvalTrigger(
  mode: RealEvalConfiguration["mode"],
  runs: readonly RunTiming[],
  now: string,
): RealEvalTrigger | null {
  if (mode === "off") return null;
  if (runs.some((run) => startedWithin(run, now, REAL_EVAL_RETRY_MS))) return null;
  if (mode === "once")
    return runs.some(({ trigger, outcome }) => trigger === "manual" && outcome !== "failed")
      ? null
      : "manual";
  return runs.some(
    (run) => run.outcome !== "failed" && startedWithin(run, now, REAL_EVAL_INTERVAL_MS),
  )
    ? null
    : "weekly";
}

function missing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}

export async function expireRealEvalSample(directory: string, now: string): Promise<boolean> {
  const names = (await readdir(directory).catch(missing)) ?? [];
  for (const name of names)
    if (name.startsWith(`${REAL_EVAL_SAMPLE_FILE}.`) && name.endsWith(".tmp"))
      await rm(path.join(directory, name), { force: true });
  const file = path.join(directory, REAL_EVAL_SAMPLE_FILE);
  const found = await stat(file).catch(missing);
  if (found && found.mtimeMs > Date.parse(now)) {
    const reset = await utimes(file, new Date(now), new Date(now)).then(
      () => true,
      () => false,
    );
    if (reset) return false;
    await rm(file, { force: true });
    return true;
  }
  if (!found || Date.parse(now) - found.mtimeMs < REAL_EVAL_SAMPLE_TTL_MS) return false;
  await rm(file, { force: true });
  return true;
}

interface InProgressRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly trigger: RealEvalTrigger;
  readonly capMicros: number;
}

function inProgressRun(text: string, now: string): InProgressRun | undefined {
  let value: Partial<InProgressRun>;
  try {
    value = JSON.parse(text) as Partial<InProgressRun>;
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.runId !== "string" ||
    value.runId.length === 0 ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    new Date(value.startedAt).toISOString() !== value.startedAt ||
    Date.parse(value.startedAt) > Date.parse(now) ||
    (value.trigger !== "manual" && value.trigger !== "weekly") ||
    !Number.isSafeInteger(value.capMicros) ||
    (value.capMicros ?? 0) < 1
  )
    return undefined;
  return {
    runId: value.runId,
    startedAt: value.startedAt,
    trigger: value.trigger,
    capMicros: value.capMicros ?? 0,
  };
}

async function readMarker(
  file: string,
  now: string,
  weeklyCapMicros: number,
  recordedRunIds: ReadonlySet<string>,
): Promise<RunTiming | undefined> {
  const found = await stat(file).catch(missing);
  if (!found) return undefined;
  const text = await readFile(file, "utf8").catch(missing);
  if (text === undefined) return undefined;
  if (found.mtimeMs > Date.parse(now)) {
    const reset = await utimes(file, new Date(now), new Date(now)).then(
      () => true,
      () => false,
    );
    if (!reset) {
      const removed = await rm(file, { force: true }).then(
        () => true,
        () => false,
      );
      return removed
        ? undefined
        : { startedAt: now, trigger: "weekly", outcome: "failed", costMicros: weeklyCapMicros };
    }
  }
  const run = inProgressRun(text, now) ?? {
    runId: "",
    startedAt: new Date(Math.min(found.mtimeMs, Date.parse(now))).toISOString(),
    trigger: "weekly" as const,
    capMicros: weeklyCapMicros,
  };
  const { startedAt } = run;
  if (
    recordedRunIds.has(run.runId) ||
    Date.parse(now) - Date.parse(startedAt) >= REAL_EVAL_INTERVAL_MS
  ) {
    await rm(file, { force: true });
    return undefined;
  }
  return { startedAt, trigger: run.trigger, outcome: "failed", costMicros: run.capMicros };
}

async function unreadableMarker(
  file: string,
  now: string,
  weeklyCapMicros: number,
): Promise<RunTiming | undefined> {
  const found = await stat(file).catch(() => undefined);
  if (!found) return undefined;
  const age = Date.parse(now) - found.mtimeMs;
  if (age < 0 || age >= REAL_EVAL_INTERVAL_MS) return undefined;
  return {
    startedAt: new Date(found.mtimeMs).toISOString(),
    trigger: "weekly",
    outcome: "failed",
    costMicros: weeklyCapMicros,
  };
}

export async function readUnfinishedRealEvals(
  directory: string,
  now: string,
  weeklyCapMicros: number,
  recordedRunIds: ReadonlySet<string> = new Set(),
): Promise<RunTiming[]> {
  const names = (await readdir(directory).catch(missing)) ?? [];
  const unfinished: RunTiming[] = [];
  for (const name of names.toSorted()) {
    if (!name.startsWith(REAL_EVAL_IN_PROGRESS_PREFIX)) continue;
    const file = path.join(directory, name);
    if (name.endsWith(".tmp")) {
      await rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    const run = await readMarker(file, now, weeklyCapMicros, recordedRunIds).catch(() =>
      unreadableMarker(file, now, weeklyCapMicros),
    );
    if (run) unfinished.push(run);
  }
  return unfinished;
}

async function markRealEvalStarted(directory: string, run: InProgressRun): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(
    directory,
    `${REAL_EVAL_IN_PROGRESS_PREFIX}${Date.parse(run.startedAt)}-${randomUUID()}.json`,
  );
  const temporary = `${file}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(run)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return file;
}

export class RealEvalSampleExpiry {
  readonly #directory: string;
  readonly #now: () => string;
  readonly #onFailure: ((error: unknown) => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    readonly directory: string;
    readonly now: () => string;
    readonly onFailure?: (error: unknown) => void;
  }) {
    this.#directory = options.directory;
    this.#now = options.now;
    this.#onFailure = options.onFailure;
  }

  start(): void {
    if (this.#timer) return;
    const check = () => {
      const now = this.#now();
      void Promise.all([
        expireRealEvalSample(this.#directory, now),
        readUnfinishedRealEvals(this.#directory, now, 0),
      ]).catch((error: unknown) => this.#onFailure?.(error));
    };
    this.#timer = setInterval(check, REAL_EVAL_TICK_MS);
    this.#timer.unref?.();
    check();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
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
      Math.ceil(
        new TextEncoder().encode(prompt).byteLength *
          Math.max(options.cost.input, options.cost.cacheRead, options.cost.cacheWrite) +
          maxOutputTokens * 2 * options.cost.output,
      ),
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
            if (!Number.isSafeInteger(event.costMicros) || event.costMicros < 0) {
              failure = "COST_INVALID";
              break;
            }
            costMicros = event.costMicros;
            completed = true;
            break;
          }
        }
      } finally {
        try {
          await authority.release();
        } finally {
          await model.release(payloads);
        }
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
  report: RealEvalSampleReport,
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
  try {
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
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
    const now = this.#options.now();
    const sampleDirectory = this.#options.sampleDirectory;
    await expireRealEvalSample(sampleDirectory, now).catch((error: unknown) =>
      this.#options.onFailure?.(error),
    );
    const recorded = await store.listRuns({ ...this.#options.scope, limit: 520 });
    const unfinished = await readUnfinishedRealEvals(
      sampleDirectory,
      now,
      configuration.weeklyCapMicros,
      new Set(recorded.map(({ id }) => id)),
    );
    const runs = [...recorded, ...unfinished];
    const trigger = dueRealEvalTrigger(configuration.mode, runs, now);
    if (trigger === null) return;
    const remaining = configuration.weeklyCapMicros - realEvalSpentMicros(runs, now);
    if (remaining <= 0) return;
    const runId = `real-eval-run:${randomUUID()}`;
    const marker = await markRealEvalStarted(sampleDirectory, {
      runId,
      startedAt: now,
      trigger,
      capMicros: remaining,
    });
    const report = await service.run(trigger, {
      runId,
      capMicros: remaining,
      newMemoriesPerRun: configuration.newMemoriesPerRun,
      ...(trigger === "manual"
        ? {
            sampleSize: REAL_EVAL_SAMPLE_SIZE,
            writeSample: async (sample: RealEvalSampleReport) => {
              await writeRealEvalSample(sampleDirectory, sample);
            },
          }
        : { sampleSize: 0 }),
    });
    await rm(marker, { force: true });
    this.#options.onRun?.(report, trigger);
  }
}

export interface ProductionRealEvalDependencies {
  readonly configuration: RealEvalConfiguration;
  readonly scope: RealEvalScope;
  readonly memoryLimit: number;
  readonly recallEstimateMicros: number;
  readonly store: RealEvalStorePort;
  readonly state: Pick<ProductMemoryStatePort, "listActive" | "listHistory">;
  readonly payloads: Pick<PayloadStorePort, "get" | "put" | "delete">;
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
    recallEstimateMicros: deps.recallEstimateMicros,
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
    discardQuestion: async (ref) => {
      await deps.payloads.delete(ref as PayloadRef);
    },
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
    recall: async (question, dataClassification) => {
      const context = { ...timeout(), dataClassification };
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
        const text = await readText(memory.contentRef).catch((): undefined => undefined);
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
