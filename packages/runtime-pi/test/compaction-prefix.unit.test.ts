import type { Context, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  approximateTokens,
  sharedSummaryContext,
  sharedSummaryOptions,
} from "../src/compaction-prefix.js";

const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

const last = (messages: Message[], systemPrompt = "系统提示"): Context => ({
  systemPrompt,
  tools: [],
  messages,
});

describe("[COMPACT-2] sharing the conversation's head with the summary request", () => {
  const prefix = [user("第一问")];

  it("appends the instruction after the same history, system prompt and tools", () => {
    const context = last([...prefix, user("第二问")]);
    const shared = sharedSummaryContext(context, prefix, 100_000, 4_000);
    expect(shared?.systemPrompt).toBe(context.systemPrompt);
    expect(shared?.tools).toBe(context.tools);
    expect(shared?.messages.slice(0, 1)).toEqual(prefix);
    expect(shared?.messages).toHaveLength(2);
    expect(shared?.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("REVERSE: gives up when the history differs, is shorter, or there is no earlier request", () => {
    expect(sharedSummaryContext(last([user("别的")]), prefix, 100_000, 4_000)).toBeUndefined();
    expect(sharedSummaryContext(last([]), prefix, 100_000, 4_000)).toBeUndefined();
    expect(sharedSummaryContext(undefined, prefix, 100_000, 4_000)).toBeUndefined();
    expect(sharedSummaryContext(last(prefix), undefined, 100_000, 4_000)).toBeUndefined();
  });

  it("REVERSE: gives up when the system prompt, tools and history do not fit the window", () => {
    const big = [user("汉".repeat(30_000))];
    expect(sharedSummaryContext(last(big), big, 100_000, 4_000)).toBeDefined();
    expect(sharedSummaryContext(last(big), big, 30_000, 4_000)).toBeUndefined();
    const heavyPrompt = last(prefix, "字".repeat(60_000));
    expect(sharedSummaryContext(heavyPrompt, prefix, 50_000, 4_000)).toBeUndefined();
  });

  it("counts Chinese text as more tokens than ASCII of the same length", () => {
    expect(approximateTokens("汉".repeat(1_000))).toBeGreaterThan(
      approximateTokens("a".repeat(1_000)) * 2,
    );
  });

  it("takes the session id and cache setting from the last normal request, not from Pi's summary call", () => {
    expect(
      sharedSummaryOptions(
        { sessionId: "pi-fresh", cacheRetention: "none", maxTokens: 9 },
        { sessionId: "himawari-1", cacheRetention: "long" },
      ),
    ).toEqual({ maxTokens: 9, sessionId: "himawari-1", cacheRetention: "long" });
    expect(
      sharedSummaryOptions({ sessionId: "pi-fresh", cacheRetention: "none" }, undefined),
    ).toEqual({});
  });
});
