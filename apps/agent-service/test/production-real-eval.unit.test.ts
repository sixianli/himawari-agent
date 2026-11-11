import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProactiveModelInvoker,
  RealEvalRunReport,
  RealEvalTrigger,
} from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRealEvalModel,
  dueRealEvalTrigger,
  ProductionRealEval,
  REAL_EVAL_INTERVAL_MS,
  REAL_EVAL_SAMPLE_FILE,
  RealEvalModelError,
  writeRealEvalSample,
} from "../src/production-real-eval.js";

const NOW = "2026-11-11T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();

describe("[P4-5] when the real memory eval runs", () => {
  it("never runs while off", () => {
    expect(dueRealEvalTrigger("off", [], NOW)).toBeNull();
  });

  it("runs once by hand until a manual run has finished without failing", () => {
    expect(dueRealEvalTrigger("once", [], NOW)).toBe("manual");
    expect(
      dueRealEvalTrigger(
        "once",
        [{ startedAt: at(-1000), trigger: "manual", outcome: "failed" }],
        NOW,
      ),
    ).toBe("manual");
    expect(
      dueRealEvalTrigger(
        "once",
        [{ startedAt: at(-1000), trigger: "manual", outcome: "budget_exceeded" }],
        NOW,
      ),
    ).toBeNull();
  });

  it("runs weekly only when the newest run is at least a week old", () => {
    expect(dueRealEvalTrigger("weekly", [], NOW)).toBe("weekly");
    const recent = [
      {
        startedAt: at(-REAL_EVAL_INTERVAL_MS + 1),
        trigger: "weekly" as const,
        outcome: "completed" as const,
      },
    ];
    expect(dueRealEvalTrigger("weekly", recent, NOW)).toBeNull();
    const old = [
      {
        startedAt: at(-REAL_EVAL_INTERVAL_MS),
        trigger: "manual" as const,
        outcome: "completed" as const,
      },
    ];
    expect(dueRealEvalTrigger("weekly", old, NOW)).toBe("weekly");
  });
});

describe("[P4-5] real eval sample for the owner's review", () => {
  it("masks sensitive values and keeps the file private to the service user", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const report: RealEvalRunReport = {
      runId: "run-1",
      outcome: "completed",
      costMicros: 120,
      summary: {},
      sample: [
        {
          panel: "fresh",
          kind: "fact",
          question: "我常用哪张卡？",
          response: "你常用 4111111111111111 这张卡。",
          verdict: "correct",
          quote: "我常用的卡号是 4111111111111111",
          memory: "主人常用的银行卡是 4111111111111111",
        },
      ],
    };
    const file = await writeRealEvalSample(path.join(directory, "real-eval"), report);
    expect(path.basename(file)).toBe(REAL_EVAL_SAMPLE_FILE);
    const body = await readFile(file, "utf8");
    expect(body).not.toContain("4111111111111111");
    expect(JSON.parse(body)).toMatchObject({
      runId: "run-1",
      items: [{ verdict: "correct", question: "我常用哪张卡？" }],
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(directory, "real-eval"))).mode & 0o777).toBe(0o700);
  });
});

function invoker(
  events: (invocationId: string) => readonly Record<string, unknown>[],
  released: string[][],
): ProactiveModelInvoker {
  const outputs = new Map<string, string>();
  return {
    modelRef: "eval-model",
    model: {
      async *invoke(request: { invocationId: string }) {
        for (const event of events(request.invocationId)) {
          if (event["type"] === "model.output")
            outputs.set(String(event["payloadRef"]), String(event["text"]));
          yield event;
        }
      },
    },
    async prepare({ invocationId }: { invocationId: string }) {
      return {
        runId: `proactive:${invocationId}`,
        inputRef: `input:${invocationId}`,
        allowedDisclosureRef: `input:${invocationId}`,
        secretHandleRefs: [],
        release: async () => undefined,
      };
    },
    readOutput: async (ref: string) => outputs.get(ref) ?? "",
    release: async (refs: readonly string[]) => {
      released.push([...refs]);
    },
  } as unknown as ProactiveModelInvoker;
}

describe("[P4-5] real eval model calls", () => {
  const cost = { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 };

  it("returns the text and actual cost and releases every payload", async () => {
    const released: string[][] = [];
    const limits: number[] = [];
    const model = createRealEvalModel({
      modelRef: "eval-model",
      invoker: (maxOutputTokens) => {
        limits.push(maxOutputTokens);
        return invoker(
          (invocationId) => [
            { type: "model.output", invocationId, payloadRef: "out-1", text: '{"verdict":' },
            { type: "model.output", invocationId, payloadRef: "out-2", text: '"correct"}' },
            { type: "model.completed", invocationId, costMicros: 37, outputTokens: 5 },
          ],
          released,
        );
      },
      cost,
      requestTimeoutMs: 1_000,
      now: () => NOW,
    });
    const result = await model.generate({
      invocationId: "call-1",
      prompt: "judge",
      maxOutputTokens: 100,
      dataClassification: "private",
    });
    await model.generate({
      invocationId: "call-2",
      prompt: "judge",
      maxOutputTokens: 100,
      dataClassification: "private",
    });
    expect(result).toEqual({ output: '{"verdict":"correct"}', costMicros: 37 });
    expect(released[0]).toEqual(["input:call-1", "out-1", "out-2"]);
    expect(limits).toEqual([100]);
    expect(model.estimateMicros("abcd", 100)).toBe(4 * 1 + 200 * 2);
  });

  it("throws a coded error when the model call fails", async () => {
    const released: string[][] = [];
    const model = createRealEvalModel({
      modelRef: "eval-model",
      invoker: () =>
        invoker(
          (invocationId) => [{ type: "model.failed", invocationId, errorCode: "RATE_LIMITED" }],
          released,
        ),
      cost,
      requestTimeoutMs: 1_000,
      now: () => NOW,
    });
    await expect(
      model.generate({
        invocationId: "call-1",
        prompt: "judge",
        maxOutputTokens: 100,
        dataClassification: "private",
      }),
    ).rejects.toBeInstanceOf(RealEvalModelError);
    expect(released).toEqual([["input:call-1"]]);
  });
});

describe("[P4-5] real eval timer", () => {
  it("does not touch the store or the model while off, and writes a sample after a manual run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const calls: string[] = [];
    const runs: RealEvalTrigger[] = [];
    const make = (mode: "off" | "once") =>
      new ProductionRealEval({
        configuration: {
          mode,
          modelRef: "eval-model",
          weeklyCapMicros: 500_000,
          newMemoriesPerRun: 10,
          requestTimeoutMs: 1_000,
        },
        scope: { ownerId: "owner", agentId: "agent" } as never,
        store: {
          listRuns: async () => {
            calls.push("listRuns");
            return [];
          },
        },
        service: {
          run: async (trigger, limits) => {
            runs.push(trigger);
            expect(limits).toMatchObject({ capMicros: 500_000, sampleSize: 30 });
            return { runId: "run-1", outcome: "completed", costMicros: 1, summary: {}, sample: [] };
          },
        },
        sampleDirectory: path.join(directory, "real-eval"),
        now: () => NOW,
      });
    const off = make("off");
    off.start();
    await off.stop();
    expect(calls).toEqual([]);
    await make("once").tick();
    expect(runs).toEqual(["manual"]);
    expect(
      JSON.parse(await readFile(path.join(directory, "real-eval", REAL_EVAL_SAMPLE_FILE), "utf8")),
    ).toMatchObject({ runId: "run-1", items: [] });
  });
});
