import { createHash, randomUUID } from "node:crypto";
import {
  ApplicationPortError,
  type ClockPort,
  MEMORY_CATEGORIES,
  type McpConnectionEntry,
  type McpSyncDeleteStatus,
  type McpSyncItemStatus,
  type McpSyncLimits,
  type McpSyncPushDelete,
  type McpSyncPushItem,
  type McpMemorySyncStorePort,
  type McpUsageCounter,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import { normalizeProposalText } from "@himawari-agent/persistence-sqlite";
import { scanMachineSecrets } from "@himawari-agent/sensitive-capture";
import { checkProjectName, checkStableId, type McpSyncTextRefusal } from "./mcp-project-name.js";
import { mcpUsageDay } from "./production-mcp-connections.js";
import {
  EXTERNAL_PROPOSAL_PENDING_CONTENT_PREFIX,
  type ExternalProposalCategory,
  proposalClassification,
} from "./production-mcp-memory-writer.js";

export const MCP_SYNC_CONTENT_PREFIX = "memory-content:mcp-sync:";
export const MCP_SYNC_KIND_NAMES = ["about_owner", "project_note"] as const;
export type McpSyncKindName = (typeof MCP_SYNC_KIND_NAMES)[number];

export const MCP_SYNC_CATEGORIES: readonly ExternalProposalCategory[] = Object.freeze(
  MEMORY_CATEGORIES.filter((category): category is ExternalProposalCategory => category !== "rule"),
);

export const MCP_SYNC_FULL = "MCP_SYNC_FULL";
export const MCP_SYNC_BATCH_TOO_LARGE = "MCP_SYNC_BATCH_TOO_LARGE";
export const MCP_SYNC_REQUEST_INVALID = "MCP_SYNC_REQUEST_INVALID";

const NOTE_HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;
const VERSION_TAG = /^[0-9a-f]{64}$/u;

export function normalizeNoteText(text: string): string {
  return text
    .normalize("NFC")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(NOTE_HIDDEN, (character) =>
      character === "\n" || character === "\t" ? character : " ",
    )
    .replace(/[ \t]+\n/gu, "\n")
    .trim();
}

export type McpSyncInvalidReason =
  | "kind_invalid"
  | "id_invalid"
  | "project_invalid"
  | "text_empty"
  | "text_too_long"
  | "category_unknown"
  | "secret"
  | "duplicate_in_request"
  | "version_tag_invalid"
  | "kind_changed";

export interface McpSyncEntryOutput {
  readonly index: number;
  readonly status: McpSyncItemStatus | "invalid";
  readonly versionTag?: string;
  readonly reason?: McpSyncInvalidReason;
  readonly detail?: McpSyncTextRefusal;
  readonly allowedCategories?: readonly string[];
}

export interface McpSyncDeleteOutput {
  readonly index: number;
  readonly status: McpSyncDeleteStatus | "invalid";
  readonly reason?: McpSyncInvalidReason;
}

export interface McpSyncOutcome {
  readonly entries: readonly McpSyncEntryOutput[];
  readonly deletes: readonly McpSyncDeleteOutput[];
  readonly counts: Readonly<Partial<Record<McpUsageCounter, number>>>;
}

export interface ProductionMcpSyncOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly store: McpMemorySyncStorePort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly timeZone: string;
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const ENTRY_COUNTER: Readonly<Record<McpSyncItemStatus | "invalid", McpUsageCounter>> = {
  pending: "entries_pending",
  saved: "entries_saved",
  unchanged: "entries_unchanged",
  updated: "entries_updated",
  declined_before: "entries_declined",
  owner_deleted: "entries_owner_deleted",
  awaiting_project_approval: "entries_awaiting_approval",
  invalid: "entries_invalid",
};

const DELETE_COUNTER: Readonly<Record<McpSyncDeleteStatus | "invalid", McpUsageCounter>> = {
  deleted: "deletes_applied",
  version_mismatch: "deletes_mismatch",
  awaiting_owner: "deletes_held",
  not_accepted: "deletes_not_accepted",
  invalid: "deletes_invalid",
};

export interface ProjectNotesFound {
  readonly found: boolean;
  readonly notes: readonly {
    readonly project: string;
    readonly source: string;
    readonly id: string;
    readonly category: string;
    readonly text: string;
    readonly updatedAt: string;
  }[];
  readonly more: boolean;
}

const NOTE_SEARCH_POOL = 100;
const NOTE_RESULT_CHARACTERS = 4000;
const ASIAN_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

function queryGrams(query: string): Set<string> {
  const lowered = query.normalize("NFKC").toLowerCase();
  const grams = new Set<string>();
  for (const run of lowered.match(ASIAN_RUN) ?? []) {
    const characters = [...run];
    if (characters.length === 1) grams.add(run);
    for (let index = 0; index + 1 < characters.length; index += 1)
      grams.add(`${characters[index]}${characters[index + 1]}`);
  }
  for (const token of lowered.replace(ASIAN_RUN, " ").split(/[^\p{L}\p{N}]+/u))
    if (token.length > 0) grams.add(token);
  return grams;
}

export class ProductionMcpSync {
  readonly #options: ProductionMcpSyncOptions;

  constructor(options: ProductionMcpSyncOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async limits(): Promise<McpSyncLimits> {
    return this.#options.store.limits(this.#scope());
  }

  async projectNotes(
    input: { readonly project: string; readonly query: string; readonly limit: number },
    ceiling: "public" | "private" | "sensitive",
  ): Promise<ProjectNotesFound> {
    const listed = await this.#options.store.projectNotes({
      ...this.#scope(),
      projectName: input.project,
      maxClassification: ceiling === "public" ? "private" : ceiling,
      limit: NOTE_SEARCH_POOL,
    });
    if (!listed.found || ceiling === "public")
      return { found: listed.found, notes: [], more: false };
    const grams = queryGrams(input.query);
    const scored: { score: number; order: number; note: ProjectNotesFound["notes"][number] }[] = [];
    for (const [order, note] of listed.notes.entries()) {
      const payload = await this.#options.payloads.get(note.contentRef);
      if (!payload || payload.contentType !== "text/plain") continue;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          await this.#options.protector.unprotect({ ...this.#scope(), payload }),
        );
      } catch {
        continue;
      }
      const lowered = text.normalize("NFKC").toLowerCase();
      let score = 0;
      for (const gram of grams) if (lowered.includes(gram)) score += 1;
      if (score === 0) continue;
      const characters = [...text];
      scored.push({
        score,
        order,
        note: {
          project: note.projectName,
          source: note.connectionName,
          id: note.stableId,
          category: note.category,
          text:
            characters.length > NOTE_RESULT_CHARACTERS
              ? characters.slice(0, NOTE_RESULT_CHARACTERS).join("")
              : text,
          updatedAt: note.lastSyncedAt,
        },
      });
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return {
      found: true,
      notes: scored.slice(0, input.limit).map(({ note }) => note),
      more: scored.length > input.limit,
    };
  }

  async sync(
    connection: { readonly id: string; readonly entry: McpConnectionEntry },
    args: unknown,
  ): Promise<McpSyncOutcome> {
    const limits = await this.limits();
    const raw = isRecord(args) ? args : {};
    const entries = raw["entries"] === undefined ? [] : raw["entries"];
    const deletes = raw["deletes"] === undefined ? [] : raw["deletes"];
    if (!Array.isArray(entries) || !Array.isArray(deletes) || entries.length + deletes.length === 0)
      throw new Error(MCP_SYNC_REQUEST_INVALID);
    if (entries.length > limits.batch_entries || deletes.length > limits.batch_deletes)
      throw new Error(MCP_SYNC_BATCH_TOO_LARGE);
    const invalidEntries = new Map<number, McpSyncEntryOutput>();
    const invalidDeletes = new Map<number, McpSyncDeleteOutput>();
    const items: McpSyncPushItem[] = [];
    const seen = new Set<string>();
    const scope = this.#scope();
    const stored: Promise<void>[] = [];
    for (const [index, entry] of entries.entries()) {
      const parsed = this.#parseEntry(index, entry, limits);
      if ("status" in parsed) {
        invalidEntries.set(index, parsed);
        continue;
      }
      const key = JSON.stringify([parsed.projectName, parsed.stableId]);
      if (seen.has(key)) {
        invalidEntries.set(index, { index, status: "invalid", reason: "duplicate_in_request" });
        continue;
      }
      seen.add(key);
      const digest = parsed.digest;
      const syncRef = `${MCP_SYNC_CONTENT_PREFIX}${sha256(
        `${scope.ownerId}\u0000${scope.agentId}\u0000${parsed.classification}\u0000${parsed.kind}\u0000${digest}`,
      )}`;
      const proposalRef =
        parsed.kind === "owner"
          ? `${EXTERNAL_PROPOSAL_PENDING_CONTENT_PREFIX}${sha256(
              `${scope.ownerId}\u0000${scope.agentId}\u0000${parsed.classification}\u0000${digest}`,
            )}`
          : null;
      stored.push(this.#storeText(syncRef, parsed.text, parsed.classification));
      if (proposalRef !== null)
        stored.push(this.#storeText(proposalRef, parsed.text, parsed.classification));
      items.push({
        index,
        projectName: parsed.projectName,
        stableId: parsed.stableId,
        kind: parsed.kind,
        category: parsed.category,
        classification: parsed.classification,
        textSha256: digest,
        contentRef: syncRef,
        proposalContentRef: proposalRef,
        proposalId: `sync-${randomUUID().replaceAll("-", "")}`,
      });
    }
    const pushDeletes: McpSyncPushDelete[] = [];
    const seenDeletes = new Set<string>();
    for (const [index, entry] of deletes.entries()) {
      const parsed = this.#parseDelete(index, entry, limits);
      const key = "status" in parsed ? "" : JSON.stringify([parsed.projectName, parsed.stableId]);
      if ("status" in parsed) invalidDeletes.set(index, parsed);
      else if (seenDeletes.has(key))
        invalidDeletes.set(index, { index, status: "invalid", reason: "duplicate_in_request" });
      else {
        seenDeletes.add(key);
        pushDeletes.push(parsed);
      }
    }
    await Promise.all(stored);
    const now = this.#options.clock.now();
    let result: Awaited<ReturnType<McpMemorySyncStorePort["push"]>>;
    if (items.length === 0 && pushDeletes.length === 0) result = { items: [], deletes: [] };
    else {
      try {
        result = await this.#options.store.push({
          ...scope,
          connectionId: connection.id,
          entry: connection.entry,
          pushPolicy: "ask",
          now,
          day: mcpUsageDay(now, this.#options.timeZone),
          brakePermille: limits.delete_brake_permille,
          items,
          deletes: pushDeletes,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("EXTERNAL_MEMORY_PROPOSAL_PENDING_FULL")
        )
          throw new Error(MCP_SYNC_FULL, { cause: error });
        throw error;
      }
    }
    const itemResults = new Map(result.items.map((item) => [item.index, item]));
    const deleteResults = new Map(result.deletes.map((item) => [item.index, item]));
    const counts: Partial<Record<McpUsageCounter, number>> = {};
    const bump = (counter: McpUsageCounter) => {
      counts[counter] = (counts[counter] ?? 0) + 1;
    };
    const entryOutputs = entries.map((_, index): McpSyncEntryOutput => {
      const invalid = invalidEntries.get(index);
      if (invalid) {
        bump(ENTRY_COUNTER.invalid);
        return invalid;
      }
      const found = itemResults.get(index);
      if (!found) {
        bump(ENTRY_COUNTER.invalid);
        return { index, status: "invalid", reason: "kind_changed" };
      }
      bump(ENTRY_COUNTER[found.status]);
      return { index, status: found.status, versionTag: found.versionTag };
    });
    const deleteOutputs = deletes.map((_, index): McpSyncDeleteOutput => {
      const invalid = invalidDeletes.get(index);
      if (invalid) {
        bump(DELETE_COUNTER.invalid);
        return invalid;
      }
      const found = deleteResults.get(index);
      const status = found?.status ?? "version_mismatch";
      bump(DELETE_COUNTER[status]);
      return { index, status };
    });
    return { entries: entryOutputs, deletes: deleteOutputs, counts };
  }

  #parseEntry(
    index: number,
    entry: unknown,
    limits: McpSyncLimits,
  ):
    | McpSyncEntryOutput
    | {
        readonly projectName: string | null;
        readonly stableId: string;
        readonly kind: "owner" | "project_note";
        readonly category: string;
        readonly classification: "private" | "sensitive";
        readonly text: string;
        readonly digest: string;
      } {
    const invalid = (
      reason: McpSyncInvalidReason,
      extra: Partial<McpSyncEntryOutput> = {},
    ): McpSyncEntryOutput => ({ index, status: "invalid", reason, ...extra });
    if (!isRecord(entry)) return invalid("kind_invalid");
    const kindName = entry["kind"];
    if (kindName !== "about_owner" && kindName !== "project_note") return invalid("kind_invalid");
    const kind = kindName === "about_owner" ? "owner" : "project_note";
    const id = checkStableId(entry["id"], limits.stable_id_chars);
    if (!id.ok) return invalid("id_invalid", { detail: id.reason });
    const project = checkProjectName(entry["project"], limits.project_name_chars);
    if (!project.ok) return invalid("project_invalid", { detail: project.reason });
    const category = entry["category"] === undefined ? "other" : entry["category"];
    if (
      typeof category !== "string" ||
      !(MCP_SYNC_CATEGORIES as readonly string[]).includes(category)
    )
      return invalid("category_unknown", { allowedCategories: MCP_SYNC_CATEGORIES });
    const rawText = entry["text"];
    if (typeof rawText !== "string") return invalid("text_empty");
    const text = kind === "owner" ? normalizeProposalText(rawText) : normalizeNoteText(rawText);
    if (text.length === 0) return invalid("text_empty");
    if ([...text].length > (kind === "owner" ? limits.owner_text_chars : limits.note_text_chars))
      return invalid("text_too_long");
    if (scanMachineSecrets(text).length > 0) return invalid("secret");
    return {
      projectName: project.value,
      stableId: id.value,
      kind,
      category,
      classification: proposalClassification(text, category as ExternalProposalCategory),
      text,
      digest: sha256(text),
    };
  }

  #parseDelete(
    index: number,
    entry: unknown,
    limits: McpSyncLimits,
  ): McpSyncDeleteOutput | McpSyncPushDelete {
    const invalid = (reason: McpSyncInvalidReason): McpSyncDeleteOutput => ({
      index,
      status: "invalid",
      reason,
    });
    if (!isRecord(entry)) return invalid("id_invalid");
    const id = checkStableId(entry["id"], limits.stable_id_chars);
    if (!id.ok) return invalid("id_invalid");
    const project = checkProjectName(entry["project"], limits.project_name_chars);
    if (!project.ok) return invalid("project_invalid");
    const tag = entry["versionTag"];
    if (typeof tag !== "string" || !VERSION_TAG.test(tag)) return invalid("version_tag_invalid");
    return { index, projectName: project.value, stableId: id.value, versionTag: tag };
  }

  async #storeText(
    contentRef: string,
    text: string,
    dataClassification: "private" | "sensitive",
  ): Promise<void> {
    const existing = await this.#options.payloads.get(contentRef);
    if (existing) return;
    try {
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ...this.#scope(),
          ref: contentRef,
          contentType: "text/plain",
          dataClassification,
          plaintext: new TextEncoder().encode(text),
          createdAt: this.#options.clock.now(),
        }),
      );
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
        throw error;
    }
  }
}
