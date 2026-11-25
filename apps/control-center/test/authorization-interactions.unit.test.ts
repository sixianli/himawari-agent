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
const message = (id: MessageId, values?: Record<string, string>) =>
  Object.entries(values ?? {}).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, value),
    messages[id],
  );
let enabled: boolean,
  providersChanged: boolean,
  revision: number,
  allowanceDays: number | null,
  approvalSnapshot: ReturnType<typeof approval>;
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
  providersChanged = false;
  revision = 2;
  allowanceDays = 7;
  approvalSnapshot = approval("approval-target", "run-target", "pending");
  query.mockImplementation(async (request) => {
    if (request.type === "search.authorization.read")
      return {
        ...envelope,
        type: "search.authorization.snapshot",
        payload: {
          enabled,
          providersChanged,
          revision,
          available: true,
          recipients: ["https://mcp.exa.ai"],
          generatedAt: "2026-09-14T00:00:00.000Z",
        },
      };
    if (request.type === "approval.list")
      return collection(
        approvalSnapshot.payload.status === "pending" ? ["approval-target"] : [],
        null,
      );
    if (request.type === "approval.detail") return approvalSnapshot;
    if (request.type === "memory.rules.read") {
      if (allowanceDays === null) throw new Error("rules unavailable");
      return {
        ...envelope,
        type: "memory.rules.snapshot",
        payload: { allowanceDays },
      };
    }
    throw new Error("unexpected query");
  });
  mutate.mockImplementation(async (request) => {
    if (request.type === "search.authorization.set") {
      enabled = request.payload.enabled;
      providersChanged = false;
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
  const found = [
    ...container.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      "button, input[type=checkbox]",
    ),
  ].find(
    (item) => item.textContent === message(id) || item.getAttribute("aria-label") === message(id),
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
      payload: { enabled: true, expectedRevision: 2, recipients: ["https://mcp.exa.ai"] },
    });
    expect(storage.readPendingGovernanceMutation("search-authorization:2:enable")).toBeNull();
    expect(button("chat.search.revoke").disabled).toBe(false);
    await click("chat.search.revoke");
    expect(mutate.mock.calls[1]?.[0].payload).toMatchObject({
      enabled: false,
      expectedRevision: 3,
    });
  });
  it("says why search turned off when the search service moved, and only then", async () => {
    providersChanged = true;
    await render(SearchAuthorizationControl, searchProps());
    const description = () => container.querySelector(".setting-description")?.textContent;
    expect(description()).toContain(message("chat.search.providersChanged"));
    expect(description()).not.toContain(message("chat.search.afterRevoke"));
    await click("chat.search.enable");
    await click("chat.search.revoke");
    expect(description()).toContain(message("chat.search.afterRevoke"));
    expect(description()).not.toContain(message("chat.search.providersChanged"));
  });
  it("renders authorization inside settings with the disclosure folded away", async () => {
    await render(SearchAuthorizationControl, searchProps());
    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(1);
    expect(details[0]?.className).toBe("settings-details");
    expect(details[0]?.open).toBe(false);
    expect(details[0]?.textContent).toContain("发到下面这些网址");
    expect(details[0]?.querySelector(".search-recipients")?.textContent).toBe("mcp.exa.ai");
    expect(details[0]?.textContent).not.toContain("Exa");
    expect(details[0]?.textContent).not.toContain("https://");
    expect(container.querySelector(".setting-row details")).toBe(details[0]);
    expect(container.querySelector('input[role="switch"]')).not.toBeNull();
    expect(container.querySelector(".search-authorization")).not.toBeNull();
    expect(button("chat.search.enable")).toBeDefined();
  });
  it.each(["offline", "not-authorized", "unavailable"])("does not mutate when %s", async (kind) => {
    const props = searchProps(kind !== "offline");
    if (kind === "not-authorized")
      props.configuration = { ...configuration, authorizationRef: null };
    if (kind === "unavailable")
      query.mockResolvedValue({
        ...envelope,
        type: "search.authorization.snapshot",
        payload: {
          enabled: false,
          providersChanged: false,
          available: false,
          revision: 2,
          recipients: ["https://mcp.exa.ai"],
        },
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
  const ownerScoped = () => {
    approvalSnapshot = {
      ...approvalSnapshot,
      payload: {
        ...approvalSnapshot.payload,
        intent: { ...approvalSnapshot.payload.intent, intentId: "owner-scope:target" },
      },
    };
  };
  it("[ADR-0285] approves and then records the chosen scope, so the same action is not asked again", async () => {
    ownerScoped();
    await render(RunApprovalCard, approvalProps());
    const scopes = [
      ...container.querySelectorAll<HTMLInputElement>(".approval-scope input[type=radio]"),
    ];
    expect(scopes.map(({ value }) => value)).toEqual(["once", "this_task", "days", "always"]);
    expect(scopes[0]?.checked).toBe(true);
    await act(async () => scopes[2]?.click());
    await click("chat.allowance.allow");
    expect(mutate.mock.calls.map(([request]) => request.type)).toEqual([
      "approval.respond",
      "approval.allowance.set",
    ]);
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      payload: { approvalRequestId: "approval-target", allowFor: "days", days: 7 },
    });
    expect(settled).toHaveBeenCalledOnce();
  });
  it("[ADR-0285] “N 天内都行” shows and sends the day count the owner set, not a fixed 7", async () => {
    allowanceDays = 30;
    ownerScoped();
    await render(RunApprovalCard, approvalProps());
    const days = container.querySelector<HTMLInputElement>(".approval-scope input[value=days]");
    expect(days?.closest("label")?.textContent).toBe(
      message("chat.allowance.option", { scope: "days", days: "30" }),
    );
    await act(async () => days?.click());
    await click("chat.allowance.allow");
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      type: "approval.allowance.set",
      payload: { allowFor: "days", days: 30 },
    });
  });
  it("[ADR-0285] REVERSE: without a known day count the card leaves out “N 天内都行” instead of guessing", async () => {
    allowanceDays = null;
    ownerScoped();
    await render(RunApprovalCard, approvalProps());
    const scopes = [
      ...container.querySelectorAll<HTMLInputElement>(".approval-scope input[type=radio]"),
    ];
    expect(scopes.map(({ value }) => value)).toEqual(["once", "this_task", "always"]);
  });
  it("[ADR-0285] REVERSE: a coding or file approval, whose yes is never looked up again, offers only this once", async () => {
    approvalSnapshot = {
      ...approvalSnapshot,
      payload: {
        ...approvalSnapshot.payload,
        intent: { ...approvalSnapshot.payload.intent, intentId: "coding:bash-target" },
      },
    };
    await render(RunApprovalCard, approvalProps());
    expect(container.querySelector(".approval-scope")).toBeNull();
    await click("chat.allowOnce");
    expect(mutate.mock.calls.map(([request]) => request.type)).toEqual(["approval.respond"]);
  });
  it("[ADR-0285] REVERSE: spending money offers only this once and never records a scope", async () => {
    ownerScoped();
    approvalSnapshot = {
      ...approvalSnapshot,
      payload: {
        ...approvalSnapshot.payload,
        intent: { ...approvalSnapshot.payload.intent, estimatedCostMicros: 12_800_000 },
      },
    };
    await render(RunApprovalCard, approvalProps());
    expect(container.querySelector(".approval-scope")).toBeNull();
    await click("chat.allowOnce");
    expect(mutate.mock.calls.map(([request]) => request.type)).toEqual(["approval.respond"]);
  });
  it("[ADR-0285] says the yes went through but the scope was not saved when recording it fails", async () => {
    mutate.mockImplementation(async (request) => {
      if (request.type === "approval.allowance.set") return { status: "rejected" };
      approvalSnapshot = {
        ...approvalSnapshot,
        payload: { ...approvalSnapshot.payload, status: "approved" },
      };
      return { status: "accepted" };
    });
    ownerScoped();
    await render(RunApprovalCard, approvalProps());
    const always = container.querySelector<HTMLInputElement>(".approval-scope input[value=always]");
    await act(async () => always?.click());
    await click("chat.allowance.allow");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      message("chat.allowance.failed"),
    );
    expect(settled).toHaveBeenCalledOnce();
  });
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

