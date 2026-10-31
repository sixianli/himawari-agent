import { describe, expect, it } from "vitest";
import { executionTimeline, timelineDuration } from "../src/execution-timeline.js";
import { at, completedRun, gameRun, newsRun, runStart } from "./news-run-fixture.js";

describe("execution timeline", () => {
  it("[UI-3] gives every second of a turn to exactly one of model, tool, waiting for you and preparation", () => {
    const timeline = executionTimeline(newsRun(), completedRun, runStart + 99999);
    expect(timeline?.total).toBe(27082);
    expect(timeline?.categories).toEqual({ you: 8428, tool: 2929, model: 9348, prep: 6377 });
    const { you, tool: toolTime, model, prep } = timeline?.categories ?? {};
    expect((you ?? 0) + (toolTime ?? 0) + (model ?? 0) + (prep ?? 0)).toBe(timeline?.total);
  });

  it("[UI-3] lists the steps in order with times taken from the recorded events", () => {
    const timeline = executionTimeline(newsRun(), completedRun, runStart + 99999);
    expect(
      timeline?.steps.map(({ kind, start, end, parallel }) => [kind, start, end, parallel]),
    ).toEqual([
      ["think", 2339, 5104, false],
      ["you", 7529, 15957, false],
      ["tool", 15961, 18813, false],
      ["tool", 15962, 18890, true],
      ["think", 18893, 21800, false],
      ["write", 21800, 25473, false],
    ]);
    expect(timeline?.longest).toBe(timeline?.steps[1]?.id);
  });

  it("[UI-3] splits model and tool steps into waiting, reasoning, output, queue and run segments", () => {
    const steps = executionTimeline(newsRun(), completedRun, runStart + 99999)?.steps ?? [];
    expect(steps[0]?.segments).toEqual([
      { kind: "wait", start: 2339, end: 4193 },
      { kind: "output", start: 4193, end: 5104 },
    ]);
    expect(steps[2]?.segments).toEqual([
      { kind: "queue", start: 15961, end: 16200 },
      { kind: "run", start: 16200, end: 18700 },
    ]);
    expect(steps[4]?.segments).toEqual([
      { kind: "wait", start: 18893, end: 19600 },
      { kind: "reason", start: 19600, end: 21000 },
      { kind: "wait", start: 21000, end: 21800 },
    ]);
    expect(steps[5]).toMatchObject({ itemId: "message:last", characters: 120 });
    expect(steps[2]).toMatchObject({ itemId: "tool:zh" });
  });

  it("[UI-3] keeps a running step open until now and still adds up to the elapsed time", () => {
    const records = newsRun().filter((item) => item.sequence <= 11);
    const timeline = executionTimeline(
      records,
      { ...completedRun, status: "awaiting_approval", updatedAt: at(7529) },
      runStart + 10000,
    );
    expect(timeline?.total).toBe(10000);
    expect(timeline?.steps.at(-1)).toMatchObject({ kind: "you", end: 10000, running: true });
    expect(timeline?.categories).toEqual({ you: 2471, tool: 0, model: 2765, prep: 4764 });
  });

  it("[UI-3] falls back to the first text update when no output boundary was recorded", () => {
    const records = newsRun().filter((item) => item.name !== "runtime.text.started");
    const steps = executionTimeline(records, completedRun, runStart + 99999)?.steps ?? [];
    expect(steps.slice(-2).map(({ kind, start, end }) => [kind, start, end])).toEqual([
      ["think", 18893, 22400],
      ["write", 22400, 25473],
    ]);
  });

  it("counts the time the model spends writing a file as the file step, not as thinking", () => {
    const run = { ...completedRun, updatedAt: at(52000) };
    const steps = executionTimeline(gameRun(), run, runStart + 99999)?.steps ?? [];
    const think = steps.find((step) => step.kind === "think");
    const write = steps.find((step) => step.kind === "tool");
    expect([think?.start, think?.end]).toEqual([1500, 20500]);
    expect(think?.segments.some((segment) => segment.kind === "output")).toBe(false);
    expect(write).toMatchObject({ itemId: "tool:write", start: 20600, end: 50400 });
    expect(write?.segments).toEqual([
      { kind: "output", start: 20600, end: 45900 },
      { kind: "queue", start: 45900, end: 46000 },
      { kind: "run", start: 46000, end: 50000 },
    ]);
  });

  it("shows a running file step while the model is still writing the file", () => {
    const run = { ...completedRun, status: "running" as const, updatedAt: at(30000) };
    const steps = executionTimeline(gameRun(30000), run, runStart + 31000)?.steps ?? [];
    expect(steps.find((step) => step.kind === "think")).toMatchObject({
      end: 20500,
      running: false,
    });
    expect(steps.at(-1)).toMatchObject({
      kind: "tool",
      itemId: "tool:write",
      start: 20600,
      end: 31000,
      running: true,
    });
  });

  it("[UI-3] returns nothing for a run without timing events", () => {
    expect(executionTimeline([], completedRun, runStart)).toBeNull();
  });

  it.each([
    [0, "0.0s"],
    [940, "0.9s"],
    [8428, "8.4s"],
    [59960, "1m 00s"],
    [65200, "1m 05s"],
    [3725000, "62m 05s"],
  ])("[UI-3] shows %ims as %s", (milliseconds, text) => {
    expect(timelineDuration(milliseconds)).toBe(text);
  });
});
