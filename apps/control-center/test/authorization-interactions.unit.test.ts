// @vitest-environment jsdom
import { act, type ComponentType, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlCenterBrowserStorage } from "../src/browser-storage.ts";
import { RunApprovalCard } from "../src/components/run-approval-card.tsx";
import { SearchAuthorizationControl } from "../src/components/search-authorization-control.tsx";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages } from "../src/i18n/resources/zh-CN.ts";
import { ControlCenterIntlProvider } from "../src/i18n/runtime.tsx";
import { approval, collection, envelope } from "./approval.fixture.ts";

let container: HTMLDivElement, root: Root, storage: ControlCenterBrowserStorage;
const configuration: ControlCenterRuntimeConfiguration = {
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner",
  csrfToken: "csrf-fixture",
  authorizationRef: "owner-authorization",
};
const query = vi.fn(),
  mutate = vi.fn(),
  settled = vi.fn(),
  unauthorized = vi.fn();
const client = { query, mutate } as unknown as GatewayClient;
const message = (id: MessageId) => messages[id];
let enabled: boolean, revision: number, approvalSnapshot: ReturnType<typeof approval>;
function searchProps(connected = true) {
  return { client, configuration, storage, connected, refreshSignal: 0, message };
}
function approvalProps() {
  return {
    client,
    configuration,
    storage,
    runId: "run-target",
    records: [],
    connection: "connected",
    refreshSignal: 0,
    message,
    onSettled: settled,
    onUnauthorized: unauthorized,
  };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  localStorage.clear();
  storage = new ControlCenterBrowserStorage(localStorage);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  enabled = false;
  revision = 2;
  approvalSnapshot = approval("approval-target", "run-target", "pending");
  query.mockImplementation(async (request) => {
    if (request.type === "search.authorization.read")
      return {
        ...envelope,
        type: "search.authorization.snapshot",
        payload: {
          enabled,
          revision,
          available: true,
          recipient: "https://mcp.exa.ai",
          generatedAt: "2026-09-14T00:00:00.000Z",
        },
      };
    if (request.type === "approval.list")
      return collection(
        approvalSnapshot.payload.status === "pending" ? ["approval-target"] : [],
        null,
      );
    if (request.type === "approval.detail") return approvalSnapshot;
    throw new Error("unexpected query");
  });
  mutate.mockImplementation(async (request) => {
    if (request.type === "search.authorization.set") {
      enabled = request.payload.enabled;
      revision++;
    }
    if (request.type === "approval.respond")
      approvalSnapshot = {
        ...approvalSnapshot,
        payload: { ...approvalSnapshot.payload, status: "approved" },
      };
    return { status: "accepted" };
  });
  settled.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function render<T extends object>(component: ComponentType<T>, props: T) {
  const provider = {
    locale: "zh-CN" as const,
    loadingLabel: "加载中",
    children: h(component, props),
  };
  await act(async () => root.render(h(ControlCenterIntlProvider, provider)));
}
function button(id: MessageId) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === message(id),
  );
  if (!found) throw new Error(`missing button ${id}`);
  return found;
}
async function click(id: MessageId) {
  await act(async () => button(id).click());
}
describe("search authorization menu", () => {
  it("enables and revokes using current revision, persists retry identity, and reads back state", async () => {
    await render(SearchAuthorizationControl, searchProps());
    await click("chat.search.enable");
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "search.authorization.set",
      payload: { enabled: true, expectedRevision: 2, recipient: "https://mcp.exa.ai" },
    });
    expect(storage.readPendingGovernanceMutation("search-authorization:2:enable")).toBeNull();
    expect(button("chat.search.revoke").disabled).toBe(false);
    await click("chat.search.revoke");
    expect(mutate.mock.calls[1]?.[0].payload).toMatchObject({
      enabled: false,
      expectedRevision: 3,
    });
  });
  it("dismisses with Escape or outside click and returns keyboard focus to its summary", async () => {
    await render(SearchAuthorizationControl, searchProps());
    const menu = container.querySelector("details");
    if (!menu) throw new Error("missing execution menu");
    menu.open = true;
    await act(async () =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector("summary"));
    menu.open = true;
    await act(async () => document.body.click());
    expect(menu.open).toBe(false);
  });
  it.each(["offline", "not-authorized", "unavailable"])("does not mutate when %s", async (kind) => {
    const props = searchProps(kind !== "offline");
    if (kind === "not-authorized")
      props.configuration = { ...configuration, authorizationRef: null };
    if (kind === "unavailable")
      query.mockResolvedValue({
        ...envelope,
        type: "search.authorization.snapshot",
        payload: { enabled: false, available: false, revision: 2, recipient: "https://mcp.exa.ai" },
      });
    await render(SearchAuthorizationControl, props);
    await click("chat.search.enable");
    expect(mutate).not.toHaveBeenCalled();
    if (kind === "offline") expect(query).not.toHaveBeenCalled();
  });
  it("reuses a pending identity after an uncertain failure", async () => {
    await render(SearchAuthorizationControl, searchProps());
    mutate.mockRejectedValueOnce(new Error("network unavailable"));
    await click("chat.search.enable");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    const first = mutate.mock.calls[0]?.[0].idempotencyKey;
    await click("chat.search.enable");
    expect(mutate.mock.calls[1]?.[0].idempotencyKey).toBe(first);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("drops a conflicting retry identity and fetches current state", async () => {
    await render(SearchAuthorizationControl, searchProps());
    mutate.mockRejectedValueOnce({ status: 409 });
    await click("chat.search.enable");
    expect(storage.readPendingGovernanceMutation("search-authorization:2:enable")).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("clears a transient load error after a successful refresh", async () => {
    query.mockRejectedValueOnce(new Error("temporary failure"));
    await render(SearchAuthorizationControl, searchProps());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await render(SearchAuthorizationControl, { ...searchProps(), refreshSignal: 1 });
    expect(button("chat.search.enable").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
describe("inline run approval", () => {
  it("clears a failed load when a later refresh confirms that no approval is pending", async () => {
    query.mockRejectedValueOnce(new Error("temporary approval failure"));
    await render(RunApprovalCard, approvalProps());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    approvalSnapshot = {
      ...approvalSnapshot,
      payload: { ...approvalSnapshot.payload, status: "approved" },
    };
    await render(RunApprovalCard, { ...approvalProps(), refreshSignal: 1 });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
  it.each([
    ["chat.allowOnce", "approved"],
    ["approvals.deny", "denied"],
  ] as const)(
    "submits %s once with exact run approval revision and disclosure hash",
    async (label, decision) => {
      await render(RunApprovalCard, approvalProps());
      await click(label);
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        type: "approval.respond",
        payload: {
          approvalRequestId: "approval-target",
          expectedRevision: 1,
          decision,
          semanticSnapshotHash: "hash",
        },
      });
      expect(settled).toHaveBeenCalledOnce();
      expect(container.querySelector("button")).toBeNull();
    },
  );
  it("shows required reauthentication and prevents approval without its reference", async () => {
    approvalSnapshot = {
      ...approvalSnapshot,
      payload: { ...approvalSnapshot.payload, recentAuthenticationRequired: true },
    };
    await render(RunApprovalCard, approvalProps());
    expect(container.textContent).toContain(message("account.reauthenticate"));
    await click("chat.allowOnce");
    expect(mutate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      message("governance.blocker.recentAuthentication"),
    );
  });
  it("disables both decisions while the first request is pending", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mutate.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render(RunApprovalCard, approvalProps());
    await click("chat.allowOnce");
    expect(button("chat.allowOnce").disabled).toBe(true);
    expect(button("approvals.deny").disabled).toBe(true);
    await click("approvals.deny");
    expect(mutate).toHaveBeenCalledOnce();
    await act(async () => {
      resolve?.({ status: "replayed" });
    });
  });
  it("routes expired authentication to login and retains uncertain command identity", async () => {
    mutate.mockRejectedValueOnce({ status: 401 });
    await render(RunApprovalCard, approvalProps());
    await click("chat.allowOnce");
    expect(unauthorized).toHaveBeenCalledOnce();
    expect(
      storage.readPendingGovernanceMutation("approval.approve:approval-target:1"),
    ).not.toBeNull();
  });
  it("does not fetch or submit while disconnected", async () => {
    await render(RunApprovalCard, { ...approvalProps(), connection: "offline" });
    expect(query).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
  });
  it("reports a list failure and clears it after retrying the current run", async () => {
    query.mockRejectedValueOnce("unavailable");
    await render(RunApprovalCard, approvalProps());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await render(RunApprovalCard, { ...approvalProps(), refreshSignal: 1 });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("chat.allowOnce").disabled).toBe(false);
  });
});
