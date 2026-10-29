import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const HISTORY = "evals/memory-retrieval/history.jsonl";
const ESTIMATED_USD = 0.001;

const options = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = "1"] = argument.replace(/^--/u, "").split("=");
    return [key, value];
  }),
);
for (const key of options.keys())
  if (!["confirm-cost", "thresholds", "no-record"].includes(key)) {
    console.error(`MEMORY_EVAL_UNKNOWN_OPTION：不认识的参数 --${key}`);
    process.exit(2);
  }

const approvedUsd = Number(options.get("confirm-cost"));
if (!options.has("confirm-cost") || !Number.isFinite(approvedUsd) || approvedUsd <= 0) {
  console.error(
    `MEMORY_EVAL_COST_APPROVAL_REQUIRED：记忆检索评测会调用真实向量模型，一轮约 ${ESTIMATED_USD} 美元。用 --confirm-cost=<美元上限> 运行；超过 0.5 美元的上限要先经 Andy 同意。`,
  );
  process.exit(2);
}

const key = process.env.AI_GATEWAY_API_KEY?.trim();
if (!key && !(process.env.HTTPS_PROXY || process.env.https_proxy)) {
  console.error(
    "MEMORY_EVAL_KEY_REQUIRED：需要评测专用的低额度 AI Gateway 密钥。本机设置 AI_GATEWAY_API_KEY；云端环境由出口代理注入。",
  );
  process.exit(2);
}

if (process.env.HTTPS_PROXY || process.env.https_proxy)
  setGlobalDispatcher(new EnvHttpProxyAgent());
const preflight = await fetch("https://ai-gateway.vercel.sh/v1/embeddings", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key || "proxy-injected"}`,
  },
  body: JSON.stringify({ model: "alibaba/qwen3-embedding-8b", input: "1", dimensions: 4096 }),
}).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }));
if (!preflight.ok) {
  console.error(
    `MEMORY_EVAL_GATEWAY_REFUSED：开跑前的试探请求被网关拒绝（HTTP ${preflight.status}），不开跑。网关原文：${(await preflight.text()).slice(0, 400)}`,
  );
  process.exit(2);
}

const output = path.resolve(
  ".ci-output/memory-retrieval",
  new Date().toISOString().replace(/[:.]/gu, "-"),
);
const result = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--config",
    "vitest.workspace.ts",
    "--project",
    "qualification-memory-retrieval-live",
    "test/integration/memory-retrieval-eval/live.test.ts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HIMAWARI_MEMORY_EVAL_LIVE: "1",
      HIMAWARI_MEMORY_EVAL_OUTPUT: output,
      HIMAWARI_MEMORY_EVAL_COST_LIMIT_MICROS: String(Math.round(approvedUsd * 1_000_000)),
      ...(options.has("thresholds")
        ? { HIMAWARI_MEMORY_EVAL_THRESHOLDS: options.get("thresholds") }
        : {}),
    },
  },
);
const roundFile = path.join(output, "round.json");
if (!existsSync(roundFile)) process.exit(result.status ?? 1);
const round = JSON.parse(readFileSync(roundFile, "utf8"));
const previous = existsSync(HISTORY)
  ? readFileSync(HISTORY, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .findLast((entry) => entry.runs.some(({ production }) => production))
  : undefined;
const percent = (value) => `${Math.round(value * 1000) / 10}%`;
for (const run of round.runs) {
  const metrics = run.metrics;
  console.log(
    `门槛 ${run.minimumSimilarity}${run.production ? "（生产）" : ""}：相关问题命中 ${percent(metrics.hitRate)}（直接 ${percent(metrics.directHitRate)}，需要联想 ${percent(metrics.inferentialHitRate)}），召回 ${percent(metrics.recall)}，带上的里面相关的 ${percent(metrics.precision)}，无关问题带出记忆 ${percent(metrics.unrelatedLeakRate)}（共 ${metrics.unrelatedMemoriesBrought} 条）`,
  );
}
const baseline = previous?.runs.find(({ production }) => production)?.metrics;
const current = round.runs.find(({ production }) => production)?.metrics;
if (baseline && current)
  console.log(
    `与上一次生产门槛对比（${previous.commit}）：命中 ${percent(baseline.hitRate)} → ${percent(current.hitRate)}，无关带出 ${percent(baseline.unrelatedLeakRate)} → ${percent(current.unrelatedLeakRate)}`,
  );
console.log(
  `花费 ${(round.usage.costMicros / 1_000_000).toFixed(6)} 美元，${round.usage.requests} 次请求。过程记录：${output}`,
);
if (!options.has("no-record")) appendFileSync(HISTORY, `${JSON.stringify(round)}\n`);
process.exit(result.status ?? 1);
