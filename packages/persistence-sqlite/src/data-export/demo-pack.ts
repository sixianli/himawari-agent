import {
  type DemoLocale,
  type DemoMemory,
  demoMemories,
  demoPeople,
  isDemoLocale,
} from "@himawari-agent/domain";
import { canonicalJson, type JsonValue, jsonLines, sha256Hex } from "./canonical.js";
import { type MarkdownMemory, renderMemoryMarkdown } from "./markdown.js";
import { RULES_INDEX_FILE, renderRulesMarkdown } from "./rules.js";
import { DATA_FILES, FORMAT_VERSION, INDEX_FILE, MANIFEST_FILE, SCHEMA_FILES } from "./schemas.js";
import {
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  type PortableCounts,
  type PortableFiles,
  type PortableManifest,
  WITHHELD_PLACEHOLDER,
} from "./types.js";

const encoder = new TextEncoder();
const DAY_MS = 86_400_000;
const POLICY_VERSION = "demo-pack-v1";

export interface DemoPackOptions {
  readonly locale: string;
  readonly migrationSequence: number;
  readonly now: () => string;
}

export const DEMO_PACK_ERROR_CODES = Object.freeze({
  LOCALE_UNSUPPORTED: "DEMO_PACK_LOCALE_UNSUPPORTED",
} as const);

export function demoMemoryId(locale: DemoLocale, key: string): string {
  return `demo-${locale}-memory-${key}`;
}

export function demoPersonId(locale: DemoLocale, key: string): string {
  return `demo-${locale}-person-${key}`;
}

function memoryLine(
  locale: DemoLocale,
  memory: DemoMemory,
  nowMs: number,
  replacementMs: ReadonlyMap<string, number>,
): { readonly line: { readonly [key: string]: JsonValue }; readonly events: number } {
  const at = (daysAgo: number) => new Date(nowMs - daysAgo * DAY_MS).toISOString();
  const text = (value: string) => ({
    text: value,
    classification: "private",
    contentType: "text/plain",
  });
  const latest = memory.updates.at(-1);
  const created = at(memory.daysAgo);
  const replacedAt = memory.replacedBy ? replacementMs.get(memory.replacedBy) : undefined;
  const history = [
    {
      kind: "created",
      content: text(memory.text),
      stance: null,
      quote: null,
      sourceDeleted: false,
      occurredAt: created,
    },
    ...memory.updates.map((update) => ({
      kind: "updated",
      content: text(update.text),
      stance: null,
      quote: null,
      sourceDeleted: false,
      occurredAt: at(update.daysAgo),
    })),
  ];
  return {
    events: history.length,
    line: {
      id: demoMemoryId(locale, memory.key),
      status: memory.replacedBy ? "archived" : "active",
      revision: history.length,
      classification: "private",
      inference: memory.inference,
      confidencePermille: memory.confidencePermille,
      policyVersion: POLICY_VERSION,
      updatedAt: latest ? at(latest.daysAgo) : created,
      recordedAt: created,
      lastUsedAt: null,
      category: memory.category,
      subCategory: null,
      importancePermille: memory.importancePermille,
      validFrom: null,
      validTo: replacedAt === undefined ? null : new Date(replacedAt).toISOString(),
      supersededBy: memory.replacedBy ? demoMemoryId(locale, memory.replacedBy) : null,
      useCount: 0,
      evidenceVerified: false,
      sensitiveTopic: null,
      tentative: memory.tentative,
      stance: null,
      importBatchId: null,
      content: text(latest ? latest.text : memory.text),
      history,
      provenance: [],
      entities: [...memory.entities],
      personIds: memory.people.map((key) => demoPersonId(locale, key)),
      pin: memory.pinned ? { pinned: true, updatedAt: created } : null,
    },
  };
}

