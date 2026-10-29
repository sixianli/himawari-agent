import { describe, expect, it } from "vitest";
import { stageTiming } from "../src/production-stage-timing.js";

describe("[TG-1] tool stage timing line", () => {
  it("writes one line with the time spent in each stage since the previous mark", () => {
    const lines: string[] = [];
    const clock = [100, 130, 180, 180, 260, 400];
    const timing = stageTiming(
      "tool.dispatch.timing",
      { runId: "run:a", toolCallId: "call-1" },
      (line) => lines.push(line),
      () => clock.shift() ?? 400,
    );
    timing.mark("validate");
    timing.mark("dispatch");
    timing.mark("validate");
    timing.finish("result_write");
    timing.finish("again");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "tool.dispatch.timing",
      runId: "run:a",
      toolCallId: "call-1",
      stages: { validate: 30, dispatch: 50, result_write: 80 },
      totalMs: 300,
    });
  });
});
