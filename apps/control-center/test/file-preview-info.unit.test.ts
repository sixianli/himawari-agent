// @vitest-environment jsdom
import ExcelJS from "exceljs";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
            bytes: async () => new ArrayBuffer(0),
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
  expect(meta?.textContent).toContain("来自「贪吃蛇」第 1 轮");
  expect(meta?.querySelector('.preview-source-link [data-glyph="chevron"]')).not.toBeNull();
  expect(meta?.querySelector(".preview-versions")).not.toBeNull();
  expect(meta?.textContent).toContain(zh["preview.isolated"]);
  await act(async () => info?.click());
  expect(container.querySelector(".preview-meta")).toBeNull();
});

const workbookFile: RegisteredFile = {
  ...snake,
  id: "file:sheet",
  path: "新闻来源统计.xlsx",
  name: "新闻来源统计.xlsx",
  kind: "data",
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  version: 1,
};

async function openWorkbook(bytes: () => Promise<ArrayBuffer>) {
  await act(async () =>
    root.render(
      h(
        IntlProvider,
        { locale: "zh-CN", messages: zh },
        h(ContentPreview, {
          value: previewOfDelivered(libraryFile(workbookFile)),
          access: {
            text: async () => "",
            bytes,
            versions: async () => [],
            previewUrl: undefined,
          },
          onClose: () => {},
        }),
      ),
    ),
  );
  await vi.waitFor(() => {
    expect(container.textContent).not.toContain(zh["preview.loading"]);
    expect(container.querySelector(".preview-body")?.childElementCount).toBeGreaterThan(0);
  });
}

it("draws a delivered workbook as a sheet table with its tabs, colors and formatted numbers", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("新闻统计");
  sheet.addRow(["来源", "占比"]);
  sheet.addRow(["共同通信", 0.2857]);
  sheet.getCell("B2").numFmt = "0.0%";
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
  workbook.addWorksheet("English").addRow(["Rank", "Headline"]);
  const bytes = await workbook.xlsx.writeBuffer();
  await openWorkbook(async () => bytes as ArrayBuffer);
  const tabs = [...container.querySelectorAll('.preview-sheet-tabs [role="tab"]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual(["新闻统计", "English"]);
  const cells = [...container.querySelectorAll(".preview-sheet-table td")];
  expect(cells.map((cell) => cell.textContent)).toEqual(["来源", "占比", "共同通信", "28.6%"]);
  expect((cells[0] as HTMLElement).style.background).toContain("217, 226, 243");
  await act(async () => (tabs[1] as HTMLButtonElement).click());
  expect(container.querySelector(".preview-sheet-table td")?.textContent).toBe("Rank");
  expect(container.querySelector('button[aria-label="复制"]')).toBeNull();
});

it("says the workbook could not be shown instead of failing silently when the bytes are not a workbook", async () => {
  await openWorkbook(async () => new TextEncoder().encode("not a zip").buffer as ArrayBuffer);
  expect(container.querySelector(".preview-body")?.textContent).toBe(zh["preview.renderFailed"]);
});
