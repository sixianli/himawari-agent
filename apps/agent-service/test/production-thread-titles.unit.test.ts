import type {
  RuntimeRequest,
  ThreadRepositoryPort,
  ThreadUpdateInput,
} from "@himawari-agent/application";
import { createReferenceAdapterSet, createV02Fixture } from "@himawari-agent/testing";
import { expect, it, vi } from "vitest";
import { ProductionThreadTitles } from "../src/production-thread-titles.js";

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

it.each(["", "line one\nline two", "x".repeat(121)])(
  "rejects malformed model titles without changing the conversation",
  async (title) => {
    const f = await fixture();
    f.generate.mockResolvedValue(title);
    f.service.start(f.request);
    await f.service.stop();
    expect(f.onFailure).toHaveBeenCalledTimes(1);
    expect(f.update).not.toHaveBeenCalled();
  },
);

it("contains provider failures instead of rejecting the answer stream", async () => {
  const f = await fixture();
  f.generate.mockRejectedValue(new Error("provider unavailable"));
  expect(() => f.service.start(f.request)).not.toThrow();
  await f.service.stop();
  expect(f.onFailure).toHaveBeenCalledTimes(1);
  expect(f.thread().titleRef).toBeNull();
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
