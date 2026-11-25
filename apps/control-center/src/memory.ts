import type { GatewayV2Command, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import type { ImportCandidate, ImportDuplicateVerdict, MemoryCategory } from "./memory-import.js";
import { commandMessage, queryMessage } from "./messages.js";
import { setApprovalAllowanceDays } from "./run-approval.js";

export type MemoryOverview = Extract<
  GatewayV2Snapshot,
  { type: "memory.overview.snapshot" }
>["payload"];
export type MemoryItem = MemoryOverview["memories"][number];
export type PendingMemory = MemoryOverview["pending"][number];
export type MemoryTidyUp = MemoryOverview["tidyUps"][number];
export type MemoryConversationReview = MemoryOverview["conversationReviews"][number];
export type MemoryReminder = MemoryOverview["reminders"][number];
export type MemoryImportSource = MemoryOverview["imports"][number]["source"];
export type ExternalProposal = MemoryOverview["externalProposals"]["items"][number];
export interface ExternalDecision {
  readonly proposalId: string;
  readonly decision: "keep" | "reject";
  readonly editedText: string | null;
}
export type OwnerRule = Extract<
  GatewayV2Snapshot,
  { type: "memory.rules.snapshot" }
>["payload"]["rules"][number];
export type PendingProposals = Extract<
  GatewayV2Snapshot,
  { type: "proposals.snapshot" }
>["payload"];
export type PendingProposal = PendingProposals["proposals"][number];
export type ProposalAction = "adopt" | "reject";
export type BuiltInActionRule = Extract<
  GatewayV2Snapshot,
  { type: "memory.rules.snapshot" }
>["payload"]["builtIn"][number];
export type OwnerAllowance = Extract<
  GatewayV2Snapshot,
  { type: "memory.rules.snapshot" }
>["payload"]["allowances"][number];
export type OwnerRuleAction = "undo" | "confirm" | "reconfirm" | "ask_first" | "allow_directly";
export type MemoryReview = Extract<
  GatewayV2Snapshot,
  { type: "memory.review.snapshot" }
>["payload"];
export type MemoryReviewAction = "dismiss" | "adopt" | "confirm_suspended" | "restore";
export type MemoryClassification = Omit<
  Extract<GatewayV2Snapshot, { type: "memory.classify.snapshot" }>["payload"]["items"][number],
  "contentRef"
>;
const CLASSIFY_BATCH = 500;
const SENSITIVE_CATEGORIES: ReadonlySet<MemoryCategory> = new Set(["health", "finance"]);
const UNCLASSIFIED: MemoryClassification = Object.freeze({
  category: "other",
  classification: "sensitive",
  topic: "other",
  failed: true,
});
const REMINDER_REFRESH_MS = 300_000;

export interface MemoryModel {
  readonly overview: MemoryOverview | null;
  readonly rules: readonly OwnerRule[];
  readonly proposals: PendingProposals | null;
  readonly respondProposal: (
    proposal: Pick<PendingProposal, "proposalId" | "version" | "fingerprint">,
    action: ProposalAction,
  ) => Promise<boolean>;
  readonly builtInRules: readonly BuiltInActionRule[];
  readonly allowances: readonly OwnerAllowance[];
  readonly allowanceDays: number | null;
  readonly setAllowanceDays: (days: number) => Promise<boolean>;
  readonly respondRule: (target: string, action: OwnerRuleAction) => Promise<boolean>;
  readonly revokeAllowance: (allowanceId: string) => Promise<boolean>;
  readonly review: MemoryReview | null;
  readonly respondReview: (
    target: string,
    action: MemoryReviewAction,
    expectedRevision: number | null,
  ) => Promise<boolean>;
  readonly reportMissed: (memoryId: string, upstreamMemoryId: string) => Promise<boolean>;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly respond: (
    item: PendingMemory,
    resolution: "approved" | "edited" | "rejected",
    editedText?: string,
  ) => Promise<boolean>;
  readonly correct: (item: MemoryItem, text: string) => Promise<boolean>;
  readonly remove: (item: MemoryItem) => Promise<boolean>;
  readonly restore: (item: MemoryItem) => Promise<boolean>;
  readonly restoreVersion: (item: MemoryItem, historyId: number) => Promise<boolean>;
  readonly recover: (item: MemoryItem) => Promise<boolean>;
  readonly confirm: (item: MemoryItem) => Promise<boolean>;
  readonly setCategory: (item: MemoryItem, category: MemoryCategory) => Promise<boolean>;
  readonly setPinned: (item: MemoryItem, pinned: boolean) => Promise<boolean>;
  readonly markViewed: () => Promise<boolean>;
  readonly undoTidy: (item: MemoryTidyUp) => Promise<boolean>;
  readonly undoReview: (item: MemoryConversationReview) => Promise<boolean>;
  readonly respondReminder: (
    item: { readonly reminderId: string },
    action: "dismiss" | "snooze" | "cancel" | "restore",
  ) => Promise<boolean>;
  readonly createReminder: (
    text: string,
    due: string,
    repeat: "none" | "yearly",
  ) => Promise<boolean>;
  readonly classify: (texts: readonly string[]) => Promise<readonly MemoryClassification[]>;
  readonly importDuplicates: (
    texts: readonly string[],
  ) => Promise<readonly ImportDuplicateVerdict[]>;
  readonly create: (
    text: string,
    picked: MemoryCategory | null,
    pinned: (category: MemoryCategory) => boolean,
  ) => Promise<MemoryCategory | null>;
  readonly setPaused: (paused: boolean) => Promise<boolean>;
  readonly respondPerson: (suggestionId: string, merge: boolean) => Promise<boolean>;
  readonly importCommit: (
    source: MemoryImportSource,
    items: readonly ImportCandidate[],
  ) => Promise<boolean>;
  readonly importUndo: (batchId: string) => Promise<boolean>;
  readonly externalReady: boolean;
  readonly externalRespond: (items: readonly ExternalDecision[]) => Promise<string | null>;
  readonly externalUndo: (batchId: string) => Promise<boolean>;
  readonly mcpSyncReady: boolean;
  readonly mcpSyncProject: (
    connectionId: string,
    projectId: string,
    decision: "approve" | "decline",
  ) => Promise<boolean>;
  readonly mcpSyncNote: (
    entryId: string,
    decision: "confirm" | "refuse" | "restore",
  ) => Promise<boolean>;
  readonly mcpSyncAttention: (
    attentionId: string,
    decision: "release" | "keep",
  ) => Promise<boolean>;
  readonly checkSource: (memoryId: string) => Promise<MemoryItem | null>;
}

function topicFor(
  result: MemoryClassification,
  category: MemoryCategory,
): NonNullable<MemoryClassification["topic"]> {
  if (result.classification === "sensitive" && result.topic) return result.topic;
  return category === "health" || category === "finance" ? category : "other";
}

export function useMemory(input: {
  readonly client: GatewayClient | undefined;
  readonly configuration: ControlCenterRuntimeConfiguration | undefined;
  readonly connected: boolean;
  readonly refreshSignal: number;
}): MemoryModel | null {
  const { client, configuration, connected, refreshSignal } = input;
  const available =
    configuration?.installedGatewayV2Operations?.includes("memory.overview.read") ?? false;
  const rulesAvailable =
    configuration?.installedGatewayV2Operations?.includes("memory.rules.read") ?? false;
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const proposalsAvailable =
    configuration?.installedGatewayV2Operations?.includes("proposals.read") ?? false;
  const [proposals, setProposals] = useState<PendingProposals | null>(null);
  const [rules, setRules] = useState<readonly OwnerRule[]>([]);
  const [builtInRules, setBuiltInRules] = useState<readonly BuiltInActionRule[]>([]);
  const [allowances, setAllowances] = useState<readonly OwnerAllowance[]>([]);
  const [allowanceDays, setAllowanceDaysValue] = useState<number | null>(null);
  const [review, setReview] = useState<MemoryReview | null>(null);
  const reviewAvailable =
    configuration?.installedGatewayV2Operations?.includes("memory.review.read") ?? false;
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const classifiedRefs = useRef(new Map<string, string>());
  useEffect(() => {
    void reload;
    void refreshSignal;
    if (!available || !client || !configuration || !connected) return;
    let disposed = false;
    void client
      .query(queryMessage(configuration, "memory.overview.read", {}))
      .then((result) => {
        if (result.type !== "memory.overview.snapshot") throw new Error("MEMORY_INVALID");
        if (!disposed) {
          setOverview(result.payload);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    if (rulesAvailable)
      void client
        .query(queryMessage(configuration, "memory.rules.read", {}))
        .then((result) => {
          if (result.type !== "memory.rules.snapshot") throw new Error("RULES_INVALID");
          if (!disposed) {
            setRules(result.payload.rules);
            setBuiltInRules(result.payload.builtIn);
            setAllowances(result.payload.allowances);
            setAllowanceDaysValue(result.payload.allowanceDays);
          }
        })
        .catch(() => {
          if (!disposed) setFailed(true);
        });
    if (proposalsAvailable)
      void client
        .query(queryMessage(configuration, "proposals.read", { open: null }))
        .then((result) => {
          if (result.type !== "proposals.snapshot") throw new Error("PROPOSALS_INVALID");
          if (!disposed) setProposals(result.payload);
        })
        .catch(() => {
          if (!disposed) setFailed(true);
        });
    if (reviewAvailable)
      void client
        .query(queryMessage(configuration, "memory.review.read", {}))
        .then((result) => {
          if (result.type !== "memory.review.snapshot") throw new Error("REVIEW_INVALID");
          if (!disposed) setReview(result.payload);
        })
        .catch(() => {
          if (!disposed) setFailed(true);
        });
    return () => {
      disposed = true;
    };
  }, [
    available,
    rulesAvailable,
    proposalsAvailable,
    reviewAvailable,
    client,
    configuration,
    connected,
    reload,
    refreshSignal,
  ]);
  useEffect(() => {
    if (!available || !connected) return;
    const timer = window.setInterval(() => setReload((value) => value + 1), REMINDER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [available, connected]);
  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  }, []);
  if (!available || !client || !configuration) return null;
  const operations = configuration.installedGatewayV2Operations ?? [];
  const send = (type: GatewayV2Command["type"], payload: () => unknown | Promise<unknown>) =>
    run(async () =>
      client.mutate(commandMessage(configuration, type, await payload(), { risk: "medium" })),
    );
  const protectedRef = async (text: string, sensitive: boolean): Promise<string> => {
    const level = sensitive ? "sensitive" : classificationWithIdentifiers(text, "private");
    const key = `${level}\u0000${text}`;
    const known = classifiedRefs.current.get(key);
    if (known) return known;
    const ref = await client.protectText(text, level);
    classifiedRefs.current.set(key, ref);
    return ref;
  };
  const classify = async (texts: readonly string[]): Promise<readonly MemoryClassification[]> => {
    if (!operations.includes("memory.classify.read")) return texts.map(() => UNCLASSIFIED);
    const results: MemoryClassification[] = [];
    for (let start = 0; start < texts.length; start += CLASSIFY_BATCH) {
      const chunk = texts.slice(start, start + CLASSIFY_BATCH);
      try {
        const contentRefs = await Promise.all(chunk.map((text) => protectedRef(text, false)));
        const result = await client.query(
          queryMessage(configuration, "memory.classify.read", { contentRefs }),
        );
        if (result.type !== "memory.classify.snapshot") throw new Error("CLASSIFY_INVALID");
        for (const [index, ref] of contentRefs.entries()) {
          const item = result.payload.items[index];
          results.push(
            item && item.contentRef === ref
              ? {
                  category: item.category,
                  classification: item.classification,
                  topic: item.topic,
                  failed: item.failed,
                }
              : UNCLASSIFIED,
          );
        }
      } catch {
        results.push(...chunk.map(() => UNCLASSIFIED));
      }
    }
    return results;
  };
  const importDuplicates = async (
    texts: readonly string[],
  ): Promise<readonly ImportDuplicateVerdict[]> => {
    if (!operations.includes("memory.import.duplicates.read")) return texts.map(() => "skipped");
    const results: ImportDuplicateVerdict[] = [];
    for (let start = 0; start < texts.length; start += CLASSIFY_BATCH) {
      const chunk = texts.slice(start, start + CLASSIFY_BATCH);
      try {
        const contentRefs = await Promise.all(chunk.map((text) => protectedRef(text, false)));
        const result = await client.query(
          queryMessage(configuration, "memory.import.duplicates.read", { contentRefs }),
        );
        if (result.type !== "memory.import.duplicates.snapshot")
          throw new Error("IMPORT_DUPLICATES_INVALID");
        for (const [index, ref] of contentRefs.entries()) {
          const item = result.payload.items[index];
          results.push(item && item.contentRef === ref ? item.verdict : "skipped");
        }
      } catch {
        results.push(...chunk.map((): ImportDuplicateVerdict => "skipped"));
      }
    }
    return results;
  };
  const mutate = (item: MemoryItem, action: string) =>
    send("memory.mutate", () => ({
      memoryId: item.memoryId,
      action,
      expectedRevision: item.revision,
      contentRef: null,
      historyId: null,
    }));
  return {
    overview,
    rules,
    proposals,
    builtInRules,
    allowances,
    allowanceDays,
    setAllowanceDays: (days) =>
      run(async () => setApprovalAllowanceDays({ client, configuration, days })),
    respondRule: (target, action) => send("memory.rule.respond", () => ({ target, action })),
    revokeAllowance: (allowanceId) =>
      run(async () =>
        client.mutate(
          commandMessage(
            configuration,
            "approval.allowance.revoke",
            { allowanceId },
            { risk: "low" },
          ),
        ),
      ),
    respondProposal: ({ proposalId, version, fingerprint }, action) =>
      send("proposal.respond", () => ({
        proposalId,
        expectedVersion: version,
        fingerprint,
        action,
        recentAuthenticationRef: null,
        fullReadToken: null,
      })),
    review,
    respondReview: (target, action, expectedRevision) =>
      send("memory.review.respond", () => ({ target, action, expectedRevision })),
    reportMissed: (memoryId, upstreamMemoryId) =>
      send("memory.review.reportMissed", () => ({ memoryId, upstreamMemoryId })),
    failed,
    busy,
    checkSource: async (memoryId) => {
      try {
        const result = await client.query(queryMessage(configuration, "memory.overview.read", {}));
        if (result.type !== "memory.overview.snapshot") return null;
        setOverview(result.payload);
        setFailed(false);
        return result.payload.memories.find((item) => item.memoryId === memoryId) ?? null;
      } catch {
        setFailed(true);
        return null;
      }
    },
    respond: (item, resolution, editedText) =>
      send("memory.approval.respond", () => ({
        requestId: item.requestId,
        resolution,
        editedText: editedText ?? null,
      })),
    correct: (item, text) =>
      send("memory.mutate", async () => ({
        memoryId: item.memoryId,
        action: "correct",
        expectedRevision: item.revision,
        contentRef: await client.protectText(text, item.dataClassification),
        historyId: null,
      })),
    remove: (item) => mutate(item, "delete"),
    restore: (item) => mutate(item, "restore"),
    restoreVersion: (item, historyId) =>
      send("memory.mutate", () => ({
        memoryId: item.memoryId,
        action: "restore_version",
        expectedRevision: item.revision,
        contentRef: null,
        historyId,
      })),
    recover: (item) => mutate(item, "recover"),
    confirm: (item) => mutate(item, "confirm"),
    setCategory: (item, category) =>
      send("memory.category.set", () => ({
        memoryId: item.memoryId,
        expectedRevision: item.revision,
        category,
      })),
    setPinned: (item, pinned) => mutate(item, pinned ? "pin" : "unpin"),
    markViewed: () => send("memory.page.viewed", () => ({})),
    undoTidy: (item) => send("memory.tidy.undo", () => ({ changeId: item.changeId })),
    undoReview: (item) =>
      send("memory.conversationReview.undo", () => ({ reviewId: item.reviewId })),
    respondReminder: (item, action) =>
      send("memory.reminder.respond", () => ({ reminderId: item.reminderId, action })),
    createReminder: (text, due, repeat) =>
      send("memory.reminder.create", async () => ({
        contentRef: await client.protectText(text, classificationWithIdentifiers(text, "private")),
        due,
        repeat,
      })),
    classify,
    importDuplicates,
    create: async (text, picked, pinned) => {
      let category: MemoryCategory = picked ?? "other";
      const ok = await send("memory.create", async () => {
        const [result = UNCLASSIFIED] = await classify([text]);
        category = picked ?? result.category;
        const sensitive =
          result.classification === "sensitive" || SENSITIVE_CATEGORIES.has(category);
        return {
          contentRef: await protectedRef(text, sensitive),
          category,
          subCategory: null,
          topic: sensitive ? topicFor(result, category) : null,
          pinned: pinned(category),
        };
      });
      return ok ? category : null;
    },
    setPaused: (paused) => send("memory.settings.set", () => ({ capturePaused: paused })),
    respondPerson: (suggestionId, merge) =>
      send("memory.person.respond", () => ({ suggestionId, merge })),
    importCommit: (source, items) =>
      send("memory.import.commit", async () => ({
        batchId: `memory-import-${Date.now()}`,
        source,
        items: await Promise.all(
          items.map(async (item) => {
            const sensitive = item.sensitive || SENSITIVE_CATEGORIES.has(item.category);
            return {
              contentRef: await protectedRef(item.text, sensitive),
              category: item.category,
              subCategory: item.subCategory,
              topic: sensitive
                ? (item.topic ??
                  (SENSITIVE_CATEGORIES.has(item.category) ? item.category : "other"))
                : null,
            };
          }),
        ),
      })),
    importUndo: (batchId) => send("memory.import.undo", () => ({ batchId })),
    externalReady:
      operations.includes("memory.external.respond") && operations.includes("memory.external.undo"),
    externalRespond: async (items) => {
      let batchId: string | null = null;
      const ok = await run(async () => {
        const result = await client.mutate(
          commandMessage(configuration, "memory.external.respond", { items }, { risk: "medium" }),
        );
        batchId = result.resultRef;
      });
      return ok ? batchId : null;
    },
    externalUndo: (batchId) => send("memory.external.undo", () => ({ batchId })),
    mcpSyncReady:
      operations.includes("memory.mcpSync.projectDecide") &&
      operations.includes("memory.mcpSync.noteDecide") &&
      operations.includes("memory.mcpSync.attentionResolve"),
    mcpSyncProject: (connectionId, projectId, decision) =>
      send("memory.mcpSync.projectDecide", () => ({ connectionId, projectId, decision })),
    mcpSyncNote: (entryId, decision) =>
      send("memory.mcpSync.noteDecide", () => ({ entryId, decision })),
    mcpSyncAttention: (attentionId, decision) =>
      send("memory.mcpSync.attentionResolve", () => ({ attentionId, decision })),
  };
}
