import type { Browser, BrowserContext } from "@playwright/test";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  openPanel,
  routePanel,
  scenes,
  strings,
  unreachableWord,
} from "../../clients/apple/scripts/safari-panel-review.mjs";
import { launchChromium } from "../fixtures/chromium-launch.ts";

const words = strings("zh-Hans");
const unreachable = unreachableWord();
const all = scenes(words);
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  browser = await launchChromium(chromium);
  context = await browser.newContext({ viewport: { width: 390, height: 520 } });
  await routePanel(context);
});

afterAll(async () => {
  await browser?.close();
});

const visible = (tab: Awaited<ReturnType<typeof openPanel>>, selector: string) =>
  tab.locator(selector).isVisible();

it("shows the page card, the request field and one send button before anything is handed over", async () => {
  const tab = await openPanel(context, all["22-gaps-2-safari-panel"], words, unreachable);
  expect(await tab.locator(".card-title").textContent()).toBe("新大阪站周边午餐 10 选");
  expect(await tab.locator(".card-subtitle").textContent()).toBe(
    `tabelog.com · ${words["sheet.fullPage"]}`,
  );
  expect(await tab.locator(".field").getAttribute("placeholder")).toBe(words["sheet.placeholder"]);
  expect(await visible(tab, ".send")).toBe(true);
  expect(await visible(tab, ".outcome")).toBe(false);
  await tab.close();
});

it("sends the typed request with the page and shows the check only when it was delivered", async () => {
  const tab = await openPanel(
    context,
    { ...all["22-gaps-2c-safari-answered"], typed: "挑一家安静的" },
    words,
    unreachable,
  );
  const calls = await tab.evaluate(
    () => (globalThis as unknown as { panelCalls: unknown[] }).panelCalls,
  );
  expect(calls).toContainEqual({
    kind: "hand",
    page: all["22-gaps-2c-safari-answered"].page,
    request: "挑一家安静的",
  });
  expect(await tab.locator(".outcome-text").textContent()).toBe(words["outcome.answered"]);
  expect(await visible(tab, ".done")).toBe(true);
  expect(await visible(tab, ".follow-up")).toBe(false);
  expect(await visible(tab, ".field")).toBe(false);
  await tab.close();

  const queued = await openPanel(context, all["22-gaps-2d-safari-queued"], words, unreachable);
  expect(await queued.locator(".outcome-text").textContent()).toBe(words["outcome.queued"]);
  expect(await visible(queued, ".done")).toBe(false);
  expect(await visible(queued, ".follow-up")).toBe(false);
  await queued.close();
});

it("offers exactly one follow-up that opens the matching page in the App", async () => {
  const tab = await openPanel(context, all["22-gaps-2e-safari-entry-off"], words, unreachable);
  expect(await tab.locator("button:visible").allTextContents()).toEqual([
    words["outcome.off.button"],
  ]);
  await tab.evaluate(() => {
    window.close = () => {};
  });
  await tab.click(".follow-up");
  const calls = await tab.evaluate(
    () => (globalThis as unknown as { panelCalls: unknown[] }).panelCalls,
  );
  expect(calls).toContainEqual({ kind: "tab", url: "himawari://handover/safari" });
  await tab.close();
});

it("does not offer to send when the page could not be read or the phone is not paired", async () => {
  const unreadable = await openPanel(
    context,
    all["22-gaps-2h-safari-unreadable"],
    words,
    unreachable,
  );
  expect(await visible(unreadable, ".card")).toBe(false);
  expect(await visible(unreadable, ".send")).toBe(false);
  expect(await unreadable.locator(".outcome-text").textContent()).toBe(words["outcome.unreadable"]);
  const calls = await unreadable.evaluate(
    () => (globalThis as unknown as { panelCalls: unknown[] }).panelCalls,
  );
  expect(calls).toContainEqual({ kind: "hand", page: null });
  await unreadable.close();

  const unpaired = await openPanel(context, all["22-gaps-2g-safari-unpaired"], words, unreachable);
  expect(await visible(unpaired, ".send")).toBe(false);
  expect(await visible(unpaired, ".field")).toBe(false);
  expect(await unpaired.locator(".outcome-text").textContent()).toBe(words["outcome.unpaired"]);
  expect(await unpaired.locator("button:visible").allTextContents()).toEqual([
    words["outcome.open"],
  ]);
  await unpaired.close();
});
