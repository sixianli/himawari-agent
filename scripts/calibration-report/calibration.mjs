import { execFileSync } from "node:child_process";
import process from "node:process";

export const HISTORY_SCHEMA = "himawari-calibration-week.v1";
export const DEFAULT_MINIMUM_SAMPLES = 5;
export const WILSON_Z = 1.96;
export const HIMAWARI_ATTENTION_OUTCOMES = Object.freeze(["act", "know", "check"]);

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function wilsonInterval(successes, samples, z = WILSON_Z) {
  if (!Number.isInteger(samples) || samples <= 0) return null;
  const proportion = successes / samples;
  const z2 = z * z;
  const denominator = 1 + z2 / samples;
  const center = (proportion + z2 / (2 * samples)) / denominator;
  const half =
    (z * Math.sqrt((proportion * (1 - proportion)) / samples + z2 / (4 * samples * samples))) /
    denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function proportion(successes, samples, minimumSamples = DEFAULT_MINIMUM_SAMPLES) {
  const interval = wilsonInterval(successes, samples);
  const enough = samples >= minimumSamples && interval !== null;
  return {
    successes,
    samples,
    enough,
    value: enough ? successes / samples : null,
    low: enough ? interval.low : null,
    high: enough ? interval.high : null,
  };
}

export function formatProportion(result) {
  if (!result.enough) return `样本不足（${result.samples} 条）`;
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  return `${percent(result.value)}（${result.successes}/${result.samples}，95% 区间 ${percent(result.low)}–${percent(result.high)}）`;
}

export function resolveWindow({ end, days = 7, now = new Date() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 366)
    throw new RangeError("CALIBRATION_WINDOW_DAYS：天数必须是 1 到 366 的整数");
  let endMs;
  if (end === undefined || end === null) {
    const jstNow = now.getTime() + JST_OFFSET_MS;
    endMs = Math.floor(jstNow / DAY_MS) * DAY_MS - JST_OFFSET_MS;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(end))
      throw new RangeError(
        "CALIBRATION_WINDOW_END：结束日期要写成 YYYY-MM-DD（日本时间当天 0 点，不含）",
      );
    const parsed = Date.parse(`${end}T00:00:00.000Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== end)
      throw new RangeError("CALIBRATION_WINDOW_END：结束日期无效");
    endMs = parsed - JST_OFFSET_MS;
  }
  const startMs = endMs - days * DAY_MS;
  const jstDate = (ms) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    days,
    label: `${jstDate(startMs)} 至 ${jstDate(endMs - 1)}（日本时间）`,
    endDate: jstDate(endMs),
  };
}

export function summarizeDecisions(rows, minimumSamples = DEFAULT_MINIMUM_SAMPLES) {
  const kinds = [...new Set(rows.map((row) => row.kind))].sort();
  return kinds.map((kind) => {
    const ofKind = rows.filter((row) => row.kind === kind);
    const rated = ofKind.filter((row) => row.ownerRating !== null);
    const count = (rating) => rated.filter((row) => row.ownerRating === rating).length;
    const useful = count("useful");
    const unneeded = count("unneeded");
    const missed = count("missed");
    return {
      kind,
      total: ofKind.length,
      rated: rated.length,
      useful,
      unneeded,
      missed,
      hit: proportion(useful, rated.length, minimumSamples),
      nuisance: proportion(unneeded, rated.length, minimumSamples),
      missedRate: proportion(missed, rated.length, minimumSamples),
    };
  });
}

export function summarizeMuse(entries, mailJudgments, minimumSamples = DEFAULT_MINIMUM_SAMPLES) {
  const reminded = entries.filter((entry) => entry.museReminded);
  const paired = entries.filter((entry) => entry.pairedMessageId !== null);
  const byMail = new Map();
  for (const entry of paired) {
    const previous = byMail.get(entry.pairedMessageId);
    if (previous === undefined || (entry.museReminded && !previous.museReminded))
      byMail.set(entry.pairedMessageId, entry);
  }
  const buckets = { both: 0, museOnly: 0, himawariOnly: 0, bothSilent: 0, noHimawariRecord: 0 };
  const ratings = { useful: 0, unneeded: 0, missed: 0, unrated: 0 };
  for (const [messageId, entry] of byMail) {
    const judgment = mailJudgments.get(messageId);
    if (judgment === undefined) {
      buckets.noHimawariRecord += 1;
      continue;
    }
    const attention = HIMAWARI_ATTENTION_OUTCOMES.includes(judgment.outcome);
    if (entry.museReminded) buckets[attention ? "both" : "museOnly"] += 1;
    else buckets[attention ? "himawariOnly" : "bothSilent"] += 1;
    if (judgment.ownerRating === null) ratings.unrated += 1;
    else ratings[judgment.ownerRating] += 1;
  }
  return {
    entries: entries.length,
    reminded: reminded.length,
    silent: entries.length - reminded.length,
    timing: proportion(
      reminded.filter((entry) => entry.timingOk === true).length,
      reminded.length,
      minimumSamples,
    ),
    content: proportion(
      reminded.filter((entry) => entry.contentOk === true).length,
      reminded.length,
      minimumSamples,
    ),
    pairing: proportion(paired.length, entries.length, minimumSamples),
    unpaired: entries.length - paired.length,
    pairedMails: byMail.size,
    buckets,
    himawariRatingsOnPairedMails: ratings,
  };
}

const ISO_PATTERN = "????-??-??T??:??:??.???Z";

export function assertTimestampFormat(database) {
  const bad =
    database
      .prepare(
        `SELECT count(*) AS n FROM decision_ledger WHERE checked_at NOT GLOB '${ISO_PATTERN}'`,
      )
      .get().n +
    database
      .prepare(
        `SELECT count(*) AS n FROM muse_reference_entries WHERE muse_at NOT GLOB '${ISO_PATTERN}'`,
      )
      .get().n;
  if (bad > 0)
    throw new Error(
      `CALIBRATION_TIMESTAMP_FORMAT：有 ${bad} 条记录的时间不是 UTC 毫秒加 Z 的格式，按时间窗口统计会错，不出报告。`,
    );
}

export function readWindow(database, { ownerId, agentId, start, end }) {
  assertTimestampFormat(database);
  const decisions = database
    .prepare(
      `SELECT kind, owner_rating AS ownerRating FROM decision_ledger
       WHERE owner_id = ? AND agent_id = ? AND checked_at >= ? AND checked_at < ?`,
    )
    .all(ownerId, agentId, start, end);
  const entries = database
    .prepare(
      `SELECT muse_reminded AS museReminded, timing_ok AS timingOk, content_ok AS contentOk,
         paired_message_id AS pairedMessageId
       FROM muse_reference_entries
       WHERE owner_id = ? AND agent_id = ? AND muse_at >= ? AND muse_at < ?`,
    )
    .all(ownerId, agentId, start, end)
    .map((row) => ({
      museReminded: row.museReminded === 1,
      timingOk: row.timingOk === null ? null : row.timingOk === 1,
      contentOk: row.contentOk === null ? null : row.contentOk === 1,
      pairedMessageId: row.pairedMessageId,
    }));
  const mailJudgments = new Map();
  const lookup = database.prepare(
    `SELECT outcome, owner_rating AS ownerRating FROM proactive_processed_messages
     WHERE owner_id = ? AND agent_id = ? AND source = 'gmail' AND message_id = ?`,
  );
  for (const messageId of new Set(
    entries.map((e) => e.pairedMessageId).filter((id) => id !== null),
  )) {
    const row = lookup.get(ownerId, agentId, messageId);
    if (row !== undefined) mailJudgments.set(messageId, row);
  }
  return { decisions, entries, mailJudgments };
}

export function findScopes(database) {
  return database
    .prepare("SELECT owner_id AS ownerId, id AS agentId FROM agents ORDER BY owner_id, id")
    .all();
}

export function buildReport({ window, scope, decisions, muse, minimumSamples, previous }) {
  const lines = [];
  lines.push(`# 校准周报：${window.label}`, "");
  lines.push(
    `统计范围：这一周内做出的决策里，你评过价的那部分。命中率 = 做对了 ÷ 已评条数；误扰率 = 不该做 ÷ 已评条数；已审漏报率 = 该做没做 ÷ 已评条数（只代表你评过的样本，不代表全部沉默的决策）。三个数同一个分母。已评少于 ${minimumSamples} 条的不出百分比，写「样本不足」。区间是 95% Wilson 区间。`,
    "",
  );
  lines.push("## 按决策类型", "");
  if (decisions.length === 0) lines.push("这一周没有决策记录。", "");
  else {
    lines.push(
      "| 决策类型 | 总数 | 已评 | 命中率 | 误扰率 | 已审漏报率 |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const row of decisions)
      lines.push(
        `| ${row.kind} | ${row.total} | ${row.rated} | ${formatProportion(row.hit)} | ${formatProportion(row.nuisance)} | ${formatProportion(row.missedRate)} |`,
      );
    lines.push("");
  }
  lines.push("## 与 Muse 对照", "");
  if (muse.entries === 0) lines.push("样本不足：这一周没有 Muse 对照条目。", "");
  else {
    lines.push(
      `- Muse 对照条目共 ${muse.entries} 条：Muse 提醒了 ${muse.reminded} 条，没提醒 ${muse.silent} 条。`,
      `- Muse 提醒的时机对的占比：${formatProportion(muse.timing)}`,
      `- Muse 提醒的内容对的占比：${formatProportion(muse.content)}`,
      `- 配对率（条目里写明了对应邮件的占比）：${formatProportion(muse.pairing)}；没写明对应邮件的 ${muse.unpaired} 条不进下面的逐封比较。`,
      `- 逐封比较（同一封邮件，共 ${muse.pairedMails} 封）：两边都提醒 ${muse.buckets.both} 封；只有 Muse 提醒 ${muse.buckets.museOnly} 封；只有 Himawari 提醒 ${muse.buckets.himawariOnly} 封；两边都没提醒 ${muse.buckets.bothSilent} 封；Himawari 没有这封邮件的记录（含邮件编号写错）${muse.buckets.noHimawariRecord} 封。`,
      `- 你对这些邮件里 Himawari 判断的评价：做对了 ${muse.himawariRatingsOnPairedMails.useful}，不该做 ${muse.himawariRatingsOnPairedMails.unneeded}，该做没做 ${muse.himawariRatingsOnPairedMails.missed}，未评 ${muse.himawariRatingsOnPairedMails.unrated}。`,
      "- 局限：只有你记过 Muse 条目的邮件才进逐封比较；Himawari 提醒过、你没记 Muse 条目的邮件不在里面，两边都没提醒又没人记的邮件也没有记录，所以样本偏向有提醒的一侧。时机对和内容对的占比按条目计，不按邮件去重。",
      "",
    );
  }
  lines.push("## 与上一周对比", "");
  if (!previous) lines.push("没有更早的记录可比。", "");
  else {
    lines.push(`上一条记录：${previous.window.label}（提交 ${previous.commit}）。`, "");
    for (const row of decisions) {
      const before = previous.kinds.find((entry) => entry.kind === row.kind);
      const show = (rate) => (rate.enough ? `${(rate.value * 100).toFixed(1)}%` : "样本不足");
      const beforeRate = before
        ? proportion(before.useful, before.rated, previous.minimumSamples ?? minimumSamples)
        : null;
      lines.push(
        `- ${row.kind} 命中率：${beforeRate ? show(beforeRate) : "无记录"} → ${show(row.hit)}`,
      );
    }
    lines.push("", "只有两周的 95% 区间不重叠，才能说命中率真的变了；区间重叠只是波动。", "");
  }
  lines.push(`范围：所有者 ${scope.ownerId}，智能体 ${scope.agentId}。`, "");
  return lines.join("\n");
}

export function historyRecord({
  window,
  scope,
  decisions,
  muse,
  minimumSamples,
  commit,
  recordedAt,
}) {
  return {
    schema: HISTORY_SCHEMA,
    recordedAt,
    commit,
    ownerId: scope.ownerId,
    agentId: scope.agentId,
    window: { start: window.start, end: window.end, days: window.days, label: window.label },
    minimumSamples,
    kinds: decisions.map(({ kind, total, rated, useful, unneeded, missed }) => ({
      kind,
      total,
      rated,
      useful,
      unneeded,
      missed,
    })),
    muse: {
      entries: muse.entries,
      reminded: muse.reminded,
      timingOk: muse.timing.successes,
      contentOk: muse.content.successes,
      paired: muse.entries - muse.unpaired,
      buckets: muse.buckets,
    },
  };
}

export function sameMeasurement(left, right) {
  return (
    left.ownerId === right.ownerId &&
    left.agentId === right.agentId &&
    left.window.start === right.window.start &&
    left.window.end === right.window.end &&
    left.minimumSamples === right.minimumSamples &&
    JSON.stringify(left.kinds) === JSON.stringify(right.kinds) &&
    JSON.stringify(left.muse) === JSON.stringify(right.muse)
  );
}

export function currentCommit(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
