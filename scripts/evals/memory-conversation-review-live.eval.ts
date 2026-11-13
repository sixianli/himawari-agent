import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, it } from "vitest";
import { judgeOrDefault } from "../../apps/agent-service/src/auxiliary-judgment.ts";
import {
  memoryConfirmationJudgePrompt,
  parseSupportVerdict,
} from "../../apps/agent-service/src/production-memory-capture.ts";
import {
  conversationReviewPrompt,
  parseConversationReview,
} from "../../apps/agent-service/src/production-memory-conversation-review.ts";

const GATEWAY = process.env.EVAL_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
const FLAT_RATE = process.env.EVAL_BASE_URL !== undefined;
const MODEL = process.env["EVAL_MODEL"] ?? "deepseek/deepseek-v4.1-flash";
const RUNS = Number(process.env["EVAL_RUNS"] ?? "1");
const CAP_USD = Number(process.env["EVAL_CONFIRM_COST"] ?? "0");
const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/memory-conversation-review";
const MAXIMUM_OUTPUT_TOKENS = Number(process.env["EVAL_MAX_OUTPUT_TOKENS"] ?? "1024");
const THINKING = process.env["EVAL_THINKING"] === "enabled";

interface Item {
  id: string;
  group: string;
  messages: { id: string; role: "owner" | "agent"; at: string; text: string }[];
  existing: {
    id: string;
    recordedOn: string;
    text: string;
    tentative: boolean;
    category: string;
    confidence: number;
  }[];
  expect: {
    creates: string[][];
    supersedes: string[];
    confirms: string[];
    forbidSupersede: string[];
  };
}

interface Outcome {
  id: string;
  group: string;
  created: string[];
  superseded: string[];
  held: string[];
  confirmed: string[];
  judgeFailures: number;
  skipped: Record<string, number>;
  error: string | null;
}

const dataset = JSON.parse(
  readFileSync("test/fixtures/memory-conversation-review-eval/dataset.json", "utf8"),
) as { day: string; timeZone: string; items: Item[] };
for (const item of dataset.items)
  for (const entry of item.existing)
    if (typeof entry.tentative !== "boolean")
      throw new Error(`EVAL_DATASET_INVALID：${item.id} 的 ${entry.id} tentative 不是布尔值`);
const REVIEW_DAY = new Date(Date.parse(`${dataset.day}T12:00:00.000Z`) + 86_400_000)
  .toISOString()
  .slice(0, 10);

let prices = { input: 0, output: 0, cacheRead: 0 };
let spentUsd = 0;
const usage = { prompt: 0, cached: 0, completion: 0, reasoning: 0, calls: 0, truncated: 0 };

