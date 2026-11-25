import {
  type MemoryId,
  createAgentId,
  createMemoryId,
  createOwnerId,
} from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_ATTRIBUTES,
  importantSenderRule,
  type MemoryCategory,
  memoryDateNote,
  memoryDatesOf,
  OwnerProfileService,
  type ProductMemoryRecord,
  RuleJudge,
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
  "memory-milk": "主人偏好明治乳制品",
  "memory-sister": "主人的妹妹在大阪做护士",
};

function numbersOf(records: readonly ProductMemoryRecord[]) {
  return async ({ memoryIds }: { readonly memoryIds: readonly MemoryId[] }) =>
    memoryIds.flatMap((memoryId) => {
      const index = records.findIndex(({ id }) => id === memoryId);
      return index < 0 ? [] : [{ memoryId, number: index + 1 }];
    });
}

function service(
  records: readonly ProductMemoryRecord[],
  characterBudget?: number,
  pins: readonly (readonly [string, boolean])[] = [],
) {
  const stored: { ref: string; text: string; dataClassification: string }[] = [];
  const profile = new OwnerProfileService({
    state: { listActive: async () => records, numbers: numbersOf(records) },
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

describe("owner name from settings", () => {
  const named = (name: string | null, records: readonly ProductMemoryRecord[] = []) => {
    const stored: { text: string; dataClassification: string }[] = [];
    const profile = new OwnerProfileService({
      state: { listActive: async () => records, numbers: numbersOf(records) },
      readText: async (record) => TEXT[record.id],
      storeText: async ({ text, dataClassification }) => {
        stored.push({ text, dataClassification });
      },
      digest: (text) => `digest-${text.length}`,
      ownerName: async () => name,
    });
    return { profile, stored };
  };
  const request = (maxClassification: "public" | "private") => ({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    maxClassification,
    now: NOW,
  });

  it("[NAME-1] tells the model how to address the owner, first among the owner's rules, as private data", async () => {
    const { profile, stored } = named(" 小 安 ", [memory("memory-language", "rule", 300)]);
    const result = await profile.compose(request("private"));
    expect(stored[0]?.text).toBe(
      "主人对 Himawari 的要求（主人亲口说过或在设置里填写的，回答时遵守）：\n- 主人在设置里填写的称呼是「小 安」，称呼主人时用它；对话里出现过不同的称呼时，以最后出现的为准。\n- 回答一律用简体中文",
    );
    expect(result.blocks[0]).toMatchObject({ kind: "owner-rules", dataClassification: "private" });
    expect(result.memoryIds).toEqual(["memory-language"]);
  });

  it("[NAME-1] sends the name even when the owner has no rules yet", async () => {
    const { profile, stored } = named("Andy");
    const result = await profile.compose(request("private"));
    expect(result.blocks.map(({ kind }) => kind)).toEqual(["owner-rules"]);
    expect(stored[0]?.text).toContain("- 主人在设置里填写的称呼是「Andy」，称呼主人时用它");
    expect(result.memoryIds).toEqual([]);
  });

  it("[NAME-1] reverse: no name, a blank name or a public-only request adds nothing", async () => {
    for (const [name, level] of [
      [null, "private"],
      ["   ", "private"],
      ["Andy", "public"],
    ] as const) {
      const { profile, stored } = named(name);
      expect((await profile.compose(request(level))).blocks).toEqual([]);
      expect(stored).toEqual([]);
    }
  });
});

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

  it("[ADR-0286] puts rules first and lists every current memory by category with its number", async () => {
    const { profile, stored } = service(records);
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "sensitive",
      now: NOW,
    });
    expect(
      result.blocks.map(({ kind, ref, dataClassification }) => [kind, ref, dataClassification]),
    ).toEqual([
      ["owner-rules", "owner-rules:agent-profile", "private"],
      ["memory-snapshot", "memory-snapshot:agent-profile", "sensitive"],
    ]);
    expect(stored.map(({ text }) => text)).toEqual([
      "主人对 Himawari 的要求（主人亲口说过的，回答时遵守）：\n- 回答一律用简体中文",
      [
        "记忆清单（每条前面是编号；要看日期、原话和旧版本，用 memory_open 按编号打开）：",
        "身份",
        "2主人叫 Andy",
        "偏好",
        "4主人早上喝美式咖啡",
        "5主人偶尔吃薯片",
        "人际关系",
        "3主人的女儿叫小葵",
        "健康",
        "7主人对青霉素过敏",
        "你还能查到的：",
        "- 清单里每条只有一句话，日期、原话和旧版本没有放进来，用 memory_open 按编号打开。",
      ].join("\n"),
    ]);
    expect(result.memoryIds).toEqual([
      "memory-language",
      "memory-name",
      "memory-daughter",
      "memory-coffee",
      "memory-snack",
      "memory-allergy",
    ]);
  });

  it("[ADR-0286] puts a space after the number only when the memory starts with a digit, and says how far old conversations go", async () => {
    const stored: string[] = [];
    const records = [
      memory("memory-born", "identity", 500),
      memory("memory-name", "identity", 500),
      memory("memory-milk", "preference", 500, {
        attributes: { ...DEFAULT_MEMORY_ATTRIBUTES, category: "preference", tentative: true },
      }),
    ];
    const texts: Record<string, string> = {
      "memory-born": "1998年出生",
      "memory-name": "主人叫 Andy",
      "memory-milk": "主人偏好明治乳制品",
    };
    const spans: unknown[] = [];
    const profile = new OwnerProfileService({
      state: { listActive: async () => records, numbers: numbersOf(records) },
      conversations: {
        span: async (input) => {
          spans.push(input);
          return {
            firstDay: "2026-09-30",
            lastDay: "2026-10-25",
            days: 12,
            months: [
              { month: "2026-09", days: 1 },
              { month: "2026-10", days: 11 },
            ],
          };
        },
      },
      readText: async (record) => texts[record.id],
      storeText: async ({ text }) => {
        stored.push(text);
      },
      digest: (text) => `digest-${text.length}`,
    });
    await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(stored).toEqual([
      [
        "记忆清单（每条前面是编号；要看日期、原话和旧版本，用 memory_open 按编号打开）：",
        "身份",
        "1 1998年出生",
        "2主人叫 Andy",
        "待确认（主人还没确认过）",
        "3主人偏好明治乳制品",
        "你还能查到的：",
        "- 清单里每条只有一句话，日期、原话和旧版本没有放进来，用 memory_open 按编号打开。",
        "- 旧对话：从 2026-09-30 到 2026-10-25，共 12 天有对话（2026-09 1 天，2026-10 11 天），都能用 conversation_search 搜当时的原话。",
      ].join("\n"),
    ]);
    expect(spans).toEqual([
      { ownerId: OWNER_ID, agentId: AGENT_ID, allowedClassifications: ["public", "private"] },
    ]);
  });
  it("[MEMORY-DATE] leaves dates out of the rules and the memory list", async () => {
    const stored: string[] = [];
    const profile = new OwnerProfileService({
      state: {
        numbers: async ({ memoryIds }) =>
          memoryIds.map((memoryId, index) => ({ memoryId, number: index + 1 })),
        listActive: async () => [
          memory("memory-language", "rule", 900),
          memory("memory-name", "identity", 900, { recordedAt: "2026-10-25T16:30:00.000Z" }),
          memory("memory-trip", "identity", 900, {
            attributes: {
              ...DEFAULT_MEMORY_ATTRIBUTES,
              category: "identity",
              importancePermille: 900,
              validFrom: "2026-10-20",
            },
          }),
        ],
      },
      readText: async (record) => TEXT[record.id],
      storeText: async ({ text }) => {
        stored.push(text);
      },
      digest: (text) => `digest-${text.length}`,
      timeZone: "Asia/Tokyo",
    });
    await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(stored).toEqual([
      "主人对 Himawari 的要求（主人亲口说过的，回答时遵守）：\n- 回答一律用简体中文",
      [
        "记忆清单（每条前面是编号；要看日期、原话和旧版本，用 memory_open 按编号打开）：",
        "身份",
        "1主人叫 Andy",
        "2主人这周在东京出差",
        "你还能查到的：",
        "- 清单里每条只有一句话，日期、原话和旧版本没有放进来，用 memory_open 按编号打开。",
      ].join("\n"),
    ]);
    const recordedAt = "2026-11-08T15:30:00.000Z";
    expect(
      memoryDateNote({ recordedAt, validFrom: "2027-01-01", validTo: null }, "Asia/Tokyo"),
    ).toBe("（2027-01-01 起）");
    expect(
      memoryDateNote({ recordedAt, validFrom: "2026-11-09", validTo: null }, "Asia/Tokyo"),
    ).toBe("（2026-11-09 至今）");
    expect(memoryDateNote({ recordedAt, validFrom: "2026-11-09", validTo: null }, "UTC")).toBe(
      "（2026-11-09 起）",
    );
    const broken = memory("memory-broken", "identity", 900, { recordedAt: "", validTo: "下个月" });
    expect(memoryDatesOf(broken)).toEqual({ recordedAt: NOW, validFrom: null, validTo: null });
    expect(memoryDateNote(memoryDatesOf(broken), "Asia/Tokyo")).toBe("（记于 2026-10-25）");
  });
  it("[RULE-memory-visible] lets a sensitive relationship memory into the memory list and marks the block sensitive", async () => {
    const { profile, stored } = service([
      ...records,
      memory("memory-sister", "relationship", 900, { dataClassification: "sensitive" }),
    ]);
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "sensitive",
      now: NOW,
    });
    const block = result.blocks.find(({ kind }) => kind === "memory-snapshot");
    expect(block?.memoryIds).toContain("memory-sister");
    expect(block?.dataClassification).toBe("sensitive");
    expect(stored.map(({ text }) => text).join("\n")).toContain("8主人的妹妹在大阪做护士");
    const capped = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(capped.memoryIds).not.toContain("memory-sister");
  });
  it("[PA-2] lists a tentative memory only under the to-be-confirmed heading of the memory list", async () => {
    const tentative = memory("memory-milk", "preference", 999);
    const { profile, stored } = service([
      ...records,
      {
        ...tentative,
        inference: true,
        attributes: { ...(tentative.attributes ?? DEFAULT_MEMORY_ATTRIBUTES), tentative: true },
      },
    ]);
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "sensitive",
      now: NOW,
    });
    expect(result.memoryIds).toContain("memory-milk");
    expect(stored.map(({ text }) => text).join("\n")).toContain(
      "待确认（主人还没确认过）\n8主人偏好明治乳制品",
    );
    expect(
      stored
        .map(({ text }) => text)
        .join("\n")
        .match(/明治/gu),
    ).toHaveLength(1);
  });

  it("[PA-2b] keeps a rule memory out of the block when it is superseded, expired or no longer active", async () => {
    const base = memory("memory-sister", "rule", 950);
    const attributes = base.attributes ?? DEFAULT_MEMORY_ATTRIBUTES;
    const variants: ProductMemoryRecord[] = [
      { ...base, attributes: { ...attributes, supersededBy: createMemoryId("memory-name") } },
      { ...base, attributes: { ...attributes, validTo: "2026-10-01T00:00:00.000Z" } },
      { ...base, status: "trashed" },
      { ...base, status: "archived" },
      { ...base, status: "deleted_verified" },
    ];
    for (const variant of variants) {
      const { profile, stored } = service([variant]);
      const result = await profile.compose({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        maxClassification: "sensitive",
        now: NOW,
      });
      expect(result.memoryIds).not.toContain("memory-sister");
      expect(stored.map(({ text }) => text).join("\n")).not.toContain("大阪");
    }
    const { profile } = service([base]);
    const control = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "sensitive",
      now: NOW,
    });
    expect(control.memoryIds).toContain("memory-sister");
  });

  it("[PA-2c] puts a sensitive rule into the block only when the request ceiling allows it", async () => {
    const base = memory("memory-sister", "rule", 950);
    const ask = async (
      dataClassification: ProductMemoryRecord["dataClassification"],
      maxClassification: "private" | "sensitive",
    ) => {
      const { profile } = service([{ ...base, dataClassification }]);
      return profile.compose({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        maxClassification,
        now: NOW,
      });
    };
    expect((await ask("sensitive", "sensitive")).memoryIds).toContain("memory-sister");
    expect((await ask("sensitive", "private")).memoryIds).not.toContain("memory-sister");
    expect((await ask("restricted", "sensitive")).memoryIds).not.toContain("memory-sister");
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

  it("[ADR-0286] keeps the memory list within its budget, most important first, and says what was left out", async () => {
    const stored: string[] = [];
    const profile = new OwnerProfileService({
      state: { listActive: async () => records, numbers: numbersOf(records) },
      readText: async (record) => TEXT[record.id],
      storeText: async ({ text }) => {
        stored.push(text);
      },
      digest: (text) => `digest-${text.length}`,
      snapshotCharacterBudget: 20,
    });
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(result.memoryIds).toEqual(["memory-language", "memory-name", "memory-daughter"]);
    expect(stored.at(-1)).toContain("- 偏好另有 2 条因篇幅没有列出，可以用 recall 搜。");
    expect(stored.at(-1)).not.toContain("身份另有");
  });
  it("[P2-2] a profile block that is too long drops the rule memory text but never a hard rule", async () => {
    const { profile } = service(records, 5);
    const result = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(result.memoryIds).not.toContain("memory-language");
    const hardRule = importantSenderRule(["bank.example"], 3);
    const facts = {
      sender_address: "a@bank.example",
      sender_domain: "bank.example",
      text: "",
      content_folded: "",
      text_words: [],
      content_words: [],
      money_state: "unknown",
      amount_state: "missing",
      amount_minor: 0,
      amount_currency: "",
    };
    expect(
      new RuleJudge().decide("mail_item", facts, [{ ...hardRule, status: "needs_review" }]).hits,
    ).toEqual([{ id: hardRule.id, revision: 3, outcome: "raise_floor" }]);
  });

  it("[MEM-PIN] leaves what the Owner switched off out of the memory list and keeps the picks in the outline", async () => {
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
      "memory-daughter",
      "memory-snack",
    ]);
    const outline = await profile.outline(request);
    expect(outline.sections.map(({ category }) => category)).toEqual([
      "identity",
      "preference",
      "relationship",
    ]);
    expect(outline.rules.map(({ text }) => text)).toEqual([TEXT["memory-language"]]);
    expect(outline.sections[0]?.lines.map(({ text }) => text)).toEqual([
      `${TEXT["memory-name"]}（记于 2026-10-25）`,
    ]);
    expect(outline.usage).toEqual({
      used: [
        TEXT["memory-language"],
        `${TEXT["memory-name"]}（记于 2026-10-25）`,
        `${TEXT["memory-daughter"]}（记于 2026-10-25）`,
        `${TEXT["memory-snack"]}（记于 2026-10-25）`,
      ]
        .map((text) => (text ?? "").length + 3)
        .reduce((sum, length) => sum + length, 0),
      limit: 2000,
      pinned: `${TEXT["memory-snack"]}（记于 2026-10-25）`.length + 3,
      queued: [],
    });
  });

  it("[MEM-PIN] puts the Owner's picks ahead of automatic ones and reports what did not fit", async () => {
    const { profile } = service(
      [memory("memory-name", "identity", 900), memory("memory-snack", "preference", 400)],
      30,
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

  it("[P2-5] never drops a pinned memory to make room for rules and reports only unpinned ones", async () => {
    const { profile } = service(
      [
        memory("memory-language", "rule", 900),
        memory("memory-name", "identity", 900),
        memory("memory-snack", "preference", 400),
        memory("memory-allergy", "preference", 400),
      ],
      60,
      [
        ["memory-snack", true],
        ["memory-allergy", true],
      ],
    );
    const request = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private" as const,
      now: NOW,
    };
    const composed = await profile.compose(request);
    expect(composed.memoryIds).toEqual(expect.arrayContaining(["memory-snack", "memory-allergy"]));
    expect(composed.usage?.queued).toEqual(["memory-language", "memory-name"]);
    expect(composed.usage?.used).toBe(composed.usage?.pinned);
    expect(composed.usage?.used).toBeLessThanOrEqual(60);
  });

  it("[P2-5] keeps every pinned memory when they alone exceed the limit", async () => {
    const { profile } = service(
      [
        memory("memory-name", "identity", 900),
        memory("memory-snack", "preference", 400),
        memory("memory-allergy", "preference", 400),
      ],
      10,
      [
        ["memory-snack", true],
        ["memory-allergy", true],
      ],
    );
    const composed = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(composed.memoryIds).toEqual(["memory-name", "memory-snack", "memory-allergy"]);
    expect(composed.usage?.pinned).toBeGreaterThan(10);
    expect(composed.usage?.used).toBe(composed.usage?.pinned);
    expect(composed.usage?.queued).toEqual(["memory-name"]);
  });

  it("[P2-5] reverse: reports nothing dropped when everything fits", async () => {
    const { profile } = service(records, undefined, [["memory-snack", true]]);
    const composed = await profile.compose({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      maxClassification: "private",
      now: NOW,
    });
    expect(composed.usage?.queued).toEqual([]);
    expect(composed.usage?.used).toBeLessThanOrEqual(composed.usage?.limit ?? 0);
  });

  it("[ADR-0286] lists a low-importance memory too, and returns no blocks when there is nothing to list", async () => {
    const listed = service([memory("memory-snack", "preference", 400)]);
    expect(
      (
        await listed.profile.compose({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          maxClassification: "private",
          now: NOW,
        })
      ).memoryIds,
    ).toEqual(["memory-snack"]);
    const { profile, stored } = service([]);
    expect(
      await profile.compose({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        maxClassification: "private",
        now: NOW,
      }),
    ).toMatchObject({ blocks: [], memoryIds: [] });
    expect(stored).toEqual([]);
  });
});

