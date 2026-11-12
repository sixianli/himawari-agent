import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CHAT_ANSWER_LANGUAGE,
  CHAT_IDENTITY,
  RULE_SCOPE_VERIFY,
} from "@himawari-agent/prompt-catalog";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { ownerRuleToolDescriptors } from "../../apps/agent-service/src/production-owner-rules.ts";
import {
  parseRuleScope,
  reconcileScope,
  type RuleScope,
  type ScopeOutcome,
} from "../../apps/agent-service/src/production-rule-scope.ts";
import { parseRuleScopeVerdict } from "../../packages/application/src/rules/rule-scope.ts";

const GATEWAY = process.env["EVAL_BASE_URL"] ?? "https://opencode.ai/inference/go/v1";
const MAIN_MODEL = process.env["EVAL_MAIN_MODEL"] ?? "deepseek-v4.1-flash";
const VERIFIER_MODEL = process.env["EVAL_VERIFIER_MODEL"] ?? "glm-5.3-flash";
const RUNS = Number(process.env["EVAL_RUNS"] ?? "3");
const CAP_USD = Number(process.env["EVAL_CONFIRM_COST"] ?? "0");
const API_KEY = process.env["EVAL_API_KEY"]?.trim() || "proxy-injected";
const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/rule-scope";
const MAX_DAYS = 366;
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "deepseek-v4.1-flash": { input: 0.15e-6, output: 0.6e-6, cacheRead: 0.003e-6 },
  "glm-5.3-flash": { input: 0.15e-6, output: 0.5e-6, cacheRead: 0.03e-6 },
};

interface Case {
  id: string;
  sentence: string;
  expect: "standing" | "until" | "this_item" | "unclear";
  window?: [string, string];
}

type Config = "main-only" | "main-plus-model";
type Result = "right" | "wrong-activation" | "missed" | "safe-hold";

const dataset = JSON.parse(readFileSync("test/fixtures/rule-scope-eval/dataset.json", "utf8")) as {
  now: string;
  timeZone: string;
  cases: Case[];
};
const NOW = new Date(dataset.now).toISOString();
const tools = ownerRuleToolDescriptors().map(({ name, description, parameters }) => ({
  type: "function",
  function: { name, description, parameters },
}));
const system = `${CHAT_IDENTITY.text}\n\n${CHAT_ANSWER_LANGUAGE.text}`;
let spentUsd = 0;
const usage: Record<string, { prompt: number; cached: number; completion: number; calls: number }> =
  {};

function localClock(): string {
  const text = dataset.now.slice(0, 16);
  return `${text}（${dataset.timeZone}）`;
}

