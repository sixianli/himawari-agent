import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useCallback, useEffect, useState } from "react";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";

export type SensitiveInterceptionsSnapshot = Extract<
  GatewayV2Snapshot,
  { type: "sensitive.interceptions.snapshot" }
>["payload"];
export type SensitiveInterceptionItem = SensitiveInterceptionsSnapshot["items"][number];
export type SensitiveInterceptionCounts = SensitiveInterceptionsSnapshot["counts"];

export interface SensitiveInterceptionsModel {
  readonly counts: SensitiveInterceptionCounts | null;
  readonly items: readonly SensitiveInterceptionItem[];
  readonly hasMore: boolean;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly loadMore: () => Promise<void>;
  readonly clear: () => Promise<boolean>;
}

export function sensitiveInterceptionTotal(counts: SensitiveInterceptionCounts): number {
  return counts.masked + counts.withheld + counts.notSaved;
}

export function useSensitiveInterceptions(input: {
  readonly client: GatewayClient | undefined;
  readonly configuration: ControlCenterRuntimeConfiguration | undefined;
  readonly connected: boolean;
  readonly active: boolean;
}): SensitiveInterceptionsModel | null {
  const { client, configuration, connected, active } = input;
  const available =
    configuration?.installedGatewayV2Operations?.includes("sensitive.interceptions.read") ?? false;
  const [counts, setCounts] = useState<SensitiveInterceptionCounts | null>(null);
  const [items, setItems] = useState<readonly SensitiveInterceptionItem[]>([]);
  const [next, setNext] = useState<SensitiveInterceptionsSnapshot["next"]>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const read = useCallback(
    async (before: SensitiveInterceptionsSnapshot["next"]) => {
      if (!client || !configuration) throw new Error("SENSITIVE_INTERCEPTIONS_UNAVAILABLE");
      const result = await client.query(
        queryMessage(configuration, "sensitive.interceptions.read", { before }),
      );
      if (result.type !== "sensitive.interceptions.snapshot")
        throw new Error("SENSITIVE_INTERCEPTIONS_INVALID");
      return result.payload;
    },
    [client, configuration],
  );

  useEffect(() => {
    void reload;
    if (!available || !active || !connected || !client || !configuration) return;
    let disposed = false;
    void read(null)
      .then((payload) => {
        if (disposed) return;
        setCounts(payload.counts);
        setItems(payload.items);
        setNext(payload.next);
        setFailed(false);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [available, active, connected, client, configuration, read, reload]);

  if (!available || !client || !configuration) return null;
  return {
    counts,
    items,
    hasMore: next !== null,
    failed,
    busy,
    loadMore: async () => {
      if (next === null || busy) return;
      setBusy(true);
      try {
        const payload = await read(next);
        setCounts(payload.counts);
        setItems((current) => {
          const seen = new Set(current.map(({ id }) => id));
          return [...current, ...payload.items.filter(({ id }) => !seen.has(id))];
        });
        setNext(payload.next);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    clear: async () => {
      setBusy(true);
      try {
        await client.mutate(
          commandMessage(configuration, "sensitive.interceptions.clear", {}, { risk: "medium" }),
        );
        setFailed(false);
        return true;
      } catch {
        setFailed(true);
        return false;
      } finally {
        setBusy(false);
        setReload((value) => value + 1);
      }
    },
  };
}
