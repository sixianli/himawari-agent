import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium, devices, firefox, webkit } from "@playwright/test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { parseArguments } from "./ci/contracts.mjs";
import { createBrowserObservation } from "./ci/browser-observation.mjs";
import { redactText } from "./ci/security-redaction.mjs";

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
  const browserErrors = [];
  const pageErrorDetails = [];
  const observation = createBrowserObservation({
    redact: (text) => redactText(text, { sentinels }),
  });
  let phase = "initialization";
  function observePageErrors(page) {
    observation.watchPage(page);
    page.on("pageerror", (error) => {
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

  async function performOperationAction(page, actionLabel) {
    await page.getByRole("button", { name: actionLabel, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: actionLabel, exact: true });
    await dialog.getByLabel("我已核对目标、范围、副作用和当前修订。").check();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/gateway/v2/commands"),
    );
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
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
    { label: "后台任务", title: "后台任务", policy: "allowed" },
    { label: "收件箱与摘要", title: "收件箱与摘要", policy: "allowed" },
    { label: "记忆", title: "记忆", policy: "allowed" },
    { label: "能力与适配器", title: "能力与适配器", policy: "allowed" },
    { label: "授权与 Grant", title: "授权与 Grant", policy: "allowed" },
    { label: "追踪", title: "追踪", policy: "allowed" },
    { label: "设置", title: "设置", policy: "allowed" },
    { label: "会话与设备", title: "会话与设备", policy: "allowed" },
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
    let page = await context.newPage();
    observePageErrors(page);
    await page.goto(`${baseUrl}/threads/thread-main?view=content`);
    await waitForConnected(page);
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
      await page
        .getByRole("button", { name: "发送并启动 Run" })
        .evaluate((button) => button.remove());
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
    const ariaSnapshot = await page.locator("body").ariaSnapshot();
    const requiredLandmarks = profile.emulation
      ? ["navigation", "main", "heading"]
      : ["navigation", "main", "heading", "complementary"];
    for (const requiredLandmark of requiredLandmarks) {
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
    await page.getByText("浏览器资格测试消息", { exact: true }).waitFor();

    await page.getByLabel("回答语言").selectOption("en");
    await waitForAccepted(page);
    if ((await page.locator("html").getAttribute("lang")) !== "zh-CN") {
      throw new Error("CONTROL_CENTER_ANSWER_LOCALE_CHANGED_UI_LOCALE");
    }
    await page.getByRole("button", { name: "稳定检查点", exact: true }).click();
    await page.getByText("completed", { exact: true }).waitFor();
    await page.getByLabel("搜索对话").fill("计划");
    await page.getByRole("button", { name: "搜索对话", exact: true }).click();
    await page.getByRole("link").filter({ hasText: "主对话" }).first().waitFor();

    await page.getByLabel("重命名").fill("多客户端冲突后的标题");
    await page.evaluate(() =>
      fetch("/__fixture/conflict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-main" }),
      }),
    );
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    await page.getByText("其他客户端已更新此对话", { exact: true }).waitFor();
    await page.getByRole("button", { name: "在最新修订上重新应用", exact: true }).click();
    await waitForAccepted(page);
    await page.getByRole("heading", { name: "多客户端冲突后的标题", exact: true }).waitFor();

    const peer = await context.newPage();
    observePageErrors(peer);
    await peer.goto(`${baseUrl}/threads/thread-main?view=details`);
    await waitForConnected(peer);
    await peer.getByRole("button", { name: "取消置顶", exact: true }).click();
    await waitForAccepted(peer);
    await page.getByRole("button", { name: "置顶", exact: true }).waitFor();
    await peer.close();

    await page.getByRole("button", { name: "归档", exact: true }).click();
    await waitForAccepted(page);
    await page.getByRole("button", { name: "恢复", exact: true }).click();
    await waitForAccepted(page);
    await page.getByRole("button", { name: "检查删除影响", exact: true }).click();
    await page.getByText("可以进入删除确认", { exact: true }).waitFor();
    if (await page.getByRole("button", { name: "移入回收站", exact: true }).isDisabled()) {
      throw new Error("CONTROL_CENTER_DELETION_IMPACT_NOT_APPLIED");
    }

    await page.getByRole("button", { name: "从此轮 Fork", exact: true }).first().click();
    await waitForAccepted(page);
    await page.waitForURL(/\/threads\/thread-fork%3A|\/threads\/thread-fork:/);
    await page.getByText("thread-fork:", { exact: false }).first().waitFor();
    await page.goto(`${baseUrl}/threads/thread-main?view=content`);
    await waitForConnected(page);

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

    await page.goto(`${baseUrl}/tasks/job-repository-monitor?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "BUDGET_EXHAUSTED");
    await waitForText(page.getByRole("main"), "NOTIFY");
    await performOperationAction(page, "暂停");
    await page.getByText("paused", { exact: true }).waitFor();

    await page.goto(`${baseUrl}/inbox/inbox-01?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "digest-current");
    await waitForText(page.getByRole("main"), "result-daily-review-01");

    await page.goto(`${baseUrl}/memory/memory-01?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "approval-memory-01");
    await page.getByLabel("更正后的记忆内容").fill("修正后的敏感记忆正文");
    await performOperationAction(page, "更正");

    await page.goto(`${baseUrl}/trace/trace-01?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "fixture-provider");
    await waitForText(page.getByRole("main"), "model:fixture-primary:v1");

    await primaryNavigation.getByRole("link", { name: "设置", exact: true }).click();
    await waitForText(page.getByRole("main"), "model:fixture-fallback:v1");
    await waitForText(
      page.getByRole("main"),
      "github-app:blocked_credentials:secret-ref-github-app",
    );

    await page.goto(`${baseUrl}/sessions/session-01?view=details`);
    await waitForConnected(page);
    await waitForText(page.getByRole("main"), "Owner MacBook");

    const localeSelect = page.locator(".locale-control select");
    await localeSelect.selectOption("en");
    await page.getByRole("heading", { name: "Sessions and devices", exact: true }).waitFor();
    if ((await page.locator("html").getAttribute("lang")) !== "en") {
      throw new Error("CONTROL_CENTER_EN_LOCALE_NOT_APPLIED");
    }
    await localeSelect.selectOption("ja");
    await page.getByRole("heading", { name: "セッションとデバイス", exact: true }).waitFor();
    if ((await page.locator("html").getAttribute("lang")) !== "ja") {
      throw new Error("CONTROL_CENTER_JA_LOCALE_NOT_APPLIED");
    }
    const japaneseNavigation = page.getByRole("navigation", { name: "コントロールセンター機能" });
    await japaneseNavigation.getByRole("link", { name: "会話", exact: true }).click();
    await page.goto(`${baseUrl}/threads/thread-main?view=content`);
    await waitForConnected(page, "リアルタイム接続");
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

    await page.goto(`${baseUrl}/capabilities/capability-review?view=details`);
    await waitForConnected(page);
    await page.getByRole("heading", { name: "能力与适配器", exact: true }).waitFor();
    await page.getByText("capability-review", { exact: true }).first().waitFor();

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
    await page.getByText("正在加载权威状态", { exact: true }).first().waitFor();
    releaseLoading?.();
    await loadingComplete;
    await page.unroute("**/api/gateway/v2/queries", loadingHandler);
    await waitForText(page.getByRole("main"), "approval-approve");

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
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitForText(page.locator(".connection"), "离线");
    const offlineGovernanceDialog = page.getByRole("dialog", { name: "确认治理操作" });
    await offlineGovernanceDialog.getByLabel("我已核对当前权威快照和操作影响。").check();
    if (!(await offlineGovernanceDialog.getByRole("button", { name: "停用能力" }).isDisabled())) {
      throw new Error("CONTROL_CENTER_OFFLINE_GOVERNANCE_MUTATION_ENABLED");
    }
    phase = "reconnecting";
    await context.setOffline(false);
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
    await page.getByText("capability-review", { exact: true }).first().waitFor();

    await page.evaluate(() => fetch("/__fixture/degrade", { method: "POST" }));
    await primaryNavigation.getByRole("link", { name: "健康与部署", exact: true }).click();
    await waitForText(page.getByRole("main"), "degraded");

    await assertAxeClean(page, "desktop-zh-CN");

    const cursorBeforeOffline = await page.evaluate(() =>
      localStorage.getItem("himawari.control-center.v1.threadLastCursor"),
    );
    await primaryNavigation.getByRole("link", { name: "对话", exact: true }).click();
    await page.goto(`${baseUrl}/threads/thread-main?view=content`);
    await waitForConnected(page);
    await page.getByLabel("消息草稿").fill("离线草稿");
    phase = "offline";
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitForText(page.locator(".connection"), "离线");
    if (!(await page.getByRole("button", { name: "发送并启动 Run" }).isDisabled())) {
      throw new Error("CONTROL_CENTER_OFFLINE_MUTATION_ENABLED");
    }
    phase = "reconnecting";
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
    await page.getByText("run-01", { exact: true }).waitFor();
    const reopenedNavigation = page.getByRole("navigation", { name: "控制中心功能" });
    await reopenedNavigation.getByRole("link", { name: "审批", exact: true }).click();
    await page.getByText("approval-approve", { exact: true }).waitFor();
    await reopenedNavigation.getByRole("link", { name: "后台任务", exact: true }).click();
    await page.getByText("job-repository-monitor", { exact: true }).waitFor();
    const expectedOfflineBrowserError = (error) =>
      error.includes("access control checks") &&
      [
        "/api/gateway/v2/events",
        "/api/gateway/thread/v3/events",
        "/api/gateway/thread/v3/queries",
      ].some((path) => error.includes(path));
    if (requestErrors.length)
      throw new Error(`CONTROL_CENTER_CRITICAL_REQUEST_FAILED:${JSON.stringify(requestErrors)}`);
    const unexpectedBrowserErrors = browserErrors.filter(
      (error) => !expectedOfflineBrowserError(error),
    );
    if (unexpectedBrowserErrors.length > 0) {
      throw new Error(`CONTROL_CENTER_PAGE_ERRORS:${unexpectedBrowserErrors.join("|")}`);
    }

    const report = {
      schemaVersion: 2,
      status: "passed",
      scope: "fixture-only",
      engine: profile.engine.name(),
      profile: profileName,
      runtime: profile.runtime,
      browserVersion,
      platform: `${process.platform}-${process.arch}`,
      emulation: profile.emulation ?? null,
      surfaces: surfaces.map(({ label, policy }) => ({ label, policy })),
      journeys: [
        "thread-chat",
        "thread-answer-locale",
        "thread-search",
        "thread-checkpoint",
        "thread-revision-conflict-reapply",
        "thread-archive-restore",
        "thread-deletion-impact",
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
        "task-budget-attention-pause",
        "inbox-digest-result-sources",
        "memory-sensitive-correction",
        "trace-observable-causal-chain",
        "settings-secret-reference-only",
        "session-device-authoritative-detail",
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
      keyboard: ["visible-focus", "settings-tabs-roving"],
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
      responsive: ["desktop-three-pane", "mobile-single-pane", "320px-reflow"],
      minimumTargetHeight,
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
        `${JSON.stringify({ schemaVersion: 2, status: "failed", scope: "fixture-only", engine: profile.engine.name(), error: redactText(error.message, { sentinels }), diagnostics, pageErrors: pageErrorDetails }, null, 2)}\n`,
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
