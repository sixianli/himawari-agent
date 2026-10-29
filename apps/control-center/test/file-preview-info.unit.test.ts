// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ContentPreview, previewOfDelivered } from "../src/components/content-preview.js";
import { libraryFile } from "../src/components/files-library.js";
import { messages as zh } from "../src/i18n/resources/zh-CN.js";
import type { RegisteredFile } from "../src/registered-files.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const snake: RegisteredFile = {
  id: "file:snake",
  threadId: "thread:1",
  runId: "run:1",
  toolCallId: "call:1",
  toolItemId: "item:1",
  source: "write",
  path: "snake.html",
  name: "snake.html",
  kind: "web",
  mediaType: "text/html",
  sizeBytes: 2048,
  version: 2,
  turn: 1,
  commandKey: null,
  stored: true,
  overlapped: false,
  createdAt: "2026-10-28T06:12:00.000Z",
};

it("shows only the content until the owner opens file info, which holds facts, versions, source and the isolation note", async () => {
  const file = { ...libraryFile(snake), versions: 2 };
  await act(async () =>
    root.render(
      h(
        IntlProvider,
        { locale: "zh-CN", messages: zh },
        h(ContentPreview, {
          value: previewOfDelivered(file, { label: "来自「贪吃蛇」第 1 轮", onOpen: () => {} }),
          access: {
            text: async () => "",
            versions: async () => [snake, { ...snake, id: "file:snake:1", version: 1 }],
            previewUrl: async () => "https://preview.example/snake.html",
          },
          onClose: () => {},
        }),
      ),
    ),
  );
  expect(container.querySelector(".preview-meta")).toBeNull();
  expect(container.textContent).not.toContain(zh["preview.isolated"]);
  const info = container.querySelector<HTMLButtonElement>('button[aria-label="文件信息"]');
  await act(async () => info?.click());
  expect(info?.getAttribute("aria-expanded")).toBe("true");
  const meta = container.querySelector(".preview-meta");
  expect(meta?.textContent).toContain("来自「贪吃蛇」第 1 轮 →");
  expect(meta?.querySelector(".preview-versions")).not.toBeNull();
  expect(meta?.textContent).toContain(zh["preview.isolated"]);
  await act(async () => info?.click());
  expect(container.querySelector(".preview-meta")).toBeNull();
});
