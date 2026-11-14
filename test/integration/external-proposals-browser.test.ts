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

interface Recorded {
  readonly total: number;
  readonly items: readonly { readonly proposalId: string }[];
  readonly decided: Readonly<
    Record<string, { readonly decision: string; readonly editedText: string | null }>
  >;
  readonly commands: readonly {
    readonly type: string;
    readonly payload: {
      readonly items?: readonly { readonly proposalId: string; readonly decision: string }[];
    };
  }[];
}

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
      code === 0 ? resolve() : reject(new Error(`EXTERNAL_PROPOSALS_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

async function fixtureState(body: object = {}): Promise<Recorded> {
  const response = await fetch(`${base}/__fixture/external`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Recorded;
}

async function chinese(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
  });
}

async function openMemory(page: Page): Promise<void> {
  await chinese(page);
  await page.goto(`${base}/memory`);
  await page.waitForSelector(".memory-page", { timeout: 10_000 });
}

async function openReminders(page: Page): Promise<void> {
  await chinese(page);
  await page.goto(`${base}/threads`);
  await page.getByRole("button", { name: "提醒", exact: true }).first().click();
  await page.waitForSelector(".reminders-page", { timeout: 10_000 });
}

describe("[P5-3] Andy confirms memories other agents proposed, in a real browser", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "external-proposals-browser-"));
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

  it("lists the proposals with the self-reported source, saves the selected ones, and undoes the batch", async () => {
    await fixtureState({ mode: "pending" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      await uiExpect(
        page.getByRole("region", { name: "来自其他 agent · 3 条待确认" }),
      ).toBeVisible();
      const section = page.locator("#memory-external");
      await uiExpect(section).toContainText("自称：Claude Code");
      await uiExpect(section).toContainText("会按敏感记忆保存");
      const keep = section.getByRole("button", { name: /^保存所选/ });
      await uiExpect(keep).toBeDisabled();
      await section.getByRole("checkbox", { name: "全选" }).check();
      await uiExpect(keep).toHaveText("保存所选（3）");
      await keep.click();
      await uiExpect(section.locator(".memory-external-result")).toHaveText(
        "这一批保存了 3 条，不要 0 条",
      );
      await uiExpect(section.locator(".external-proposal")).toHaveCount(0);
      await uiExpect(
        page.getByRole("heading", { name: "来自其他 agent · 0 条待确认" }),
      ).toBeVisible();
      const sent = await fixtureState();
      expect(sent.commands[0]?.payload.items?.map(({ decision }) => decision)).toEqual([
        "keep",
        "keep",
        "keep",
      ]);
      await section.getByRole("button", { name: "撤销这一批" }).click();
      await uiExpect(
        page.getByRole("region", { name: "来自其他 agent · 3 条待确认" }),
      ).toBeVisible();
      await uiExpect(section.locator(".memory-external-result")).toHaveCount(0);
      expect((await fixtureState()).commands.at(-1)?.type).toBe("memory.external.undo");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("declines only the ticked proposals and saves an edited one with the new text", async () => {
    await fixtureState({ mode: "pending" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      const section = page.locator("#memory-external");
      await section.getByRole("checkbox", { name: /主人在学法语/ }).check();
      await section.getByRole("button", { name: "不要所选（1）" }).click();
      await uiExpect(section.locator(".memory-external-result")).toHaveText(
        "这一批保存了 0 条，不要 1 条",
      );
      const first = section.locator('[data-proposal="proposal-1"]');
      await first.getByRole("button", { name: "改一下再保存" }).click();
      await first.getByRole("textbox").fill("主人周末常去镰仓看海");
      await first.getByRole("button", { name: "保存" }).click();
      await uiExpect(section.locator('[data-proposal="proposal-1"]')).toHaveCount(0);
      const state = await fixtureState();
      expect(state.decided["proposal-3"]).toEqual({ decision: "reject", editedText: null });
      expect(state.decided["proposal-1"]).toEqual({
        decision: "keep",
        editedText: "主人周末常去镰仓看海",
      });
      expect(state.decided["proposal-2"]).toBeUndefined();
      expect(state.items.map(({ proposalId }) => proposalId)).toEqual(["proposal-2"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("says how many could not be handled when some were already decided elsewhere, and drops that line when the next send fails", async () => {
    await fixtureState({ mode: "pending" });
    await fixtureState({
      items: [
        {
          proposalId: "proposal-1",
          text: "主人喜欢喝抹茶",
          category: "preference",
          dataClassification: "private",
          client: "Muse",
          receivedAt: "2026-08-26T23:40:00.000Z",
        },
        {
          proposalId: "proposal-2",
          text: "这条已经在别处处理过",
          category: "other",
          dataClassification: "private",
          client: "Muse",
          receivedAt: "2026-08-26T23:40:00.000Z",
        },
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      const section = page.locator("#memory-external");
      await section.getByRole("checkbox", { name: "全选" }).check();
      await section.getByRole("button", { name: "保存所选（2）" }).click();
      await uiExpect(section.locator(".memory-external-result")).toContainText(
        "这一批保存了 1 条，不要 0 条；另有 1 条没处理成",
      );
      await uiExpect(section.locator('[data-proposal="proposal-2"]')).toBeVisible();
      await section.getByRole("checkbox", { name: /这条已经在别处处理过/ }).check();
      await section.getByRole("button", { name: "保存所选（1）" }).click();
      await uiExpect(section.locator(".memory-external-result")).toHaveCount(0);
      await uiExpect(section.locator('[data-proposal="proposal-2"]')).toBeVisible();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("states the total and how many are shown when more than 100 are waiting", async () => {
    await fixtureState({ mode: "many" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      const section = page.locator("#memory-external");
      await uiExpect(section.getByRole("heading")).toHaveText("来自其他 agent · 130 条待确认");
      await uiExpect(section).toContainText("共 130 条，显示前 100 条");
      await uiExpect(section.locator(".external-proposal")).toHaveCount(100);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("points from the reminders page to the memory page while proposals are waiting", async () => {
    await fixtureState({ mode: "pending" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openReminders(page);
      const hint = page.locator(".reminders-external");
      await uiExpect(hint).toContainText("其他 agent 送来的 3 条记忆等你确认。");
      await hint.getByRole("button", { name: "去确认" }).click();
      await uiExpect(page.locator("#memory-external")).toBeVisible();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("shows neither the section nor the reminder hint when nothing is waiting", async () => {
    await fixtureState({ mode: "none" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openMemory(page);
      await uiExpect(page.locator(".memory-tabs")).toBeVisible();
      await uiExpect(page.locator("#memory-external")).toHaveCount(0);
      await uiExpect(page.getByText("来自其他 agent")).toHaveCount(0);
      await openReminders(page);
      await uiExpect(page.locator(".reminders-page")).toBeVisible();
      await uiExpect(page.locator(".reminders-external")).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});
