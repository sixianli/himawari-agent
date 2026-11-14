#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { watchPageErrors } from "./browser-page-errors.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(repositoryRoot, "apps/control-center");
const LOCALES = ["zh-CN", "en", "ja"];
const VIEWPORTS = [
  { width: 1280, height: 820 },
  { width: 654, height: 844 },
  { width: 390, height: 844 },
];
const THEMES = ["light", "dark"];

export function findLayoutProblems(locale) {
  const problems = [];
  const width = window.innerWidth;
  const height = window.innerHeight;
  const describe = (element) => {
    const label =
      element.getAttribute("aria-label") ||
      (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const classes = typeof element.className === "string" ? element.className.trim() : "";
    return `${element.tagName.toLowerCase()}${classes ? `.${classes.split(/\s+/).join(".")}` : ""}${
      label ? ` "${label}"` : ""
    }`;
  };
  const shown = (element) => {
    if (!element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        node.inert ||
        style.clipPath.startsWith("inset(50%")
      )
        return false;
    }
    return true;
  };
  const visibleRect = (element) => {
    const rect = element.getBoundingClientRect();
    let left = rect.left;
    let right = rect.right;
    let top = rect.top;
    let bottom = rect.bottom;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const clip = node.getBoundingClientRect();
        if (style.overflowX !== "visible") {
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
        if (style.overflowY !== "visible") {
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      if (style.position === "fixed") break;
    }
    return { left, right, top, bottom, rect };
  };
  if (document.documentElement.scrollWidth > width + 1)
    problems.push(`PAGE_SCROLLS_SIDEWAYS scrollWidth=${document.documentElement.scrollWidth}`);
  for (const node of document.querySelectorAll("body, body *")) {
    if (node.scrollLeft <= 0) continue;
    const overflowX = getComputedStyle(node).overflowX;
    if (overflowX === "hidden" || overflowX === "clip")
      problems.push(`CONTENT_PUSHED_SIDEWAYS ${describe(node)} scrollLeft=${node.scrollLeft}`);
  }
  if (width > 640)
    for (const pane of document.querySelectorAll(".sidebar .list-pane"))
      if (shown(pane.closest(".sidebar")) && !pane.getClientRects().length)
        problems.push(`SIDEBAR_CONTENT_HIDDEN ${describe(pane)}`);
  const modal = document.querySelector("dialog[open]");
  for (const element of document.body.querySelectorAll("*")) {
    if (!shown(element)) continue;
    const { left, right, top, bottom, rect } = visibleRect(element);
    if (rect.width <= 1 || rect.height <= 1) continue;
    if (right - left > 0 && bottom - top > 0 && (right > width + 1 || left < -1))
      problems.push(
        `OUTSIDE_SCREEN ${describe(element)} left=${Math.round(left)} right=${Math.round(right)}`,
      );
    if (element.matches("select")) problems.push(`NATIVE_SELECT ${describe(element)}`);
    const style = getComputedStyle(element);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
    const fontSize = Number.parseFloat(style.fontSize) || 14;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.4;
    if (
      [...ownText].length >= 4 &&
      rect.width < fontSize * 2.5 &&
      rect.height > lineHeight * 3.5 &&
      style.writingMode === "horizontal-tb"
    )
      problems.push(
        `TEXT_SQUEEZED ${describe(element)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      );
    if (
      ownText &&
      style.whiteSpace === "nowrap" &&
      style.overflowX !== "visible" &&
      style.textOverflow !== "ellipsis" &&
      element.scrollWidth > element.clientWidth + 1
    )
      problems.push(`TEXT_CUT_WITHOUT_ELLIPSIS ${describe(element)}`);
    if (
      element.matches("button, a[href], summary, [role='button'], [role='switch']") &&
      (!modal || modal.contains(element))
    ) {
      const fully =
        right - left >= rect.width - 0.5 &&
        bottom - top >= rect.height - 0.5 &&
        rect.left >= 0 &&
        rect.right <= width &&
        rect.top >= 0 &&
        rect.bottom <= height;
      if (fully) {
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (hit && hit !== element && !element.contains(hit) && !hit.contains(element))
          problems.push(`CONTROL_COVERED ${describe(element)} by ${describe(hit)}`);
      }
    }
  }
  for (const icon of document.querySelectorAll('svg[viewBox="0 0 24 24"]')) {
    if (!shown(icon)) continue;
    if (!icon.hasAttribute("data-glyph"))
      problems.push(`ICON_OUTSIDE_GLYPH_SET ${describe(icon.parentElement ?? icon)}`);
    for (const shape of icon.querySelectorAll("path[data-tone]")) {
      if (getComputedStyle(shape).fill !== "none") continue;
      problems.push(`GLYPH_FILL_LOST ${describe(icon)}`);
      break;
    }
  }
  for (const control of document.querySelectorAll("button, summary, a[href], [role='button']")) {
    if (!shown(control)) continue;
    const own = [...control.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("");
    const glyphs = [...control.querySelectorAll("[aria-hidden='true']")].map(
      (node) => node.textContent ?? "",
    );
    const glyphIcon = /(^|\s)[×✕✓›‹▶▸▾⋯⌄＋→←↑↓]$/;
    if ([own, ...glyphs].some((text) => glyphIcon.test(text.trim())))
      problems.push(`TEXT_GLYPH_ICON ${describe(control)}`);
  }
  const borderless = [
    ".action-button-primary",
    ".action-button-secondary",
    ".action-button-danger",
    '[role="tab"][aria-selected="true"]:not(.preview-sheet-tabs *)',
    '.settings-nav [aria-pressed="true"]',
    ".theme-switch",
    'input[role="switch"]',
    ".thread-message-owner",
    ".files-library-chips button",
    ".memory-chips button",
    ".thread-search input",
    ".files-library-search",
    ".file-card",
    ".composer",
    ".modal-dialog",
    ".topbar .action-button",
    ".topbar .more-button",
    ".dropdown-trigger",
    'input:is([type="text"], [type="search"], :not([type]))',
  ].join(", ");
  for (const element of document.querySelectorAll(borderless)) {
    if (!shown(element)) continue;
    const style = getComputedStyle(element);
    if (
      Number.parseFloat(style.borderTopWidth) > 0 &&
      style.borderTopStyle !== "none" &&
      !/(,\s*0\)|\/\s*0\)|transparent)$/.test(style.borderTopColor)
    )
      problems.push(`OUTLINED_CONTROL ${describe(element)} ${style.borderTopWidth}`);
  }
  const active = document.activeElement;
  if (
    active &&
    active !== document.body &&
    !active.matches("input, textarea, [contenteditable='true']") &&
    active.matches(":focus-visible")
  ) {
    const style = getComputedStyle(active);
    if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0)
      problems.push(`UNASKED_FOCUS_RING ${describe(active)}`);
  }
  if (locale !== "en") {
    const englishDate =
      /\b(January|February|March|April|June|July|August|September|October|November|December|Jan|Feb|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|AM|PM)\b/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !shown(parent)) continue;
      if (parent.closest("pre, code, .assistant-markdown, .owner-message, .thread-message-content"))
        continue;
      const text = node.textContent ?? "";
      const match = text.match(englishDate);
      if (match) problems.push(`ENGLISH_IN_${locale} "${match[0]}" in ${describe(parent)}`);
    }
  }
  return [...new Set(problems)];
}

export function labels(locale) {
  const text = readFileSync(path.join(APP, `src/i18n/resources/${locale}.ts`), "utf8");
  const value = (key) => {
    const found = text.match(new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`));
    if (!found) throw new Error(`LAYOUT_AUDIT_LABEL_MISSING ${locale} ${key}`);
    return found[1];
  };
  return {
    settings: value("settings.title"),
    memory: value("nav.memory"),
    reminders: value("nav.reminders"),
    weeklyTab: value("reminders.tab.report"),
    reviewExpand: value("dailyReview.expand"),
    files: value("library.title"),
    fork: value("answer.fork"),
    personalization: value("review.settings.personalization"),
    general: value("review.settings.general"),
    tools: value("review.settings.tools"),
    data: value("review.settings.data"),
    sensitiveOpen: value("sensitive.open"),
  };
}

