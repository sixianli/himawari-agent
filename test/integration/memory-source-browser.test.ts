import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page, expect as uiExpect } from "@playwright/test";
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
      { cwd: APP, stdio: ["ignore", "ignore", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`MEMORY_SOURCE_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

describe("[P1-1] memory page jumps to the original message in a real browser", () => {
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

  async function openMemory(page: Page) {
    await page.addInitScript(() => {
      localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
    });
    await page.goto(`${base}/memory`);
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
    } finally {
      await page.close();
    }
  });

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
  });
});
