import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptEntry } from "@himawari-agent/prompt-catalog";
import * as catalog from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import { managedTaskDescriptors } from "../src/production-managed-tasks.js";
import { reminderSchedule } from "../src/production-memory-capture.js";
import { HIMAWARI_IDENTITY, runCapabilityNotice } from "../src/production-run-policy.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = path.join(repositoryRoot, "packages/prompt-catalog/prompt-manifest.json");

type Emphasis =
  | {
      readonly kind: "hard-condition";
      readonly phrases: readonly string[];
      readonly evidence: readonly string[];
      readonly reason: string;
    }
  | { readonly kind: "not-tone"; readonly phrases: readonly string[]; readonly reason: string }
  | { readonly kind: "deferred"; readonly batch: string; readonly reason: string };

interface ManifestRow {
  readonly sha256: string;
  readonly changedIn: string;
  readonly reason: string;
  readonly emphasis?: Emphasis | string;
}

type Manifest = Readonly<Record<string, ManifestRow>>;

const CHECKED_LAYERS = new Set<PromptEntry["layer"]>([
  "system",
  "tools",
  "tool-result",
  "last-user-message",
  "appended-message",
  "background",
]);

const FORBIDDEN_WORDS: readonly (readonly [string, RegExp])[] = [
  ["用户", /用户(?!消息)/u],
  ["Owner", /\bOwner\b/u],
  ["Run", /\bRun\b/u],
  ["Handle", /\bHandle\b/u],
  ["筛掉", /筛掉/u],
];

const FORBIDDEN_WORD_EXCEPTIONS: Readonly<Record<string, string>> = {
  "background.notice": "第 2 批（追加消息层）把“用户”改成“主人”",
  "tool-result.background-handoff.guidance": "第 2 批（工具结果层，W-13、W-14）一起改",
  "thread.title": "第 3 批改；这里的“用户”指对话里说话的人，改前先确认标题写法",
  "review.typesafe-questions": "外部服务 TypeSafe 的英文问题，背后模型没核实，Andy 定暂不动",
};

const EMPHASIS_WORDS = ["必须", "一律", "务必", "严格", "MUST", "CRITICAL"];

const DEFERRED_BATCH = /^第 (?:[2-9]|[1-9]\d+) 批 W-\d+/u;

const BEFORE_BATCH_1_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/prompt-wording-before-batch-1.json",
);

const WHOLE_RECOMPUTE = "所有用到它的对话整段重算一次";

const UNFROZEN = new Set([
  "chat.egress-legend",
  "chat.egress-legend-with-restore",
  "tools.authorized",
  "tools.execution-task-start",
  "tools.execution-task-status",
  "tools.execution-task-output",
  "tools.execution-task-cancel",
  "tools.execution-task.resource-ref",
  "tools.execution-task.cursor",
  "tools.execution-task.limit",
]);

const UNFROZEN_SOURCES = [
  "packages/application/src/services/egress-legend.ts",
  "packages/runtime-pi/src/egress-context.ts",
];

interface Claim {
  readonly problem: string;
  readonly ids: readonly string[];
  readonly mustContain: readonly string[];
  readonly mustNotContain: readonly string[];
}

