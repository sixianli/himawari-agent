import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { routeForSurface } from "../src/app/router.js";
import { ThreadSidebar, type ThreadSidebarProps } from "../src/components/thread-sidebar.js";
import { IntlProvider } from "react-intl";
import { messages } from "../src/i18n/resources/zh-CN.js";

const thread = (id: string, pinOrder: number | null): ThreadSidebarProps["threads"][number] => ({
  threadId: id,
  revision: 1,
  status: "active",
  titleRef: `title:${id}`,
  titleSource: "owner",
  titleRevision: 1,
  pinOrder,
  answerLocale: "zh-CN",
  messageWatermark: 0,
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
});

function render(threads: ThreadSidebarProps["threads"], loading = false, hasLoaded = true) {
  return renderToStaticMarkup(
    h(
      IntlProvider,
      { locale: "zh-CN", messages },
      h(ThreadSidebar, {
        threads,
        contentByRef: {
          "title:first": "先置顶",
          "title:last": "后置顶",
          "title:recent": "最近的工作",
        },
        loading,
        hasLoaded,
        searchText: "",
        selectedThreadId: "recent",
        route: routeForSurface("threads"),
        onSearchTextChange: vi.fn(),
        onSearch: vi.fn(),
        onCreate: vi.fn(),
        onRefresh: vi.fn(),
        onNavigate: vi.fn(),
      }),
    ),
  );
}

describe("thread sidebar navigation", () => {
  it("shows quiet placeholders only before the first collection arrives", () => {
    const markup = render([], true, false);
    expect(markup).toContain('class="thread-loading-skeleton"');
    expect(markup).not.toContain("正在加载权威状态");
  });

  it("keeps a loaded empty collection quiet during background refresh", () => {
    const markup = render([], true, true);
    expect(markup).not.toContain("正在加载权威状态");
    expect(markup).not.toContain('class="thread-loading-skeleton"');
  });

  it("separates ordered pins from recent conversations without duplicating links", () => {
    const threads = [thread("recent", null), thread("last", 2), thread("first", 0)];
    const markup = render(threads);
    expect(markup.indexOf('title="先置顶"')).toBeLessThan(markup.indexOf('title="后置顶"'));
    expect(markup.indexOf('title="后置顶"')).toBeLessThan(markup.indexOf('title="最近的工作"'));
    expect(markup.match(/title="最近的工作"/g)).toHaveLength(1);
    expect(markup).toContain('href="/threads/recent"');
    expect(markup).toContain('aria-current="page"');
    expect(threads.map(({ threadId }) => threadId)).toEqual(["recent", "last", "first"]);
  });

  it("keeps search and archive filters accessible when the collection is empty", () => {
    const markup = render([]);
    expect(markup).toContain('aria-label="搜索对话"');
    expect(markup).toContain('aria-label="对话筛选"');
    expect(markup).toContain('value="archived"');
    expect(markup).toContain('value="all"');
    expect(markup).not.toContain('aria-label="置顶"');
  });
});
