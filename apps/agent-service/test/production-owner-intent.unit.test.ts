import type { RunExecutionSource } from "@himawari-agent/application";
import { expect, it } from "vitest";
import { collectOwnerWords } from "../src/production-owner-intent.js";

interface Message {
  readonly id: string;
  readonly sequence: number;
  readonly role: "owner" | "agent";
  readonly status: "committed" | "pending";
  readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
  readonly contentRef: string;
  readonly text: string;
  readonly internal?: true;
}

const message = (sequence: number, text: string, overrides: Partial<Message> = {}): Message => ({
  id: `m${sequence}`,
  sequence,
  role: "owner",
  status: "committed",
  dataClassification: "private",
  contentRef: `ref:${sequence}`,
  text,
  ...overrides,
});

function dependencies(messages: readonly Message[]) {
  return {
    ownerId: "owner:a" as never,
    agentId: "agent:a" as never,
    threads: {
      readCommittedMessagesByIds: async ({ messageIds }: { messageIds: readonly string[] }) =>
        messages.filter(({ id }) => messageIds.includes(id)) as never,
      listMessages: async (_o: unknown, _a: unknown, _t: unknown, after: number, limit: number) =>
        messages
          .filter(({ sequence, internal }) => sequence > after && internal !== true)
          .slice(0, limit) as never,
    },
    readText: async (ref: string) => messages.find(({ contentRef }) => contentRef === ref)?.text,
  };
}

const source = (sequence: number): RunExecutionSource =>
  ({
    sourceType: "user_message",
    threadId: "thread:a",
    sourceId: `m${sequence}`,
    payloadRef: `ref:${sequence}`,
  }) as never;

it("[ADR-0257][I-129] sends only the owner's own words, health and card numbers included: no agent text, no password or key, nothing after the triggering message", async () => {
  const messages = [
    message(1, "帮我看看这个网页"),
    message(2, "好的，我读了这个网页", { role: "agent" }),
    message(3, "我的健康情况不好", { dataClassification: "sensitive" }),
    message(4, "我的银行卡是 4111 1111 1111 1111"),
    message(5, "我的密码是 Tr0ub4dor&3xyz"),
    message(6, "明天九点提醒我给房东回电话"),
    message(7, "之后才说的话"),
  ];
  expect(await collectOwnerWords(dependencies(messages), source(6))).toEqual([
    "帮我看看这个网页",
    "我的健康情况不好",
    "我的银行卡是 4111 1111 1111 1111",
    "明天九点提醒我给房东回电话",
  ]);
});

it("[ADR-0257] returns nothing, so the owner is asked, when the run is not a user message, has no thread, or the message is not the owner's own", async () => {
  const messages = [message(1, "明天九点提醒我", { role: "agent" }), message(2, "帮我设提醒")];
  const deps = dependencies(messages);
  expect(
    await collectOwnerWords(deps, {
      ...source(2),
      sourceType: "schedule",
    } as never),
  ).toEqual([]);
  expect(await collectOwnerWords(deps, { ...source(2), threadId: null } as never)).toEqual([]);
  expect(await collectOwnerWords(deps, source(1))).toEqual([]);
  expect(
    await collectOwnerWords(deps, {
      ...source(2),
      payloadRef: "ref:other",
    } as never),
  ).toEqual([]);
});

it("[ADR-0257] keeps at most the six most recent owner messages and cuts each at 2000 characters", async () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index + 1, `第 ${index + 1} 句，${"字".repeat(2500)}`),
  );
  const words = await collectOwnerWords(dependencies(messages), source(10));
  expect(words.length).toBeLessThanOrEqual(6);
  expect(words.at(-1)).toContain("第 10 句");
  expect(words.every((text) => [...text].length <= 2000)).toBe(true);
});

it("[ADR-0257] keeps the total owner words within the byte budget, dropping the oldest first", async () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index + 1, `第 ${index + 1} 句，${"字".repeat(2500)}`),
  );
  const words = await collectOwnerWords(dependencies(messages), source(10));
  const total = words.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  expect(total).toBeLessThanOrEqual(20_000);
  expect(words.at(-1)).toContain("第 10 句");
  expect(words.join("")).not.toContain("第 5 句");
});

it("[ADR-0257] counts the JSON-escaped size of the owner words against the byte budget", async () => {
  const messages = Array.from({ length: 6 }, (_, index) =>
    message(index + 1, `第 ${index + 1} 句${"\u0001a".repeat(1000)}`),
  );
  const words = await collectOwnerWords(dependencies(messages), source(6));
  const wire = words.reduce(
    (sum, text) => sum + Buffer.byteLength(JSON.stringify(text), "utf8"),
    0,
  );
  expect(wire).toBeLessThanOrEqual(20_000 + 2 * words.length);
  expect(words.at(-1)).toContain("第 6 句");
});

it("[PR631-R2-1] returns nothing, so the owner is asked, when the triggering message is hidden from the owner, even with earlier owner words in the window", async () => {
  const messages = [
    message(1, "明天九点提醒我给房东回电话"),
    message(2, "收件箱来了一封邮件", { internal: true }),
  ];
  expect(await collectOwnerWords(dependencies(messages), source(1))).toEqual([
    "明天九点提醒我给房东回电话",
  ]);
  expect(await collectOwnerWords(dependencies(messages), source(2))).toEqual([]);
});

it("counts the owner messages folded into the Run as the owner's own words, and nothing after them", async () => {
  const messages = [
    message(1, "帮我看看这个网页"),
    message(2, "查东京天气"),
    message(3, "再帮我设个明早 7 点的闹钟"),
    message(4, "之后才说的话"),
  ];
  const folded = [
    { messageId: "m2", runId: "run:2" },
    { messageId: "m3", runId: "run:3" },
  ];
  const deps = {
    ...dependencies(messages),
    threads: {
      ...dependencies(messages).threads,
      readFoldedOwnerMessages: async () => folded as never,
    },
  };
  expect(await collectOwnerWords(deps, source(1))).toEqual([
    "帮我看看这个网页",
    "查东京天气",
    "再帮我设个明早 7 点的闹钟",
  ]);
  expect(await collectOwnerWords(dependencies(messages), source(1))).toEqual(["帮我看看这个网页"]);
});
