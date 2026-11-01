import { describe, expect, it } from "vitest";
import { COMMAND_SILENCE_MS, CommandSilenceWatch } from "../src/command-silence-watch.ts";

const TICK = 5_000;

function ticks(watch: CommandSilenceWatch, from: number, to: number) {
  for (let at = from; at <= to; at += TICK) watch.check(at);
}

function harness() {
  const silent: Array<{ runId: string; silentMs: number }> = [];
  const resumed: Array<{ runId: string; silentMs: number }> = [];
  const watch = new CommandSilenceWatch({
    onSilent: (detail) => silent.push(detail),
    onResumed: (detail) => resumed.push(detail),
  });
  return { watch, silent, resumed };
}

describe("[SILENCE-1] a running command with no contact for the silence window is logged once", () => {
  it("reports a command that stops polling, and only once", () => {
    const { watch, silent } = harness();
    watch.observe("a", "run-a", true, 0);
    ticks(watch, 5_000, COMMAND_SILENCE_MS - TICK);
    expect(silent).toEqual([]);
    ticks(watch, COMMAND_SILENCE_MS, COMMAND_SILENCE_MS + 2 * TICK);
    expect(silent).toEqual([{ runId: "run-a", silentMs: COMMAND_SILENCE_MS }]);
  });

  it("reports resumption with how long it was silent", () => {
    const { watch, silent, resumed } = harness();
    watch.observe("a", "run-a", true, 0);
    ticks(watch, 5_000, COMMAND_SILENCE_MS);
    watch.observe("a", "run-a", true, COMMAND_SILENCE_MS + 2_000);
    expect(silent).toHaveLength(1);
    expect(resumed).toEqual([{ runId: "run-a", silentMs: COMMAND_SILENCE_MS + 2_000 }]);
  });
});

describe("[SILENCE-2] negative: healthy or finished commands are never reported", () => {
  it("a command polling every 250 ms is never reported", () => {
    const { watch, silent } = harness();
    for (let at = 0; at <= 120_000; at += 250) {
      watch.observe("a", "run-a", true, at);
      if (at % 5_000 === 0) watch.check(at);
    }
    expect(silent).toEqual([]);
  });

  it("a command that finished (no longer running) is forgotten, not reported", () => {
    const { watch, silent } = harness();
    watch.observe("a", "run-a", true, 0);
    watch.observe("a", "run-a", false, 1_000);
    ticks(watch, 5_000, COMMAND_SILENCE_MS * 3);
    expect(silent).toEqual([]);
    expect(watch.size()).toBe(0);
  });

  it("slow but alive polling (every 20 s) is not reported", () => {
    const { watch, silent } = harness();
    for (let at = 0; at <= 200_000; at += TICK) {
      if (at % 20_000 === 0) watch.observe("a", "run-a", true, at);
      watch.check(at);
    }
    expect(silent).toEqual([]);
  });
});

describe("[SILENCE-3] negative: a lagging agent-service loop is not blamed on the worker", () => {
  it("when the check itself runs far later than scheduled, silence is re-measured from now", () => {
    const { watch, silent } = harness();
    watch.observe("a", "run-a", true, 0);
    watch.check(5_000);
    watch.check(5_000 + 60_000);
    expect(silent).toEqual([]);
    ticks(watch, 70_000, 65_000 + COMMAND_SILENCE_MS - TICK);
    expect(silent).toEqual([]);
    ticks(watch, 65_000 + COMMAND_SILENCE_MS, 65_000 + COMMAND_SILENCE_MS);
    expect(silent).toHaveLength(1);
  });
});
