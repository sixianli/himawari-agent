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
  readonly connections: readonly { readonly id: string; readonly status: string }[];
  readonly held: readonly string[];
  readonly commands: readonly {
    readonly type: string;
    readonly risk: string;
    readonly payload: Record<string, unknown>;
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
      code === 0 ? resolve() : reject(new Error(`MCP_CONNECTIONS_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

async function fixtureState(body: object = {}): Promise<Recorded> {
  const response = await fetch(`${base}/__fixture/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Recorded;
}

async function openAgents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
  });
  await page.goto(`${base}/settings/agents`);
  await page.locator("dialog[open] .mcp-connections").waitFor({ timeout: 10_000 });
  await page.locator("dialog[open] .mcp-limits").waitFor({ timeout: 10_000 });
}

function agents(page: Page) {
  return page.locator("dialog[open] .mcp-connections");
}

describe("[P5-B] the owner manages connected agents on the real page", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "mcp-connections-browser-"));
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

  it("creates a connection and shows its address only once", async () => {
    await fixtureState({ mode: "empty" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openAgents(page);
      const view = agents(page);
      await uiExpect(
        page.locator("dialog[open] .settings-nav").getByRole("button", { name: "接入的 agent" }),
      ).toHaveAttribute("aria-pressed", "true");
      await uiExpect(view).toContainText("还没有接入");
      await uiExpect(view.getByTestId("mcp-address")).toHaveCount(0);
      await uiExpect(view.getByRole("button", { name: "新建接入" })).toBeDisabled();
      await view.getByLabel("名称").first().fill("Claude Code");
      await view.getByRole("button", { name: "新建接入" }).click();
      const address = view.getByTestId("mcp-address");
      await uiExpect(address).toHaveText(`${base}/api/mcp/v1/fixture-key-1-${"x".repeat(24)}`);
      await uiExpect(view).toContainText("只显示这一次");
      await uiExpect(view.locator(".mcp-limits")).toContainText("接入个数：最多 200 个，已用 1 个");
      await uiExpect(view.locator(".mcp-connection")).toContainText("还没用过");
      const recorded = await fixtureState();
      expect(recorded.commands).toEqual([
        {
          type: "mcp.connection.create",
          risk: "medium",
          payload: {
            name: "Claude Code",
            capabilities: ["mcp"],
            readCeiling: "private",
            pushPolicy: "ask",
          },
        },
      ]);
      expect(recorded.held).toEqual([]);

      await page.reload();
      await page.locator("dialog[open] .mcp-connection").waitFor();
      await uiExpect(agents(page).getByTestId("mcp-address")).toHaveCount(0);
      await uiExpect(agents(page).locator(".mcp-connection")).toContainText("Claude Code");
    } finally {
      await page.close();
    }
  });

  it("shows each number with its definition, and every limit with what is used", async () => {
    await fixtureState({ mode: "one" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openAgents(page);
      const row = agents(page).locator(".mcp-connection");
      await uiExpect(row).toContainText("Codex 笔记本");
      await uiExpect(row).toContainText("对方自称：codex");
      await uiExpect(row).toContainText("读取 8 次 (start_here 2 · find_memories 6)");
      await uiExpect(row).toContainText("交出内容 4 次");
      await uiExpect(row).toContainText("空手而归 3 次");
      await uiExpect(row).toContainText("自动搜 5 次 / 有内容 2 次");
      await uiExpect(row).toContainText("规则提议 4 次（超频被拒 2 次）");
      await uiExpect(row).toContainText("被限流 3 次");
      await uiExpect(row.getByTestId("mcp-address")).toHaveCount(0);
      const limits = agents(page).locator(".mcp-limits");
      await uiExpect(limits).toContainText("最多 30 次，这一分钟最多的接入用了 2 次");
      await uiExpect(limits).toContainText("最多 60 次，这一分钟最多的接入用了 5 次");
      await uiExpect(limits).toContainText("名称：最多 64 个字，现有最长的 9 个字");
      await uiExpect(limits).toContainText("请求大小不单独记录");
      await uiExpect(limits).toContainText("单次请求：最多 65536 字节");
      await uiExpect(limits).toContainText("每个接入每分钟请求（自动搜另算）：最多 30 次");
      await uiExpect(agents(page)).toContainText("最近 7 天（2026-08-24 至 2026-08-30");
      await agents(page).getByText("每个数字怎么算").click();
      await uiExpect(agents(page)).toContainText("空手而归的自动搜只计数，不写决策记录");
      await uiExpect(agents(page)).toContainText(
        "被限流：除规则提议外，工具调用因为超过每分钟上限被拒的次数",
      );
      await uiExpect(agents(page).getByRole("link", { name: "Logpush 字段说明" })).toHaveAttribute(
        "href",
        /logpush.*http_requests/,
      );
    } finally {
      await page.close();
    }
  });

  it("pauses, rotates and revokes, and a cancelled revoke sends nothing", async () => {
    await fixtureState({ mode: "one" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await openAgents(page);
      const row = agents(page).locator(".mcp-connection");
      await row.getByRole("button", { name: "撤销" }).click();
      await row.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
      await uiExpect(row.getByRole("alertdialog")).toHaveCount(0);
      expect((await fixtureState()).commands).toEqual([]);

      await row.getByRole("button", { name: "暂停" }).click();
      await uiExpect(row.locator(".mcp-status")).toHaveText("已暂停");
      await row.getByRole("button", { name: "恢复" }).click();
      await uiExpect(row.locator(".mcp-status")).toHaveText("使用中");

      await row.getByRole("button", { name: "最多能读到" }).click();
      await row.getByRole("option", { name: "公开" }).click();
      await uiExpect(row.getByRole("button", { name: "最多能读到" })).toHaveText("公开");

      await row.getByRole("button", { name: "换密钥" }).click();
      await row.getByRole("alertdialog").getByRole("button", { name: "换密钥" }).click();
      await uiExpect(row.getByTestId("mcp-address")).toHaveText(
        /\/api\/mcp\/v1\/fixture-key-rotated-1$/,
      );

      await row.getByRole("button", { name: "撤销" }).click();
      await row.getByRole("alertdialog").getByRole("button", { name: "撤销" }).click();
      await uiExpect(row.locator(".mcp-status")).toHaveText("已撤销");
      await uiExpect(row.getByTestId("mcp-address")).toHaveCount(0);
      await uiExpect(row.getByRole("button")).toHaveCount(0);
      await uiExpect(agents(page).locator(".mcp-limits")).toContainText("已用 0 个");
      await uiExpect(agents(page)).toContainText("还没有接入");

      const recorded = await fixtureState();
      expect(recorded.commands.map(({ type, risk, payload }) => [type, risk, payload])).toEqual([
        [
          "mcp.connection.change",
          "medium",
          {
            connectionId: "conn-fixture-existing",
            name: null,
            capabilities: null,
            readCeiling: null,
            pushPolicy: null,
            status: "paused",
          },
        ],
        [
          "mcp.connection.change",
          "medium",
          {
            connectionId: "conn-fixture-existing",
            name: null,
            capabilities: null,
            readCeiling: null,
            pushPolicy: null,
            status: "active",
          },
        ],
        [
          "mcp.connection.change",
          "medium",
          {
            connectionId: "conn-fixture-existing",
            name: null,
            capabilities: null,
            readCeiling: "public",
            pushPolicy: null,
            status: null,
          },
        ],
        ["mcp.connection.rotate", "medium", { connectionId: "conn-fixture-existing" }],
        [
          "mcp.connection.change",
          "medium",
          {
            connectionId: "conn-fixture-existing",
            name: null,
            capabilities: null,
            readCeiling: null,
            pushPolicy: null,
            status: "revoked",
          },
        ],
      ]);
      expect(recorded.held).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("the weekly report lists each connection's numbers, and says so when there is none", async () => {
    for (const mode of ["one", "empty"] as const) {
      await fixtureState({ mode });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      try {
        await page.addInitScript(() => {
          localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
        });
        await page.goto(`${base}/reminders`);
        await page.getByRole("tab", { name: "校准周报" }).click();
        const section = page.getByRole("region", { name: "接入的 agent" });
        await section.waitFor({ timeout: 10_000 });
        await uiExpect(section).toContainText("2026-08-24 至 2026-08-30");
        if (mode === "one") {
          await uiExpect(section).toContainText("Codex 笔记本");
          await uiExpect(section).toContainText("读取 8 次");
          await uiExpect(section).toContainText("推来记忆 3 次");
        } else {
          await uiExpect(section).toContainText("这一周没有接入。");
          await uiExpect(section.locator("li")).toHaveCount(0);
        }
      } finally {
        await page.close();
      }
    }
  });
});
