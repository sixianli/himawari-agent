import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type ClockPort,
  type DurableMemoryService,
  enforceableOwnerRule,
  foldText,
  type MemoryBookStorePort,
  OWNER_RULE_ID_PREFIX,
  OWNER_RULE_SUMMARY_LIMIT,
  type OwnerRuleReplayResult,
  type OwnerRuleStorePort,
  type RuleReviewOwnerStorePort,
  ownerRuleRecord,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
  parseOwnerRuleParameters,
  RULE_TYPES,
  type RuleRecord,
  RuleTypeError,
  type RuntimeToolDescriptor,
  type RuntimeToolInvocation,
  type StoredOwnerRule,
  type ThreadRepositoryPort,
  validRuleSummary,
  writableRuleType,
} from "@himawari-agent/application";
import { TOOL_RULE_LIST, TOOL_RULE_SET, TOOL_RULE_UNDO } from "@himawari-agent/prompt-catalog";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";

export const RULE_SET_CAPABILITY_REF = "rule.set";
export const RULE_LIST_CAPABILITY_REF = "rule.list";
export const RULE_UNDO_CAPABILITY_REF = "rule.undo";
export const RULE_CAPABILITY_REFS: readonly string[] = [
  RULE_SET_CAPABILITY_REF,
  RULE_LIST_CAPABILITY_REF,
  RULE_UNDO_CAPABILITY_REF,
];

const SOFT_TYPE = "soft";
const RULE_POLICY_VERSION = "owner-rule:v1";
const RULE_IMPORTANCE = 900;
const QUOTE_LIMIT = 500;
const QUOTE_MINIMUM = 4;
const CLAUSE_BREAK = /[\n\r。！？!?；;，,、…：:]+/u;
const OWNER_MESSAGES_CHECKED = 6;
const MESSAGES_SCANNED = 200;
const SET_ARGUMENTS = ["quote", "inferred", "type", "params", "summary"];
const ACTIVE_RULE_LIMIT = 32;
const STANDING_MARKERS = [
  "以后",
  "以後",
  "今后",
  "今後",
  "一律",
  "必须",
  "必需",
  "每次",
  "总是",
  "永远",
  "都要",
  "都得",
  "不许",
  "不要再",
  "必ず",
  "いつも",
  "毎回",
  "常に",
  "always",
  "never",
  "every time",
  "from now on",
  "whenever",
  "must",
].map(foldText);
const ONE_OFF_MARKERS = [
  "这封",
  "这一封",
  "这条",
  "这次",
  "这回",
  "本次",
  "此次",
  "这一次",
  "此邮件",
  "那封",
  "刚才",
  "今天",
  "今晚",
  "この",
  "今回",
  "今日",
  "this one",
  "this time",
  "this email",
  "this mail",
  "this message",
  "today",
  "tonight",
  "再说",
  "再看",
  "再讲",
  "再议",
  "改天",
  "回头",
  "あとで",
  "later",
  "we'll see",
].map(foldText);
const STANDING_STARTS = [
  "从今天起",
  "从今天开始",
  "今天起",
  "今天开始",
  "今日から",
  "今日以降",
  "starting today",
  "from today",
].map(foldText);

type MemoryId = ProductMemoryRecord["id"];
type ThreadId = Parameters<ThreadRepositoryPort["read"]>[2];
type GenerationId = Parameters<DurableMemoryService["archive"]>[1];

export type OwnerRuleErrorCode =
  | "RULE_INPUT_INVALID"
  | "RULE_TYPE_UNKNOWN"
  | "RULE_TYPE_UNTESTED"
  | "RULE_PARAMETERS_INVALID"
  | "RULE_NOT_FOUND"
  | "RULE_MEMORY_NOT_READY"
  | "RULE_LIMIT_REACHED"
  | "RULE_NOT_EXPLICIT"
  | "RULE_UNAVAILABLE";

