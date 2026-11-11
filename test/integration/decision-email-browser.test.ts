import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page, expect as uiExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
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
      {
        cwd: APP,
        env: { ...process.env, NODE_ENV: "production" },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`DECISION_EMAIL_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

describe("[P1-5] the email decision detail page in a real browser", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "decision-email-browser-"));
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

  async function openCase(page: Page, index: number, width = 1280) {
    await page.setViewportSize({ width, height: 900 });
    await page.context().addCookies([{ name: "himawari-fixture-mail", value: "on", url: base }]);
    await page.addInitScript(() => {
      localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
    });
    await page.goto(`${base}/reminders`);
    await page.getByRole("tab", { name: "校准周报" }).click();
    const rows = page.locator(".weekly-case");
    await rows.nth(index).waitFor();
    await rows.nth(index).getByRole("button", { name: "查看这封邮件" }).click();
    await page.locator(".mail-decision-card").first().waitFor();
  }

  it("shows the chain, the period's numbers and the Muse comparison of one mail on one page", async () => {
    const page = await browser.newPage();
    try {
      await openCase(page, 0);
      const detail = page.locator(".mail-decision");
      await uiExpect(detail).toContainText("邮件决策详情");
      await uiExpect(detail).toContainText("命中的规则");
      await uiExpect(detail).toContainText("内置规则");
      await uiExpect(detail).toContainText("主人的房租每月 27 日从三井住友扣款");
      await uiExpect(detail.locator(".decision-chain-memory", { hasText: "房租" })).toContainText(
        "这封邮件用到",
      );
      await uiExpect(
        detail.locator(".decision-chain-memory", { hasText: "拉面" }),
      ).not.toContainText("这封邮件用到");
      await uiExpect(detail).toContainText("你的评价");
      await uiExpect(detail).toContainText("读完邮件提醒了你");
      await uiExpect(detail).toContainText("Muse 差距线");
      await uiExpect(detail).toContainText("Muse 提醒：mail-fixture-full");
      await uiExpect(detail).toContainText("只有 Muse 提醒了你，Himawari 没有");
      await uiExpect(detail.locator(".weekly-tile[data-mark]")).toContainText("只有 Muse 提醒");
      const columns = await page
        .locator(".mail-decision-grid")
        .evaluate(
          (element) =>
            element.ownerDocument.defaultView
              ?.getComputedStyle(element)
              .gridTemplateColumns.split(" ").length,
        );
      if (columns !== 2) throw new Error(`MAIL_DECISION_COLUMNS ${columns}`);
      await detail.getByRole("button", { name: "看来源对话" }).first().click();
      await page.waitForURL(/\/threads\/thread-main/);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[negative] says no record for the links an old record never kept, never a blank", async () => {
    const page = await browser.newPage();
    try {
      await openCase(page, 1);
      const detail = page.locator(".mail-decision");
      await uiExpect(detail).toContainText(
        "命中规则 无记录 条 · 用到记忆 无记录 条 · 相关邮件 无记录 封",
      );
      await uiExpect(detail.locator(".decision-chain-memory", { hasText: "房租" })).toHaveCount(0);
      for (const section of await detail.locator(".decision-chain section").all())
        await uiExpect(section).toContainText("无记录");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[negative] a mail without any judgment shows no chain and says it cannot compare", async () => {
    const page = await browser.newPage();
    try {
      await openCase(page, 2);
      const detail = page.locator(".mail-decision");
      await uiExpect(detail).toContainText("没有这封邮件的判断记录。");
      await uiExpect(detail).toContainText("Himawari 没有这封邮件的判断记录，无法对比");
      await uiExpect(detail.locator(".decision-chain-memory", { hasText: "房租" })).toHaveCount(0);
      await uiExpect(detail.locator(".weekly-tile[data-mark]")).toContainText("没有这封邮件的记录");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("goes back to the report, and fits a phone screen without sideways scrolling", async () => {
    const page = await browser.newPage();
    try {
      await openCase(page, 0, 390);
      const detail = page.locator(".mail-decision");
      await uiExpect(detail).toContainText("命中的规则");
      const overflow = await page
        .locator("html")
        .evaluate((element) => element.scrollWidth - element.clientWidth);
      if (overflow > 0) throw new Error(`MAIL_DECISION_SIDE_SCROLL ${overflow}`);
      const columns = await page
        .locator(".mail-decision-grid")
        .evaluate(
          (element) =>
            element.ownerDocument.defaultView
              ?.getComputedStyle(element)
              .gridTemplateColumns.split(" ").length,
        );
      if (columns !== 1) throw new Error(`MAIL_DECISION_PHONE_COLUMNS ${columns}`);
      await detail.getByRole("button", { name: "返回" }).click();
      await uiExpect(page.locator(".mail-decision")).toHaveCount(0);
      await uiExpect(page.locator(".weekly-case").first()).toBeVisible();
    } finally {
      await page.close();
    }
  }, 30_000);
});