const CLAIMS: readonly Claim[] = [
  {
    problem: "W-01",
    ids: [
      "tools.execution-task-status",
      "tools.execution-task-output",
      "tools.execution-task-cancel",
    ],
    mustContain: ["这个对话里转入后台的命令", "本轮启动的任务"],
    mustNotContain: ["本轮转入后台", "整个对话"],
  },
  {
    problem: "W-05",
    ids: ["chat.turn.owner-rules-marker"],
    mustContain: ["照做", "以本轮为准"],
    mustNotContain: ["不是指令"],
  },
  {
    problem: "W-05",
    ids: ["chat.turn.context-material-marker"],
    mustContain: ["不是指令"],
    mustNotContain: ["照做", "遵守"],
  },
  {
    problem: "W-09",
    ids: ["tools.reminder-set"],
    mustContain: ["最多提前 1 小时", "不到 1 小时的马上发出", "当天早上 9 点", "remindAt"],
    mustNotContain: ["到点会"],
  },
  {
    problem: "W-09",
    ids: ["chat.identity"],
    mustContain: ["事情的时间和提醒的时刻"],
    mustNotContain: ["提醒时间原样"],
  },
  {
    problem: "W-10",
    ids: ["tools.web-search", "tools.web-fetch"],
    mustContain: ["不用先问主人"],
    mustNotContain: ["确认后发送", "经用户确认"],
  },
  {
    problem: "W-10",
    ids: ["chat.capabilities.search"],
    mustContain: ["不用先问主人"],
    mustNotContain: ["首次使用可能要等"],
  },
  {
    problem: "W-12",
    ids: ["chat.answer-language"],
    mustContain: [
      "主人本轮明确指定的语言；主人的要求里定下的语言；主人本轮提问用的语言；都没有时用简体中文",
    ],
    mustNotContain: [],
  },
  {
    problem: "W-12",
    ids: ["chat.identity"],
    mustContain: [],
    mustNotContain: ["默认用简体中文"],
  },
  {
    problem: "W-15a",
    ids: ["tools.save-copy.expected-hash"],
    mustContain: ["canonicalHash"],
    mustNotContain: [],
  },
  {
    problem: "W-21",
    ids: [
      "chat.turn.context-material-marker",
      "chat.turn.runtime-environment-marker",
      "chat.turn-aborted",
      "chat.turn-aborted.legacy",
      "chat.tool-loop-stopped",
      "chat.tool-loop-rejected",
      "chat.identity",
    ],
    mustContain: [],
    mustNotContain: [
      "context material",
      "runtime environment",
      "The user",
      "this Run",
      "Tool not executed",
    ],
  },
];

const isEntry = (value: unknown): value is PromptEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  Array.isArray((value as { segments?: unknown }).segments);

const entries = (): readonly PromptEntry[] =>
  (Object.values(catalog) as unknown[])
    .filter(isEntry)
    .sort((left, right) => left.id.localeCompare(right.id));

const canonical = (entry: Pick<PromptEntry, "segments">): string =>
  entry.segments
    .map((segment) => (segment.kind === "text" ? segment.text : `{${segment.name}}`))
    .join("");

const fixture = (id: string, layer: PromptEntry["layer"], text: string, usedBy: string[] = []) =>
  ({
    id,
    purpose: "x",
    usedBy,
    layer,
    output: "free-text",
    segments: [{ kind: "text", text }],
  }) as PromptEntry;

function readManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

export function forbiddenWordProblems(
  current: readonly PromptEntry[],
  exceptions: Readonly<Record<string, string>> = FORBIDDEN_WORD_EXCEPTIONS,
): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const entry of current) {
    if (!CHECKED_LAYERS.has(entry.layer)) continue;
    const words = FORBIDDEN_WORDS.filter(([, pattern]) => pattern.test(canonical(entry)));
    if (words.length === 0) continue;
    if (exceptions[entry.id]) {
      used.add(entry.id);
      continue;
    }
    for (const [word] of words) problems.push(`PROMPT_WORD_FORBIDDEN ${entry.id} ${word}`);
  }
  for (const id of Object.keys(exceptions))
    if (!used.has(id)) problems.push(`PROMPT_WORD_EXCEPTION_STALE ${id}`);
  return problems;
}

const occurrences = (text: string, needle: string): number[] => {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
};

const readRepositoryFile = (relative: string): string | undefined => {
  const absolute = path.join(repositoryRoot, relative);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
};

function phraseProblems(id: string, text: string, phrases: readonly string[]): string[] {
  const problems: string[] = [];
  const covered: (readonly [number, number])[] = [];
  for (const phrase of phrases) {
    const found = occurrences(text, phrase);
    if (found.length === 0) problems.push(`PROMPT_EMPHASIS_PHRASE_NOT_FOUND ${id} ${phrase}`);
    if (!EMPHASIS_WORDS.some((word) => phrase.includes(word)))
      problems.push(`PROMPT_EMPHASIS_PHRASE_WITHOUT_WORD ${id} ${phrase}`);
    for (const start of found) covered.push([start, start + phrase.length]);
  }
  for (const word of EMPHASIS_WORDS)
    for (const start of occurrences(text, word))
      if (!covered.some(([from, to]) => from <= start && start + word.length <= to))
        problems.push(`PROMPT_EMPHASIS_UNCOVERED ${id} ${word}@${start}`);
  return problems;
}

