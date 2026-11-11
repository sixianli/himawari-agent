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
      code === 0 ? resolve() : reject(new Error(`MUSE_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

type Recorded = { commands: { type: string; payload: Record<string, unknown> }[] };

async function setMode(mode: string): Promise<Recorded> {
  const response = await fetch(`${base}/__fixture/muse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return (await response.json()) as Recorded;
}

async function recorded(): Promise<Recorded> {
  const response = await fetch(`${base}/__fixture/muse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return (await response.json()) as Recorded;
}

async function chinese(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
  });
}

async function openReminders(page: Page): Promise<void> {
  await chinese(page);
  await page.goto(`${base}/threads`);
  await page.getByRole("button", { name: "提醒", exact: true }).first().click();
  await page.waitForSelector(".muse-reference, .reminders-page", { timeout: 10_000 });
}

async function openDataSettings(page: Page): Promise<void> {
  await chinese(page);
  await page.goto(`${base}/threads`);
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await page
    .locator("dialog[open] .settings-nav")
    .getByRole("button", { name: "数据", exact: true })
    .click();
}

describe("Muse 参考区（真实网页验收）", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "muse-browser-"));
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

  it("正向：通道正常时显示条目、数字，并且只有两项都选了才提交评价", async () => {
    await setMode("ok");
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    try {
      await openReminders(page);
      const section = page.locator(".muse-reference");
      await section.waitFor();
      await uiExpect(section.locator(".muse-status")).toContainText("通道正常");
      await uiExpect(section.locator(".muse-summary")).toContainText("近 7 天收到 4 条");
      await uiExpect(section.locator(".muse-summary")).toContainText("条待评价");
      await uiExpect(section.locator(".muse-summary")).toContainText("事件到提醒的中位延迟");
      const first = section.locator(".muse-row", { hasText: "GitHub" }).first();
      await first
        .getByRole("group", { name: "时机" })
        .getByRole("button", { name: "对", exact: true })
        .click();
      expect((await recorded()).commands.filter((c) => c.type === "muse.item.rate")).toHaveLength(
        0,
      );
      await first
        .getByRole("group", { name: "内容" })
        .getByRole("button", { name: "不对", exact: true })
        .click();
      await expect
        .poll(async () => (await recorded()).commands.filter((c) => c.type === "muse.item.rate"))
        .toHaveLength(1);
      const sent = (await recorded()).commands.find((c) => c.type === "muse.item.rate");
      expect(sent?.payload).toMatchObject({ timingOk: true, contentOk: false });
      await uiExpect(first.getByRole("button", { name: "撤销评价" })).toBeVisible();
      expect(await section.textContent()).not.toMatch(/命中率?\s*[:：]?\s*\d/);
    } finally {
      await page.close();
    }
  });

  it("反向：从未收到数据时不显示任何数字或条目", async () => {
    await setMode("never");
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    try {
      await openReminders(page);
      const section = page.locator(".muse-reference");
      await section.waitFor();
      await uiExpect(section).toContainText("还没有收到 Muse 的数据");
      await uiExpect(section.locator(".muse-row")).toHaveCount(0);
      await uiExpect(section.locator(".muse-summary")).toHaveCount(0);
      expect(await section.textContent()).not.toMatch(/\d+\s*条/);
    } finally {
      await page.close();
    }
  });

  it("反向：通道中断用警示显示，暂停不显示成正常", async () => {
    await setMode("down");
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    try {
      await openReminders(page);
      const status = page.locator(".muse-reference .muse-status");
      await status.waitFor();
      await uiExpect(status).toHaveAttribute("role", "alert");
      await uiExpect(status).toContainText("通道已中断");
      await uiExpect(status).not.toContainText("通道正常");
    } finally {
      await page.close();
    }
    await setMode("paused");
    const paused = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    try {
      await openReminders(paused);
      const status = paused.locator(".muse-reference .muse-status");
      await status.waitFor();
      await uiExpect(status).toContainText("已暂停接收");
      await uiExpect(status).not.toContainText("通道正常");
    } finally {
      await paused.close();
    }
  });

  it("反向：延迟样本不足时不显示延迟数字，敏感条目不显示原文", async () => {
    await setMode("stale");
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    try {
      await openReminders(page);
      const section = page.locator(".muse-reference");
      await section.waitFor();
      await uiExpect(section).not.toContainText("中位延迟");
      await uiExpect(section).toContainText("一条敏感内容");
    } finally {
      await page.close();
    }
  });

  it("数据设置：暂停可切换，清除要先确认，取消不清除", async () => {
    await setMode("ok");
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    try {
      await openDataSettings(page);
      const data = page.locator("dialog[open] .muse-data");
      await data.waitFor();
      await data.getByRole("button", { name: "暂停接收" }).click();
      await expect
        .poll(async () => (await recorded()).commands.some((c) => c.type === "muse.intake.set"))
        .toBe(true);
      await data.getByRole("button", { name: "清除 Muse 数据" }).click();
      await uiExpect(data.locator('[role="alert"]')).toContainText("这不能撤销");
      await data.getByRole("button", { name: "取消" }).click();
      expect((await recorded()).commands.some((c) => c.type === "muse.data.clear")).toBe(false);
      await data.getByRole("button", { name: "清除 Muse 数据" }).click();
      await data.locator('[role="alert"]').getByRole("button", { name: "清除 Muse 数据" }).click();
      await expect
        .poll(async () => (await recorded()).commands.some((c) => c.type === "muse.data.clear"))
        .toBe(true);
    } finally {
      await page.close();
    }
  });
});
