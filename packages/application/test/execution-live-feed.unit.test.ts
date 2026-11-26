import { describe, expect, it } from "vitest";
import { type ExecutionLiveEvent, ExecutionLiveFeed } from "../src/index.js";

function recorded() {
  const feed = new ExecutionLiveFeed();
  const events: ExecutionLiveEvent[] = [];
  feed.subscribe((event) => events.push(event));
  const texts = () =>
    events.flatMap((event) =>
      event.kind === "text" ? [{ offset: event.offset, text: event.text }] : [],
    );
  const shown = () =>
    texts().reduce((current, { offset, text }) => current.slice(0, offset) + text, "");
  return { feed, events, texts, shown };
}

describe("execution live feed", () => {
  it("pushes only the new characters of a growing answer", () => {
    const { feed, texts } = recorded();
    for (const text of ["向日", "向日葵的", "向日葵的一生"])
      feed.assistantText({ threadId: "thread-1", runId: "run-1", timestamp: 1, text });
    expect(texts()).toEqual([
      { offset: 0, text: "向日" },
      { offset: 2, text: "葵的" },
      { offset: 4, text: "一生" },
    ]);
  });

  it("remembers the moment of her first character for each run, and null for a run with none", () => {
    const times = ["2026-11-26T03:00:01.000Z", "2026-11-26T03:00:02.500Z"];
    const feed = new ExecutionLiveFeed(() => times.shift() ?? "unused");
    feed.assistantText({ threadId: "thread-1", runId: "run-1", timestamp: 1, text: "" });
    expect(feed.firstEmittedAt("run-1")).toBeNull();
    feed.assistantText({ threadId: "thread-1", runId: "run-1", timestamp: 1, text: "好的" });
    feed.assistantText({ threadId: "thread-1", runId: "run-1", timestamp: 1, text: "好的，来了" });
    expect(feed.firstEmittedAt("run-1")).toBe("2026-11-26T03:00:01.000Z");
    feed.finished("run-1");
    expect(feed.firstEmittedAt("run-1")).toBe("2026-11-26T03:00:01.000Z");
    expect(feed.firstEmittedAt("run-other")).toBeNull();
  });

  it("stamps each piece with the moment she wrote it, and skips an empty opening", () => {
    const times = ["2026-11-26T03:00:01.000Z", "2026-11-26T03:00:02.500Z"];
    const feed = new ExecutionLiveFeed(() => times.shift() ?? "unused");
    const stamps: string[] = [];
    feed.subscribe((event) => {
      if (event.kind === "text") stamps.push(`${event.text}@${event.emittedAt}`);
    });
    feed.assistantText({ threadId: "thread-1", runId: "run-1", timestamp: 1, text: "" });
    feed.assistantText({ threadId: "thread-1", runId: "run-1", timestamp: 1, text: "好的" });
    feed.assistantText({
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 1,
      text: "好的，查到了",
    });
    expect(stamps).toEqual(["好的@2026-11-26T03:00:01.000Z", "，查到了@2026-11-26T03:00:02.500Z"]);
  });

  it("[mask-not-block] shows a secret that arrives split across two pieces as written", () => {
    const { feed, shown, texts } = recorded();
    const secret = `sk-${"A".repeat(24)}`;
    const answer = `钥匙是 ${secret} 用完请删`;
    for (const end of [6, 9, 14, 20, answer.length])
      feed.assistantText({
        threadId: "thread-1",
        runId: "run-1",
        timestamp: 1,
        text: answer.slice(0, end),
      });
    expect(
      texts()
        .map(({ text }) => text)
        .join(""),
    ).toBe(answer);
    expect(shown()).toBe(answer);
  });

  it("starts a new answer from the beginning and hands late watchers the current text", () => {
    const { feed, texts } = recorded();
    feed.assistantText({ threadId: "thread-1", runId: "run-1", timestamp: 1, text: "先查一下" });
    feed.assistantText({ threadId: "thread-1", runId: "run-1", timestamp: 2, text: "查到了" });
    expect(texts().at(-1)).toEqual({ offset: 0, text: "查到了" });
    expect(feed.current("thread-1")).toEqual([
      expect.objectContaining({ runId: "run-1", text: "查到了" }),
    ]);
    expect(feed.current("thread-2")).toEqual([]);
    feed.finished("run-1");
    expect(feed.current("thread-1")).toEqual([]);
  });

  it("ignores runs outside a thread", () => {
    const { feed, events } = recorded();
    feed.assistantText({ threadId: null, runId: "run-1", timestamp: 1, text: "后台" });
    expect(events).toEqual([]);
  });
});
