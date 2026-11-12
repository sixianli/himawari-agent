import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import type { DecisionLedgerEntry } from "../src/ports/decision-ledger.js";
import {
  type DailyReviewPoolItem,
  parseReviewKey,
  readDailyReview,
  readDailyReviewSubjects,
  reviewCapacity,
  reviewKey,
  reviewMemoryVisible,
  selectDailyReview,
} from "../src/services/daily-review.js";
import type { ProactiveOverview } from "../src/services/proactive-overview.js";

const DAY = "2026-11-03T15:00:00.000Z";
const NOW = "2026-11-04T01:00:00.000Z";
const scope = {
  ownerId: createOwnerId("owner"),
  agentId: createAgentId("agent"),
};

const item = (
  key: string,
  group: DailyReviewPoolItem["group"],
  done = false,
  doneAt: string | null = null,
): DailyReviewPoolItem => ({ key, group, done, doneAt });

describe("[P0-11] silent share of the proactive sample", () => {
  const pool = [
    ...Array.from({ length: 20 }, (_, index) => item(`p${index}`, "proactive")),
    ...Array.from({ length: 20 }, (_, index) => item(`s${index}`, "proactive_silent")),
  ];
  const shownSilent = (silentShare: number | undefined, capacity: number) =>
    selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity,
      ...(silentShare === undefined ? {} : { silentShare }),
    }).shown.filter((key) => key.startsWith("s")).length;

  it("takes the configured share of the sample from silent decisions", () => {
    expect(shownSilent(500, 10)).toBe(5);
    expect(shownSilent(250, 8)).toBe(2);
    expect(shownSilent(1000, 10)).toBe(10);
  });

  it("[negative] takes none at share 0 while acted-on decisions remain", () => {
    expect(shownSilent(0, 10)).toBe(0);
  });

  it("hands slots to the other queue when one runs out", () => {
    const small = [
      item("s0", "proactive_silent"),
      ...Array.from({ length: 6 }, (_, index) => item(`p${index}`, "proactive")),
    ];
    const selection = selectDailyReview({
      pool: small,
      dayStart: DAY,
      seed: "s",
      capacity: 5,
      silentShare: 800,
    });
    expect(selection.shown).toHaveLength(5);
    expect(selection.shown).toContain("s0");
  });

  it("still counts silent decisions that did not fit as not sampled", () => {
    const selection = selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity: 10,
      silentShare: 500,
    });
    expect(selection.notSampled).toBe(30);
  });
});

