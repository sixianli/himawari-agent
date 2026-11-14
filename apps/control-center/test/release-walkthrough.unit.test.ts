// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_CENTER_SURFACE_INVENTORY } from "../src/app/control-center-inventory.js";
import { ControlCenterApp } from "../src/app.js";
import { ControlCenterBrowserStorage } from "../src/browser-storage.js";
import { messages } from "../src/i18n/resources/zh-CN.js";
import { completedRun, newsRun, runStart } from "./news-run-fixture.js";
import { ACCEPTANCE_SELECTABLE_MODELS } from "./release-walkthrough-models.js";
import { RELEASE_WALKTHROUGH_UI as UI, type WalkthroughTarget } from "./release-walkthrough-ui.js";

const fake = vi.hoisted(() => ({
  searchEnabled: false,
  searchRevision: 2,
  unexpected: [] as string[],
}));
const NOW = new Date(runStart + 30_000).toISOString();
const thread = {
  threadId: "thread-walkthrough",
  revision: 2,
  status: "active",
  titleRef: "title-walkthrough",
  titleSource: "automatic",
  titleRevision: 1,
  pinOrder: null,
  answerLocale: "zh-CN",
  messageWatermark: 2,
  sourceThreadId: null,
  sourceWatermark: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const turnMessage = (sequence: number, role: "owner" | "agent", contentRef: string) => ({
  messageId: `message-${sequence}`,
  sequence,
  role,
  contentRef,
  dataClassification: "private",
  status: "committed",
  turnId: "turn-news",
  runId: completedRun.runId,
  committedAt: NOW,
});
const memoryOverview = {
  memories: [],
  profile: [],
  profileUsage: { used: 0, limit: 2000, pinned: 0, queued: [] },
  lastViewedAt: null,
  externalProposals: { total: 0, items: [], batches: [] },
  pending: [],
  tidyUps: [],
  conversationReviews: [],
  reminders: [],
  upcoming: [],
  people: [],
  personSuggestions: [],
  imports: [],
  capturePaused: false,
  manualAddReady: true,
  generatedAt: NOW,
};

vi.mock("../src/gateway-client.js", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const snapshot = (request: Record<string, unknown>, type: string, payload: unknown) => ({
    ...request,
    kind: "snapshot",
    type,
    payload,
  });
  return {
    ...actual,
    loadRuntimeConfiguration: async () => ({
      ownerId: "owner-walkthrough",
      agentId: "agent-walkthrough",
      deploymentId: "deployment-walkthrough",
      authorityEpoch: 1,
      fencingToken: 1,
      actorId: "owner-walkthrough",
      csrfToken: "csrf-walkthrough",
      sessionId: "session-walkthrough",
      authorizationRef: "authorization-walkthrough",
      canCancelRun: true,
      executionPresentationAvailable: true,
      filesAvailable: true,
      availableModels: [
        {
          ref: "model-primary",
          model: "deepseek/deepseek-v4.1-flash",
          name: "Product path primary",
          provider: "vercel-ai-gateway",
          thinkingLevels: [],
        },
        ...ACCEPTANCE_SELECTABLE_MODELS.map((entry) => ({
          ...entry,
          provider: "vercel-ai-gateway",
          thinkingLevels: [],
        })),
      ],
      installedGatewayV2Operations: [
        ...CONTROL_CENTER_SURFACE_INVENTORY.flatMap((item) => [...item.queries, ...item.mutations]),
        "search.authorization.read",
        "search.authorization.set",
        "memory.overview.read",
        "memory.approval.respond",
        "memory.mutate",
      ],
    }),
    refreshRuntimeConfiguration: async (_fetch: unknown, loaded: unknown) => loaded,
    GatewayClient: class {
      async query(request: { type: string }) {
        if (request.type === "search.authorization.read")
          return snapshot(request, "search.authorization.snapshot", {
            enabled: fake.searchEnabled,
            providersChanged: false,
            available: true,
            revision: fake.searchRevision,
            recipients: ["https://mcp.exa.ai"],
          });
        if (request.type === "approval.list")
          return snapshot(request, "collection.snapshot", { itemRefs: [], nextCursor: null });
        if (request.type === "memory.overview.read")
          return snapshot(request, "memory.overview.snapshot", memoryOverview);
        fake.unexpected.push(`query ${request.type}`);
        throw Object.assign(new Error("WALKTHROUGH_FIXTURE_UNAVAILABLE"), { status: 503 });
      }
      async mutate(request: { type: string; payload: { enabled: boolean } }) {
        if (request.type === "memory.page.viewed")
          return { resultRef: "result-walkthrough", replayed: false, status: "accepted" };
        if (request.type !== "search.authorization.set") {
          fake.unexpected.push(`mutate ${request.type}`);
          throw Object.assign(new Error("WALKTHROUGH_FIXTURE_UNAVAILABLE"), { status: 503 });
        }
        fake.searchEnabled = request.payload.enabled;
        fake.searchRevision += 1;
        return { resultRef: "result-walkthrough", replayed: false, status: "accepted" };
      }
      async queryThread(request: { type: string; payload: Record<string, unknown> }) {
        if (request.type === "thread.list")
          return snapshot(request, "thread.collection_snapshot", {
            threads: [thread],
            nextCursor: null,
            total: 1,
          });
        if (request.type === "thread.detail")
          return snapshot(request, "thread.detail_snapshot", {
            thread,
            messages: [
              turnMessage(1, "owner", "content-question"),
              turnMessage(2, "agent", "content-answer"),
            ],
            runs: [completedRun],
            nextSequence: null,
          });
        if (request.type === "thread.execution")
          return snapshot(request, "thread.execution_snapshot", {
            threadId: thread.threadId,
            runId: completedRun.runId,
            records: request.payload["afterSequence"] === 0 ? newsRun() : [],
            nextSequence: null,
            generatedAt: NOW,
          });
        fake.unexpected.push(`queryThread ${request.type}`);
        throw Object.assign(new Error("WALKTHROUGH_FIXTURE_UNAVAILABLE"), { status: 503 });
      }
      async mutateThread(request: { type: string }) {
        fake.unexpected.push(`mutateThread ${request.type}`);
        throw Object.assign(new Error("WALKTHROUGH_FIXTURE_UNAVAILABLE"), { status: 503 });
      }
      async readText(ref: string) {
        return {
          content:
            ref === "content-question"
              ? "请联网搜索今天的新闻"
              : ref === "content-answer"
                ? "工具返回：https://example.com/news"
                : "今天的新闻",
        };
      }
      async listFiles() {
        return { items: [], nextCursor: null };
      }
    },
  };
});

