import { createAgentId, createMemoryId, createOwnerId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_ATTRIBUTES,
  type MemoryCategory,
  OwnerProfileService,
  type ProductMemoryRecord,
} from "../src/index.js";

const OWNER_ID = createOwnerId("owner-profile");
const AGENT_ID = createAgentId("agent-profile");
const NOW = "2026-10-25T12:00:00.000Z";

function memory(
  id: string,
  category: MemoryCategory,
  importancePermille: number,
  overrides: Partial<ProductMemoryRecord> & { validTo?: string | null } = {},
): ProductMemoryRecord {
  const { validTo = null, ...rest } = overrides;
  return {
    id: createMemoryId(id),
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    revision: 1,
    status: "active",
    contentRef: `payload-${id}`,
    dataClassification: "private",
    sourceThreadId: null,
    sourceRefs: [`message-${id}`],
    inference: false,
    confidencePermille: 950,
    policyVersion: "memory-capture:v2",
    providerRecordId: null,
    lastUsedAt: null,
    updatedAt: NOW,
    attributes: { ...DEFAULT_MEMORY_ATTRIBUTES, category, importancePermille, validTo },
    ...rest,
  };
}

const TEXT: Record<string, string> = {
  "memory-language": "回答一律用简体中文",
  "memory-name": "主人叫 Andy",
  "memory-daughter": "主人的女儿叫小葵",
  "memory-coffee": "主人早上喝美式咖啡",
  "memory-snack": "主人偶尔吃薯片",
  "memory-trip": "主人这周在东京出差",
  "memory-allergy": "主人对青霉素过敏",
  "memory-public": "主人的博客地址是公开的",
};

function service(
  records: readonly ProductMemoryRecord[],
  characterBudget?: number,
  pins: readonly (readonly [string, boolean])[] = [],
) {
  const stored: { ref: string; text: string; dataClassification: string }[] = [];
  const profile = new OwnerProfileService({
    state: { listActive: async () => records },
    pins: {
      listProfilePins: async () =>
        pins.map(([memoryId, pinned]) => ({
          memoryId: createMemoryId(memoryId),
          pinned,
          updatedAt: NOW,
        })),
    },
    readText: async (record) => TEXT[record.id],
    storeText: async ({ ref, text, dataClassification }) => {
      stored.push({ ref, text, dataClassification });
    },
    digest: (text) => `digest-${text.length}`,
    ...(characterBudget === undefined ? {} : { characterBudget }),
  });
  return { profile, stored };
}

