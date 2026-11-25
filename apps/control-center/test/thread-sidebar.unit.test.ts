import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { routeForSurface } from "../src/app/router.js";
import { ThreadSidebar, type ThreadSidebarProps } from "../src/components/thread-sidebar.js";
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
  messageWatermark: 2,
  sourceThreadId: null,
  sourceWatermark: null,
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
});

function render(
  threads: ThreadSidebarProps["threads"],
  loading = false,
  hasLoaded = true,
  extra: Partial<ThreadSidebarProps> = {},
) {
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
        onRefresh: vi.fn(),
        onNavigate: vi.fn(),
        ...extra,
      }),
    ),
  );
}

describe("thread sidebar navigation", () => {
  it("[UI-27] leaves conversations that never got a message out of the list, except the open one and branches", () => {
    const empty = { ...thread("empty", null), messageWatermark: 0 };
    const html = render([
      empty,
      {
        ...thread("branch", null),
        messageWatermark: 0,
        sourceThreadId: "first",
        sourceWatermark: 2,
      },
      { ...thread("recent", null), messageWatermark: 0 },
      thread("first", null),
    ]);
    expect(html).not.toContain('href="/threads/empty"');
    expect(html).toContain('href="/threads/branch"');
    expect(html).toContain('href="/threads/recent"');
    expect(html).toContain('href="/threads/first"');
  });
  it("lists memory and reminders as their own pages and marks due reminders with a dot", () => {
    const quiet = render([], false, true, {
      onOpenMemory: vi.fn(),
      onOpenReminders: vi.fn(),
      onOpenFiles: vi.fn(),
      openPage: "memory",
    });
    const labels = [...quiet.matchAll(/<button[^>]*>(?:<svg.*?<\/svg>)?([^<]+)/g)].map(
      (match) => match[1],
    );
    expect(labels.slice(0, 3)).toEqual(["记忆", "提醒", "文件"]);
    expect(quiet).not.toContain("新建对话");
    expect(quiet).toMatch(/aria-pressed="true"[^>]*><svg[^>]*>.*?<\/svg>记忆/);
    expect(quiet).not.toContain("nav-dot");
    const due = render([], false, true, { onOpenReminders: vi.fn(), remindersDue: 2 });
    expect(due).toContain('class="nav-dot" role="img" aria-label="有 2 个提醒到点了"');
  });

  it("names the main conversation and offers no way to start another one", () => {
    const main = { ...thread("main", null), titleRef: "title:recent", messageWatermark: 0 };
    const markup = render([main, thread("recent", null)], false, true, { mainThreadId: "main" });
    expect(markup.match(/href="\/threads\/main"/g)).toHaveLength(1);
    expect(markup).toMatch(/<nav[^>]*><a[^>]*href="\/threads\/main"[^>]*>.*?主对话<\/a>/);
    expect(markup.match(/title="最近的工作"/g)).toHaveLength(1);
    expect(markup).not.toContain("新建对话");
  });

  it("shows quiet placeholders only before the first collection arrives", () => {
    const markup = render([], true, false);
    expect(markup).toContain('class="thread-loading-skeleton"');
    expect(markup).not.toContain("正在加载…");
  });

  it("keeps a loaded empty collection quiet during background refresh", () => {
    const markup = render([], true, true);
    expect(markup).not.toContain("正在加载…");
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

  it("keeps search accessible and removes global filters from the empty sidebar", () => {
    const markup = render([]);
    expect(markup).toContain('<search class="thread-search-landmark"><form class="thread-search"');
    expect(markup).toContain('placeholder="搜索对话"');
    expect(markup).not.toContain("<dialog");
    expect(markup).not.toContain('aria-label="对话筛选"');
    expect(markup).not.toContain('value="archived"');
    expect(markup).not.toContain('value="all"');
    expect(markup).not.toContain('aria-label="置顶"');
  });
});
