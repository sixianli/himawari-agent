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
    viewport: { width: 1280, height: 800 },
    ...profile.contextOptions,
  });
  let page = await context.newPage();
  await page.goto("http://127.0.0.1:4173");
  await waitForText(page.getByRole("status"), "实时连接");

  await page.keyboard.press("Tab");
  const keyboardFocus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    const style = getComputedStyle(element);
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ")
      : "";
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
        labelledByText ||
        labelText ||
        element.textContent?.trim() ||
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
  for (const requiredLandmark of ["navigation", "main", "heading"]) {
    if (!ariaSnapshot.includes(requiredLandmark)) {
      throw new Error(`CONTROL_CENTER_ARIA_LANDMARK_MISSING:${requiredLandmark}`);
    }
  }

  await page.getByLabel("消息草稿").fill("浏览器资格测试消息");
  await page.getByRole("button", { name: "发送并启动 Run" }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");
  if ((await page.getByLabel("消息草稿").inputValue()) !== "") {
    throw new Error("CONTROL_CENTER_DRAFT_NOT_CLEARED");
  }
  await page.getByLabel("所选记录引用").fill("run-01");
  await page.getByRole("button", { name: "取消指定 Run", exact: true }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");

  const journeys = [
    ["审批", "approval-01"],
    ["后台任务", "job-repository-monitor"],
    ["收件箱", "inbox-01"],
    ["记忆", "memory-01"],
    ["追踪", "trace-01"],
    ["会话与设备", "session-01"],
    ["健康状态", "healthy"],
  ];
  for (const [label, expected] of journeys) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await waitForText(page.getByRole("main"), expected);
  }

  await page.getByRole("button", { name: "后台任务", exact: true }).click();
  await waitForText(page.getByRole("main"), "fixture-primary");
  await page.getByLabel(/机器秘密、App 私钥/).check();
  await waitForText(page.getByRole("status"), "披露确认待随");
  await page.getByLabel("所选记录引用").fill("job-repository-monitor");
  await page.getByLabel("GitHub repository ref").selectOption("fixture-owner/fixture-repository");
  await page.getByLabel("GitHub monitor revision").fill("1");
  await page.getByRole("button", { name: "启用 GitHub 监控", exact: true }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");
  await page.getByLabel("GitHub monitor revision").fill("2");
  await page.getByLabel("撤销后的历史处理").selectOption("delete");
  await page.getByRole("button", { name: "撤销 GitHub 监控", exact: true }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");

  await page.getByRole("button", { name: "审批", exact: true }).click();
  await page.getByLabel("所选记录引用").fill("approval-01");
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");

  await page.getByRole("button", { name: "后台任务", exact: true }).click();
  await page.getByLabel("所选记录引用").fill("job-repository-monitor");
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");

  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByLabel("所选记录引用").fill("memory-01");
  await page.getByLabel("更正后的记忆内容").fill("经所有者确认后的更正内容");
  await page.getByRole("button", { name: "更正", exact: true }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");

  await page.getByRole("button", { name: "会话与设备", exact: true }).click();
  await page.getByLabel("所选记录引用").fill("session-01");
  await page.getByRole("button", { name: "撤销会话", exact: true }).click();
  await waitForText(page.getByText("命令状态："), "已接纳");

  await page.evaluate(() => fetch("/__fixture/degrade", { method: "POST" }));
  await page.getByRole("button", { name: "健康状态", exact: true }).click();
  await waitForText(page.getByRole("main"), "degraded");

  const cursorBeforeOffline = await page.evaluate(() =>
    localStorage.getItem("himawari.control-center.v1.lastCursor"),
  );
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForText(page.getByRole("status"), "离线");
  await context.setOffline(false);
  await waitForText(page.getByRole("status"), "实时连接");

  const background = await context.newPage();
  await background.goto("about:blank");
  await background.waitForTimeout(1_200);
  await page.bringToFront();
  await waitForText(page.getByRole("status"), "实时连接");
  await background.close();

  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  if (violations.length > 0) {
    throw new Error(`CONTROL_CENTER_AXE_VIOLATIONS:${violations.map(({ id }) => id).join(",")}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const minimumButtonHeight = Math.min(
    ...(await page
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))),
  );
  if (minimumButtonHeight < 44) throw new Error("CONTROL_CENTER_TOUCH_TARGET_TOO_SMALL");

  await page.close();
  page = await context.newPage();
  await page.goto("http://127.0.0.1:4173");
  await waitForText(page.getByRole("status"), "实时连接");
  const cursorAfterReopen = await page.evaluate(() =>
    localStorage.getItem("himawari.control-center.v1.lastCursor"),
  );
  if (!cursorAfterReopen || cursorAfterReopen === cursorBeforeOffline) {
    throw new Error("CONTROL_CENTER_CURSOR_NOT_RECOVERED");
  }

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      engine: profile.engine.name(),
      profile: profileName,
      runtime: profile.runtime,
      browserVersion,
      platform: `${process.platform}-${process.arch}`,
      emulation: profile.emulation ?? null,
      journeys: [
        "thread-chat",
        "approval",
        "task",
        "github-monitor-lifecycle",
        "inbox",
        "memory",
        "trace",
        "identity",
        "health",
      ],
      sse: ["offline-reconnect", "background-tab", "close-reopen"],
      mobileViewport: "390x844",
      minimumButtonHeight,
      axeViolations: 0,
      keyboardFocus,
      semanticLandmarks: ["navigation", "main", "heading"],
      nonColorConnectionStatus: true,
      cursorAfterReopen,
    })}\n`,
  );
} finally {
  await browser?.close().catch(() => undefined);
  server.kill("SIGTERM");
}
