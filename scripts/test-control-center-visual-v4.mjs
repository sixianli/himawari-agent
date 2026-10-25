import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PNG } = require(
  path.join(path.dirname(require.resolve("playwright-core")), "lib/utilsBundle.js"),
);

import { pathToFileURL } from "node:url";

async function pixelDifference(a, b, destination) {
  const left = PNG.sync.read(await readFile(a)),
    right = PNG.sync.read(await readFile(b));
  if (left.width !== right.width || left.height !== right.height)
    throw new Error("VISUAL_DIMENSIONS_DIFFER");
  const diff = new PNG({ width: left.width, height: left.height });
  let changed = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    const different = [0, 1, 2, 3].some(
      (channel) => left.data[i + channel] !== right.data[i + channel],
    );
    if (different) changed++;
    diff.data[i] = different ? 255 : left.data[i];
    diff.data[i + 1] = different ? 0 : left.data[i + 1];
    diff.data[i + 2] = different ? 255 : left.data[i + 2];
    diff.data[i + 3] = 255;
  }
  await writeFile(destination, PNG.sync.write(diff));
  return {
    changedPixels: changed,
    totalPixels: left.width * left.height,
    identical: changed === 0,
  };
}

export async function captureControlCenterV4(browser, baseUrl, out) {
  await mkdir(out, { recursive: true });
  const pairs = [
    ["sidebar", ".hw-sidebar", ".sidebar"],
    ["header", ".hw-header", ".topbar"],
    ["composer", ".hw-composer", ".composer"],
    ["input", ".hw-composer textarea", ".composer textarea"],
    ["welcome", ".hw-empty", ".thread-welcome"],
    ["nav", ".hw-nav", ".thread-sidebar-actions"],
    ["nav-button", ".hw-nav button:first-child", ".thread-sidebar-actions button:first-child"],
    ["thread-name", ".hw-name >> nth=0", ".thread-row > a > span:last-child >> nth=0"],
    ["welcome-title", ".hw-empty h2", ".thread-welcome h2"],
  ];
  const metric = (locator) =>
    locator.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        s = getComputedStyle(el);
      return {
        width: r.width,
        height: r.height,
        font: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        color: s.color,
        smoothing: s.webkitFontSmoothing,
        lineHeight: s.lineHeight,
        padding: s.padding,
        borderRadius: s.borderRadius,
        background: s.backgroundColor,
      };
    });
  const report = {
    status: "comparison-only; nonzero differences are not pixel parity",
    scope:
      "Frozen sandboxed reference and built UI with matched fixture data; only the review toolbar and 1px outer frame are excluded",
    states: {},
  };
  const refs = {};
  let titles = [];
  // Capture each surface in its own context and close it before opening the
  // next. This keeps focus-driven prototype popovers in their observed state.
  const referenceContext = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 950 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await referenceContext.newPage();
    page.setDefaultTimeout(15000);
    const html = await readFile("docs/assets/control-center/2026-09-15-v4/index.html", "utf8");
    await page.route("**/__review_v4", (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto(`${baseUrl}/__review_v4`);
    const frame = page.frameLocator("iframe");
    await expect(frame.locator(".hw-app")).toBeVisible();
    titles = await frame.locator(".hw-name").allTextContents();
    async function capture(name) {
      await frame.locator(".hw-app").evaluate(() => document.fonts.ready);
      const box = await frame.locator(".hw-app").boundingBox();
      if (!box) throw new Error("REFERENCE_MISSING");
      const components = {};
      for (const [id, selector] of pairs) components[id] = await metric(frame.locator(selector));
      refs[name] = {
        width: Math.round(box.width) - 2,
        height: Math.round(box.height) - 1,
        components,
      };
      // Locator capture forces the iframe to paint before clipping its outer frame.
      const bytes = await frame.locator(".hw-app").screenshot({ animations: "disabled" });
      const full = PNG.sync.read(bytes),
        cropped = new PNG({ width: full.width - 2, height: full.height - 1 });
      PNG.bitblt(full, cropped, 1, 0, cropped.width, cropped.height, 0, 0);
      refs[name].width = cropped.width;
      refs[name].height = cropped.height;
      await writeFile(path.join(out, `${name}-reference.png`), PNG.sync.write(cropped));
    }
    await expect(frame.locator(".hw-model-picker")).toBeVisible();
    await capture("model");
    await frame.locator("[data-act=model]").click();
    await capture("empty");
    await frame.locator("[data-act=settings]").click();
    await expect(frame.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    await capture("settings");
    await frame.locator("#hw-theme").selectOption("light");
    await capture("settings-light");
    await frame.locator("[data-act=close]").click();
    await frame.getByRole("heading", { name: "新对话", exact: true }).click();
    await capture("light");
    await page.setViewportSize({ width: 424, height: 950 });
    await capture("mobile-light");
  } finally {
    await referenceContext.close();
  }
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: refs.empty.width, height: refs.empty.height },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.route("**/api/control-center/v1/config", async (route) => {
      const response = await route.fetch(),
        config = await response.json();
      await route.fulfill({
        response,
        json: {
          ...config,
          primaryModelRef: "model:fixture-primary:v1",
          availableModels: [
            {
              ref: "model:fixture-primary:v1",
              provider: "fixture",
              model: "fixture-primary",
              name: "GLM 5.3 Flash",
              thinkingLevels: ["minimal", "low", "medium", "high"],
            },
          ],
        },
      });
    });
    await page.route("**/api/gateway/thread/v3/queries", async (route) => {
      if (route.request().postDataJSON().type !== "thread.list") return route.continue();
      const response = await route.fetch(),
        snapshot = await response.json(),
        template = snapshot.payload.threads[0];
      snapshot.payload.threads = titles.map((_title, index) => ({
        ...template,
        threadId: index === 2 ? "thread-main" : `visual-${index}`,
        titleRef: `payload:visual-${index}`,
        pinOrder: index < 2 ? index : null,
        updatedAt: new Date(Date.UTC(2026, 8, 15, 0, 0, titles.length - index)).toISOString(),
      }));
      await route.fulfill({ response, json: snapshot });
    });
    await page.route("**/api/payload/v1/text/read", async (route) => {
      const ref = route.request().postDataJSON().payloadRef;
      if (!ref.startsWith("payload:visual-")) return route.continue();
      await route.fulfill({
        json: {
          content: titles[Number(ref.split("-").at(-1))],
          contentType: "text/plain",
          dataClassification: "private",
        },
      });
    });
    await page.goto(`${baseUrl}/threads`);
    await expect(page.locator(".thread-row > a > span:last-child").first()).toHaveText(titles[0]);
    await expect(page.locator(".model-name")).toHaveText("GLM 5.3 Flash");
    async function capture(name) {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: path.join(out, `${name}-product.png`),
        animations: "disabled",
      });
      const components = {};
      for (const [id, , selector] of pairs)
        components[id] = {
          reference: refs[name].components[id],
          product: await metric(page.locator(selector)),
        };
      report.states[name] = {
        viewport: { width: refs[name].width, height: refs[name].height },
        components,
        pixels: await pixelDifference(
          path.join(out, `${name}-reference.png`),
          path.join(out, `${name}-product.png`),
          path.join(out, `${name}-diff.png`),
        ),
      };
    }
    await page.locator(".model-picker > summary").click();
    await page.getByRole("slider").fill("2");
    await capture("model");
    await page.locator(".model-picker > summary").click();
    await page.getByRole("heading", { name: "新对话", exact: true }).click();
    await capture("empty");
    // The frozen prototype is the source of truth for these visible dimensions,
    // typography and colors; do not bless the product output as its own baseline.
    for (const pair of Object.values(report.states.empty.components))
      expect(pair.product).toEqual(pair.reference);
    await page.evaluate(() => {
      const marker = document.createElement("div");
      marker.id = "visual-difference-probe";
      marker.style.cssText =
        "position:fixed;top:0;left:0;width:20px;height:20px;background:red;z-index:99999";
      document.body.append(marker);
    });
    await page.screenshot({
      path: path.join(out, "controlled-change.png"),
      animations: "disabled",
    });
    report.controlledChange = await pixelDifference(
      path.join(out, "empty-product.png"),
      path.join(out, "controlled-change.png"),
      path.join(out, "controlled-diff.png"),
    );
    expect(report.controlledChange.changedPixels).toBe(400);
    await page.locator("#visual-difference-probe").evaluate((el) => el.remove());
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await capture("settings");
    await page.getByLabel("外观", { exact: true }).selectOption("light");
    await capture("settings-light");
    await page.getByRole("dialog", { name: "设置", exact: true }).press("Escape");
    await page.getByRole("heading", { name: "新对话", exact: true }).click();
    await capture("light");
    await page.setViewportSize({
      width: refs["mobile-light"].width,
      height: refs["mobile-light"].height,
    });
    await capture("mobile-light");
  } finally {
    await context.unrouteAll({ behavior: "wait" });
    await context.close();
  }
  await writeFile(path.join(out, "comparison.json"), JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    await captureControlCenterV4(
      browser,
      process.argv[2] ?? "http://127.0.0.1:4189",
      process.argv[3] ?? "test/qualification/evidence/control-center-v4/visual",
    );
  } finally {
    await browser.close();
  }
}
