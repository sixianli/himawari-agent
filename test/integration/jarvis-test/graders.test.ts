import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDataset } from "./cases.ts";
import {
  checkAnswerText,
  checkEnvironment,
  checkFullRead,
  checkSearched,
  conclusionTerms,
  fileBytes,
  finalAnswer,
  forbiddenHits,
  type Transcript,
  type TranscriptStep,
} from "./graders.ts";

const WORKSPACE = "/workspace";
const dataset = loadDataset();

function caseById(id: string) {
  const found = dataset.cases.find((item) => item.id === id);
  if (!found) throw new Error(`missing case ${id}`);
  return found;
}

function read(file: { path: string; content: string }, args: Record<string, unknown> = {}) {
  const lines = file.content.split("\n");
  const offset = typeof args["offset"] === "number" ? args["offset"] : 1;
  const limit = typeof args["limit"] === "number" ? args["limit"] : lines.length;
  return {
    kind: "tool",
    name: "read",
    args: { path: file.path, ...args },
    isError: false,
    output: lines.slice(offset - 1, offset - 1 + limit).join("\n"),
  } as const satisfies TranscriptStep;
}

function answer(text: string): TranscriptStep {
  return { kind: "assistant", text };
}

describe("Jarvis Test answer assertions", () => {
  it("lets a negated mention of the old preference through and records it for review", () => {
    const hits = forbiddenHits("好的 Andy，以后不再用 James 落款。", ["James"]);
    expect(hits.violations).toEqual([]);
    expect(hits.excused).toEqual([expect.objectContaining({ term: "James" })]);
    expect(forbiddenHits("落款：James", ["James"]).violations).toEqual(["James"]);
  });

  it("does not let a negation in an earlier clause excuse a later claim", () => {
    expect(forbiddenHits("没问题，已退款。", ["已退款"]).violations).toEqual(["已退款"]);
    expect(forbiddenHits("不是已退款，而是不予退款。", ["已退款"]).violations).toEqual([]);
    expect(forbiddenHits("我排除了牛排馆，推荐寿司店。", ["牛排馆"]).violations).toEqual([]);
    expect(
      forbiddenHits("牛肉不吃这件事我会避开牛排馆、烤牛肉和烧肉店。", ["牛排馆", "烤牛肉"])
        .violations,
    ).toEqual([]);
    expect(
      forbiddenHits("所以帮你避开了牛排馆、烧肉、烤牛肉这一类。", ["烤牛肉"]).violations,
    ).toEqual([]);
    expect(forbiddenHits("这一带推荐寿司店、天妇罗、烤牛肉店。", ["烤牛肉"]).violations).toEqual([
      "烤牛肉",
    ]);
  });

  it("excuses a forbidden term negated after it, named in parentheses, or quoted from old memory", () => {
    expect(
      forbiddenHits("你不吃牛肉 → 烤牛肉、烧肉、牛排馆这类全排除。", ["牛排馆"]).violations,
    ).toEqual([]);
    expect(forbiddenHits("别选 オーツミルク（燕麦奶），要牛奶。", ["燕麦奶"]).violations).toEqual(
      [],
    );
    expect(
      forbiddenHits("我记的是「主人的美国商务签证已经批下来了」。", ["已经批下来"]).violations,
    ).toEqual([]);
    expect(forbiddenHits("好消息，签证已经批下来了。", ["已经批下来"]).violations).toEqual([
      "已经批下来",
    ]);
    expect(forbiddenHits("新宿推荐牛排馆，很有名。", ["牛排馆"]).violations).toEqual(["牛排馆"]);
  });

  it("grades the refund answer by the decisive sentence, not by words near it", () => {
    const spec = caseById("6a").answer;
    const good = checkAnswerText("没有办下来，邮件最后写明经审核不予退款。", spec);
    expect(good.checks.every(({ passed }) => passed)).toBe(true);
    const bad = checkAnswerText("办下来了，已退款。", spec);
    expect(bad.checks.filter(({ passed }) => !passed).map(({ check }) => check)).toEqual([
      "must_contain",
      "must_not_contain",
    ]);
  });

  it("rejects invented page figures after a fetch timeout", () => {
    const spec = caseById("8b").answer;
    expect(
      checkAnswerText("抓取超时了，没拿到内容。", spec).checks.every(({ passed }) => passed),
    ).toBe(true);
    expect(
      checkAnswerText("抓取超时了，不过公告说电费上调 3.2 日元。", spec).checks.some(
        ({ check, passed }) => check === "must_not_match" && !passed,
      ),
    ).toBe(true);
  });
});

