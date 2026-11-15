import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import type { ProactiveMail } from "../../packages/application/src/ports/proactive-sources.ts";
import {
  parseJudgements,
  proactivePrompt,
} from "../../packages/application/src/services/proactive-mail-check-service.ts";

const GATEWAY = process.env["EVAL_BASE_URL"] ?? "https://opencode.ai/inference/go/v1";
const MODELS = (process.env["EVAL_MODELS"] ?? "deepseek-v4.1-flash,glm-5.3-flash").split(",");
const RUNS = Number(process.env["EVAL_RUNS"] ?? "3");
const CAP_USD = Number(process.env["EVAL_CONFIRM_COST"] ?? "0");
const API_KEY = process.env["EVAL_API_KEY"]?.trim() || "proxy-injected";
const OUTPUT_DIRECTORY = process.env["EVAL_OUT"] ?? "evals/proactive-intercept";
const OUTPUT_TOKENS = 4096;
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "deepseek-v4.1-flash": { input: 0.15e-6, output: 0.6e-6, cacheRead: 0.003e-6 },
  "glm-5.3-flash": { input: 0.15e-6, output: 0.5e-6, cacheRead: 0.03e-6 },
};

type Result = "act" | "know" | "check" | "ignore";

interface Mail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}

interface Case {
  readonly id: string;
  readonly title: string;
  readonly expect: readonly Result[] | null;
  readonly target: Mail | null;
  readonly memories: readonly { readonly id: string; readonly text: string }[];
  readonly memoryRequired?: boolean;
}

interface Dataset {
  readonly datasetVersion: string;
  readonly now: string;
  readonly timeZone: string;
  readonly noise: readonly Mail[];
  readonly cases: readonly Case[];
}

interface Outcome {
  readonly model: string;
  readonly run: number;
  readonly caseId: string;
  readonly targetResult: string | null;
  readonly intercepted: boolean | null;
  readonly memoryCited: boolean | null;
  readonly falseAlarms: readonly string[];
  readonly parsed: boolean;
  readonly callFailure: string | null;
  readonly pass: boolean;
}

const dataset = JSON.parse(
  readFileSync("test/fixtures/proactive-intercept-eval/dataset.json", "utf8"),
) as Dataset;
let spentUsd = 0;
const usage: Record<string, { prompt: number; cached: number; completion: number; calls: number }> =
  {};

function proactiveMail(mail: Mail, index: number): ProactiveMail {
  const address = mail.from.match(/<([^>]+)>/u)?.[1] ?? mail.from;
  return {
    source: "gmail",
    messageId: mail.id,
    threadId: `thread-${mail.id}`,
    from: mail.from,
    fromAddress: address,
    subject: mail.subject,
    snippet: mail.body.slice(0, 120),
    link: `https://mail.google.com/mail/u/0/#inbox/${mail.id}`,
    receivedAt: new Date(Date.parse(dataset.now) - (index + 1) * 3_600_000).toISOString(),
    categories: [],
    sentByOwner: false,
    body: mail.body,
    bodyTruncated: false,
    bodyUnavailable: false,
    attachments: [],
  };
}

function batch(item: Case): readonly ProactiveMail[] {
  return [...(item.target ? [item.target] : []), ...dataset.noise].map(proactiveMail);
}

async function judge(model: string, prompt: string): Promise<string | Error> {
  if (spentUsd >= CAP_USD)
    throw new Error(`EVAL_BUDGET_REACHED：已花 ${spentUsd.toFixed(4)} 美元，上限 ${CAP_USD}`);
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    const response = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
        "x-opencode-session": `himawari-proactive-intercept-eval-${model}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: OUTPUT_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    }).catch((error: Error) => error);
    if (response instanceof Error) {
      lastError = `EVAL_NETWORK: ${response.message}`;
      continue;
    }
    // biome-ignore lint/suspicious/noExplicitAny: the model gateway response is parsed JSON of unchecked shape
    const body: any = await response.json().catch(() => ({}));
    if (response.ok) {
      const entry = usage[model] ?? { prompt: 0, cached: 0, completion: 0, calls: 0 };
      usage[model] = entry;
      const promptTokens = body.usage?.prompt_tokens ?? 0;
      const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const completion = body.usage?.completion_tokens ?? 0;
      entry.prompt += promptTokens;
      entry.cached += cached;
      entry.completion += completion;
      entry.calls += 1;
      const price = PRICES[model] ?? { input: 1e-6, output: 4e-6, cacheRead: 1e-6 };
      spentUsd +=
        (promptTokens - cached) * price.input +
        cached * price.cacheRead +
        completion * price.output;
      return String(body.choices?.[0]?.message?.content ?? "");
    }
    lastError = `EVAL_GATEWAY_${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
    if (response.status !== 429 && response.status < 500) break;
  }
  return new Error(lastError);
}