describe("owner agenda", () => {
  it("[RULE-memory-visible] lists the next seven days of reminders in the Owner's time zone, sensitive ones included", async () => {
    const records = [
      memory("memory-trip", "event", 500),
      memory("memory-allergy", "health", 950, { dataClassification: "sensitive" }),
    ];
    const stored: { ref: string; text: string }[] = [];
    const windows: { from: string; to: string }[] = [];
    const profile = new OwnerProfileService({
      state: { listActive: async () => records, numbers: numbersOf(records) },
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
    expect(agenda?.memoryIds).toEqual(["memory-allergy", "memory-trip"]);
    expect(agenda?.dataClassification).toBe("sensitive");
    const text = stored.find(({ ref }) => ref === agenda?.payloadRef)?.text ?? "";
    expect(text).toContain("Asia/Shanghai");
    expect(text).toContain("15:00：主人这周在东京出差");
    expect(text).toContain("主人对青霉素过敏");
  });

  const dated = (
    id: string,
    validFrom: string | null,
    validTo: string | null = null,
    overrides: Partial<ProductMemoryRecord> = {},
    category: MemoryCategory = "event",
  ): ProductMemoryRecord => ({
    ...memory(id, category, 300),
    attributes: {
      ...DEFAULT_MEMORY_ATTRIBUTES,
      category,
      importancePermille: 300,
      validFrom,
      validTo,
    },
    ...overrides,
  });
  const AGENDA_TEXT: Record<string, string> = {
    "memory-laundry": "主人打算洗衣服晾衣服",
    "memory-visa": "主人的在留卡在办续签",
    "memory-move": "主人搬到杭州",
    "memory-past": "主人上周去了箱根",
    "memory-past-instant": "主人今天上午去了区役所",
    "memory-far": "主人下个月去北海道",
    "memory-dentist": "主人去看牙医",
    "memory-secret": "主人的体检复查",
  };
  const agendaService = (
    records: readonly ProductMemoryRecord[],
    options: {
      readonly reminders?: readonly { memoryId: string; dueAt: string; id?: string }[];
      readonly agendaCharacterBudget?: number;
      readonly pins?: readonly (readonly [string, boolean])[];
    } = {},
  ) => {
    const stored: { ref: string; text: string }[] = [];
    const profile = new OwnerProfileService({
      state: { listActive: async () => records, numbers: numbersOf(records) },
      readText: async (record) => AGENDA_TEXT[record.id] ?? TEXT[record.id],
      storeText: async ({ ref, text }) => {
        stored.push({ ref, text });
      },
      digest: (text) => `digest-${text.length}-${text}`,
      timeZone: "Asia/Tokyo",
      ...(options.pins
        ? {
            pins: {
              listProfilePins: async () =>
                (options.pins ?? []).map(([memoryId, pinned]) => ({
                  memoryId: createMemoryId(memoryId),
                  pinned,
                  updatedAt: NOW,
                })),
            },
          }
        : {}),
      ...(options.agendaCharacterBudget === undefined
        ? {}
        : { agendaCharacterBudget: options.agendaCharacterBudget }),
      ...(options.reminders
        ? {
            reminders: {
              listUpcoming: async () =>
                (options.reminders ?? []).map(({ memoryId, dueAt, id }) => ({
                  id: id ?? `reminder:${memoryId}`,
                  ownerId: OWNER_ID,
                  agentId: AGENT_ID,
                  memoryId: createMemoryId(memoryId),
                  dueAt,
                  remindAt: dueAt,
                  repeat: "none" as const,
                  status: "scheduled" as const,
                  dismissedAt: null,
                  createdAt: NOW,
                  updatedAt: NOW,
                })),
            },
          }
        : {}),
    });
    const agendaText = async (maxClassification: "private" | "sensitive" = "private") => {
      const result = await profile.compose({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        maxClassification,
        now: NOW,
      });
      const agenda = result.blocks.find(({ kind }) => kind === "owner-agenda");
      return {
        agenda,
        text: stored.find(({ ref }) => ref === agenda?.payloadRef)?.text ?? "",
      };
    };
    return { agendaText };
  };

  it("lists a memory dated inside the next seven days even when it has no reminder and no reminder store is wired", async () => {
    const { agendaText } = agendaService([dated("memory-laundry", "2026-10-26")]);
    const { agenda, text } = await agendaText();
    expect(agenda?.memoryIds).toEqual(["memory-laundry"]);
    expect(text).toBe(
      [
        "主人接下来 7 天的安排（时间为主人当地时间，Asia/Tokyo）：",
        "- 10/26周一：主人打算洗衣服晾衣服",
      ].join("\n"),
    );
  });

  it("says a dated memory has no reminder only when every reminder of the seven days was read", async () => {
    const records = [
      dated("memory-laundry", "2026-10-26"),
      dated("memory-visa", null, "2026-10-30"),
    ];
    const complete = await agendaService(records, { reminders: [] }).agendaText();
    expect(complete.text.split("\n").slice(1)).toEqual([
      "- 10/26周一（这 7 天里没有提醒）：主人打算洗衣服晾衣服",
      "- 10/30周五截止（这 7 天里没有提醒）：主人的在留卡在办续签",
    ]);
  });

  it("REVERSE: does not say there is no reminder when no reminder store is wired or the reminder list was cut off", async () => {
    const records = [
      dated("memory-laundry", "2026-10-26"),
      dated("memory-visa", null, "2026-10-30"),
    ];
    const plain = ["- 10/26周一：主人打算洗衣服晾衣服", "- 10/30周五截止：主人的在留卡在办续签"];
    const unwired = await agendaService(records).agendaText();
    expect(unwired.text.split("\n").slice(1)).toEqual(plain);
    const cut = await agendaService(records, {
      reminders: Array.from({ length: 100 }, (_, index) => ({
        memoryId: `memory-unknown-${index}`,
        dueAt: "2026-10-27T06:00:00.000Z",
      })),
    }).agendaText();
    expect(cut.text.split("\n").slice(1)).toEqual(plain);
    const belowLimit = await agendaService(records, {
      reminders: Array.from({ length: 99 }, (_, index) => ({
        memoryId: `memory-unknown-${index}`,
        dueAt: "2026-10-27T06:00:00.000Z",
      })),
    }).agendaText();
    expect(belowLimit.text).toContain("10/26周一（这 7 天里没有提醒）");
  });

  it("REVERSE: leaves out memories dated before today, after the seven days, undated, or above the classification ceiling", async () => {
    const { agendaText } = agendaService([
      dated("memory-past", "2026-10-24"),
      dated("memory-past-instant", "2026-10-25T11:59:59.000Z"),
      dated("memory-far", "2026-11-02"),
      dated("memory-coffee", null),
      dated("memory-secret", "2026-10-27", null, { dataClassification: "sensitive" }),
    ]);
    expect((await agendaText()).agenda).toBeUndefined();
    for (const [id, date] of [
      ["memory-past", "2026-10-24"],
      ["memory-past-instant", "2026-10-25T11:59:59.000Z"],
      ["memory-far", "2026-11-02"],
    ] as const)
      expect((await agendaService([dated(id, date)]).agendaText()).agenda, id).toBeUndefined();
    const pastInstant = agendaService([
      dated("memory-past-instant", "2026-10-25T11:59:59.000Z"),
      dated("memory-laundry", "2026-10-26"),
    ]);
    expect((await pastInstant.agendaText()).agenda?.memoryIds).toEqual(["memory-laundry"]);
  });

  it("REVERSE: leaves out a dated memory the Owner switched off from every conversation, and keeps one switched on", async () => {
    const records = [
      dated("memory-laundry", "2026-10-26", null, {}, "project"),
      dated("memory-move", "2026-10-28", null, {}, "project"),
    ];
    const { agenda } = await agendaService(records, {
      pins: [
        ["memory-laundry", false],
        ["memory-move", true],
      ],
    }).agendaText();
    expect(agenda?.memoryIds).toEqual(["memory-move"]);
  });

  it("lists a dated memory classified sensitive when the turn allows sensitive, and leaves it out when it does not", async () => {
    const { agendaText } = agendaService([
      dated("memory-secret", "2026-10-27", null, { dataClassification: "sensitive" }, "health"),
    ]);
    const allowed = await agendaText("sensitive");
    expect(allowed.agenda?.memoryIds).toEqual(["memory-secret"]);
    expect(allowed.agenda?.dataClassification).toBe("sensitive");
    expect((await agendaText("private")).agenda).toBeUndefined();
  });

  it("keeps the reminder of a memory the Owner switched off from every conversation", async () => {
    const { agenda, text } = await agendaService(
      [dated("memory-dentist", "2026-10-27", null, {}, "project")],
      {
        pins: [["memory-dentist", false]],
        reminders: [{ memoryId: "memory-dentist", dueAt: "2026-10-27T06:00:00.000Z" }],
      },
    ).agendaText();
    expect(agenda?.memoryIds).toEqual(["memory-dentist"]);
    expect(text.split("\n").slice(1)).toEqual(["- 10/27周二 15:00：主人去看牙医"]);
  });

  it("lists dated health and finance memories like events, inside the classification ceiling", async () => {
    const records = [
      dated("memory-dentist", "2026-10-27", null, {}, "health"),
      dated("memory-visa", null, "2026-10-30", {}, "finance"),
    ];
    expect((await agendaService(records).agendaText()).agenda?.memoryIds).toEqual([
      "memory-dentist",
      "memory-visa",
    ]);
  });

  it("orders reminders due at the same moment by reminder id in code-unit order, however the store returns them", async () => {
    const records = [dated("memory-move", null), dated("memory-dentist", null)];
    const reminders = [
      { memoryId: "memory-move", dueAt: "2026-10-27T06:00:00.000Z", id: "reminder:B" },
      { memoryId: "memory-dentist", dueAt: "2026-10-27T06:00:00.000Z", id: "reminder:a" },
    ];
    const first = await agendaService(records, { reminders }).agendaText();
    const reversed = await agendaService(records, {
      reminders: [...reminders].reverse(),
    }).agendaText();
    expect(first.agenda?.memoryIds).toEqual(["memory-move", "memory-dentist"]);
    expect(reversed.text).toBe(first.text);
  });

  it("counts the seven days in the Owner's local dates and includes both ends", async () => {
    const { agendaText } = agendaService([
      dated("memory-laundry", "2026-10-25"),
      dated("memory-move", "2026-11-01"),
      dated("memory-dentist", "2026-10-25T15:30:00.000Z"),
    ]);
    const { text } = await agendaText();
    expect(text.split("\n").slice(1)).toEqual([
      "- 10/25周日：主人打算洗衣服晾衣服",
      "- 10/26周一：主人去看牙医",
      "- 11/1周日：主人搬到杭州",
    ]);
  });

  it("marks a memory whose validity ends inside the seven days as ending that day", async () => {
    const { agendaText } = agendaService([dated("memory-visa", null, "2026-10-30")]);
    expect((await agendaText()).text).toContain("- 10/30周五截止：主人的在留卡在办续签");
  });

  it("shows a memory once when it already has a reminder, and orders reminders and dated memories by day", async () => {
    const records = [
      dated("memory-move", "2026-10-28"),
      dated("memory-laundry", "2026-10-26"),
      dated("memory-dentist", "2026-10-27"),
    ];
    const reminders = [{ memoryId: "memory-dentist", dueAt: "2026-10-27T06:00:00.000Z" }];
    const first = await agendaService(records, { reminders }).agendaText();
    expect(first.text.split("\n").slice(1)).toEqual([
      "- 10/26周一（这 7 天里没有提醒）：主人打算洗衣服晾衣服",
      "- 10/27周二 15:00：主人去看牙医",
      "- 10/28周三（这 7 天里没有提醒）：主人搬到杭州",
    ]);
    expect(first.agenda?.memoryIds).toEqual(["memory-laundry", "memory-dentist", "memory-move"]);
    const shuffled = await agendaService([...records].reverse(), { reminders }).agendaText();
    expect(shuffled.text).toBe(first.text);
  });

  it("says how many entries were left out when the agenda does not fit", async () => {
    const records = [
      dated("memory-laundry", "2026-10-26"),
      dated("memory-dentist", "2026-10-27"),
      dated("memory-move", "2026-10-28"),
    ];
    const { text } = await agendaService(records, { agendaCharacterBudget: 27 }).agendaText();
    expect(text.split("\n").slice(1)).toEqual([
      "- 10/26周一：主人打算洗衣服晾衣服",
      "（另有 2 项因篇幅没有列出。）",
    ]);
    const roomy = await agendaService(records).agendaText();
    expect(roomy.text).not.toContain("没有列出");
    const none = await agendaService(records, { agendaCharacterBudget: 5 }).agendaText();
    expect(none.text.split("\n").slice(1)).toEqual(["（另有 3 项因篇幅没有列出。）"]);
  });
});
