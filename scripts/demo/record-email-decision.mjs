import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDirectory = path.resolve(process.argv[2] ?? path.join(root, ".ci-output/demo"));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function run(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"], ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`DEMO_STEP_FAILED ${code}`)),
    );
  });
}

const staticRoot = await mkdtemp(path.join(tmpdir(), "demo-static-"));
const videoRoot = await mkdtemp(path.join(tmpdir(), "demo-video-"));
await run(
  process.execPath,
  [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "build",
    "--outDir",
    staticRoot,
    "--emptyOutDir",
    "--logLevel",
    "error",
  ],
  { cwd: path.join(root, "apps/control-center"), env: { ...process.env, NODE_ENV: "production" } },
);
const port = await freePort();
const fixture = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    HIMAWARI_BROWSER_FIXTURE_PORT: String(port),
    HIMAWARI_BROWSER_STATIC_ROOT: staticRoot,
    HIMAWARI_MEMORY_FIXTURE: "1",
  },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${port}`;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    if ((await fetch(`${base}/threads`)).ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const bundled = "/opt/pw-browsers/chromium";
const executablePath =
  process.env.HIMAWARI_CHROMIUM_PATH ?? (existsSync(bundled) ? bundled : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: videoRoot, size: { width: 1280, height: 800 } },
});
await context.addCookies([{ name: "himawari-fixture-mail", value: "on", url: base }]);
const page = await context.newPage();
await page.addInitScript(() => {
  localStorage.setItem("himawari.control-center.v1.locale", "zh-CN");
});

async function caption(text) {
  await page.evaluate((value) => {
    let element = document.getElementById("demo-caption");
    if (!element) {
      element = document.createElement("div");
      element.id = "demo-caption";
      element.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:14px 24px;background:rgba(20,20,20,.88);color:#fff;font:600 18px system-ui,sans-serif;text-align:center";
      document.body.append(element);
    }
    element.textContent = value;
  }, text);
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  await page.goto(`${base}/reminders`);
  await page.getByRole("tab", { name: "校准周报" }).click();
  await page.locator(".weekly-case").first().waitFor();
  await caption("演示数据（非生产数据）：校准周报里，Himawari 和 Muse 有差距的邮件");
  await pause(3500);
  await page.locator(".weekly-case").first().getByRole("button", { name: "查看这封邮件" }).click();
  await page.locator(".mail-decision-card").first().waitFor();
  await caption("一页：这封邮件的判断和你的评价");
  await pause(3500);
  await caption("依据链：命中的规则（带出处）和用到的记忆（高亮“这封邮件用到”）");
  await page.locator(".decision-chain-memory").first().scrollIntoViewIfNeeded();
  await pause(4500);
  await caption("右边：那一周的校准数字和 Muse 对照结论");
  await page.locator(".mail-week").first().scrollIntoViewIfNeeded();
  await pause(4500);
  await caption("记忆能点到来源对话（规则和评价这一版只显示）");
  await page.getByRole("button", { name: "看来源对话" }).first().click();
  await page.waitForURL(/\/threads\//);
  await pause(3000);
} finally {
  await context.close();
  await browser.close();
  fixture.kill();
  await rm(staticRoot, { recursive: true, force: true });
}

await mkdir(outputDirectory, { recursive: true });
const [video] = (await readdir(videoRoot)).filter((name) => name.endsWith(".webm"));
await rename(path.join(videoRoot, video), path.join(outputDirectory, "email-decision-demo.webm"));
await rm(videoRoot, { recursive: true, force: true });
console.log(path.join(outputDirectory, "email-decision-demo.webm"));
