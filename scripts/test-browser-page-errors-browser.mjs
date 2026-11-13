import http from "node:http";
import { collectPageErrors } from "./browser-page-errors.mjs";

const blocked = / due to access control checks\.$/u;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function origin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function blockedHosts(messages) {
  return messages
    .filter((message) => blocked.test(message))
    .map((message) => message.split("/")[1])
    .sort();
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function qualifyPageErrorFilter(browser) {
  const page = await listen((request, response) => {
    if (request.url.startsWith("/slow")) {
      setTimeout(() => response.end("{}"), 3_000);
      return;
    }
    if (request.url.startsWith("/probe")) return response.end("{}");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>page-error-filter</title>");
  });
  const other = await listen((_request, response) => response.end("{}")).catch(async (error) => {
    await close(page);
    throw error;
  });
  const pageOrigin = origin(page);
  const otherOrigin = origin(other);
  const pageHost = new URL(pageOrigin).host;
  const otherHost = new URL(otherOrigin).host;
  const cases = [];
  let context;
  try {
    context = await browser.newContext();
    for (const scenario of [
      { name: "same-origin-fetch-started-while-reloading", target: pageOrigin, reload: true },
      { name: "cross-origin-fetch-started-while-reloading", target: otherOrigin, reload: true },
      { name: "cross-origin-fetch-on-stable-page", target: otherOrigin, reload: false },
      { name: "same-origin-fetch-in-flight-while-reloading", target: pageOrigin, inFlight: true },
    ]) {
      const tab = await context.newPage();
      const raw = [];
      tab.on("pageerror", (error) => raw.push(error.message));
      const filtered = collectPageErrors(tab);
      await tab.goto(`${pageOrigin}/`);
      const url = `${scenario.target}/probe`;
      if (scenario.inFlight) {
        const sent = tab.waitForRequest((request) => request.url().endsWith("/slow"));
        await tab.evaluate(() => {
          fetch("/slow", { method: "POST" }).catch(() => {});
        });
        await sent;
        await tab.reload();
      } else if (scenario.reload) {
        await tab.evaluate((url) => {
          addEventListener("pagehide", () => {
            fetch(url, { method: "POST" }).catch(() => {});
          });
        }, url);
        await tab.reload();
      } else {
        await tab.evaluate((url) => fetch(url, { method: "POST" }).catch(() => {}), url);
      }
      await tab.waitForTimeout(200);
      await tab.close();
      cases.push({
        name: scenario.name,
        rawBlocked: blockedHosts(raw),
        recordedBlocked: blockedHosts(filtered),
        rawOther: raw.filter((message) => !blocked.test(message)),
        recordedOther: filtered.filter((message) => !blocked.test(message)),
      });
    }
  } finally {
    await context?.close();
    await Promise.all([close(page), close(other)]);
  }
  const engine = browser.browserType().name();
  for (const entry of cases) {
    if (JSON.stringify(entry.rawOther) !== JSON.stringify(entry.recordedOther))
      throw new Error(`PAGE_ERROR_FILTER_DROPPED_OTHER_ERROR:${entry.name}`);
    const expectedRecorded = entry.name.startsWith("same-origin")
      ? entry.rawBlocked.filter((host) => host !== pageHost)
      : entry.rawBlocked;
    if (JSON.stringify(entry.recordedBlocked) !== JSON.stringify(expectedRecorded))
      throw new Error(`PAGE_ERROR_FILTER_MISMATCH:${entry.name}:${JSON.stringify(entry)}`);
    if (engine !== "webkit" || entry.name.includes("in-flight")) continue;
    const expectedHost = entry.name.startsWith("same-origin") ? pageHost : otherHost;
    if (!entry.rawBlocked.includes(expectedHost))
      throw new Error(`PAGE_ERROR_FILTER_SCENARIO_NOT_REPRODUCED:${entry.name}`);
  }
  return { engine, cases };
}
