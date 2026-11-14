import {
  ApplicationPortError,
  type DecisionLedgerPort,
  describeRuleVersion,
  type MemoryBasisChainNode,
  PORT_ERROR_CODES,
  type ProductMemoryRecord,
  parseRuleRef,
} from "@himawari-agent/application";
import type { GatewayV2Query, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";

type ChainSnapshot = Extract<GatewayV2Snapshot, { type: "decision.chain.snapshot" }>;
type ChainPayload = ChainSnapshot["payload"];
type ChainItem = ChainPayload["memories"]["items"][number];
type ChainNode = ChainItem["basis"]["nodes"][number];
type SectionState = ChainPayload["rules"]["state"];
type ReadState = NonNullable<ChainPayload["memories"]["recall"]>;

export const DECISION_CHAIN_MEMORIES_SHOWN = 100;
export const DECISION_CHAIN_BASIS_NODES_SHOWN = 200;
const NODE_TEXT_LIMIT = 500;

export interface DecisionChainMemoryView {
  readonly record: ProductMemoryRecord | undefined;
  readonly item: {
    readonly text: string;
    readonly status: "active" | "archived" | "trashed";
    readonly inference: boolean;
    readonly tentative: boolean;
    readonly supersededBy: string | null;
    readonly sourceThreadId: string | null;
    readonly sourceMessageId: string | null;
    readonly sourceRefs: readonly string[];
    readonly importBatchId: string | null;
    readonly history: readonly { readonly quote: string | null; readonly sourceDeleted: boolean }[];
  } | null;
}

export interface DecisionChainMemoryText {
  readonly text: string | null;
  readonly hidden: boolean;
}

export interface DecisionChainDependencies {
  readonly scope: Pick<Parameters<DecisionLedgerPort["read"]>[0], "ownerId" | "agentId">;
  readonly ledger: Pick<DecisionLedgerPort, "read">;
  readonly readBasisChain: (memoryId: string) => Promise<MemoryBasisChainNode>;
  readonly views: (
    memoryIds: readonly string[],
  ) => Promise<ReadonlyMap<string, DecisionChainMemoryView>>;
  readonly texts: (
    memoryIds: readonly string[],
  ) => Promise<ReadonlyMap<string, DecisionChainMemoryText>>;
  readonly visible: (classification: string) => boolean;
}

export const displayRuleId = (ruleId: string) =>
  [...ruleId]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("");

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function sectionState(
  recordedFields: ReadonlySet<string>,
  field: string,
  values: readonly unknown[],
): SectionState {
  if (!recordedFields.has(field)) return "not_recorded";
  return values.length === 0 ? "none" : "recorded";
}

function readState(recordedFields: ReadonlySet<string>, field: string, value: string): ReadState {
  return recordedFields.has(field) ? (value as ReadState) : "not_recorded";
}

export async function readDecisionChain(
  dependencies: DecisionChainDependencies,
  query: Extract<GatewayV2Query, { type: "decision.chain.read" }>,
): Promise<GatewayV2Snapshot> {
  const { decisionId } = query.payload;
  const found = await dependencies.ledger.read({
    ownerId: dependencies.scope.ownerId,
    agentId: dependencies.scope.agentId,
    decisionId,
  });
  if (!found)
    throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "DECISION_RECORD_NOT_FOUND");
  const { entry } = found;
  const fields: ReadonlySet<string> = new Set(found.inputFields);
  const inputs = entry.inputs;
  const proactive = entry.kind === "proactive";
  const rulesRecorded = proactive || entry.kind === "rule_review" || entry.kind === "web_push";

  const ruleMailCounts = new Map<string, number>();
  for (const hits of [inputs.floorHits, inputs.ruleHits ?? {}])
    for (const refs of Object.values(hits))
      for (const ruleId of new Set(refs.map((ref) => parseRuleRef(ref).ruleId)))
        ruleMailCounts.set(ruleId, (ruleMailCounts.get(ruleId) ?? 0) + 1);
  const ruleViews = rulesRecorded
    ? sortedUnique(inputs.ruleIds).map((ref) =>
        describeRuleVersion(parseRuleRef(ref), found.ruleVersions?.[ref]),
      )
    : [];
  const ruleMemoryIds = sortedUnique(
    ruleViews.flatMap(({ sourceMemoryId }) => (sourceMemoryId ? [sourceMemoryId] : [])),
  );
  const ruleMemoryTexts =
    ruleMemoryIds.length > 0 ? await dependencies.texts(ruleMemoryIds) : new Map();
  const rules: ChainPayload["rules"] = rulesRecorded
    ? {
        state: sectionState(fields, "ruleIds", inputs.ruleIds),
        items: ruleViews.map((view) => {
          const memoryText = view.sourceMemoryId
            ? ruleMemoryTexts.get(view.sourceMemoryId)
            : undefined;
          return {
            ruleId: displayRuleId(view.ruleId),
            revision: view.revision,
            current: view.current,
            kind: view.kind,
            origin: view.origin,
            source: view.source,
            status: view.status,
            changedAt: view.changedAt,
            memory: view.sourceMemoryId
              ? {
                  memoryId: view.sourceMemoryId,
                  state: !memoryText ? "missing" : memoryText.hidden ? "hidden" : "visible",
                  text: memoryText?.text?.slice(0, NODE_TEXT_LIMIT) ?? null,
                }
              : null,
            wording: view.wording
              ? {
                  values: view.wording.values.map((value) => displayRuleId(value).slice(0, 256)),
                  quietHours: view.wording.quietHours.map(({ days, start, end }) => ({
                    days: [...days],
                    start,
                    end,
                  })),
                  amount: view.wording.amount,
                }
              : null,
            tests: view.tests,
            mailCount: ruleMailCounts.get(view.ruleId) ?? 0,
          };
        }),
      }
    : { state: "not_applicable", items: [] };

  const mails: ChainPayload["mails"] = proactive
    ? {
        judged: fields.has("sourceIds") ? new Set(inputs.sourceIds).size : null,
        related: fields.has("relatedByMail")
          ? new Set(Object.values(inputs.relatedByMail).flat()).size
          : null,
        relatedRead: readState(fields, "relatedRead", inputs.relatedRead),
        summaries: fields.has("summaryRead")
          ? {
              count: new Set(inputs.summaryIds ?? []).size,
              read: inputs.summaryRead ?? "off",
            }
          : null,
      }
    : null;

  const memoryIds = sortedUnique([
    ...inputs.memoryIds,
    ...Object.values(inputs.memoryByMail).flat(),
    ...inputs.usedMemoryIds,
    ...inputs.tentativeMemoryIds,
  ]);
  const shownIds = memoryIds.slice(0, DECISION_CHAIN_MEMORIES_SHOWN);
  const used = new Set(inputs.usedMemoryIds);
  const tentative = new Set(inputs.tentativeMemoryIds);
  const views = await dependencies.views(shownIds);

  const secondaryIds = new Set<string>();
  for (const id of shownIds) {
    const superseded = views.get(id)?.item?.supersededBy;
    if (superseded) secondaryIds.add(superseded);
  }

  let nodeBudget = DECISION_CHAIN_BASIS_NODES_SHOWN;
  const bases = new Map<string, { nodes: MemoryBasisChainNode[]; complete: boolean }>();
  for (const id of shownIds) {
    const view = views.get(id);
    if (!view?.record || !view.item) continue;
    if (nodeBudget <= 0) {
      bases.set(id, { nodes: [], complete: false });
      continue;
    }
    try {
      const root = await dependencies.readBasisChain(id);
      if (root.change === null) {
        bases.set(id, { nodes: [], complete: !root.truncated });
        continue;
      }
      const nodes: MemoryBasisChainNode[] = [];
      let complete = !root.truncated;
      const queued = [root];
      for (const node of queued) {
        if (nodeBudget <= 0) {
          complete = false;
          break;
        }
        nodeBudget -= 1;
        nodes.push(node);
        if (node.truncated) complete = false;
        queued.push(...node.basis);
      }
      for (const node of nodes) secondaryIds.add(node.memoryId);
      bases.set(id, { nodes, complete });
    } catch {
      bases.set(id, { nodes: [], complete: false });
    }
  }
  const texts = await dependencies.texts([...secondaryIds].sort());

  const items: ChainItem[] = shownIds.map((id) => {
    const view = views.get(id);
    const record = view?.record;
    const item = view?.item ?? null;
    const base = bases.get(id) ?? { nodes: [], complete: true };
    const nodes: ChainNode[] = base.nodes.map((node) => ({
      memoryId: node.memoryId,
      text: texts.get(node.memoryId)?.text?.slice(0, NODE_TEXT_LIMIT) || null,
      action: node.change?.action ?? null,
      changedAt: node.change?.createdAt ?? null,
      basisMemoryIds: node.basis.map((child) => child.memoryId),
      repeated: node.repeated,
      truncated: node.truncated,
    }));
    if (!record || !item)
      return {
        memoryId: id,
        state: "missing",
        text: null,
        status: null,
        inference: false,
        tentative: tentative.has(id),
        usedByModel: used.has(id),
        changedSinceDecision: false,
        supersededBy: null,
        source: {
          threadId: null,
          messageId: null,
          quote: null,
          refs: [],
          importBatchId: null,
          firstSourceDeleted: false,
        },
        basis: { nodes: [], complete: true },
      };
    const visible = dependencies.visible(record.dataClassification);
    return {
      memoryId: id,
      state: visible ? "visible" : "hidden",
      text: visible ? item.text : null,
      status: item.status,
      inference: item.inference,
      tentative: item.tentative || tentative.has(id),
      usedByModel: used.has(id),
      changedSinceDecision: record.updatedAt > entry.decidedAt,
      supersededBy: item.supersededBy
        ? {
            memoryId: item.supersededBy,
            text: visible ? texts.get(item.supersededBy)?.text || null : null,
          }
        : null,
      source: {
        threadId: item.sourceThreadId,
        messageId: item.sourceMessageId,
        quote: visible ? item.history[0]?.quote || null : null,
        refs: item.sourceRefs,
        importBatchId: item.importBatchId,
        firstSourceDeleted: item.history[0]?.sourceDeleted ?? false,
      },
      basis: {
        nodes: visible ? nodes : nodes.map((node) => ({ ...node, text: null })),
        complete: base.complete,
      },
    };
  });

  const memories: ChainPayload["memories"] = {
    state: sectionState(fields, "memoryIds", memoryIds),
    recall: proactive ? readState(fields, "memoryRecall", inputs.memoryRecall) : null,
    total: memoryIds.length,
    truncated: memoryIds.length > shownIds.length,
    items,
  };
  const inputsState: ChainPayload["inputs"] = fields.size === 0 ? "not_recorded" : "recorded";
  return {
    ...query,
    kind: "snapshot",
    type: "decision.chain.snapshot",
    payload: {
      decisionId,
      decision: {
        kind: entry.kind,
        decidedAt: entry.decidedAt,
        outcome: entry.outcome,
        reasonCode: entry.reasonCode,
        rating: entry.ownerRating,
        ratedAt: entry.ratedAt,
      },
      inputs: inputsState,
      rules,
      mails,
      memories,
    },
  } as GatewayV2Snapshot;
}
