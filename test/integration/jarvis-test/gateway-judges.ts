import { loadJudgeModels } from "./cases.ts";
import type { DecisionJudge, JudgeQuestion, ReasoningJudge, ReasoningVerdict } from "./judge.ts";

export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const { decisionJudge: DECISION_JUDGE_MODEL, reasoningJudge: REASONING_JUDGE_MODEL } =
  loadJudgeModels();

export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

interface GatewayOptions {
  readonly secret: () => Promise<string>;
  readonly usage: JudgeUsage;
  readonly fetch?: typeof globalThis.fetch;
}

function costMicros(body: { providerMetadata?: { gateway?: { cost?: unknown } } }): number {
  const cost = Number(body.providerMetadata?.gateway?.cost);
  return Number.isFinite(cost) ? Math.round(cost * 1_000_000) : 0;
}

async function post(options: GatewayOptions, route: string, body: unknown): Promise<unknown> {
  const response = await (options.fetch ?? globalThis.fetch)(`${GATEWAY_BASE_URL}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await options.secret()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`JUDGE_GATEWAY_HTTP_${response.status}`);
  return response.json();
}

export function gatewayDecisionJudge(options: GatewayOptions): DecisionJudge {
  return {
    identity: DECISION_JUDGE_MODEL,
    decide: async (questions) => {
      const probabilities: number[] = [];
      for (const item of questions) {
        const body = (await post(options, "/evaluate", {
          model: DECISION_JUDGE_MODEL.id,
          state: { evidence: item.evidence, answer: item.answer },
          questions: {
            verdict: {
              type: "boolean",
              instructions: `根据 evidence（材料）判断 answer（回答）：${item.rule.question}`,
              criteria: { true: "是，回答符合这条要求", false: "否，回答违反了这条要求" },
            },
          },
        })) as {
          answers?: { verdict?: { probability?: unknown } };
          usage?: { inputTokens?: number; outputTokens?: number };
          providerMetadata?: { gateway?: { cost?: unknown } };
        };
        const probability = body.answers?.verdict?.probability;
        if (typeof probability !== "number") throw new Error("DECISION_JUDGE_ANSWER_MISSING");
        options.usage.inputTokens += body.usage?.inputTokens ?? 0;
        options.usage.outputTokens += body.usage?.outputTokens ?? 0;
        options.usage.costMicros += costMicros(body);
        probabilities.push(probability);
      }
      return probabilities;
    },
  };
}

export function reasoningPrompt(item: JudgeQuestion): string {
  return [
    "你是评测裁判。只根据下面的材料判断回答是否满足要求，不要补充材料里没有的信息。",
    `要求：${item.rule.question}`,
    `材料：\n${item.evidence}`,
    `回答：\n${item.answer}`,
    '只输出一个 JSON 对象：{"passed": true 或 false, "quote": "回答里支撑判断的原句，逐字摘抄", "reason": "一句话理由"}',
  ].join("\n\n");
}

export function parseReasoningVerdict(text: string): ReasoningVerdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("REASONING_JUDGE_NOT_JSON");
  const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  if (typeof value["passed"] !== "boolean") throw new Error("REASONING_JUDGE_NOT_JSON");
  return {
    passed: value["passed"],
    quote: typeof value["quote"] === "string" ? value["quote"] : "",
    reason: typeof value["reason"] === "string" ? value["reason"] : "",
  };
}

export function gatewayReasoningJudge(options: GatewayOptions): ReasoningJudge {
  return {
    identity: REASONING_JUDGE_MODEL,
    judge: async (item) => {
      const body = (await post(options, "/chat/completions", {
        model: REASONING_JUDGE_MODEL.id,
        temperature: 0,
        max_tokens: 8000,
        messages: [{ role: "user", content: reasoningPrompt(item) }],
      })) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: unknown };
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("REASONING_JUDGE_ANSWER_MISSING");
      options.usage.inputTokens += body.usage?.prompt_tokens ?? 0;
      options.usage.outputTokens += body.usage?.completion_tokens ?? 0;
      const cost = Number(body.usage?.cost);
      if (Number.isFinite(cost)) options.usage.costMicros += Math.round(cost * 1_000_000);
      return parseReasoningVerdict(content);
    },
  };
}
