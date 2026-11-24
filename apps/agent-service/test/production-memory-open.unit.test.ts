import type {
  DataClassification,
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
  readonly classifications?: Readonly<Record<string, DataClassification>>;
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
    readText: async (ref) => ({
      text: ref === "text-memory" ? options.text : options.versionText,
      dataClassification: options.classifications?.[ref] ?? "private",
    }),
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

async function everyPage(tool: ProductionMemoryOpen) {
  const pages: Record<string, unknown>[] = [];
  for (let page = 1; ; ) {
    const opened = await tool.open(call({ number: 1, page }));
    pages.push(opened.output);
    if (opened.output["nextPage"] === undefined) return pages;
    expect(opened.output["nextPage"]).toBe(page + 1);
    page = opened.output["nextPage"] as number;
  }
}

it("keeps every page within the page budget and returns the whole long memory across pages", async () => {
  const text = awkward.repeat(400);
  const pages = await everyPage(
    memoryTool({ text, versions: 6, versionText: awkward.repeat(200), pageCharacters: 2000 }),
  );
  expect(pages.length).toBeGreaterThan(10);
  for (const output of pages) expect(JSON.stringify(output).length).toBeLessThanOrEqual(2000);
  expect(pages.map((output) => output["text"] ?? "").join("")).toBe(text);
  const versions = pages.flatMap((output) => output["versions"] as { text: string }[]);
  expect(versions).toHaveLength(6);
  for (const version of versions) expect(version.text.endsWith("…")).toBe(true);
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

it("reaches every version past page 100, each exactly once, and rejects a page past the last one", async () => {
  const tool = memoryTool({
    text: "短",
    versions: 150,
    versionText: "长".repeat(900),
    pageCharacters: 2000,
  });
  const pages = await everyPage(tool);
  expect(pages.length).toBeGreaterThan(100);
  expect(pages[0]?.["text"]).toBe("短");
  expect(pages.slice(1).every((output) => !("text" in output))).toBe(true);
  for (const output of pages) expect(JSON.stringify(output).length).toBeLessThanOrEqual(2000);
  const times = pages.flatMap((output) =>
    (output["versions"] as { time: string }[]).map((version) => version.time),
  );
  expect(times).toHaveLength(150);
  expect(new Set(times).size).toBe(150);
  await expect(tool.open(call({ number: 1, page: pages.length + 1 }))).rejects.toBeInstanceOf(
    MemoryOpenInputError,
  );
  const single = memoryTool({ text: "短", versions: 1, versionText: "短", pageCharacters: 2000 });
  await expect(single.open(call({ number: 1, page: 2 }))).rejects.toBeInstanceOf(
    MemoryOpenInputError,
  );
  expect((await single.open(call({ number: 1, page: 1 }))).output["versions"]).toHaveLength(1);
}, 30_000);

it("withholds an earlier version or quote the model may not see and labels the result with the highest shown classification", async () => {
  const opened = await memoryTool({
    text: "现在的说法",
    versions: 3,
    versionText: "旧的说法",
    pageCharacters: 2000,
    classifications: { "version-0": "restricted", "quote-1": "restricted", "quote-2": "sensitive" },
  }).open(call({ number: 1 }));
  expect(opened.output["text"]).toBe("现在的说法");
  expect(opened.output["versions"]).toEqual([
    expect.objectContaining({ text: null, quote: "旧的说法" }),
    expect.objectContaining({ text: "旧的说法", quote: null }),
    expect.objectContaining({ text: "旧的说法", quote: "旧的说法" }),
  ]);
  expect(JSON.stringify(opened.output)).not.toContain("restricted");
  expect(opened.contentClassification).toBe("sensitive");
});

it("REVERSE: versions stored at the memory's own classification are all shown and keep its classification", async () => {
  const opened = await memoryTool({
    text: "现在的说法",
    versions: 2,
    versionText: "旧的说法",
    pageCharacters: 2000,
  }).open(call({ number: 1 }));
  expect(opened.output["versions"]).toEqual([
    expect.objectContaining({ text: "旧的说法", quote: "旧的说法" }),
    expect.objectContaining({ text: "旧的说法", quote: "旧的说法" }),
  ]);
  expect(opened.contentClassification).toBe("private");
});

it("labels each page only with what that page shows, so a sensitive version on a later page does not raise the first page", async () => {
  const tool = memoryTool({
    text: "长".repeat(1900),
    versions: 2,
    versionText: "旧的说法",
    pageCharacters: 2000,
    classifications: { "version-1": "sensitive" },
  });
  const first = await tool.open(call({ number: 1 }));
  expect(first.output["versions"]).toEqual([]);
  expect(first.output["nextPage"]).toBe(2);
  expect(first.contentClassification).toBe("private");
  const second = await tool.open(call({ number: 1, page: 2 }));
  expect(second.output["versions"]).toEqual([
    expect.objectContaining({ text: "旧的说法" }),
    expect.objectContaining({ text: "旧的说法" }),
  ]);
  expect(second.contentClassification).toBe("sensitive");
});
