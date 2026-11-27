import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { embeddingIdentity, JINA_V5_SMALL_INT8_PROFILE } from "@himawari-agent/application";
import { EgressEmbedder, type Embedder, LOCAL_ONNX_BASE_URL } from "@himawari-agent/memory-engine";
import { LocalOnnxEmbeddingRuntime } from "@himawari-agent/platform-node";
import { testModelEgress } from "@himawari-agent/testing";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { beforeAll, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "../sqlite-contract-execution.fixture.ts";
import { evidenceHit, fullContextMessages, memoryAnswerMessages } from "./answer.ts";
import {
  armMetrics,
  type BenchmarkQuestion,
  type BenchmarkSample,
  judgePrompt,
  locomoSamples,
  longMemEvalSamples,
  parseJudgeVerdict,
  type QuestionOutcome,
  stratifiedLongMemEval,
} from "./datasets.ts";
import { BudgetReachedError, ChatClient, DEEPSEEK_V4_1_FLASH_PRICES } from "./model.ts";
import { type IngestedStore, ingestStore, type StoreStatistics } from "./store.ts";

interface BenchEnvironment {
  readonly HIMAWARI_MEMORY_BENCH_LIVE?: string;
  readonly HIMAWARI_MEMORY_BENCH_DATA_DIR?: string;
  readonly HIMAWARI_MEMORY_BENCH_LOCOMO?: string;
  readonly HIMAWARI_MEMORY_BENCH_LOCOMO_QUESTIONS?: string;
  readonly HIMAWARI_MEMORY_BENCH_SMOKE_TURNS?: string;
  readonly HIMAWARI_MEMORY_BENCH_LONGMEMEVAL_PER_TYPE?: string;
  readonly HIMAWARI_MEMORY_BENCH_FULL_CONTEXT?: string;
  readonly HIMAWARI_MEMORY_BENCH_COST_CAP_USD?: string;
  readonly HIMAWARI_MEMORY_BENCH_SAMPLE_CONCURRENCY?: string;
  readonly HIMAWARI_MEMORY_BENCH_MODEL_CONCURRENCY?: string;
  readonly HIMAWARI_MEMORY_BENCH_OUTPUT?: string;
  readonly HIMAWARI_MEMORY_BENCH_STATE_ROOT?: string;
  readonly HIMAWARI_MEMORY_BENCH_ARTIFACT?: string;
  readonly HIMAWARI_MEMORY_BENCH_BASE_URL?: string;
  readonly HIMAWARI_MEMORY_BENCH_MODEL?: string;
}

const environment = process.env as unknown as BenchEnvironment;
const LIVE = environment.HIMAWARI_MEMORY_BENCH_LIVE === "1";

function selectedLocomo(all: BenchmarkSample[]): BenchmarkSample[] {
  const choice = environment.HIMAWARI_MEMORY_BENCH_LOCOMO?.trim() ?? "0";
  const picked =
    choice === "all"
      ? all
      : /^\d+$/u.test(choice)
        ? all.slice(0, Number(choice))
        : all.filter(({ id }) => choice.split(",").includes(id));
  const limit = Number(environment.HIMAWARI_MEMORY_BENCH_LOCOMO_QUESTIONS ?? 0);
  if (!(limit > 0)) return picked;
  return picked.map((sample) => {
    const step = sample.questions.length / Math.min(limit, sample.questions.length);
    return {
      ...sample,
      questions: Array.from(
        { length: Math.min(limit, sample.questions.length) },
        (_, index) => sample.questions[Math.floor(index * step)] as BenchmarkQuestion,
      ),
    };
  });
}

async function pool<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>) {
  let next = 0;
  let stop: unknown;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
      while (next < items.length && stop === undefined) {
        const item = items[next] as T;
        next += 1;
        try {
          await work(item);
        } catch (error) {
          stop = error;
        }
      }
    }),
  );
  if (stop !== undefined) throw stop;
}

