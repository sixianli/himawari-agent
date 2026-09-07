import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { queryMessage } from "./messages.js";

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
