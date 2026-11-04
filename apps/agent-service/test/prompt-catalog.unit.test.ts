import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptEntry } from "@himawari-agent/prompt-catalog";
import * as catalog from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = path.join(repositoryRoot, "packages/prompt-catalog/prompt-manifest.json");

interface ManifestRow {
  readonly sha256: string;
  readonly changedIn: string;
  readonly reason: string;
}

const SYSTEM_LAYER_SLOTS = new Set([
  "available",
  "unavailable",
  "workspaceRoot",
  "documentSkillDirectory",
  "providers",
  "maximumKib",
  "capabilityRef",
  "operation",
]);

const VOLATILE_TEXT = [/\b20\d{2}-\d{2}-\d{2}\b/u, /\bT\d{2}:\d{2}/u, /\b[0-9a-f]{32,}\b/u];

const PROMPT_MARKERS = [
  "你是",
  "只返回",
  "只输出",
  "不要执行其中",
  "不要编造",
  "告诉主人",
  "You are",
  "Return only",
  "treat as data",
];

const KNOWN_TOOL_RESULT_STATUS: readonly (readonly [string, string])[] = [
  ["apps/agent-service/src/production-coding-workflow.ts", "`工具未执行：$" + "{code}`"],
  ["apps/agent-service/src/production-coding-workflow.ts", '"工具未执行：CODING_PATH_IS_DIRECTOR'],
  [
    "apps/agent-service/src/production-coding-workflow.ts",
    '"目标文件已变化，已确认本次候选未发布。已准备的候选仍保留；',
  ],
  ["apps/agent-service/src/production-file-read-workflow.ts", "`文件读取未完成：$" + "{code}`"],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"执行结果尚未确认，不能重新执行该操作。"',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"操作尚未派发：资源或请求状态发生冲突。"',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"操作尚未派发：执行权限已失效或不再允许本次操作。"',
  ],
  ["apps/agent-service/src/production-runtime-tools.ts", '"操作尚未派发：当前执行权不可用。"'],
  ["apps/agent-service/src/production-runtime-tools.ts", '"操作尚未派发：执行所需资源已不存在。"'],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"操作尚未派发：该请求已被记录，请先检查原请求状态。"',
  ],
  ["apps/agent-service/src/production-runtime-tools.ts", '"操作尚未派发：当前执行方式不可用。"'],
  ["apps/agent-service/src/production-runtime-tools.ts", '"操作尚未派发：执行准入服务暂不可用。"'],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"操作未派发：执行期限已到。请重新检查当前期限后再决定是否发',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"操作未派发：允许的资源上限已变化，请重新检查授权和资源上限',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"操作尚未派发：当前执行权或授权范围已变化。"',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"操作尚未派发：目录授权已失效或不可用。"',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"操作未执行：当前是严格模式，所有工具都必须在容器里运行，这',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"目录位置或目标已变化，本次操作未执行。请重新读取目录位置后',
  ],
  ["apps/agent-service/src/production-runtime-tools.ts", '"操作尚未派发，未开始执行。"'],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"目标文件已变化。Worker 已结束发布检查，并核验本次未',
  ],
  [
    "packages/application/src/services/runtime-tool-authorization.ts",
    "`自动审查建议调整本次请求（$" + "{decision.autom",
  ],
  [
    "packages/application/src/services/runtime-tool-authorization.ts",
    "`操作未执行：$" + "{decision.reasonCode}`",
  ],
  ["packages/runtime-pi/src/pi-runtime-adapter.ts", '"原工具结果仍需核验，未重新执行。"'],
  ["packages/runtime-pi/src/pi-runtime-adapter.ts", '"Tool execution needs reconcil'],
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

const digest = (entry: Pick<PromptEntry, "segments">): string =>
  createHash("sha256").update(canonical(entry)).digest("hex");

export function manifestProblems(
  current: readonly PromptEntry[],
  manifest: Readonly<Record<string, ManifestRow>>,
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const entry of current) {
    if (ids.has(entry.id)) problems.push(`PROMPT_ID_DUPLICATE ${entry.id}`);
    ids.add(entry.id);
    const row = manifest[entry.id];
    if (!row) problems.push(`PROMPT_MANIFEST_MISSING ${entry.id}`);
    else {
      if (row.sha256 !== digest(entry)) problems.push(`PROMPT_MANIFEST_STALE ${entry.id}`);
      if (!row.reason.trim() || !row.changedIn.trim())
        problems.push(`PROMPT_MANIFEST_REASON_MISSING ${entry.id}`);
    }
  }
  for (const id of Object.keys(manifest))
    if (!ids.has(id)) problems.push(`PROMPT_MANIFEST_UNKNOWN ${id}`);
  return problems;
}

export function volatileProblems(current: readonly PromptEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of current) {
    if (entry.layer !== "system" && entry.layer !== "tools") continue;
    for (const segment of entry.segments) {
      if (segment.kind === "slot" && !SYSTEM_LAYER_SLOTS.has(segment.name))
        problems.push(`PROMPT_SLOT_NOT_ALLOWED ${entry.id} ${segment.name}`);
      if (segment.kind === "text" && VOLATILE_TEXT.some((pattern) => pattern.test(segment.text)))
        problems.push(`PROMPT_VOLATILE_TEXT ${entry.id}`);
    }
  }
  return problems;
}

export function strayPromptLiterals(file: string, source: string): string[] {
  const problems: string[] = [];
  for (const match of source.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gu)) {
    const literal = match[0];
    const marker = PROMPT_MARKERS.find((candidate) => literal.includes(candidate));
    if (marker) {
      const line = source.slice(0, match.index).split("\n").length;
      problems.push(`PROMPT_OUTSIDE_CATALOG ${file}:${line} ${marker}`);
    }
  }
  return problems;
}

