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
const scene = (name: string) => {
  const found = all[name];
  if (!found) throw new Error(`no scene ${name}`);
  return found;
};
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
  const tab = await openPanel(context, scene("22-gaps-2-safari-panel"), words, unreachable);
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
    { ...scene("22-gaps-2c-safari-answered"), typed: "挑一家安静的" },
    words,
    unreachable,
  );
  const calls = await tab.evaluate(
    () => (globalThis as unknown as { panelCalls: unknown[] }).panelCalls,
  );
  expect(calls).toContainEqual({
    kind: "hand",
    page: scene("22-gaps-2c-safari-answered").page,
    request: "挑一家安静的",
  });
  expect(await tab.locator(".outcome-text").textContent()).toBe(words["outcome.answered"]);
  expect(await visible(tab, ".done")).toBe(true);
  expect(await visible(tab, ".follow-up")).toBe(false);
  expect(await visible(tab, ".field")).toBe(false);
  expect(await tab.locator(".sent-request").textContent()).toBe("挑一家安静的");
  expect(await visible(tab, ".sent-request")).toBe(true);
  await tab.close();

  const queued = await openPanel(context, scene("22-gaps-2d-safari-queued"), words, unreachable);
  expect(await queued.locator(".outcome-text").textContent()).toBe(words["outcome.queued"]);
  expect(await visible(queued, ".done")).toBe(false);
  expect(await visible(queued, ".follow-up")).toBe(false);
  expect(await visible(queued, ".sent-request")).toBe(false);
  await queued.close();
});

it("does not claim the full page was handed over when delivery failed", async () => {
  const tab = await openPanel(context, scene("22-gaps-2h-safari-failed"), words, unreachable);
  expect(await tab.locator(".outcome-text").textContent()).toBe(words["outcome.serverOutdated"]);
  expect(await tab.locator(".card-subtitle").textContent()).toBe("tabelog.com");
  await tab.close();
});

it("says the page was not sent when the extension cannot queue it", async () => {
  const tab = await openPanel(context, scene("22-gaps-2j-safari-not-sent"), words, unreachable);
  expect(await tab.locator(".outcome-text").textContent()).toBe(words["outcome.notSent"]);
  expect(await tab.locator(".card-subtitle").textContent()).toBe("tabelog.com");
  expect(await visible(tab, ".done")).toBe(false);
  await tab.close();
});

it("offers exactly one follow-up that opens the matching page in the App", async () => {
  const tab = await openPanel(context, scene("22-gaps-2e-safari-entry-off"), words, unreachable);
  expect(await tab.locator("button:visible").allTextContents()).toEqual([
    words["outcome.off.button"],
  ]);
  await tab.evaluate(() => {
    (globalThis as unknown as { close: () => void }).close = () => {};
  });
  await tab.click(".follow-up");
  const calls = await tab.evaluate(
    () => (globalThis as unknown as { panelCalls: unknown[] }).panelCalls,
  );
  expect(calls).toContainEqual({ kind: "tab", url: "himawari://handover/safari" });
  await tab.close();
});

it("offers to hand over just the address when the page text cannot be read", async () => {
  const unreadable = scene("22-gaps-2h-safari-text-unreadable");
  const tab = await openPanel(
    context,
    { ...unreadable, typed: "这家几点开门" },
    words,
    unreachable,
  );
  expect(await tab.locator(".card-title").textContent()).toBe("新大阪站周边午餐 10 选");
  expect(await tab.locator(".card-subtitle").textContent()).toBe(words["sheet.textUnreadable"]);
  expect(await tab.locator(".note").textContent()).toBe(words["sheet.note.urlOnly"]);
  expect(await tab.locator("button:visible").allTextContents()).toEqual([words["sheet.sendUrl"]]);
  await tab.click(".send");
  await tab.waitForFunction(() => {
    const page = (
      globalThis as unknown as {
        document: { querySelector(s: string): { hasAttribute(n: string): boolean } | null };
      }
    ).document;
    return !page.querySelector(".outcome")?.hasAttribute("hidden");
  });
  const calls = await tab.evaluate(
    () => (globalThis as unknown as { panelCalls: unknown[] }).panelCalls,
  );
  expect(calls).toContainEqual({
    kind: "hand",
    page: { url: unreadable.tab?.url, title: unreadable.tab?.title, text: "" },
    request: "这家几点开门",
  });
  await tab.close();
});

it("does not offer to send when there is no web page or the phone is not paired", async () => {
  const unreadable = await openPanel(
    context,
    scene("22-gaps-2i-safari-unreadable"),
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

  const unpaired = await openPanel(
    context,
    scene("22-gaps-2g-safari-unpaired"),
    words,
    unreachable,
  );
  expect(await visible(unpaired, ".send")).toBe(false);
  expect(await visible(unpaired, ".field")).toBe(false);
  expect(await unpaired.locator(".card-title").textContent()).toBe("新大阪站周边午餐 10 选");
  expect(await unpaired.locator(".outcome-text").textContent()).toBe(words["outcome.unpaired"]);
  expect(await unpaired.locator("button:visible").allTextContents()).toEqual([
    words["outcome.open"],
  ]);
  await unpaired.close();
});
