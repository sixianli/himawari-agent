import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useCallback, useEffect, useState } from "react";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";

export type MemoryOverview = Extract<
  GatewayV2Snapshot,
  { type: "memory.overview.snapshot" }
>["payload"];
export type MemoryItem = MemoryOverview["memories"][number];
export type PendingMemory = MemoryOverview["pending"][number];
export type MemoryTidyUp = MemoryOverview["tidyUps"][number];
export type MemoryReminder = MemoryOverview["reminders"][number];
const REMINDER_REFRESH_MS = 300_000;

export interface MemoryModel {
  readonly overview: MemoryOverview | null;
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
  readonly confirm: (item: MemoryItem) => Promise<boolean>;
  readonly undoTidy: (item: MemoryTidyUp) => Promise<boolean>;
  readonly respondReminder: (
    item: MemoryReminder,
    action: "dismiss" | "snooze",
  ) => Promise<boolean>;
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
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
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
    return () => {
      disposed = true;
    };
  }, [available, client, configuration, connected, reload, refreshSignal]);
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
  return {
    overview,
    failed,
    busy,
    respond: (item, resolution, editedText) =>
      run(() =>
        client.mutate(
          commandMessage(
            configuration,
            "memory.approval.respond",
            { requestId: item.requestId, resolution, editedText: editedText ?? null },
            { risk: "medium" },
          ),
        ),
      ),
    correct: (item, text) =>
      run(async () =>
        client.mutate(
          commandMessage(
            configuration,
            "memory.mutate",
            {
              memoryId: item.memoryId,
              action: "correct",
              expectedRevision: item.revision,
              contentRef: await client.protectText(text, item.dataClassification),
            },
            { risk: "medium" },
          ),
        ),
      ),
    remove: (item) =>
      run(() =>
        client.mutate(
          commandMessage(
            configuration,
            "memory.mutate",
            {
              memoryId: item.memoryId,
              action: "delete",
              expectedRevision: item.revision,
              contentRef: null,
            },
            { risk: "medium" },
          ),
        ),
      ),
    restore: (item) =>
      run(() =>
        client.mutate(
          commandMessage(
            configuration,
            "memory.mutate",
            {
              memoryId: item.memoryId,
              action: "restore",
              expectedRevision: item.revision,
              contentRef: null,
            },
            { risk: "medium" },
          ),
        ),
      ),
    confirm: (item) =>
      run(() =>
        client.mutate(
          commandMessage(
            configuration,
            "memory.mutate",
            {
              memoryId: item.memoryId,
              action: "confirm",
              expectedRevision: item.revision,
              contentRef: null,
            },
            { risk: "medium" },
          ),
        ),
      ),
    undoTidy: (item) =>
      run(() =>
        client.mutate(
          commandMessage(
            configuration,
            "memory.tidy.undo",
            { changeId: item.changeId },
            { risk: "medium" },
          ),
        ),
      ),
    respondReminder: (item, action) =>
      run(() =>
        client.mutate(
          commandMessage(
            configuration,
            "memory.reminder.respond",
            { reminderId: item.reminderId, action },
            { risk: "medium" },
          ),
        ),
      ),
  };
}