describe("[P0-6] daily review sampling", () => {
  it("turns the budget into a whole number of items, at least one", () => {
    expect(reviewCapacity(120, 5)).toBe(24);
    expect(reviewCapacity(120, 7)).toBe(17);
    expect(reviewCapacity(3, 5)).toBe(1);
  });

  it("shows every default item when they fit and counts none as left out", () => {
    const pool = [item("a", "memory_skipped"), item("b", "proactive"), item("c", "other")];
    const selection = selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity: 24,
    });
    expect([...selection.shown].sort()).toEqual(["a", "b"]);
    expect(selection).toMatchObject({
      sampled: 2,
      notSampled: 0,
      foldedTotal: 1,
    });
    expect(selection.foldedShown).toEqual(["c"]);
  });

  it("fills the budget with skipped memories first, then samples the rest, and reports what was left out", () => {
    const pool = [
      ...Array.from({ length: 10 }, (_, index) => item(`m${index}`, "memory_skipped")),
      ...Array.from({ length: 30 }, (_, index) => item(`p${index}`, "proactive")),
    ];
    const selection = selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity: 24,
    });
    expect(selection.sampled).toBe(24);
    expect(selection.shown.filter((key) => key.startsWith("m"))).toHaveLength(10);
    expect(selection.notSampled).toBe(16);
    const tooMany = selectDailyReview({
      pool: Array.from({ length: 40 }, (_, index) => item(`m${index}`, "memory_skipped")),
      dayStart: DAY,
      seed: "s",
      capacity: 24,
    });
    expect(tooMany.shown.every((key) => key.startsWith("m"))).toBe(true);
    expect(tooMany).toMatchObject({ sampled: 24, notSampled: 16 });
  });

  it("[all decisions] shares the budget between the four default groups and hands unused slots to the others", () => {
    const many = (prefix: string, group: DailyReviewPoolItem["group"], count: number) =>
      Array.from({ length: count }, (_, index) => item(`${prefix}${index}`, group));
    const pool = [
      ...many("m", "memory_skipped", 40),
      ...many("p", "proactive", 40),
      ...many("k", "memory_kept", 40),
      ...many("c", "consolidation", 40),
    ];
    const selection = selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity: 24,
    });
    const share = (prefix: string) =>
      selection.shown.filter((key) => key.startsWith(prefix)).length;
    expect([share("m"), share("p"), share("k"), share("c")]).toEqual([6, 6, 6, 6]);
    expect(selection).toMatchObject({ sampled: 24, notSampled: 136 });
    const lopsided = selectDailyReview({
      pool: [...many("m", "memory_skipped", 2), ...many("k", "memory_kept", 40)],
      dayStart: DAY,
      seed: "s",
      capacity: 24,
    });
    expect(lopsided.shown.filter((key) => key.startsWith("m"))).toHaveLength(2);
    expect(lopsided.shown.filter((key) => key.startsWith("k"))).toHaveLength(22);
  });

  it("[all decisions] fills a budget that is not a multiple of four without repeats or items outside the pool", () => {
    const groups = ["memory_skipped", "proactive", "memory_kept", "consolidation"] as const;
    const pool = groups.flatMap((group) =>
      Array.from({ length: 10 }, (_, index) => item(`${group}:${index}`, group)),
    );
    const selection = selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity: 10,
    });
    const keys = new Set(pool.map(({ key }) => key));
    expect(selection.shown).toHaveLength(10);
    expect(new Set(selection.shown).size).toBe(10);
    expect(selection.shown.every((key) => keys.has(key))).toBe(true);
    const per = groups.map(
      (group) => selection.shown.filter((key) => key.startsWith(`${group}:`)).length,
    );
    expect(per).toEqual([3, 3, 2, 2]);
  });

  it("[all decisions] never puts truncation, retrieval degrade or external read in the default sample", () => {
    const pool = [
      item("t", "other"),
      ...Array.from({ length: 30 }, (_, index) => item(`k${index}`, "memory_kept")),
    ];
    const selection = selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity: 24,
    });
    expect(selection.shown).not.toContain("t");
    expect(selection.foldedShown).toEqual(["t"]);
  });

  it("gives the same sample for the same day and a different one for another day or owner", () => {
    const pool = Array.from({ length: 60 }, (_, index) => item(`p${index}`, "proactive"));
    const pick = (dayStart: string, seed: string) =>
      selectDailyReview({ pool, dayStart, seed, capacity: 24 }).shown;
    expect(pick(DAY, "s")).toEqual(pick(DAY, "s"));
    expect(pick(DAY, "s")).not.toEqual(pick("2026-11-04T15:00:00.000Z", "s"));
    expect(pick(DAY, "s")).not.toEqual(pick(DAY, "other"));
  });

  it("keeps items rated today in the sample and drops those rated before today", () => {
    const pool = [
      item("today", "memory_skipped", true, "2026-11-04T00:30:00.000Z"),
      item("yesterday", "memory_skipped", true, "2026-11-03T14:59:59.000Z"),
      item("open", "memory_skipped"),
    ];
    const selection = selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity: 24,
    });
    expect([...selection.shown].sort()).toEqual(["open", "today"]);
    expect(selection.notSampled).toBe(0);
  });

  it("builds and reads back review keys", () => {
    expect(parseReviewKey(reviewKey("ledger", "x:1"))).toEqual({
      source: "ledger",
      id: "x:1",
    });
    expect(parseReviewKey(reviewKey("mail", "m"))).toEqual({
      source: "mail",
      id: "m",
    });
    expect(parseReviewKey("ledger:")).toBeUndefined();
    expect(parseReviewKey("other:1")).toBeUndefined();
  });
});