export class OwnerRuleError extends Error {
  readonly code: OwnerRuleErrorCode;
  readonly detail: string;
  constructor(code: OwnerRuleErrorCode, detail = "") {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export function ownerRuleToolDescriptors(
  types: readonly { readonly id: string; readonly tests: string | null }[] = RULE_TYPES,
): readonly RuntimeToolDescriptor[] {
  const list = {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 64 },
    maxItems: 32,
  };
  return [
    {
      name: "rule_set",
      capabilityRef: RULE_SET_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_RULE_SET.text,
      parameters: {
        type: "object",
        properties: {
          quote: { type: "string", minLength: 1, maxLength: QUOTE_LIMIT },
          inferred: { type: "boolean" },
          type: {
            type: "string",
            enum: [...types.filter(({ tests }) => tests).map(({ id }) => id), SOFT_TYPE],
          },
          params: {
            type: "object",
            properties: {
              senderDomains: list,
              senderAddresses: list,
              phrases: list,
              words: list,
              excludePhrases: list,
            },
            additionalProperties: false,
          },
          summary: { type: "string", minLength: 1, maxLength: OWNER_RULE_SUMMARY_LIMIT },
        },
        required: ["quote", "inferred", "type", "summary"],
        additionalProperties: false,
      },
    },
    {
      name: "rule_list",
      capabilityRef: RULE_LIST_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_RULE_LIST.text,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "rule_undo",
      capabilityRef: RULE_UNDO_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_RULE_UNDO.text,
      parameters: {
        type: "object",
        properties: { ruleId: { type: "string", minLength: 1, maxLength: 64 } },
        required: ["ruleId"],
        additionalProperties: false,
      },
    },
  ];
}

export interface RuleTrial {
  readonly from: string;
  readonly subject: string;
  readonly hit: boolean;
}

export type RuleReplay = OwnerRuleReplayResult;

export interface RuleReceipt {
  readonly status: "active" | "proposed" | "soft";
  readonly ruleId: string | null;
  readonly proposalId: string | null;
  readonly memoryId: string | null;
  readonly type: string;
  readonly summary: string;
  readonly quote: string;
  readonly trials: readonly RuleTrial[];
  readonly replay: RuleReplay | null;
  readonly replayed: boolean;
}

export interface ListedOwnerRule {
  readonly ruleId: string;
  readonly type: string;
  readonly summary: string;
  readonly status: StoredOwnerRule["status"];
  readonly enforced: boolean;
  readonly updatedAt: string;
  readonly revision: number;
  readonly sourceMemoryId: string | null;
}

interface Proposal {
  readonly key: string;
  readonly type: string;
  readonly params: unknown;
  readonly summary: string;
  readonly quote: string;
  readonly threadId: string | null;
  readonly source?: string;
}

export interface RulePreview {
  readonly type: string;
  readonly params: unknown;
  readonly summary: string;
  readonly trials: readonly RuleTrial[];
  readonly replay: RuleReplay | null;
}

export interface ProductionOwnerRuleWriterOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly rules: OwnerRuleStorePort;
  readonly reviews: Pick<RuleReviewOwnerStorePort, "act">;
  readonly memory: Pick<DurableMemoryService, "applyProposal" | "archive" | "recover">;
  readonly memories: Pick<ProductMemoryStatePort, "read">;
  readonly book: Pick<MemoryBookStorePort, "latestGeneration">;
  readonly threads: Pick<ThreadRepositoryPort, "read" | "listMessages">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly replay?: (rule: RuleRecord) => Promise<RuleReplay>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function trialsOf(rule: RuleRecord): readonly RuleTrial[] {
  return rule.examples.map((example) => {
    const text = String(example.facts["text"] ?? "");
    return Object.freeze({
      from: String(example.facts["sender_address"] ?? ""),
      subject: text.split("\n", 1)[0] ?? "",
      hit: example.hit,
    });
  });
}

function containsMarker(clause: string, marker: string): boolean {
  if (!/^[a-z' ]+$/u.test(marker))
    return clause.replace(/\s+/gu, "").includes(marker.replace(/\s+/gu, ""));
  const words = marker.trim().split(/\s+/u).join("\\s+");
  return new RegExp(`(?<![a-z0-9_'])${words}(?![a-z0-9_'])`, "u").test(clause);
}

export function isStandingQuote(quote: string): boolean {
  return foldText(quote)
    .split(CLAUSE_BREAK)
    .map((clause) => clause.replace(/\s+/gu, " ").trim())
    .filter((clause) => clause.length > 0)
    .some((clause) => {
      const rest = STANDING_STARTS.reduce((text, start) => text.replaceAll(start, " | "), clause);
      return (
        STANDING_MARKERS.some((marker) => containsMarker(rest, marker)) &&
        !ONE_OFF_MARKERS.some((marker) => containsMarker(rest, marker))
      );
    });
}

function clausesOf(text: string): readonly string[] {
  return foldText(text)
    .split(CLAUSE_BREAK)
    .map((clause) => clause.replace(/\s+/gu, ""))
    .filter((clause) => clause.length > 0);
}

export function quotesWholeClauses(text: string, quote: string): boolean {
  const wanted = clausesOf(quote);
  return Array.from(wanted.join("")).length >= QUOTE_MINIMUM && saysWholeClauses(text, wanted);
}

function saysWholeClauses(text: string, quote: readonly string[]): boolean {
  const clauses = clausesOf(text);
  for (let start = 0; start + quote.length <= clauses.length; start += 1)
    if (quote.every((clause, index) => clauses[start + index] === clause)) return true;
  return false;
}

function sameRule(parameters: unknown, type: string, params: unknown): boolean {
  const record = (parameters ?? {}) as Record<string, unknown>;
  return record["type"] === type && JSON.stringify(record["params"]) === JSON.stringify(params);
}

function summaryOf(parameters: unknown): { readonly type: string; readonly summary: string } {
  const record = (parameters ?? {}) as Record<string, unknown>;
  return {
    type: typeof record["type"] === "string" ? record["type"] : "",
    summary: typeof record["summary"] === "string" ? record["summary"] : "",
  };
}

export class ProductionOwnerRuleWriter {
  readonly #options: ProductionOwnerRuleWriterOptions;

  constructor(options: ProductionOwnerRuleWriterOptions) {
    this.#options = options;
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async #readText(ref: string): Promise<string | undefined> {
    const payload = await this.#options.payloads.get(ref);
    if (!payload) return undefined;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      await this.#options.protector.unprotect({ ...this.#scope(), payload }),
    );
    if (payload.contentType === "text/plain") return text;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object") {
        const value = (parsed as Record<string, unknown>)["text"];
        if (typeof value === "string") return value;
      }
    } catch {
      return text;
    }
    return undefined;
  }

