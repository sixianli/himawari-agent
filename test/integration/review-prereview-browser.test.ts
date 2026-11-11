import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page, expect as uiExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
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
      code === 0 ? resolve() : reject(new Error(`PREREVIEW_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

async function open(page: Page, cookies: Record<string, string>, tab: "每天打分" | "校准周报") {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .context()
    .addCookies(Object.entries(cookies).map(([name, value]) => ({ name, value, url: base })));
  await page.addInitScript(() => {
    localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
  });
  await page.goto(`${base}/reminders`);
  if (tab === "校准周报") {
    await page.getByRole("tab", { name: "校准周报" }).click();
    await page.locator('[aria-label="模型预评一致率"]').waitFor();
  } else {
    await page.locator(".proactive-review-list").first().waitFor();
  }
}

describe("[P4-8] model pre-rating on the real page", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "review-prereview-browser-"));
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
    const bundled = "/opt/pw-browsers/chromium";
    const executablePath =
      process.env["HIMAWARI_CHROMIUM_PATH"] ?? (existsSync(bundled) ? bundled : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    fixture?.kill();
    if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
  });

  it("says how many items the model kept back on the daily rating page", async () => {
    const page = await browser.newPage();
    try {
      await open(page, { "himawari-fixture-prereview": "on" }, "每天打分");
      await uiExpect(page.locator(".proactive-review-hidden")).toHaveText(
        "另有 3 条模型已预评为有用、而且有把握，按你开的减量设置这次没给你看",
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[negative] shows no kept-back note when the model hid nothing", async () => {
    const page = await browser.newPage();
    try {
      await open(page, {}, "每天打分");
      await uiExpect(page.locator(".proactive-review-hidden")).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("shows the agreement per type in the weekly report", async () => {
    const page = await browser.newPage();
    try {
      await open(page, { "himawari-fixture-mail": "on" }, "校准周报");
      const card = page.locator('[aria-label="模型预评一致率"]');
      await uiExpect(card.locator('[data-prereview-group="proactive_silent"]')).toContainText(
        "90.0%（27/30）",
      );
      await uiExpect(card).toContainText("这一周对数不够，还不能判断");
      await uiExpect(card).toContainText("另有 2 条预评来自旧的模型或提示词版本");
      await uiExpect(card).toContainText("自动减少没有开启");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("[negative] shows no agreement number when nothing was pre-rated", async () => {
    const page = await browser.newPage();
    try {
      await open(page, {}, "校准周报");
      const card = page.locator('[aria-label="模型预评一致率"]');
      await uiExpect(card).toContainText("这一周还没有模型预评过、你也打过分的决策。");
      await uiExpect(card.locator("[data-prereview-group]")).toHaveCount(0);
      await uiExpect(card).not.toContainText("%");
    } finally {
      await page.close();
    }
  }, 30_000);
});