function entry(overrides: Partial<DecisionLedgerEntry>): DecisionLedgerEntry {
  return {
    id: "e",
    kind: "memory_candidate",
    decidedAt: NOW,
    outcome: "discarded",
    reasonCode: "transient_ignored",
    subjectRef: null,
    inputs: {
      memoryIds: [],
      ruleIds: [],
      batchId: null,
      resultMemoryIds: [],
      sourceIds: [],
      floorHits: {},
      ruleHits: {},
      memoryInjected: false,
      usedMemoryIds: [],
      tentativeMemoryIds: [],
      memoryByMail: {},
      memoryRecall: "off",
      relatedByMail: {},
      relatedRead: "off",
      relatedStats: { requests: 0, messages: 0, characters: 0, durationMs: 0 },
      relatedFailedSteps: [],
      summaryInjected: false,
      summaryIds: [],
      summaryDays: [],
      summaryCharacters: 0,
      summaryRead: "off",
      summaryGenerated: 0,
      profileBudget: null,
      limitChange: null,
    },
    reasonRef: null,
    contentRef: null,
    costMicros: 0,
    durationMs: 0,
    ownerRating: null,
    ratedAt: null,
    category: null,
    confidencePermille: null,
    inferred: null,
    ...overrides,
  };
}

const counts = (judged: number) => ({
  fetched: 3,
  skipped: 0,
  judged,
  act: 0,
  know: 0,
  check: 0,
  ignore: 0,
  floorRaised: 0,
  pushed: 0,
});

function overview(
  audit: ProactiveOverview["audit"]["items"],
  decisions: ProactiveOverview["decisions"] = [],
): ProactiveOverview {
  return {
    audit: { active: true, since: DAY, items: audit, pending: 0 },
    decisions,
  } as unknown as ProactiveOverview;
}

describe("[all decisions] which memories the review page may show", () => {
  it("[RULE-memory-visible] shows public, private and sensitive memories and hides restricted and unknown ones", () => {
    for (const shown of ["public", "private", "sensitive"])
      expect(reviewMemoryVisible(shown)).toBe(true);
    for (const other of ["restricted", "secret", "", "PRIVATE"])
      expect(reviewMemoryVisible(other)).toBe(false);
  });

  it("strips text-direction override characters from the shown text", async () => {
    const review = await readDailyReview({
      scope,
      ledger: {
        listReviewPool: async () => [entry({ id: "kept", outcome: "kept", subjectRef: "m" })],
      },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: "牛肉\u202E123", hidden: false }),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
    });
    expect(review.items[0]?.text).toBe("牛肉123");
  });

  it("[P4-6] keeps text with characters outside the basic plane within the contract length", async () => {
    const review = await readDailyReview({
      scope,
      ledger: {
        listReviewPool: async () => [entry({ id: "kept", outcome: "kept", subjectRef: "m" })],
      },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: "😀".repeat(300), hidden: false }),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
    });
    expect(review.items[0]?.text).toBe("😀".repeat(100));
  });

  it("[P4-6] never splits a character in two at the length limit", async () => {
    const review = await readDailyReview({
      scope,
      ledger: {
        listReviewPool: async () => [entry({ id: "kept", outcome: "kept", subjectRef: "m" })],
      },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: `a${"😀".repeat(200)}`, hidden: false }),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
    });
    expect(review.items[0]?.text).toBe(`a${"😀".repeat(99)}`);
  });

  it("[P4-6] keeps a consolidation of several long memories within the contract length", async () => {
    const review = await readDailyReview({
      scope,
      ledger: {
        listReviewPool: async () => [
          entry({
            id: "merge",
            kind: "consolidation",
            outcome: "merge",
            inputs: {
              ...entry({}).inputs,
              memoryIds: ["a", "b"],
              resultMemoryIds: ["c"],
            },
          }),
        ],
      },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: "😀".repeat(100), hidden: false }),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
    });
    const text = review.items[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(150);
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it("hides the whole consolidation when any memory in it may not be shown", async () => {
    const review = await readDailyReview({
      scope,
      ledger: {
        listReviewPool: async () => [
          entry({
            id: "merge",
            kind: "consolidation",
            outcome: "merge",
            inputs: {
              ...entry({}).inputs,
              memoryIds: ["old"],
              resultMemoryIds: ["new"],
            },
          }),
        ],
      },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async (id) =>
        id === "old" ? { text: "", hidden: true } : { text: "新记忆原文", hidden: false },
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
    });
    expect(review.items[0]).toMatchObject({ text: "", textHidden: true });
  });
});