  async #ownerSaid(threadId: string | null, quote: string): Promise<boolean> {
    if (threadId === null) return false;
    const { ownerId, agentId } = this.#scope();
    const thread = await this.#options.threads.read(ownerId, agentId, threadId as ThreadId);
    if (!thread) return false;
    const messages = await this.#options.threads.listMessages(
      ownerId,
      agentId,
      threadId as ThreadId,
      Math.max(0, thread.messageWatermark - MESSAGES_SCANNED),
      MESSAGES_SCANNED,
    );
    const owners = messages
      .filter(({ role, status }) => role === "owner" && status === "committed")
      .slice(-OWNER_MESSAGES_CHECKED);
    for (const message of owners) {
      const text = await this.#readText(message.contentRef);
      if (text !== undefined && quotesWholeClauses(text, quote)) return true;
    }
    return false;
  }

  async #writeText(ref: string, text: string): Promise<string> {
    const now = this.#options.clock.now();
    if (!(await this.#options.payloads.get(ref)))
      await this.#options.payloads.put(
        await this.#options.protector.protect({
          ...this.#scope(),
          ref,
          contentType: "text/plain",
          dataClassification: classificationWithIdentifiers(text, "private"),
          plaintext: new TextEncoder().encode(text),
          createdAt: now,
        }),
      );
    const payload = await this.#options.payloads.get(ref);
    if (!payload) throw new OwnerRuleError("RULE_UNAVAILABLE");
    return payload.dataClassification;
  }

  async #writeMemory(input: {
    readonly key: string;
    readonly text: string;
    readonly category: "rule" | "preference";
    readonly threadId: string | null;
  }): Promise<MemoryId> {
    const generation: GenerationId | undefined = await this.#options.book.latestGeneration(
      this.#scope(),
    );
    if (!generation) throw new OwnerRuleError("RULE_MEMORY_NOT_READY");
    const memoryId = `memory:rule:${input.key}` as MemoryId;
    const contentRef = `memory-content:rule:${input.key}`;
    if (await this.#options.memories.read(memoryId)) {
      await this.#reviveMemory(memoryId);
      return memoryId;
    }
    const classification = await this.#writeText(contentRef, input.text);
    await this.#options.memory.applyProposal(
      {
        decision: "create",
        memory: {
          id: memoryId,
          ...this.#scope(),
          contentRef,
          dataClassification: classification as ProductMemoryRecord["dataClassification"],
          sourceThreadId: input.threadId as ProductMemoryRecord["sourceThreadId"],
          sourceRefs: [contentRef],
          inference: false,
          confidencePermille: 1000,
          policyVersion: RULE_POLICY_VERSION,
          attributes: {
            category: input.category,
            importancePermille: RULE_IMPORTANCE,
            entities: [],
            validFrom: null,
            validTo: null,
            supersededBy: null,
            evidenceVerified: false,
          },
        },
      },
      generation,
    );
    return memoryId;
  }

  #draft(type: string, params: unknown, summary: string): RuleRecord {
    try {
      writableRuleType(type);
      return ownerRuleRecord({
        ruleId: `${OWNER_RULE_ID_PREFIX}draft`,
        revision: 1,
        status: "active",
        source: "draft",
        parameters: { type, params, summary },
      });
    } catch (error) {
      if (error instanceof RuleTypeError)
        throw new OwnerRuleError(
          error.code === "RULE_ID_INVALID" ? "RULE_INPUT_INVALID" : error.code,
          error.message,
        );
      throw error;
    }
  }

  async #replay(rule: RuleRecord): Promise<RuleReplay | null> {
    if (!this.#options.replay) return null;
    try {
      return await this.#options.replay(rule);
    } catch {
      return null;
    }
  }

  async #activate(proposal: Proposal, replayed: RuleReplay | null): Promise<RuleReceipt> {
    const draft = this.#draft(proposal.type, proposal.params, proposal.summary);
    const parsed = parseOwnerRuleParameters({
      type: proposal.type,
      params: proposal.params,
      summary: proposal.summary,
    });
    const ruleId = `${OWNER_RULE_ID_PREFIX}${hash(proposal.key).slice(0, 24)}`;
    const existing = await this.#options.rules.list({ ...this.#scope(), includeRetired: false });
    const same = existing.find(
      (row) => row.ruleId !== ruleId && sameRule(row.parameters, parsed.type, parsed.params),
    );
    if (same) {
      await this.reconfirm(same.ruleId);
      return Object.freeze({
        status: "active",
        ruleId: same.ruleId,
        proposalId: null,
        memoryId: same.sourceMemoryId,
        type: parsed.type,
        summary: summaryOf(same.parameters).summary,
        quote: proposal.quote,
        trials: trialsOf(draft),
        replay: replayed,
        replayed: true,
      });
    }
    if (!existing.some((row) => row.ruleId === ruleId) && existing.length >= ACTIVE_RULE_LIMIT)
      throw new OwnerRuleError("RULE_LIMIT_REACHED", String(ACTIVE_RULE_LIMIT));
    const prior = await this.#options.rules.read({ ...this.#scope(), ruleId });
    if (prior?.sourceMemoryId) await this.#reviveMemory(prior.sourceMemoryId as MemoryId);
    const memoryId = await this.#writeMemory({
      key: proposal.key,
      text: `${proposal.quote}\n${parsed.summary}`,
      category: "rule",
      threadId: proposal.threadId,
    });
    const outcome = await this.#options.rules
      .create({
        ...this.#scope(),
        ruleId,
        parameters: { type: parsed.type, params: parsed.params, summary: parsed.summary },
        source: (proposal.source ?? `chat:${proposal.threadId ?? "none"}`).slice(0, 256),
        sourceMemoryId: memoryId,
        now: this.#options.clock.now(),
      })
      .catch(async (error: unknown) => {
        await this.#archiveMemory(memoryId);
        throw error;
      });
    const stored =
      outcome === "replayed"
        ? await this.#options.rules.read({ ...this.#scope(), ruleId })
        : undefined;
    if (stored && stored.status !== "active") {
      const revived = await this.#options.rules.setStatus({
        ...this.#scope(),
        ruleId,
        status: "active",
        expectedRevision: stored.revision,
        reason: "owner_confirmed",
        now: this.#options.clock.now(),
      });
      if (!revived) {
        await this.#archiveMemory(memoryId);
        throw new OwnerRuleError("RULE_UNAVAILABLE");
      }
    }
    return Object.freeze({
      status: "active",
      ruleId,
      proposalId: null,
      memoryId,
      type: parsed.type,
      summary: parsed.summary,
      quote: proposal.quote,
      trials: trialsOf(draft),
      replay: replayed,
      replayed: outcome === "replayed",
    });
  }

  async preview(input: {
    readonly type: string;
    readonly params: unknown;
    readonly summary: string;
  }): Promise<RulePreview> {
    const draft = this.#draft(input.type, input.params, input.summary);
    const parsed = parseOwnerRuleParameters({
      type: input.type,
      params: input.params,
      summary: input.summary.trim(),
    });
    return Object.freeze({
      type: parsed.type,
      params: parsed.params,
      summary: parsed.summary,
      trials: trialsOf(draft),
      replay: await this.#replay(draft),
    });
  }

  async create(input: {
    readonly key: string;
    readonly quote: string;
    readonly inferred: boolean;
    readonly type: string;
    readonly params: unknown;
    readonly summary: string;
    readonly threadId: string | null;
    readonly source?: string;
  }): Promise<RuleReceipt> {
    const quote = input.quote.trim();
    const summary = input.summary.trim();
    if (quote.length === 0 || quote.length > QUOTE_LIMIT || /\p{Surrogate}/u.test(quote))
      throw new OwnerRuleError("RULE_INPUT_INVALID", "quote");
    if (input.type === SOFT_TYPE) {
      if (!validRuleSummary(summary)) throw new OwnerRuleError("RULE_INPUT_INVALID", "summary");
      if (input.inferred || !(await this.#ownerSaid(input.threadId, quote)))
        throw new OwnerRuleError("RULE_NOT_EXPLICIT", "偏好只记主人的原话");
      const memoryId = await this.#writeMemory({
        key: input.key,
        text: `${quote}\n${summary}`,
        category: "preference",
        threadId: input.threadId,
      });
      return Object.freeze({
        status: "soft",
        ruleId: null,
        proposalId: null,
        memoryId,
        type: SOFT_TYPE,
        summary,
        quote,
        trials: [],
        replay: null,
        replayed: false,
      });
    }
    const draft = this.#draft(input.type, input.params, input.summary);
    const replayed = await this.#replay(draft);
    const proposal: Proposal = {
      key: input.key,
      type: input.type,
      params: input.params ?? {},
      summary,
      quote,
      threadId: input.threadId,
      ...(input.source === undefined ? {} : { source: input.source }),
    };
    const explicit =
      !input.inferred && isStandingQuote(quote) && (await this.#ownerSaid(input.threadId, quote));
    if (explicit) return this.#activate(proposal, replayed);
    const normalized = parseOwnerRuleParameters({
      type: input.type,
      params: input.params,
      summary,
    });
    const proposalId = `rule-proposal:${hash(
      JSON.stringify([
        this.#scope().ownerId,
        normalized.type,
        normalized.params,
        normalized.summary,
        quote,
      ]),
    ).slice(0, 32)}`;
    await this.#writeText(proposalId, JSON.stringify(proposal));
    return Object.freeze({
      status: "proposed",
      ruleId: null,
      proposalId,
      memoryId: null,
      type: input.type,
      summary,
      quote,
      trials: trialsOf(draft),
      replay: replayed,
      replayed: false,
    });
  }

  async confirm(proposalId: string): Promise<RuleReceipt> {
    if (!/^rule-proposal:[0-9a-f]{32}$/u.test(proposalId))
      throw new OwnerRuleError("RULE_NOT_FOUND");
    const text = await this.#readText(proposalId);
    if (text === undefined) throw new OwnerRuleError("RULE_NOT_FOUND");
    const proposal = JSON.parse(text) as Proposal;
    return this.#activate(proposal, null);
  }

  async storedFor(key: string): Promise<boolean> {
    const ruleId = `${OWNER_RULE_ID_PREFIX}${hash(key).slice(0, 24)}`;
    return (await this.#options.rules.read({ ...this.#scope(), ruleId })) !== undefined;
  }

  async list(): Promise<readonly ListedOwnerRule[]> {
    const rows = await this.#options.rules.list({ ...this.#scope(), includeRetired: false });
    return rows.map((row) => {
      const { type, summary } = summaryOf(row.parameters);
      return Object.freeze({
        ruleId: row.ruleId,
        type,
        summary,
        status: row.status,
        enforced: enforceableOwnerRule(row) !== undefined,
        updatedAt: row.updatedAt,
        revision: row.revision,
        sourceMemoryId: row.sourceMemoryId,
      });
    });
  }

  async reconfirm(ruleId: string): Promise<ListedOwnerRule> {
    if (!ruleId.startsWith(OWNER_RULE_ID_PREFIX) || ruleId.length > 64)
      throw new OwnerRuleError("RULE_NOT_FOUND");
    const current = await this.#options.rules.read({ ...this.#scope(), ruleId });
    if (!current || current.status === "retired") throw new OwnerRuleError("RULE_NOT_FOUND");
    if (enforceableOwnerRule({ ...current, status: "active" }) === undefined)
      throw new OwnerRuleError("RULE_UNAVAILABLE");
    const revivedMemory = current.sourceMemoryId
      ? await this.#reviveMemory(current.sourceMemoryId as MemoryId)
      : false;
    const latest = revivedMemory
      ? await this.#options.rules.read({ ...this.#scope(), ruleId })
      : current;
    const restored =
      latest && latest.status !== "active" && latest.status !== "retired"
        ? await this.#options.reviews.act({
            ...this.#scope(),
            ruleId,
            expectedRevision: latest.revision,
            action: "restore",
            now: this.#options.clock.now(),
          })
        : latest?.status === "active";
    const changed = restored
      ? await this.#options.rules.read({ ...this.#scope(), ruleId })
      : undefined;
    if (!changed || changed.status !== "active") {
      if (revivedMemory) await this.#archiveMemory(current.sourceMemoryId as MemoryId);
      throw new OwnerRuleError("RULE_UNAVAILABLE");
    }
    const { type, summary } = summaryOf(changed.parameters);
    return Object.freeze({
      ruleId,
      type,
      summary,
      status: changed.status,
      enforced: true,
      updatedAt: changed.updatedAt,
      revision: changed.revision,
      sourceMemoryId: changed.sourceMemoryId,
    });
  }

  async #reviveMemory(memoryId: MemoryId): Promise<boolean> {
    const record = await this.#options.memories.read(memoryId);
    if (record?.status === "active") return false;
    if (record?.status !== "archived" && record?.status !== "trashed")
      throw new OwnerRuleError("RULE_UNAVAILABLE", "这条规则的出处记忆已删除，请重新说一遍");
    const generation = await this.#options.book.latestGeneration(this.#scope());
    if (!generation) throw new OwnerRuleError("RULE_MEMORY_NOT_READY");
    await this.#options.memory.recover(memoryId, generation);
    return true;
  }

  async #archiveMemory(memoryId: MemoryId): Promise<void> {
    const generation = await this.#options.book.latestGeneration(this.#scope());
    if (!generation) throw new OwnerRuleError("RULE_MEMORY_NOT_READY");
    try {
      await this.#options.memory.archive(memoryId, generation);
    } catch (error) {
      if (
        error instanceof ApplicationPortError &&
        (error.code === PORT_ERROR_CODES.INVALID_OPERATION ||
          error.code === PORT_ERROR_CODES.NOT_FOUND)
      )
        return;
      throw new OwnerRuleError("RULE_UNAVAILABLE", "规则记忆没能归档，请再撤销一次");
    }
  }

  async undo(ruleId: string): Promise<ListedOwnerRule> {
    if (!ruleId.startsWith(OWNER_RULE_ID_PREFIX) || ruleId.length > 64)
      throw new OwnerRuleError("RULE_NOT_FOUND");
    const current = await this.#options.rules.read({ ...this.#scope(), ruleId });
    if (!current) throw new OwnerRuleError("RULE_NOT_FOUND");
    const { type, summary } = summaryOf(current.parameters);
    if (current.sourceMemoryId) await this.#archiveMemory(current.sourceMemoryId as MemoryId);
    const latest = await this.#options.rules.read({ ...this.#scope(), ruleId });
    if (!latest) throw new OwnerRuleError("RULE_UNAVAILABLE");
    if (latest.status !== "retired") {
      const changed = await this.#options.rules.setStatus({
        ...this.#scope(),
        ruleId,
        status: "retired",
        expectedRevision: latest.revision,
        reason: "owner_undo",
        now: this.#options.clock.now(),
      });
      if (!changed) throw new OwnerRuleError("RULE_UNAVAILABLE");
    }
    return Object.freeze({
      ruleId,
      type,
      summary,
      status: "retired",
      enforced: false,
      updatedAt: this.#options.clock.now(),
      revision: latest.revision,
      sourceMemoryId: latest.sourceMemoryId,
    });
  }
}

