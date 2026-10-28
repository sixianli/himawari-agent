// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AnswerSources } from "../src/components/answer-footer.js";

it("[UI-10] shows each opened source by domain and keeps the full address on hover", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const url = "https://www3.nhk.or.jp/news/html/20261028/k10014.html";
  await act(async () => {
    root.render(
      createElement(AnswerSources, {
        sources: [{ url, title: "関東 夕方から雨の所も", site: "nhk.or.jp" }],
        message: (id) => id,
      }),
    );
  });
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".sources-toggle")?.click();
  });
  const link = host.querySelector<HTMLAnchorElement>(".source-list a");
  expect(link?.getAttribute("title")).toBe(url);
  expect(link?.querySelector("small")?.textContent).toBe("nhk.or.jp");
  expect(host.textContent).not.toContain("www3");
  act(() => root.unmount());
});
