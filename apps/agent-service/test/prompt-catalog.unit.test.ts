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
      if (top === "packages" && name === "prompt-catalog") continue;
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

  it("keeps changing values out of system prompts and tool definitions", () => {
    expect(volatileProblems(entries())).toEqual([]);
  });

  it("finds no prompt-like literal outside the catalog", () => {
    const problems = sourceFiles().flatMap((file) =>
      strayPromptLiterals(file, readFileSync(path.join(repositoryRoot, file), "utf8")),
    );
    expect(problems).toEqual([]);
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