describe("[P3-8] held memory conflicts in the daily review", () => {
  it("shows a held conflict as old then new and keeps held conflicts within the day's capacity", async () => {
    const memories: Record<string, { text: string; hidden: boolean }> = {
      "milk-old": { text: "主人平时喝明治的牛奶", hidden: false },
      "milk-new": { text: "主人出差时喝便利店的牛奶", hidden: false },
    };
    const holds = Array.from({ length: 30 }, (_, index) =>
      entry({
        id: `hold-${index}`,
        kind: "consolidation",
        outcome: "hold",
        subjectRef: "milk-new",
        inputs: {
          ...entry({}).inputs,
          memoryIds: ["milk-new", "milk-old"],
          resultMemoryIds: ["milk-new"],
        },
      }),
    );
    const review = await readDailyReview({
      scope,
      ledger: { listReviewPool: async () => holds },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async (id) => memories[id],
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 50,
      secondsPerItem: 5,
    });
    expect(review.capacity).toBe(10);
    expect(review.items).toHaveLength(10);
    expect(review.items[0]).toMatchObject({
      kind: "consolidation",
      outcome: "hold",
      text: "主人平时喝明治的牛奶 → 主人出差时喝便利店的牛奶",
      textHidden: false,
      acted: true,
    });
  });
});

