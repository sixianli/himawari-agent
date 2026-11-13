import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readHistory, renderTrend } from "./history.mjs";

const VITEST_ARGS = [
  "vitest",
  "run",
  "--config",
  "vitest.workspace.ts",
  "--project",
  "qualification-jarvis-live",
  "test/integration/jarvis-test/live-round.test.ts",
];

const options = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = "1"] = argument.replace(/^--/u, "").split("=");
    return [key, value];
  }),
);
const known = new Set([
  "cases",
  "trials",
  "token-limit",
  "calibrated",
  "no-record",
  "confirm-cost",
]);
for (const key of options.keys())
  if (!known.has(key)) {
    console.error(`JARVIS_LIVE_UNKNOWN_OPTION：不认识的参数 --${key}`);
    process.exit(2);
  }

const approvedUsd = Number(options.get("confirm-cost"));
if (!options.has("confirm-cost") || !Number.isFinite(approvedUsd) || approvedUsd <= 0) {
  const last = (await readHistory("evals/jarvis-test/history.jsonl")).at(-1);
  console.error(
    `JARVIS_LIVE_COST_APPROVAL_REQUIRED：真模型层会花钱，开跑前要先报预计费用并经 Andy 同意，再用 --confirm-cost=<美元上限> 运行；花费到上限就停。上一轮完整跑（${last?.cases?.length ?? "未知"} 条×${last?.trials ?? "未知"} 次）花了 ${last?.costMicros == null ? "未测量" : `${(last.costMicros / 1_000_000).toFixed(2)} 美元`}，被测模型是 ${last?.models.subject.id ?? "未知"}。`,
  );
  process.exit(2);
}

const viaProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
const key = process.env.AI_GATEWAY_API_KEY?.trim();
if (!key && !viaProxy) {
  console.error(
    "JARVIS_LIVE_KEY_REQUIRED：真模型层需要 AI Gateway 密钥。本机运行请设置环境变量 AI_GATEWAY_API_KEY；云端环境由出口代理注入密钥。",
  );
  process.exit(2);
}

const gateway = process.env.HIMAWARI_JARVIS_PREFLIGHT_URL ?? "https://ai-gateway.vercel.sh/v1";
const preflight = await fetch(`${gateway}/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  },
  body: JSON.stringify({
    model: "deepseek/deepseek-v4.1-flash",
    messages: [{ role: "user", content: "1" }],
    max_tokens: 1,
  }),
}).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }));
if (!preflight.ok) {
  console.error(
    `JARVIS_LIVE_GATEWAY_REFUSED：开跑前的 1 个 token 试探请求被网关拒绝（HTTP ${preflight.status}），不开跑。预算超了会连累同一账号下的生产调用，先查 Vercel 预算。网关原文：${(await preflight.text()).slice(0, 400)}`,
  );
  process.exit(2);
}

const output = path.resolve(
  ".ci-output/jarvis-test",
  new Date().toISOString().replace(/[:.]/gu, "-"),
);
const environment = {
  ...process.env,
  HIMAWARI_JARVIS_OUTPUT: output,
  HIMAWARI_JARVIS_LIVE: "1",
  HIMAWARI_JARVIS_COST_LIMIT_MICROS: String(Math.round(approvedUsd * 1_000_000)),
  HIMAWARI_JARVIS_RECORD: options.has("no-record") ? "0" : "1",
  ...(options.has("cases") ? { HIMAWARI_JARVIS_CASES: options.get("cases") } : {}),
  ...(options.has("trials") ? { HIMAWARI_JARVIS_TRIALS: options.get("trials") } : {}),
  ...(options.has("token-limit")
    ? { HIMAWARI_JARVIS_TOKEN_LIMIT: options.get("token-limit") }
    : {}),
  ...(options.has("calibrated") ? { HIMAWARI_JARVIS_CALIBRATED: "1" } : {}),
};
const result = spawnSync("npx", VITEST_ARGS, { stdio: "inherit", env: environment });
const roundFile = path.join(output, "round.json");
if (existsSync(roundFile)) {
  const record = JSON.parse(readFileSync(roundFile, "utf8"));
  console.log(renderTrend([record]));
  for (const item of record.cases)
    console.log(`${item.id} ${item.trials.map((passed) => (passed ? "过" : "不过")).join(" ")}`);
  console.log(`过程记录：${output}`);
}
process.exit(result.status ?? 1);
