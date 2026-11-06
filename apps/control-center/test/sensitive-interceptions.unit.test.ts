import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, createIntlCache } from "react-intl";
import { expect, it } from "vitest";
import { SensitiveInterceptionsPage } from "../src/components/sensitive-interceptions.js";
import type { MessageId } from "../src/i18n/message-ids.js";
import { loadMessageCatalog } from "../src/i18n/runtime.js";
import type {
  SensitiveInterceptionItem,
  SensitiveInterceptionsModel,
} from "../src/sensitive-interceptions.js";

const item = (fields: Partial<SensitiveInterceptionItem>): SensitiveInterceptionItem => ({
  id: "a".repeat(64),
  threadId: "thread-known",
  source: "chat",
  purpose: "chat",
  part: "owner_message",
  category: "password",
  outcome: "masked",
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  seenCount: 1,
  ...fields,
});

async function render(items: readonly SensitiveInterceptionItem[]): Promise<string> {
  const intl = createIntl(
    { locale: "zh-CN", messages: await loadMessageCatalog("zh-CN"), onError: () => undefined },
    createIntlCache(),
  );
  const model: SensitiveInterceptionsModel = {
    counts: { masked: items.length, withheld: 0, notSaved: 0 },
    items,
    hasMore: false,
    failed: false,
    busy: false,
    loadMore: async () => undefined,
    clear: async () => true,
  };
  return renderToStaticMarkup(
    createElement(SensitiveInterceptionsPage, {
      model,
      message: (id: MessageId, values?: Record<string, string | number>) =>
        intl.formatMessage({ id }, values),
      threadTitle: (threadId: string) => (threadId === "thread-known" ? "家里网络设置" : undefined),
      onBack: () => undefined,
      onOpenThread: () => undefined,
    }),
  );
}

it("[SI-4] names a known conversation by its title and an unknown one without inventing a title", async () => {
  const html = await render([
    item({ id: "b".repeat(64), seenCount: 5 }),
    item({ id: "c".repeat(64), threadId: "thread-unknown", category: "bank-card" }),
    item({
      id: "d".repeat(64),
      threadId: null,
      source: "embedding",
      purpose: null,
      part: "embedding_input",
    }),
  ]);
  expect(html).toContain("对话「家里网络设置」 · 你的话");
  expect(html).toContain("第一次遮住，之后 4 次发送都已遮住");
  expect(html).toContain("一个对话 · 你的话");
  expect(html).toContain("后台 · 记忆检索");
  expect(html).not.toContain("后台 · 记忆检索 · 记忆检索");
});

it("[I-78] names which call masked a value inside a conversation, and does not call Himawari's own background request your message", async () => {
  const html = await render([
    item({ id: "e".repeat(64), source: "background", purpose: "thread-title" }),
    item({ id: "f".repeat(64), source: "background", purpose: "memory-capture" }),
    item({
      id: "1".repeat(64),
      source: "background",
      purpose: "action-review",
      part: "tool_result",
    }),
    item({ id: "2".repeat(64), threadId: null, source: "background", purpose: "mail-judgment" }),
  ]);
  expect(html).toContain("对话「家里网络设置」 · 起对话标题<");
  expect(html).toContain("对话「家里网络设置」 · 自动整理记忆<");
  expect(html).toContain("对话「家里网络设置」 · 动作复核 · 工具结果");
  expect(html).toContain("后台 · 邮件判断<");
  expect(html).not.toContain("起对话标题 · 你的话");
  expect(html).not.toContain("自动整理记忆 · 你的话");
});

it("[I-78] keeps saying where the value was when the call is not one the page knows", async () => {
  const html = await render([
    item({ id: "4".repeat(64), source: "background", purpose: "something-new" }),
  ]);
  expect(html).toContain("对话「家里网络设置」 · 其他 · 你的话");
});

it("[I-78] REVERSE: a chat record in a conversation still says it was your message, without repeating chat", async () => {
  const html = await render([item({ id: "3".repeat(64) })]);
  expect(html).toContain("对话「家里网络设置」 · 你的话");
  expect(html).not.toContain("聊天");
});
