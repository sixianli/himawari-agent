import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { watchPageErrors } from "./browser-page-errors.mjs";

const profile = process.argv[2] ?? "chromium";
const output = path.resolve(process.argv[3] ?? `.ci-output/file-preview/${profile}`);
await mkdir(output, { recursive: true });

const gatewaySource = await readFile("packages/platform-node/src/http-gateway-server.ts", "utf8");
const cspLine = gatewaySource
  .split("\n")
  .find((line) => line.includes("`default-src 'none'; base-uri 'none';"));
if (!cspLine) throw new Error("PRODUCTION_CSP_NOT_FOUND");
const productionCsp = cspLine
  .slice(cspLine.indexOf("`") + 1, cspLine.lastIndexOf("`"))
  .replace(/\$\{.*?: ""\}/g, "");
if (productionCsp.includes("${")) throw new Error("PRODUCTION_CSP_NOT_RESOLVED");

const fixtureRoot = "test/e2e/fixtures/files";
const files = [
  {
    name: "日本新闻头条.pdf",
    source: "news-headlines.pdf",
    kind: "pdf",
    mediaType: "application/pdf",
  },
  {
    name: "日本新闻头条.docx",
    source: "news-headlines.docx",
    kind: "document",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    name: "新闻来源统计.xlsx",
    source: "news-sources.xlsx",
    kind: "data",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    name: "系统字体中文.pdf",
    source: "cjk-system-font.pdf",
    kind: "pdf",
    mediaType: "application/pdf",
  },
  {
    name: "损坏的文件.pdf",
    source: "broken.pdf",
    kind: "pdf",
    mediaType: "application/pdf",
  },
  {
    name: "第二页超高.pdf",
    source: "tall-second-page.pdf",
    kind: "pdf",
    mediaType: "application/pdf",
  },
];
const bytes = new Map(
  await Promise.all(
    files.map(async (file) => [file.source, await readFile(path.join(fixtureRoot, file.source))]),
  ),
);
const items = files.map((file, index) => ({
  id: `file:preview-${index}`,
  threadId: "thread-main",
  runId: "run-01",
  toolCallId: `call:preview-${index}`,
  toolItemId: `item:preview-${index}`,
  source: "write",
  path: file.name,
  name: file.name,
  kind: file.kind,
  mediaType: file.mediaType,
  sizeBytes: bytes.get(file.source).length,
  version: 1,
  turn: 1,
  commandKey: null,
  stored: true,
  overlapped: false,
  createdAt: "2026-10-29T03:00:00.000Z",
}));
const filesLabel = { "zh-CN": "文件", en: "Files", ja: "ファイル" };
const showListLabel = { "zh-CN": "显示列表", en: "Show list", ja: "リストを表示" };

