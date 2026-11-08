import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scanMachineSecrets } from "@himawari-agent/sensitive-capture";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, it } from "vitest";
import {
  memoryCapturePrompt,
  parseMemoryCandidates,
} from "../../apps/agent-service/src/production-memory-capture.ts";
import { scoreStable } from "./memory-capture-score.mjs";

const GATEWAY = process.env.EVAL_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
const FLAT_RATE = process.env.EVAL_BASE_URL !== undefined;
const MODEL = process.env["EVAL_MODEL"] ?? "deepseek/deepseek-v4.1-flash";
const ARMS = (process.env["EVAL_ARMS"] ?? "A,B").split(",");
const RUNS = Number(process.env["EVAL_RUNS"] ?? "3");
const LIMIT = Number(process.env["EVAL_LIMIT"] ?? "0");
const CAP_USD = Number(process.env["EVAL_CONFIRM_COST"] ?? "0");
const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/memory-capture";
const TIME_ZONE = "Asia/Tokyo";

interface Item {
  id: string;
  group: string;
  message: string;
  previousAssistantMessage: string | null;
  existingMemories: { id: string; text: string; stance: string | null }[];
  sentAt: string;
  expect: { remember: boolean };
}

interface Candidate {
  text: string;
  decision: string;
  classification: string;
  category: string | null;
  dueAt: string | null;
  existingMemoryId: string | null;
}

interface Usage {
  truncated: number;
  prompt: number;
  cached: number;
  completion: number;
  calls: number;
}

const dataset = JSON.parse(
  readFileSync("test/fixtures/memory-capture-eval/dataset.json", "utf8"),
) as { items: Item[] };
const items =
  LIMIT > 0
    ? dataset.items.filter((_, index) => index % Math.ceil(dataset.items.length / LIMIT) === 0)
    : dataset.items;
const subset = { ...dataset, items };

const usage: Record<string, Usage> = {};
let prices = { input: 0, output: 0, cacheRead: 0 };
let spentUsd = 0;

// biome-ignore lint/suspicious/noExplicitAny: the model gateway response is parsed JSON of unchecked shape
function addUsage(arm: string, body: any): void {
  const entry = usage[arm] ?? { truncated: 0, prompt: 0, cached: 0, completion: 0, calls: 0 };
  usage[arm] = entry;
  const prompt = body.usage?.prompt_tokens ?? 0;
  const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const completion = body.usage?.completion_tokens ?? 0;
  entry.prompt += prompt;
  entry.cached += cached;
  entry.completion += completion;
  entry.calls += 1;
  if (body.choices?.[0]?.finish_reason === "length") entry.truncated += 1;
  spentUsd +=
    (prompt - cached) * prices.input + cached * prices.cacheRead + completion * prices.output;
}

// biome-ignore lint/suspicious/noExplicitAny: the model gateway response is parsed JSON of unchecked shape
async function chat(arm: string, payload: Record<string, unknown>): Promise<any> {
  if (spentUsd >= CAP_USD)
    throw new Error(`EVAL_BUDGET_REACHED：已花 ${spentUsd.toFixed(4)} 美元，上限 ${CAP_USD}`);
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    const response = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env["AI_GATEWAY_API_KEY"] ?? "proxy-injected"}`,
      },
      body: JSON.stringify({ model: MODEL, temperature: 0, ...payload }),
    }).catch((error: Error) => error);
    if (response instanceof Error) {
      lastError = `EVAL_NETWORK: ${response.message}`;
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      addUsage(arm, body);
      return body;
    }
    lastError = `EVAL_GATEWAY_${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new Error(lastError);
}

async function runArmA(item: Item): Promise<Candidate[]> {
  if (scanMachineSecrets(item.message).length > 0) return [];
  const prompt = memoryCapturePrompt(
    item.message,
    item.existingMemories as never,
    item.previousAssistantMessage,
    item.sentAt,
    TIME_ZONE,
  );
  const body = await chat("A", { messages: [{ role: "user", content: prompt }], max_tokens: 4096 });
  const output = String(body.choices?.[0]?.message?.content ?? "");
  try {
    const parsed = parseMemoryCandidates({
      output,
      sourceRef: item.id,
      sourceClassification: "private",
      existingIds: new Set(item.existingMemories.map(({ id }) => id)),
      ownerMessage: item.message,
      sentAt: item.sentAt,
      timeZone: TIME_ZONE,
    });
    return parsed.candidates.map((candidate) => ({
      text: candidate.text,
      decision: candidate.supersedes ? "supersede" : candidate.decision,
      classification: candidate.dataClassification,
      category: candidate.attributes?.category ?? null,
      dueAt: candidate.reminder?.dueAt ?? null,
      existingMemoryId: candidate.existingMemoryId ?? candidate.supersedes ?? null,
    }));
  } catch {
    return [];
  }
}