async function openSidebarOnPhone(page) {
  const toggle = page.locator(".mobile-sidebar-toggle");
  if (await toggle.isVisible()) {
    await toggle.click();
    await page.waitForTimeout(250);
  }
}

async function openSettings(page, text, tab) {
  await openSidebarOnPhone(page);
  await page.getByRole("button", { name: text.settings, exact: true }).first().click();
  await page.waitForTimeout(250);
  await page
    .locator("dialog[open] .settings-nav")
    .getByRole("button", { name: text[tab], exact: true })
    .click();
  await page.waitForTimeout(200);
}

async function openWeeklyReport(page, text, ready = ".weekly-days") {
  await openSidebarOnPhone(page);
  await page.getByRole("button", { name: text.reminders, exact: true }).first().click();
  await page.getByRole("tab", { name: text.weeklyTab, exact: true }).click();
  await page.waitForSelector(ready);
}

export function findWeeklyProblems(phase = "reported") {
  const problems = [];
  const report = document.querySelector(".weekly-report");
  if (!report) return ["WEEKLY_REPORT_MISSING"];
  const shown = (element) => element.getClientRects().length > 0;
  const text = [report, ...document.querySelectorAll("dialog[open]")]
    .map((element) => element.innerText)
    .join("\n");
  if (/\b[a-z]+_[a-z_]+\b/.test(text))
    problems.push(`WEEKLY_RAW_CODE ${text.match(/\b[a-z]+_[a-z_]+\b/)[0]}`);
  if (/(^|[^\d.])0(\.0)?\s?%/.test(text)) problems.push("WEEKLY_ZERO_PERCENT");
  const days = [...report.querySelectorAll(".weekly-day")].filter(shown);
  if (phase === "unset") {
    if (days.length) problems.push(`WEEKLY_DAY_COUNT ${days.length}`);
    if (/%/.test(text)) problems.push("WEEKLY_UNSET_RATIO");
    if (![...report.querySelectorAll(".weekly-stepper")].some(shown))
      problems.push("WEEKLY_START_MISSING");
    return problems;
  }
  if (days.length !== 7) problems.push(`WEEKLY_DAY_COUNT ${days.length}`);
  const tables = [...report.querySelectorAll(".weekly-table")].filter(shown).length;
  const cards = [...report.querySelectorAll(".weekly-type-cards")].filter(shown).length;
  if (tables + cards !== 1) problems.push(`WEEKLY_TYPE_LAYOUT table=${tables} cards=${cards}`);
  return problems;
}