const server = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
  env: { ...process.env, HIMAWARI_BROWSER_FIXTURE_PORT: "0", HIMAWARI_MEMORY_FIXTURE: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
let browser;
let activePage;
let activeProblems = [];
const results = [];
try {
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fixture startup timeout")), 10000);
    let text = "";
    server.stdout.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/CONTROL_CENTER_FIXTURE_READY (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    server.once("error", reject);
    server.once("exit", () => reject(new Error("Fixture exited")));
  });
  browser = await (profile === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(process.env.HIMAWARI_CHROMIUM_PATH && profile !== "webkit"
      ? { executablePath: process.env.HIMAWARI_CHROMIUM_PATH }
      : {}),
  });
  for (const locale of ["zh-CN", "en", "ja"]) {
    for (const width of [1280, 390]) {
      const label = `${locale}-${width}`;
      const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
      const page = await context.newPage();
      activePage = page;
      const problems = [];
      activeProblems = problems;
      let step = "start";
      let capturing = false;
      const shot = async (name) => {
        capturing = true;
        await page.screenshot({ path: path.join(output, `${label}-${name}.png`) });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        capturing = false;
      };
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (...args) {
          if (this.height > 10000) return null;
          return original.apply(this, args);
        };
      });
      watchPageErrors(page, (error) => problems.push(`${step} pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (!capturing && /Content Security Policy|Refused to/i.test(message.text()))
          problems.push(`${step} csp: ${message.text()}`);
      });
      await context.route("**/*", async (route) => {
        if (route.request().resourceType() !== "document") return route.fallback();
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: { ...response.headers(), "content-security-policy": productionCsp },
        });
      });
      await context.route("**/api/files/v1/list", (route) =>
        route.fulfill({ json: { items, nextCursor: null } }),
      );
      await context.route("**/api/files/v1/content/**", (route) => {
        const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
        const file = files[items.findIndex((item) => item.id === id)];
        if (!file) return route.fulfill({ status: 404, json: { error: "missing" } });
        return route.fulfill({
          status: 200,
          contentType: file.mediaType,
          body: bytes.get(file.source),
        });
      });
      await page.goto(baseUrl);
      if (width < 760)
        await page.getByRole("button", { name: showListLabel[locale], exact: true }).click();
      await page.getByRole("button", { name: filesLabel[locale], exact: true }).first().click();

      step = "pdf";
      await page.getByText(files[0].name).first().click();
      const pdfPages = page.locator(".content-preview .preview-page");
      await expect(pdfPages).toHaveCount(2, { timeout: 15000 });
      await expect(pdfPages.first().locator(".textLayer span").first()).toBeAttached({
        timeout: 15000,
      });
      const pdf = await page.evaluate(() => {
        const first = document.querySelector(".content-preview .preview-page");
        const canvas = first.querySelector("canvas");
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 200) ink += 1;
        const body = first.closest(".preview-body").getBoundingClientRect();
        return {
          ink,
          text: first.querySelector(".textLayer").textContent,
          pageWidth: first.getBoundingClientRect().width,
          bodyWidth: body.width,
        };
      });
      expect(pdf.ink).toBeGreaterThan(1000);
      expect(pdf.text).toContain("千葉県");
      expect(pdf.pageWidth).toBeLessThanOrEqual(pdf.bodyWidth);
      await shot("pdf");
      await page.locator(".content-preview header button").last().click();

      step = "word";
      await page.getByText(files[1].name).first().click();
      await page.waitForFunction(
        () => {
          const wrapper = document
            .querySelector(".preview-word")
            ?.shadowRoot?.querySelector(".docx-wrapper");
          return wrapper?.querySelector("section.docx") && Number(wrapper.style.zoom) > 0;
        },
        undefined,
        { timeout: 15000 },
      );
      const word = await page.evaluate(() => {
        const host = document.querySelector(".preview-word");
        const root = host.shadowRoot;
        const section = root.querySelector("section.docx");
        const table = root.querySelector("table");
        return {
          sections: root.querySelectorAll("section.docx").length,
          text: root.textContent,
          sectionBackground: getComputedStyle(section).backgroundColor,
          tableCollapse: table ? getComputedStyle(table).borderCollapse : "",
          sectionWidth:
            section.offsetWidth * Number(root.querySelector(".docx-wrapper").style.zoom || 1),
          bullets: [...root.querySelectorAll("p")]
            .map((paragraph) => getComputedStyle(paragraph, "::before").content)
            .filter((content) => content && content !== "none" && content !== "normal"),
          hostWidth: host.getBoundingClientRect().width,
          images: [...root.querySelectorAll("img")].map(
            (image) => image.complete && image.naturalWidth > 0,
          ),
        };
      });
      expect(word.sections).toBeGreaterThanOrEqual(2);
      expect(word.text).toContain("千葉県北東部");
      expect(word.sectionBackground).toBe("rgb(255, 255, 255)");
      expect(word.tableCollapse).toBe("collapse");
      expect(word.sectionWidth).toBeLessThanOrEqual(word.hostWidth);
      expect(word.images).toEqual([true]);
      expect(word.bullets.filter((content) => content.includes("\u2022"))).toHaveLength(3);
      expect(word.bullets.join("")).not.toMatch(/[\uF000-\uF0FF]/);
      await shot("word");
      await page.locator(".content-preview header button").last().click();

      step = "sheet";
      await page.getByText(files[2].name).first().click();
      const table = page.locator(".content-preview .preview-sheet-table");
      await expect(table).toBeVisible({ timeout: 15000 });
      await expect(table).toContainText("¥1,250,000");
      await expect(table).toContainText("35.7%");
      await expect(page.locator(".preview-sheet-tabs [role=tab]")).toHaveCount(2);
      const titleFill = await table
        .locator("td", { hasText: "日本新闻来源统计" })
        .evaluate((cell) => getComputedStyle(cell).backgroundColor);
      expect(titleFill).toBe("rgb(31, 78, 121)");
      await shot("sheet");
      await page.locator(".content-preview header button").last().click();

      step = "pdf-without-embedded-font";
      await page.getByText(files[3].name).first().click();
      const cjkPage = page.locator(".content-preview .preview-page").first();
      await expect(cjkPage.locator(".textLayer span").first()).toBeAttached({ timeout: 15000 });
      await expect(cjkPage.locator(".textLayer")).toContainText("向日葵");
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const canvas = document.querySelector(".content-preview .preview-page canvas");
              const pixels = canvas
                .getContext("2d")
                .getImageData(0, 0, canvas.width, canvas.height).data;
              let ink = 0;
              for (let index = 0; index < pixels.length; index += 4)
                if (pixels[index] < 200) ink += 1;
              return ink;
            }),
          { timeout: 15000 },
        )
        .toBeGreaterThan(300);
      await page.locator(".content-preview header button").last().click();

      step = "pdf-broken";
      await page.getByText(files[4].name).first().click();
      await expect(page.locator(".content-preview .preview-notice")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.locator(".content-preview .preview-page")).toHaveCount(0);
      await expect(page.locator(".content-preview a[download]")).toBeVisible();
      await shot("pdf-broken");
      await page.locator(".content-preview header button").last().click();

      step = "pdf-one-page-broken";
      await page.getByText(files[5].name).first().click();
      const pages = page.locator(".content-preview .preview-page");
      await expect(pages).toHaveCount(2, { timeout: 15000 });
      await expect(pages.nth(0).locator(".textLayer")).toContainText("Page one ok", {
        timeout: 15000,
      });
      await expect(pages.nth(1).locator(".preview-page-failed")).toBeVisible({ timeout: 15000 });
      await expect(pages.nth(0).locator(".preview-page-failed")).toHaveCount(0);
      await expect(pages.nth(1).locator("canvas")).toBeHidden();
      const firstPageInk = await pages
        .nth(0)
        .locator("canvas")
        .evaluate((canvas) => {
          const pixels = canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 200) ink += 1;
          return ink;
        });
      expect(firstPageInk).toBeGreaterThan(100);
      await expect(
        page.locator(
          ".content-preview > .preview-notice, .content-preview .preview-body > .preview-notice",
        ),
      ).toHaveCount(0);
      await shot("pdf-one-page-broken");
      await page.locator(".content-preview header button").last().click();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
      expect(problems).toEqual([]);
      results.push(
        `${label}: pdf pages with text layer, word pages with styles, sheet with fills and formats, no CSP refusals`,
      );
      process.stdout.write(`passed ${label}\n`);
      await context.close();
    }
  }
  await writeFile(
    path.join(output, "report.json"),
    `${JSON.stringify({ status: "passed", profile, browser: browser.version(), checks: results }, null, 2)}\n`,
  );
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  await writeFile(
    path.join(output, "report.json"),
    `${JSON.stringify({ status: "failed", checks: results, problems: activeProblems, error: String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