describe("[P0-6] reading the daily review", () => {
  const read = (entries: DecisionLedgerEntry[], view: ProactiveOverview) =>
    readDailyReview({
      scope,
      ledger: { listReviewPool: async () => entries },
      overview: view,
      readMemoryText: async (ref) => (ref === "ok" ? "  我最近\n想吃牛肉 " : undefined),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
    });

  it("reads the text of a skipped memory, hides it when there is none, and skips ones the owner rejected", async () => {
    const review = await read(
      [
        entry({ id: "shown", contentRef: "ok" }),
        entry({ id: "secret", category: "health" }),
        entry({ id: "rejected", reasonCode: "approval_rejected" }),
      ],
      overview([]),
    );
    expect(review.items.map(({ key }) => key).sort()).toEqual(["ledger:secret", "ledger:shown"]);
    expect(review.items.find(({ key }) => key === "ledger:shown")).toMatchObject({
      text: "我最近 想吃牛肉",
      textHidden: false,
      acted: false,
    });
    expect(review.items.find(({ key }) => key === "ledger:secret")).toMatchObject({
      text: "",
      textHidden: true,
      category: "health",
    });
  });

  it("[P3-5] shows a failed capture as not acted on, with no memory to read and no hidden text", async () => {
    let reads = 0;
    const review = await readDailyReview({
      scope,
      ledger: {
        listReviewPool: async () =>
          ["capture_retrying", "capture_queued", "capture_gave_up"].map((outcome) =>
            entry({
              id: outcome,
              outcome,
              reasonCode: "AI_GATEWAY_REQUEST_TIMEOUT",
              subjectRef: "memory-capture:run-1",
            }),
          ),
      },
      overview: overview([]),
      readMemoryText: async () => {
        reads += 1;
        return "should not be read";
      },
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
    });
    expect(review.items).toEqual([]);
    expect(review.folded.items.map(({ key }) => key).sort()).toEqual([
      "ledger:capture_gave_up",
      "ledger:capture_queued",
      "ledger:capture_retrying",
    ]);
    for (const item of review.folded.items)
      expect(item).toMatchObject({ acted: false, text: "", textHidden: false });
    expect(reads).toBe(0);
  });

  it("leaves out a silent check that judged no mail and keeps pushed ones", async () => {
    const review = await read(
      [
        entry({ id: "quiet", kind: "proactive", outcome: "silent" }),
        entry({ id: "nothing", kind: "proactive", outcome: "silent" }),
        entry({ id: "spoke", kind: "proactive", outcome: "pushed" }),
      ],
      overview([], [
        { id: "quiet", counts: counts(2) },
        { id: "nothing", counts: counts(0) },
        { id: "spoke", counts: counts(1) },
      ] as unknown as ProactiveOverview["decisions"]),
    );
    expect(review.items.map(({ key }) => key).sort()).toEqual(["ledger:quiet", "ledger:spoke"]);
    expect(review.items.find(({ key }) => key === "ledger:spoke")?.acted).toBe(true);
    expect(review.items.find(({ key }) => key === "ledger:quiet")?.acted).toBe(false);
  });

  it("lists mail that was not reminded, as reviewed once the owner looked at it", async () => {
    const review = await read(
      [],
      overview([
        {
          messageId: "m1",
          decidedAt: NOW,
          reviewedAt: null,
          from: "Shop",
          subject: "セール",
          link: "",
          rating: null,
        },
        {
          messageId: "m2",
          decidedAt: NOW,
          reviewedAt: "2026-11-04T00:10:00.000Z",
          from: "News",
          subject: "週刊",
          link: "",
          rating: null,
        },
        {
          messageId: "m3",
          decidedAt: NOW,
          reviewedAt: "2026-11-03T00:10:00.000Z",
          from: "Old",
          subject: "旧",
          link: "",
          rating: null,
        },
      ]),
    );
    expect(review.items.map(({ key, rating }) => [key, rating]).sort()).toEqual([
      ["mail:m1", null],
      ["mail:m2", "useful"],
    ]);
    expect(review.items[0]).toMatchObject({ source: "mail", acted: false });
  });

  it("[all decisions] puts kept memories and consolidation in the sample and folds the rest", async () => {
    const memories: Record<string, { text: string; hidden: boolean }> = {
      "memory:new": { text: "我最近想吃牛肉", hidden: false },
      "memory:old": { text: "我想吃肉", hidden: false },
      "memory:secret": { text: "不该显示", hidden: true },
    };
    const review = await readDailyReview({
      scope,
      ledger: {
        listReviewPool: async () => [
          entry({ id: "kept", outcome: "kept", subjectRef: "memory:new" }),
          entry({
            id: "pending",
            outcome: "pending_approval",
            subjectRef: "request:1",
          }),
          entry({
            id: "hiddenkept",
            outcome: "kept",
            subjectRef: "memory:secret",
            contentRef: "payload:secret",
          }),
          entry({
            id: "merge",
            kind: "consolidation",
            outcome: "merge",
            inputs: {
              ...entry({}).inputs,
              memoryIds: ["memory:old"],
              resultMemoryIds: ["memory:new"],
            },
          }),
          entry({
            id: "rated",
            kind: "retrieval_degrade",
            outcome: "degraded",
            ownerRating: "useful",
            ratedAt: DAY,
          }),
        ],
      },
      overview: overview([]),
      readMemoryText: async () => "不该显示的原文",
      readMemory: async (id) => memories[id],
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
    });
    expect(review.items.map(({ key }) => key).sort()).toEqual([
      "ledger:hiddenkept",
      "ledger:kept",
      "ledger:merge",
    ]);
    const byKey = (key: string) => review.items.find((candidate) => candidate.key === key);
    expect(byKey("ledger:kept")).toMatchObject({
      text: "我最近想吃牛肉",
      textHidden: false,
      acted: true,
    });
    expect(byKey("ledger:merge")).toMatchObject({
      text: "我想吃肉 → 我最近想吃牛肉",
      acted: true,
    });
    expect(byKey("ledger:hiddenkept")).toMatchObject({
      text: "",
      textHidden: true,
    });
    expect(JSON.stringify(review)).not.toContain("不该显示");
    expect(review.folded.total).toBe(1);
    expect(review.folded.items.map(({ key }) => key).sort()).toEqual([
      "ledger:pending",
      "ledger:rated",
    ]);
  });
});

describe("[P4-8] model prereview reduction on the daily review", () => {
  const pool = Array.from({ length: 12 }, (_, index) => item(`k${index}`, "memory_kept"));
  const pick = (hidden?: ReadonlySet<string>) =>
    selectDailyReview({
      pool,
      dayStart: DAY,
      seed: "s",
      capacity: 6,
      ...(hidden === undefined ? {} : { hidden }),
    });

  it("[negative] leaves the selection exactly as before when nothing is hidden", () => {
    const before = pick();
    expect(pick(new Set())).toEqual(before);
    expect(before.hiddenByModel).toBe(0);
  });

  it("drops hidden items without filling their place, and counts them", () => {
    const before = pick();
    const hidden = new Set(before.shown.slice(0, 2));
    const after = pick(hidden);
    expect(after.shown).toEqual(before.shown.slice(2));
    expect(after.hiddenByModel).toBe(2);
    expect(after.sampled).toBe(4);
    expect(after.notSampled).toBe(before.notSampled);
  });

  it("[negative] never hides an item the owner already rated today", () => {
    const rated = [item("r0", "memory_kept", true, NOW)];
    const selection = selectDailyReview({
      pool: rated,
      dayStart: DAY,
      seed: "s",
      capacity: 6,
      hidden: new Set(["r0"]),
    });
    expect(selection.shown).toEqual(["r0"]);
    expect(selection.hiddenByModel).toBe(0);
  });
});

