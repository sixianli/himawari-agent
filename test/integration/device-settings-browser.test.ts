import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page, expect as uiExpect } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../fixtures/chromium-launch.ts";
import {
  type Harness,
  harness,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
  webToken,
} from "../fixtures/device-api-harness.ts";
import { repositoryRoot } from "../fixtures/product-path-harness.ts";

const APP = path.join(repositoryRoot, "apps/control-center");

let browser: Browser;
let staticRoot = "";
const open: Harness[] = [];

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
      code === 0 ? resolve() : reject(new Error(`DEVICE_BROWSER_BUILD_FAILED ${code}`)),
    );
  });
}

async function serve(): Promise<Harness> {
  const port = await freePort();
  const h = await harness({ origin: `http://localhost:${port}`, staticRoot });
  await h.app.listen({ host: "127.0.0.1", port });
  open.push(h);
  return h;
}

async function openDevices(h: Harness, locale = "zh-CN"): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "himawari_session",
      value: webToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  await page.addInitScript((value) => {
    localStorage.setItem("himawari.control-center.v1.locale", value);
  }, locale);
  await page.goto(`${h.origin}/settings/devices`);
  await page.locator(".device-settings").waitFor();
  return page;
}

async function signInFromApp(h: Harness, page: Page, name: string) {
  const client = await pairAndConfirm(h, name);
  await page.reload();
  await page.locator(".device-settings").waitFor();
  return { ...client, row: page.locator(`.device-row[data-device-id="${client.deviceId}"]`) };
}

async function deviceConfigStatus(h: Harness, client: Awaited<ReturnType<typeof signInFromApp>>) {
  return (await send(h, signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" })))
    .statusCode;
}

describe("[P1-1] 设置里的“设备”页（真实网页验收）", () => {
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "device-settings-browser-"));
    await build(staticRoot);
    browser = await launchChromium(chromium);
  }, 180_000);

  afterEach(async () => {
    for (const h of open.splice(0)) {
      await h.app.close();
      await h.repository.close();
    }
    await removeDeviceHarnessDirectories();
  });

  afterAll(async () => {
    await browser?.close();
    if (staticRoot) await rm(staticRoot, { recursive: true, force: true });
  });

  it("lists a device signed in from the App, renames it, and offers no QR pairing", async () => {
    const h = await serve();
    const page = await openDevices(h);
    await uiExpect(page.getByText("还没有配对的设备。")).toBeVisible();
    await uiExpect(page.getByText("设备在 Himawari App 里用通行密钥登录")).toBeVisible();
    const client = await signInFromApp(h, page, "Andy iPhone");
    await uiExpect(client.row).toHaveAttribute("data-status", "active", { timeout: 10_000 });
    await uiExpect(page.getByRole("img", { name: "配对二维码" })).toHaveCount(0);
    await uiExpect(page.getByRole("button", { name: "添加设备", exact: true })).toHaveCount(0);
    await uiExpect(client.row.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
    expect(await deviceConfigStatus(h, client)).toBe(200);

    await client.row.getByRole("button", { name: "改名", exact: true }).click();
    await client.row.getByRole("textbox", { name: "设备名" }).fill("工作 iPhone");
    await client.row.getByRole("button", { name: "保存", exact: true }).click();
    await uiExpect(client.row).toContainText("工作 iPhone");

    const limits = page.locator(".device-limits [data-limit-key]");
    await uiExpect(limits).toHaveCount(10);
    await uiExpect(page.locator('[data-limit-key="device.request.body_bytes"] dd')).toHaveText(
      "1 MB",
    );
    await uiExpect(page.locator('[data-limit-key="device.nonce.retained"] dd')).toHaveText(
      "10,000",
    );
    const shots = process.env["HIMAWARI_DEVICE_SHOTS"];
    if (shots) await page.screenshot({ path: path.join(shots, "devices-active.png") });
    await page.context().close();
  }, 60_000);

  it("[reverse] a device removed from the page is marked removed and can no longer connect", async () => {
    const h = await serve();
    const page = await openDevices(h);
    const phone = await signInFromApp(h, page, "Andy iPhone");
    await uiExpect(phone.row).toHaveAttribute("data-status", "active", { timeout: 10_000 });
    expect(await deviceConfigStatus(h, phone)).toBe(200);
    await phone.row.getByRole("button", { name: "移除", exact: true }).click();
    await uiExpect(phone.row).toHaveAttribute("data-status", "revoked");
    await uiExpect(phone.row).toContainText("已移除");
    await uiExpect(phone.row.getByRole("button")).toHaveCount(0);
    expect(await deviceConfigStatus(h, phone)).toBe(403);
    await page.context().close();
  }, 60_000);

  it("labels the page in English and Japanese", async () => {
    const h = await serve();
    for (const [locale, help, limits] of [
      ["en", "Devices sign in from the Himawari App with a passkey", "Device limits"],
      ["ja", "デバイスは Himawari アプリからパスキーでログインします", "デバイスの上限"],
    ] as const) {
      const page = await openDevices(h, locale);
      await uiExpect(page.getByText(help)).toBeVisible();
      await uiExpect(page.getByRole("heading", { name: limits })).toBeVisible();
      await page.context().close();
    }
  }, 60_000);
});
