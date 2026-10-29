// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilesLibrary, type LibraryQuery } from "../src/components/files-library.js";
import type { MessageId } from "../src/i18n/message-ids.js";
import { messages as en } from "../src/i18n/resources/en.js";
import { messages as ja } from "../src/i18n/resources/ja.js";
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

const file = (id: string, path: string): RegisteredFile =>
  ({
    id,
    threadId: "thread-1",
    runId: "run-1",
    turn: 1,
    path,
    kind: "document",
    source: "write",
    version: 1,
    sizeBytes: 120,
    createdAt: new Date().toISOString(),
  }) as unknown as RegisteredFile;

const message = (id: MessageId, values?: Record<string, unknown>) =>
  `${id}${values ? JSON.stringify(values) : ""}`;

const render = (
  list: (query: LibraryQuery) => Promise<{ items: RegisteredFile[]; nextCursor: string | null }>,
) =>
  act(async () =>
    root.render(
      h(FilesLibrary, {
        list,
        threadTitle: () => "Weather",
        openKey: undefined,
        onOpen: () => undefined,
        onBack: undefined,
        message,
      }),
    ),
  );

it("keeps the file list on screen when the page around it re-renders", async () => {
  const items = [file("f1", "report.md")];
  const first = vi.fn(async () => ({ items, nextCursor: null }));
  await render(first);
  expect(container.textContent).toContain("report.md");
  const second = vi.fn(async (_query: LibraryQuery) => ({ items, nextCursor: null }));
  await render((query) => second(query));
  await render((query) => second(query));
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  expect(container.textContent).toContain("report.md");
  expect(container.textContent).not.toContain("state.loading");
});

it("keeps the old rows while a new category loads instead of blanking the page", async () => {
  let resolve: (value: { items: RegisteredFile[]; nextCursor: null }) => void = () => undefined;
  const list = vi.fn(async (query: LibraryQuery) =>
    query.kind
      ? new Promise<{ items: RegisteredFile[]; nextCursor: null }>((done) => {
          resolve = done;
        })
      : { items: [file("f1", "report.md")], nextCursor: null },
  );
  await render(list);
  const tables = container.querySelectorAll<HTMLButtonElement>(".files-library-chips button")[2];
  await act(async () => tables?.click());
  expect(container.textContent).toContain("report.md");
  expect(container.querySelector(".files-library")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => resolve({ items: [file("f2", "sales.csv")], nextCursor: null }));
  expect(container.textContent).toContain("sales.csv");
  expect(container.textContent).not.toContain("report.md");
  expect(container.querySelector(".files-library")?.getAttribute("aria-busy")).toBe("false");
});

it("shows a placeholder instead of loading text before the first page arrives", async () => {
  await render(() => new Promise(() => undefined));
  expect(container.querySelector(".files-library-skeleton")).not.toBeNull();
  expect(container.textContent).not.toContain("state.loading");
});

it("words the shared loading text plainly in every language", () => {
  expect(zh["state.loading"]).toBe("正在加载…");
  expect(en["state.loading"]).toBe("Loading…");
  expect(ja["state.loading"]).toBe("読み込み中…");
});

it("says the file count is a lower bound while more pages are still on the server", async () => {
  await render(async () => ({ items: [file("f1", "report.md")], nextCursor: "cursor-2" }));
  await act(async () => {});
  expect(container.querySelector(".files-library-count")?.textContent).toBe(
    'library.count{"count":1,"more":"yes"}',
  );
});

it("gives the exact file count once the server has no more pages", async () => {
  await render(async () => ({ items: [file("f1", "report.md")], nextCursor: null }));
  await act(async () => {});
  expect(container.querySelector(".files-library-count")?.textContent).toBe(
    'library.count{"count":1,"more":"no"}',
  );
});
