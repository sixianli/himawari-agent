import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CHAT_ANSWER_LANGUAGE,
  CHAT_IDENTITY,
  CHAT_TURN_CONTEXT_PREFACE,
  CHAT_TURN_TIME,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { memoryRecallDescriptor } from "../../apps/agent-service/src/production-memory-recall.ts";

const GATEWAY = process.env["EVAL_BASE_URL"] ?? "https://opencode.ai/inference/go/v1";
const MODELS = (process.env["EVAL_MODELS"] ?? "deepseek-v4.1-flash").split(",");
const RUNS = Number(process.env["EVAL_RUNS"] ?? "2");
const CAP_USD = Number(process.env["EVAL_CONFIRM_COST"] ?? "0");
const API_KEY = process.env["EVAL_API_KEY"]?.trim() || "proxy-injected";
const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/memory-time-scope";
const FIXTURE = "test/fixtures/memory-evaluation/model-time-scopes.json";
const TIME_ZONE = "Asia/Tokyo";
const ABILITIES = new Set(["temporal", "history", "time_window", "episode"]);
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "deepseek-v4.1-flash": { input: 0.15e-6, output: 0.6e-6, cacheRead: 0.003e-6 },
  "glm-5.3-flash": { input: 0.15e-6, output: 0.5e-6, cacheRead: 0.03e-6 },
};

interface Question {
  id: string;
  ability: string;
  query: string;
}

interface ToolScope {
  from?: string;
  to?: string;
  includeHistory?: boolean;
}

interface Outcome {
  model: string;
  run: number;
  questionId: string;
  called: boolean;
  scope: ToolScope | null;
  query: string | null;
}

const dataset = JSON.parse(
  readFileSync("test/fixtures/memory-evaluation/dataset.json", "utf8"),
) as { now: string; questions: Question[] };
const questions = dataset.questions.filter(({ ability }) => ABILITIES.has(ability));
const descriptor = memoryRecallDescriptor();
const tools = [
  {
    type: "function",
    function: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
    },
  },
];
const system = `${CHAT_IDENTITY.text}\n\n${CHAT_ANSWER_LANGUAGE.text}`;
const turnTime = renderPrompt(CHAT_TURN_TIME, {
  occurredAt: dataset.now,
  timeZone: TIME_ZONE,
  localTime: new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).format(new Date(dataset.now)),
  weekday: new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, weekday: "long" }).format(
    new Date(dataset.now),
  ),
});
let spentUsd = 0;
const usage: Record<string, { prompt: number; cached: number; completion: number; calls: number }> =
  {};

function ownerTurn(query: string): string {
  return [
    "<himawari-context>",
    CHAT_TURN_CONTEXT_PREFACE.text,
    turnTime,
    "</himawari-context>",
    "",
    "<owner-message>",
    query,
    "</owner-message>",
  ].join("\n");
}

// biome-ignore lint/suspicious/noExplicitAny: the model gateway response is parsed JSON of unchecked shape
async function chat(model: string, query: string): Promise<any> {
  if (spentUsd >= CAP_USD)
    throw new Error(`EVAL_BUDGET_REACHED：已花 ${spentUsd.toFixed(4)} 美元，上限 ${CAP_USD}`);
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    const response = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
        "x-opencode-session": `himawari-memory-time-scope-eval-${model}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2048,
        tools,
        messages: [
          { role: "system", content: system },
          { role: "user", content: ownerTurn(query) },
        ],
      }),
    }).catch((error: Error) => error);
    if (response instanceof Error) {
      lastError = `EVAL_NETWORK: ${response.message}`;
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      const entry = usage[model] ?? { prompt: 0, cached: 0, completion: 0, calls: 0 };
      usage[model] = entry;
      const prompt = body.usage?.prompt_tokens ?? 0;
      const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const completion = body.usage?.completion_tokens ?? 0;
      entry.prompt += prompt;
      entry.cached += cached;
      entry.completion += completion;
      entry.calls += 1;
      const price = PRICES[model] ?? { input: 1e-6, output: 4e-6, cacheRead: 1e-6 };
      spentUsd +=
        (prompt - cached) * price.input + cached * price.cacheRead + completion * price.output;
      return body;
    }
    lastError = `EVAL_GATEWAY_${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new Error(lastError);
}

function recallCall(
  message: Record<string, unknown>,
): Omit<Outcome, "model" | "run" | "questionId"> {
  const call = ((message["tool_calls"] as Record<string, unknown>[] | undefined) ?? []).find(
    (candidate) => (candidate["function"] as Record<string, unknown>)?.["name"] === "recall",
  );
  if (!call) return { called: false, scope: null, query: null };
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(String((call["function"] as Record<string, unknown>)["arguments"] ?? ""));
  } catch {
    return { called: true, scope: null, query: null };
  }
  const scope: ToolScope = {};
  if (typeof args["from"] === "string") scope.from = args["from"];
  if (typeof args["to"] === "string") scope.to = args["to"];
  if (typeof args["includeHistory"] === "boolean") scope.includeHistory = args["includeHistory"];
  return {
    called: true,
    scope,
    query: typeof args["query"] === "string" ? args["query"] : null,
  };
}

describe("memory time scope live eval", () => {
  it("records the from, to and includeHistory the model fills for time questions", async () => {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    expect(CAP_USD).toBeGreaterThan(0);
    const outcomes: Outcome[] = [];
    for (const model of MODELS)
      for (let run = 1; run <= RUNS; run += 1)
        for (const question of questions) {
          const body = await chat(model, question.query);
          outcomes.push({
            model,
            run,
            questionId: question.id,
            ...recallCall((body.choices?.[0]?.message ?? {}) as Record<string, unknown>),
          });
        }
    const first = outcomes.filter(({ model, run }) => model === MODELS[0] && run === 1);
    const agreement = MODELS.map((model) => {
      const runs = Array.from({ length: RUNS }, (_, index) =>
        outcomes.filter((outcome) => outcome.model === model && outcome.run === index + 1),
      );
      const same = questions.filter((question) =>
        runs.every(
          (run) =>
            JSON.stringify(run.find(({ questionId }) => questionId === question.id)?.scope) ===
            JSON.stringify(runs[0]?.find(({ questionId }) => questionId === question.id)?.scope),
        ),
      ).length;
      return { model, sameAcrossRuns: same, total: questions.length };
    });
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    writeFileSync(
      path.join(OUTPUT_DIRECTORY, "result.json"),
      `${JSON.stringify({ now: dataset.now, timeZone: TIME_ZONE, spentUsd, usage, agreement, outcomes }, null, 2)}\n`,
    );
    writeFileSync(
      FIXTURE,
      `${JSON.stringify(
        {
          model: MODELS[0],
          now: dataset.now,
          timeZone: TIME_ZONE,
          scopes: Object.fromEntries(
            first.map(({ questionId, called, scope }) => [questionId, called ? scope : null]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    console.log(JSON.stringify({ spentUsd, usage, agreement }, null, 2));
  });
});