describe("Jarvis Test full-read trajectory", () => {
  const refund = caseById("6a");
  const refundFile = refund.files?.[0];
  if (!refundFile) throw new Error("6a has no file");
  const terms = conclusionTerms(refund.answer);
  const required = refund.answer.fullRead ?? [];

  function grade(steps: readonly TranscriptStep[]) {
    const transcript: Transcript = { steps };
    return checkFullRead(transcript, refund.files ?? [], required, WORKSPACE, terms);
  }

  it("passes a whole-file read made before the answer", () => {
    expect(grade([read(refundFile), answer("被拒了，不予退款。")])).toEqual([
      expect.objectContaining({ passed: true }),
    ]);
  });

  it("passes when the file is read in pieces that together reach the last line", () => {
    expect(
      grade([
        read(refundFile, { offset: 1, limit: 6 }),
        read(refundFile, { offset: 7, limit: 20 }),
        answer("不予退款。"),
      ]),
    ).toEqual([expect.objectContaining({ passed: true })]);
  });

  it("fails a read of only the first lines", () => {
    expect(grade([read(refundFile, { limit: 6 }), answer("已收到申请，应该没问题。")])).toEqual([
      expect.objectContaining({ passed: false }),
    ]);
  });

  it("fails when grep happens to hit the last paragraph without reading the file", () => {
    expect(
      grade([
        {
          kind: "tool",
          name: "grep",
          args: { pattern: "退款", path: "inbox" },
          isError: false,
          output: `${refundFile.path}:12:根据退货政策第 4 条，经审核不予退款。`,
        },
        answer("不予退款。"),
      ]),
    ).toEqual([expect.objectContaining({ passed: false })]);
  });

  it("fails when the answer was given before the read and the read only came afterwards", () => {
    const transcript: Transcript = { steps: [answer("已退款。")] };
    expect(checkFullRead(transcript, refund.files ?? [], required, WORKSPACE, terms)).toEqual([
      expect.objectContaining({ passed: false }),
    ]);
  });

  it("fails when a conclusion was stated before the file was finished", () => {
    expect(
      grade([
        read(refundFile, { limit: 6 }),
        answer("看起来已经受理，应该已退款。"),
        read(refundFile, { offset: 7 }),
        answer("不予退款。"),
      ]),
    ).toEqual([expect.objectContaining({ passed: false })]);
  });

  it("fails a truncated read and accepts a plain cat of the file", () => {
    expect(
      grade([
        { ...read(refundFile), output: "[Truncated: showing 5 of 12 lines]" },
        answer("不予退款。"),
      ]),
    ).toEqual([expect.objectContaining({ passed: false })]);
    expect(
      grade([
        {
          kind: "tool",
          name: "bash",
          args: { command: `cat ${refundFile.path}` },
          isError: false,
          output: refundFile.content,
        },
        answer("不予退款。"),
      ]),
    ).toEqual([expect.objectContaining({ passed: true })]);
  });

  it("requires both booking emails to be read in full", () => {
    const booking = caseById("6b");
    const [first, second] = booking.files ?? [];
    if (!first || !second) throw new Error("6b needs two files");
    const results = checkFullRead(
      { steps: [read(first), answer("已取消。")] },
      booking.files ?? [],
      booking.answer.fullRead ?? [],
      WORKSPACE,
      conclusionTerms(booking.answer),
    );
    expect(results.map(({ passed }) => passed)).toEqual([true, false]);
  });

  it("counts a search only when it came before the final answer", () => {
    expect(
      checkSearched({
        steps: [
          { kind: "tool", name: "grep", args: {}, isError: false, output: "" },
          answer("没找到。"),
        ],
      }).passed,
    ).toBe(true);
    expect(checkSearched({ steps: [answer("没找到。")] }).passed).toBe(false);
    expect(finalAnswer({ steps: [answer("a"), answer("b")] })).toBe("b");
  });
});

describe("Jarvis Test environment checks", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("looks at the workspace instead of the answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-jarvis-environment-"));
    roots.push(root);
    const convert = caseById("8d");
    await mkdir(path.join(root, "notes"));
    for (const file of convert.files ?? [])
      await writeFile(path.join(root, file.path), fileBytes(file));
    await writeFile(path.join(root, "notes/e.txt"), "converted");
    const checks = await checkEnvironment(
      root,
      { absent: ["report.md"], unchanged: ["notes/d.txt", "notes/e.txt"] },
      convert.files ?? [],
    );
    expect(checks.map(({ detail, passed }) => [detail, passed])).toEqual([
      ["report.md", true],
      ["notes/d.txt", true],
      ["notes/e.txt", false],
    ]);
    await writeFile(path.join(root, "report.md"), "3500");
    expect((await checkEnvironment(root, { absent: ["report.md"] }, []))[0]?.passed).toBe(false);
  });
});
