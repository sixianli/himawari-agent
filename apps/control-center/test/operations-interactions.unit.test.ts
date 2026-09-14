// @vitest-environment jsdom
import { type GatewayV2Snapshot, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compatibilityMessages from "./fixtures/control-plane-snapshots.json" with { type: "json" };
import { ControlCenterBrowserStorage } from "../src/browser-storage.ts";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import { useOperationsControlCenter } from "../src/operations-control-center.tsx";

type Input = Parameters<typeof useOperationsControlCenter>[0];
const configuration: ControlCenterRuntimeConfiguration = {
  ownerId: "owner-01",
  agentId: "agent-01",
  actorId: "owner-01",
  deploymentId: "deployment-01",
  authorityEpoch: 8,
  fencingToken: 3,
  csrfToken: "fixture",
  authorizationRef: "authorization-governance-01",
  recentAuthenticationRef: "recent-auth-01",
};
const message: Input["message"] = (id) => id;
const query = vi.fn(),
  mutate = vi.fn(),
  protect = vi.fn(),
  navigate = vi.fn(),
  unauthorized = vi.fn();
const client = { query, mutate, protectText: protect } as unknown as GatewayClient;
let storage: ControlCenterBrowserStorage,
  root: Root,
  container: HTMLDivElement,
  detail: GatewayV2Snapshot | undefined;
let input: Input;
const nativeDialogMethods = ["showModal", "close"].map(
  (name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const,
);
function snapshot(type: string, changes: Record<string, unknown> = {}): GatewayV2Snapshot {
  const raw = compatibilityMessages.find((value) => value.type === type);
  if (!raw) throw new Error(`Missing contract fixture ${type}`);
  const parsed = gatewayV2MessageSchema.parse(raw);
  if (parsed.kind !== "snapshot") throw new Error("Expected snapshot fixture");
  return { ...parsed, payload: { ...parsed.payload, ...changes } } as GatewayV2Snapshot;
}
function Harness(props: Input) {
  const view = useOperationsControlCenter(props);
  return h("main", null, view.list, view.content, view.details);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  localStorage.clear();
  storage = new ControlCenterBrowserStorage(localStorage);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  detail = undefined;
  input = {
    active: true,
    client,
    configuration,
    connection: "connected",
    message,
    navigate,
    onUnauthorized: unauthorized,
    refreshSignal: 0,
    route: { surfaceId: "tasks", objectId: null, status: null, afterCursor: null, view: "content" },
    storage,
  };
  query.mockImplementation(async (request) => {
    if (request.type.endsWith(".detail") || request.type === "identity.session_detail")
      return detail;
    if (request.type === "inbox.digest") return snapshot("digest.snapshot");
    if (request.type === "settings.read") return snapshot("settings.snapshot");
    return {
      type: "collection.snapshot",
      payload: {
        category:
          { tasks: "tasks", memory: "memory", "sessions-devices": "sessions-devices" }[
            input.route.surfaceId as "tasks"
          ] ?? input.route.surfaceId,
        itemRefs: ["item-one"],
      },
    };
  });
  mutate.mockResolvedValue({ status: "accepted" });
  protect.mockResolvedValue("payload-correction");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const [name, descriptor] of nativeDialogMethods) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(changes: Partial<Input> = {}) {
  input = { ...input, ...changes };
  await act(async () => root.render(h(Harness, input)));
}
async function click(label: string, parent: ParentNode = document) {
  const button = [...parent.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
  return button;
}
async function confirm() {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) throw new Error("Missing confirmation");
  const check = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!check) throw new Error("Missing acknowledgement");
  await act(async () => check.click());
  return click("governed.confirm", dialog);
}
const surfaces = [
  ["tasks", "task.list", "task.detail", "task.snapshot", "jobId"],
  ["inbox-digest", "inbox.list", "inbox.detail", "inbox.snapshot", "inboxItemId"],
  ["memory", "memory.search", "memory.detail", "memory.snapshot", "memoryId"],
  ["trace", "trace.timeline", "trace.detail", "trace.snapshot", "traceEventId"],
  [
    "sessions-devices",
    "identity.sessions",
    "identity.session_detail",
    "session.snapshot",
    "sessionId",
  ],
  ["host-workspaces", "workspace.list", "workspace.detail", "workspace.snapshot", "workspaceId"],
  ["suggestions", "suggestion.list", "suggestion.detail", "suggestion.snapshot", "suggestionId"],
  ["workers", "delegation.list", "delegation.detail", "delegation.snapshot", "delegationId"],
  ["improvements", "improvement.list", "improvement.detail", "improvement.snapshot", "candidateId"],
] as const;
describe("operations page user contracts", () => {
  it.each(surfaces)(
    "loads scoped list and selected record for %s",
    async (surfaceId, listType, detailType, snapshotType, idKey) => {
      detail = snapshot(snapshotType, { [idKey]: "selected-record" });
      await render({
        route: {
          ...input.route,
          surfaceId,
          objectId: "selected-record",
          view: "details",
          afterCursor: "cursor-one",
        },
      });
      expect(query.mock.calls.map(([request]) => request.type)).toContain(listType);
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          type: detailType,
          payload: { [idKey]: "selected-record" },
          scope: { ownerId: "owner-01", agentId: "agent-01" },
        }),
      );
      expect(container.textContent).toContain("selected-record");
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it.each(["active", "paused", "revoked", "invalid"])(
    "validates task status filter %s",
    async (status) => {
      await render({ route: { ...input.route, status } });
      expect(query.mock.calls[0]?.[0].payload.status).toBe(status === "invalid" ? null : status);
    },
  );
  it.each(["active", "archived", "trashed", "invalid"])(
    "validates memory status filter %s",
    async (status) => {
      await render({ route: { ...input.route, surfaceId: "memory", status } });
      expect(query.mock.calls[0]?.[0].payload).toMatchObject({
        status: status === "invalid" ? null : status,
        queryRef: "query:recent",
      });
    },
  );
  it.each(["settings", "reflection", "health-deployment"] as const)(
    "opens direct surface %s without inventing a list request",
    async (surfaceId) => {
      if (surfaceId === "reflection") {
        detail = snapshot("reflection.snapshot");
      }
      await render({ route: { ...input.route, surfaceId } });
      expect(query.mock.calls.map(([request]) => request.type)).toEqual(
        surfaceId === "settings"
          ? ["settings.read"]
          : surfaceId === "reflection"
            ? ["reflection.detail"]
            : [],
      );
    },
  );
  it.each(["inactive", "no-client", "no-configuration"])(
    "does not fetch when %s",
    async (reason) => {
      await render(
        reason === "inactive"
          ? { active: false }
          : reason === "no-client"
            ? { client: undefined }
            : { configuration: undefined },
      );
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("navigates a selected list record without performing a mutation", async () => {
    await render();
    const link = container.querySelector("a");
    if (!link) throw new Error("Missing record link");
    await act(async () => link.click());
    expect(navigate).toHaveBeenCalledWith({
      ...input.route,
      objectId: "item-one",
      view: "details",
    });
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each([401, 503, null])("handles failed reads (%s) and recovers on refresh", async (status) => {
    query.mockRejectedValueOnce(status === null ? "unavailable" : { status });
    await render();
    expect(container.textContent).toContain(
      status === 401
        ? "CONTROL_CENTER_REAUTHENTICATION_REQUIRED"
        : "CONTROL_CENTER_REQUEST_REJECTED",
    );
    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    await click("common.refresh");
    expect(container.textContent).not.toContain("CONTROL_CENTER_REQUEST_REJECTED");
  });
  it.each([
    [
      "tasks",
      "task.snapshot",
      "active",
      "tasks.pause",
      "task.set_state",
      { jobId: "job-01", expectedRevision: 2, action: "pause", reasonCode: "owner-requested" },
    ],
    [
      "tasks",
      "task.snapshot",
      "paused",
      "tasks.resume",
      "task.set_state",
      { jobId: "job-01", expectedRevision: 2, action: "resume", reasonCode: "owner-requested" },
    ],
    [
      "tasks",
      "task.snapshot",
      "active",
      "tasks.cancel",
      "task.set_state",
      { jobId: "job-01", expectedRevision: 2, action: "revoke", reasonCode: "owner-requested" },
    ],
    [
      "memory",
      "memory.snapshot",
      "active",
      "memory.archive",
      "memory.mutate",
      { memoryId: "memory-01", expectedRevision: 2, action: "archive", contentRef: null },
    ],
    [
      "memory",
      "memory.snapshot",
      "active",
      "memory.delete",
      "memory.mutate",
      { memoryId: "memory-01", expectedRevision: 2, action: "delete", contentRef: null },
    ],
    [
      "sessions-devices",
      "session.snapshot",
      "active",
      "sessions.revoke",
      "session.revoke",
      {
        sessionId: "session-01",
        recentAuthenticationRef: "recent-auth-01",
        reasonCode: "owner-requested",
      },
    ],
    [
      "suggestions",
      "suggestion.snapshot",
      "candidate",
      "suggestions.approve",
      "suggestion.respond",
      { suggestionId: "suggestion-01", expectedRevision: 2, decision: "approve" },
    ],
    [
      "suggestions",
      "suggestion.snapshot",
      "delivered",
      "suggestions.reject",
      "suggestion.respond",
      { suggestionId: "suggestion-01", expectedRevision: 2, decision: "reject" },
    ],
    [
      "improvements",
      "improvement.snapshot",
      "review_required",
      "improvements.reject",
      "improvement.review",
      {
        candidateId: "improvement-01",
        expectedRevision: 4,
        decision: "reject",
        reviewEvidenceRef: "review:owner-requested",
      },
    ],
    [
      "improvements",
      "improvement.snapshot",
      "review_required",
      "improvements.requestRevision",
      "improvement.review",
      {
        candidateId: "improvement-01",
        expectedRevision: 4,
        decision: "request_revision",
        reviewEvidenceRef: "review:owner-requested",
      },
    ],
  ] as const)(
    "requires confirmation and submits %s / %s / %s / %s with its bound revision",
    async (surfaceId, type, status, label, commandType, payload) => {
      detail = snapshot(type, { status });
      await render({
        route: { ...input.route, surfaceId, objectId: "selected-record", view: "details" },
      });
      await click(label);
      expect(mutate).not.toHaveBeenCalled();
      await confirm();
      expect(mutate).toHaveBeenCalledOnce();
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({ type: commandType, payload: expect.objectContaining(payload) }),
      );
      expect(query.mock.calls.length).toBeGreaterThan(2);
      expect(document.querySelector("dialog[open]")).toBeNull();
    },
  );
  it.each([
    ["tasks", "task.snapshot", "revoked"],
    ["memory", "memory.snapshot", "deleted_verified"],
    ["sessions-devices", "session.snapshot", "revoked"],
    ["suggestions", "suggestion.snapshot", "approved"],
    ["improvements", "improvement.snapshot", "rejected"],
  ] as const)("offers no mutation for terminal %s records", async (surfaceId, type, status) => {
    detail = snapshot(type, { status });
    await render({ route: { ...input.route, surfaceId, objectId: "selected-record" } });
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "common.refresh",
    ]);
  });
  it("keeps offline actions disabled", async () => {
    detail = snapshot("task.snapshot");
    await render({ connection: "offline", route: { ...input.route, objectId: "job-01" } });
    expect(container.textContent).toContain("operations.offlineNoMutation");
    const button = await click("tasks.pause");
    expect(button.disabled).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each([401, 409, 503])(
    "preserves operation truth after mutation failure %s",
    async (status) => {
      detail = snapshot("task.snapshot");
      mutate.mockRejectedValueOnce({ status });
      await render({ route: { ...input.route, objectId: "job-01", view: "details" } });
      await click("tasks.pause");
      await confirm();
      expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      expect(storage.readPendingGovernanceMutation("operation:task.pause:job-01:2") === null).toBe(
        status === 409,
      );
      if (status !== 409)
        expect(container.textContent).toContain(
          status === 401
            ? "CONTROL_CENTER_REAUTHENTICATION_REQUIRED"
            : "CONTROL_CENTER_REQUEST_REJECTED",
        );
    },
  );
});
