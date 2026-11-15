import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import type { DeliveryTimingQuestion } from "../../packages/application/src/index.ts";
import { DeliveryTimingDecision } from "../../packages/platform-node/src/delivery-timing-decision.ts";

const MODEL = process.env["EVAL_JEV_MODEL"] ?? "typesafe-ai/jev";
const BASE_URL = process.env["EVAL_JEV_BASE_URL"];
const PRICE_MICROS = Number(process.env["EVAL_JEV_PRICE_MICROS"] ?? "42000");
const RUNS = Number(process.env["EVAL_RUNS"] ?? "2");
const CAP_USD = Number(process.env["EVAL_CONFIRM_COST"] ?? "0");
const THRESHOLD = Number(process.env["EVAL_BUSY_AT_LEAST_PERMILLE"] ?? "700");
const TIMEOUT_MS = Number(process.env["EVAL_TIMEOUT_MS"] ?? "10000");
const API_KEY = process.env["EVAL_API_KEY"]?.trim() || "proxy-injected";
const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/delivery-timing";

interface Case extends DeliveryTimingQuestion {
  readonly id: string;
  readonly category: "busy" | "clear";
  readonly expect: "yes" | "no";
}

const dataset = JSON.parse(
  readFileSync("test/fixtures/delivery-timing-eval/dataset.json", "utf8"),
) as { cases: Case[] };

describe("delivery timing live eval", () => {
  it("忙的时候判不适合打扰，空闲时判可以送，出错数为 0", async () => {
    expect(CAP_USD).toBeGreaterThan(0);
    setGlobalDispatcher(new EnvHttpProxyAgent());
    const decision = new DeliveryTimingDecision({
      model: MODEL,
      inputMicrosPerMillionTokens: PRICE_MICROS,
      apiKey: async () => API_KEY,
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
    });
    const estimate =
      dataset.cases.reduce((sum, item) => sum + decision.estimateMicros(item), 0) * RUNS;
    if (estimate > CAP_USD * 1e6)
      throw new Error(
        `EVAL_BUDGET_REACHED：预计 ${(estimate / 1e6).toFixed(4)} 美元，上限 ${CAP_USD}`,
      );
    const outcomes: {
      id: string;
      category: string;
      run: number;
      probability: number | null;
      defers: boolean | null;
      correct: boolean;
      error: string | null;
      milliseconds: number;
    }[] = [];
    for (let run = 1; run <= RUNS; run += 1)
      for (const item of dataset.cases) {
        const started = performance.now();
        let probability: number | null = null;
        let error: string | null = null;
        try {
          probability = await decision.probability({
            pushClass: item.pushClass,
            facts: item.facts,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (caught) {
          error = (caught as { code?: string }).code ?? (caught as Error).message;
        }
        const defers = probability === null ? null : probability * 1000 >= THRESHOLD;
        outcomes.push({
          id: item.id,
          category: item.category,
          run,
          probability,
          defers,
          correct: defers === (item.expect === "yes"),
          error,
          milliseconds: Math.round(performance.now() - started),
        });
      }
    const of = (category: string) => outcomes.filter((outcome) => outcome.category === category);
    const times = outcomes.map(({ milliseconds }) => milliseconds).sort((a, b) => a - b);
    const summary = {
      threshold: THRESHOLD,
      runs: RUNS,
      calls: outcomes.length,
      errors: outcomes.filter(({ error }) => error !== null).length,
      busyTotal: of("busy").length,
      busyDeferred: of("busy").filter(({ defers }) => defers === true).length,
      clearTotal: of("clear").length,
      clearDeferred: of("clear").filter(({ defers }) => defers === true).length,
      wrongIds: [...new Set(outcomes.filter(({ correct }) => !correct).map(({ id }) => id))],
      medianMilliseconds: times[Math.floor(times.length / 2)] ?? null,
      estimatedUsd: estimate / 1e6,
    };
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    writeFileSync(
      path.join(OUTPUT_DIRECTORY, "result.json"),
      `${JSON.stringify({ model: MODEL, summary, outcomes }, null, 2)}\n`,
    );
    console.log(JSON.stringify(summary, null, 2));
    expect(summary.errors, "判断出错").toBe(0);
  });
});