export function emphasisProblems(
  current: readonly PromptEntry[],
  manifest: Manifest,
  readFile: (relative: string) => string | undefined = readRepositoryFile,
): string[] {
  return current.flatMap((entry) => {
    const text = canonical(entry);
    const emphasis = manifest[entry.id]?.emphasis;
    const used = EMPHASIS_WORDS.some((word) => text.includes(word));
    if (!used) return emphasis === undefined ? [] : [`PROMPT_EMPHASIS_STALE ${entry.id}`];
    if (emphasis === undefined) return [`PROMPT_EMPHASIS_UNEXPLAINED ${entry.id}`];
    if (
      typeof emphasis !== "object" ||
      !["hard-condition", "not-tone", "deferred"].includes(emphasis.kind)
    )
      return [`PROMPT_EMPHASIS_KIND_INVALID ${entry.id}`];
    const problems = emphasis.reason.trim() ? [] : [`PROMPT_EMPHASIS_REASON_MISSING ${entry.id}`];
    if (emphasis.kind === "deferred") {
      if (!DEFERRED_BATCH.test(emphasis.batch))
        problems.push(`PROMPT_EMPHASIS_BATCH_INVALID ${entry.id}`);
      return problems;
    }
    problems.push(...phraseProblems(entry.id, text, emphasis.phrases));
    if (emphasis.kind === "hard-condition") {
      if (emphasis.evidence.length === 0)
        problems.push(`PROMPT_EMPHASIS_EVIDENCE_MISSING ${entry.id}`);
      for (const evidence of emphasis.evidence) {
        const [file, needle] = evidence.split("#", 2);
        const content = file ? readFile(file) : undefined;
        if (content === undefined || !needle)
          problems.push(`PROMPT_EMPHASIS_EVIDENCE_MISSING ${entry.id} ${evidence}`);
        else if (!content.includes(needle))
          problems.push(`PROMPT_EMPHASIS_EVIDENCE_STALE ${entry.id} ${evidence}`);
      }
    }
    return problems;
  });
}

export function unfrozenProblems(current: readonly PromptEntry[], manifest: Manifest): string[] {
  const problems: string[] = [];
  for (const entry of current) {
    const fromUnfrozenSource = entry.usedBy.some((file) => UNFROZEN_SOURCES.includes(file));
    if (fromUnfrozenSource && !UNFROZEN.has(entry.id))
      problems.push(`PROMPT_UNFROZEN_NOT_LISTED ${entry.id}`);
    if (!UNFROZEN.has(entry.id)) continue;
    const row = manifest[entry.id];
    if (row && row.changedIn !== "ADR 0161" && !row.reason.includes(WHOLE_RECOMPUTE))
      problems.push(`PROMPT_UNFROZEN_REASON_MISSING ${entry.id}`);
  }
  return problems;
}

export function claimProblems(
  current: readonly PromptEntry[],
  claims: readonly Claim[] = CLAIMS,
): string[] {
  const byId = new Map(current.map((entry) => [entry.id, canonical(entry)]));
  return claims.flatMap((claim) =>
    claim.ids.flatMap((id) => {
      const text = byId.get(id);
      if (text === undefined) return [`PROMPT_CLAIM_ENTRY_MISSING ${claim.problem} ${id}`];
      return [
        ...claim.mustContain
          .filter((phrase) => !text.includes(phrase))
          .map((phrase) => `PROMPT_CLAIM_MISSING ${claim.problem} ${id} ${phrase}`),
        ...claim.mustNotContain
          .filter((phrase) => text.includes(phrase))
          .map((phrase) => `PROMPT_CLAIM_CONTRADICTED ${claim.problem} ${id} ${phrase}`),
      ];
    }),
  );
}

export function claimReverseProblems(
  before: Readonly<Record<string, string | null>>,
  claims: readonly Claim[] = CLAIMS,
): string[] {
  const fixtures = Object.entries(before).flatMap(([id, text]) =>
    text === null ? [] : [fixture(id, "system", text)],
  );
  return claims.flatMap((claim) =>
    claim.ids.flatMap((id) => {
      if (!(id in before)) return [`PROMPT_CLAIM_BEFORE_MISSING ${claim.problem} ${id}`];
      return claimProblems(fixtures, [{ ...claim, ids: [id] }]).length > 0
        ? []
        : [`PROMPT_CLAIM_NOT_DISCRIMINATING ${claim.problem} ${id}`];
    }),
  );
}