const IMPLICIT_ROLES: Readonly<Record<string, string>> = {
  A: "link",
  ARTICLE: "article",
  BUTTON: "button",
  DIALOG: "dialog",
  NAV: "navigation",
  SECTION: "region",
  TEXTAREA: "textbox",
};

function roleOf(element: Element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit.split(" ")[0];
  if (element.tagName === "A" && !element.hasAttribute("href")) return null;
  if (element.tagName === "SECTION" && !accessibleName(element)) return null;
  if (element instanceof HTMLInputElement)
    return element.type === "checkbox"
      ? "checkbox"
      : element.type === "text"
        ? "textbox"
        : element.type === "search"
          ? "searchbox"
          : null;
  return IMPLICIT_ROLES[element.tagName] ?? null;
}

function normalized(text: string | null | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy)
    return normalized(
      labelledBy
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" "),
    );
  const label = element.getAttribute("aria-label");
  if (label) return normalized(label);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    return normalized(element.labels?.[0]?.textContent ?? element.placeholder);
  if (["NAV", "SECTION", "DIALOG", "ARTICLE"].includes(element.tagName)) return "";
  return normalized(element.textContent);
}

function hidden(element: Element, scope: Element) {
  for (
    let node: Element | null = element;
    node && node !== scope.parentElement;
    node = node.parentElement
  ) {
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return true;
    if (node instanceof HTMLDialogElement && !node.open) return true;
    if (
      node.parentElement instanceof HTMLDetailsElement &&
      !node.parentElement.open &&
      node.tagName !== "SUMMARY"
    )
      return true;
  }
  return false;
}