describe.skipIf(!LIVE)(
  "memory benchmarks: LoCoMo and LongMemEval through the production memory path",
  () => {
    useSqliteContractExecution("worker");
    beforeAll(() => {
      if (process.env["HTTPS_PROXY"] || process.env["https_proxy"])
        setGlobalDispatcher(new EnvHttpProxyAgent());
    });

    it(
      "captures each conversation turn by turn, answers from memory, and judges with the benchmark's prompts",
      async () => {
        const dataDir = environment.HIMAWARI_MEMORY_BENCH_DATA_DIR;
        const stateRoot = environment.HIMAWARI_MEMORY_BENCH_STATE_ROOT;
        const artifactSha256 = environment.HIMAWARI_MEMORY_BENCH_ARTIFACT?.trim();
        if (!dataDir || !stateRoot || !artifactSha256) throw new Error("BENCH_INPUTS_REQUIRED");
        const capUsd = Number(environment.HIMAWARI_MEMORY_BENCH_COST_CAP_USD ?? 0);
        expect(capUsd).toBeGreaterThan(0);
        const fullContext = environment.HIMAWARI_MEMORY_BENCH_FULL_CONTEXT === "1";
        const perType = Number(environment.HIMAWARI_MEMORY_BENCH_LONGMEMEVAL_PER_TYPE ?? 0);
        const samples: BenchmarkSample[] = [];
        samples.push(
          ...selectedLocomo(
            locomoSamples(JSON.parse(await readFile(path.join(dataDir, "locomo10.json"), "utf8"))),
          ),
        );
        if (perType > 0)
          samples.push(
            ...longMemEvalSamples(
              stratifiedLongMemEval(
                JSON.parse(await readFile(path.join(dataDir, "lme_s.json"), "utf8")),
                perType,
              ),
            ),
          );
        const smokeTurns = Number(environment.HIMAWARI_MEMORY_BENCH_SMOKE_TURNS ?? 0);
        if (smokeTurns > 0)
          samples.splice(
            0,
            samples.length,
            ...samples.map((sample) => ({
              ...sample,
              stores: sample.stores.map((store) => ({
                ...store,
                turns: store.turns.slice(0, smokeTurns),
              })),
            })),
          );
        expect(samples.length).toBeGreaterThan(0);

        const profile = JINA_V5_SMALL_INT8_PROFILE;
        const dimensions = profile.dimensions[0] ?? 0;
        const runtime = new LocalOnnxEmbeddingRuntime({
          stateRoot,
          profile,
          dimensions,
          artifactSha256,
        });
        let reason: string | null = null;
        runtime.observe((_state, code) => {
          reason = code;
        });
        await runtime.start();
        expect(`${runtime.state} ${reason}`).toBe("ready null");
        const embedder: Embedder = new EgressEmbedder({
          egress: testModelEgress(),
          baseUrl: LOCAL_ONNX_BASE_URL,
          profile,
          identity: embeddingIdentity({
            provider: profile.provider,
            model: profile.model,
            dimensions,
            artifactSha256,
          }),
          dimensions,
          fetch: runtime.fetch as typeof fetch,
        });
        (embedder as EgressEmbedder).bindBoundary((_request, send) => send(), 120_000);

        const client = new ChatClient({
          baseUrl:
            environment.HIMAWARI_MEMORY_BENCH_BASE_URL ?? "https://opencode.ai/inference/go/v1",
          model: environment.HIMAWARI_MEMORY_BENCH_MODEL ?? "deepseek-v4.1-flash",
          prices: DEEPSEEK_V4_1_FLASH_PRICES,
          capUsd,
          concurrency: Number(environment.HIMAWARI_MEMORY_BENCH_MODEL_CONCURRENCY ?? 24),
        });
        const output =
          environment.HIMAWARI_MEMORY_BENCH_OUTPUT ??
          path.resolve(
            ".ci-output/memory-benchmark",
            new Date().toISOString().replace(/[:.]/gu, "-"),
          );
        await mkdir(output, { recursive: true });
        const outcomesFile = path.join(output, "outcomes.jsonl");
        const storesFile = path.join(output, "stores.jsonl");
        const outcomes: QuestionOutcome[] = [];
        const stores: (StoreStatistics & { id: string; benchmark: string })[] = [];
        const record = async (
          outcome: QuestionOutcome & {
            readonly benchmark: string;
            readonly gold: string;
            readonly question: string;
          },
        ) => {
          outcomes.push(outcome);
          await appendFile(outcomesFile, `${JSON.stringify(outcome)}\n`);
        };
        const judge = async (
          sample: BenchmarkSample,
          question: BenchmarkQuestion,
          response: string,
        ) => {
          const verdict = await client.chat({
            purpose: `${sample.benchmark}:judge`,
            session: `himawari-bench-judge-${sample.id}`,
            messages: [
              { role: "user", content: judgePrompt(sample.benchmark, question, response) },
            ],
            maxTokens: 200,
          });
          return parseJudgeVerdict(sample.benchmark, verdict.text);
        };
        const started = Date.now();
        const progress = new Map<string, string>();
        const ticker = setInterval(() => {
          void writeFile(
            path.join(output, "progress.json"),
            JSON.stringify(
              {
                spentUsd: client.spentUsd,
                outcomes: outcomes.length,
                stores: Object.fromEntries(progress),
                usage: Object.fromEntries(client.usage),
              },
              null,
              1,
            ),
          );
        }, 15_000);
        let stopped: string | null = null;

        const runSample = async (sample: BenchmarkSample) => {
          const ingested: IngestedStore[] = [];
          try {
            ingested.push(
              ...(await Promise.all(
                sample.stores.map((store) =>
                  ingestStore({
                    store,
                    embedder,
                    minimumSimilarity: profile.chatMinimumSimilarity,
                    onTurn: (done, total) => {
                      progress.set(store.id, `${done}/${total}`);
                    },
                    stopIf: () =>
                      client.spentUsd >= capUsd
                        ? new BudgetReachedError(client.spentUsd, capUsd)
                        : undefined,
                    generate: async (prompt, call) =>
                      (
                        await client.chat({
                          purpose: `${sample.benchmark}:capture`,
                          session: `himawari-bench-capture-${store.id}`,
                          messages: [{ role: "user", content: prompt }],
                          maxTokens: call.maxOutputTokens ?? 1024,
                        })
                      ).text,
                  }),
                ),
              )),
            );
            for (const store of ingested) {
              const line = {
                id: store.store.id,
                benchmark: sample.benchmark,
                ...store.statistics,
                failureSamples: store.failures.slice(0, 5),
              };
              stores.push(line);
              await appendFile(storesFile, `${JSON.stringify(line)}\n`);
            }
            const stored = new Set<string>();
            for (const store of ingested)
              for (const id of await store.storedSessionIds()) stored.add(id);
            const askedAt = sample.questions[0]?.askedAt ?? new Date().toISOString();
            const profiles = await Promise.all(ingested.map((store) => store.profileText(askedAt)));
            const answerOne = async (question: BenchmarkQuestion) => {
              const related = await Promise.all(
                ingested.map((store) => store.related(question.question, question.askedAt)),
              );
              const messages = memoryAnswerMessages(
                sample,
                question,
                ingested.map((store, index) => ({
                  ownerName: sample.benchmark === "locomo" ? store.store.ownerName : null,
                  profile: profiles[index] ?? "",
                  related: related[index] ?? [],
                })),
              );
              const answered = await client.chat({
                purpose: `${sample.benchmark}:answer`,
                session: `himawari-bench-answer-${sample.id}`,
                messages,
                maxTokens: 400,
              });
              const base = {
                benchmark: sample.benchmark,
                sampleId: sample.id,
                questionId: question.id,
                category: question.abstention
                  ? `${question.category}:abstention`
                  : question.category,
                question: question.question,
                gold: question.answer,
              };
              await record({
                ...base,
                arm: "memory",
                correct: await judge(sample, question, answered.text),
                response: answered.text,
                contextTokens: answered.promptTokens,
                answerMs: answered.ms,
                evidenceRecalled: evidenceHit(
                  question,
                  related.flat().flatMap(({ sessionIds }) => sessionIds),
                ),
                evidenceStored: evidenceHit(question, stored),
              });
              if (!fullContext) return;
              const direct = await client.chat({
                purpose: `${sample.benchmark}:full-context`,
                session: `himawari-bench-full-${sample.id}`,
                messages: fullContextMessages(sample, question),
                maxTokens: 400,
              });
              await record({
                ...base,
                arm: "full-context",
                correct: await judge(sample, question, direct.text),
                response: direct.text,
                contextTokens: direct.promptTokens,
                answerMs: direct.ms,
                evidenceRecalled: null,
                evidenceStored: null,
              });
            };
            const [head, ...rest] = sample.questions;
            if (head) await answerOne(head);
            await pool(rest, 8, answerOne);
          } finally {
            await Promise.all(ingested.map((store) => store.close()));
          }
        };

        try {
          await pool(
            samples,
            Number(environment.HIMAWARI_MEMORY_BENCH_SAMPLE_CONCURRENCY ?? 8),
            runSample,
          );
        } catch (error) {
          if (!(error instanceof BudgetReachedError)) throw error;
          stopped = error.message;
        } finally {
          clearInterval(ticker);
          await runtime.close();
        }

        const byBenchmark = (benchmark: string, arm: QuestionOutcome["arm"]) =>
          armMetrics(
            outcomes.filter(
              (outcome) =>
                (outcome as unknown as { benchmark: string }).benchmark === benchmark &&
                outcome.arm === arm,
            ),
          );
        const summary = {
          schema: "himawari-memory-benchmark-round.v1",
          recordedAt: new Date().toISOString(),
          commit: execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(),
          model: client.model,
          embedding: `${profile.provider}/${profile.model}`,
          minimumSimilarity: profile.chatMinimumSimilarity,
          stopped,
          wallMinutes: Math.round((Date.now() - started) / 600) / 100,
          spentUsd: Math.round(client.spentUsd * 10_000) / 10_000,
          usage: Object.fromEntries(client.usage),
          samples: samples.map(({ id, benchmark, questions }) => ({
            id,
            benchmark,
            questions: questions.length,
          })),
          stores,
          results: {
            locomo: {
              memory: byBenchmark("locomo", "memory"),
              fullContext: byBenchmark("locomo", "full-context"),
            },
            longmemeval: {
              memory: byBenchmark("longmemeval", "memory"),
              fullContext: byBenchmark("longmemeval", "full-context"),
            },
          },
        };
        await writeFile(path.join(output, "round.json"), `${JSON.stringify(summary, null, 2)}\n`);
        expect(outcomes.length).toBeGreaterThan(0);
      },
      6 * 60 * 60 * 1000,
    );
  },
);
