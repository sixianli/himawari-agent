import { readdir } from "node:fs/promises";
import path from "node:path";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";
import { BrowserToolError } from "../../apps/agent-service/src/production-browser-tools.js";
import {
  approveThenUse,
  CALL_MS,
  call,
  computer,
  externalContent,
  home,
  installBrowserToolHarness,
  refOf,
  use,
} from "../fixtures/browser-tool-harness.ts";
import { RUN_ID } from "../fixtures/sqlite-capability-invocation-fixture.js";

installBrowserToolHarness();

describe("browser tool on real sites in the owner's own computer", () => {
  it(
    "searches a real site after the owner allows it, and keeps the site's cookies on the owner's disk across a restart",
    async () => {
      const opened = await approveThenUse(
        call("call:wiki-open", { action: "open", url: "https://en.wikipedia.org/wiki/Main_Page" }),
        "always",
      );
      const page = opened.value as { page: { url: string }; text: string; blockedHosts: string[] };
      expect(page.page.url).toBe("https://en.wikipedia.org/wiki/Main_Page");
      expect(computer.calls.at(-1)?.allowedDomains).toEqual([
        "en.wikipedia.org:443",
        "en.wikipedia.org:80",
      ]);
      expect(page.blockedHosts).not.toContain("en.wikipedia.org");
      const search = refOf(page.text, /^(searchbox|textbox) .*search/iu);
      const typed = await approveThenUse(
        call("call:wiki-type", {
          action: "type",
          ref: search,
          text: "Helianthus annuus",
          submit: true,
        }),
        "this_task",
      );
      const article = typed.value as { page: { url: string; title: string }; text: string };
      expect(article.page.url).toMatch(/^https:\/\/en\.wikipedia\.org\//u);
      expect(article.text).toMatch(/sunflower/iu);
      expect((await externalContent.read(RUN_ID)).map(({ origin }) => origin)).toContain(
        "browser_page",
      );
      const read = await use(call("call:wiki-read", { action: "read" }));
      expect(computer.calls.at(-1)?.allowedDomains).toEqual([]);
      expect((read.value as { text: string }).text).toMatch(/sunflower/iu);
      await computer.run(["stop"], new Uint8Array(), new Date(Date.now() + CALL_MS).toISOString());
      const cookies = openQualifiedDatabase(
        path.join(home, ".himawari/browser/profile/Default/Cookies"),
      );
      const hosts = cookies.prepare("SELECT DISTINCT host_key FROM cookies").pluck().all();
      cookies.close();
      expect(hosts).toEqual(expect.arrayContaining([".wikipedia.org"]));
      const again = await use(call("call:wiki-after-restart", { action: "read" }));
      expect((again.value as { page: { url: string } }).page.url).toBe("about:blank");
      expect(await readdir(path.join(home, ".himawari/browser/profile"))).toContain("Default");
    },
    CALL_MS * 6,
  );

  it(
    "refuses a link to a site the owner has not allowed: the proxy blocks it and the tool says which site",
    async () => {
      await approveThenUse(
        call("call:example-open", { action: "open", url: "https://example.com/" }),
        "this_task",
      );
      const read = await use(call("call:example-read", { action: "read" }));
      const link = refOf((read.value as { text: string }).text, /^link /u);
      const clicked = use(call("call:example-click", { action: "click", ref: link }));
      await expect(clicked).rejects.toBeInstanceOf(BrowserToolError);
      await clicked.catch((error: BrowserToolError) => {
        expect(error.code).toBe("BROWSER_SITE_NOT_ALLOWED");
        expect(error.note).toMatch(/iana\.org/u);
      });
      expect(computer.calls.at(-1)?.allowedDomains).toEqual(["example.com:443", "example.com:80"]);
    },
    CALL_MS * 4,
  );
});