// biome-ignore lint/suspicious/noExplicitAny: the model gateway response is parsed JSON of unchecked shape
async function chat(prompt: string): Promise<any> {
  if (!FLAT_RATE && spentUsd >= CAP_USD)
    throw new Error(`EVAL_BUDGET_REACHED：已花 ${spentUsd.toFixed(4)} 美元，上限 ${CAP_USD}`);
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    const response = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env["EVAL_API_KEY"] ?? "proxy-injected"}`,
        "x-opencode-session": `himawari-conversation-review-eval-${MODEL}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: MAXIMUM_OUTPUT_TOKENS,
        messages: [{ role: "user", content: prompt }],
        ...(THINKING ? {} : { thinking: { type: "disabled" } }),
      }),
    }).catch((error: Error) => error);
    if (response instanceof Error) {
      lastError = `EVAL_NETWORK: ${response.message}`;
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      const input = body.usage?.prompt_tokens ?? 0;
      const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const completion = body.usage?.completion_tokens ?? 0;
      usage.prompt += input;
      usage.cached += cached;
      usage.completion += completion;
      usage.reasoning += body.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      usage.calls += 1;
      if (body.choices?.[0]?.finish_reason === "length") usage.truncated += 1;
      spentUsd +=
        (input - cached) * prices.input + cached * prices.cacheRead + completion * prices.output;
      return body;
    }
    lastError = `EVAL_GATEWAY_${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new Error(lastError);
}

async function review(item: Item): Promise<Outcome> {
  const outcome: Outcome = {
    id: item.id,
    group: item.group,
    created: [],
    superseded: [],
    held: [],
    confirmed: [],
    judgeFailures: 0,
    skipped: {},
    error: null,
  };
  const existing = item.existing.map((entry) => ({
    id: entry.id,
    recordedOn: entry.recordedOn,
    text: entry.text,
    stance: null,
    tentative: entry.tentative,
    memory: {
      id: entry.id,
      recordedAt: `${entry.recordedOn}T00:00:00.000Z`,
      updatedAt: `${entry.recordedOn}T00:00:00.000Z`,
      confidencePermille: entry.confidence,
      attributes: { category: entry.category, tentative: entry.tentative },
    },
  }));
  const prompt = conversationReviewPrompt({
    messages: item.messages.map(({ id, role, at, text }) => ({
      id,
      role,
      messageSentAt: at,
      text,
    })),
    existing: existing as never,
    subCategories: {},
    people: [],
    timeZone: dataset.timeZone,
    day: REVIEW_DAY,
  });
  const body = await chat(prompt);
  const output = String(body.choices?.[0]?.message?.content ?? "");
  try {
    const parse = (supportVerdicts?: ReadonlyMap<string, boolean>) =>
      parseConversationReview({
        output,
        messages: item.messages.map(({ id, role, at, text }) => ({
          message: {
            id,
            role,
            committedAt: at,
            contentRef: `payload:${id}`,
            dataClassification: "private",
          },
          text,
        })) as never,
        existing: existing as never,
        timeZone: dataset.timeZone,
        newMemoriesAllowed: 5,
        ...(supportVerdicts ? { supportVerdicts } : {}),
      });
    const first = parse();
    const verdicts = new Map<string, boolean>();
    for (const check of first.supportChecks) {
      if (verdicts.has(check.key)) continue;
      const judgePrompt = memoryConfirmationJudgePrompt(check.memoryText, check.quote);
      verdicts.set(
        check.key,
        await judgeOrDefault(
          {
            ask: async () => String((await chat(judgePrompt)).choices?.[0]?.message?.content ?? ""),
            parse: parseSupportVerdict,
          },
          false,
          () => {
            outcome.judgeFailures += 1;
          },
        ),
      );
    }
    const parsed = verdicts.size === 0 ? first : parse(verdicts);
    outcome.skipped = { ...parsed.skipped };
    for (const group of parsed.groups)
      for (const candidate of group.parsed.candidates) {
        if (candidate.confirmsTentativeCategory !== undefined && candidate.existingMemoryId)
          outcome.confirmed.push(candidate.existingMemoryId);
        else if (candidate.decision === "create") outcome.created.push(candidate.text);
        if (candidate.supersedes) outcome.superseded.push(candidate.supersedes);
        else if (candidate.attributes?.tentative === true && candidate.decision === "create")
          outcome.held.push(candidate.text);
      }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

function score(item: Item, outcome: Outcome) {
  const createHits = item.expect.creates.filter((words) =>
    outcome.created.some((text) => words.every((word) => text.includes(word))),
  ).length;
  const extraCreates = outcome.created.filter(
    (text) => !item.expect.creates.some((words) => words.every((word) => text.includes(word))),
  ).length;
  const supersedeHits = item.expect.supersedes.filter((id) =>
    outcome.superseded.includes(id),
  ).length;
  const wrongSupersedes = outcome.superseded.filter(
    (id) => !item.expect.supersedes.includes(id),
  ).length;
  const confirmHits = item.expect.confirms.filter((id) => outcome.confirmed.includes(id)).length;
  const extraConfirms = outcome.confirmed.filter((id) => !item.expect.confirms.includes(id)).length;
  const forbiddenSupersedes = outcome.superseded.filter((id) =>
    item.expect.forbidSupersede.includes(id),
  ).length;
  const expected =
    item.expect.creates.length + item.expect.supersedes.length + item.expect.confirms.length;
  const hits = createHits + supersedeHits + confirmHits;
  return {
    expected,
    hits,
    extraCreates,
    wrongSupersedes,
    extraConfirms,
    forbiddenSupersedes,
    pass:
      hits === expected &&
      extraCreates === 0 &&
      wrongSupersedes === 0 &&
      extraConfirms === 0 &&
      outcome.judgeFailures === 0 &&
      !outcome.error,
  };
}

async function loadPrices(): Promise<void> {
  if (FLAT_RATE) return;
  const models = (await (await fetch(`${GATEWAY}/models`)).json()) as {
    data: { id: string; pricing?: Record<string, string> }[];
  };
  const pricing = models.data.find(({ id }) => id === MODEL)?.pricing;
  if (!pricing) throw new Error(`EVAL_PRICE_UNKNOWN：网关价目表里没有 ${MODEL}`);
  prices = {
    input: Number(pricing["input"]),
    output: Number(pricing["output"]),
    cacheRead: Number(pricing["input_cache_read"] ?? pricing["input"]),
  };
}

describe.skipIf(!(CAP_USD > 0 || FLAT_RATE))("回看对话评测（真实模型）", () => {
  it("跑完全部对话并打分", async () => {
    if (process.env["HTTPS_PROXY"] || process.env["https_proxy"])
      setGlobalDispatcher(new EnvHttpProxyAgent());
    await loadPrices();
    const runs: { outcome: Outcome; score: ReturnType<typeof score> }[][] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const results = [];
      for (const item of dataset.items) {
        const outcome = await review(item);
        results.push({ outcome, score: score(item, outcome) });
      }
      runs.push(results);
    }
    const summary = runs.map((results) => {
      const total = (
        key: "expected" | "hits" | "extraCreates" | "wrongSupersedes" | "extraConfirms",
      ) => results.reduce((sum, { score: value }) => sum + value[key], 0);
      const negatives = results.filter(({ outcome }) => outcome.group === "none");
      return {
        items: results.length,
        passed: results.filter(({ score: value }) => value.pass).length,
        recall: total("hits") / Math.max(1, total("expected")),
        extraCreates: total("extraCreates"),
        wrongSupersedes: total("wrongSupersedes"),
        extraConfirms: total("extraConfirms"),
        negativesClean: negatives.filter(
          ({ outcome }) =>
            outcome.created.length === 0 &&
            outcome.superseded.length === 0 &&
            outcome.confirmed.length === 0,
        ).length,
        negatives: negatives.length,
        errors: results.filter(({ outcome }) => outcome.error).length,
        judgeFailures: results.reduce((sum, { outcome }) => sum + outcome.judgeFailures, 0),
        failed: results.filter(({ score: value }) => !value.pass).map(({ outcome }) => outcome),
      };
    });
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(OUTPUT_DIRECTORY, `${stamp}.json`);
    writeFileSync(
      file,
      JSON.stringify({ model: MODEL, runs: RUNS, spentUsd, usage, summary }, null, 1),
    );
    console.log(
      JSON.stringify({ file, model: MODEL, spentUsd: Number(spentUsd.toFixed(4)), usage, summary }),
    );
  });
});
