import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { BrowserThreadFileContent } from "../src/browser-thread-files.js";
import { PREVIEW_STORAGE_SCRIPT, withPreviewStorage } from "../src/preview-page-storage.js";

const GAME_SCRIPT = `
const best = Number(localStorage.getItem("best") ?? 0);
localStorage.setItem("best", String(best + 5));
globalThis.result = [localStorage.getItem("best"), localStorage.length, localStorage.key(0), sessionStorage.getItem("missing")];
`;

function htmlContent(html: string): BrowserThreadFileContent {
  return {
    bytes: new TextEncoder().encode(html),
    mediaType: "text/html",
    fileName: "snake.html",
    disposition: "inline",
  };
}

function served(content: BrowserThreadFileContent): string {
  return new TextDecoder().decode(withPreviewStorage(content).bytes);
}

function sandboxedFrame(providedStorage?: object) {
  const frame = createContext({
    providedStorage,
    denied: (name: string) => {
      throw new DOMException(
        `Failed to read the '${name}' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.`,
        "SecurityError",
      );
    },
  });
  runInContext(
    `globalThis.window = globalThis;
for (const name of ["localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    get: () => providedStorage ?? denied(name),
  });
}`,
    frame,
  );
  return frame;
}

function pageScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
}

describe("[FD-3] preview pages keep working without same-origin storage", () => {
  it("a page that reads localStorage on load stops before wiring its buttons in the sandboxed preview", () => {
    const frame = sandboxedFrame();
    expect(() => runInContext(GAME_SCRIPT, frame)).toThrow(/allow-same-origin/);
  });

  it("the served preview gives the page an in-memory storage so its script runs to the end", () => {
    const html = served(
      htmlContent(`<!DOCTYPE html><html><head><script>${GAME_SCRIPT}</script></head></html>`),
    );
    const frame = sandboxedFrame();
    for (const script of pageScripts(html)) runInContext(script, frame);
    expect(runInContext("JSON.stringify(result)", frame)).toBe(
      JSON.stringify(["5", 1, "best", null]),
    );
  });

  it("leaves storage alone when the browser does provide it", () => {
    const real = { getItem: () => "41" };
    const frame = sandboxedFrame(real);
    runInContext(pageScripts(PREVIEW_STORAGE_SCRIPT)[0] ?? "", frame);
    expect(runInContext("window.localStorage", frame)).toBe(real);
  });

  it("keeps the doctype first so the page stays in standards mode", () => {
    expect(served(htmlContent("<!DOCTYPE html>\n<html><body>蛇</body></html>"))).toBe(
      `<!DOCTYPE html>${PREVIEW_STORAGE_SCRIPT}\n<html><body>蛇</body></html>`,
    );
    expect(served(htmlContent("<p>片段</p>"))).toBe(`${PREVIEW_STORAGE_SCRIPT}<p>片段</p>`);
  });

  it("serves files that are not HTML unchanged", () => {
    const svg: BrowserThreadFileContent = { ...htmlContent("<svg/>"), mediaType: "image/svg+xml" };
    expect(withPreviewStorage(svg)).toBe(svg);
  });
});