const modelVisibleRule = ({
  revision: _revision,
  sourceMemoryId: _sourceMemoryId,
  ...rule
}: ListedOwnerRule) => rule;

export class ProductionOwnerRuleTools {
  readonly #writer: Pick<ProductionOwnerRuleWriter, "create" | "list" | "undo">;

  constructor(writer: Pick<ProductionOwnerRuleWriter, "create" | "list" | "undo">) {
    this.#writer = writer;
  }

  async run(invocation: RuntimeToolInvocation): Promise<unknown> {
    const args = invocation.arguments;
    const names = Object.keys(args);
    if (invocation.capabilityRef === RULE_LIST_CAPABILITY_REF) {
      if (names.length > 0) throw new OwnerRuleError("RULE_INPUT_INVALID");
      return { rules: (await this.#writer.list()).map(modelVisibleRule) };
    }
    if (invocation.capabilityRef === RULE_UNDO_CAPABILITY_REF) {
      const ruleId = args["ruleId"];
      if (typeof ruleId !== "string" || names.some((name) => name !== "ruleId"))
        throw new OwnerRuleError("RULE_INPUT_INVALID");
      return { undone: modelVisibleRule(await this.#writer.undo(ruleId)) };
    }
    if (invocation.capabilityRef !== RULE_SET_CAPABILITY_REF)
      throw new OwnerRuleError("RULE_INPUT_INVALID");
    const { quote, inferred, type, params, summary } = args;
    if (
      typeof quote !== "string" ||
      typeof inferred !== "boolean" ||
      typeof type !== "string" ||
      typeof summary !== "string" ||
      names.some((name) => !SET_ARGUMENTS.includes(name))
    )
      throw new OwnerRuleError("RULE_INPUT_INVALID");
    return this.#writer.create({
      key: hash(`${invocation.runId}\n${invocation.toolCallId}`).slice(0, 32),
      quote,
      inferred,
      type,
      params,
      summary,
      threadId: invocation.context?.threadId ?? null,
    });
  }
}
