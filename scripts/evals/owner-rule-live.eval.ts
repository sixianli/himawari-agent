import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CHAT_ANSWER_LANGUAGE, CHAT_IDENTITY } from "@himawari-agent/prompt-catalog";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import {
  isStandingQuote,
  quotesWholeClauses,
  ownerRuleToolDescriptors,
} from "../../apps/agent-service/src/production-owner-rules.ts";
import { ownerRuleRecord } from "../../packages/application/src/rules/rule-types.ts";
import {
  mustNotifyHitIds,
  wholeThreadHitIds,
} from "../../packages/application/src/services/proactive-rules.ts";

const GATEWAY = process.env["EVAL_BASE_URL"] ?? "https://opencode.ai/inference/go/v1";
const MODELS = (process.env["EVAL_MODELS"] ?? "deepseek-v4.1-flash,glm-5.3-flash").split(",");
const RUNS = Number(process.env["EVAL_RUNS"] ?? "3");
const CAP_USD = Number(process.env["EVAL_CONFIRM_COST"] ?? "0");
const MINIMUM_PASS_SHARE = Number(process.env["EVAL_MINIMUM_PASS_SHARE"] ?? "1");
const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/owner-rule";
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "deepseek-v4.1-flash": { input: 0.15e-6, output: 0.6e-6, cacheRead: 0.003e-6 },
  "glm-5.3-flash": { input: 0.15e-6, output: 0.5e-6, cacheRead: 0.03e-6 },
};

interface Mail {
  from: string;
  subject: string;
  body: string;
}

interface Case {
  id: string;
  sentence: string;
  expect: "mail_read_whole_thread" | "mail_must_notify" | "soft" | "none";
  hit?: Mail[];
  miss?: Mail[];
}

interface Outcome {
  model: string;
  run: number;
  caseId: string;
  pass: boolean;
  reasons: string[];
  call: unknown;
}

const dataset = JSON.parse(readFileSync("test/fixtures/owner-rule-eval/dataset.json", "utf8")) as {
  cases: Case[];
};
const tools = ownerRuleToolDescriptors().map(({ name, description, parameters }) => ({
  type: "function",
  function: { name, description, parameters },
}));
const system = `${CHAT_IDENTITY.text}\n\n${CHAT_ANSWER_LANGUAGE.text}`;
let spentUsd = 0;
const usage: Record<string, { prompt: number; cached: number; completion: number; calls: number }> =
  {};

// biome-ignore lint/suspicious/noExplicitAny: the model gateway response is parsed JSON of unchecked shape
async function chat(model: string, sentence: string): Promise<any> {
  if (spentUsd >= CAP_USD)
    throw new Error(`EVAL_BUDGET_REACHED：已花 ${spentUsd.toFixed(4)} 美元，上限 ${CAP_USD}`);
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    const response = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer proxy-injected" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4096,
        tools,
        messages: [
          { role: "system", content: system },
          { role: "user", content: sentence },
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

function sourceItem(mail: Mail) {
  return {
    messageId: "m",
    threadId: "t",
    from: mail.from,
    fromAddress: mail.from,
    subject: mail.subject,
    snippet: "",
    receivedAt: "2026-11-11T00:00:00.000Z",
    labels: [],
    categories: [],
    link: "https://mail.google.com/",
    body: mail.body,
  } as unknown as Parameters<typeof wholeThreadHitIds>[0];
}

function grade(item: Case, message: Record<string, unknown>): Omit<Outcome, "model" | "run"> {
  const calls = ((message["tool_calls"] as Record<string, unknown>[] | undefined) ?? []).filter(
    (call) => (call["function"] as Record<string, unknown>)?.["name"] === "rule_set",
  );
  const reasons: string[] = [];
  if (item.expect === "none") {
    if (calls.length) reasons.push("一次性的话也立了规则");
    return { caseId: item.id, pass: !reasons.length, reasons, call: calls[0] ?? null };
  }
  if (calls.length !== 1) {
    reasons.push(`rule_set 调用 ${calls.length} 次`);
    return { caseId: item.id, pass: false, reasons, call: calls };
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(
      String((calls[0]?.["function"] as Record<string, unknown>)["arguments"] ?? ""),
    );
  } catch {
    return { caseId: item.id, pass: false, reasons: ["参数不是 JSON"], call: calls[0] };
  }
  if (args["type"] !== item.expect) reasons.push(`type=${String(args["type"])}`);
  const quote = String(args["quote"] ?? "");
  if (args["inferred"] !== false) reasons.push("标成了推断");
  if (!quotesWholeClauses(item.sentence, quote)) reasons.push("quote 不是主人原话里的整句");
  if (item.expect === "soft")
    return { caseId: item.id, pass: !reasons.length, reasons, call: args };
  if (!isStandingQuote(quote)) reasons.push("quote 没有表示一直有效的字样");
  let rule: ReturnType<typeof ownerRuleRecord>;
  try {
    rule = ownerRuleRecord({
      ruleId: "owner:eval",
      revision: 1,
      status: "active",
      source: "eval",
      parameters: { type: args["type"], params: args["params"], summary: args["summary"] },
    });
  } catch (error) {
    reasons.push(`参数被拒：${(error as Error).message}`);
    return { caseId: item.id, pass: false, reasons, call: args };
  }
  const hits = item.expect === "mail_read_whole_thread" ? wholeThreadHitIds : mustNotifyHitIds;
  for (const mail of item.hit ?? [])
    if (!hits(sourceItem(mail), [rule]).length) reasons.push(`漏：${mail.subject}`);
  for (const mail of item.miss ?? [])
    if (hits(sourceItem(mail), [rule]).length) reasons.push(`误中：${mail.subject}`);
  return { caseId: item.id, pass: !reasons.length, reasons, call: args };
}

describe("owner rule live eval", () => {
  it("把主人的话译成规则，并在正反例邮件上核对", async () => {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    expect(CAP_USD).toBeGreaterThan(0);
    const outcomes: Outcome[] = [];
    for (const model of MODELS)
      for (let run = 1; run <= RUNS; run += 1)
        for (const item of dataset.cases) {
          const body = await chat(model, item.sentence);
          outcomes.push({
            model,
            run,
            ...grade(item, (body.choices?.[0]?.message ?? {}) as Record<string, unknown>),
          });
        }
    const summary = MODELS.map((model) => {
      const mine = outcomes.filter((outcome) => outcome.model === model);
      return {
        model,
        passed: mine.filter(({ pass }) => pass).length,
        total: mine.length,
        byCase: Object.fromEntries(
          dataset.cases.map(({ id }) => [
            id,
            `${mine.filter((o) => o.caseId === id && o.pass).length}/${mine.filter((o) => o.caseId === id).length}`,
          ]),
        ),
        usage: usage[model],
      };
    });
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    writeFileSync(
      path.join(OUTPUT_DIRECTORY, "result.json"),
      `${JSON.stringify({ gateway: GATEWAY, runs: RUNS, spentUsd, summary, outcomes }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ spentUsd, summary }, null, 2));
    for (const { model, passed, total } of summary)
      expect(passed / total, model).toBeGreaterThanOrEqual(MINIMUM_PASS_SHARE);
  });
});