describe("[P4-8] what the model prereview may see", () => {
  const classified: Record<string, "private" | "restricted"> = {
    ok: "private",
    locked: "restricted",
  };
  const subjects = (entries: DecisionLedgerEntry[], view: ProactiveOverview) => {
    let ratedSince: string | undefined;
    return readDailyReviewSubjects({
      scope,
      ledger: {
        listReviewPool: async (query) => {
          ratedSince = query.ratedSince;
          return entries.filter(
            (candidate) => candidate.ratedAt === null || candidate.ratedAt >= query.ratedSince,
          );
        },
      },
      overview: view,
      readMemoryText: async (ref) => (ref in classified ? `正文 ${ref}` : undefined),
      readMemoryClassification: async (ref) => classified[ref],
      timeZone: "Asia/Tokyo",
      now: NOW,
    }).then((result) => ({ result, ratedSince }));
  };

  it("includes items the owner rated days ago, with the owner's rating, so agreement can start at once", async () => {
    const { result, ratedSince } = await subjects(
      [
        entry({
          id: "old",
          contentRef: "ok",
          ownerRating: "missed",
          ratedAt: "2026-10-30T00:00:00.000Z",
        }),
      ],
      overview([]),
    );
    expect(ratedSince).toBe("2026-10-28T01:00:00.000Z");
    expect(result).toEqual([
      {
        key: "ledger:old",
        group: "memory_skipped",
        category: null,
        text: "正文 ok",
        dataClassification: "private",
        ownerRating: "missed",
      },
    ]);
  });

  it("[negative] leaves out restricted text and text it cannot classify", async () => {
    const { result } = await subjects(
      [entry({ id: "locked", contentRef: "locked" }), entry({ id: "unknown", contentRef: "gone" })],
      overview([]),
    );
    expect(result).toEqual([]);
  });

  it("puts reminded and silent decisions and skipped mail in their own groups", async () => {
    const { result } = await subjects(
      [],
      overview([
        {
          messageId: "m1",
          decidedAt: NOW,
          reviewedAt: "2026-11-04T00:10:00.000Z",
          from: "Shop",
          subject: "セール",
          link: "",
          rating: null,
        },
      ]),
    );
    expect(result).toEqual([
      {
        key: "mail:m1",
        group: "proactive_silent",
        category: null,
        text: "Shop · セール",
        dataClassification: "private",
        ownerRating: "useful",
      },
    ]);
  });
});

