import type { GatewayV2Command, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import { useCallback, useEffect, useState } from "react";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import type { ImportCandidate, MemoryCategory } from "./memory-import.js";
import { commandMessage, queryMessage } from "./messages.js";

export type MemoryOverview = Extract<
  GatewayV2Snapshot,
  { type: "memory.overview.snapshot" }
>["payload"];
export type MemoryItem = MemoryOverview["memories"][number];
export type PendingMemory = MemoryOverview["pending"][number];
export type MemoryTidyUp = MemoryOverview["tidyUps"][number];
export type MemoryReminder = MemoryOverview["reminders"][number];
export type MemoryImportSource = MemoryOverview["imports"][number]["source"];
export type OwnerRule = Extract<
  GatewayV2Snapshot,
  { type: "memory.rules.snapshot" }
>["payload"]["rules"][number];
export type OwnerRuleAction = "undo" | "confirm" | "reconfirm";
const REMINDER_REFRESH_MS = 300_000;

export interface MemoryModel {
  readonly overview: MemoryOverview | null;
  readonly rules: readonly OwnerRule[];
  readonly respondRule: (target: string, action: OwnerRuleAction) => Promise<boolean>;
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
  readonly recover: (item: MemoryItem) => Promise<boolean>;
  readonly confirm: (item: MemoryItem) => Promise<boolean>;
  readonly setCategory: (item: MemoryItem, category: MemoryCategory) => Promise<boolean>;
  readonly setPinned: (item: MemoryItem, pinned: boolean) => Promise<boolean>;
  readonly markViewed: () => Promise<boolean>;
  readonly undoTidy: (item: MemoryTidyUp) => Promise<boolean>;
  readonly respondReminder: (
    item: { readonly reminderId: string },
    action: "dismiss" | "snooze" | "cancel",
  ) => Promise<boolean>;
  readonly createReminder: (
    text: string,
    due: string,
    repeat: "none" | "yearly",
  ) => Promise<boolean>;
  readonly create: (
    text: string,
    category: MemoryCategory,
    sensitive: boolean,
    pinned: boolean,
  ) => Promise<boolean>;
  readonly setPaused: (paused: boolean) => Promise<boolean>;
  readonly respondPerson: (suggestionId: string, merge: boolean) => Promise<boolean>;
  readonly importCommit: (
    source: MemoryImportSource,
    items: readonly ImportCandidate[],
  ) => Promise<boolean>;
  readonly importUndo: (batchId: string) => Promise<boolean>;
  readonly checkSource: (memoryId: string) => Promise<MemoryItem | null>;
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
  const [rules, setRules] = useState<readonly OwnerRule[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
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
          if (!disposed) setRules(result.payload.rules);
        })
        .catch(() => {
          if (!disposed) setFailed(true);
        });
    return () => {
      disposed = true;
    };
  }, [available, rulesAvailable, client, configuration, connected, reload, refreshSignal]);
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
  const send = (type: GatewayV2Command["type"], payload: () => unknown | Promise<unknown>) =>
    run(async () =>
      client.mutate(commandMessage(configuration, type, await payload(), { risk: "medium" })),
    );
  const mutate = (item: MemoryItem, action: string) =>
    send("memory.mutate", () => ({
      memoryId: item.memoryId,
      action,
      expectedRevision: item.revision,
      contentRef: null,
    }));
  return {
    overview,
    rules,
    respondRule: (target, action) => send("memory.rule.respond", () => ({ target, action })),
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
      })),
    remove: (item) => mutate(item, "delete"),
    restore: (item) => mutate(item, "restore"),
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
    respondReminder: (item, action) =>
      send("memory.reminder.respond", () => ({ reminderId: item.reminderId, action })),
    createReminder: (text, due, repeat) =>
      send("memory.reminder.create", async () => ({
        contentRef: await client.protectText(text, classificationWithIdentifiers(text, "private")),
        due,
        repeat,
      })),
    create: (text, category, sensitive, pinned) => {
      const classification = sensitive
        ? "sensitive"
        : classificationWithIdentifiers(text, "private");
      return send("memory.create", async () => ({
        contentRef: await client.protectText(text, classification),
        category,
        subCategory: null,
        pinned,
      }));
    },
    setPaused: (paused) => send("memory.settings.set", () => ({ capturePaused: paused })),
    respondPerson: (suggestionId, merge) =>
      send("memory.person.respond", () => ({ suggestionId, merge })),
    importCommit: (source, items) =>
      send("memory.import.commit", async () => ({
        batchId: `memory-import-${Date.now()}`,
        source,
        items: await Promise.all(
          items.map(async (item) => ({
            contentRef: await client.protectText(
              item.text,
              item.sensitive ? "sensitive" : "private",
            ),
            category: item.category,
            subCategory: item.subCategory,
          })),
        ),
      })),
    importUndo: (batchId) => send("memory.import.undo", () => ({ batchId })),
  };
}