function grade(item: Case, output: string | Error): Omit<Outcome, "model" | "run"> {
  if (output instanceof Error)
    return {
      caseId: item.id,
      targetResult: null,
      intercepted: null,
      memoryCited: null,
      falseAlarms: [],
      parsed: false,
      callFailure: output.message,
      pass: false,
    };
  const mails = batch(item);
  const judgements = parseJudgements(output, mails);
  if (!judgements)
    return {
      caseId: item.id,
      targetResult: null,
      intercepted: item.target ? false : null,
      memoryCited: null,
      falseAlarms: [],
      parsed: false,
      callFailure: null,
      pass: false,
    };
  const falseAlarms = dataset.noise
    .filter(({ id }) => (judgements.get(id)?.result ?? "missing") !== "ignore")
    .map(({ id }) => `${id}:${judgements.get(id)?.result ?? "missing"}`);
  const target = item.target ? judgements.get(item.target.id) : undefined;
  const targetResult = item.target ? (target?.result ?? "missing") : null;
  const intercepted = item.expect ? item.expect.includes(targetResult as Result) : null;
  const memoryIds = item.memories.map(({ id }) => id);
  const memoryCited =
    item.memoryRequired && target
      ? target.usedMemoryIds.some((id) => memoryIds.includes(id))
      : null;
  return {
    caseId: item.id,
    targetResult,
    intercepted,
    memoryCited,
    falseAlarms,
    parsed: true,
    callFailure: null,
    pass: intercepted !== false && memoryCited !== false && falseAlarms.length === 0,
  };
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;
}

describe("Jarvis Test #3 proactive interception, mail half", () => {
  it("在一批邮件里拦下将要出错的那封，其余保持沉默", async () => {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    expect(CAP_USD).toBeGreaterThan(0);
    const outcomes: Outcome[] = [];
    for (const model of MODELS)
      for (let run = 1; run <= RUNS; run += 1)
        for (const item of dataset.cases) {
          const prompt = proactivePrompt(
            batch(item),
            dataset.now,
            dataset.timeZone,
            item.memories.map(({ id, text }) => ({
              mailId: item.target?.id ?? "",
              id,
              text,
              dataClassification: "private" as const,
            })),
          );
          outcomes.push({ model, run, ...grade(item, await judge(model, prompt)) });
        }
    const summary = MODELS.map((model) => {
      const mine = outcomes.filter((outcome) => outcome.model === model);
      const answered = mine.filter(({ callFailure }) => callFailure === null);
      const shouldAct = answered.filter(({ caseId }) =>
        dataset.cases.find(({ id }) => id === caseId)?.expect?.includes("act"),
      );
      const noiseJudged = mine.filter(({ parsed }) => parsed).length * dataset.noise.length;
      return {
        model,
        passAll: dataset.cases.filter((item) =>
          mine.filter(({ caseId }) => caseId === item.id).every(({ pass }) => pass),
        ).length,
        cases: dataset.cases.length,
        passAt1: share(answered.filter(({ pass }) => pass).length, answered.length),
        interceptRate: share(
          shouldAct.filter(({ intercepted }) => intercepted).length,
          shouldAct.length,
        ),
        interceptSamples: shouldAct.length,
        falseAlarmRate: share(
          mine.reduce((sum, { falseAlarms }) => sum + falseAlarms.length, 0),
          noiseJudged,
        ),
        falseAlarmSamples: noiseJudged,
        byCase: Object.fromEntries(
          dataset.cases.map(({ id }) => [
            id,
            mine
              .filter((outcome) => outcome.caseId === id)
              .map(({ pass }) => (pass ? "过" : "不过"))
              .join(" "),
          ]),
        ),
        callFailures: mine.filter(({ callFailure }) => callFailure !== null).length,
        usage: usage[model],
      };
    });
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    writeFileSync(
      path.join(OUTPUT_DIRECTORY, "result.json"),
      `${JSON.stringify(
        {
          datasetVersion: dataset.datasetVersion,
          gateway: GATEWAY,
          runs: RUNS,
          spentUsd,
          summary,
          outcomes,
        },
        null,
        2,
      )}\n`,
    );
    console.log(JSON.stringify({ spentUsd, summary }, null, 2));
    expect(
      outcomes.filter(({ callFailure }) => callFailure === null).every(({ parsed }) => parsed),
    ).toBe(true);
    expect(outcomes.filter(({ callFailure }) => callFailure !== null).length).toBeLessThanOrEqual(
      Math.floor(outcomes.length / 5),
    );
  });
});