describe("[P4-8] decisions the prereview cannot see", () => {
  it("[negative] gives reminded mail decisions no subject, since the page shows them without text", async () => {
    const subjects = await readDailyReviewSubjects({
      scope,
      ledger: {
        listReviewPool: async () => [entry({ id: "spoke", kind: "proactive", outcome: "pushed" })],
      },
      overview: overview([], [
        { id: "spoke", counts: counts(1) },
      ] as unknown as ProactiveOverview["decisions"]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: "x", hidden: false, dataClassification: "private" }),
      timeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(subjects).toEqual([]);
  });

  it("uses the memory's own classification for kept memories and skips ones without it", async () => {
    const read = (dataClassification?: "private" | "sensitive") =>
      readDailyReviewSubjects({
        scope,
        ledger: {
          listReviewPool: async () => [
            entry({ id: "kept", outcome: "kept", subjectRef: "memory:new" }),
          ],
        },
        overview: overview([]),
        readMemoryText: async () => undefined,
        readMemory: async () =>
          dataClassification === undefined
            ? { text: "我最近想吃牛肉", hidden: false }
            : { text: "我最近想吃牛肉", hidden: false, dataClassification },
        timeZone: "Asia/Tokyo",
        now: NOW,
      });
    expect(
      (await read("sensitive")).map(({ group, dataClassification }) => [group, dataClassification]),
    ).toEqual([["memory_kept", "sensitive"]]);
    expect(await read()).toEqual([]);
  });
});

describe("[P4-6] memory checkup in the daily review", () => {
  const checkup = (
    id: string,
    handledAt: string | null,
  ): import("../src/ports/memory-checkup.js").MemoryCheckupItem => ({
    id,
    ownerId: scope.ownerId,
    agentId: scope.agentId,
    weekStart: "2026-11-01T15:00:00.000Z",
    memoryId: `memory:${id}` as never,
    relatedMemoryId: null,
    reason: "unused",
    action: handledAt === null ? null : "confirm",
    keptMemoryId: null,
    before: handledAt === null ? null : { tentative: false },
    handledAt,
    undoneAt: null,
    createdAt: "2026-11-02T00:00:00.000Z",
  });
  const read = (items: ReturnType<typeof checkup>[]) =>
    readDailyReview({
      scope,
      ledger: { listReviewPool: async () => [] },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: "牛奶", hidden: false }),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 10,
      secondsPerItem: 5,
      checkup: items,
    });

  it("keeps items handled earlier this week on the page for undo without spending today's slots", async () => {
    const review = await read([
      checkup("yesterday", "2026-11-03T02:00:00.000Z"),
      checkup("a", null),
      checkup("b", null),
      checkup("c", null),
    ]);
    expect(review.sampled).toBe(2);
    expect(review.items.map(({ key }) => key)).toContain("checkup:yesterday");
    expect(review.items.filter(({ checkup: entry }) => entry?.action === null)).toHaveLength(2);
    expect(review.items.find(({ key }) => key === "checkup:yesterday")?.checkup?.action).toBe(
      "confirm",
    );
  });

  it("[negative] does not add pending items beyond today's slots", async () => {
    const review = await read([checkup("a", null), checkup("b", null), checkup("c", null)]);
    expect(review.items).toHaveLength(2);
  });

  it("shows a held conflict only through the checkup group, and as a consolidation when the checkup list does not carry it", async () => {
    const hold = entry({
      id: "hold",
      kind: "consolidation",
      outcome: "hold",
      inputs: {
        ...entry({}).inputs,
        memoryIds: ["old"],
        resultMemoryIds: ["new"],
      },
    });
    const withCheckup = await readDailyReview({
      scope,
      ledger: { listReviewPool: async () => [hold] },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: "牛奶", hidden: false }),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
      checkup: [
        {
          ...checkup("pair", null),
          memoryId: "new" as never,
          relatedMemoryId: "old" as never,
          reason: "conflict",
        },
      ],
    });
    expect(withCheckup.items.map(({ key }) => key)).not.toContain("ledger:hold");
    const withoutCheckup = await readDailyReview({
      scope,
      ledger: { listReviewPool: async () => [hold] },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: "牛奶", hidden: false }),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
      checkup: [checkup("other", null)],
    });
    expect(withoutCheckup.items.map(({ key }) => key)).toContain("ledger:hold");
    const sharedOld = entry({
      id: "hold-shared",
      kind: "consolidation",
      outcome: "hold",
      inputs: {
        ...entry({}).inputs,
        memoryIds: ["other-new", "old"],
        resultMemoryIds: ["other-new"],
      },
    });
    const sharing = await readDailyReview({
      scope,
      ledger: { listReviewPool: async () => [hold, sharedOld] },
      overview: overview([]),
      readMemoryText: async () => undefined,
      readMemory: async () => ({ text: "牛奶", hidden: false }),
      timeZone: "Asia/Tokyo",
      now: NOW,
      budgetSeconds: 120,
      secondsPerItem: 5,
      checkup: [
        {
          ...checkup("pair", null),
          memoryId: "new" as never,
          relatedMemoryId: "old" as never,
          reason: "conflict",
        },
      ],
    });
    const sharingKeys = sharing.items.map(({ key }) => key);
    expect(sharingKeys).not.toContain("ledger:hold");
    expect(sharingKeys).toContain("ledger:hold-shared");
  });
});
