import {
  MEMORY_CATEGORY_NAMES,
  MEMORY_IMPORT_PREVIEW_FILE_NAME_MAXIMUM,
  type MEMORY_IMPORT_PREVIEW_FILE_STATES,
  type MEMORY_IMPORT_PREVIEW_FLAGS,
  MEMORY_IMPORT_PREVIEW_ITEMS_MAXIMUM,
  type MEMORY_IMPORT_SOURCE_NAMES,
  MEMORY_SENSITIVE_TOPICS,
} from "@himawari-agent/gateway-contracts";

export type ImportSource = (typeof MEMORY_IMPORT_SOURCE_NAMES)[number];
export type ImportCategory = (typeof MEMORY_CATEGORY_NAMES)[number];
export type ImportTopic = (typeof MEMORY_SENSITIVE_TOPICS)[number];
export type ImportFileState = (typeof MEMORY_IMPORT_PREVIEW_FILE_STATES)[number];
export type ImportFlag = (typeof MEMORY_IMPORT_PREVIEW_FLAGS)[number];

export const IMPORT_TEXT_MAXIMUM = 500;
const FROM_SECTION_MAXIMUM = 200;

export interface ImportCandidate {
  readonly text: string;
  readonly from: string;
  readonly category: ImportCategory;
  readonly subCategory: string | null;
  readonly topic: ImportTopic | null;
  readonly sensitive: boolean;
  readonly coding: boolean;
  readonly classified: boolean;
}

export interface ImportFileParse {
  readonly state: ImportFileState;
  readonly items: readonly ImportCandidate[];
}

const SKIPPED_SECTION =
  /what's in memory|older memory topics|^task \d+|rollout_summary_files|keywords/i;

export const normalizeImportText = (text: string): string =>
  text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

function fromLabel(name: string, section: string): string {
  const file = name.slice(0, MEMORY_IMPORT_PREVIEW_FILE_NAME_MAXIMUM);
  return section ? `${file} · ${section.slice(0, FROM_SECTION_MAXIMUM - 3)}` : file;
}

export function parseMemoryText(name: string, text: string): readonly ImportCandidate[] {
  const agents = /agents\.md$/i.test(name);
  const seen = new Set<string>();
  const items: ImportCandidate[] = [];
  let section = agents ? "agents" : "";
  let project = "";
  let skipLevel = 0;
  const add = (raw: string, kind: "fact" | "rule" | "project") => {
    const line = raw
      .replace(/\s*\[Task \d+\]\s*/gi, "")
      .replace(/^[-*]\s+/, "")
      .trim()
      .slice(0, IMPORT_TEXT_MAXIMUM);
    if (line.length < 2) return;
    const key = normalizeImportText(line);
    if (seen.has(key)) return;
    seen.add(key);
    const coding = kind === "project";
    items.push({
      text: line,
      from: fromLabel(name, section && section !== "agents" ? section : ""),
      category: coding ? "project" : "other",
      subCategory: coding ? (project || "Codex").slice(0, 32) : null,
      topic: null,
      sensitive: false,
      coding,
      classified: false,
    });
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "v1") continue;
    const group = /^#\s+Task Group:\s*(.+)$/i.exec(line);
    if (group) {
      project = group[1]?.trim() ?? "";
      section = "skip";
      skipLevel = 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      if (skipLevel && level > skipLevel) continue;
      const title = heading[2]?.trim() ?? "";
      const skipped = SKIPPED_SECTION.test(title);
      skipLevel = skipped ? level : 0;
      section = agents ? "agents" : skipped ? "skip" : title;
      continue;
    }
    if (/^(scope|applies_to|desc|learnings):/i.test(line)) continue;
    const current = section.toLowerCase();
    if (current === "skip" || SKIPPED_SECTION.test(current)) continue;
    if (/user profile/.test(current)) {
      for (const part of line.split(/[。；;]|\.\s/)) add(part, "fact");
    } else if (/user preferences/.test(current) || current === "agents") {
      if (/^[-*]\s+/.test(line)) add(line, "rule");
    } else if (/general tips|reusable knowledge|failures/.test(current)) {
      if (/^[-*]\s+/.test(line)) add(line, "project");
    } else add(line, "fact");
  }
  return items;
}

export function parseMemoryExport(name: string, text: string): readonly ImportCandidate[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const memories = (data as { memories?: unknown } | null)?.memories;
  if (!Array.isArray(memories)) return null;
  const items: ImportCandidate[] = [];
  for (const entry of memories as Record<string, unknown>[]) {
    const raw = entry?.["text"];
    if (typeof raw !== "string" || entry["status"] !== "active") continue;
    const memoryText = raw.trim().slice(0, IMPORT_TEXT_MAXIMUM);
    if (!memoryText) continue;
    const category = MEMORY_CATEGORY_NAMES.includes(entry["category"] as ImportCategory)
      ? (entry["category"] as ImportCategory)
      : "other";
    const sensitive = entry["sensitive"] === true;
    const topic = entry["sensitiveTopic"];
    const sub = entry["subCategory"];
    items.push({
      text: memoryText,
      from: fromLabel(name, ""),
      category,
      subCategory: typeof sub === "string" && sub ? sub.slice(0, 32) : null,
      topic:
        sensitive && MEMORY_SENSITIVE_TOPICS.includes(topic as ImportTopic)
          ? (topic as ImportTopic)
          : null,
      sensitive,
      coding: false,
      classified: true,
    });
  }
  return items;
}

export function parseImportFile(source: ImportSource, name: string, text: string): ImportFileParse {
  const items = source === "himawari" ? parseMemoryExport(name, text) : parseMemoryText(name, text);
  if (items === null) return { state: "unreadable", items: [] };
  return { state: items.length ? "read" : "empty", items };
}

export function capImportCandidates(files: readonly ImportFileParse[]): readonly ImportCandidate[] {
  const seen = new Set<string>();
  const kept: ImportCandidate[] = [];
  for (const file of files)
    for (const item of file.items) {
      if (kept.length >= MEMORY_IMPORT_PREVIEW_ITEMS_MAXIMUM) return kept;
      const key = normalizeImportText(item.text);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(item);
    }
  return kept;
}

export type ImportDuplicateVerdict = "same" | "unsure" | "different" | "skipped";

export function importFlag(input: {
  readonly secret: boolean;
  readonly classificationFailed: boolean;
  readonly coding: boolean;
  readonly duplicate: ImportDuplicateVerdict;
}): ImportFlag | null {
  if (input.secret) return "secret";
  if (input.duplicate === "same") return "duplicate";
  if (input.classificationFailed) return "unclassified";
  if (input.duplicate === "unsure") return "similar";
  if (input.duplicate === "skipped") return "unchecked";
  if (input.coding) return "coding";
  return null;
}

export const importFlagSelectable = (flag: ImportFlag | null): boolean => flag !== "duplicate";