function queryAllByRole(scope: Element, target: WalkthroughTarget) {
  return [...scope.querySelectorAll("*")].filter((element) => {
    if (roleOf(element) !== target.role || hidden(element, scope)) return false;
    if (target.name === undefined) return true;
    const name = accessibleName(element);
    return target.exact ? name === target.name : name.includes(target.name);
  });
}

function byRole(scope: Element, target: WalkthroughTarget | readonly WalkthroughTarget[]) {
  const targets = Array.isArray(target) ? target : [target as WalkthroughTarget];
  const matches = targets.map((item) => ({ item, found: queryAllByRole(scope, item) }));
  const ambiguous = matches.find(({ item, found }) => item.role === "region" && found.length > 1);
  if (ambiguous)
    throw new Error(
      `RELEASE_WALKTHROUGH_TARGET_AMBIGUOUS ${ambiguous.found.length} ${ambiguous.item.role}:${ambiguous.item.name ?? ""}`,
    );
  const found = matches.flatMap(({ found: elements }) => elements);
  if (found.length === 0)
    throw new Error(
      `RELEASE_WALKTHROUGH_TARGET_MISSING ${targets.map((item) => `${item.role}:${item.name ?? ""}`).join(" | ")}`,
    );
  return found[0] as HTMLElement;
}

function visibleText(scope: Element, text: string | RegExp) {
  return [...scope.querySelectorAll("*")].filter(
    (element) =>
      !hidden(element, scope) &&
      [...element.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          (typeof text === "string"
            ? node.textContent?.includes(text)
            : text.test(element.textContent ?? "")),
      ),
  );
}

let root: Root, container: HTMLDivElement;

