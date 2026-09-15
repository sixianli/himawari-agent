import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import type { ControlCenterBrowserStorage } from "./browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { commandMessage } from "./messages.js";

/** Reuse the existing scoped search policy and retain identity across uncertain responses. */
export async function setSearchAuthorization({
  client,
  configuration,
  storage,
  snapshot,
  enabled,
}: {
  client: Pick<GatewayClient, "mutate">;
  configuration: ControlCenterRuntimeConfiguration;
  storage: ControlCenterBrowserStorage;
  snapshot: Extract<GatewayV2Snapshot, { type: "search.authorization.snapshot" }>;
  enabled: boolean;
}) {
  if (!configuration.authorizationRef) throw new Error("CONTROL_CENTER_AUTHORIZATION_REQUIRED");
  if (enabled && !snapshot.payload.available) throw new Error("SEARCH_NOT_CONFIGURED");
  const { revision, recipient } = snapshot.payload;
  const operationKey = `search-authorization:${revision}:${enabled ? "enable" : "revoke"}`;
  const pending = storage.readPendingGovernanceMutation(operationKey);
  const idempotencyKey = pending?.idempotencyKey ?? `governance:${crypto.randomUUID()}`;
  storage.savePendingGovernanceMutation({
    operationKey,
    idempotencyKey,
    commandType: "search.authorization.set",
    objectRef: "search-authorization",
    expectedRevision: revision,
  });
  try {
    const result = await client.mutate(
      commandMessage(
        configuration,
        "search.authorization.set",
        { expectedRevision: revision, enabled, recipient },
        { idempotencyKey, authorizationRef: configuration.authorizationRef, risk: "high" },
      ),
    );
    storage.clearPendingGovernanceMutation(operationKey);
    if (result.status !== "accepted" && result.status !== "replayed")
      throw new Error("SEARCH_AUTHORIZATION_REJECTED");
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 409)
      storage.clearPendingGovernanceMutation(operationKey);
    throw error;
  }
}
