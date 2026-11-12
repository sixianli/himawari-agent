import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME_FEED,
  type HomeCandidate,
  HomeFeedService,
  type HomeSource,
  orderHomeItems,
} from "../src/index.ts";

const NOW = "2026-11-12T03:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

function candidate(key: string, extra: Partial<HomeCandidate> = {}): HomeCandidate {
  return {
    key,
    kind: "heads_up",
    awaitsOwner: true,
    sentence: key,
    sentenceBasis: "recorded",
    target: { type: "mail", id: key, threadId: null, link: null },
    source: { type: "mail", from: null, label: null, threadId: null, decisionId: null, at: NOW },
    deadline: null,
    createdAt: at(-60),
    actions: [],
    ruleHit: false,
    dataClassification: "private",
    ...extra,
  };
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}

function service(
  sources: readonly HomeSource[],
  settings = DEFAULT_HOME_FEED,
  failures: string[] = [],
) {
  return new HomeFeedService({
    sources,
    settings,
    clock: { now: () => NOW },
    digest: (text) => {
      let hash = 0x811c9dc5;
      for (const character of text)
        hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
      return hash.toString(16);
    },
    onSourceFailure: (source) => failures.push(source),
  });
}

const fixed = (
  name: HomeSource["name"],
  awaitsOwner: boolean,
  items: readonly HomeCandidate[],
  unread = 0,
): HomeSource => ({ name, awaitsOwner, read: async () => ({ items, unread }) });

describe("home feed ordering", () => {
  const candidates = [
    candidate("insight:rule", { ruleHit: true, createdAt: at(-600) }),
    candidate("insight:rule-due", { ruleHit: true, deadline: at(30) }),
    candidate("approval:soon", { kind: "approval", deadline: at(20) }),
    candidate("reminder:overdue", { deadline: at(-10) }),
    candidate("approval:later", { kind: "approval", deadline: at(3 * 1440) }),
    candidate("memory_request:new", { kind: "memory_confirm", createdAt: at(-5) }),
    candidate("memory_request:old", { kind: "memory_confirm", createdAt: at(-500) }),
    candidate("memory_request:tie-b", { kind: "memory_confirm", createdAt: at(-90) }),
    candidate("memory_request:tie-a", { kind: "memory_confirm", createdAt: at(-90) }),
    candidate("tidy:new", { kind: "done", awaitsOwner: false, createdAt: at(-1) }),
    candidate("run:old", { kind: "running", awaitsOwner: false, createdAt: at(-300) }),
  ];
  const expected = [
    ["insight:rule-due", "rule"],
    ["insight:rule", "rule"],
    ["reminder:overdue", "deadline"],
    ["approval:soon", "deadline"],
    ["approval:later", "unscored"],
    ["memory_request:new", "unscored"],
    ["memory_request:tie-a", "unscored"],
    ["memory_request:tie-b", "unscored"],
    ["memory_request:old", "unscored"],
    ["tidy:new", "recency"],
    ["run:old", "recency"],
  ];

  it("puts rule hits first, then near deadlines, then the rest, then what does not wait for the owner", () => {
    expect(
      orderHomeItems(candidates, NOW, DEFAULT_HOME_FEED.deadlineLeadMinutes).map(
        ({ key, rank }) => [key, rank],
      ),
    ).toEqual(expected);
  });

  it("gives the same order whatever order the sources return rows in", () => {
    for (let seed = 1; seed <= 25; seed += 1)
      expect(
        orderHomeItems(shuffled(candidates, seed), NOW, DEFAULT_HOME_FEED.deadlineLeadMinutes).map(
          ({ key, rank }) => [key, rank],
        ),
      ).toEqual(expected);
  });

  it("stops raising a deadline once the lead time is set to zero and the deadline is still ahead", () => {
    const ordered = orderHomeItems(candidates, NOW, 0);
    expect(ordered.find(({ key }) => key === "approval:soon")?.rank).toBe("unscored");
    expect(ordered.find(({ key }) => key === "reminder:overdue")?.rank).toBe("deadline");
  });

  it("never lets something that does not wait for the owner outrank something that does", () => {
    const ordered = orderHomeItems(
      [
        candidate("run:newest", { kind: "running", awaitsOwner: false, createdAt: at(0) }),
        candidate("memory_request:ancient", { kind: "memory_confirm", createdAt: at(-99_999) }),
      ],
      NOW,
      DEFAULT_HOME_FEED.deadlineLeadMinutes,
    );
    expect(ordered.map(({ key }) => key)).toEqual(["memory_request:ancient", "run:newest"]);
  });
});

