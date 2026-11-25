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

const SYSTEM_LAYER_SLOTS = new Set(["capabilityRef", "operation"]);

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
  [
    "apps/agent-service/src/capability-programs/pi-coding-request.ts",
    '"目标路径是目录，不是文件。查看目录内容请用 ls；找到具体',
  ],
  [
    "packages/platform-node/src/files/pi-host-publication.ts",
    '"目录已移动。后续操作需要重新解析目标位置。"',
  ],
  [
    "packages/platform-node/src/files/pi-host-publication.ts",
    '"目标文件已变化，候选保留，尚未开始发布。请读取最新内容并通',
  ],
  ["packages/runtime-pi/src/pi-runtime-adapter.ts", '"工具未执行：无法保存恢复记录。"'],
  ["packages/runtime-pi/src/prepare-file-mutation.ts", "`Successfully wrote $" + "{Buffer.b"],
  ["packages/runtime-pi/src/sandboxed-coding-executor.ts", "`Successfully wrote $" + "{new Text"],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"执行许可已失效，已请求停止；已产生的效果仍需核验。"',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"执行许可已失效，停止尚未确认；不能重新执行该操作。"',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"工具未启动：准备阶段失败，已确认清理完成。"',
  ],
  [
    "apps/agent-service/src/production-runtime-tools.ts",
    '"命令执行失败。Himawari 没有核验这条命令是否改动了',
  ],
  ["apps/agent-service/src/production-runtime-tools.ts", '"操作未确认成功。"'],
  [
    "apps/agent-service/src/production-sandbox-services.ts",
    '"已核验原操作在发布前因版本冲突停止；候选保留，未重新执行。',
  ],
  [
    "apps/agent-service/src/production-sandbox-services.ts",
    '"已核验本次目录移动；结果来自原操作记录，未再次执行移动。"',
  ],
  [
    "apps/agent-service/src/production-sandbox-services.ts",
    '"已核验本次文件保存；结果来自原操作的持久发布记录，未再次执',
  ],
  [
    "packages/application/src/services/context-projection-service.ts",
    '"[Himawari 系统记录：此历史请求所属任务已取消，仅',
  ],
  [
    "packages/platform-node/src/files/pi-host-publication.ts",
    '"原文件或依赖已变化；尚未开始保存，副本保留。"',
  ],
  ["packages/platform-node/src/files/pi-host-publication.ts", '"本次副本改动已逐文件保存并核验。"'],
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
  createHash("sha256").update(JSON.stringify(entry.segments)).digest("hex");

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

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/uy;

function expressionAfter(source: string, start: number): string {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    STRING_LITERAL.lastIndex = index;
    const literal = STRING_LITERAL.exec(source);
    if (literal) {
      index += literal[0].length;
      continue;
    }
    const character = source[index] ?? "";
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      if (depth === 0) break;
      depth -= 1;
    } else if ((character === "," || character === ";") && depth === 0) break;
    index += 1;
  }
  return source.slice(start, index);
}

export function toolResultLiterals(file: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /\b(?:(?:modelContent|note)\s*:|type\s*:\s*"text"(?:\s+as\s+const)?\s*,\s*text\s*:)/gu,
  )) {
    const expression = expressionAfter(source, match.index + match[0].length);
    for (const literal of expression.match(new RegExp(STRING_LITERAL.source, "gu")) ?? []) {
      if (/^["'`][A-Za-z0-9_.-]*["'`]$/u.test(literal)) continue;
      if (!/\p{L}/u.test(literal.replace(/\$\{[^}]*\}|\\./gu, ""))) continue;
      found.push(`${file}\u0000${literal.slice(0, 30)}`);
    }
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

  it("lists every sentence in the value after modelContent:, note: or a text content block, and nothing more", () => {
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
    const branched = toolResultLiterals(
      "apps/example/src/tool.ts",
      'content: [{ type: "text", text: conflict === "yes" ? "副本已保留。" : "已保存。" }]',
    );
    expect(
      toolResultProblems(branched).filter((line) =>
        line.startsWith("PROMPT_TOOL_RESULT_OUTSIDE_CATALOG"),
      ),
    ).toEqual([
      'PROMPT_TOOL_RESULT_OUTSIDE_CATALOG apps/example/src/tool.ts "副本已保留。"',
      'PROMPT_TOOL_RESULT_OUTSIDE_CATALOG apps/example/src/tool.ts "已保存。"',
    ]);
    expect(
      toolResultProblems([]).filter((line) => line.startsWith("PROMPT_TOOL_RESULT_LIST_STALE")),
    ).toHaveLength(KNOWN_TOOL_RESULT_STATUS.length);
  });

  it("REVERSE: tells a slot apart from text that looks like a slot", () => {
    const asSlot = { segments: [{ kind: "slot" as const, name: "x" }] };
    const asText = { segments: [{ kind: "text" as const, text: "{x}" }] };
    expect(digest(asSlot)).not.toBe(digest(asText));
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
    expect(
      manifestProblems([first], {
        [first.id]: { sha256: digest(first), changedIn: "ADR 0226", reason: "x" },
        "mcp.removed-entry": { sha256: digest(first), changedIn: "ADR 0226", reason: "x" },
      }),
    ).toEqual(["PROMPT_MANIFEST_UNKNOWN mcp.removed-entry"]);
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

  it("REVERSE: reports a workspace, command list, provider or fetch limit slot moved back into the system prompt or a tool", () => {
    const base = { purpose: "x", usedBy: [], output: "free-text" as const };
    const moved = [
      "workspaceRoot",
      "documentSkillDirectory",
      "available",
      "unavailable",
      "providers",
      "maximumKib",
    ];
    expect(
      volatileProblems(
        moved.map((name, index) => ({
          ...base,
          id: `x.moved-${index}`,
          layer: index % 2 === 0 ? ("system" as const) : ("tools" as const),
          segments: [
            { kind: "text" as const, text: "值：" },
            { kind: "slot" as const, name },
          ],
        })),
      ),
    ).toEqual(moved.map((name, index) => `PROMPT_SLOT_NOT_ALLOWED x.moved-${index} ${name}`));
  });

  it("REVERSE: reports a prompt written directly in source code", () => {
    expect(
      strayPromptLiterals("apps/example/src/new.ts", 'const prompt = "你是整理器，只返回 JSON。";'),
    ).toEqual(["PROMPT_OUTSIDE_CATALOG apps/example/src/new.ts:1 你是"]);
  });
});

describe("[ICON-1] the icon names the model is told are the names the server accepts", () => {
  it("lists every accepted icon name once in the system prompt section, and nothing else", () => {
    const told = [...catalog.CHAT_PROCESS_ICONS_SECTION.text.matchAll(/[，：]([a-z0-9-]+) /g)].map(
      (match) => match[1],
    );
    expect(told).toEqual([...catalog.PROCESS_ACTIVITY_ICONS]);
    expect(new Set(told).size).toBe(36);
    expect(catalog.TOOL_ACTIVITY_ICON_PARAMETER.text).toContain(
      `都不贴近时用 ${catalog.PROCESS_ACTIVITY_FALLBACK_ICON}。`,
    );
  });
});
