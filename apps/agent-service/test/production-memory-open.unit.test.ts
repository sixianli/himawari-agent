import type {
  MemoryHistoryEvent,
  ProductMemoryRecord,
  RuntimeRequest,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import { expect, it } from "vitest";
import { MemoryOpenInputError, ProductionMemoryOpen } from "../src/production-memory-open.js";

const ownerId = "owner-open" as RuntimeRequest["ownerId"];
const agentId = "agent-open" as RuntimeRequest["agentId"];
const awkward = `他说："别再提这件事了"\n\\路径\\在这里\t😀🎉${"长".repeat(30)}`;

function memoryTool(options: {
  readonly text: string;
  readonly versions: number;
  readonly versionText: string;
  readonly pageCharacters: number;
}) {
  const memory = {
    id: "memory-open",
    ownerId,
    agentId,
    status: "active",
    dataClassification: "private",
    contentRef: "text-memory",
    sourceRefs: ["message-open"],
    attributes: { category: "fact" },
    updatedAt: "2026-11-01T00:00:00.000Z",
    recordedAt: "2026-11-01T00:00:00.000Z",
  } as unknown as ProductMemoryRecord;
  const events = Array.from(
    { length: options.versions },
    (_, index) =>
      ({
        id: index + 1,
        memoryId: memory.id,
        kind: index === 0 ? "created" : "edited",
        contentRef: `version-${index}`,
        stance: null,
        quoteRef: `quote-${index}`,
        sourceThreadId: "thread-open",
        sourceDeleted: false,
        occurredAt: `2026-11-01T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`,
      }) as unknown as MemoryHistoryEvent,
  );
  return new ProductionMemoryOpen({
    ownerId,
    agentId,
    state: {
      byNumber: async ({ number }) => (number === 1 ? memory.id : undefined),
      read: async (id) => (id === memory.id ? memory : undefined),
      numbers: async () => [],
      listHistory: async () => events,
    },
    readText: async (ref) => (ref === "text-memory" ? options.text : options.versionText),
    pageCharacters: options.pageCharacters,
    now: () => "2026-11-25T00:00:00.000Z",
  });
}

function call(args: Record<string, unknown>): RuntimeToolInvocation {
  return {
    runId: "run-open",
    toolCallId: "call-open",
    capabilityRef: "memory.open",
    capabilityHandleRef: null,
    dataClassification: "public",
    arguments: args,
  } as unknown as RuntimeToolInvocation;
}

it("keeps every page within the page budget when the memory and its versions are long and full of escapes", async () => {
  const tool = memoryTool({
    text: awkward.repeat(400),
    versions: 6,
    versionText: awkward.repeat(200),
    pageCharacters: 2000,
  });
  let page = 1;
  const seen: string[] = [];
  for (;;) {
    const opened = await tool.open(call({ number: 1, page }));
    expect(JSON.stringify(opened.output).length).toBeLessThanOrEqual(2000);
    expect(String(opened.output["text"]).endsWith("…")).toBe(true);
    for (const version of opened.output["versions"] as { text: string; time: string }[]) {
      expect(version.text.endsWith("…")).toBe(true);
      seen.push(version.time);
    }
    if (opened.output["nextPage"] === undefined) break;
    page = opened.output["nextPage"] as number;
  }
  expect(seen).toHaveLength(6);
});

it("REVERSE: a short memory is returned whole, without clipping", async () => {
  const opened = await memoryTool({
    text: awkward,
    versions: 1,
    versionText: awkward,
    pageCharacters: 2000,
  }).open(call({ number: 1 }));
  expect(opened.output["text"]).toBe(awkward);
  expect(opened.output["versions"]).toEqual([
    expect.objectContaining({ text: awkward, quote: awkward }),
  ]);
  expect(opened.output).not.toHaveProperty("nextPage");
});

it("rejects a page past the last one and never points nextPage past the page limit", async () => {
  const tool = memoryTool({
    text: "短",
    versions: 150,
    versionText: "长".repeat(2000),
    pageCharacters: 2000,
  });
  const last = await tool.open(call({ number: 1, page: 100 }));
  expect(last.output).not.toHaveProperty("nextPage");
  expect((await tool.open(call({ number: 1, page: 99 }))).output).toMatchObject({
    nextPage: 100,
  });
  const single = memoryTool({ text: "短", versions: 1, versionText: "短", pageCharacters: 2000 });
  await expect(single.open(call({ number: 1, page: 2 }))).rejects.toBeInstanceOf(
    MemoryOpenInputError,
  );
  expect((await single.open(call({ number: 1, page: 1 }))).output["versions"]).toHaveLength(1);
});
