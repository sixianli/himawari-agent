import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium, devices, expect, firefox, webkit } from "@playwright/test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { expectedOfflineTransportError, watchPageErrors } from "./browser-page-errors.mjs";
import { createBrowserObservation } from "./ci/browser-observation.mjs";
import { parseArguments } from "./ci/contracts.mjs";
import { redactText } from "./ci/security-redaction.mjs";
import { qualifyPageErrorFilter } from "./test-browser-page-errors-browser.mjs";
import { qualifyControlCenterV4 } from "./test-control-center-v4.mjs";
import { qualifyExecutionChainFixture } from "./test-execution-chain-browser.mjs";
import { qualifyMobileComposer } from "./test-mobile-composer-browser.mjs";

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
async function showNavigation(page) {
  const toggle = page.locator(".mobile-sidebar-toggle");
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}

async function threadAction(page, name, threadId = "thread-main") {
  await showNavigation(page);
  const row = page
    .locator(".thread-row")
    .filter({ has: page.locator(`a[href="/threads/${threadId}"]`) });
  await row.getByRole("button").click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

export async function qualifyDeploymentAvailability(page, baseUrl) {
  await page.route("**/api/control-center/v1/config", async (route) => {
    const response = await route.fetch();
    const configuration = await response.json();
    await route.fulfill({
      response,
      json: {
        ...configuration,
        installedGatewayV2Operations: ["approval.list", "approval.detail", "approval.respond"],
      },
    });
  });
  await page.goto(`${baseUrl}/inbox`);
  await page.getByText("找不到这个页面", { exact: true }).waitFor();
  let unsupportedQueries = 0;
  const countQueries = (request) => {
    if (request.url().endsWith("/api/gateway/v2/queries")) unsupportedQueries += 1;
  };
  page.on("request", countQueries);
  const unavailableRoutes = [
    "/tasks",
    "/inbox",
    "/capabilities",
    "/authorizations",
    "/workspaces",
    "/suggestions",
    "/reflection",
    "/workers",
    "/improvements",
    "/trace",
    "/sessions",
  ];
  for (const route of unavailableRoutes) {
    await page.goto(`${baseUrl}${route}`);
    await page.getByText("找不到这个页面", { exact: true }).waitFor();
    if (await page.getByText("PORT_NOT_AUTHORITATIVE", { exact: true }).count())
      throw new Error("CONTROL_CENTER_UNINSTALLED_SHOWN_AS_DENIED");
  }
  if (unsupportedQueries !== 0) throw new Error("CONTROL_CENTER_UNINSTALLED_QUERY_SENT");
  page.off("request", countQueries);
  await page.goto(`${baseUrl}/approvals`);
  await showNavigation(page);
  await page.getByText("approval-approve", { exact: true }).waitFor();
  await page.goto(`${baseUrl}/health`);
  await page.getByText("model-provider", { exact: true }).waitFor();
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  if (violations.length) throw new Error("CONTROL_CENTER_AVAILABILITY_AXE_FAILED");
  return {
    unavailablePages: unavailableRoutes.length,
    unsupportedQueries,
    approvalVisible: true,
    healthVisible: true,
    axeViolations: violations.length,
  };
}

export async function qualifyBrowser({
  profileName = "chromium",
  staticRoot = path.join(repositoryRoot, "apps/control-center/dist"),
  reportDirectory,
  port = 0,
  fault = null,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("CONTROL_CENTER_PORT_INVALID");
  if (
    ![null, "page-error", "broken-button", "missing-translation", "accessibility"].includes(fault)
  )
    throw new Error("CONTROL_CENTER_FAULT_INVALID");
  await readFile(path.join(staticRoot, "index.html"));
  if (reportDirectory) await mkdir(reportDirectory, { recursive: true });
  let baseUrl;
  let primaryError;
  let cleanupFailure;
  let reportResult;
  let tracedContext;
  let diagnosticPage;
  const diagnostics = [];
  const requestErrors = [];
  const networkEmulation = [];
  const browserErrors = [];
  const pageErrorDetails = [];
  const observation = createBrowserObservation({
    redact: (text) => redactText(text, { sentinels }),
  });
  let phase = "initialization";
  function observePageErrors(page) {
    observation.watchPage(page);
    watchPageErrors(page, (error) => {
      browserErrors.push(error.message);
      pageErrorDetails.push({
        phase,
        url: page.url(),
        message: redactText(error.message, { sentinels }),
        stack: redactText(error.stack ?? "", { sentinels }),
      });
    });
  }
  const expectedAborts = new Set([
    "net::ERR_ABORTED",
    "NS_BINDING_ABORTED",
    "Load request cancelled",
    "cancelled",
  ]);
  const sentinels = ["fixture-machine-secret-value"];
  const profile = profiles[profileName];
  if (!profile) throw new Error(`CONTROL_CENTER_BROWSER_PROFILE_INVALID:${profileName}`);

  async function setEmulatedOffline(context, page, offline) {
    await context.setOffline(offline);
    const state = await page.evaluate(async (offline) => {
      let reachable = false;
      try {
        reachable = (await fetch(`/?network-probe=${offline}`, { cache: "no-store" })).ok;
      } catch {}
      return { reachable, onlineHint: navigator.onLine };
    }, offline);
    if (state.reachable === offline)
      throw new Error(`CONTROL_CENTER_NETWORK_EMULATION_INVALID:${JSON.stringify(state)}`);
    const supplementedOnlineEvent =
      !offline && profile.engine === webkit && process.platform === "linux" && !state.onlineHint;
    if (supplementedOnlineEvent)
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
    networkEmulation.push({ offline, ...state, supplementedOnlineEvent });
  }

  const server = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HIMAWARI_BROWSER_FIXTURE_PORT: String(port),
      HIMAWARI_BROWSER_STATIC_ROOT: staticRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  async function waitForServer() {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("CONTROL_CENTER_FIXTURE_TIMEOUT")), 10_000);
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`CONTROL_CENTER_FIXTURE_EXIT:${code}`));
      });
      server.stdout.on("data", (chunk) => {
        output += String(chunk);
        const match = /CONTROL_CENTER_FIXTURE_READY (http:\/\/127\.0\.0\.1:\d+)/u.exec(output);
        if (match) {
          clearTimeout(timer);
          baseUrl = match[1];
          resolve();
        }
      });
      server.stderr.on("data", (chunk) =>
        process.stderr.write(redactText(String(chunk), { sentinels })),
      );
    });
  }

  function watchPage(page) {
    diagnosticPage = page;
    page.on("requestfailed", (request) => {
      if (!["document", "script", "stylesheet"].includes(request.resourceType())) return;
      const failure = request.failure()?.errorText ?? "unknown";
      if (!expectedAborts.has(failure))
        requestErrors.push({ path: new URL(request.url()).pathname, failure });
    });
    page.on("response", (response) => {
      if (
        ["document", "script", "stylesheet"].includes(response.request().resourceType()) &&
        response.status() >= 400
      )
        requestErrors.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
  }

  async function waitForText(locator, text) {
    await locator.filter({ hasText: text }).waitFor({ state: "visible", timeout: 5_000 });
  }

  async function waitForConnected(page) {
    await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "connected", {
      timeout: 15000,
    });
  }

  async function waitForAccepted(page) {
    try {
      await waitForText(page.getByRole("status"), "已接纳");
    } catch (error) {
      const mainText = await page.getByRole("main").innerText();
      throw new Error(`CONTROL_CENTER_MUTATION_NOT_ACCEPTED:${mainText}`, { cause: error });
    }
  }

  async function performGovernanceAction(page, actionLabel) {
    await page.getByRole("button", { name: actionLabel, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认治理操作" });
    await dialog.getByLabel("我已核对当前权威快照和操作影响。").check();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/gateway/v2/commands"),
    );
    await dialog.getByRole("button", { name: actionLabel, exact: true }).click();
    const response = await responsePromise;
    await waitForAccepted(page);
    return response;
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
    { label: "审批", title: "审批", policy: "allowed" },
    { label: "能力与适配器", title: "能力与适配器", policy: "allowed" },
    { label: "授权与 Grant", title: "授权与 Grant", policy: "allowed" },
    { label: "设置", title: "设置", policy: "allowed" },
    { label: "健康与部署", title: "健康与部署", policy: "allowed" },
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

  const minimumTouchTargetPixels = { answerAction: 36, other: 40 };

  let browser;
  let page;
  try {
    await waitForServer();
    browser = await profile.engine.launch({
      headless: true,
      timeout: 30_000,
      ...profile.launchOptions,
    });
    const browserVersion = browser.version();
    phase = "page-error-filter";
    const pageErrorFilter = await qualifyPageErrorFilter(browser);
    phase = "mobile-composer";
    const mobileComposer = await qualifyMobileComposer(browser, baseUrl, reportDirectory);
    phase = "v4-startup";
    const v4Journeys = await qualifyControlCenterV4(browser, baseUrl, reportDirectory);
    phase = "execution-chain";
    const executionChain = await qualifyExecutionChainFixture(
      browser,
      path.join(reportDirectory ?? ".ci-output/browser", "execution-chain"),
      staticRoot,
    );
    phase = "initialization";
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
      ...profile.contextOptions,
    });
    tracedContext = context;
    if (reportDirectory)
      await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    context.on("page", watchPage);
    if (fault === "missing-translation")
      await context.route("**/assets/en-*.js", (route) => route.abort("failed"));
    await context.addInitScript(() => {
      window.__himawariSafeLogs = [];
      window.addEventListener("himawari:safe-log", (event) => {
        window.__himawariSafeLogs.push(event.detail);
      });
    });
    page = await context.newPage();
    observePageErrors(page);
    await page.goto(`${baseUrl}/threads/thread-main?view=content`);
    await waitForConnected(page);
    const brandLoaded = await page
      .locator(".himawari-brand svg")
      .first()
      .evaluate((mark) => {
        const box = mark.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && mark.querySelectorAll("circle").length > 0;
      });
    if (!brandLoaded) throw new Error("CONTROL_CENTER_BRAND_IMAGE_NOT_LOADED");
    if (fault === "page-error") {
      const receivedError = page.waitForEvent("pageerror");
      await page.evaluate(() =>
        setTimeout(() => {
          throw new Error("CONTROL_CENTER_INJECTED_PAGE_ERROR");
        }, 0),
      );
      await receivedError;
      if (browserErrors.length)
        throw new Error(`CONTROL_CENTER_PAGE_ERRORS:${browserErrors.join("|")}`);
    }
    if (fault === "broken-button")
      await page.getByRole("button", { name: "发送" }).evaluate((button) => button.remove());
    if (fault === "accessibility") {
      await page.evaluate(() => document.body.append(document.createElement("button")));
      await assertAxeClean(page, "injected-accessibility-regression");
    }

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
    if (profile.emulation) await showNavigation(page);
    const ariaSnapshot = await page.locator("body").ariaSnapshot();
    const requiredLandmarks = profile.emulation
      ? ["navigation", "main", "heading"]
      : ["navigation", "main", "heading", "complementary"];
    for (const requiredLandmark of requiredLandmarks) {
      if (!ariaSnapshot.includes(requiredLandmark)) {
        throw new Error(`CONTROL_CENTER_ARIA_LANDMARK_MISSING:${requiredLandmark}`);
      }
    }

    if (profile.emulation) await page.locator(".mobile-sidebar-toggle").click();

    let csrfRefreshes = 0;
    const csrfRequests = [];
    const refreshRoute = async (route) => {
      csrfRefreshes += 1;
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), csrfToken: "csrf-renewed-fixture" },
      });
    };
    const expiredRoute = async (route) => {
      const request = route.request();
      csrfRequests.push({ body: request.postData(), headers: request.headers() });
      if (csrfRequests.length === 1) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "HTTP_GATEWAY_CSRF_REJECTED" } }),
        });
      } else await route.continue();
    };
    await page.route("**/api/control-center/v1/config", refreshRoute);
    await page.route("**/api/payload/v1/text", expiredRoute);
    await page.getByLabel("消息草稿").fill("浏览器资格测试消息");
    await page.getByRole("button", { name: "发送" }).click();
    await waitForAccepted(page);
    if ((await page.getByLabel("消息草稿").inputValue()) !== "") {
      throw new Error("CONTROL_CENTER_DRAFT_NOT_CLEARED");
    }
    await page.getByText("浏览器资格测试消息", { exact: true }).waitFor();
    const [rejectedUpload, ...laterUploads] = csrfRequests;
    const retriedUpload = laterUploads.find(
      (request) =>
        request.headers["idempotency-key"] === rejectedUpload?.headers["idempotency-key"],
    );
    const parallelUpload = laterUploads.find((request) => request !== retriedUpload);
    if (
      csrfRefreshes !== 1 ||
      csrfRequests.length !== 3 ||
      !rejectedUpload.headers["idempotency-key"] ||
      rejectedUpload.headers["x-csrf-token"] === "csrf-renewed-fixture" ||
      !retriedUpload ||
      retriedUpload.body !== rejectedUpload.body ||
      retriedUpload.headers["x-csrf-token"] !== "csrf-renewed-fixture" ||
      !parallelUpload ||
      parallelUpload.headers["idempotency-key"] === rejectedUpload.headers["idempotency-key"] ||
      JSON.stringify(
        [rejectedUpload, parallelUpload].map((request) => JSON.parse(request.body).content).sort(),
      ) !== JSON.stringify(["thread-action:submit", "浏览器资格测试消息"].sort())
    )
      throw new Error(
        `CONTROL_CENTER_CSRF_REFRESH_INVALID:${JSON.stringify({ csrfRefreshes, requests: csrfRequests.map((request) => ({ body: request.body, token: request.headers["x-csrf-token"], idempotencyKey: request.headers["idempotency-key"] })) })}`,
      );
    await page.unroute("**/api/control-center/v1/config", refreshRoute);
    await page.unroute("**/api/payload/v1/text", expiredRoute);

    await expect(page.getByRole("button", { name: "显示详情", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("回答语言", { exact: true })).toHaveCount(0);
    await showNavigation(page);
    const threadSearch = page.getByRole("searchbox", { name: "搜索对话", exact: true });
    await threadSearch.fill("计划");
    await threadSearch.press("Enter");
    await page
      .locator(".thread-search-results")
      .getByRole("link")
      .filter({ hasText: "主对话" })
      .first()
      .click();
    await threadSearch.fill("");
    await threadAction(page, "重命名");
    await page.getByLabel("会话名称").fill("多客户端冲突后的标题");
    await page.evaluate(() =>
      fetch("/__fixture/conflict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-main" }),
      }),
    );
    await page.getByLabel("会话名称").press("Enter");
    await page.getByText("这个对话刚在别处改过", { exact: true }).waitFor();
    await page.getByRole("button", { name: "按最新内容再操作一次", exact: true }).click();
    await waitForAccepted(page);
    await page.getByRole("heading", { name: "多客户端冲突后的标题", exact: true }).waitFor();

    const peer = await context.newPage();
    observePageErrors(peer);
    await peer.goto(`${baseUrl}/threads/thread-main?view=details`);
    await waitForConnected(peer);
    await threadAction(peer, "取消置顶");
    await waitForAccepted(peer);
    await expect(
      page.locator('.thread-row[data-pinned="false"] a[href="/threads/thread-main"]'),
    ).toHaveCount(1);
    await peer.close();
    diagnosticPage = page;

    await threadAction(page, "归档");
    await page.getByText("这个会话仍有待确认的操作，请先处理后再归档。", { exact: true }).waitFor();
    await threadAction(page, "归档", "thread-research");
    await waitForAccepted(page);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "数据", exact: true }).click();
    await page.getByRole("button", { name: /已归档会话/ }).click();
    await page
      .locator(".archived-conversations li")
      .filter({ hasText: "研究记录" })
      .getByRole("button", { name: "恢复", exact: true })
      .click();
    await expect(
      page.locator(".archived-conversations li").filter({ hasText: "研究记录" }),
    ).toHaveCount(0);
    await page.getByRole("dialog", { name: "设置", exact: true }).press("Escape");
    await expect(page.getByRole("button", { name: "移入回收站", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "检查删除影响", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "分出新对话", exact: true }).first().click();
    await page.waitForURL(/\/threads\/thread-fork%3A|\/threads\/thread-fork:/);
    await expect(page.locator(".thread-message-owner")).not.toHaveCount(0);
    await page.goto(`${baseUrl}/threads/thread-main?view=content`);
    await waitForConnected(page);

    for (const surface of surfaces) {
      await page.goto(
        `${baseUrl}/${{ 对话: "threads", 会話: "threads", 审批: "approvals", 能力与适配器: "capabilities", "授权与 Grant": "authorizations", 设置: "settings", 健康与部署: "health" }[surface.label]}`,
      );
      if (surface.label === "对话") await page.locator("#page-title").waitFor();
      else await page.getByRole("heading", { name: surface.title, exact: true }).waitFor();
      const routeFocused =
        surface.label === "设置"
          ? await page
              .getByRole("dialog", { name: "设置", exact: true })
              .evaluate((dialog) => dialog === document.activeElement)
          : await page.evaluate(() => document.activeElement?.id === "page-title");
      if (!routeFocused) {
        const focusedId = await page.evaluate(() => document.activeElement?.id ?? null);
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

    for (const removedRoute of [
      "/tasks",
      "/inbox",
      "/trace",
      "/tasks/job-repository-monitor",
      "/inbox/inbox-01",
      "/memory/memory-01",
      "/trace/trace-01",
    ]) {
      await page.goto(`${baseUrl}${removedRoute}?view=details`);
      await waitForConnected(page);
      await page.getByText("找不到这个页面", { exact: true }).waitFor();
    }

    const chooseLocale = async (optionText) => {
      await page.goto(`${baseUrl}/settings`);
      await page.locator(".settings-nav button").nth(1).click();
      await page.locator(".settings-content .dropdown-trigger").first().click();
      await page.getByRole("option", { name: optionText, exact: true }).click();
    };
    await chooseLocale("English");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await page.goto(`${baseUrl}/approvals`);
    await page.getByRole("heading", { name: "Approvals", exact: true }).waitFor();
    await chooseLocale("日本語");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");

    await page.goto(`${baseUrl}/threads`);
    await showNavigation(page);
    await page.locator('.list-pane a[href="/threads/thread-main"]').click();
    await page.getByRole("heading", { name: "多客户端冲突后的标题", exact: true }).waitFor();
    await page.getByText("浏览器资格测试消息", { exact: true }).waitFor();
    await waitForConnected(page, "リアルタイム接続");
    const japaneseDraft = "日本語の長文入力とレイアウトを確認するための未送信メッセージです。";
    await page.getByLabel("メッセージ下書き").fill(japaneseDraft);
    if ((await page.getByLabel("メッセージ下書き").inputValue()) !== japaneseDraft) {
      throw new Error("CONTROL_CENTER_JA_INPUT_NOT_PRESERVED");
    }
    await assertNoDocumentOverflow(page, "desktop-ja-long-input");
    await assertAxeClean(page, "desktop-ja");
    await page.getByLabel("メッセージ下書き").fill("");
    await chooseLocale("简体中文");
    await page.locator("dialog[open], [role=dialog]").first().press("Escape");
    if (
      (await page.evaluate(() => localStorage.getItem("himawari.control-center.v1.locale"))) !==
      "zh-CN"
    ) {
      throw new Error("CONTROL_CENTER_LOCALE_NOT_PERSISTED");
    }

    await page.goto(`${baseUrl}/capabilities/capability-review?view=details`);
    await waitForConnected(page);
    await page.getByRole("heading", { name: "能力与适配器", exact: true }).waitFor();
    await showNavigation(page);
    await page
      .getByText("capability-review", { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor();

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

    await page.goto(`${baseUrl}/approvals`);
    await showNavigation(page);
    await page.getByText("正在加载…", { exact: true }).filter({ visible: true }).first().waitFor();
    releaseLoading?.();
    await loadingComplete;
    await page.unroute("**/api/gateway/v2/queries", loadingHandler);
    await showNavigation(page);
    await waitForText(page.locator(".list-pane"), "approval-approve");

    const hiddenExecutionStatus = await page.evaluate(() =>
      fetch("/api/capabilities/capability-review/execute", { method: "POST" }).then(
        (response) => response.status,
      ),
    );
    if (hiddenExecutionStatus !== 404) {
      throw new Error(
        `CONTROL_CENTER_UNAPPROVED_CAPABILITY_ROUTE_PRESENT:${hiddenExecutionStatus}`,
      );
    }

    await page.goto(`${baseUrl}/approvals/approval-approve?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "sha256:approval-approve");
    await waitForText(page.getByRole("main"), "named_recipients");
    await waitForText(page.getByRole("main"), "1000");
    await performGovernanceAction(page, "批准");
    await page.getByText("approved", { exact: true }).waitFor();
    await waitForText(page.getByRole("main"), "result:approval-approve:approved");

    await page.goto(`${baseUrl}/approvals/approval-deny?view=details`);
    await waitForConnected(page);
    await performGovernanceAction(page, "拒绝");
    await page.getByText("denied", { exact: true }).waitFor();

    await page.evaluate(() =>
      fetch("/__fixture/recent-auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ available: false }),
      }),
    );
    const reauthenticationContext = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
      ...profile.contextOptions,
    });
    const reauthenticationPage = await reauthenticationContext.newPage();
    observePageErrors(reauthenticationPage);
    await reauthenticationPage.goto(`${baseUrl}/approvals/approval-recent-auth?view=details`);
    await waitForConnected(reauthenticationPage);
    await reauthenticationPage.getByRole("button", { name: "批准", exact: true }).click();
    const reauthenticationDialog = reauthenticationPage.getByRole("dialog", {
      name: "确认治理操作",
    });
    await reauthenticationDialog.getByLabel("我已核对当前权威快照和操作影响。").check();
    await reauthenticationDialog.getByText("此操作需要近期重新认证。", { exact: true }).waitFor();
    if (!(await reauthenticationDialog.getByRole("button", { name: "批准" }).isDisabled())) {
      throw new Error("CONTROL_CENTER_RECENT_AUTHENTICATION_GATE_BYPASSED");
    }
    await reauthenticationContext.close();
    await page.evaluate(() =>
      fetch("/__fixture/recent-auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ available: true }),
      }),
    );

    await page.goto(`${baseUrl}/capabilities/capability-review?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "publisher:fixture-reviewed");
    await waitForText(page.getByRole("main"), "secret-ref-provider-token");
    if ((await page.getByRole("main").innerText()).includes("fixture-machine-secret-value")) {
      throw new Error("CONTROL_CENTER_RAW_MACHINE_SECRET_EXPOSED");
    }
    await performGovernanceAction(page, "完成来源审查");
    await page.getByText("installation_proposed", { exact: true }).waitFor();
    await performGovernanceAction(page, "批准并激活安装");
    await page.getByText("active", { exact: true }).first().waitFor();

    await page.goto(`${baseUrl}/capabilities/capability-update-approve?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "1.0.0 → 2.0.0");
    await performGovernanceAction(page, "批准并激活更新");
    await waitForText(page.getByRole("main"), "2.0.0");
    await performGovernanceAction(page, "回退能力版本");
    await waitForText(page.getByRole("main"), "rolled_back");
    await performGovernanceAction(page, "停用能力");
    await page.getByText("disabled", { exact: true }).waitFor();

    await page.goto(`${baseUrl}/capabilities/capability-update-deny?view=details`);
    await waitForConnected(page);
    await performGovernanceAction(page, "拒绝更新");
    await page.getByText("active", { exact: true }).first().waitFor();

    await page.goto(`${baseUrl}/authorizations/grant-active?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "task-dependent-01");
    await page.getByRole("button", { name: "撤销 Grant", exact: true }).click();
    await page.evaluate(() =>
      fetch("/__fixture/governance-conflict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objectRef: "grant-active" }),
      }),
    );
    const conflictDialog = page.getByRole("dialog", { name: "确认治理操作" });
    await conflictDialog.getByLabel("我已核对当前权威快照和操作影响。").check();
    const conflictResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/gateway/v2/commands"),
    );
    await conflictDialog.getByRole("button", { name: "撤销 Grant", exact: true }).click();
    if ((await conflictResponsePromise).status() !== 409) {
      throw new Error("CONTROL_CENTER_GOVERNANCE_CONFLICT_NOT_REJECTED");
    }
    await page.getByText("其他客户端已更新此治理对象", { exact: true }).waitFor();
    await performGovernanceAction(page, "撤销 Grant");
    await page.getByText("revoked", { exact: true }).waitFor();

    await page.goto(`${baseUrl}/capabilities/capability-active?view=details`);
    await waitForConnected(page);
    await page.getByRole("button", { name: "停用能力", exact: true }).click();
    phase = "offline";
    await setEmulatedOffline(context, page, true);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "offline");
    const offlineGovernanceDialog = page.getByRole("dialog", { name: "确认治理操作" });
    await offlineGovernanceDialog.getByLabel("我已核对当前权威快照和操作影响。").check();
    if (!(await offlineGovernanceDialog.getByRole("button", { name: "停用能力" }).isDisabled())) {
      throw new Error("CONTROL_CENTER_OFFLINE_GOVERNANCE_MUTATION_ENABLED");
    }
    phase = "reconnecting";
    await setEmulatedOffline(context, page, false);
    await waitForConnected(page);
    await offlineGovernanceDialog.getByRole("button", { name: "关闭", exact: true }).last().click();

    const errorHandler = async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "CONTROL_CENTER_FIXTURE_UNAVAILABLE" } }),
      });
    };
    await page.route("**/api/gateway/v2/queries", errorHandler);

    await page.goto(`${baseUrl}/approvals`);
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
    const revokedResponse = page.waitForResponse(
      (response) => response.url().endsWith("/api/gateway/v2/queries") && response.status() === 401,
    );
    await page.goto(`${baseUrl}/approvals`);
    await revokedResponse;
    await page.getByText("正在进入 Himawari…", { exact: true }).waitFor();
    if ((await page.getByText("approval-approve", { exact: true }).count()) > 0) {
      throw new Error("CONTROL_CENTER_REVOKED_SESSION_VIEW_STATE_RETAINED");
    }
    await page.unroute("**/api/gateway/v2/queries", revokedSessionHandler);
    await page.reload();
    await waitForConnected(page);

    await page.goto(`${baseUrl}/capabilities`);
    await showNavigation(page);
    await page
      .getByText("capability-review", { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor();

    await page.evaluate(() => fetch("/__fixture/degrade", { method: "POST" }));

    await page.goto(`${baseUrl}/health`);
    await waitForText(page.getByRole("main"), "degraded");

    await assertAxeClean(page, "desktop-zh-CN");

    const cursorBeforeOffline = await page.evaluate(() =>
      localStorage.getItem("himawari.control-center.v1.threadLastCursor"),
    );

    await page.goto(`${baseUrl}/threads`);
    await showNavigation(page);
    await page.locator('.list-pane a[href="/threads/thread-main"]').click();
    await page.getByRole("heading", { name: "多客户端冲突后的标题", exact: true }).waitFor();
    await page.getByText("浏览器资格测试消息", { exact: true }).waitFor();
    await waitForConnected(page);
    await page.getByLabel("消息草稿").fill("离线草稿");
    phase = "offline";
    await setEmulatedOffline(context, page, true);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-connection", "offline");
    if (!(await page.getByRole("button", { name: "发送" }).isDisabled())) {
      throw new Error("CONTROL_CENTER_OFFLINE_MUTATION_ENABLED");
    }
    phase = "reconnecting";
    await setEmulatedOffline(context, page, false);
    await waitForConnected(page);

    const background = await context.newPage();
    await background.goto("about:blank");
    await background.waitForTimeout(1_200);
    await page.bringToFront();
    await waitForConnected(page);
    await background.close();

    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.getByRole("button", { name: "关闭", exact: true }).isVisible())
      await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "发送" }).waitFor();
    await page.getByRole("button", { name: "显示列表" }).click();
    if (
      !(await page.locator(".list-pane").isVisible()) ||
      !(await page.locator(".content-pane").isVisible())
    ) {
      throw new Error("CONTROL_CENTER_MOBILE_LIST_VIEW_INVALID");
    }
    await expect(page.getByRole("button", { name: "显示详情", exact: true })).toHaveCount(0);
    const smallTargets = await page.locator("button:visible, .primary-nav a:visible").evaluateAll(
      (targets, minimums) =>
        targets
          .map((target) => ({
            label: (target.getAttribute("aria-label") ?? target.textContent ?? "")
              .trim()
              .slice(0, 30),
            height: target.getBoundingClientRect().height,
            minimum: target.classList.contains("answer-action")
              ? minimums.answerAction
              : minimums.other,
          }))
          .filter((target) => target.height < target.minimum),
      minimumTouchTargetPixels,
    );
    if (smallTargets.length > 0)
      throw new Error(`CONTROL_CENTER_TOUCH_TARGET_TOO_SMALL:${JSON.stringify(smallTargets)}`);
    await assertNoDocumentOverflow(page, "390px");
    await assertAxeClean(page, "mobile-zh-CN");

    await page.setViewportSize({ width: 320, height: 640 });
    await assertNoDocumentOverflow(page, "320px-equivalent-400-percent-reflow");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".settings-nav button").nth(1).click();
    await page
      .locator(".theme-switch label")
      .filter({ has: page.locator('input[value="light"]') })
      .click();
    const savedPreferences = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("himawari.control-center.v1.preferences") ?? "null"),
    );
    if (savedPreferences?.theme !== "light") throw new Error("CONTROL_CENTER_THEME_NOT_PERSISTED");
    await page.getByRole("dialog", { name: "设置", exact: true }).press("Escape");
    const storageSnapshot = await page.evaluate(() =>
      Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
          .filter((key) => key !== null)
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    );
    const allowedStorageKey =
      /^himawari\.control-center\.v1\.(?:draft\.[A-Za-z0-9._:-]+|lastCursor|threadLastCursor|locale|preferences)$/;
    const unexpectedStorageKeys = Object.keys(storageSnapshot).filter(
      (key) => !allowedStorageKey.test(key),
    );
    if (unexpectedStorageKeys.length > 0) {
      throw new Error(`CONTROL_CENTER_STORAGE_BOUNDARY_FAILED:${unexpectedStorageKeys.join(",")}`);
    }
    const browserPrivacy = await page.evaluate(async () => {
      const databaseNames =
        typeof indexedDB.databases === "function"
          ? (await indexedDB.databases()).map(({ name }) => name ?? "<unnamed>")
          : [];
      const cacheNames = "caches" in window ? await caches.keys() : [];
      const serviceWorkers =
        "serviceWorker" in navigator
          ? (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => scope)
          : [];
      const sessionStorageKeys = Array.from({ length: sessionStorage.length }, (_, index) =>
        sessionStorage.key(index),
      ).filter((key) => key !== null);
      return {
        databaseNames,
        cacheNames,
        serviceWorkers,
        sessionStorageKeys,
        safeLogs: window.__himawariSafeLogs ?? [],
      };
    });
    if (
      browserPrivacy.databaseNames.length > 0 ||
      browserPrivacy.cacheNames.length > 0 ||
      browserPrivacy.serviceWorkers.length > 0 ||
      browserPrivacy.sessionStorageKeys.length > 0
    ) {
      throw new Error(
        `CONTROL_CENTER_BROWSER_PRIVATE_CACHE_FAILED:${JSON.stringify(browserPrivacy)}`,
      );
    }
    const serializedSafeLogs = JSON.stringify(browserPrivacy.safeLogs);
    for (const forbiddenLogValue of ["机器秘密", "semanticSnapshotHash", "authentication:owner"]) {
      if (serializedSafeLogs.includes(forbiddenLogValue)) {
        throw new Error(`CONTROL_CENTER_SAFE_LOG_LEAK:${forbiddenLogValue}`);
      }
    }

    phase = "close-and-reopen";
    await page.close();
    page = await context.newPage();
    observePageErrors(page);
    await page.goto(`${baseUrl}/threads?view=content`);
    await waitForConnected(page);
    const cursorAfterReopen = await page.evaluate(() =>
      localStorage.getItem("himawari.control-center.v1.threadLastCursor"),
    );
    if (!cursorAfterReopen || cursorAfterReopen !== cursorBeforeOffline) {
      throw new Error("CONTROL_CENTER_CURSOR_NOT_RECOVERED");
    }
    if ((await page.locator("html").getAttribute("lang")) !== "zh-CN") {
      throw new Error("CONTROL_CENTER_REOPEN_LOCALE_NOT_RECOVERED");
    }
    await page.goto(`${baseUrl}/threads/thread-main?view=content`);
    await waitForConnected(page);
    await page.getByText("浏览器资格测试消息", { exact: true }).waitFor();
    await expect(page.locator(".thread-message-owner")).toContainText([
      "请总结当前计划。",
      "浏览器资格测试消息",
    ]);

    await page.goto(`${baseUrl}/approvals`);
    await showNavigation(page);
    await page.getByText("approval-approve", { exact: true }).waitFor();

    await page.goto(`${baseUrl}/capabilities`);
    await showNavigation(page);
    await page
      .getByText("capability-review", { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor();
    const expectedOfflineBrowserError = (error) =>
      expectedOfflineTransportError(error, baseUrl, [
        "/api/gateway/v2/events",
        "/api/gateway/thread/v3/events",
        "/api/gateway/thread/v3/execution-events",
        "/api/gateway/thread/v3/queries",
      ]);
    if (requestErrors.length)
      throw new Error(`CONTROL_CENTER_CRITICAL_REQUEST_FAILED:${JSON.stringify(requestErrors)}`);
    const unexpectedBrowserErrors = browserErrors.filter(
      (error) => !expectedOfflineBrowserError(error),
    );
    if (unexpectedBrowserErrors.length > 0) {
      throw new Error(`CONTROL_CENTER_PAGE_ERRORS:${unexpectedBrowserErrors.join("|")}`);
    }

    phase = "deployment-availability";
    await qualifyDeploymentAvailability(page, baseUrl);

    const report = {
      schemaVersion: 2,
      pageErrorFilter,
      mobileComposer,
      v4Journeys,
      executionChain,
      status: "passed",
      scope: "fixture-only",
      engine: profile.engine.name(),
      profile: profileName,
      runtime: profile.runtime,
      browserVersion,
      networkEmulation,
      platform: `${process.platform}-${process.arch}`,
      emulation: profile.emulation ?? null,
      surfaces: surfaces.map(({ label, policy }) => ({ label, policy })),
      journeys: [
        "brand-mark-rendered",
        "mobile-composer-prototype-layout-and-menus",
        "deployment-availability-no-unsupported-queries",
        "installed-health-dependencies",
        "thread-chat",
        "expired-csrf-refresh-preserves-command",
        "thread-ui-language-follows-settings",
        "thread-search",
        "thread-revision-conflict-reapply",
        "thread-archive-restore",
        "thread-deletion-controls-absent",
        "thread-fork",
        "thread-multi-tab",
        "approval-approve-deny",
        "approval-recent-authentication-gate",
        "capability-review-install",
        "capability-update-approve-deny",
        "capability-rollback-disable",
        "grant-revision-conflict-revoke",
        "governance-offline-no-mutation",
        "unapproved-capability-hidden-route-absent",
        "removed-operations-routes-not-found",
        "locale-and-theme-in-settings-dialog",
        "revoked-session-clears-private-view",
        "browser-private-storage-scan",
      ],
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
      keyboard: ["visible-focus", "settings-keyboard-navigation"],
      sse: [
        "durable-thread-cursor",
        "event-id-deduplication",
        "sequence-gap-snapshot-refresh",
        "authority-scope-snapshot-refresh",
        "offline-reconnect",
        "multi-tab",
        "close-reopen",
      ],
      privacy: {
        indexedDbDatabases: browserPrivacy.databaseNames.length,
        cacheEntries: browserPrivacy.cacheNames.length,
        serviceWorkers: browserPrivacy.serviceWorkers.length,
        sessionStorageKeys: browserPrivacy.sessionStorageKeys.length,
        safeLogEntries: browserPrivacy.safeLogs.length,
      },
      responsive: ["desktop-chat-with-contextual-preview", "mobile-single-pane", "320px-reflow"],
      minimumTouchTargetPixels,
      axeViolations: 0,
      keyboardFocus,
      semanticLandmarks: requiredLandmarks,
      nonColorConnectionStatus: true,
      unsafeBaselineMutations: 0,
      expectedOfflineTransportErrors: browserErrors.length - unexpectedBrowserErrors.length,
      browserStorageKeys: Object.keys(storageSnapshot).sort(),
      cursorAfterReopen,
    };
    if (reportDirectory)
      await writeFile(
        path.join(reportDirectory, "browser.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    reportResult = report;
  } catch (error) {
    primaryError = error;
    diagnosticPage = page;
    diagnostics.push({ phase, url: diagnosticPage?.url() });
    if (reportDirectory) {
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        try {
          await diagnosticPage.evaluate((secrets) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode())
              for (const secret of secrets)
                walker.currentNode.textContent = walker.currentNode.textContent.replaceAll(
                  secret,
                  "[REDACTED]",
                );
            for (const input of document.querySelectorAll("input, textarea"))
              for (const secret of secrets)
                input.value = input.value.replaceAll(secret, "[REDACTED]");
          }, sentinels);
          await diagnosticPage.screenshot({
            path: path.join(reportDirectory, "failure.png"),
            fullPage: true,
          });
          diagnostics.push("failure.png");
        } catch (captureError) {
          diagnostics.push(`screenshot unavailable: ${captureError.name}`);
        }
      }
      await writeFile(
        path.join(reportDirectory, "browser.json"),
        `${JSON.stringify({ schemaVersion: 2, status: "failed", scope: "fixture-only", engine: profile.engine.name(), error: redactText(error.message, { sentinels }), diagnostics, networkEmulation, pageErrors: pageErrorDetails }, null, 2)}\n`,
      );
    }
  } finally {
    const cleanupErrors = [];
    if (reportDirectory) {
      try {
        await writeFile(
          path.join(reportDirectory, "browser-observation.json"),
          `${JSON.stringify({ ...observation.snapshot(), profile: profileName, browserVersion: browser?.version() ?? null, platform: `${process.platform}-${process.arch}` }, null, 2)}\n`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (reportDirectory && tracedContext) {
      try {
        await tracedContext.tracing.stop({ path: path.join(reportDirectory, "trace.zip") });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await browser?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (server.exitCode === null && server.signalCode === null)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            server.kill("SIGKILL");
            reject(new Error("CONTROL_CENTER_FIXTURE_CLEANUP_TIMEOUT"));
          }, 5_000);
          server.once("exit", (code, signal) => {
            clearTimeout(timer);
            if (code === 0 || signal === "SIGTERM") resolve();
            else reject(new Error(`CONTROL_CENTER_FIXTURE_CLEANUP_FAILED:${code}:${signal}`));
          });
          server.kill("SIGTERM");
        });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      if (reportDirectory)
        await writeFile(
          path.join(reportDirectory, "cleanup.json"),
          `${JSON.stringify({ status: "failed", errors: cleanupErrors.map((error) => redactText(error.message, { sentinels })), originalFailure: primaryError ? redactText(primaryError.message, { sentinels }) : null })}\n`,
        );
      if (!primaryError)
        cleanupFailure = new AggregateError(cleanupErrors, "CONTROL_CENTER_CLEANUP_FAILED");
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupFailure) throw cleanupFailure;
  return reportResult;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2);
    const profileName = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "chromium";
    const args = parseArguments(argv, ["--static-root", "--report-directory", "--port", "--fault"]);
    const report = await qualifyBrowser({
      profileName,
      staticRoot: args["--static-root"],
      reportDirectory: args["--report-directory"],
      port: args["--port"] === undefined ? 0 : Number(args["--port"]),
      fault: args["--fault"] ?? null,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(
      `${redactText(error.message, { sentinels: ["fixture-machine-secret-value"] })}\n`,
    );
    process.exitCode = 1;
  }
}
