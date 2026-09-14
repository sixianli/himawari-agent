// @vitest-environment jsdom
import { type GatewayV2Snapshot, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import governanceMessages from "./fixtures/control-plane-snapshots.json" with { type: "json" };
import {
  ControlCenterBrowserStorage,
  GOVERNANCE_MUTATION_STORAGE_PREFIX,
} from "../src/browser-storage.ts";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import { useGovernanceControlCenter } from "../src/governance-control-center.tsx";

type Input = Parameters<typeof useGovernanceControlCenter>[0];
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
  const raw = governanceMessages.find((value) => value["type"] === type);
  if (!raw) throw new Error(`Missing contract fixture ${type}`);
  const parsed = gatewayV2MessageSchema.parse(raw);
  if (parsed.kind !== "snapshot") throw new Error("Expected snapshot fixture");
  return { ...parsed, payload: { ...parsed.payload, ...changes } } as GatewayV2Snapshot;
}
function Harness(props: Input) {
  const view = useGovernanceControlCenter(props);
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
    route: {
      surfaceId: "approvals",
      objectId: null,
      status: null,
      afterCursor: null,
      view: "content",
    },
    storage,
  };
  query.mockImplementation(async (request) => {
    if (request.type.endsWith(".detail") || request.type === "identity.session_detail")
      return detail;
    return {
      type: "collection.snapshot",
      payload: {
        category: input.route.surfaceId,
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
async function confirm(label: string) {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) throw new Error("Missing confirmation");
  const check = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!check) throw new Error("Missing acknowledgement");
  await act(async () => check.click());
  return click(label, dialog);
}

const surfaces = [
  ["approvals", "approval", "approvalRequestId", "pending"],
  ["capabilities-adapters", "capability", "capabilityRef", "active"],
  ["authorizations-grants", "grant", "grantId", "active"],
] as const;
describe("governance page action contracts", () => {
  it.each(surfaces)(
    "loads the selected %s record and filters its list",
    async (surfaceId, name, id, status) => {
      detail = snapshot(`${name}.snapshot`);
      await render({
        route: { ...input.route, surfaceId, objectId: "selected", status, afterCursor: "next" },
      });
      const filter =
        name === "grant"
          ? { includeRevoked: false }
          : { [name === "approval" ? "status" : "lifecycle"]: status };
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          type: `${name}.list`,
          payload: { ...filter, afterCursor: "next", limit: 100 },
        }),
      );
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({ type: `${name}.detail`, payload: { [id]: "selected" } }),
      );
      expect(container.textContent).toContain(`${name}.snapshot:`);
      const link = container.querySelector<HTMLAnchorElement>("a");
      if (!link) throw new Error("Missing record link");
      await act(async () => link.click());
      expect(navigate).toHaveBeenCalledWith({
        ...input.route,
        objectId: "item-one",
        view: "details",
      });
    },
  );
  it.each(surfaces)("normalizes unknown filters on %s", async (surfaceId, name) => {
    await render({ route: { ...input.route, surfaceId, status: "not-a-status" } });
    expect(query.mock.calls[0]?.[0].payload).toEqual({
      ...(name === "grant"
        ? { includeRevoked: true }
        : { [name === "approval" ? "status" : "lifecycle"]: null }),
      afterCursor: null,
      limit: 100,
    });
    expect(container.textContent).toContain("governance.selectRecord");
  });
  it.each(["active", "client", "configuration"])(
    "does not fetch when %s is unavailable",
    async (field) => {
      await render(field === "active" ? { active: false } : { [field]: undefined });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each([401, 503, "plain"])("handles read failure %s and permits a refresh", async (status) => {
    query.mockRejectedValueOnce(status === "plain" ? "unavailable" : { status });
    await render();
    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    if (status !== 401) expect(container.textContent).toContain("CONTROL_CENTER_REQUEST_REJECTED");
    await click("common.refresh");
    expect(container.textContent).not.toContain("CONTROL_CENTER_REQUEST_REJECTED");
    expect(container.querySelector("a")).not.toBeNull();
  });
  it("rejects a detail snapshot from an unrelated surface", async () => {
    detail = {
      type: "collection.snapshot",
      payload: { itemRefs: [] },
    } as unknown as GatewayV2Snapshot;
    await render({ route: { ...input.route, objectId: "approval-01" } });
    expect(container.textContent).toContain("CONTROL_CENTER_GOVERNANCE_DETAIL_INVALID");
    expect(container.querySelector(".governance-actions")).toBeNull();
  });
  it("refreshes only on relevant cross-tab mutation records", async () => {
    await render();
    const count = query.mock.calls.length;
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" })));
    expect(query).toHaveBeenCalledTimes(count);
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: `${GOVERNANCE_MUTATION_STORAGE_PREFIX}other` }),
      ),
    );
    expect(query.mock.calls.length).toBeGreaterThan(count);
  });

  const actions = [
    [
      "approvals",
      "approval",
      "pending",
      "approvals.approve",
      "approval.respond",
      { decision: "approved", recentAuthenticationRef: "recent-auth-01" },
    ],
    [
      "approvals",
      "approval",
      "pending",
      "approvals.deny",
      "approval.respond",
      { decision: "denied", recentAuthenticationRef: null },
    ],
    [
      "authorizations-grants",
      "grant",
      "active",
      "governance.revokeGrant",
      "grant.revoke",
      { reasonCode: "owner_revoked_from_control_center" },
    ],
    [
      "capabilities-adapters",
      "capability",
      "review_required",
      "governance.reviewCapability",
      "capability.review",
      {},
    ],
    [
      "capabilities-adapters",
      "capability",
      "installation_proposed",
      "governance.approveInstallation",
      "capability.install.approve",
      { approvalRef: configuration.authorizationRef },
    ],
    [
      "capabilities-adapters",
      "capability",
      "update_proposed",
      "governance.approveUpdate",
      "capability.update.respond",
      { decision: "approved", approvalRef: configuration.authorizationRef },
    ],
    [
      "capabilities-adapters",
      "capability",
      "update_proposed",
      "governance.denyUpdate",
      "capability.update.respond",
      { decision: "denied", approvalRef: null },
    ],
    [
      "capabilities-adapters",
      "capability",
      "active",
      "governance.disableCapability",
      "capability.disable",
      { reasonCode: "owner_disabled_from_control_center" },
    ],
    [
      "capabilities-adapters",
      "capability",
      "active",
      "governance.rollbackCapability",
      "capability.rollback",
      { reasonCode: "owner_rollback_from_control_center" },
    ],
  ] as const;
  it.each(actions)(
    "binds %s %s %s %s to the reviewed revision",
    async (surfaceId, name, state, label, commandType, payload) => {
      detail = snapshot(`${name}.snapshot`, {
        [name === "capability" ? "lifecycle" : "status"]: state,
      });
      await render({ route: { ...input.route, surfaceId, objectId: "selected", view: "details" } });
      await click(label);
      expect(mutate).not.toHaveBeenCalled();
      await confirm(label);
      expect(mutate).toHaveBeenCalledOnce();
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          type: commandType,
          payload: expect.objectContaining({
            ...payload,
            expectedRevision: name === "capability" ? 7 : 2,
          }),
        }),
      );
      expect(document.querySelector("dialog[open]")).toBeNull();
      expect(query.mock.calls.length).toBeGreaterThan(2);
    },
  );
  it.each([
    ["approvals", "approval", "approved"],
    ["authorizations-grants", "grant", "revoked"],
    ["capabilities-adapters", "capability", "uninstalled"],
  ] as const)("offers no actions for a terminal %s record", async (surfaceId, name, state) => {
    detail = snapshot(`${name}.snapshot`, {
      [name === "capability" ? "lifecycle" : "status"]: state,
    });
    await render({ route: { ...input.route, surfaceId, objectId: "selected" } });
    expect(container.querySelector(".governance-actions")).toBeNull();
  });
  it.each(["offline", "authorization", "authentication"])(
    "blocks approval when %s is missing",
    async (missing) => {
      detail = snapshot("approval.snapshot");
      await render({
        connection: missing === "offline" ? "offline" : "connected",
        configuration: {
          ...configuration,
          ...(missing === "authorization"
            ? { authorizationRef: null }
            : missing === "authentication"
              ? { recentAuthenticationRef: null }
              : {}),
        },
        route: { ...input.route, objectId: "approval-01" },
      });
      await click("approvals.approve");
      const button = await confirm("approvals.approve");
      expect(button.disabled).toBe(true);
      expect(mutate).not.toHaveBeenCalled();
      await click("common.close", document.querySelector("dialog") ?? document);
      expect(document.querySelector("dialog[open]")).toBeNull();
    },
  );
  it.each([401, 409, 503])(
    "preserves retry identity or reports a revision conflict after %s",
    async (status) => {
      detail = snapshot("grant.snapshot");
      mutate.mockRejectedValueOnce({ status });
      await render({
        route: {
          ...input.route,
          surfaceId: "authorizations-grants",
          objectId: "grant-01",
          view: "details",
        },
      });
      await click("governance.revokeGrant");
      await confirm("governance.revokeGrant");
      expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      expect(storage.readPendingGovernanceMutation("grant.revoke:grant-01:2") === null).toBe(
        status === 409,
      );
      if (status === 409) expect(container.textContent).toContain("governance.conflictDescription");
      if (status === 503) {
        const first = mutate.mock.calls[0]?.[0];
        await click("governance.revokeGrant", document.querySelector("dialog") ?? document);
        expect(mutate.mock.calls[1]?.[0].idempotencyKey).toBe(first.idempotencyKey);
        expect(storage.readPendingGovernanceMutation("grant.revoke:grant-01:2")).toBeNull();
      }
    },
  );
  it("refuses a stored mutation whose identity conflicts with the selected record", async () => {
    detail = snapshot("grant.snapshot");
    storage.savePendingGovernanceMutation({
      operationKey: "grant.revoke:grant-01:2",
      commandType: "capability.disable",
      objectRef: "other",
      expectedRevision: 2,
      idempotencyKey: "previous",
    });
    await render({
      route: { ...input.route, surfaceId: "authorizations-grants", objectId: "grant-01" },
    });
    await click("governance.revokeGrant");
    await confirm("governance.revokeGrant");
    expect(container.textContent).toContain("CONTROL_CENTER_MUTATION_IDENTITY_CONFLICT");
    expect(mutate).not.toHaveBeenCalled();
  });
});