describe("inline search choice", () => {
  function searchApproval() {
    approvalSnapshot = {
      ...approvalSnapshot,
      payload: {
        ...approvalSnapshot.payload,
        intent: {
          ...approvalSnapshot.payload.intent,
          operation: "web_search",
          sideEffect: "none",
          recipientRefs: ["https://mcp.exa.ai"],
        },
      },
    };
  }
  it("remembers only explicit search consent and then settles the exact pending approval", async () => {
    searchApproval();
    await render(RunApprovalCard, approvalProps());
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    await click("chat.search.enable");
    expect(mutate.mock.calls.map((call) => call[0].type)).toEqual([
      "search.authorization.set",
      "approval.respond",
    ]);
    expect(mutate.mock.calls[0]?.[0].payload).toEqual({
      expectedRevision: 2,
      enabled: true,
      recipients: ["https://mcp.exa.ai"],
    });
    expect(mutate.mock.calls[1]?.[0].payload).toMatchObject({
      approvalRequestId: "approval-target",
      expectedRevision: 1,
      semanticSnapshotHash: "hash",
      decision: "approved",
    });
    expect((await query({ type: "search.authorization.read" })).payload.enabled).toBe(true);
  });
  it.each(["once", "deny", "reauth"])(
    "does not grant persistent permission for %s",
    async (kind) => {
      searchApproval();
      if (kind === "reauth")
        approvalSnapshot = {
          ...approvalSnapshot,
          payload: { ...approvalSnapshot.payload, recentAuthenticationRequired: true },
        };
      await render(RunApprovalCard, approvalProps());
      if (kind === "once")
        await act(async () =>
          container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(),
        );
      await click(kind === "deny" ? "approvals.deny" : "chat.search.enable");
      expect(mutate.mock.calls.some((call) => call[0].type === "search.authorization.set")).toBe(
        false,
      );
      expect(enabled).toBe(false);
      expect(mutate).toHaveBeenCalledTimes(kind === "reauth" ? 0 : 1);
    },
  );
  it("does not approve the tool when remembering consent fails", async () => {
    searchApproval();
    mutate.mockRejectedValueOnce(new Error("unavailable"));
    await render(RunApprovalCard, approvalProps());
    await click("chat.search.enable");
    expect(mutate).toHaveBeenCalledOnce();
    expect(approvalSnapshot.payload.status).toBe("pending");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
