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
      code === 0 ? resolve() : reject(new Error(`DECISION_CHAIN_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

describe("[P1-3] the basis drawer of a decision record in a real browser", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "decision-chain-browser-"));
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

  async function openLog(page: Page, width = 1280) {
    await page.setViewportSize({ width, height: 900 });
    await page
      .context()
      .addCookies([{ name: "himawari-fixture-decisions", value: "on", url: base }]);
    await page.addInitScript(() => {
      localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
    });
    await page.goto(`${base}/settings/data`);
    await page
      .locator("dialog[open] .settings-nav")
      .getByRole("button", { name: "工具与权限", exact: true })
      .click();
    await page.locator(".proactive-log-entry summary").click();
    await page.locator(".proactive-log-row").first().waitFor();
  }
  const basisButton = (page: Page, index: number) =>
    page.locator(".proactive-log-row").nth(index).getByRole("button", { name: "依据" });

  it("shows the whole chain of a Gmail record and jumps to the quoted conversation", async () => {
    const page = await browser.newPage();
    try {
      await openLog(page);
      await basisButton(page, 0).click();
      const drawer = page.locator(".decision-chain");
      await uiExpect(drawer).toContainText("命中的规则");
      await uiExpect(drawer).toContainText("内置规则");
      await uiExpect(drawer).toContainText("你设定的");
      await uiExpect(drawer).toContainText("判断了 3 封");
      await uiExpect(drawer).toContainText("主人的房租每月 27 日从三井住友扣款");
      await uiExpect(drawer).toContainText("房租每月 27 号扣");
      await uiExpect(drawer).toContainText("周五晚上吃了拉面");
      await uiExpect(drawer).toContainText("受限记忆，模型也看不到，内容不在这里显示");
      await uiExpect(drawer).toContainText("做对了");
      await drawer.getByRole("button", { name: "看来源对话" }).click();
      await page.waitForURL(/\/threads\/thread-main/);
      await uiExpect(
        page.locator('[data-message-id="message-01"][data-focused="true"]'),
      ).toBeVisible();
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[P2-7] shows each rule's own words, wording, source and test state, and a failing example by number", async () => {
    const page = await browser.newPage();
    try {
      await openLog(page);
      await basisButton(page, 0).click();
      const drawer = page.locator(".decision-chain");
      const money = drawer.locator('[data-rule-id="floor_money_words"]');
      await uiExpect(money).toContainText(
        "模型逐封判断“是否涉及你要付出、被扣、可收回或已入账的钱款”",
      );
      await uiExpect(money).not.toContainText("词表");
      await uiExpect(money).toContainText("出处：ADR 0106 第 4 条；ADR 0209；ADR 0248 · 第 2 版");
      await uiExpect(money.locator('[data-tests="passed"]')).toHaveText("测试：5 条例子全部通过");
      const sender = drawer.locator('[data-rule-id="floor_important_sender"]');
      await uiExpect(sender).toContainText("原话：银行来的信一律提醒我");
      await uiExpect(sender).toContainText("重要名单：smbc.example");
      await uiExpect(sender).toContainText("待重审");
      await uiExpect(sender).toContainText("第 2 版");
      await uiExpect(sender.locator('[data-tests="failed"]')).toHaveText(
        "测试：第 2 条例子不符（共 3 条）",
      );
      await uiExpect(sender).not.toContainText("全部通过");
      const quiet = drawer.locator('[data-rule-id="quiet_hours"]');
      await uiExpect(quiet).toContainText("23:00–07:00");
      await uiExpect(money).not.toContainText("原话");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("says no record for a record that kept nothing, never a blank section", async () => {
    const page = await browser.newPage();
    try {
      await openLog(page);
      await basisButton(page, 1).click();
      const drawer = page.locator(".decision-chain");
      await uiExpect(drawer).toContainText("还没评价");
      await uiExpect(drawer.locator("section")).toHaveCount(3);
      for (const section of await drawer.locator("section").all())
        await uiExpect(section).toContainText("无记录");
      await uiExpect(drawer.locator(".decision-chain-memory")).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("closes the drawer and says the record was cleared when it no longer exists", async () => {
    const page = await browser.newPage();
    try {
      await openLog(page);
      await basisButton(page, 2).click();
      await uiExpect(page.locator(".decision-chain")).toHaveCount(0);
      await uiExpect(page.locator(".proactive-log")).toContainText("这条记录已被清除");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("fits a phone screen without sideways scrolling", async () => {
    const page = await browser.newPage();
    try {
      await openLog(page, 390);
      await basisButton(page, 0).click();
      const drawer = page.locator(".decision-chain");
      await uiExpect(drawer).toContainText("命中的规则");
      const overflow = await drawer.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      if (overflow > 0) throw new Error(`DECISION_CHAIN_SIDE_SCROLL ${overflow}`);
    } finally {
      await page.close();
    }
  }, 30_000);
});
