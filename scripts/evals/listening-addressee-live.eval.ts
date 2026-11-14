import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { VoiceAddresseeDecision } from "../../packages/platform-node/src/voice-addressee-decision.ts";
import { addresseeQuestions, parseObservations } from "./listening-score.mjs";

const OBSERVATIONS = process.env["EVAL_OBSERVATIONS"] ?? "";
const OUTPUT = process.env["EVAL_OUT"] ?? "";
const CAP_USD = Number(process.env["EVAL_CONFIRM_COST"] ?? "0");
const MODEL = process.env["EVAL_ADDRESSEE_MODEL"] ?? "typesafe-ai/jev";
const PRICE_MICROS = Number(process.env["EVAL_ADDRESSEE_PRICE_MICROS"] ?? "42000");
const TIMEOUT_MS = Number(process.env["EVAL_ADDRESSEE_TIMEOUT_MS"] ?? "10000");
const API_KEY = process.env["EVAL_API_KEY"]?.trim() || "proxy-injected";
const BASE_URL = process.env["EVAL_BASE_URL"];

describe("listening addressee live eval", () => {
  it("问判断模型每一句认出名字的话是不是在叫它", async () => {
    expect(OBSERVATIONS).not.toBe("");
    expect(OUTPUT).not.toBe("");
    expect(CAP_USD).toBeGreaterThan(0);
    setGlobalDispatcher(new EnvHttpProxyAgent());
    const decision = new VoiceAddresseeDecision({
      model: MODEL,
      inputMicrosPerMillionTokens: PRICE_MICROS,
      apiKey: async () => API_KEY,
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
    });
    const questions = addresseeQuestions(parseObservations(readFileSync(OBSERVATIONS, "utf8")));
    const estimate = questions.reduce(
      (sum, { heardName, request }) => sum + decision.estimateMicros({ heardName, text: request }),
      0,
    );
    if (estimate > CAP_USD * 1e6)
      throw new Error(
        `EVAL_BUDGET_REACHED：${questions.length} 句预计 ${(estimate / 1e6).toFixed(4)} 美元，上限 ${CAP_USD}`,
      );
    mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true });
    writeFileSync(OUTPUT, "");
    for (const { heardName, request } of questions) {
      const started = performance.now();
      let probability: number | null = null;
      let error: string | null = null;
      try {
        probability = await decision.probability({
          heardName,
          text: request,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (caught) {
        error = (caught as { code?: string }).code ?? (caught as Error).name;
      }
      appendFileSync(
        OUTPUT,
        `${JSON.stringify({
          heardName,
          request,
          model: MODEL,
          probability,
          error,
          milliseconds: Math.round(performance.now() - started),
          costMicros: decision.estimateMicros({ heardName, text: request }),
        })}\n`,
      );
    }
  });
});