describe("home feed count", () => {
  const awaiting = [
    candidate("insight:1"),
    candidate("approval:1", { kind: "approval" }),
    candidate("memory_request:1", { kind: "memory_confirm" }),
  ];
  const others = [
    candidate("tidy:1", { kind: "done", awaitsOwner: false }),
    candidate("run:1", { kind: "running", awaitsOwner: false }),
  ];

  it("equals the awaiting entries in the list and is the number the badge function returns", async () => {
    const feed = service([fixed("mail", true, awaiting), fixed("done", false, others)]);
    const read = await feed.read({ locale: "en" });
    expect(read.awaitingCount).toBe(3);
    expect(read.items.filter(({ awaitsOwner }) => awaitsOwner)).toHaveLength(3);
    expect(read.items).toHaveLength(5);
    expect(read.awaitingTruncated).toBe(false);
    expect(await feed.awaitingCount()).toBe(3);
  });

  it("is zero when only finished and running things exist", async () => {
    const feed = service([fixed("done", false, others), fixed("runs", false, [])]);
    expect((await feed.read({ locale: "en" })).awaitingCount).toBe(0);
    expect(await feed.awaitingCount()).toBe(0);
  });

  it("ignores an awaiting flag that contradicts the source it came from", async () => {
    const feed = service([
      fixed("done", false, [candidate("tidy:lying", { kind: "done", awaitsOwner: true })]),
      fixed("mail", true, [candidate("insight:lying", { awaitsOwner: false })]),
    ]);
    const read = await feed.read({ locale: "en" });
    expect(read.items).toEqual([]);
    expect(read.awaitingCount).toBe(0);
    expect(await feed.awaitingCount()).toBe(0);
  });

  it("keeps the true count when the list is cut at the limit", async () => {
    const many = Array.from({ length: 7 }, (_, index) => candidate(`insight:${index}`));
    const feed = service([fixed("mail", true, many), fixed("done", false, others)], {
      ...DEFAULT_HOME_FEED,
      awaitingLimit: 4,
    });
    const read = await feed.read({ locale: "en" });
    expect(read.items.filter(({ awaitsOwner }) => awaitsOwner)).toHaveLength(4);
    expect(read.awaitingCount).toBe(7);
    expect(read.awaitingTruncated).toBe(true);
    expect(await feed.awaitingCount()).toBe(7);
  });

  it("adds what a source could not read within its own limit", async () => {
    const feed = service([fixed("reminders", true, awaiting, 12)]);
    const read = await feed.read({ locale: "en" });
    expect(read.awaitingCount).toBe(15);
    expect(read.awaitingTruncated).toBe(true);
    expect(await feed.awaitingCount()).toBe(15);
  });

  it("counts one entry once when two sources return the same key", async () => {
    const feed = service([
      fixed("mail", true, [candidate("insight:1")]),
      fixed("reminders", true, [candidate("insight:1")]),
    ]);
    expect((await feed.read({ locale: "en" })).awaitingCount).toBe(1);
    expect(await feed.awaitingCount()).toBe(1);
  });

  it("names a source that failed instead of dropping its entries silently", async () => {
    const failures: string[] = [];
    const feed = service(
      [
        fixed("mail", true, awaiting),
        {
          name: "approvals",
          awaitsOwner: true,
          read: async () => {
            throw new Error("down");
          },
        },
      ],
      DEFAULT_HOME_FEED,
      failures,
    );
    const read = await feed.read({ locale: "en" });
    expect(read.incompleteSources).toEqual(["approvals"]);
    expect(read.awaitingCount).toBe(3);
    expect(failures).toEqual(["approvals"]);
    expect(await feed.awaitingCount()).toBeUndefined();
  });

  it("gives no badge number when a source says its own answer is incomplete", async () => {
    const feed = service([
      fixed("mail", true, awaiting),
      {
        name: "rules",
        awaitsOwner: true,
        read: async () => ({ items: [], unread: 0, incomplete: true }),
      },
    ]);
    const read = await feed.read({ locale: "en" });
    expect(read.incompleteSources).toEqual(["rules"]);
    expect(read.awaitingCount).toBe(3);
    expect(await feed.awaitingCount()).toBeUndefined();
  });

  it("counts an awaiting entry even when something that does not wait shares its key and was read first", async () => {
    const feed = service([
      fixed("done", false, [candidate("shared:1", { kind: "done", awaitsOwner: false })]),
      fixed("mail", true, [candidate("shared:1")]),
    ]);
    const read = await feed.read({ locale: "en" });
    expect(read.awaitingCount).toBe(1);
    expect(read.items.map(({ awaitsOwner }) => awaitsOwner)).toEqual([true]);
    expect(await feed.awaitingCount()).toBe(1);
  });

  it("does not read finished and running sources for the badge", async () => {
    let reads = 0;
    const feed = service([
      fixed("mail", true, awaiting),
      {
        name: "done",
        awaitsOwner: false,
        read: async () => {
          reads += 1;
          return { items: others, unread: 0 };
        },
      },
    ]);
    await feed.awaitingCount();
    expect(reads).toBe(0);
  });
});

describe("home feed revision", () => {
  it("stays the same for the same entries and changes when an entry changes", async () => {
    const first = await service([fixed("mail", true, [candidate("insight:1")])]).read({
      locale: "en",
    });
    const again = await service([fixed("mail", true, [candidate("insight:1")])]).read({
      locale: "en",
    });
    const changed = await service([
      fixed("mail", true, [candidate("insight:1", { sentence: "other" })]),
    ]).read({ locale: "en" });
    expect(again.revision).toBe(first.revision);
    expect(changed.revision).not.toBe(first.revision);
  });
});