// biome-ignore lint/suspicious/noExplicitAny: the model gateway response is parsed JSON of unchecked shape
async function chat(model: string, messages: unknown[], withTools: boolean): Promise<any> {
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
        "x-opencode-session": `himawari-rule-scope-eval-${model}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: withTools ? 4096 : 1024,
        ...(withTools ? { tools } : {}),
        messages,
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

interface MainReading {
  readonly called: boolean;
  readonly quote: string;
  readonly inferred: boolean;
  readonly scope: RuleScope | undefined;
}

async function mainReads(item: Case): Promise<MainReading> {
  const body = await chat(
    MAIN_MODEL,
    [
      { role: "system", content: system },
      { role: "user", content: `${item.sentence}\n\n当前当地时间和时区：${localClock()}` },
    ],
    true,
  );
  const calls = (
    (body.choices?.[0]?.message?.tool_calls as Record<string, unknown>[]) ?? []
  ).filter((call) => (call["function"] as Record<string, unknown>)?.["name"] === "rule_set");
  const first = calls[0];
  if (!first) return { called: false, quote: "", inferred: false, scope: undefined };
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(String((first["function"] as Record<string, unknown>)["arguments"] ?? ""));
  } catch {
    return { called: true, quote: "", inferred: true, scope: undefined };
  }
  return {
    called: true,
    quote: String(args["quote"] ?? ""),
    inferred: args["inferred"] !== false,
    scope: parseRuleScope(args["scope"], {
      now: NOW,
      timeZone: dataset.timeZone,
      maxDays: MAX_DAYS,
    }),
  };
}

async function verifierReads(item: Case, quote: string) {
  const prompt = `${RULE_SCOPE_VERIFY.text}\n${JSON.stringify({ quote, context: item.sentence })}\n当前当地时间和时区：${localClock()}`;
  const body = await chat(VERIFIER_MODEL, [{ role: "user", content: prompt }], false);
  return parseRuleScopeVerdict(String(body.choices?.[0]?.message?.content ?? ""), quote);
}

function localInstant(expiresAt: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: dataset.timeZone,
    dateStyle: "short",
    timeStyle: "short",
  })
    .format(new Date(expiresAt))
    .replace(" ", "T");
}

function grade(item: Case, outcome: ScopeOutcome | "no-call"): Result {
  if (outcome === "no-call" || outcome.kind === "ask") {
    return item.expect === "standing" || item.expect === "until" ? "missed" : "right";
  }
  if (outcome.kind === "propose") {
    return item.expect === "this_item" || item.expect === "unclear" ? "safe-hold" : "missed";
  }
  if (item.expect === "this_item" || item.expect === "unclear") return "wrong-activation";
  if (item.expect === "standing") return outcome.expiresAt === null ? "right" : "wrong-activation";
  if (outcome.expiresAt === null || !item.window) return "wrong-activation";
  const local = localInstant(outcome.expiresAt);
  return local >= item.window[0] && local <= item.window[1] ? "right" : "wrong-activation";
}

describe("rule scope live eval", () => {
  it("比较只用主模型、主模型加对话模型核对两种配置", async () => {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    expect(CAP_USD).toBeGreaterThan(0);
    const rows: {
      config: Config;
      run: number;
      caseId: string;
      expect: string;
      result: Result;
      outcome: unknown;
    }[] = [];
    for (let run = 1; run <= RUNS; run += 1)
      for (const item of dataset.cases) {
        const reading = await mainReads(item);
        const verdict =
          reading.called && !reading.inferred && reading.scope
            ? await verifierReads(item, reading.quote)
            : undefined;
        for (const config of ["main-only", "main-plus-model"] as const) {
          let outcome: ScopeOutcome | "no-call";
          if (!reading.called || !reading.scope) outcome = "no-call";
          else
            outcome = reconcileScope({
              main: reading.scope,
              inferred: reading.inferred,
              ownerSaid: true,
              verifier: config === "main-plus-model" ? { verify: async () => verdict } : undefined,
              verdict: config === "main-plus-model" ? verdict : undefined,
              now: NOW,
              maxDays: MAX_DAYS,
            });
          rows.push({
            config,
            run,
            caseId: item.id,
            expect: item.expect,
            result: grade(item, outcome),
            outcome: { outcome, scope: reading.scope, verdict },
          });
        }
      }
    const summary = (["main-only", "main-plus-model"] as const).map((config) => {
      const mine = rows.filter((row) => row.config === config);
      const count = (result: Result) => mine.filter((row) => row.result === result).length;
      return {
        config,
        total: mine.length,
        right: count("right"),
        wrongActivation: count("wrong-activation"),
        missed: count("missed"),
        safeHold: count("safe-hold"),
        wrongCases: [
          ...new Set(
            mine.filter((row) => row.result === "wrong-activation").map((row) => row.caseId),
          ),
        ],
      };
    });
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    writeFileSync(
      path.join(OUTPUT_DIRECTORY, "result.json"),
      `${JSON.stringify({ gateway: GATEWAY, mainModel: MAIN_MODEL, verifierModel: VERIFIER_MODEL, runs: RUNS, spentUsd, usage, summary, rows }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ spentUsd, summary }, null, 2));
    expect(summary.length).toBe(2);
  });
});
