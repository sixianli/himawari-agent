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
let pinnedFixture: ChildProcess;
let pinnedBase = "";
let reviewFixture: ChildProcess;
let reviewBase = "";

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
      code === 0 ? resolve() : reject(new Error(`MEMORY_SOURCE_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

async function serve(
  pinned: string,
  extra: Record<string, string> = {},
): Promise<{ process: ChildProcess; base: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HIMAWARI_BROWSER_FIXTURE_PORT: String(port),
      HIMAWARI_BROWSER_STATIC_ROOT: staticRoot,
      HIMAWARI_MEMORY_FIXTURE: "1",
      HIMAWARI_PROFILE_PINNED_CHARACTERS: pinned,
      ...extra,
    },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${url}/threads`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { process: child, base: url };
}

describe("[P1-1] memory page jumps to the original message in a real browser", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "sensitive-browser-"));
    await build(staticRoot);
    ({ process: fixture, base } = await serve("0"));
    ({ process: pinnedFixture, base: pinnedBase } = await serve("2150"));
    ({ process: reviewFixture, base: reviewBase } = await serve("0", {
      HIMAWARI_MEMORY_REVIEW_FIXTURE: "1",
    }));
    browser = await launchChromium(chromium);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    fixture?.kill();
    pinnedFixture?.kill();
    reviewFixture?.kill();
    if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
  });

  async function openMemory(page: Page, at = base) {
    await page.addInitScript(() => {
      localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
    });
    await page.goto(`${at}/memory`);
  }

  it("offers the jump for a captured memory and opens its conversation", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      await page.getByText("主人最喜欢的颜色是蓝色").first().click();
      const drawer = page.locator(".memory-drawer");
      await uiExpect(drawer.getByRole("button", { name: "跳到原话" })).toBeVisible();
      await uiExpect(drawer).not.toContainText("来源已不可查");
      await drawer.getByRole("button", { name: "跳到原话" }).click();
      await page.waitForURL(/\/threads\/thread-main/);
      await uiExpect(
        page.locator('[data-message-id="message-01"][data-focused="true"]'),
      ).toBeVisible();
    } finally {
      await page.close();
    }
  }, 30_000);

  it("opens a conversation without highlighting anything when nobody asked for a message", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      await page.goto(`${base}/threads/thread-main`);
      await uiExpect(page.locator('[data-message-id="message-01"]')).toBeVisible();
      await page.waitForTimeout(500);
      await uiExpect(page.locator("[data-focused]")).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("says the source can no longer be found for a memory whose message is gone, and offers no jump", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      await uiExpect(page.locator('[data-kind="source-unavailable"]')).toContainText(
        "有 1 条记忆的来源已不可查",
      );
      await page.getByText("主人以前在大阪住过").first().click();
      const drawer = page.locator(".memory-drawer");
      await uiExpect(drawer).toContainText("来源已不可查");
      await uiExpect(drawer.getByRole("button", { name: "跳到原话" })).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[P2-5] tells the owner when the memories they chose to bring every time exceed the limit", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page, pinnedBase);
      await uiExpect(page.getByTestId("memory-carry-pinned-over")).toHaveText(
        "你打开“每次对话都带上”的记忆共 2150 字，比上限 2000 字多出 150 字。它们照样每次都带上，但其他记忆就放不进来了；关掉几条可以回到上限以内。",
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[DREAM] shows a conversation review batch with the owner's words and undoes the whole batch", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page, reviewBase);
      await page.getByRole("tab", { name: "变化记录" }).click();
      const row = page.locator(".memory-day p", { hasText: "回看了一段对话" });
      await uiExpect(row).toHaveCount(1);
      await uiExpect(row).toContainText("新记住 1 条，取代旧说法 0 条，确认 0 条");
      await uiExpect(row).toContainText("新记住：主人在学德语（原话：我最近每天晚上学一小时德语）");
      await row.getByRole("button", { name: "撤销" }).click();
      await uiExpect(row).toContainText("已撤销");
      await uiExpect(row.getByRole("button", { name: "撤销" })).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[DREAM] reverse: with no conversation review there is no review row and no batch undo", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      await page.getByRole("tab", { name: "变化记录" }).click();
      await uiExpect(page.locator(".memory-day").first()).toBeVisible();
      await uiExpect(page.locator(".memory-day p", { hasText: "回看了一段对话" })).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[P2-5] reverse: shows no over-limit notice when the chosen memories fit", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      await uiExpect(page.locator(".memory-carry")).toBeVisible();
      await uiExpect(page.getByTestId("memory-carry-pinned-over")).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 30_000);
});
