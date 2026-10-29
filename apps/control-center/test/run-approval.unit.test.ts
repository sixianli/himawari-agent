import { expect, it, vi } from "vitest";
import { ControlCenterBrowserStorage } from "../src/browser-storage.js";
import {
  approvalsDecidedTogether,
  findPendingRunApprovals,
  respondToRunApproval,
} from "../src/run-approval.js";
import { approval, collection } from "./approval.fixture.ts";

const configuration = {
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner",
  csrfToken: "csrf",
};
it("finds the current Run across pages and skips another Run or a stale decision", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce(collection(["other", "stale"], "page-2"))
    .mockResolvedValueOnce(approval("other", "another-run", "pending"))
    .mockResolvedValueOnce(approval("stale", "target-run", "approved"))
    .mockResolvedValueOnce(collection(["target"], null))
    .mockResolvedValueOnce(approval("target", "target-run", "pending"));
  const found = await findPendingRunApprovals({ query }, configuration, "target-run");
  expect(found.map((item) => item.payload.approvalRequestId)).toEqual(["target"]);
  expect(query.mock.calls[3]?.[0]).toMatchObject({
    type: "approval.list",
    payload: { afterCursor: "page-2" },
  });
});
it("stops on a repeated pagination cursor", async () => {
  const query = vi.fn().mockResolvedValue(collection([], "same-page"));
  await expect(findPendingRunApprovals({ query }, configuration, "target-run")).rejects.toThrow(
    "APPROVAL_CURSOR_REPEATED",
  );
  expect(query).toHaveBeenCalledTimes(2);
});
it("returns no pending approval when the collection is empty", async () => {
  const query = vi.fn().mockResolvedValue(collection([], null));
  expect(await findPendingRunApprovals({ query }, configuration, "target-run")).toEqual([]);
});
it("returns every pending approval of the Run in request order", async () => {
  const later = approval("later", "target-run", "pending");
  const earlier = approval("earlier", "target-run", "pending");
  const query = vi
    .fn()
    .mockResolvedValueOnce(collection(["later", "earlier"], null))
    .mockResolvedValueOnce({
      ...later,
      payload: { ...later.payload, requestedAt: "2026-09-07T00:00:00.007Z" },
    })
    .mockResolvedValueOnce(earlier);
  const found = await findPendingRunApprovals({ query }, configuration, "target-run");
  expect(found.map((item) => item.payload.approvalRequestId)).toEqual(["earlier", "later"]);
});
it("decides only approvals of the same kind together", () => {
  const first = approval("first", "run", "pending");
  const second = approval("second", "run", "pending");
  const other = approval("other", "run", "pending");
  const different = {
    ...other,
    payload: { ...other.payload, intent: { ...other.payload.intent, operation: "write" } },
  };
  expect(
    approvalsDecidedTogether([first, different, second]).map(
      (item) => item.payload.approvalRequestId,
    ),
  ).toEqual(["first", "second"]);
  expect(approvalsDecidedTogether([])).toEqual([]);
});

it("retains approval retry identity and keeps the exact Run, revision and disclosure hash", async () => {
  const values = new Map<string, string>();
  const storage = new ControlCenterBrowserStorage({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
  });
  const snapshot = approval("target", "run", "pending");
  if (snapshot.type !== "approval.snapshot") throw new Error("fixture");
  const mutate = vi
    .fn()
    .mockRejectedValueOnce(new Error("network interrupted"))
    .mockResolvedValueOnce({ resultRef: "result", status: "replayed", replayed: true });
  const input = {
    client: { mutate },
    configuration: { ...configuration, authorizationRef: "owner-authority" },
    storage,
    snapshot,
    runId: "run",
    decision: "approved" as const,
  };
  await expect(respondToRunApproval(input)).rejects.toThrow("network interrupted");
  await expect(respondToRunApproval(input)).resolves.toMatchObject({ status: "replayed" });
  expect(mutate.mock.calls[0]?.[0].idempotencyKey).toBe(mutate.mock.calls[1]?.[0].idempotencyKey);
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({
    type: "approval.respond",
    payload: {
      expectedRevision: 1,
      semanticSnapshotHash: "hash",
      approvalRequestId: "target",
      decision: "approved",
    },
  });
  await expect(respondToRunApproval({ ...input, runId: "other" })).rejects.toThrow(
    "APPROVAL_RUN_CHANGED",
  );
  await expect(
    respondToRunApproval({
      ...input,
      snapshot: {
        ...snapshot,
        payload: { ...snapshot.payload, recentAuthenticationRequired: true },
      },
    }),
  ).rejects.toThrow("RECENT_AUTHENTICATION_REQUIRED");
  expect(mutate).toHaveBeenCalledTimes(2);
});