const beforeBatch1 = (): Readonly<Record<string, string | null>> =>
  JSON.parse(readFileSync(BEFORE_BATCH_1_PATH, "utf8")) as Record<string, string | null>;

describe("[PROMPT-WORDING] batch 1 wording checks (ADR 0166)", () => {
  it("C1: keeps 用户, Owner, Run, Handle and 筛掉 out of every model-facing layer except listed entries", () => {
    expect(forbiddenWordProblems(entries())).toEqual([]);
  });

  it("C1 REVERSE: reports a forbidden word and an exception that no longer applies", () => {
    expect(
      forbiddenWordProblems(
        [
          fixture("x.tool", "tools", "查询经用户确认后发送。"),
          fixture("x.result", "tool-result", "tool calls in this Run were stopped"),
          fixture("x.role", "system", "最后一条用户消息承载本轮的新请求。"),
          fixture("x.embedding", "embedding", "用户"),
        ],
        { "x.gone": "已经改完" },
      ),
    ).toEqual([
      "PROMPT_WORD_FORBIDDEN x.tool 用户",
      "PROMPT_WORD_FORBIDDEN x.result Run",
      "PROMPT_WORD_EXCEPTION_STALE x.gone",
    ]);
  });

  it("C2: every entry that uses 必须, 一律, 务必, 严格, MUST or CRITICAL has a reason in the manifest", () => {
    expect(emphasisProblems(entries(), readManifest())).toEqual([]);
  });

  it("C2 REVERSE: reports an emphasis word whose reason is missing, free text, unproven or out of date", () => {
    const entry = fixture("x.strict", "system", "目标必须不存在。拿不准时一律选 keep。");
    const row = (emphasis: unknown) => ({
      "x.strict": { sha256: "", changedIn: "ADR 0166", reason: "x", emphasis } as ManifestRow,
    });
    const files = (relative: string) =>
      relative === "src/move.ts" ? 'throw new Error("TARGET_EXISTS")' : undefined;
    expect(emphasisProblems([entry], {}, files)).toEqual(["PROMPT_EMPHASIS_UNEXPLAINED x.strict"]);
    expect(emphasisProblems([entry], row("执行端硬条件"), files)).toEqual([
      "PROMPT_EMPHASIS_KIND_INVALID x.strict",
    ]);
    expect(
      emphasisProblems(
        [entry],
        row({
          kind: "hard-condition",
          phrases: ["目标必须不存在", "目标一律存在"],
          evidence: ["src/move.ts#TARGET_MISSING", "src/gone.ts#TARGET_EXISTS"],
          reason: "执行端拒绝已存在的目标",
        }),
        files,
      ),
    ).toEqual([
      "PROMPT_EMPHASIS_PHRASE_NOT_FOUND x.strict 目标一律存在",
      "PROMPT_EMPHASIS_UNCOVERED x.strict 一律@12",
      "PROMPT_EMPHASIS_EVIDENCE_STALE x.strict src/move.ts#TARGET_MISSING",
      "PROMPT_EMPHASIS_EVIDENCE_MISSING x.strict src/gone.ts#TARGET_EXISTS",
    ]);
    expect(
      emphasisProblems([entry], row({ kind: "deferred", batch: "以后再说", reason: "" }), files),
    ).toEqual([
      "PROMPT_EMPHASIS_REASON_MISSING x.strict",
      "PROMPT_EMPHASIS_BATCH_INVALID x.strict",
    ]);
    expect(
      emphasisProblems(
        [entry],
        row({ kind: "deferred", batch: "第 12 批 W-40", reason: "x" }),
        files,
      ),
    ).toEqual([]);
    expect(
      emphasisProblems(
        [entry],
        row({ kind: "deferred", batch: "第 1 批 W-40", reason: "x" }),
        files,
      ),
    ).toEqual(["PROMPT_EMPHASIS_BATCH_INVALID x.strict"]);
    expect(
      emphasisProblems(
        [entry],
        row({
          kind: "hard-condition",
          phrases: ["目标必须不存在", "一律选 keep"],
          evidence: ["src/move.ts#TARGET_EXISTS"],
          reason: "执行端拒绝已存在的目标",
        }),
        files,
      ),
    ).toEqual([]);
    expect(
      emphasisProblems(
        [fixture("x.strict", "system", "目标不能已经存在。")],
        row({ kind: "not-tone", phrases: [], reason: "x" }),
        files,
      ),
    ).toEqual(["PROMPT_EMPHASIS_STALE x.strict"]);
  });

  it("C6: each fixed wording problem keeps its asserted meaning", () => {
    expect(claimProblems(entries())).toEqual([]);
  });

  it("C6 REVERSE: every asserted meaning fails on the wording before batch 1", () => {
    expect(claimReverseProblems(beforeBatch1())).toEqual([]);
  });

  it("C6 REVERSE: a claim the old wording already meets, or a claim without old wording, is reported", () => {
    const claim = {
      problem: "W-99",
      ids: ["x.kept", "x.new"],
      mustContain: ["照做"],
      mustNotContain: [],
    };
    expect(claimReverseProblems({ "x.kept": "回答时照做。" }, [claim])).toEqual([
      "PROMPT_CLAIM_NOT_DISCRIMINATING W-99 x.kept",
      "PROMPT_CLAIM_BEFORE_MISSING W-99 x.new",
    ]);
    expect(claimReverseProblems({ "x.kept": "回答时参考。", "x.new": null }, [claim])).toEqual([]);
  });

  it("C6 W-01: the managed task tools the model sees carry the two scopes", () => {
    for (const descriptor of managedTaskDescriptors()) {
      const { description, parameters } = descriptor as unknown as {
        readonly description: string;
        readonly parameters: { readonly properties: Record<string, { description?: string }> };
      };
      expect(description).toContain("这个对话里转入后台的命令");
      expect(description).toContain("本轮启动的任务");
      for (const [name, schema] of Object.entries(parameters.properties))
        expect(schema.description, `${descriptor.name}.${name}`).toBeTruthy();
    }
  });

  it("C6 W-09: the reminder description matches reminderSchedule at its boundaries", () => {
    const sent = "2026-11-05T01:00:00.000Z";
    expect(reminderSchedule("2026-11-05T10:30", "none", sent, "Asia/Tokyo")).toMatchObject({
      dueAt: "2026-11-05T01:30:00.000Z",
      remindAt: sent,
    });
    expect(reminderSchedule("2026-11-05T13:00", "none", sent, "Asia/Tokyo")).toMatchObject({
      dueAt: "2026-11-05T04:00:00.000Z",
      remindAt: "2026-11-05T03:00:00.000Z",
    });
    expect(reminderSchedule("2026-11-06", "none", sent, "Asia/Tokyo")).toMatchObject({
      dueAt: "2026-11-06T00:00:00.000Z",
      remindAt: "2026-11-06T00:00:00.000Z",
    });
  });

  it("C6 W-05, W-12, W-24: the conversation system prompt carries the new rules once", () => {
    expect(HIMAWARI_IDENTITY).toContain("Himawari 主人的要求");
    expect(HIMAWARI_IDENTITY).not.toContain("owner-rules");
    expect(HIMAWARI_IDENTITY).toContain("系统会在你调用工具时自动发起审批");
    expect(runCapabilityNotice({ coding: true })).not.toContain("一定失败");
    expect(runCapabilityNotice({ coding: false })).not.toContain("首次使用");
  });

  it("C8: text that is not frozen per conversation records that a change recomputes every conversation", () => {
    expect(unfrozenProblems(entries(), readManifest())).toEqual([]);
  });

  it("C8 REVERSE: reports an unfrozen change without the warning and an unlisted legend", () => {
    expect(
      unfrozenProblems(
        [
          fixture("tools.authorized", "tools", "执行一项已经授权的操作。"),
          fixture("chat.egress-legend-new", "system", "占位符说明", [
            "packages/runtime-pi/src/egress-context.ts",
          ]),
        ],
        { "tools.authorized": { sha256: "", changedIn: "ADR 0166", reason: "只改了措辞" } },
      ),
    ).toEqual([
      "PROMPT_UNFROZEN_REASON_MISSING tools.authorized",
      "PROMPT_UNFROZEN_NOT_LISTED chat.egress-legend-new",
    ]);
  });
});
