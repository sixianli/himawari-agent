import type {
  RuntimeRequest,
  ThreadRepositoryPort,
  ThreadUpdateInput,
} from "@himawari-agent/application";
import { TRUSTED_PROMPT_TEXTS } from "@himawari-agent/prompt-catalog";
import { redactForEgress } from "@himawari-agent/sensitive-capture";
import { createReferenceAdapterSet, createV02Fixture } from "@himawari-agent/testing";
import { expect, it, vi } from "vitest";
import { ProductionThreadTitles } from "../src/production-thread-titles.js";

const testTag = (kind: string, value: string) =>
  `${kind}${value}`
    .replace(/[^a-z]/gu, "")
    .padEnd(8, "x")
    .slice(0, 8);

async function fixture(empty = false) {
  const adapters = createReferenceAdapterSet();
  const { ownerId, agentId, threadId, authority } = createV02Fixture().scope;
  let thread: ThreadUpdateInput["thread"] = {
    id: threadId,
    ownerId,
    agentId,
    revision: 1,
    status: "active",
    titleRef: null,
    titleSource: null,
    titleRevision: 0,
    pinOrder: null,
    answerLocale: "zh-CN",
    messageWatermark: 0,
    lineage: null,
    createdAt: adapters.clock.now(),
    updatedAt: adapters.clock.now(),
  };
  const payload = await adapters.payloadProtector.protect({
    ownerId,
    agentId,
    ref: "first-message",
    dataClassification: "private",
    contentType: "text/plain",
    plaintext: new TextEncoder().encode("查询今天的日本头条"),
    createdAt: adapters.clock.now(),
  });
  await adapters.payload.put(payload);
  const update = vi.fn(async (input: ThreadUpdateInput) => {
    thread = input.thread;
    return { thread };
  });
  const threads = {
    read: vi.fn(async () => thread),
    listMessages: vi.fn(async () =>
      empty
        ? []
        : [
            {
              role: "owner",
              status: "committed",
              contentRef: payload.ref,
              dataClassification: "private",
            },
          ],
    ),
    findReceipt: vi.fn(async () => undefined),
    update,
  } as unknown as ThreadRepositoryPort;
  const generate = vi.fn(
    async (_request: RuntimeRequest, _prompt: string, _onAdmitted: () => void) => "日本今日头条",
  );
  const onFailure = vi.fn();
  const service = new ProductionThreadTitles({
    threads,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    clock: adapters.clock,
    authority: () => authority,
    assertActive: async () => {},
    externalTag: async () => testTag,
    generate,
    onFailure,
  });
  const request = {
    ownerId,
    agentId,
    threadId: thread.id,
    runId: "run:title",
    modelRef: "existing-model",
    dataClassification: "private",
  } as RuntimeRequest;
  return {
    service,
    request,
    generate,
    onFailure,
    update,
    adapters,
    thread: () => thread,
    setThread: (value: ThreadUpdateInput["thread"]) => {
      thread = value;
    },
  };
}

it("uses the model title, stores protected text and names the thread automatically", async () => {
  const f = await fixture();
  f.service.start(f.request);
  f.service.start(f.request);
  await f.service.stop();
  expect(f.onFailure).not.toHaveBeenCalled();
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.generate.mock.calls[0]?.[1]).toContain("查询今天的日本头条");
  expect(f.thread().titleSource).toBe("automatic");
  const payload = await f.adapters.payload.get(f.thread().titleRef as string);
  expect(payload).toBeDefined();
  if (!payload) throw new Error("Expected a stored title");
  const content = await f.adapters.payloadProtector.unprotect({ payload });
  expect(new TextDecoder().decode(content)).toBe("日本今日头条");
});

it("does not send a model request for an already named thread", async () => {
  const f = await fixture();
  f.setThread({ ...f.thread(), titleSource: "owner", titleRef: "owner-name" });
  f.service.start(f.request);
  await f.service.stop();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});

it("does not send a model request for a thread Himawari opened to think something over", async () => {
  const f = await fixture();
  f.setThread({ ...f.thread(), origin: "think" });
  f.service.start(f.request);
  await f.service.stop();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
  expect(f.thread().titleRef).toBeNull();
});

it("keeps an Owner rename made while the model request is in flight", async () => {
  const f = await fixture();
  f.generate.mockImplementation(async () => {
    f.setThread({ ...f.thread(), titleSource: "owner", titleRef: "my-title" });
    return "Generated title";
  });
  f.service.start(f.request);
  await f.service.stop();
  expect(f.thread().titleRef).toBe("my-title");
  expect(f.update).not.toHaveBeenCalled();
});

async function storedTitle(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const payload = await f.adapters.payload.get(f.thread().titleRef as string);
  if (!payload) throw new Error("Expected a stored title");
  const content = await f.adapters.payloadProtector.unprotect({ payload });
  return new TextDecoder().decode(content);
}

