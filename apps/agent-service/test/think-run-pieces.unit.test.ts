import { parseThinkRunAnswer, readOnlyRow } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import { ThinkLoop } from "../src/production-think-composition.ts";
import {
  PRODUCTION_TOOL_ACTION_ROWS,
  productionToolActionRegistry,
} from "../src/production-tool-actions.ts";

describe("think run pieces", () => {
  it("offers a think run only tools that read and change nothing", () => {
    const registry = productionToolActionRegistry();
    const descriptors = PRODUCTION_TOOL_ACTION_ROWS.filter((row) => !row.toolIsPrefix).map(
      (row) => ({
        name: row.tool,
        capabilityRef: row.capabilityRef ?? row.tool,
        capabilityHandleRef: null,
        description: "x",
        parameters: {},
      }),
    );
    const all = registry.offer(descriptors).map((item) => item.name);
    const readOnly = registry.offer(descriptors, { readOnly: true }).map((item) => item.name);
    expect(readOnly.length).toBeGreaterThan(0);
    expect(readOnly.length).toBeLessThan(all.length);
    for (const name of readOnly) {
      const row = registry.forTool(name);
      expect(row && readOnlyRow(row)).toBe(true);
      expect(row?.actionKind).toBe("READ");
      expect(row?.sideEffect).toBe("none");
    }
    for (const name of all.filter((item) => !readOnly.includes(item)))
      expect(readOnlyRow(registry.forTool(name) as never)).toBe(false);
    expect([...readOnly].sort()).toEqual([
      "conversation_open",
      "conversation_search",
      "memory_open",
      "perception_read",
      "recall",
      "reminder_list",
      "rule_list",
      "tool_result_recall",
      "web_fetch",
      "web_search",
    ]);
    for (const name of ["reminder_set", "rule_set", "bash", "write", "device_action"])
      expect(readOnly).not.toContain(name);
  });

  it("accepts only the agreed JSON answer", () => {
    expect(
      parseThinkRunAnswer('```json\n{"action":"task.run","reason":"要回复","text":"回复"}\n```'),
    ).toEqual({ action: "task.run", reason: "要回复", fields: { text: "回复" } });
    expect(parseThinkRunAnswer('{"action":"none","reason":"不用管"}')).toMatchObject({
      action: "none",
    });
    for (const raw of [
      "我觉得要回复",
      '好的 {"action":"none","reason":"x"}',
      '{"action":"none"}',
      '{"action":"none","reason":"  "}',
      '{"action":"Send Mail","reason":"x"}',
      '{"action":"none","reason":"x"',
      '["none"]',
      `{"action":"none","reason":"${"长".repeat(501)}"}`,
      `{"action":"none","reason":"x","pad":"${"x".repeat(17000)}"}`,
      42,
    ])
      expect(parseThinkRunAnswer(raw)).toBeUndefined();
  });

  it("keeps working while there is work, waits when idle, and stops cleanly", async () => {
    const steps: string[] = [];
    let queue = 2;
    let resolveIdle: () => void = () => undefined;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    const loop = new ThinkLoop({
      worker: {
        runOnce: async () => {
          if (queue > 0) {
            queue -= 1;
            steps.push("done");
            return { status: "done" } as never;
          }
          steps.push("idle");
          resolveIdle();
          return { status: "idle" };
        },
      },
      intervalMs: 60_000,
      onFailure: () => undefined,
    });
    loop.start();
    await idle;
    await loop.stop();
    expect(steps).toEqual(["done", "done", "idle"]);
  });

  it("reports a throwing step and keeps the loop alive", async () => {
    const failures: unknown[] = [];
    let calls = 0;
    let resolveSecond: () => void = () => undefined;
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const loop = new ThinkLoop({
      worker: {
        runOnce: async () => {
          calls += 1;
          if (calls === 1) throw new Error("boom");
          resolveSecond();
          return { status: "idle" };
        },
      },
      intervalMs: 1,
      onFailure: (error) => failures.push(error),
    });
    loop.start();
    await second;
    await loop.stop();
    expect(failures).toHaveLength(1);
  });

  it("keeps the loop alive when reporting a failure throws", async () => {
    let calls = 0;
    let resolveSecond: () => void = () => undefined;
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const loop = new ThinkLoop({
      worker: {
        runOnce: async () => {
          calls += 1;
          if (calls === 1) throw new Error("boom");
          resolveSecond();
          return { status: "idle" };
        },
      },
      intervalMs: 1,
      onFailure: () => {
        throw new Error("diagnostic output closed");
      },
    });
    loop.start();
    await second;
    await loop.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
