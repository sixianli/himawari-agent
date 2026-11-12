import {
  ApplicationPortError,
  autoCommitThreshold,
  type CaptureGates,
  type DataClassification,
  type DurableMemoryService,
  highestClassification,
  isModelVisible,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryConsolidationAction,
  type MemoryConsolidationChange,
  type MemoryConsolidationStorePort,
  PORT_ERROR_CODES,
  type ProductMemoryRecord,
  type ProductMemoryStatePort,
} from "@himawari-agent/application";
import {
  type AgentId,
  createMemoryId,
  type MemoryGenerationId,
  type MemoryId,
  type OwnerId,
} from "@himawari-agent/domain";
import {
  MEMORY_CONSOLIDATION,
  MEMORY_CONSOLIDATION_FORMAT,
  MEMORY_CONSOLIDATION_FRESH_HEADER,
  MEMORY_CONSOLIDATION_GROUP,
  MEMORY_CONSOLIDATION_QUOTE,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import { localDay } from "./episodes.js";
import { indexTerms } from "./segmentation.js";

export function isConsolidationUndoable(
  change: Pick<MemoryConsolidationChange, "afterRevision" | "undoneAt">,
  memory: Pick<ProductMemoryRecord, "revision"> | undefined,
): boolean {
  return (
    change.undoneAt === null && memory !== undefined && memory.revision === change.afterRevision
  );
}

export const MEMORY_CONSOLIDATION_POLICY_VERSION = "memory-consolidation:v1";
const MAXIMUM_FRESH = 20;
const MAXIMUM_NEIGHBOURS = 3;
const MAXIMUM_INSIGHTS = 3;
const MINIMUM_OVERLAP = 0.5;
const MAXIMUM_QUOTE_CHARACTERS = 300;

function overlap(left: string, right: string): number {
  const a = new Set(indexTerms(left));
  const b = new Set(indexTerms(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export interface MemoryConsolidationHit {
  readonly productMemoryId: MemoryId;
}

export interface MemoryConsolidationServiceOptions {
  readonly store: MemoryConsolidationStorePort;
  readonly state: Pick<ProductMemoryStatePort, "listActive" | "read">;
  readonly memory: Pick<DurableMemoryService, "revise" | "applyProposal">;
  readonly generationFor: (memoryId: MemoryId) => Promise<MemoryGenerationId | undefined>;
  readonly readText: (memory: ProductMemoryRecord) => Promise<string | undefined>;
  readonly readQuote?: (memory: ProductMemoryRecord) => Promise<string | undefined>;
  readonly storeText: (input: {
    readonly key: string;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly text: string;
    readonly dataClassification: DataClassification;
    readonly createdAt: string;
  }) => Promise<string>;
  readonly now: () => string;
  readonly timeZone?: string;
  readonly gates?: CaptureGates;
}

export interface MemoryConsolidationResult {
  readonly id: string;
  readonly modelCalled: boolean;
  readonly changes: readonly MemoryConsolidationChange[];
}

interface Reviewed {
  readonly label: string;
  readonly memory: ProductMemoryRecord;
  readonly text: string;
  readonly quote?: string;
}

interface Group {
  readonly label: string;
  readonly fresh: Reviewed;
  readonly neighbours: readonly Reviewed[];
}

interface Decision {
  readonly group: string;
  readonly action: "duplicate" | "replace" | "conflict";
  readonly keep: string | null;
  readonly drop: string | null;
}

interface Insight {
  readonly text: string;
  readonly category: MemoryCategory;
  readonly basis: readonly string[];
}

export function statedAt(
  memory: Pick<ProductMemoryRecord, "attributes" | "recordedAt" | "updatedAt">,
): string {
  return memory.attributes?.validFrom ?? memory.recordedAt ?? memory.updatedAt;
}

export interface ReplacementClaim {
  readonly statedAt: string;
  readonly confidencePermille: number;
  readonly category: MemoryCategory | null;
}

export function replacesOlder(
  older: Pick<ProductMemoryRecord, "attributes" | "recordedAt" | "updatedAt">,
  newer: ReplacementClaim,
  gates?: CaptureGates,
): boolean {
  return (
    statedAt(older) < newer.statedAt &&
    newer.confidencePermille >= autoCommitThreshold(newer.category, gates)
  );
}

function day(memory: ProductMemoryRecord): string {
  return statedAt(memory).slice(0, 10);
}

export function consolidationPrompt(groups: readonly Group[], fresh: readonly Reviewed[]): string {
  const line = ({ label, memory, text, quote }: Reviewed) =>
    `${label}（${day(memory)}）${text}${quote ? renderPrompt(MEMORY_CONSOLIDATION_QUOTE, { quote }) : ""}`;
  return [
    MEMORY_CONSOLIDATION.text,
    ...groups.flatMap((group) => [
      renderPrompt(MEMORY_CONSOLIDATION_GROUP, { label: group.label }),
      line(group.fresh),
      ...group.neighbours.map(line),
      "",
    ]),
    MEMORY_CONSOLIDATION_FRESH_HEADER.text,
    ...fresh.map(line),
    "",
    MEMORY_CONSOLIDATION_FORMAT.text,
  ].join("\n");
}

function parse(
  output: string,
  groups: ReadonlyMap<string, Group>,
  labels: ReadonlyMap<string, Reviewed>,
): { decisions: Decision[]; insights: Insight[] } {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("MEMORY_CONSOLIDATION_OUTPUT_INVALID");
  const value = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  const decisions: Decision[] = [];
  for (const raw of Array.isArray(value["groups"]) ? value["groups"] : []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const group = typeof item["group"] === "string" ? groups.get(item["group"]) : undefined;
    const action = item["action"];
    if (!group || (action !== "duplicate" && action !== "replace" && action !== "conflict"))
      continue;
    const members = new Set([group.fresh.label, ...group.neighbours.map(({ label }) => label)]);
    const keep = typeof item["keep"] === "string" ? item["keep"] : null;
    const drop = typeof item["drop"] === "string" ? item["drop"] : null;
    if (!keep || !drop || keep === drop || !members.has(keep) || !members.has(drop)) continue;
    if (keep !== group.fresh.label && drop !== group.fresh.label) continue;
    decisions.push({ group: group.label, action, keep, drop });
  }
  const insights: Insight[] = [];
  for (const raw of Array.isArray(value["insights"]) ? value["insights"] : []) {
    if (insights.length >= MAXIMUM_INSIGHTS || !raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = typeof item["text"] === "string" ? item["text"].trim() : "";
    const category = MEMORY_CATEGORIES.includes(item["category"] as MemoryCategory)
      ? (item["category"] as MemoryCategory)
      : "other";
    const basis = [
      ...new Set(
        (Array.isArray(item["basis"]) ? item["basis"] : []).filter(
          (label): label is string => typeof label === "string" && labels.has(label),
        ),
      ),
    ];
    if (
      text.length < 4 ||
      text.length > 200 ||
      basis.length < 2 ||
      ["health", "finance"].includes(category)
    )
      continue;
    insights.push({ text, category, basis });
  }
  return { decisions, insights };
}

export class MemoryConsolidationService {
  readonly #options: MemoryConsolidationServiceOptions;
  #sequence = 0;

  constructor(options: MemoryConsolidationServiceOptions) {
    this.#options = options;
  }

  consolidationId(agentId: AgentId, now = this.#options.now()): string {
    return `memory-consolidation:${agentId}:${localDay(now, this.#options.timeZone)}`;
  }

  async due(ownerId: OwnerId, agentId: AgentId): Promise<boolean> {
    const last = await this.#options.store.lastCompleted(ownerId, agentId);
    return !last || last.day < localDay(this.#options.now(), this.#options.timeZone);
  }

  async run(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly triggerRunId: string;
    readonly search: (
      query: string,
      limit: number,
      dataClassification: DataClassification,
    ) => Promise<readonly MemoryConsolidationHit[]>;
    readonly generate: (prompt: string, dataClassification: DataClassification) => Promise<string>;
  }): Promise<MemoryConsolidationResult | null> {
    const { ownerId, agentId } = input;
    const startedAt = this.#options.now();
    const last = await this.#options.store.lastCompleted(ownerId, agentId);
    const id = this.consolidationId(agentId, startedAt);
    if (
      !(await this.#options.store.begin({
        id,
        ownerId,
        agentId,
        day: localDay(startedAt, this.#options.timeZone),
        triggerRunId: input.triggerRunId,
        status: "running",
        reviewedThrough: null,
        modelCalled: false,
        changeCount: 0,
        errorCode: null,
        startedAt,
        finishedAt: null,
      }))
    )
      return null;
    const changes: MemoryConsolidationChange[] = [];
    let modelCalled = false;
    this.#sequence = 0;
    try {
      const ownChanges = new Map(
        (last ? await this.#options.store.listChanges({ ownerId, agentId, limit: 200 }) : [])
          .filter(({ consolidationId }) => consolidationId === last?.id)
          .map(({ memoryId, afterRevision }) => [memoryId, afterRevision]),
      );
      const active = (await this.#options.state.listActive(ownerId, agentId)).filter(
        (memory) => memory.status === "active",
      );
      const reviewable = active.filter(
        (memory) =>
          isModelVisible(memory.dataClassification) &&
          (memory.attributes?.supersededBy ?? null) === null &&
          memory.attributes?.tentative !== true,
      );
      const byId = new Map(reviewable.map((memory) => [memory.id, memory]));
      const fresh = reviewable
        .filter(
          (memory) =>
            (!last?.reviewedThrough || memory.updatedAt > last.reviewedThrough) &&
            ownChanges.get(memory.id) !== memory.revision,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAXIMUM_FRESH);
      const labels = new Map<string, Reviewed>();
      const labelOf = new Map<MemoryId, Reviewed>();
      const reviewed = async (memory: ProductMemoryRecord) => {
        const known = labelOf.get(memory.id);
        if (known) return known;
        const text = await this.#options.readText(memory).catch(() => undefined);
        if (!text) return undefined;
        const quote = (await this.#options.readQuote?.(memory).catch(() => undefined))
          ?.replace(/\s+/gu, " ")
          .trim()
          .slice(0, MAXIMUM_QUOTE_CHARACTERS);
        const value = {
          label: `M${labels.size + 1}`,
          memory,
          text,
          ...(quote ? { quote } : {}),
        };
        labels.set(value.label, value);
        labelOf.set(memory.id, value);
        return value;
      };
      const groups = new Map<string, Group>();
      const paired = new Set(
        (await this.#options.store.listHeldPairs({ ownerId, agentId })).map((pair) =>
          [...pair].sort().join("\n"),
        ),
      );
      const freshReviewed: Reviewed[] = [];
      for (const memory of fresh) {
        const current = await reviewed(memory);
        if (!current) continue;
        freshReviewed.push(current);
        const neighbours: Reviewed[] = [];
        const subCategory = memory.attributes?.subCategory ?? null;
        const category = memory.attributes?.category ?? null;
        if (subCategory && category) {
          const sameTopic = reviewable
            .filter(
              (other) =>
                other.id !== memory.id &&
                other.attributes?.category === category &&
                other.attributes?.subCategory === subCategory &&
                !paired.has([memory.id, other.id].sort().join("\n")),
            )
            .sort(
              (left, right) =>
                right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
            );
          for (const other of sameTopic) {
            if (neighbours.length >= MAXIMUM_NEIGHBOURS) break;
            const value = await reviewed(other);
            if (!value) continue;
            paired.add([memory.id, other.id].sort().join("\n"));
            neighbours.push(value);
          }
        }
        for (const hit of neighbours.length >= MAXIMUM_NEIGHBOURS
          ? []
          : await input.search(
              current.text,
              MAXIMUM_NEIGHBOURS + 2,
              current.memory.dataClassification,
            )) {
          const neighbour = byId.get(hit.productMemoryId);
          if (!neighbour || neighbour.id === memory.id) continue;
          const pair = [memory.id, neighbour.id].sort().join("\n");
          if (paired.has(pair)) continue;
          const text = await this.#options.readText(neighbour).catch(() => undefined);
          if (!text || overlap(current.text, text) < MINIMUM_OVERLAP) continue;
          const value = await reviewed(neighbour);
          if (!value) continue;
          paired.add(pair);
          neighbours.push(value);
          if (neighbours.length >= MAXIMUM_NEIGHBOURS) break;
        }
        if (neighbours.length > 0) {
          const label = `g${groups.size + 1}`;
          groups.set(label, { label, fresh: current, neighbours });
        }
      }
      if (groups.size > 0 || freshReviewed.length >= 3) {
        modelCalled = true;
        const { decisions, insights } = parse(
          await input.generate(
            consolidationPrompt([...groups.values()], freshReviewed),
            highestClassification("private", [
              ...freshReviewed.map(({ memory }) => memory.dataClassification),
              ...[...groups.values()].flatMap(({ neighbours }) =>
                neighbours.map(({ memory }) => memory.dataClassification),
              ),
            ]),
          ),
          groups,
          labels,
        );
        const touched = new Set<MemoryId>();
        for (const decision of decisions) {
          const keep = labels.get(decision.keep ?? "");
          const drop = labels.get(decision.drop ?? "");
          if (!keep || !drop || touched.has(keep.memory.id) || touched.has(drop.memory.id))
            continue;
          if (decision.action === "duplicate") {
            const change = await this.#revise(id, "merge", drop.memory, keep.memory.id, {
              status: "archived",
            });
            if (!change) continue;
            touched.add(drop.memory.id);
            changes.push(change);
            continue;
          }
          const [older, newer] =
            statedAt(keep.memory) < statedAt(drop.memory) ? [keep, drop] : [drop, keep];
          if (
            decision.action === "replace" &&
            newer === keep &&
            replacesOlder(
              older.memory,
              {
                statedAt: statedAt(newer.memory),
                confidencePermille: newer.memory.confidencePermille,
                category: newer.memory.attributes?.category ?? null,
              },
              this.#options.gates,
            )
          ) {
            const change = await this.#supersede(id, older.memory, newer.memory);
            if (!change) continue;
            touched.add(older.memory.id);
            changes.push(change);
            continue;
          }
          const change = await this.#revise(id, "hold", newer.memory, older.memory.id, {
            attributes: { tentative: true },
          });
          if (!change) continue;
          touched.add(newer.memory.id);
          touched.add(older.memory.id);
          changes.push(change);
        }
        for (const [index, insight] of insights.entries()) {
          const change = await this.#reflect(
            id,
            index,
            insight,
            insight.basis.flatMap((label) => labels.get(label)?.memory ?? []),
          );
          if (change) changes.push(change);
        }
      }
      await this.#options.store.finish({
        id,
        status: "completed",
        reviewedThrough: startedAt,
        modelCalled,
        errorCode: null,
        finishedAt: this.#options.now(),
      });
      return Object.freeze({ id, modelCalled, changes: Object.freeze(changes) });
    } catch (error) {
      await this.#options.store
        .finish({
          id,
          status: "failed",
          reviewedThrough: null,
          modelCalled,
          errorCode: error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN",
          finishedAt: this.#options.now(),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async undo(changeId: string): Promise<MemoryConsolidationChange> {
    const change = await this.#options.store.readChange(changeId);
    if (!change)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Consolidation change not found");
    if (change.undoneAt !== null)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Consolidation change undone");
    const memory = await this.#options.state.read(change.memoryId);
    if (!memory || !isConsolidationUndoable(change, memory))
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "MEMORY_CHANGED_AFTER_CONSOLIDATION",
      );
    const generationId = await this.#options.generationFor(memory.id);
    if (!generationId)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Memory generation not found");
    await this.#options.memory.revise({
      memoryId: memory.id,
      expectedRevision: memory.revision,
      generationId,
      ...(change.action === "supersede"
        ? {
            attributes: {
              supersededBy: change.beforeSupersededBy,
              validTo: change.beforeValidTo,
            },
          }
        : change.action === "hold"
          ? { attributes: { tentative: false } }
          : { status: change.action === "reflect" ? "archived" : "active" }),
    });
    const undoneAt = this.#options.now();
    if (!(await this.#options.store.markUndone({ id: change.id, undoneAt })))
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Consolidation change undone");
    return Object.freeze({ ...change, undoneAt });
  }

  #supersede(id: string, older: ProductMemoryRecord, newer: ProductMemoryRecord) {
    const endedAt = newer.attributes?.validFrom ?? newer.recordedAt ?? newer.updatedAt;
    const validTo = older.attributes?.validTo ?? null;
    return this.#revise(id, "supersede", older, newer.id, {
      attributes: {
        supersededBy: newer.id,
        validTo: validTo !== null && validTo < endedAt ? validTo : endedAt,
      },
    });
  }

  async #revise(
    id: string,
    action: MemoryConsolidationAction,
    memory: ProductMemoryRecord,
    relatedMemoryId: MemoryId | null,
    change: Pick<Parameters<DurableMemoryService["revise"]>[0], "status" | "attributes">,
  ): Promise<MemoryConsolidationChange | undefined> {
    const generationId = await this.#options.generationFor(memory.id);
    if (!generationId) return undefined;
    const changeId = this.#nextChangeId(id);
    const createdAt = this.#options.now();
    let recorded: MemoryConsolidationChange | undefined;
    try {
      await this.#options.memory.revise({
        memoryId: memory.id,
        expectedRevision: memory.revision,
        generationId,
        ...change,
        consolidation: (saved) => {
          recorded = Object.freeze({
            id: changeId,
            consolidationId: id,
            ownerId: memory.ownerId,
            agentId: memory.agentId,
            memoryId: memory.id,
            relatedMemoryId,
            action,
            beforeRevision: memory.revision,
            afterRevision: saved.revision,
            beforeStatus: memory.status,
            beforeSupersededBy: memory.attributes?.supersededBy ?? null,
            beforeValidTo: memory.attributes?.validTo ?? null,
            createdAt,
            undoneAt: null,
          });
          const basisMemoryIds = relatedMemoryId ? [memory.id, relatedMemoryId] : [memory.id];
          return {
            change: recorded,
            basisMemoryIds,
            resultMemoryIds:
              action === "hold" ? [memory.id] : relatedMemoryId ? [relatedMemoryId] : [],
          };
        },
      });
    } catch (error) {
      if (
        error instanceof ApplicationPortError &&
        !(await this.#writeFailedAfterStaging(memory, recorded))
      )
        return undefined;
      throw error;
    }
    return recorded;
  }

  async #writeFailedAfterStaging(
    memory: ProductMemoryRecord,
    staged: MemoryConsolidationChange | undefined,
  ): Promise<boolean> {
    if (!staged) return false;
    return (await this.#options.state.read(memory.id))?.revision === memory.revision;
  }

  async #reflect(
    id: string,
    index: number,
    insight: Insight,
    basis: readonly ProductMemoryRecord[],
  ): Promise<MemoryConsolidationChange | undefined> {
    const [first] = basis;
    if (!first || basis.length < 2) return undefined;
    const generationId = await this.#options.generationFor(first.id);
    if (!generationId) return undefined;
    const createdAt = this.#options.now();
    const dataClassification = highestClassification(
      "public",
      basis.map(({ dataClassification }) => dataClassification),
    );
    const memoryId = createMemoryId(`${id}:insight:${index}`);
    const contentRef = await this.#options.storeText({
      key: memoryId,
      ownerId: first.ownerId,
      agentId: first.agentId,
      text: insight.text,
      dataClassification,
      createdAt,
    });
    const changeId = this.#nextChangeId(id);
    let recorded: MemoryConsolidationChange | undefined;
    await this.#options.memory.applyProposal(
      {
        decision: "create",
        memory: {
          id: memoryId,
          ownerId: first.ownerId,
          agentId: first.agentId,
          contentRef,
          dataClassification,
          sourceThreadId: first.sourceThreadId,
          sourceRefs: [...new Set(basis.flatMap(({ sourceRefs }) => sourceRefs))].sort(),
          inference: true,
          confidencePermille: 600,
          policyVersion: MEMORY_CONSOLIDATION_POLICY_VERSION,
          attributes: {
            category: insight.category,
            importancePermille: 500,
            entities: [],
            validFrom: null,
            validTo: null,
            supersededBy: null,
            evidenceVerified: false,
            tentative: true,
          },
        },
      },
      generationId,
      undefined,
      (saved) => {
        recorded = Object.freeze({
          id: changeId,
          consolidationId: id,
          ownerId: first.ownerId,
          agentId: first.agentId,
          memoryId: saved.id,
          relatedMemoryId: first.id,
          action: "reflect",
          beforeRevision: null,
          afterRevision: saved.revision,
          beforeStatus: null,
          beforeSupersededBy: null,
          beforeValidTo: null,
          createdAt,
          undoneAt: null,
        });
        const basisMemoryIds = basis.map(({ id: memoryId }) => memoryId);
        return {
          change: recorded,
          basisMemoryIds,
          resultMemoryIds: [saved.id],
        };
      },
    );
    return recorded;
  }

  #nextChangeId(consolidationId: string): string {
    this.#sequence += 1;
    return `${consolidationId}:c${this.#sequence}`;
  }
}
