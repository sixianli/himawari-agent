import { appendFile, readFile } from "node:fs/promises";

export const HISTORY_SCHEMA_VERSION = 1;
export const SCENARIOS = Object.freeze([
  "memory_correction",
  "state_discipline",
  "failure_transparency",
  "proactive_next_step",
]);
export const SCENARIO_LABELS = Object.freeze({
  memory_correction: "#1 记忆纠正",
  state_discipline: "#6 状态判断",
  failure_transparency: "#8 失败透明",
  proactive_next_step: "#9 主动提下一步",
});
export const RED_FLAG_DROP = 2;
const JUDGE_TIERS = new Set(["code_only", "decision", "escalated", "reasoning_only"]);

function fail(message) {
  throw new Error(`JARVIS_HISTORY_INVALID:${message}`);
}

function identity(value, label, nullable) {
  if (value === null && nullable) return;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.id !== "string" ||
    typeof value.version !== "string" ||
    value.id.length === 0 ||
    value.version.length === 0
  )
    fail(`${label} must pin id and version`);
}

export function validateRecord(record) {
  if (record?.schemaVersion !== HISTORY_SCHEMA_VERSION) fail("schemaVersion");
  if (!Number.isFinite(Date.parse(record.runAt))) fail("runAt");
  for (const key of ["commit", "datasetVersion", "calibrationVersion"])
    if (typeof record[key] !== "string" || record[key].length === 0) fail(key);
  if (typeof record.graderCalibrated !== "boolean") fail("graderCalibrated");
  if (!Number.isSafeInteger(record.trials) || record.trials < 1) fail("trials");
  identity(record.models?.subject, "models.subject", false);
  identity(record.models?.decisionJudge, "models.decisionJudge", true);
  identity(record.models?.reasoningJudge, "models.reasoningJudge", false);
  if (!["two_tier", "reasoning_only"].includes(record.judgeMode)) fail("judgeMode");
  if ((record.judgeMode === "two_tier") !== (record.models.decisionJudge !== null))
    fail("judgeMode does not match models.decisionJudge");
  for (const key of ["subject", "judge"])
    if (!Number.isSafeInteger(record.tokens?.[key]) || record.tokens[key] < 0)
      fail(`tokens.${key}`);
  if (!Number.isSafeInteger(record.tokenLimit) || record.tokenLimit < 1) fail("tokenLimit");
  if (record.costMicros !== null && !Number.isSafeInteger(record.costMicros)) fail("costMicros");
  if (typeof record.stoppedByLimit !== "boolean") fail("stoppedByLimit");
  if (!Array.isArray(record.cases) || record.cases.length === 0) fail("cases");
  const ids = new Set();
  for (const item of record.cases) {
    if (typeof item.id !== "string" || ids.has(item.id)) fail("case id");
    ids.add(item.id);
    if (!SCENARIOS.includes(item.scenario)) fail(`case ${item.id} scenario`);
    if (
      !Array.isArray(item.trials) ||
      item.trials.length !== record.trials ||
      !item.trials.every((trial) => typeof trial === "boolean")
    )
      fail(`case ${item.id} trials`);
    if (
      item.jev_probability !== null &&
      !(
        typeof item.jev_probability === "number" &&
        item.jev_probability >= 0 &&
        item.jev_probability <= 1
      )
    )
      fail(`case ${item.id} jev_probability`);
    if (!JUDGE_TIERS.has(item.judge_tier)) fail(`case ${item.id} judge_tier`);
  }
  return record;
}

export async function appendHistory(file, record) {
  validateRecord(record);
  await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o644 });
}

export async function readHistory(file) {
  const text = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return validateRecord(JSON.parse(line));
      } catch (error) {
        throw new Error(`line ${index + 1}: ${error.message}`);
      }
    });
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarize(record) {
  return Object.fromEntries(
    SCENARIOS.map((scenario) => {
      const cases = record.cases.filter((item) => item.scenario === scenario);
      return [
        scenario,
        {
          cases: cases.length,
          passAll: cases.filter((item) => item.trials.every(Boolean)).length,
          passAt1: mean(cases.flatMap((item) => item.trials.map(Number))),
          jevMeanProbability: mean(
            cases.map((item) => item.jev_probability).filter((value) => value !== null),
          ),
        },
      ];
    }),
  );
}

export function compare(previous, current) {
  if (!previous) return Object.fromEntries(SCENARIOS.map((scenario) => [scenario, "first"]));
  if (previous.datasetVersion !== current.datasetVersion)
    return Object.fromEntries(SCENARIOS.map((scenario) => [scenario, "dataset_changed"]));
  const before = summarize(previous);
  const after = summarize(current);
  return Object.fromEntries(
    SCENARIOS.map((scenario) => {
      const delta = after[scenario].passAll - before[scenario].passAll;
      if (delta <= -RED_FLAG_DROP) return [scenario, "drop"];
      if (delta < 0) return [scenario, "wobble"];
      if (delta > 0) return [scenario, "rise"];
      return [scenario, "same"];
    }),
  );
}

const MARKS = {
  first: "",
  dataset_changed: "（题目已变，不和上次比）",
  drop: "  ▼ 下降",
  wobble: "（-1 条，波动）",
  rise: "  ▲",
  same: "",
};

function percent(value) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function probability(value) {
  return value === null ? "—" : value.toFixed(2);
}

function jst(iso) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  return `${parts} JST`;
}

export function renderTrend(records) {
  if (records.length === 0)
    return "还没有真模型评测记录。跑一次 npm run eval:jarvis:live 后这里会有数据。";
  const lines = [];
  for (const [index, record] of records.entries()) {
    const marks = compare(records[index - 1], record);
    const summary = summarize(record);
    const judge = record.models.decisionJudge
      ? `${record.models.decisionJudge.id} → ${record.models.reasoningJudge.id}`
      : record.models.reasoningJudge.id;
    const cost = record.costMicros === null ? "未测量" : `$${(record.costMicros / 1e6).toFixed(4)}`;
    lines.push(
      `${jst(record.runAt)}  提交 ${record.commit.slice(0, 7)}  题目 ${record.datasetVersion}${record.graderCalibrated ? "" : "  校准前"}${record.stoppedByLimit ? "  到 token 上限提前停止" : ""}`,
    );
    lines.push(
      `  被测模型 ${record.models.subject.id}@${record.models.subject.version}  裁判 ${judge}`,
    );
    for (const scenario of SCENARIOS) {
      const item = summary[scenario];
      lines.push(
        `  ${SCENARIO_LABELS[scenario]}  ${record.trials} 次全过 ${item.passAll}/${item.cases}  单次通过率 ${percent(item.passAt1)}  Jev 平均概率 ${probability(item.jevMeanProbability)}${MARKS[marks[scenario]]}`,
      );
    }
    lines.push(
      `  token 被测 ${record.tokens.subject} / 裁判 ${record.tokens.judge}（上限 ${record.tokenLimit}）  费用 ${cost}`,
    );
  }
  return lines.join("\n");
}
