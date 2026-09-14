import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { queryMessage } from "./messages.js";
import { commandMessage } from "./messages.js";
import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import type { ControlCenterBrowserStorage } from "./browser-storage.js";

export type RunApproval = Extract<GatewayV2Snapshot, { type: "approval.snapshot" }>;

/** Same command, revision, disclosure hash and durable retry identity as the management page. */
export async function respondToRunApproval(input: {
  client: Pick<GatewayClient, "mutate">;
  configuration: ControlCenterRuntimeConfiguration;
  storage: ControlCenterBrowserStorage;
  snapshot: RunApproval;
  runId: string;
  decision: "approved" | "denied";
}) {
  const { client, configuration, storage, snapshot, runId, decision } = input;
  const approval = snapshot.payload;
  if (approval.status !== "pending" || approval.intent.runId !== runId)
    throw new Error("APPROVAL_RUN_CHANGED");
  if (!configuration.authorizationRef) throw new Error("CONTROL_CENTER_AUTHORIZATION_REQUIRED");
  if (
    decision === "approved" &&
    approval.recentAuthenticationRequired &&
    !configuration.recentAuthenticationRef
  )
    throw new Error("CONTROL_CENTER_RECENT_AUTHENTICATION_REQUIRED");
  const operationKey =
    `approval.${decision === "approved" ? "approve" : "deny"}:${approval.approvalRequestId}:${approval.revision}`.slice(
      0,
      128,
    );
  const pending = storage.readPendingGovernanceMutation(operationKey);
  if (
    pending &&
    (pending.commandType !== "approval.respond" ||
      pending.objectRef !== approval.approvalRequestId ||
      pending.expectedRevision !== approval.revision)
  )
    throw new Error("CONTROL_CENTER_MUTATION_IDENTITY_CONFLICT");
  const idempotencyKey = pending?.idempotencyKey ?? `governance:${crypto.randomUUID()}`;
  storage.savePendingGovernanceMutation({
    operationKey,
    idempotencyKey,
    commandType: "approval.respond",
    objectRef: approval.approvalRequestId,
    expectedRevision: approval.revision,
  });
  try {
    const result = await client.mutate(
      commandMessage(
        configuration,
        "approval.respond",
        {
          approvalRequestId: approval.approvalRequestId,
          expectedRevision: approval.revision,
          decision,
          semanticSnapshotHash: approval.semanticSnapshotHash,
          editedPayloadRef: null,
          recentAuthenticationRef:
            decision === "approved" && approval.recentAuthenticationRequired
              ? (configuration.recentAuthenticationRef ?? null)
              : null,
        },
        {
          risk: decision === "approved" ? approval.finalRisk : "medium",
          authorizationRef: configuration.authorizationRef,
          idempotencyKey,
        },
      ),
    );
    storage.clearPendingGovernanceMutation(operationKey);
    return result;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 409)
      storage.clearPendingGovernanceMutation(operationKey);
    throw error;
  }
}

/** Use the existing scoped approval contracts without expanding Thread snapshots. */
export async function findPendingRunApproval(
  client: Pick<GatewayClient, "query">,
  configuration: ControlCenterRuntimeConfiguration,
  runId: string,
): Promise<string | null> {
  let afterCursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await client.query(
      queryMessage(configuration, "approval.list", {
        status: "pending",
        afterCursor,
        limit: 100,
      }),
    );
    if (page.type !== "collection.snapshot") throw new Error("APPROVAL_LIST_INVALID");
    for (const approvalRequestId of page.payload.itemRefs) {
      const detail = await client.query(
        queryMessage(configuration, "approval.detail", { approvalRequestId }),
      );
      if (
        detail.type === "approval.snapshot" &&
        detail.payload.status === "pending" &&
        detail.payload.intent.runId === runId
      )
        return approvalRequestId;
    }
    afterCursor = page.payload.nextCursor;
    if (afterCursor && seen.has(afterCursor)) throw new Error("APPROVAL_CURSOR_REPEATED");
    if (afterCursor) seen.add(afterCursor);
  } while (afterCursor);
  return null;
}
