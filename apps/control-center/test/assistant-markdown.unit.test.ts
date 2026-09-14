import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown } from "../src/components/assistant-markdown.js";

const render = (text: string) => renderToStaticMarkup(createElement(AssistantMarkdown, { text }));
describe("disclosed assistant Markdown", () => {
  it("renders readable code, lists, tables and explicit source links", () => {
    const result = render(
      '**内容**\n\n```sh\nprintf "晨光计划"\n```\n\n- 一项\n\n| 天气 | 日期 |\n| --- | --- |\n| 晴 | 今日 |\n\n[来源](https://example.com/weather)',
    );
    expect(result).toContain("<strong>内容</strong>");
    expect(result).toContain('<pre><code class="language-sh">');
    expect(result).toContain("<li>一项</li>");
    expect(result).toContain("<table>");
    expect(result).toContain('href="https://example.com/weather"');
    expect(result).toContain('rel="noopener noreferrer"');
    expect(result).toContain('referrerPolicy="no-referrer"');
  });
  it("keeps Chinese prose outside automatically detected source links", () => {
    const result = render(
      "来源（https://weathernews.jp/news/202609/120091/），属前一天预报。数据：https://example.com/?year=2026&month=9）。",
    );
    expect(result).toContain('href="https://weathernews.jp/news/202609/120091/"');
    expect(result).toContain('href="https://example.com/?year=2026&amp;month=9"');
    expect(result).toContain("</a>），属前一天预报。");
    expect(result).toContain("</a>）。");
  });
  it("preserves explicit Unicode destinations and bare Unicode paths", () => {
    const result = render("[资料](https://example.com/（天气）) https://example.com/天气");
    expect(result).toContain('href="https://example.com/%EF%BC%88%E5%A4%A9%E6%B0%94%EF%BC%89"');
    expect(result).toContain('href="https://example.com/%E5%A4%A9%E6%B0%94"');
  });
  it("never embeds HTML or remote images from model text", () => {
    const result = render(
      '<script>alert(1)</script>\n\n<img src="https://example.com/tracker">\n\n![示意图](https://example.com/image.png)',
    );
    expect(result).not.toMatch(/<(script|img|iframe)|src=/);
    expect(result).toContain("示意图");
  });
  it.each([
    "javascript:alert%281%29",
    "data:text/html,test",
    "/approvals",
    "//example.com",
    "https://user:password@example.com",
  ])("does not activate unsafe or implicit destination %s", (url) => {
    expect(render(`[来源](${url})`)).not.toContain("href=");
  });
  it("keeps partial streamed code readable and accepts the later completed block", () => {
    expect(render('```sh\necho "早上好')).toContain("echo &quot;早上好");
    expect(render('```sh\necho "早上好"\n```')).toContain("</code></pre>");
  });
});