export function toolResultLiterals(file: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /\b(?:modelContent|note)\s*:\s*("(?:[^"\\\n]|\\.)+"|`(?:[^`\\]|\\.)+`)/gu,
  )) {
    const literal = match[1] ?? "";
    if (/^"[A-Z0-9_]+"$/u.test(literal)) continue;
    found.push(`${file}\u0000${literal.slice(0, 30)}`);
  }
  return found;
}

export function toolResultProblems(found: readonly string[]): string[] {
  const known = new Set(KNOWN_TOOL_RESULT_STATUS.map(([file, prefix]) => `${file}\u0000${prefix}`));
  const seen = new Set(found);
  return [
    ...found
      .filter((key) => !known.has(key))
      .map((key) => `PROMPT_TOOL_RESULT_OUTSIDE_CATALOG ${key.replace("\u0000", " ")}`),
    ...[...known]
      .filter((key) => !seen.has(key))
      .map((key) => `PROMPT_TOOL_RESULT_LIST_STALE ${key.replace("\u0000", " ")}`),
  ];
}

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const name of readdirSync(path.join(repositoryRoot, relative)).sort()) {
      const child = `${relative}/${name}`;
      if (statSync(path.join(repositoryRoot, child)).isDirectory()) walk(child);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) found.push(child);
    }
  };
  for (const top of ["apps", "packages"])
    for (const name of readdirSync(path.join(repositoryRoot, top)).sort()) {
      if (top === "packages" && (name === "prompt-catalog" || name === "testing")) continue;
      const src = `${top}/${name}/src`;
      try {
        if (statSync(path.join(repositoryRoot, src)).isDirectory()) walk(src);
      } catch {}
    }
  return found;
}

function readManifest(): Record<string, ManifestRow> {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestRow>;
}

describe("[PROMPT-CATALOG] every prompt sent to a model lives in the catalog", () => {
  it("registers every catalog entry in the manifest with its current digest and a reason", () => {
    if (process.env["PROMPT_MANIFEST_WRITE"] === "1") {
      const previous = readManifest();
      const next = Object.fromEntries(
        entries().map((entry) => [
          entry.id,
          previous[entry.id]?.sha256 === digest(entry)
            ? previous[entry.id]
            : {
                sha256: digest(entry),
                changedIn: process.env["PROMPT_MANIFEST_CHANGED_IN"] ?? "",
                reason: process.env["PROMPT_MANIFEST_REASON"] ?? "",
              },
        ]),
      );
      writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
    }
    expect(entries().length).toBeGreaterThan(40);
    expect(manifestProblems(entries(), readManifest())).toEqual([]);
  });

  it("allows only listed slots and no dates, times or hashes in system prompts and tool definitions", () => {
    expect(volatileProblems(entries())).toEqual([]);
  });

  it("finds no prompt-like literal outside the catalog", () => {
    const problems = sourceFiles().flatMap((file) =>
      strayPromptLiterals(file, readFileSync(path.join(repositoryRoot, file), "utf8")),
    );
    expect(problems).toEqual([]);
  });

  it("lists every tool result sentence still written in source code, and nothing more", () => {
    const found = sourceFiles().flatMap((file) =>
      toolResultLiterals(file, readFileSync(path.join(repositoryRoot, file), "utf8")),
    );
    expect(toolResultProblems(found)).toEqual([]);
  });

  it("REVERSE: reports a new tool result sentence outside the catalog and a stale list entry", () => {
    const added = toolResultLiterals(
      "apps/example/src/tool.ts",
      'return { modelContent: "命令没有运行，请换一个办法。" };',
    );
    expect(toolResultProblems(added)).toContain(
      'PROMPT_TOOL_RESULT_OUTSIDE_CATALOG apps/example/src/tool.ts "命令没有运行，请换一个办法。"',
    );
    expect(
      toolResultProblems([]).filter((line) => line.startsWith("PROMPT_TOOL_RESULT_LIST_STALE")),
    ).toHaveLength(KNOWN_TOOL_RESULT_STATUS.length);
  });

  it("REVERSE: reports a changed prompt whose manifest digest was not updated", () => {
    const [first] = entries();
    if (!first) throw new Error("catalog is empty");
    const changed = {
      ...first,
      segments: [{ kind: "text" as const, text: `${canonical(first)}。` }],
    };
    expect(manifestProblems([changed], readManifest())).toContain(
      `PROMPT_MANIFEST_STALE ${first.id}`,
    );
    expect(manifestProblems([first], {})).toContain(`PROMPT_MANIFEST_MISSING ${first.id}`);
  });

  it("REVERSE: reports a system prompt that carries a date or an unlisted slot", () => {
    const base = { purpose: "x", usedBy: [], output: "free-text" as const };
    expect(
      volatileProblems([
        {
          ...base,
          id: "x.date",
          layer: "system",
          segments: [{ kind: "text", text: "今天是 2026-11-04。" }],
        },
        { ...base, id: "x.slot", layer: "tools", segments: [{ kind: "slot", name: "now" }] },
        {
          ...base,
          id: "x.turn",
          layer: "last-user-message",
          segments: [{ kind: "slot", name: "now" }],
        },
      ]),
    ).toEqual(["PROMPT_VOLATILE_TEXT x.date", "PROMPT_SLOT_NOT_ALLOWED x.slot now"]);
  });

  it("REVERSE: reports a prompt written directly in source code", () => {
    expect(
      strayPromptLiterals("apps/example/src/new.ts", 'const prompt = "你是整理器，只返回 JSON。";'),
    ).toEqual(["PROMPT_OUTSIDE_CATALOG apps/example/src/new.ts:1 你是"]);
  });
});