async function settle() {
  for (let round = 0; round < 12; round++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function eventually<T>(read: () => T, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return read();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function present<T extends unknown[]>(found: T, what: string) {
  if (found.length === 0) throw new Error(`RELEASE_WALKTHROUGH_TEXT_MISSING ${what}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onmessage = null;
      onerror = null;
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ method: "cloudflare-access" })));
  fake.searchEnabled = false;
  fake.searchRevision = 2;
  fake.unexpected = [];
  window.localStorage.clear();
  new ControlCenterBrowserStorage(window.localStorage).saveLocale("zh-CN");
  window.history.replaceState(null, "", `/threads/${thread.threadId}`);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
});

describe("release walkthrough locators against the real control center", () => {
  it("finds every control the release walkthrough clicks, in the order it clicks them", async () => {
    await act(async () => root.render(createElement(ControlCenterApp)));
    await settle();
    const body = document.body;

    expect(byRole(body, UI.composer)).toBeInstanceOf(HTMLTextAreaElement);
    expect(byRole(body, UI.send)).toBeDefined();
    expect(byRole(body, UI.newThread)).toBeDefined();

    const picker = body.querySelector<HTMLDetailsElement>(UI.modelPickerRoot);
    expect(picker).not.toBeNull();
    expect(body.querySelector(UI.modelPicker)).not.toBeNull();
    (picker as HTMLDetailsElement).open = true;
    await click(body.querySelector<HTMLElement>(UI.modelChooser) as HTMLElement);
    const options = [...body.querySelectorAll<HTMLElement>(UI.modelOption)];
    expect(options).toHaveLength(ACCEPTANCE_SELECTABLE_MODELS.length + 1);
    for (const entry of ACCEPTANCE_SELECTABLE_MODELS)
      expect(options.some((option) => option.textContent?.includes(entry.name))).toBe(true);
    await click(options[1] as HTMLElement);
    (picker as HTMLDetailsElement).open = false;

    await click(byRole(body, UI.openSettings));
    const dialog = byRole(body, UI.settingsDialog);
    expect(
      queryAllByRole(byRole(dialog, UI.settingsTabs), { role: "button" }).length,
    ).toBeGreaterThanOrEqual(3);
    await click(byRole(dialog, UI.settingsToolsTab));
    const enable = byRole(dialog, UI.searchEnable) as HTMLInputElement;
    expect(enable.disabled).toBe(false);
    expect(enable.checked).toBe(false);
    await click(enable);
    const revoke = byRole(byRole(body, UI.settingsDialog), UI.searchRevoke) as HTMLInputElement;
    expect(revoke.checked).toBe(true);
    expect(revoke.disabled).toBe(false);
    await click(byRole(byRole(body, UI.settingsDialog), UI.closeSettings));
    expect(queryAllByRole(body, UI.settingsDialog)).toHaveLength(0);

    const turns = body.querySelectorAll(UI.turn);
    expect(turns.length).toBeGreaterThan(0);
    const turn = turns[turns.length - 1] as HTMLElement;
    expect(body.querySelectorAll(UI.conversationLoading)).toHaveLength(0);
    expect(
      queryAllByRole(turn, UI.message).some((item) =>
        item.textContent?.includes("请联网搜索今天的新闻"),
      ),
    ).toBe(true);
    const processes = turn.querySelectorAll(UI.turnProcess);
    expect(processes.length).toBeGreaterThan(0);
    const process = processes[processes.length - 1] as HTMLElement;
    if (process.getAttribute("open") === null) {
      const toggle = process.querySelector<HTMLElement>(UI.turnProcessToggle);
      expect(toggle).not.toBeNull();
      await click(toggle as HTMLElement);
    }
    present(visibleText(turn, UI.searchStep), UI.searchStep);
    expect(visibleText(body, UI.unreadableRecords)).toHaveLength(0);
    expect(visibleText(body, UI.noProcessRecords)).toHaveLength(0);

    expect(byRole(body, UI.showList)).toBeDefined();
    await click(byRole(byRole(body, UI.sidebarNavigation), UI.openMemory));
    const memory = await eventually(() => {
      const page = byRole(body, UI.memoryPage);
      present(visibleText(page, UI.memoryCount), String(UI.memoryCount));
      return page;
    });
    expect(queryAllByRole(memory, UI.pageError)).toHaveLength(0);
    expect(byRole(memory, UI.memoryCarry)).toBeDefined();
    expect(
      queryAllByRole(byRole(memory, UI.memoryTabs), UI.memoryTab).length,
    ).toBeGreaterThanOrEqual(2);
    await click(byRole(byRole(body, UI.sidebarNavigation), UI.newThread[1]));
    expect(queryAllByRole(body, UI.memoryPage)).toHaveLength(0);

    await click(byRole(byRole(body, UI.sidebarNavigation), UI.openReminders));
    const reminders = await eventually(() => byRole(body, UI.remindersPage));
    expect(queryAllByRole(reminders, UI.pageError)).toHaveLength(0);
    await click(byRole(byRole(body, UI.sidebarNavigation), UI.openFiles));
    const files = await eventually(() => byRole(body, UI.filesPage));
    expect(queryAllByRole(files, UI.pageError)).toHaveLength(0);
    const library = await eventually(() => {
      const found = files.querySelector(UI.filesLibrary);
      if (!found) throw new Error("RELEASE_WALKTHROUGH_TARGET_MISSING files-library");
      return found;
    });
    expect(library.getAttribute("aria-busy")).toBe("false");
    expect(queryAllByRole(body, UI.remindersPage)).toHaveLength(0);
    await click(byRole(byRole(body, UI.sidebarNavigation), UI.newThread[1]));
    expect(queryAllByRole(body, UI.filesPage)).toHaveLength(0);

    const search = byRole(byRole(body, UI.sidebarNavigation), UI.threadSearch);
    expect(search).toBeInstanceOf(HTMLInputElement);

    expect(fake.unexpected).toEqual([]);
  });

  it("names the process steps the walkthrough waits for exactly as the interface shows them", () => {
    expect(messages["step.search"]).toBe(UI.searchStep);
    expect(messages["step.command"]).toBe(UI.commandStep);
  });
  it("names the approval card controls exactly as the page shows them", () => {
    expect(UI.approveSearch.name).toBe(messages["chat.search.enable"]);
    expect(UI.rememberSearch.name).toBe(messages["chat.search.remember"]);
    expect(UI.approvalContinuing).toBe(messages["chat.approval.continuing"]);
    expect(UI.searchBatch.test(messages["chat.approval.searchBatch"].replace("{count}", "2"))).toBe(
      true,
    );
  });
});
