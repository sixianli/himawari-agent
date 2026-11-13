import {
  IMPORT_DUPLICATE_DEFAULTS,
  type ImportDuplicateAnswer,
  type ImportDuplicateDecisionPort,
} from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import { ProductionImportDuplicateChecker } from "../src/production-memory-import-duplicates.js";

type Decide = ImportDuplicateDecisionPort["decide"];
type Input = Parameters<Decide>[0];

const existing = [
  { memoryId: "memory-a", text: "对乳制品不耐受" },
  { memoryId: "memory-b", text: "住在上海" },
  { memoryId: "memory-c", text: "每周跑三次步" },
];

function checker(decide: Decide, settings = {}) {
  const failures: unknown[] = [];
  return {
    failures,
    checker: new ProductionImportDuplicateChecker({
      decision: { decide },
      settings: { ...IMPORT_DUPLICATE_DEFAULTS, ...settings },
      onFailure: (error) => failures.push(error),
    }),
  };
}

const answer = (matchKey: string | null, probabilityPermille: number): ImportDuplicateAnswer => ({
  matchKey,
  probabilityPermille,
});

describe("[A4] production import duplicate checker", () => {
  it("maps a confident match to the existing memory id and everything else to different", async () => {
    const { checker: run } = checker(async (input: Input) =>
      input.candidates.map(({ text }) =>
        text === "喝不了牛奶" ? answer("m0", 900) : answer(null, 0),
      ),
    );
    const results = await run.check(["喝不了牛奶", "喜欢蓝色"], existing);
    expect(results).toEqual([
      { verdict: "same", memoryId: "memory-a" },
      { verdict: "different", memoryId: null },
    ]);
  });

  it("keeps the strongest answer across chunks of existing memories", async () => {
    const { checker: run } = checker(
      async (input: Input) =>
        input.candidates.map(() =>
          input.existing.some(({ key }) => key === "m2") ? answer("m2", 800) : answer("m0", 400),
        ),
      { existingPerRequest: 2 },
    );
    const [result] = await run.check(["每周跑步三次"], existing);
    expect(result).toEqual({ verdict: "same", memoryId: "memory-c" });
  });

  it("calls a middling probability unsure and never sends deterministically sensitive text", async () => {
    const sent: string[] = [];
    const { checker: run } = checker(async (input: Input) => {
      for (const { text } of input.candidates) sent.push(text);
      return input.candidates.map(() => answer("m1", 500));
    });
    const results = await run.check(["在上海住了三年", "我的密码是 hunter2"], existing);
    expect(results[0]).toEqual({ verdict: "unsure", memoryId: "memory-b" });
    expect(results[1]).toEqual({ verdict: "skipped", memoryId: null });
    expect(sent).toEqual(["在上海住了三年"]);
  });

  it("REVERSE: a failed or refused request is skipped, never reported as different", async () => {
    const failing = checker(async () => {
      throw new Error("IMPORT_DUPLICATE_HTTP_503");
    });
    expect(await failing.checker.check(["喝不了牛奶"], existing)).toEqual([
      { verdict: "skipped", memoryId: null },
    ]);
    expect(failing.failures).toHaveLength(1);
    const refused = checker(async (input: Input) => input.candidates.map(() => undefined));
    expect(await refused.checker.check(["喝不了牛奶"], existing)).toEqual([
      { verdict: "skipped", memoryId: null },
    ]);
  });

  it("REVERSE: a failure in one chunk does not hide a match found in another", async () => {
    const { checker: run } = checker(
      async (input: Input) => {
        if (!input.existing.some(({ key }) => key === "m2"))
          throw new Error("IMPORT_DUPLICATE_HTTP_500");
        return input.candidates.map(() => answer("m2", 950));
      },
      { existingPerRequest: 2 },
    );
    expect(await run.check(["每周跑步三次"], existing)).toEqual([
      { verdict: "same", memoryId: "memory-c" },
    ]);
  });

  it("stops at the request limit and reports the rest as skipped", async () => {
    let calls = 0;
    const { checker: run } = checker(
      async (input: Input) => {
        calls += 1;
        return input.candidates.map(() => answer(null, 0));
      },
      { candidatesPerRequest: 1, maximumRequests: 2 },
    );
    const results = await run.check(["甲乙", "丙丁", "戊己"], existing);
    expect(calls).toBe(2);
    expect(results.map(({ verdict }) => verdict)).toEqual(["different", "different", "skipped"]);
  });

  it("REVERSE: reports skipped, not different, when existing memories could not all be read or none may be compared", async () => {
    let calls = 0;
    const { checker: run } = checker(async () => {
      calls += 1;
      return [];
    });
    expect(await run.check(["喝不了牛奶"], existing, { complete: false })).toEqual([
      { verdict: "skipped", memoryId: null },
    ]);
    expect(
      await run.check(["喝不了牛奶"], [{ memoryId: "memory-x", text: "密码是 hunter2" }]),
    ).toEqual([{ verdict: "skipped", memoryId: null }]);
    expect(calls).toBe(1);
    const failing = checker(async (input: Input) => input.candidates.map(() => answer(null, 0)));
    expect(await failing.checker.check(["喝不了牛奶"], existing, { complete: false })).toEqual([
      { verdict: "skipped", memoryId: null },
    ]);
  });

  it("sends the first request alone and pairs the rest of the same chunk right after it", async () => {
    const order: string[] = [];
    let active = 0;
    let firstWasAlone = true;
    const { checker: run } = checker(
      async (input: Input) => {
        order.push(input.existing.map(({ key }) => key).join(","));
        if (order.length === 1) firstWasAlone = active === 0;
        active += 1;
        await Promise.resolve();
        active -= 1;
        return input.candidates.map(() => answer(null, 0));
      },
      { candidatesPerRequest: 1, existingPerRequest: 2 },
    );
    await run.check(["甲乙", "丙丁"], existing);
    expect(firstWasAlone).toBe(true);
    expect(order).toEqual(["m0,m1", "m0,m1", "m2", "m2"]);
  });

  it("reports the daily limit through onFailure once it is hit", async () => {
    const { checker: run, failures } = checker(
      async (input: Input) => input.candidates.map(() => answer(null, 0)),
      { dailyMaximumRequests: 1 },
    );
    await run.check(["甲乙"], existing);
    await run.check(["丙丁"], existing);
    expect(failures.map((error) => (error as Error).message)).toEqual([
      "IMPORT_DUPLICATE_DAILY_LIMIT",
    ]);
  });

  it("stops asking once the daily request limit is used up", async () => {
    let calls = 0;
    const { checker: run } = checker(
      async (input: Input) => {
        calls += 1;
        return input.candidates.map(() => answer(null, 0));
      },
      { dailyMaximumRequests: 2 },
    );
    const first = await run.check(["甲乙"], existing);
    const second = await run.check(["丙丁"], existing);
    const third = await run.check(["戊己"], existing);
    expect([first, second, third].map(([item]) => item?.verdict)).toEqual([
      "different",
      "different",
      "skipped",
    ]);
    expect(calls).toBe(2);
  });

  it("asks nothing when there is no existing memory", async () => {
    let calls = 0;
    const { checker: run } = checker(async () => {
      calls += 1;
      return [];
    });
    expect(await run.check(["喝不了牛奶"], [])).toEqual([{ verdict: "different", memoryId: null }]);
    expect(calls).toBe(0);
  });
});
