import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium, devices, firefox, webkit } from "@playwright/test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileName = process.argv[2] ?? "chromium";
const profiles = {
  chromium: { engine: chromium, runtime: "playwright-chromium" },
  chrome: {
    engine: chromium,
    runtime: "installed-google-chrome",
    launchOptions: { channel: "chrome" },
  },
  edge: {
    engine: chromium,
    runtime: "installed-microsoft-edge",
    launchOptions: { channel: "msedge" },
  },
  firefox: {
    engine: firefox,
    runtime: process.env.HIMAWARI_FIREFOX_EXECUTABLE
      ? "playwright-firefox-explicit-executable"
      : "playwright-firefox",
    launchOptions: process.env.HIMAWARI_FIREFOX_EXECUTABLE
      ? { executablePath: process.env.HIMAWARI_FIREFOX_EXECUTABLE }
      : undefined,
  },
  webkit: { engine: webkit, runtime: "playwright-webkit" },
  "ios-webkit": {
    engine: webkit,
    runtime: "playwright-webkit-ios-emulation",
    contextOptions: devices["iPhone 15"],
    emulation: "iPhone 15",
  },
  "android-chrome": {
    engine: chromium,
    runtime: "installed-google-chrome-android-emulation",
    launchOptions: { channel: "chrome" },
    contextOptions: devices["Pixel 7"],
    emulation: "Pixel 7",
  },
};
const profile = profiles[profileName];
if (!profile) throw new Error(`CONTROL_CENTER_BROWSER_PROFILE_INVALID:${profileName}`);

const server = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
  cwd: repositoryRoot,
  env: { ...process.env, HIMAWARI_BROWSER_FIXTURE_PORT: "4173" },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CONTROL_CENTER_FIXTURE_TIMEOUT")), 10_000);
    server.once("error", reject);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("CONTROL_CENTER_FIXTURE_READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  });
}

async function waitForText(locator, text) {
  await locator.filter({ hasText: text }).waitFor({ state: "visible", timeout: 5_000 });
}

async function waitForConnected(page, text = "实时连接") {
  await waitForText(page.getByRole("status"), text);
}

async function waitForAccepted(page) {
  try {
    await waitForText(page.getByRole("status"), "已接纳");
  } catch (error) {
    const mainText = await page.getByRole("main").innerText();
    throw new Error(`CONTROL_CENTER_MUTATION_NOT_ACCEPTED:${mainText}`, { cause: error });
  }
}

async function assertAxeClean(page, checkpoint) {
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  if (violations.length > 0) {
    const details = violations.flatMap(({ id, nodes }) =>
      nodes.map((node) => ({ id, target: node.target, failureSummary: node.failureSummary })),
    );
    throw new Error(`CONTROL_CENTER_AXE_VIOLATIONS:${checkpoint}:${JSON.stringify(details)}`);
  }
}

async function assertNoDocumentOverflow(page, checkpoint) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (dimensions.scrollWidth > dimensions.clientWidth + 1) {
    throw new Error(`CONTROL_CENTER_REFLOW_OVERFLOW:${checkpoint}:${JSON.stringify(dimensions)}`);
  }
}

const surfaces = [
  { label: "对话", title: "对话", policy: "allowed" },
  { label: "审批", title: "审批", policy: "baseline_only" },
  { label: "后台任务", title: "后台任务", policy: "baseline_only" },
  { label: "收件箱与摘要", title: "收件箱与摘要", policy: "baseline_only" },
  { label: "记忆", title: "记忆", policy: "baseline_only" },
  { label: "能力与适配器", title: "能力与适配器", policy: "blocked" },
  { label: "授权与 Grant", title: "授权与 Grant", policy: "blocked" },
  { label: "追踪", title: "追踪", policy: "baseline_only" },
  { label: "设置", title: "设置", policy: "blocked" },
  { label: "会话与设备", title: "会话与设备", policy: "baseline_only" },
  { label: "健康与部署", title: "健康与部署", policy: "baseline_only" },
];
const forbiddenBaselineActions = [
  "批准",
  "拒绝",
  "暂停",
  "恢复",
  "启用 GitHub 监控",
  "撤销 GitHub 监控",
  "更正",
  "归档",
  "删除",
  "撤销会话",
];