describe("owner profile composition", () => {
  const records = [
    memory("memory-language", "rule", 300),
    memory("memory-name", "identity", 900),
    memory("memory-daughter", "relationship", 850),
    memory("memory-coffee", "preference", 600),
    memory("memory-snack", "preference", 400),
    memory("memory-trip", "event", 900, { validTo: "2026-10-07" }),
    memory("memory-allergy", "health", 950, { dataClassification: "sensitive" }),
  ];

  it("puts rules first and groups important facts by section", async () => {
    const { profile, stored } = service(records);
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "sensitive",
      now: NOW,
    });
    expect(result.blocks.map(({ kind, ref }) => [kind, ref])).toEqual([
      ["owner-rules", "owner-rules:agent-profile"],
      ["owner-profile", "owner-profile:agent-profile"],
    ]);
    expect(stored.map(({ text }) => text)).toEqual([
      "主人对 Himawari 的要求（主人亲口说过的，回答时遵守）：\n- 回答一律用简体中文",
      [
        "主人档案（由已确认的长期记忆整理）：",
        "身份：",
        "- 主人叫 Andy",
        "偏好：",
        "- 主人早上喝美式咖啡",
        "人际关系：",
        "- 主人的女儿叫小葵",
      ].join("\n"),
    ]);
    expect(result.memoryIds).toEqual([
      "memory-language",
      "memory-name",
      "memory-coffee",
      "memory-daughter",
    ]);
    expect(result.blocks.every(({ dataClassification }) => dataClassification === "private")).toBe(
      true,
    );
  });

  it("leaves private facts out of a public request and marks public-only blocks public", async () => {
    const { profile } = service([
      ...records,
      memory("memory-public", "identity", 700, { dataClassification: "public" }),
    ]);
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "public",
      now: NOW,
    });
    expect(result.memoryIds).toEqual(["memory-public"]);
    expect(result.blocks.map(({ dataClassification }) => dataClassification)).toEqual(["public"]);
  });

  it("stays within the character budget, keeping the most important lines", async () => {
    const { profile } = service(records, 30);
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(result.memoryIds).toEqual(["memory-language", "memory-name"]);
  });

  it("[MEM-PIN] brings what the Owner switched on and drops what the Owner switched off", async () => {
    const { profile } = service(records, undefined, [
      ["memory-snack", true],
      ["memory-coffee", false],
      ["memory-allergy", true],
    ]);
    const request = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private" as const,
      now: NOW,
    };
    const result = await profile.compose(request);
    expect(result.memoryIds).toEqual([
      "memory-language",
      "memory-name",
      "memory-snack",
      "memory-daughter",
    ]);
    const outline = await profile.outline(request);
    expect(outline.sections.map(({ category }) => category)).toEqual([
      "identity",
      "preference",
      "relationship",
    ]);
    expect(outline.usage).toEqual({
      used: [
        TEXT["memory-language"],
        TEXT["memory-name"],
        TEXT["memory-daughter"],
        TEXT["memory-snack"],
      ]
        .map((text) => (text ?? "").length + 3)
        .reduce((sum, length) => sum + length, 0),
      limit: 2000,
      queued: [],
    });
  });

  it("[MEM-PIN] puts the Owner's picks ahead of automatic ones and reports what did not fit", async () => {
    const { profile } = service(
      [memory("memory-name", "identity", 900), memory("memory-snack", "preference", 400)],
      12,
      [["memory-snack", true]],
    );
    const outline = await profile.outline({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(outline.sections.flatMap(({ lines }) => lines.map(({ memoryId }) => memoryId))).toEqual([
      "memory-snack",
    ]);
    expect(outline.usage.queued).toEqual(["memory-name"]);
  });

  it("returns no blocks when nothing qualifies", async () => {
    const { profile, stored } = service([memory("memory-snack", "preference", 400)]);
    expect(
      await profile.compose({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        maxClassification: "private",
        now: NOW,
      }),
    ).toEqual({ blocks: [], memoryIds: [] });
    expect(stored).toEqual([]);
  });
});

describe("owner agenda", () => {
  it("lists the next seven days of reminders in the Owner's time zone", async () => {
    const records = [
      memory("memory-trip", "event", 500),
      memory("memory-allergy", "health", 950, { dataClassification: "sensitive" }),
    ];
    const stored: { ref: string; text: string }[] = [];
    const windows: { from: string; to: string }[] = [];
    const profile = new OwnerProfileService({
      state: { listActive: async () => records },
      readText: async (record) => TEXT[record.id],
      storeText: async ({ ref, text }) => {
        stored.push({ ref, text });
      },
      digest: (text) => `digest-${text.length}`,
      timeZone: "Asia/Shanghai",
      reminders: {
        listUpcoming: async ({ from, to }) => {
          windows.push({ from, to });
          return ["memory-trip", "memory-allergy", "memory-gone"].map((id) => ({
            id: `reminder:${id}`,
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            memoryId: createMemoryId(id),
            dueAt: "2026-10-27T07:00:00.000Z",
            remindAt: "2026-10-27T06:00:00.000Z",
            repeat: "none" as const,
            status: "scheduled" as const,
            dismissedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          }));
        },
      },
    });
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "sensitive",
      now: NOW,
    });
    expect(windows).toEqual([{ from: NOW, to: "2026-11-01T12:00:00.000Z" }]);
    const agenda = result.blocks.find(({ kind }) => kind === "owner-agenda");
    expect(agenda?.memoryIds).toEqual(["memory-trip"]);
    const text = stored.find(({ ref }) => ref === agenda?.payloadRef)?.text ?? "";
    expect(text).toContain("Asia/Shanghai");
    expect(text).toContain("15:00：主人这周在东京出差");
    expect(text).not.toContain("青霉素");
  });
});
