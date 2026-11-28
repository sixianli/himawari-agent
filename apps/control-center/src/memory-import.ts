import {
  MEMORY_CATEGORY_NAMES,
  type MEMORY_SENSITIVE_TOPICS,
} from "@himawari-agent/gateway-contracts";

export type MemoryCategory = (typeof MEMORY_CATEGORY_NAMES)[number];
export type MemoryTopic = (typeof MEMORY_SENSITIVE_TOPICS)[number];

export interface ImportCandidate {
  readonly text: string;
  readonly category: MemoryCategory;
  readonly subCategory: string | null;
  readonly topic: MemoryTopic | null;
  readonly duplicate: boolean;
  readonly duplicateCheck: "pending" | "clear" | "similar" | "unchecked";
  readonly coding: boolean;
  readonly from: string;
  readonly checked: boolean;
  readonly status: "classifying" | "ready" | "unclassified";
}

export interface ImportClassification {
  readonly category: MemoryCategory;
  readonly classification: "private" | "sensitive";
  readonly topic: MemoryTopic | null;
  readonly failed: boolean;
}

export type ImportDuplicateVerdict = "same" | "unsure" | "different" | "skipped";

export interface ImportParse {
  readonly items: readonly ImportCandidate[];
}

const SKIPPED_SECTION =
  /what's in memory|older memory topics|^task \d+|rollout_summary_files|keywords/i;
const MAXIMUM_TEXT = 500;

export const normalizeMemoryText = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

export function parseMemoryText(name: string, text: string): ImportParse {
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
      .slice(0, MAXIMUM_TEXT);
    if (line.length < 2) return;
    const key = normalizeMemoryText(line);
    if (seen.has(key)) return;
    seen.add(key);
    const coding = kind === "project";
    items.push({
      text: line,
      category: coding ? "project" : "other",
      subCategory: coding ? (project || "Codex").slice(0, 32) : null,
      topic: null,
      duplicate: false,
      duplicateCheck: "pending",
      coding,
      from: section && section !== "agents" ? `${name} · ${section}` : name,
      checked: false,
      status: "classifying",
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
  return { items };
}

export function parseMemoryExport(name: string, text: string): ImportParse {
  const data = JSON.parse(text) as { memories?: unknown };
  if (!Array.isArray(data.memories)) throw new Error("MEMORY_EXPORT_INVALID");
  const items: ImportCandidate[] = [];
  for (const entry of data.memories as Record<string, unknown>[]) {
    const raw = entry?.["text"];
    if (typeof raw !== "string" || entry["status"] !== "active") continue;
    const memoryText = raw.trim().slice(0, MAXIMUM_TEXT);
    if (!memoryText) continue;
    const category = MEMORY_CATEGORY_NAMES.includes(entry["category"] as MemoryCategory)
      ? (entry["category"] as MemoryCategory)
      : "other";
    const sub = entry["subCategory"];
    items.push({
      text: memoryText,
      category,
      subCategory: typeof sub === "string" && sub ? sub.slice(0, 32) : null,
      topic: null,
      duplicate: false,
      duplicateCheck: "pending",
      coding: false,
      from: name,
      checked: false,
      status: "ready",
    });
  }
  return { items };
}

export function applyImportDuplicates(
  items: readonly ImportCandidate[],
  verdicts: readonly ImportDuplicateVerdict[],
): readonly ImportCandidate[] {
  return items.map((item, index) => {
    if (item.duplicateCheck !== "pending") return item;
    const verdict = verdicts[index] ?? "skipped";
    const duplicate = verdict === "same";
    const duplicateCheck =
      verdict === "unsure" ? "similar" : verdict === "skipped" ? "unchecked" : "clear";
    return {
      ...item,
      duplicate,
      duplicateCheck,
      checked: item.status === "ready" && !duplicate && duplicateCheck === "clear" && !item.coding,
    };
  });
}

export function applyImportClassifications(
  items: readonly ImportCandidate[],
  results: readonly ImportClassification[],
): readonly ImportCandidate[] {
  let next = 0;
  return items.map((item) => {
    if (item.status !== "classifying") return item;
    const result = results[next];
    next += 1;
    if (!result || result.failed) return { ...item, checked: false, status: "unclassified" };
    return {
      ...item,
      category: item.coding ? item.category : result.category,
      checked: !item.duplicate && item.duplicateCheck === "clear" && !item.coding,
      status: "ready",
    };
  });
}
