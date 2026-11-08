import type { GatewayV2Command, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useCallback, useEffect, useState } from "react";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";

export type MuseOverview = Extract<
  GatewayV2Snapshot,
  { type: "muse.overview.snapshot" }
>["payload"];
export type MuseItem = MuseOverview["items"][number];

const MUSE_REFRESH_MS = 300_000;

export interface MuseModel {
  readonly overview: MuseOverview | null;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly rate: (
    item: Pick<MuseItem, "kind" | "naturalKey">,
    timingOk: boolean | null,
    contentOk: boolean | null,
  ) => Promise<boolean>;
  readonly setPaused: (paused: boolean) => Promise<boolean>;
  readonly clearAll: () => Promise<boolean>;
}

export function useMuse(input: {
  readonly client: GatewayClient | undefined;
  readonly configuration: ControlCenterRuntimeConfiguration | undefined;
  readonly connected: boolean;
  readonly refreshSignal: number;
}): MuseModel | null {
  const { client, configuration, connected, refreshSignal } = input;
  const available =
    configuration?.installedGatewayV2Operations?.includes("muse.overview.read") ?? false;
  const [overview, setOverview] = useState<MuseOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    void reload;
    void refreshSignal;
    if (!available || !client || !configuration || !connected) return;
    let disposed = false;
    void client
      .query(queryMessage(configuration, "muse.overview.read", {}))
      .then((result) => {
        if (result.type !== "muse.overview.snapshot") throw new Error("MUSE_INVALID");
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
    const timer = window.setInterval(() => setReload((value) => value + 1), MUSE_REFRESH_MS);
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
  const send = (type: GatewayV2Command["type"], payload: unknown) =>
    run(() => client.mutate(commandMessage(configuration, type, payload, { risk: "medium" })));
  return {
    overview,
    failed,
    busy,
    rate: (item, timingOk, contentOk) =>
      send("muse.item.rate", {
        kind: item.kind,
        naturalKey: item.naturalKey,
        timingOk,
        contentOk,
      }),
    setPaused: (paused) => send("muse.intake.set", { paused }),
    clearAll: () => send("muse.data.clear", {}),
  };
}

export function museDelayParts(minutes: number): {
  readonly unit: "minutes" | "hours";
  readonly value: number;
} {
  return minutes < 120
    ? { unit: "minutes", value: minutes }
    : { unit: "hours", value: Math.round(minutes / 6) / 10 };
}