export function buildDemoPack(options: DemoPackOptions): {
  readonly files: PortableFiles;
  readonly manifest: PortableManifest;
} {
  if (!isDemoLocale(options.locale))
    throw new DataExportError(
      DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED,
      DEMO_PACK_ERROR_CODES.LOCALE_UNSUPPORTED,
    );
  const locale = options.locale;
  const exportedAt = options.now();
  const nowMs = Date.parse(exportedAt);
  const memories = demoMemories(locale);
  const replacementMs = new Map(
    memories.map((memory) => [memory.key, nowMs - memory.daysAgo * DAY_MS] as const),
  );
  const built = memories.map((memory) => memoryLine(locale, memory, nowMs, replacementMs));
  const memoryLines = built.map(({ line }) => line);
  const peopleLines = demoPeople(locale).map((person) => ({
    id: demoPersonId(locale, person.key),
    name: person.name,
    relation: person.relation,
    reverseRelation: person.reverseRelation,
    mergedInto: null,
    createdAt: new Date(nowMs - 100 * DAY_MS).toISOString(),
    updatedAt: new Date(nowMs - 100 * DAY_MS).toISOString(),
    aliases: [...person.aliases],
  }));

  const files: PortableFiles = new Map();
  const roles = new Map<string, "data" | "schema" | "markdown">();
  const lineCounts = new Map<string, number>();
  const put = (
    path: string,
    role: "data" | "schema" | "markdown",
    content: string,
    lines: number,
  ) => {
    files.set(path, encoder.encode(content));
    roles.set(path, role);
    lineCounts.set(path, lines);
  };
  put(DATA_FILES.memories, "data", jsonLines(memoryLines), memoryLines.length);
  put(DATA_FILES.people, "data", jsonLines(peopleLines), peopleLines.length);
  put(DATA_FILES.importBatches, "data", "", 0);
  put(DATA_FILES.pairedDevices, "data", "", 0);
  put(DATA_FILES.consolidations, "data", "", 0);
  put(DATA_FILES.decisions, "data", "", 0);
  put(DATA_FILES.rules, "data", "", 0);
  put(DATA_FILES.conversationReviews, "data", "", 0);
  put(DATA_FILES.externalProposals, "data", "", 0);
  for (const { path, schema } of SCHEMA_FILES)
    put(path, "schema", `${JSON.stringify(schema, null, 2)}\n`, 0);
  const markdown = renderMemoryMarkdown(memoryLines as unknown as readonly MarkdownMemory[]);
  for (const [path, content] of markdown.files) put(path, "markdown", content, 0);
  put(INDEX_FILE, "markdown", markdown.index, 0);
  put(RULES_INDEX_FILE, "markdown", renderRulesMarkdown([], WITHHELD_PLACEHOLDER), 0);

  const counts: PortableCounts = {
    memories: memoryLines.length,
    memoryHistoryEvents: built.reduce((total, { events }) => total + events, 0),
    people: peopleLines.length,
    importBatches: 0,
    pairedDevices: 0,
    consolidations: 0,
    consolidationChanges: 0,
    decisions: 0,
    decisionSignals: 0,
    conversationReviews: 0,
    conversationReviewChanges: 0,
    markdownMemories: markdown.count,
    sealedOriginals: 0,
    sealedEvidenceRows: 0,
    rules: 0,
    enforcedRules: 0,
    externalProposals: 0,
    ruleHistoryVersions: 0,
  };
  const manifest: PortableManifest = {
    format: FORMAT_VERSION,
    migrationSequence: options.migrationSequence,
    exportedAt,
    egressRuleset: 0,
    files: [...files.keys()].sort().map((path) => ({
      path,
      role: roles.get(path) ?? "data",
      bytes: files.get(path)?.byteLength ?? 0,
      lines: lineCounts.get(path) ?? 0,
      sha256: sha256Hex(files.get(path) ?? new Uint8Array()),
    })),
    counts,
    withheld: { texts: 0, memories: 0, decisions: 0, rules: 0 },
    omitted: [
      {
        what: "对话、消息、决策记录、规则、其他 agent 的提议",
        count: null,
        reason: "示范数据只含记忆和人物，是编出来的，不属于任何真人",
      },
    ],
  };
  files.set(
    MANIFEST_FILE,
    encoder.encode(
      `${JSON.stringify(JSON.parse(canonicalJson(manifest as unknown as JsonValue)), null, 2)}\n`,
    ),
  );
  return { files, manifest };
}