let browser;
try {
  await waitForServer();
  browser = await profile.engine.launch({
    headless: true,
    timeout: 30_000,
    ...profile.launchOptions,
  });
  const browserVersion = browser.version();
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 800 },
    ...profile.contextOptions,
  });
  let page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("http://127.0.0.1:4173/threads/thread-main?view=content");
  await waitForConnected(page);

  await page.keyboard.press("Tab");
  const keyboardFocus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    const style = getComputedStyle(element);
    const labelText =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? Array.from(element.labels ?? [])
            .map((label) => label.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ")
        : "";
    return {
      tagName: element.tagName.toLowerCase(),
      accessibleName:
        element.getAttribute("aria-label") ||
        labelText ||
        element.textContent?.trim() ||
        element.title ||
        "",
      visible:
        style.outlineStyle !== "none" ||
        style.boxShadow !== "none" ||
        Number.parseFloat(style.outlineWidth) > 0,
    };
  });
  if (!keyboardFocus?.visible || !keyboardFocus.accessibleName) {
    throw new Error(`CONTROL_CENTER_KEYBOARD_FOCUS_NOT_VISIBLE:${JSON.stringify(keyboardFocus)}`);
  }
  const ariaSnapshot = await page.locator("body").ariaSnapshot();
  for (const requiredLandmark of ["navigation", "main", "heading", "complementary"]) {
    if (!ariaSnapshot.includes(requiredLandmark)) {
      throw new Error(`CONTROL_CENTER_ARIA_LANDMARK_MISSING:${requiredLandmark}`);
    }
  }

  await page.getByLabel("消息草稿").fill("浏览器资格测试消息");
  await page.getByRole("button", { name: "发送并启动 Run" }).click();
  await waitForAccepted(page);
  if ((await page.getByLabel("消息草稿").inputValue()) !== "") {
    throw new Error("CONTROL_CENTER_DRAFT_NOT_CLEARED");
  }
  await page.goto("http://127.0.0.1:4173/threads/run-01?view=content");
  await waitForConnected(page);
  await page.getByRole("button", { name: "取消指定 Run", exact: true }).click();
  await waitForAccepted(page);

  const primaryNavigation = page.getByRole("navigation", { name: "控制中心功能" });
  for (const surface of surfaces) {
    await primaryNavigation.getByRole("link", { name: surface.label, exact: true }).click();
    await page.getByRole("heading", { name: surface.title, exact: true }).waitFor();
    const focusedId = await page.evaluate(() => document.activeElement?.id ?? null);
    if (focusedId !== "page-title") {
      throw new Error(`CONTROL_CENTER_ROUTE_FOCUS_NOT_MOVED:${surface.label}:${focusedId}`);
    }
    if (surface.policy !== "allowed") {
      await page.getByText("领域 contract 尚未冻结", { exact: true }).waitFor();
      if ((await page.locator("main code").count()) === 0) {
        throw new Error(`CONTROL_CENTER_BLOCKER_CODE_MISSING:${surface.label}`);
      }
      for (const action of forbiddenBaselineActions) {
        if ((await page.getByRole("button", { name: action, exact: true }).count()) > 0) {
          throw new Error(`CONTROL_CENTER_UNSAFE_BASELINE_ACTION:${surface.label}:${action}`);
        }
      }
    }
  }

  await primaryNavigation.getByRole("link", { name: "后台任务", exact: true }).click();
  await waitForText(page.getByRole("main"), "fixture-primary");
  await waitForText(page.getByRole("main"), "fixture-owner/fixture-repository");

  await primaryNavigation.getByRole("link", { name: "设置", exact: true }).click();
  const languageTab = page.getByRole("tab", { name: "界面语言", exact: true });
  await languageTab.focus();
  await languageTab.press("ArrowRight");
  const modelsTab = page.getByRole("tab", { name: "模型与预算", exact: true });
  if ((await modelsTab.getAttribute("aria-selected")) !== "true") {
    throw new Error("CONTROL_CENTER_TAB_ROVING_FAILED");
  }

  const localeSelect = page.locator(".locale-control select");
  await localeSelect.selectOption("en");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  if ((await page.locator("html").getAttribute("lang")) !== "en") {
    throw new Error("CONTROL_CENTER_EN_LOCALE_NOT_APPLIED");
  }
  await localeSelect.selectOption("ja");
  await page.getByRole("heading", { name: "設定", exact: true }).waitFor();
  if ((await page.locator("html").getAttribute("lang")) !== "ja") {
    throw new Error("CONTROL_CENTER_JA_LOCALE_NOT_APPLIED");
  }
  const japaneseNavigation = page.getByRole("navigation", { name: "コントロールセンター機能" });
  await japaneseNavigation.getByRole("link", { name: "会話", exact: true }).click();
  const japaneseDraft = "日本語の長文入力とレイアウトを確認するための未送信メッセージです。";
  await page.getByLabel("メッセージ下書き").fill(japaneseDraft);
  if ((await page.getByLabel("メッセージ下書き").inputValue()) !== japaneseDraft) {
    throw new Error("CONTROL_CENTER_JA_INPUT_NOT_PRESERVED");
  }
  await assertNoDocumentOverflow(page, "desktop-ja-long-input");
  await assertAxeClean(page, "desktop-ja");
  await page.getByLabel("メッセージ下書き").fill("");
  await localeSelect.selectOption("zh-CN");
  await page.getByRole("heading", { name: "对话", exact: true }).waitFor();
  if (
    (await page.evaluate(() => localStorage.getItem("himawari.control-center.v1.locale"))) !==
    "zh-CN"
  ) {
    throw new Error("CONTROL_CENTER_LOCALE_NOT_PERSISTED");
  }

  await page.goto("http://127.0.0.1:4173/capabilities/capability-01?view=details");
  await waitForConnected(page);
  await page.getByRole("heading", { name: "能力与适配器", exact: true }).waitFor();
  await page.getByText("capability-01", { exact: true }).waitFor();

  let releaseLoading;
  let markLoadingComplete;
  const loadingGate = new Promise((resolve) => {
    releaseLoading = resolve;
  });
  const loadingComplete = new Promise((resolve) => {
    markLoadingComplete = resolve;
  });
  const loadingHandler = async (route) => {
    await loadingGate;
    await route.continue();
    markLoadingComplete?.();
  };
  await page.route("**/api/gateway/v2/queries", loadingHandler);
  await primaryNavigation.getByRole("link", { name: "审批", exact: true }).click();
  await page.getByText("正在加载权威状态", { exact: true }).waitFor();
  releaseLoading?.();
  await loadingComplete;
  await page.unroute("**/api/gateway/v2/queries", loadingHandler);
  await waitForText(page.getByRole("main"), "approval-01");

  const errorHandler = async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "CONTROL_CENTER_FIXTURE_UNAVAILABLE" } }),
    });
  };
  await page.route("**/api/gateway/v2/queries", errorHandler);
  await primaryNavigation.getByRole("link", { name: "收件箱与摘要", exact: true }).click();
  await page.getByText("CONTROL_CENTER_FIXTURE_UNAVAILABLE", { exact: true }).waitFor();
  await page.unroute("**/api/gateway/v2/queries", errorHandler);

  const revokedSessionHandler = async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "SESSION_REVOKED" } }),
    });
  };
  await page.route("**/api/gateway/v2/queries", revokedSessionHandler);
  await primaryNavigation.getByRole("link", { name: "后台任务", exact: true }).click();
  await page.getByText("CONTROL_CENTER_REAUTHENTICATION_REQUIRED", { exact: true }).waitFor();
  if ((await page.getByText("approval-01", { exact: true }).count()) > 0) {
    throw new Error("CONTROL_CENTER_REVOKED_SESSION_VIEW_STATE_RETAINED");
  }
  await page.unroute("**/api/gateway/v2/queries", revokedSessionHandler);

  await primaryNavigation.getByRole("link", { name: "能力与适配器", exact: true }).click();
  await page.getByText("暂无记录", { exact: true }).waitFor();

  await page.evaluate(() => fetch("/__fixture/degrade", { method: "POST" }));
  await primaryNavigation.getByRole("link", { name: "健康与部署", exact: true }).click();
  await waitForText(page.getByRole("main"), "degraded");

  await assertAxeClean(page, "desktop-zh-CN");

  const cursorBeforeOffline = await page.evaluate(() =>
    localStorage.getItem("himawari.control-center.v1.lastCursor"),
  );
  await primaryNavigation.getByRole("link", { name: "对话", exact: true }).click();
  await page.getByLabel("消息草稿").fill("离线草稿");
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForText(page.locator(".connection"), "离线");
  if (!(await page.getByRole("button", { name: "发送并启动 Run" }).isDisabled())) {
    throw new Error("CONTROL_CENTER_OFFLINE_MUTATION_ENABLED");
  }
  await context.setOffline(false);
  await waitForConnected(page);

  const background = await context.newPage();
  await background.goto("about:blank");
  await background.waitForTimeout(1_200);
  await page.bringToFront();
  await waitForConnected(page);
  await background.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "显示内容" }).click();
  await page.getByRole("button", { name: "发送并启动 Run" }).waitFor();
  await page.getByRole("button", { name: "显示列表" }).click();
  if (
    !(await page.locator(".list-pane").isVisible()) ||
    (await page.locator(".content-pane").isVisible())
  ) {
    throw new Error("CONTROL_CENTER_MOBILE_LIST_VIEW_INVALID");
  }
  await page.getByRole("button", { name: "显示详情" }).click();
  if (
    !(await page.locator(".details-pane").isVisible()) ||
    (await page.locator(".content-pane").isVisible())
  ) {
    throw new Error("CONTROL_CENTER_MOBILE_DETAILS_VIEW_INVALID");
  }
  const targetHeights = await page
    .locator("button:visible, .primary-nav a:visible")
    .evaluateAll((targets) => targets.map((target) => target.getBoundingClientRect().height));
  const minimumTargetHeight = Math.min(...targetHeights);
  if (minimumTargetHeight < 44) throw new Error("CONTROL_CENTER_TOUCH_TARGET_TOO_SMALL");
  await assertNoDocumentOverflow(page, "390px");
  await assertAxeClean(page, "mobile-zh-CN");

  await page.setViewportSize({ width: 320, height: 640 });
  await assertNoDocumentOverflow(page, "320px-equivalent-400-percent-reflow");

  await page.setViewportSize({ width: 1280, height: 800 });
  const layoutRanges = page.locator(".layout-controls input[type=range]");
  await layoutRanges.nth(0).fill("31");
  await layoutRanges.nth(1).fill("29");
  const savedPreferences = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("himawari.control-center.v1.preferences") ?? "null"),
  );
  if (savedPreferences?.listPanePercent !== 31 || savedPreferences?.detailPanePercent !== 29) {
    throw new Error("CONTROL_CENTER_LAYOUT_PREFERENCES_NOT_PERSISTED");
  }

  const storageSnapshot = await page.evaluate(() =>
    Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter((key) => key !== null)
        .map((key) => [key, localStorage.getItem(key)]),
    ),
  );
  const allowedStorageKey =
    /^himawari\.control-center\.v1\.(?:draft\.[A-Za-z0-9._:-]+|lastCursor|locale|preferences)$/;
  const unexpectedStorageKeys = Object.keys(storageSnapshot).filter(
    (key) => !allowedStorageKey.test(key),
  );
  if (unexpectedStorageKeys.length > 0) {
    throw new Error(`CONTROL_CENTER_STORAGE_BOUNDARY_FAILED:${unexpectedStorageKeys.join(",")}`);
  }

  await page.close();
  page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("http://127.0.0.1:4173/threads?view=content");
  await waitForConnected(page);
  const cursorAfterReopen = await page.evaluate(() =>
    localStorage.getItem("himawari.control-center.v1.lastCursor"),
  );
  if (!cursorAfterReopen || cursorAfterReopen === cursorBeforeOffline) {
    throw new Error("CONTROL_CENTER_CURSOR_NOT_RECOVERED");
  }
  if ((await page.locator("html").getAttribute("lang")) !== "zh-CN") {
    throw new Error("CONTROL_CENTER_REOPEN_LOCALE_NOT_RECOVERED");
  }
  const unexpectedBrowserErrors = browserErrors.filter(
    (error) =>
      !error.includes("/api/gateway/v2/events") || !error.includes("access control checks"),
  );
  if (unexpectedBrowserErrors.length > 0) {
    throw new Error(`CONTROL_CENTER_PAGE_ERRORS:${unexpectedBrowserErrors.join("|")}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 2,
      engine: profile.engine.name(),
      profile: profileName,
      runtime: profile.runtime,
      browserVersion,
      platform: `${process.platform}-${process.arch}`,
      emulation: profile.emulation ?? null,
      surfaces: surfaces.map(({ label, policy }) => ({ label, policy })),
      journeys: ["thread-chat", "run-cancel", "read-only-task-disclosure"],
      routeStates: [
        "deep-link",
        "focus-management",
        "loading",
        "empty",
        "error",
        "degraded",
        "offline",
        "session-revoked",
      ],
      locales: ["zh-CN", "en", "ja"],
      keyboard: ["visible-focus", "settings-tabs-roving"],
      sse: ["offline-reconnect", "background-tab", "close-reopen"],
      responsive: ["desktop-three-pane", "mobile-single-pane", "320px-reflow"],
      minimumTargetHeight,
      axeViolations: 0,
      keyboardFocus,
      semanticLandmarks: ["navigation", "main", "heading", "complementary"],
      nonColorConnectionStatus: true,
      unsafeBaselineMutations: 0,
      expectedOfflineTransportErrors: browserErrors.length - unexpectedBrowserErrors.length,
      browserStorageKeys: Object.keys(storageSnapshot).sort(),
      cursorAfterReopen,
    })}\n`,
  );
} finally {
  await browser?.close().catch(() => undefined);
  server.kill("SIGTERM");
}