it.each(["", "line one\nline two", "x".repeat(121)])(
  "falls back to the opening words when the model title is malformed",
  async (title) => {
    const f = await fixture();
    f.generate.mockResolvedValue(title);
    f.service.start(f.request);
    await f.service.stop();
    expect(f.onFailure).toHaveBeenCalledTimes(1);
    expect(f.thread().titleSource).toBe("automatic");
    expect(await storedTitle(f)).toBe("查询今天的日本头条");
  },
);

it("falls back to the opening words when the model request fails, and still reports the failure", async () => {
  const f = await fixture();
  f.generate.mockRejectedValue(new Error("provider unavailable"));
  expect(() => f.service.start(f.request)).not.toThrow();
  await f.service.stop();
  expect(f.onFailure).toHaveBeenCalledTimes(1);
  expect(f.thread().titleSource).toBe("automatic");
  expect(await storedTitle(f)).toBe("查询今天的日本头条");
});

it("cuts a long first message to 24 characters with an ellipsis in the fallback title", async () => {
  const f = await fixture();
  const long = `${"一二三四五六七八九十".repeat(3)}\n后面还有很多内容`;
  const payload = await f.adapters.payloadProtector.protect({
    ownerId: f.request.ownerId,
    agentId: f.request.agentId,
    ref: "first-message-long",
    dataClassification: "private",
    contentType: "text/plain",
    plaintext: new TextEncoder().encode(long),
    createdAt: f.adapters.clock.now(),
  });
  await f.adapters.payload.put(payload);
  const listMessages = vi.fn(async () => [
    {
      role: "owner",
      status: "committed",
      contentRef: payload.ref,
      dataClassification: "private",
    },
  ]);
  (
    f.service as unknown as { options: { threads: { listMessages: unknown } } }
  ).options.threads.listMessages = listMessages;
  f.generate.mockRejectedValue(new Error("provider unavailable"));
  f.service.start(f.request);
  await f.service.stop();
  expect(await storedTitle(f)).toBe(`${"一二三四五六七八九十一二三四五六七八九十一二三四"}…`);
});

it("does not invent a title for an empty conversation", async () => {
  const f = await fixture(true);
  f.service.start(f.request);
  await f.service.stop();
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});

it("signals admission separately from the pending model response", async () => {
  const f = await fixture();
  let finish = (_title: string) => {};
  const response = new Promise<string>((resolve) => {
    finish = resolve;
  });
  f.generate.mockImplementation(async (_request, _prompt, onAdmitted) => {
    onAdmitted();
    return response;
  });
  await f.service.start(f.request);
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.update).not.toHaveBeenCalled();
  finish("日本今日头条");
  await f.service.stop();
  expect(f.thread().titleSource).toBe("automatic");
});

it.each([
  ["inside the message", "我的密码: hunter2abc 帮我记一下", "hunter2abc"],
  ["at the end of the message", "帮我记一下，我的密码是 hunter2abc", "hunter2abc"],
  ["with quote and backslash at the end", '帮我记一下，我的密码是 ab"c\\d', 'ab"c\\d'],
])(
  "[mask-not-block] restores a placeholder the model copied into the title (secret %s)",
  async (_name, message, secret) => {
    const f = await fixture();
    const payload = await f.adapters.payloadProtector.protect({
      ownerId: f.request.ownerId,
      agentId: f.request.agentId,
      ref: "first-message-secret",
      dataClassification: "private",
      contentType: "text/plain",
      plaintext: new TextEncoder().encode(message),
      createdAt: f.adapters.clock.now(),
    });
    await f.adapters.payload.put(payload);
    const options = (
      f.service as unknown as {
        options: { threads: { listMessages: unknown } };
      }
    ).options;
    options.threads.listMessages = vi.fn(async () => [
      {
        role: "owner",
        status: "committed",
        contentRef: payload.ref,
        dataClassification: "private",
      },
    ]);
    f.generate.mockImplementation(async (_request, prompt) => {
      const masked = redactForEgress(prompt, {
        known: new Map(),
        tag: testTag,
        trusted: TRUSTED_PROMPT_TEXTS,
      }).text;
      expect(masked).not.toContain("hunter2abc");
      const placeholder = masked.match(/\[密码#[^\]]+\]/u)?.[0];
      if (placeholder === undefined) throw new Error("Expected a masked password");
      return `${placeholder} 备忘`;
    });
    f.service.start(f.request);
    await f.service.stop();
    expect(f.onFailure).not.toHaveBeenCalled();
    expect(await storedTitle(f)).toBe(`${secret} 备忘`);
  },
);

it("[mask-not-block] stores a model title that carries a secret as written", async () => {
  const f = await fixture();
  f.generate.mockResolvedValue("密码 hunter2abc");
  f.service.start(f.request);
  await f.service.stop();
  expect(f.onFailure).not.toHaveBeenCalled();
  expect(await storedTitle(f)).toBe("密码 hunter2abc");
});
