import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page, expect as uiExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../fixtures/chromium-launch.ts";
import { repositoryRoot } from "../fixtures/product-path-harness.ts";

const APP = path.join(repositoryRoot, "apps/control-center");

let browser: Browser;
let base = "";
let staticRoot = "";
let fixture: ChildProcess;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function build(outDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules/vite/bin/vite.js"),
        "build",
        "--outDir",
        outDir,
        "--emptyOutDir",
        "--logLevel",
        "error",
      ],
      { cwd: APP, stdio: ["ignore", "ignore", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`SENSITIVE_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

type Recorded = {
  commands: { type: string; payload: Record<string, unknown> }[];
  items: unknown[];
};

const SHOTS = process.env["HIMAWARI_SENSITIVE_SHOTS"];

async function setMode(mode: string): Promise<Recorded> {
  const response = await fetch(`${base}/__fixture/sensitive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return (await response.json()) as Recorded;
}

async function recorded(): Promise<Recorded> {
  const response = await fetch(`${base}/__fixture/sensitive`);
  return (await response.json()) as Recorded;
}

async function openDataSettings(
  page: Page,
  locale = "zh-CN",
  data = "数据",
  theme: "light" | "dark" = "light",
): Promise<void> {
  await page.addInitScript(
    ([value, scheme]) => {
      localStorage.setItem("himawari.control-center.v1.locale", value);
      localStorage.setItem(
        "himawari.control-center.v1.preferences",
        JSON.stringify({ theme: scheme, accent: "violet" }),
      );
    },
    [locale, theme] as const,
  );
  await page.goto(`${base}/settings/data`);
  await page
    .locator("dialog[open] .settings-nav")
    .getByRole("button", { name: data, exact: true })
    .waitFor();
}

type Box = { scrollLeft: number; parentElement: Box | null };

async function noSideScroll(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const box = await page.locator(".sensitive-page").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let shifted = 0;
    for (let node: Box | null = element as unknown as Box; node; node = node.parentElement)
      shifted += node.scrollLeft;
    return { left: rect.left, right: rect.right, shifted };
  });
  expect(box.shifted).toBe(0);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(width);
  const tabs = await page
    .locator("dialog[open] .settings-nav .action-button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.scrollWidth <= button.clientWidth + 1),
    );
  expect(tabs.every(Boolean)).toBe(true);
  expect(await page.locator("html").evaluate((root) => root.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  expect(
    await page
      .locator("dialog[open] .settings-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
}

function middayTimezone() {
  const offset = 12 - new Date().getUTCHours();
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

describe("[SI-4] 敏感信息拦截记录（真实网页验收）", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "sensitive-browser-"));
    await build(staticRoot);
    const port = await freePort();
    fixture = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HIMAWARI_BROWSER_FIXTURE_PORT: String(port),
        HIMAWARI_BROWSER_STATIC_ROOT: staticRoot,
        HIMAWARI_MEMORY_FIXTURE: "1",
      },
      stdio: "ignore",
    });
    base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${base}/threads`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await launchChromium(chromium);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    fixture?.kill();
    if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
  });

  it("正向：数据栏显示条数，点进去按天列出出处、类别和次数，能筛选，能打开对话", async () => {
    await setMode("demo");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 820 },
      colorScheme: "light",
      timezoneId: middayTimezone(),
    });
    try {
      await openDataSettings(page);
      const entry = page.locator(".sensitive-entry");
      await uiExpect(entry).toContainText("敏感信息拦截记录");
      await uiExpect(entry).toContainText("共 5 条记录");
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "zh-CN-1280-light-data.png") });
      await entry.getByRole("button", { name: "查看" }).click();
      const view = page.locator(".sensitive-page");
      await uiExpect(view.locator(".sensitive-item")).toHaveCount(5);
      await uiExpect(view.locator(".sensitive-filter")).toContainText("全部 5");
      await uiExpect(view.locator(".sensitive-filter")).toContainText("发给模型前遮住 4");
      await uiExpect(view.locator(".sensitive-filter")).toContainText("没记进记忆 1");
      await uiExpect(view.locator(".sensitive-filter")).not.toContainText("整段没发给模型");
      await uiExpect(view.locator(".sensitive-day h4").first()).toHaveText("今天");
      const first = view.locator(".sensitive-item").first();
      await uiExpect(first.locator(".sensitive-chip")).toHaveText("密码");
      await uiExpect(first).toContainText("一个对话 · 你的话");
      await uiExpect(first).toContainText("第一次遮住，之后 4 次发送都已遮住");
      const unsaved = view.locator(".sensitive-item", { hasText: "这条记忆没有保存" });
      await uiExpect(unsaved.locator(".sensitive-what")).toHaveAttribute("data-tone", "warning");
      const mail = view.locator(".sensitive-item", { hasText: "邮件判断" });
      await uiExpect(mail).toContainText("后台 · 邮件判断 · 一封收件箱里的邮件");
      await uiExpect(mail).toContainText("遮住 1 次");
      await uiExpect(mail.getByRole("button", { name: "打开对话" })).toHaveCount(0);
      await uiExpect(view.locator(".sensitive-item", { hasText: "银行卡号" })).toContainText(
        "一个对话 · 你的话",
      );
      expect(await view.textContent()).not.toMatch(/\d{4}\s?\d{4}\s?\d{4}/);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "zh-CN-1280-light-list.png") });
      await view.getByRole("button", { name: "没记进记忆 1" }).click();
      await uiExpect(view.locator(".sensitive-item")).toHaveCount(1);
      await view.getByRole("button", { name: "全部 5" }).click();
      await first.getByRole("button", { name: "打开对话" }).click();
      await uiExpect(page.locator("dialog[open] .sensitive-page")).toHaveCount(0);
      await uiExpect(page).toHaveURL(/thread-main/);
      await uiExpect(page).not.toHaveURL(/settings/);
    } finally {
      await page.close();
    }
  });

  it("反向：没有记录时只说还没有拦下过，不显示数字、条目和清除按钮", async () => {
    await setMode("empty");
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    try {
      await openDataSettings(page);
      const entry = page.locator(".sensitive-entry");
      await uiExpect(entry).toContainText("还没有拦下过敏感信息");
      expect(await entry.textContent()).not.toMatch(/\d/);
      await entry.getByRole("button", { name: "查看" }).click();
      const view = page.locator(".sensitive-page");
      await uiExpect(view.locator(".sensitive-empty")).toHaveText("还没有拦下过敏感信息");
      await uiExpect(view.locator(".sensitive-item")).toHaveCount(0);
      await uiExpect(view.locator(".sensitive-filter")).toHaveCount(0);
      await uiExpect(view.getByRole("button", { name: "清除记录" })).toHaveCount(0);
      await view.getByRole("button", { name: "数据" }).click();
      await uiExpect(page.locator(".sensitive-entry")).toBeVisible();
    } finally {
      await page.close();
    }
  });

  it("清除：先确认，取消不发命令；确认后发出清除并显示空", async () => {
    await setMode("demo");
    const before = (await recorded()).commands.length;
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    try {
      await openDataSettings(page);
      await page.locator(".sensitive-entry").getByRole("button", { name: "查看" }).click();
      const view = page.locator(".sensitive-page");
      await uiExpect(view.locator(".sensitive-foot")).toContainText("记录不会自动删除");
      await view.getByRole("button", { name: "清除记录" }).click();
      await uiExpect(view.getByRole("alert")).toContainText("清除全部拦截记录？对话本身不受影响。");
      await view.getByRole("button", { name: "取消" }).click();
      expect((await recorded()).commands.length).toBe(before);
      await view.getByRole("button", { name: "清除记录" }).click();
      await view.getByRole("alert").getByRole("button", { name: "清除", exact: true }).click();
      await expect
        .poll(async () =>
          (await recorded()).commands.filter((c) => c.type === "sensitive.interceptions.clear"),
        )
        .toHaveLength(1);
      await uiExpect(view.locator(".sensitive-empty")).toBeVisible();
      await uiExpect(view).toContainText("已清除。");
    } finally {
      await page.close();
    }
  });

  it("手机和深色：390 宽不左右滚动，三种语言都能显示", async () => {
    for (const [locale, data, scheme] of [
      ["zh-CN", "数据", "light"],
      ["zh-CN", "数据", "dark"],
      ["ja", "データ", "light"],
      ["en", "Data", "light"],
    ] as const) {
      await setMode("demo");
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        colorScheme: scheme,
      });
      try {
        await openDataSettings(page, locale, data, scheme);
        await page.locator(".sensitive-entry .action-button").click();
        await uiExpect(page.locator(".sensitive-page .sensitive-item")).toHaveCount(5);
        await noSideScroll(page);
        if (SHOTS)
          await page.screenshot({
            path: path.join(SHOTS, `${locale}-390-${scheme}-list.png`),
          });
      } finally {
        await page.close();
      }
    }
  });
});