export const SCENES = {
  welcome: { path: "/threads", act: async () => {} },
  conversation: { path: "/threads/thread-main", act: async () => {} },
  process: {
    path: "/threads/thread-main",
    act: async (page) => {
      await page.locator(".turn-process > summary").first().click();
      await page.waitForTimeout(200);
    },
  },
  branched: {
    path: "/threads/thread-main",
    act: async (page, text) => {
      await page.getByRole("button", { name: text.fork, exact: true }).first().click();
      await page.waitForTimeout(700);
      await page.mouse.move(1, 1);
    },
  },
  settingsPersonalization: {
    path: "/threads",
    act: (page, text) => openSettings(page, text, "personalization"),
  },
  settingsGeneral: { path: "/threads", act: (page, text) => openSettings(page, text, "general") },
  settingsTools: { path: "/threads", act: (page, text) => openSettings(page, text, "tools") },
  settingsData: { path: "/threads", act: (page, text) => openSettings(page, text, "data") },
  sensitiveInterceptions: {
    path: "/threads",
    act: async (page, text) => {
      await openSettings(page, text, "data");
      await page
        .locator(".sensitive-entry")
        .getByRole("button", { name: text.sensitiveOpen, exact: true })
        .click();
      await page.waitForSelector(".sensitive-page .sensitive-item");
    },
  },
  memory: {
    path: "/threads",
    act: async (page, text) => {
      await openSidebarOnPhone(page);
      await page.getByRole("button", { name: text.memory, exact: true }).first().click();
      await page.waitForTimeout(400);
    },
  },
  memoryExternal: {
    path: "/threads",
    act: async (page, text) => {
      await page.request.post(new URL("/__fixture/external", page.url()).href, {
        data: { mode: "pending" },
      });
      await openSidebarOnPhone(page);
      await page.getByRole("button", { name: text.memory, exact: true }).first().click();
      await page.waitForSelector("#memory-external .external-proposal");
    },
  },
  reminders: {
    path: "/threads",
    act: async (page, text) => {
      await openSidebarOnPhone(page);
      await page.getByRole("button", { name: text.reminders, exact: true }).first().click();
      await page.waitForTimeout(400);
    },
  },
  remindersReview: {
    path: "/threads",
    act: async (page, text) => {
      await openSidebarOnPhone(page);
      await page.getByRole("button", { name: text.reminders, exact: true }).first().click();
      await page.waitForSelector(".proactive-review");
    },
    verify: (page) => page.evaluate(findReviewProblems),
  },
  remindersReviewFolded: {
    path: "/threads",
    act: async (page, text) => {
      await openSidebarOnPhone(page);
      await page.getByRole("button", { name: text.reminders, exact: true }).first().click();
      await page.waitForSelector(".proactive-review");
      await page
        .locator(".proactive-review-fold")
        .getByRole("button", { name: text.reviewExpand, exact: true })
        .click();
    },
    verify: (page) => page.evaluate(findReviewProblems),
  },
  weeklyReport: {
    path: "/threads",
    act: (page, text) => openWeeklyReport(page, text),
    verify: (page) => page.evaluate(findWeeklyProblems),
  },
  weeklyReportDay: {
    path: "/threads",
    act: async (page, text) => {
      await openWeeklyReport(page, text);
      await page.locator("button.weekly-day").nth(2).click();
      await page.waitForTimeout(250);
    },
    verify: (page) => page.evaluate(findWeeklyProblems, "reported"),
  },
  weeklyUnset: {
    path: "/threads",
    weekly: "unset",
    act: (page, text) => openWeeklyReport(page, text, ".weekly-stepper"),
    verify: (page) => page.evaluate(findWeeklyProblems, "unset"),
  },
  weeklyUnsetConfirm: {
    path: "/threads",
    weekly: "unset",
    act: async (page, text) => {
      await openWeeklyReport(page, text, ".weekly-stepper");
      await page.locator(".weekly-start .action-button").click();
      await page.waitForSelector("dialog[open] .weekly-confirm");
      await page.waitForTimeout(250);
    },
    verify: (page) => page.evaluate(findWeeklyProblems, "unset"),
  },
  files: {
    path: "/threads",
    act: async (page, text) => {
      await openSidebarOnPhone(page);
      await page.getByRole("button", { name: text.files, exact: true }).first().click();
      await page.waitForTimeout(400);
    },
  },
};

