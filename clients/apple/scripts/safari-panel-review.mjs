import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const appleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(appleRoot, "App/SafariExtension/Resources");
const out = path.resolve(process.argv[2] ?? path.join(appleRoot, "ui-review/safari-panel"));

export const strings = (language) => {
  const file = path.join(
    appleRoot,
    `Sources/HimawariShare/Resources/${language}.lproj/Localizable.strings`,
  );
  return Object.fromEntries(
    [...readFileSync(file, "utf8").matchAll(/^"([^"]+)" = "((?:[^"\\]|\\.)*)";$/gmu)].map((m) => [
      m[1],
      m[2],
    ]),
  );
};

const page = {
  url: "https://tabelog.com/osaka/shin-osaka/lunch",
  title: "新大阪站周边午餐 10 选",
  text: "从车站走路 5 分钟以内",
};
const finished = (words, key, extra = {}) => ({
  phase: "finished",
  done: false,
  line: words[key],
  ...extra,
});

export function scenes(words) {
  return {
    "22-gaps-2-safari-panel": { open: { phase: "editing" }, page, typed: "" },
    "22-gaps-2b-safari-panel-typed": {
      open: { phase: "editing" },
      page,
      typed: "周五和田中吃饭，帮我挑一家安静的",
    },
    "22-gaps-2c-safari-answered": {
      open: { phase: "editing" },
      page,
      typed: "周五和田中吃饭，帮我挑一家安静的",
      hand: finished(words, "outcome.answered", { done: true }),
    },
    "22-gaps-2d-safari-queued": {
      open: { phase: "editing" },
      page,
      hand: finished(words, "outcome.queued"),
    },
    "22-gaps-2h-safari-failed": {
      open: { phase: "editing" },
      page,
      hand: finished(words, "outcome.serverOutdated", { kept: false }),
    },
    "22-gaps-2e-safari-entry-off": {
      open: { phase: "editing" },
      page,
      hand: finished(words, "outcome.off.safari", {
        button: words["outcome.off.button"],
        link: "himawari://handover/safari",
      }),
    },
    "22-gaps-2f-safari-removed": {
      open: { phase: "editing" },
      page,
      hand: finished(words, "outcome.removed", {
        button: words["outcome.open"],
        link: "himawari://",
      }),
    },
    "22-gaps-2g-safari-unpaired": {
      open: {
        phase: "unpaired",
        line: words["outcome.unpaired"],
        button: words["outcome.open"],
        link: "himawari://",
      },
      page,
    },
    "22-gaps-2h-safari-text-unreadable": {
      open: { phase: "editing" },
      page: null,
      tab: page,
      hand: finished(words, "outcome.delivered", { done: true }),
    },
    "22-gaps-2i-safari-unreadable": {
      open: { phase: "editing" },
      page: null,
      tab: { url: "about:blank", title: "" },
      hand: { phase: "unreadable", done: false, line: words["outcome.unreadable"] },
    },
  };
}

function mockBrowser({ open, page: current, tab, hand, words, unreachable }) {
  globalThis.panelCalls = [];
  globalThis.browser = {
    runtime: {
      sendMessage: async (message) => {
        globalThis.panelCalls.push(message);
        return message.kind === "open"
          ? { ...open, words }
          : (hand ?? { phase: "finished", done: true, line: "" });
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: (current ?? tab)?.url, title: (current ?? tab)?.title }],
      create: async (options) => {
        globalThis.panelCalls.push({ kind: "tab", ...options });
        return {};
      },
    },
    scripting: {
      executeScript: async () =>
        current ? [{ result: current }] : Promise.reject(new Error("no access")),
    },
    i18n: { getMessage: () => unreachable },
  };
}

export const unreachableWord = () =>
  JSON.parse(readFileSync(path.join(resources, "_locales/zh_CN/messages.json"), "utf8")).unreachable
    .message;

export async function routePanel(context) {
  await context.route("http://panel.test/**", (route) => {
    const file = path.join(resources, decodeURIComponent(new URL(route.request().url()).pathname));
    const type = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".svg": "image/svg+xml",
    }[path.extname(file)];
    route.fulfill({ body: readFileSync(file), contentType: type ?? "application/octet-stream" });
  });
}

export async function openPanel(context, scene, words, unreachable) {
  const tab = await context.newPage();
  await tab.addInitScript(mockBrowser, {
    ...scene,
    words,
    unreachable,
    tab: scene.tab ?? null,
    hand: scene.hand ?? null,
  });
  await tab.goto("http://panel.test/popup.html");
  await tab.waitForFunction(() => document.querySelector(".panel").dataset.phase !== "loading");
  if (scene.typed) await tab.fill(".field", scene.typed);
  if (scene.hand && scene.page) {
    await tab.click(".send");
    await tab.waitForFunction(
      () =>
        document.querySelector(".panel").dataset.phase !== "sending" &&
        !document.querySelector(".outcome").hidden,
    );
  }
  return tab;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(out, { recursive: true });
  const words = strings("zh-Hans");
  const unreachable = unreachableWord();
  const configured = process.env.HIMAWARI_CHROMIUM_PATH;
  const browser = await chromium.launch(configured ? { executablePath: configured } : {});
  try {
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 520 },
        deviceScaleFactor: 2,
        colorScheme: scheme,
      });
      await routePanel(context);
      for (const [name, scene] of Object.entries(scenes(words))) {
        const tab = await openPanel(context, scene, words, unreachable);
        await tab.locator(".panel").screenshot({ path: path.join(out, `${name}-${scheme}.png`) });
        await tab.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`SAFARI_PANEL_REVIEW_WRITTEN ${out}\n`);
}
