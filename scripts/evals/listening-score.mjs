import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  VOICE_AIRPODS_NEAR_GATE,
  VOICE_COMMAND_AMBIENT_GATE,
  VOICE_SCORE_MAX,
  wilsonInterval,
} from "@himawari-agent/calibration";
import {
  DEFAULT_VOICE_GATES,
  decideVoiceCommand,
} from "../../packages/application/src/services/voice-command.ts";
import {
  normalizeSpokenText,
  spokenQueryText,
  textSimilarityPermille,
} from "../../packages/memory-engine/src/query-prefetch.ts";

export const SWEEP_STEP = 10;
export const PREFETCH_SIMILARITY_LEVELS = Object.freeze([1000, 950, 900, 800]);
const CHARACTER_LANGUAGES = new Set(["zh-Hans", "ja", "mixed"]);
const CALL_PURPOSES = new Set(["command", "bystander", "tv_mention", "owner_mention"]);
const NEGATIVE_CALLS = new Set(["bystander", "tv_mention"]);

export function parseObservations(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function rate(successes, samples) {
  const interval = wilsonInterval(successes, samples);
  return {
    successes,
    samples,
    share: samples === 0 ? null : successes / samples,
    low: interval?.low ?? null,
    high: interval?.high ?? null,
  };
}

function thresholds() {
  const values = [];
  for (let value = 0; value <= VOICE_SCORE_MAX; value += SWEEP_STEP) values.push(value);
  values.push(VOICE_SCORE_MAX + 1);
  return values;
}

function scored(observations, predicate) {
  return observations.filter(
    (observation) => predicate(observation) && Number.isInteger(observation.speakerScore),
  );
}

export function scoreSpeaker(observations) {
  const owner = scored(
    observations,
    ({ clip }) => clip.source === "owner" && clip.purpose === "speaker",
  );
  const others = scored(
    observations,
    ({ clip }) => clip.source !== "owner" && clip.purpose === "speaker",
  );
  const speakers = new Set(others.map(({ clip }) => clip.speaker));
  const sweep = thresholds().map((threshold) => ({
    threshold,
    falseAccept: rate(
      others.filter((item) => item.speakerScore >= threshold).length,
      others.length,
    ),
    falseReject: rate(owner.filter((item) => item.speakerScore < threshold).length, owner.length),
  }));
  let equalError = null;
  for (const row of sweep) {
    const gap = Math.abs((row.falseAccept.share ?? 0) - (row.falseReject.share ?? 0));
    if (equalError === null || gap < equalError.gap) equalError = { gap, row };
  }
  const byCondition = {};
  for (const condition of ["quiet", "noisy"]) {
    byCondition[condition] = {
      owner: owner.filter(({ clip }) => clip.condition === condition).length,
      others: others.filter(({ clip }) => clip.condition === condition).length,
      ownerMedian: median(
        owner.filter(({ clip }) => clip.condition === condition).map((item) => item.speakerScore),
      ),
      othersMax: Math.max(
        -1,
        ...others
          .filter(({ clip }) => clip.condition === condition)
          .map((item) => item.speakerScore),
      ),
    };
  }
  return {
    owner: owner.length,
    others: others.length,
    otherSpeakers: speakers.size,
    equalErrorThreshold: equalError?.row.threshold ?? null,
    equalErrorRate: equalError?.row.falseAccept.share ?? null,
    strictest: lowestThresholdWithFalseAcceptUnder(sweep, 0.02),
    byCondition,
    sweep,
  };
}

function lowestThresholdWithFalseAcceptUnder(sweep, limit) {
  const row = sweep.find((candidate) => (candidate.falseAccept.high ?? 1) <= limit);
  return row ? { threshold: row.threshold, falseReject: row.falseReject } : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function evidenceFor(observation) {
  const { clip } = observation;
  return {
    trigger: clip.placement === "airpods" ? "airpods_name" : "ambient_name",
    speakerScore: Number.isInteger(observation.speakerScore) ? observation.speakerScore : null,
    inputRoute: clip.route,
    inEar: typeof clip.inEar === "boolean" ? clip.inEar : null,
    loudnessScore: Number.isInteger(observation.loudnessScore) ? observation.loudnessScore : null,
  };
}

function gatesWith({ ambient, near }) {
  return {
    ...DEFAULT_VOICE_GATES,
    ambientCommand: { ...VOICE_COMMAND_AMBIENT_GATE, defaultThreshold: ambient },
    airpodsNear: { ...VOICE_AIRPODS_NEAR_GATE, defaultThreshold: near },
  };
}

export function executes(observation, gates) {
  const request = observation.call?.request;
  if (typeof request !== "string" || request.trim().length === 0) return false;
  return decideVoiceCommand(evidenceFor(observation), gates).accepted;
}

export function scoreCommand(observations) {
  const calls = observations.filter(({ clip }) => CALL_PURPOSES.has(clip.purpose));
  const positives = calls.filter(
    ({ clip }) => clip.source === "owner" && clip.purpose === "command",
  );
  const negatives = calls.filter(({ clip }) => NEGATIVE_CALLS.has(clip.purpose));
  const ownerMentions = calls.filter(({ clip }) => clip.purpose === "owner_mention");
  const nameHeard = {};
  for (const observation of calls) {
    const key = `${observation.clip.purpose}/${observation.clip.placement}/${observation.clip.language}`;
    nameHeard[key] ??= { heard: 0, total: 0 };
    nameHeard[key].total += 1;
    if (observation.call?.nameHeard) nameHeard[key].heard += 1;
  }
  const placements = {
    airpods: { gate: "near", select: ({ clip }) => clip.placement === "airpods" },
    ambient: { gate: "ambient", select: ({ clip }) => clip.placement !== "airpods" },
  };
  const sweeps = {};
  const recommended = {};
  for (const [name, { gate, select }] of Object.entries(placements)) {
    const owned = positives.filter(select);
    const foreign = negatives.filter(select);
    const rows = thresholds().map((threshold) => {
      const gates = gatesWith({
        ambient: gate === "ambient" ? threshold : VOICE_SCORE_MAX + 1,
        near: gate === "near" ? threshold : VOICE_SCORE_MAX + 1,
      });
      return {
        threshold,
        executed: rate(owned.filter((item) => executes(item, gates)).length, owned.length),
        wronglyExecuted: foreign.filter((item) => executes(item, gates)).length,
      };
    });
    sweeps[name] = rows;
    recommended[name] =
      rows
        .filter((row) => row.wronglyExecuted === 0 && row.executed.samples > 0)
        .sort(
          (a, b) => (b.executed.share ?? 0) - (a.executed.share ?? 0) || b.threshold - a.threshold,
        )[0] ?? null;
  }
  const atRecommended = gatesWith({
    ambient: recommended.ambient?.threshold ?? VOICE_SCORE_MAX + 1,
    near: recommended.airpods?.threshold ?? VOICE_SCORE_MAX + 1,
  });
  return {
    positives: positives.length,
    negatives: negatives.length,
    ownerMentions: {
      total: ownerMentions.length,
      nameHeard: ownerMentions.filter(({ call }) => call?.nameHeard).length,
      executedAtRecommended: ownerMentions.filter((item) => executes(item, atRecommended)).length,
    },
    nameHeard,
    recommended,
    sweeps,
  };
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[right.length];
}

export function errorUnits(language, text) {
  if (CHARACTER_LANGUAGES.has(language)) return [...normalizeSpokenText(text)];
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

export function scoreTranscription(observations) {
  const groups = new Map();
  for (const observation of observations) {
    const { clip } = observation;
    if (!["speaker", "mixed", "public_speech"].includes(clip.purpose)) continue;
    const reference = errorUnits(clip.language, clip.reference);
    if (reference.length === 0) continue;
    for (const transcript of observation.transcripts ?? []) {
      const key = [
        clip.language,
        clip.source === "owner" ? "owner" : "public",
        transcript.engine,
        transcript.locale,
      ].join("|");
      const group = groups.get(key) ?? { errors: 0, units: 0, clips: 0, seconds: 0 };
      const text = transcript.pieces
        .filter((piece) => piece.isFinal)
        .map((piece) => piece.text)
        .join(" ");
      group.errors += editDistance(reference, errorUnits(clip.language, text));
      group.units += reference.length;
      group.clips += 1;
      group.seconds += Math.max(0, ...transcript.pieces.map((piece) => piece.at));
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [language, speaker, engine, locale] = key.split("|");
      return {
        language,
        speaker,
        engine,
        locale,
        measure: CHARACTER_LANGUAGES.has(language) ? "character" : "word",
        errorRate: group.errors / group.units,
        clips: group.clips,
        minutes: group.seconds / 60,
      };
    })
    .sort((a, b) => a.language.localeCompare(b.language) || a.errorRate - b.errorRate);
}

export function scorePrefetch(observations) {
  const commands = observations.filter(
    ({ clip, call }) =>
      clip.source === "owner" && clip.purpose === "command" && typeof call?.request === "string",
  );
  const prepared = commands.filter(({ call }) => call.prepared.length > 0);
  const similarities = prepared.map(({ call }) =>
    textSimilarityPermille(call.prepared.at(-1), call.request),
  );
  const reused = prepared.filter(
    ({ call }) => spokenQueryText(call.prepared.at(-1)) === spokenQueryText(call.request),
  );
  return {
    commands: commands.length,
    withPrepared: prepared.length,
    reused: rate(reused.length, commands.length),
    preparedPerCommand:
      commands.length === 0
        ? null
        : commands.reduce((sum, { call }) => sum + call.prepared.length, 0) / commands.length,
    similarity: PREFETCH_SIMILARITY_LEVELS.map((threshold) => ({
      threshold,
      rate: rate(similarities.filter((value) => value >= threshold).length, commands.length),
    })),
  };
}

export function scoreListening(observations) {
  const command = scoreCommand(observations);
  return {
    observations: observations.length,
    speaker: scoreSpeaker(observations),
    command,
    transcription: scoreTranscription(observations),
    prefetch: scorePrefetch(observations),
  };
}

function percent(value) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function interval(entry) {
  return `${percent(entry.share)}（${percent(entry.low)}–${percent(entry.high)}，${entry.successes}/${entry.samples}）`;
}

export function renderReport(score) {
  const lines = [];
  const { speaker, command, transcription, prefetch } = score;
  lines.push("# 收听评测结果", "");
  lines.push(
    "主人的录音都是照着屏幕读的，比日常随口说话流利，所以下面的转文字错字率和叫名字的命中率会偏乐观。",
    "",
  );
  lines.push("## 认人", "");
  lines.push(
    `主人 ${speaker.owner} 句，非主人 ${speaker.others} 句（${speaker.otherSpeakers} 个不同来源）。`,
  );
  lines.push(
    `错认率和漏认率相等的门槛约 ${speaker.equalErrorThreshold ?? "—"}，这时错认率 ${percent(speaker.equalErrorRate)}。`,
  );
  if (speaker.strictest)
    lines.push(
      `错认率 95% 区间上限不超过 2% 的最低门槛：${speaker.strictest.threshold}，这时主人被漏认 ${interval(speaker.strictest.falseReject)}。`,
    );
  else lines.push("没有哪个门槛能让错认率 95% 区间上限不超过 2%。");
  lines.push(
    "",
    "| 环境 | 主人 | 非主人 | 主人分数中位数 | 非主人最高分 |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const [condition, row] of Object.entries(speaker.byCondition))
    lines.push(
      `| ${condition} | ${row.owner} | ${row.others} | ${row.ownerMedian ?? "—"} | ${row.othersMax} |`,
    );
  lines.push("", "## 口头指令", "");
  lines.push(
    `主人叫它 ${command.positives} 次，旁人叫它和电视里出现名字共 ${command.negatives} 次。`,
    "",
  );
  for (const [name, row] of Object.entries(command.recommended))
    lines.push(
      row
        ? `- ${name === "airpods" ? "戴 AirPods（近处音量门槛）" : "放在一旁或口袋里（认人门槛）"}：不误执行的前提下门槛取 ${row.threshold}，主人叫它执行了 ${interval(row.executed)}。`
        : `- ${name}：没有哪个门槛能做到旁人叫它 0 次误执行。`,
    );
  lines.push(
    "",
    `主人提到名字但不是在叫它：${command.ownerMentions.total} 句，听成叫名字 ${command.ownerMentions.nameHeard} 句，按上面的门槛会被执行 ${command.ownerMentions.executedAtRecommended} 句（期望 0）。`,
  );
  lines.push("", "| 类别/放法/语言 | 听到名字 |", "| --- | --- |");
  for (const [key, row] of Object.entries(command.nameHeard).sort())
    lines.push(`| ${key} | ${row.heard}/${row.total} |`);
  lines.push(
    "",
    "## 转文字",
    "",
    "| 语言 | 说话人 | 引擎 | 语言设置 | 错误率 | 计法 | 句数 | 分钟 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of transcription)
    lines.push(
      `| ${row.language} | ${row.speaker} | ${row.engine} | ${row.locale} | ${percent(row.errorRate)} | ${row.measure === "character" ? "按字" : "按词"} | ${row.clips} | ${row.minutes.toFixed(1)} |`,
    );
  lines.push("", "## 抢跑", "");
  lines.push(
    `主人的口头指令 ${prefetch.commands} 句，其中 ${prefetch.withPrepared} 句提前发了半句话，平均每句发 ${prefetch.preparedPerCommand?.toFixed(1) ?? "—"} 次。`,
    `服务器的做法：最后半句和最终那句按同一规则去掉标点后完全一样才采用，采用了 ${interval(prefetch.reused)}。`,
    "",
    "下表只是统计，不用于线上：如果按相似度放宽，能多采用多少。",
    "",
    "| 相似度至少 | 句数 |",
    "| --- | --- |",
  );
  for (const row of prefetch.similarity) lines.push(`| ${row.threshold} | ${interval(row.rate)} |`);
  return `${lines.join("\n")}\n`;
}

export function run(argv, options = {}) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  const input = args.get("--observations");
  if (!input) throw new Error("usage: listening-score.mjs --observations FILE [--out DIR]");
  const score = scoreListening(parseObservations(readFileSync(input, "utf8")));
  const report = renderReport(score);
  const out = args.get("--out");
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "listening-score.json"), `${JSON.stringify(score, null, 2)}\n`);
    writeFileSync(path.join(out, "listening-report.md"), report);
  }
  (options.output ?? process.stdout).write(report);
  return score;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  run(process.argv.slice(2));