function launch() {
  const bundled = "/opt/pw-browsers/chromium";
  return chromium.launch(
    process.env.HIMAWARI_LAYOUT_AUDIT_CHROMIUM
      ? { executablePath: process.env.HIMAWARI_LAYOUT_AUDIT_CHROMIUM }
      : existsSync(bundled)
        ? { executablePath: bundled }
        : {},
  );
}

const REPRODUCTION = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{margin:0;font:14px/1.4 sans-serif} .wide{width:520px;height:20px;background:#eee}
.narrow{width:20px} .cut{width:60px;white-space:nowrap;overflow:hidden}
.cover{position:relative;height:40px} .cover button{position:absolute;left:0;top:0}
.cover span{position:absolute;left:0;top:0;width:120px;height:40px;background:#fff}
#focused:focus-visible{outline:2px solid blue}</style></head><body>
<div class="wide">超出屏幕的一行</div><select><option>原生下拉</option></select>
<p class="narrow">被挤成竖排的一段文字</p><p class="cut">没有省略号的长标题文字</p>
<div class="cover"><button>被挡住的按钮</button><span></span></div>
<p>日期 Thu, October 29 11:55 AM</p><button id="focused">关闭</button>
<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#000" stroke-width="1.5"><path d="M4 12h16"/></svg>
<svg data-glyph="memory" viewBox="0 0 24 24" width="20" height="20" style="fill:none"><path data-tone="base" d="M4 4h16v16H4Z"/></svg>
<button class="action-button-secondary" style="border:1.5px solid #999">描了边的胶囊按钮</button>
<button aria-label="关闭提示">×</button>
<div id="pushed" style="overflow:hidden;width:100px"><div style="width:300px">被推开的内容</div></div>
<script>document.getElementById("focused").focus();document.getElementById("pushed").scrollLeft=60</script></body></html>`;

const CLEAN = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;font:14px/1.4 sans-serif"><p>10月29日 星期四 11:55</p><button>好的</button>
<svg data-glyph="memory" viewBox="0 0 24 24" width="20" height="20"><path data-tone="base" d="M4 4h16v16H4Z" style="fill:currentColor;fill-opacity:.24"/></svg>
<button class="action-button-secondary" style="border:0;background:#eee">胶囊按钮</button></body></html>`;

export function findReviewProblems() {
  const problems = [];
  const section = document.querySelector(".proactive-review");
  if (!section) return ["REVIEW_SECTION_MISSING"];
  const rect = section.getBoundingClientRect();
  if (rect.height > window.innerHeight)
    problems.push(`REVIEW_EXCEEDS_SCREEN ${Math.round(rect.height)}>${window.innerHeight}`);
  const rows = section.querySelectorAll(".proactive-review-list > li").length;
  if (rows > 6) problems.push(`REVIEW_TOO_MANY_ROWS ${rows}`);
  if (section.scrollHeight > section.clientHeight + 1) problems.push("REVIEW_SCROLLS_INSIDE");
  return problems;
}

const REVIEW_TALL = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
<section class="proactive-review"><ul class="proactive-review-list">${"<li style='height:200px'>行</li>".repeat(8)}</ul></section></body></html>`;
const REVIEW_FITS = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
<section class="proactive-review"><ul class="proactive-review-list">${"<li style='height:52px'>行</li>".repeat(6)}</ul></section></body></html>`;

const WEEKLY_BROKEN = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
<div class="weekly-report"><p>proactive_writing gap_too_long</p><p>提醒得对 0%（0/2）</p>
${"<button class='weekly-day'>第 1 天</button>".repeat(3)}
<table class="weekly-table"><tr><td>行</td></tr></table><div class="weekly-type-cards">卡片</div></div></body></html>`;
const WEEKLY_CLEAN = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
<div class="weekly-report"><p>提醒得对 75.0%（6/8）</p><p>样本不足（4 条）</p>
${"<button class='weekly-day'>第 1 天</button>".repeat(7)}
<table class="weekly-table"><tr><td>行</td></tr></table><div class="weekly-type-cards" style="display:none">卡片</div></div></body></html>`;
const WEEKLY_UNSET_BROKEN = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
<div class="weekly-report"><p>配对率 95.2%（40/42）</p>
${"<button class='weekly-day'>第 1 天</button>".repeat(2)}</div></body></html>`;
const WEEKLY_UNSET_CLEAN = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
<div class="weekly-report"><p>还没开始观察</p><fieldset class="weekly-stepper"><output>11 月 5 日</output></fieldset></div></body></html>`;
const WEEKLY_UNSET_KINDS = ["WEEKLY_UNSET_RATIO", "WEEKLY_START_MISSING", "WEEKLY_DAY_COUNT"];
const WEEKLY_KINDS = [
  "WEEKLY_RAW_CODE",
  "WEEKLY_ZERO_PERCENT",
  "WEEKLY_DAY_COUNT",
  "WEEKLY_TYPE_LAYOUT",
];

export const REQUIRED_KINDS = [
  "PAGE_SCROLLS_SIDEWAYS",
  "CONTENT_PUSHED_SIDEWAYS",
  "OUTSIDE_SCREEN",
  "NATIVE_SELECT",
  "TEXT_SQUEEZED",
  "TEXT_CUT_WITHOUT_ELLIPSIS",
  "CONTROL_COVERED",
  "UNASKED_FOCUS_RING",
  "ENGLISH_IN_zh-CN",
  "GLYPH_FILL_LOST",
  "OUTLINED_CONTROL",
  "ICON_OUTSIDE_GLYPH_SET",
  "TEXT_GLYPH_ICON",
  "SIDEBAR_CONTENT_HIDDEN",
];

const SIDEBAR_REPRODUCTION = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
<aside class="sidebar"><p>侧栏</p><section class="list-pane" style="display:none"><p>会话列表</p></section></aside></body></html>`;

async function selfTest(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.setContent(REPRODUCTION);
    const found = await page.evaluate(findLayoutProblems, "zh-CN");
    await page.setViewportSize({ width: 654, height: 844 });
    await page.setContent(SIDEBAR_REPRODUCTION);
    found.push(...(await page.evaluate(findLayoutProblems, "zh-CN")));
    await page.setViewportSize({ width: 390, height: 844 });
    const missing = REQUIRED_KINDS.filter((kind) => !found.some((item) => item.startsWith(kind)));
    await page.setContent(REVIEW_TALL);
    const tall = await page.evaluate(findReviewProblems);
    for (const kind of ["REVIEW_EXCEEDS_SCREEN", "REVIEW_TOO_MANY_ROWS"])
      if (!tall.some((item) => item.startsWith(kind))) missing.push(`REVIEW_${kind}`);
    await page.setContent(WEEKLY_BROKEN);
    const weekly = await page.evaluate(findWeeklyProblems);
    for (const kind of WEEKLY_KINDS)
      if (!weekly.some((item) => item.startsWith(kind))) missing.push(kind);
    await page.setContent(WEEKLY_UNSET_BROKEN);
    const unset = await page.evaluate(findWeeklyProblems, "unset");
    for (const kind of WEEKLY_UNSET_KINDS)
      if (!unset.some((item) => item.startsWith(kind))) missing.push(`UNSET_${kind}`);
    await page.setContent(WEEKLY_UNSET_CLEAN);
    const unsetClean = await page.evaluate(findWeeklyProblems, "unset");
    await page.setContent(WEEKLY_CLEAN);
    const weeklyClean = [...(await page.evaluate(findWeeklyProblems)), ...unsetClean];
    await page.setContent(REVIEW_FITS);
    const fits = [...(await page.evaluate(findReviewProblems)), ...weeklyClean];
    await page.setContent(CLEAN);
    const clean = [...(await page.evaluate(findLayoutProblems, "zh-CN")), ...fits];
    const errors = [
      ...missing.map((kind) => `LAYOUT_AUDIT_SELF_TEST_MISSED ${kind}`),
      ...clean.map((item) => `LAYOUT_AUDIT_SELF_TEST_FALSE_ALARM ${item}`),
    ];
    return errors;
  } finally {
    await page.close();
  }
}

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

async function build(outDir) {
  await new Promise((resolve, reject) => {
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
      code === 0 ? resolve() : reject(new Error(`LAYOUT_AUDIT_BUILD_FAILED ${code}`)),
    );
  });
}

async function startFixture(staticRoot) {
  const port = await freePort();
  const child = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], {
    cwd: repositoryRoot,
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
      const response = await fetch(`${base}/threads`);
      if (response.ok) return { base, child };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error("LAYOUT_AUDIT_FIXTURE_DID_NOT_START");
}

async function auditApp(browser, base, only) {
  const jobs = [];
  for (const locale of LOCALES)
    for (const viewport of VIEWPORTS)
      for (const theme of THEMES)
        for (const [name, scene] of Object.entries(SCENES))
          if (!only.length || only.includes(name))
            jobs.push({ locale, viewport, theme, name, scene });
  const problems = [];
  let next = 0;
  const worker = async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      const where = `${job.name} ${job.locale} ${job.viewport.width} ${job.theme}`;
      const context = await browser.newContext({
        viewport: job.viewport,
        locale: "en-US",
        timezoneId: "Asia/Tokyo",
        reducedMotion: "reduce",
      });
      try {
        await context.addInitScript(
          ([locale, theme]) => {
            localStorage.setItem("himawari.control-center.v1.locale", locale);
            localStorage.setItem(
              "himawari.control-center.v1.preferences",
              JSON.stringify({ theme, accent: "violet" }),
            );
          },
          [job.locale, job.theme],
        );
        await context.addInitScript(() => {
          document.addEventListener("DOMContentLoaded", () => {
            const style = document.createElement("style");
            style.textContent =
              "*,*::before,*::after{transition:none!important;animation:none!important}";
            document.head.append(style);
          });
        });
        if (job.scene.weekly)
          await context.addCookies([
            { name: "himawari-fixture-weekly", value: job.scene.weekly, url: base },
          ]);
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        watchPageErrors(page, (error) => problems.push(`${where}: PAGE_ERROR ${error.message}`));
        await page.goto(`${base}${job.scene.path}`);
        await page.waitForTimeout(600);
        await job.scene.act(page, labels(job.locale));
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(150);
        for (const item of await page.evaluate(findLayoutProblems, job.locale))
          problems.push(`${where}: ${item}`);
        if (job.scene.verify)
          for (const item of await job.scene.verify(page)) problems.push(`${where}: ${item}`);
      } catch (error) {
        problems.push(
          `${where}: SCENE_FAILED ${error instanceof Error ? error.message.split("\n")[0] : error}`,
        );
      } finally {
        await context.close();
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return problems;
}

async function main() {
  const only = process.argv.slice(2).filter((item) => !item.startsWith("--"));
  const started = Date.now();
  const browser = await launch();
  const temporary = await mkdtemp(path.join(tmpdir(), "himawari-layout-audit-"));
  let fixture;
  try {
    const selfErrors = await selfTest(browser);
    if (selfErrors.length) {
      for (const error of selfErrors) console.error(error);
      process.exitCode = 1;
      return;
    }
    console.log(`LAYOUT_AUDIT self-test passed kinds=${REQUIRED_KINDS.length}`);
    if (process.argv.includes("--self-test")) return;
    await build(temporary);
    await writeFile(path.join(temporary, ".layout-audit"), "");
    fixture = await startFixture(temporary);
    const problems = await auditApp(browser, fixture.base, only);
    for (const problem of problems) console.error(`LAYOUT_AUDIT ${problem}`);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (problems.length) {
      console.error(`LAYOUT_AUDIT failed problems=${problems.length} seconds=${seconds}`);
      process.exitCode = 1;
    } else
      console.log(
        `LAYOUT_AUDIT passed scenes=${Object.keys(SCENES).length * LOCALES.length * VIEWPORTS.length * THEMES.length} seconds=${seconds}`,
      );
  } finally {
    fixture?.child.kill();
    await browser.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