const REMEMBER_TOOL = {
  type: "function",
  function: {
    name: "memory_remember",
    description:
      "把主人说的、以后对话还会用到的长期信息存进长期记忆：身份、偏好、习惯、人际关系、长期目标、决定、对 Himawari 的要求、带时间的计划。不要存一次性的任务内容、提问、寒暄、Himawari 自己的话、一次性验证码。text 用第三人称写成一句完整的话。主人纠正或改变了已有记忆时 decision 用 supersede，补充细节用 update，重复用 unchanged，这三种必须填 existingMemoryId，其余用 create。健康、财务、宗教政治、性与亲密关系、他人私事、精确住址、法律纠纷 classification 用 sensitive；证件号码、银行卡号、密码、密钥用 sensitive；其余 private。有具体时间的事填 dueAt（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM，主人当地时间）。一条消息有几件事就调用几次。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        decision: { type: "string", enum: ["create", "update", "supersede", "unchanged"] },
        existingMemoryId: { type: ["string", "null"] },
        classification: { type: "string", enum: ["private", "sensitive", "restricted"] },
        category: {
          type: "string",
          enum: [
            "identity",
            "preference",
            "relationship",
            "goal",
            "project",
            "rule",
            "health",
            "finance",
            "event",
            "other",
          ],
        },
        dueAt: { type: ["string", "null"] },
      },
      required: ["text", "decision", "classification", "category"],
    },
  },
};

async function runArmB(item: Item): Promise<Candidate[]> {
  const existing = item.existingMemories.length
    ? `已有长期记忆：\n${item.existingMemories.map(({ id, text }) => `- ${id}：${text}`).join("\n")}`
    : "已有长期记忆：无";
  const messages: unknown[] = [
    {
      role: "system",
      content: `你是 Himawari，主人的个人助手。现在时间 ${item.sentAt}，主人所在时区 ${TIME_ZONE}。${existing}`,
    },
  ];
  if (item.previousAssistantMessage)
    messages.push({ role: "assistant", content: item.previousAssistantMessage });
  messages.push({ role: "user", content: item.message });
  const body = await chat("B", { messages, tools: [REMEMBER_TOOL], max_tokens: 2048 });
  const calls = body.choices?.[0]?.message?.tool_calls ?? [];
  const candidates: Candidate[] = [];
  for (const call of calls) {
    if (call.function?.name !== "memory_remember") continue;
    try {
      const args = JSON.parse(call.function.arguments);
      if (typeof args.text !== "string" || args.text.length === 0) continue;
      candidates.push({
        text: args.text,
        decision: args.decision ?? "create",
        classification: args.classification ?? "private",
        category: args.category ?? null,
        dueAt: args.dueAt ?? null,
        existingMemoryId: args.existingMemoryId ?? null,
      });
    } catch {}
  }
  return candidates;
}

const TRIGGERS = [
  /我(的|是|在|有|想|要|打算|准备|喜欢|不喜欢|爱|讨厌|不吃|从|搬|换|最近|一直|每|常|已经|没|不再|妈|爸|老婆|老公|女儿|儿子|朋友|同事|导师|老板)/u,
  /记住|记得|别忘|提醒|以后|今后|下次|从现在起|都要|务必|不要再|别再|改成|改为|其实/u,
  /\b(i|i'm|i'd|i've|my|me|remember|always|never|from now on|please remember)\b/iu,
  /私は|僕は|俺は|わたしの|私の|覚えて|忘れないで|これから|いつも/u,
];

export function rulePrefilterPasses(message: string): boolean {
  return TRIGGERS.some((pattern) => pattern.test(message));
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await work(values[index] as T);
      }
    }),
  );
  return results;
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

describe.skipIf(!(CAP_USD > 0))("记忆抽取评测（真实模型，会花钱）", () => {
  it("跑完所选实验臂并打分", async () => {
    if (process.env["HTTPS_PROXY"] || process.env["https_proxy"])
      setGlobalDispatcher(new EnvHttpProxyAgent());
    await loadPrices();
    const runners: Record<string, (item: Item) => Promise<Candidate[]>> = {
      A: runArmA,
      B: runArmB,
    };
    const raw: Record<string, { id: string; candidates: Candidate[] }[][]> = {};
    for (const arm of ARMS) {
      const armRuns: { id: string; candidates: Candidate[] }[][] = [];
      raw[arm] = armRuns;
      const runner = runners[arm];
      if (!runner) throw new Error(`EVAL_ARM_UNKNOWN：${arm}`);
      for (let run = 0; run < RUNS; run += 1) {
        const results = await mapLimit(items, 6, async (item) => ({
          id: item.id,
          candidates: await runner(item),
        }));
        armRuns.push(results);
        mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
        writeFileSync(
          path.join(OUTPUT_DIRECTORY, `partial-${arm}-${run}.json`),
          JSON.stringify({ spentUsd, usage, results }),
        );
      }
    }
    if (raw["A"]) {
      raw["C"] = raw["A"].map((results) =>
        results.map((result) => {
          const item = items.find(({ id }) => id === result.id);
          if (!item) throw new Error(`EVAL_ITEM_MISSING：${result.id}`);
          return rulePrefilterPasses(item.message) ? result : { id: result.id, candidates: [] };
        }),
      );
    }
    const summary: Record<string, unknown> = {};
    for (const [arm, runs] of Object.entries(raw)) {
      const stable = scoreStable(subset, runs);
      summary[arm] = {
        passAll: stable.passAll,
        runs: stable.runs.map(({ items: _items, ...metrics }) => metrics),
        prefilterSkipped:
          arm === "C"
            ? items.filter(({ message }) => !rulePrefilterPasses(message)).length
            : undefined,
      };
    }
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(OUTPUT_DIRECTORY, `${stamp}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        { model: MODEL, runs: RUNS, itemCount: items.length, spentUsd, usage, summary, raw },
        null,
        1,
      ),
    );
    console.log(
      JSON.stringify(
        { file, model: MODEL, spentUsd: Number(spentUsd.toFixed(4)), usage, summary },
        null,
        1,
      ),
    );
  });
});
