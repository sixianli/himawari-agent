import { MEMORY_CATEGORY_NAMES, MEMORY_SENSITIVE_TOPICS } from "@himawari-agent/gateway-contracts";

export type MemoryCategory = (typeof MEMORY_CATEGORY_NAMES)[number];
export type MemoryTopic = (typeof MEMORY_SENSITIVE_TOPICS)[number];

export interface ImportCandidate {
  readonly text: string;
  readonly category: MemoryCategory;
  readonly subCategory: string | null;
  readonly topic: MemoryTopic | null;
  readonly sensitive: boolean;
  readonly duplicate: boolean;
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

export interface ImportParse {
  readonly items: readonly ImportCandidate[];
}

const SKIPPED_SECTION =
  /what's in memory|older memory topics|^task \d+|rollout_summary_files|keywords/i;
const MAXIMUM_TEXT = 500;

export const normalizeMemoryText = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
    .replace(/[，。；、,.;!！]+$/, "")
    .toLowerCase();

function isDuplicate(key: string, existing: readonly string[]) {
  return existing.some(
    (known) =>
      known === key ||
      (known.length > 5 && key.includes(known)) ||
      (key.length > 5 && known.includes(key)),
  );
}

export function parseMemoryText(
  name: string,
  text: string,
  existingTexts: readonly string[],
): ImportParse {
  const agents = /agents\.md$/i.test(name);
  const existing = existingTexts.map(normalizeMemoryText);
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
    const duplicate = isDuplicate(key, existing);
    const coding = kind === "project";
    items.push({
      text: line,
      category: coding ? "project" : "other",
      subCategory: coding ? (project || "Codex").slice(0, 32) : null,
      topic: null,
      sensitive: false,
      duplicate,
      coding,
      from: section && section !== "agents" ? `${name} · ${section}` : name,
      checked: false,
      status: duplicate ? "ready" : "classifying",
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

export function parseMemoryExport(
  name: string,
  text: string,
  existingTexts: readonly string[],
): ImportParse {
  const data = JSON.parse(text) as { memories?: unknown };
  if (!Array.isArray(data.memories)) throw new Error("MEMORY_EXPORT_INVALID");
  const existing = existingTexts.map(normalizeMemoryText);
  const items: ImportCandidate[] = [];
  for (const entry of data.memories as Record<string, unknown>[]) {
    const raw = entry?.["text"];
    if (typeof raw !== "string" || entry["status"] !== "active") continue;
    const memoryText = raw.trim().slice(0, MAXIMUM_TEXT);
    if (!memoryText) continue;
    const category = MEMORY_CATEGORY_NAMES.includes(entry["category"] as MemoryCategory)
      ? (entry["category"] as MemoryCategory)
      : "other";
    const sensitive = entry["sensitive"] === true;
    const topic = entry["sensitiveTopic"];
    const sub = entry["subCategory"];
    const duplicate = isDuplicate(normalizeMemoryText(memoryText), existing);
    items.push({
      text: memoryText,
      category,
      subCategory: typeof sub === "string" && sub ? sub.slice(0, 32) : null,
      topic:
        sensitive && MEMORY_SENSITIVE_TOPICS.includes(topic as MemoryTopic)
          ? (topic as MemoryTopic)
          : null,
      sensitive,
      duplicate,
      coding: false,
      from: name,
      checked: !duplicate && !sensitive,
      status: "ready",
    });
  }
  return { items };
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
    if (!result || result.failed)
      return { ...item, sensitive: true, topic: "other", checked: false, status: "unclassified" };
    const sensitive = result.classification === "sensitive";
    return {
      ...item,
      category: item.coding ? item.category : result.category,
      sensitive,
      topic: sensitive ? (result.topic ?? "other") : null,
      checked: !item.duplicate && !sensitive && !item.coding,
      status: "ready",
    };
  });
}
