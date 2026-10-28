import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderTrend } from "./history.mjs";

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
const known = new Set(["cases", "trials", "token-limit", "calibrated", "no-record"]);
for (const key of options.keys())
  if (!known.has(key)) {
    console.error(`JARVIS_LIVE_UNKNOWN_OPTION：不认识的参数 --${key}`);
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

const output = path.resolve(
  ".ci-output/jarvis-test",
  new Date().toISOString().replace(/[:.]/gu, "-"),
);
const environment = {
  ...process.env,
  HIMAWARI_JARVIS_OUTPUT: output,
  HIMAWARI_JARVIS_LIVE: "1",
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
