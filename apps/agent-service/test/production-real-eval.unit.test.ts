import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProactiveModelInvoker,
  RealEvalRunReport,
  RealEvalTrigger,
} from "@himawari-agent/application";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRealEvalModel,
  dueRealEvalTrigger,
  expireRealEvalSample,
  ProductionRealEval,
  REAL_EVAL_IN_PROGRESS_PREFIX,
  REAL_EVAL_INTERVAL_MS,
  REAL_EVAL_RETRY_MS,
  REAL_EVAL_SAMPLE_FILE,
  RealEvalModelError,
  RealEvalSampleExpiry,
  readUnfinishedRealEvals,
  realEvalSpentMicros,
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
        [
          {
            startedAt: at(-REAL_EVAL_RETRY_MS),
            trigger: "manual",
            outcome: "failed",
            costMicros: 0,
          },
        ],
        NOW,
      ),
    ).toBe("manual");
    expect(
      dueRealEvalTrigger(
        "once",
        [{ startedAt: at(-1000), trigger: "manual", outcome: "failed", costMicros: 0 }],
        NOW,
      ),
    ).toBeNull();
    expect(
      dueRealEvalTrigger(
        "once",
        [
          {
            startedAt: at(-REAL_EVAL_RETRY_MS),
            trigger: "manual",
            outcome: "budget_exceeded",
            costMicros: 0,
          },
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it("runs weekly when no run finished in the last week, retrying a failed one after a day", () => {
    expect(dueRealEvalTrigger("weekly", [], NOW)).toBe("weekly");
    const run = (offsetMs: number, outcome: "completed" | "failed") => ({
      startedAt: at(offsetMs),
      trigger: "weekly" as const,
      outcome,
      costMicros: 0,
    });
    expect(
      dueRealEvalTrigger("weekly", [run(-REAL_EVAL_INTERVAL_MS + 1, "completed")], NOW),
    ).toBeNull();
    expect(dueRealEvalTrigger("weekly", [run(-REAL_EVAL_INTERVAL_MS, "completed")], NOW)).toBe(
      "weekly",
    );
    expect(dueRealEvalTrigger("weekly", [run(-1000, "failed")], NOW)).toBeNull();
    expect(dueRealEvalTrigger("weekly", [run(-REAL_EVAL_RETRY_MS, "failed")], NOW)).toBe("weekly");
  });

  it("adds up what runs started in the last seven days spent", () => {
    const run = (offsetMs: number, costMicros: number) => ({
      startedAt: at(offsetMs),
      trigger: "manual" as const,
      outcome: "failed" as const,
      costMicros,
    });
    expect(
      realEvalSpentMicros(
        [
          run(-1000, 200_000),
          run(-REAL_EVAL_RETRY_MS, 100_000),
          run(-REAL_EVAL_INTERVAL_MS, 400_000),
        ],
        NOW,
      ),
    ).toBe(300_000);
  });
});

describe("[P4-5] real eval sample for the owner's review", () => {
  it("deletes the sample once it is a week old so deleted memories do not linger there", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const file = path.join(directory, REAL_EVAL_SAMPLE_FILE);
    await writeFile(file, "{}\n");
    const written = new Date(Date.parse(NOW) - REAL_EVAL_INTERVAL_MS + 1000);
    await utimes(file, written, written);
    expect(await expireRealEvalSample(directory, NOW)).toBe(false);
    expect(await expireRealEvalSample(directory, at(1000))).toBe(true);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await expireRealEvalSample(directory, at(1000))).toBe(false);
  });

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
    allowedDataClassifications: ["public", "private"],
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

  it("refuses a completed call whose cost is missing or not a whole number", async () => {
    for (const costMicros of [37.5, undefined, -1]) {
      const model = createRealEvalModel({
        modelRef: "eval-model",
        invoker: () =>
          invoker(
            (invocationId) => [
              { type: "model.output", invocationId, payloadRef: "out-1", text: "{}" },
              { type: "model.completed", invocationId, costMicros },
            ],
            [],
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
      ).rejects.toMatchObject({ code: "COST_INVALID" });
    }
  });

  it("still releases the payloads when releasing the call authority fails", async () => {
    const released: string[][] = [];
    const base = invoker(
      (invocationId) => [
        { type: "model.output", invocationId, payloadRef: "out-1", text: "{}" },
        { type: "model.completed", invocationId, costMicros: 1 },
      ],
      released,
    );
    const failing = {
      ...base,
      prepare: async (input: { invocationId: string }) => ({
        ...(await base.prepare(input as never)),
        release: async () => {
          throw new Error("AUTHORITY_RELEASE_FAILED");
        },
      }),
    } as unknown as ProactiveModelInvoker;
    const model = createRealEvalModel({
      modelRef: "eval-model",
      invoker: () => failing,
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
    ).rejects.toThrow("AUTHORITY_RELEASE_FAILED");
    expect(released).toEqual([["input:call-1", "out-1"]]);
  });

  it("estimates input by UTF-8 bytes so a token count cannot exceed it", () => {
    const model = createRealEvalModel({
      modelRef: "eval-model",
      invoker: () => invoker(() => [], []),
      cost,
      requestTimeoutMs: 1_000,
      now: () => NOW,
    });
    expect(model.estimateMicros("燕麦", 100)).toBe(6 * 1 + 200 * 2);
  });
});

describe("[P4-5] real eval timer", () => {
  it("does not touch the store or the model while off, and writes a sample after a manual run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const calls: string[] = [];
    const runs: RealEvalTrigger[] = [];
    const oldRun = {
      id: "old",
      startedAt: at(-REAL_EVAL_RETRY_MS - 1),
      finishedAt: at(-REAL_EVAL_RETRY_MS),
      outcome: "failed" as const,
      trigger: "manual" as const,
      model: "eval-model",
      costMicros: 120_000,
      summary: {},
    };
    let spent = [oldRun];
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
            return spent;
          },
        },
        service: {
          run: async (trigger, limits) => {
            runs.push(trigger);
            expect(limits).toMatchObject({ capMicros: 500_000 - 120_000, sampleSize: 30 });
            const report = {
              runId: "run-1",
              outcome: "completed" as const,
              costMicros: 1,
              summary: {},
              sample: [],
            };
            await limits.writeSample?.(report);
            return report;
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
    spent = [{ ...oldRun, costMicros: 500_000 }];
    await make("once").tick();
    expect(runs).toEqual(["manual"]);
  });

  it("starts only one run when ticks overlap", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const timer = new ProductionRealEval({
      configuration: {
        mode: "weekly",
        modelRef: "eval-model",
        weeklyCapMicros: 500_000,
        newMemoriesPerRun: 10,
        requestTimeoutMs: 1_000,
      },
      scope: { ownerId: "owner", agentId: "agent" } as never,
      store: { listRuns: async () => [] },
      service: {
        run: async () => {
          started += 1;
          await gate;
          return { runId: "run-1", outcome: "completed", costMicros: 1, summary: {}, sample: [] };
        },
      },
      sampleDirectory: path.join(directory, "real-eval"),
      now: () => NOW,
    });
    const first = timer.tick();
    const second = timer.tick();
    expect(second).toBe(first);
    release();
    await first;
    expect(started).toBe(1);
  });
});

describe("[P4-5] real eval leftovers", () => {
  const configuration = {
    mode: "weekly" as const,
    modelRef: "eval-model",
    weeklyCapMicros: 500_000,
    newMemoriesPerRun: 10,
    requestTimeoutMs: 1_000,
  };

  it("removes leftover temporary sample files and keeps running when the cleanup fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    await writeFile(path.join(directory, `${REAL_EVAL_SAMPLE_FILE}.run-0.tmp`), "{}");
    expect(await expireRealEvalSample(directory, NOW)).toBe(false);
    expect(await readdir(directory)).toEqual([]);

    const stuck = path.join(directory, REAL_EVAL_SAMPLE_FILE);
    await mkdir(path.join(stuck, "inside"), { recursive: true });
    const old = new Date(Date.parse(NOW) - REAL_EVAL_INTERVAL_MS);
    await utimes(stuck, old, old);
    const failures: unknown[] = [];
    let ran = 0;
    await new ProductionRealEval({
      configuration,
      scope: { ownerId: "owner", agentId: "agent" } as never,
      store: { listRuns: async () => [] },
      service: {
        run: async () => {
          ran += 1;
          return { runId: "run-1", outcome: "completed", costMicros: 1, summary: {}, sample: [] };
        },
      },
      sampleDirectory: directory,
      now: () => NOW,
      onFailure: (error) => failures.push(error),
    }).tick();
    expect(failures).toHaveLength(1);
    expect(ran).toBe(1);
  });

  it("counts a run that never got recorded as having spent its whole allowance", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const limits: number[] = [];
    let recordFails = true;
    const timer = new ProductionRealEval({
      configuration,
      scope: { ownerId: "owner", agentId: "agent" } as never,
      store: { listRuns: async () => [] },
      service: {
        run: async (_trigger, input) => {
          limits.push(input.capMicros);
          if (recordFails) throw new Error("SQLITE_FULL");
          return { runId: "run-2", outcome: "completed", costMicros: 1, summary: {}, sample: [] };
        },
      },
      sampleDirectory: directory,
      now: () => NOW,
      onFailure: () => undefined,
    });
    await timer.tick();
    const markers = await readdir(directory);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.startsWith(REAL_EVAL_IN_PROGRESS_PREFIX)).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(directory, markers[0] ?? ""), "utf8")),
    ).toMatchObject({
      startedAt: NOW,
      trigger: "weekly",
      capMicros: 500_000,
    });
    await timer.tick();
    expect(limits).toEqual([500_000]);

    recordFails = false;
    const later = new ProductionRealEval({
      configuration,
      scope: { ownerId: "owner", agentId: "agent" } as never,
      store: { listRuns: async () => [] },
      service: {
        run: async (_trigger, input) => {
          limits.push(input.capMicros);
          return { runId: "run-3", outcome: "completed", costMicros: 1, summary: {}, sample: [] };
        },
      },
      sampleDirectory: directory,
      now: () => at(REAL_EVAL_INTERVAL_MS),
    });
    await later.tick();
    expect(limits).toEqual([500_000, 500_000]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("counts an unreadable marker as a run that spent the whole weekly cap", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const limits: number[] = [];
    const timer = (now: string) =>
      new ProductionRealEval({
        configuration,
        scope: { ownerId: "owner", agentId: "agent" } as never,
        store: { listRuns: async () => [] },
        service: {
          run: async (_trigger, input) => {
            limits.push(input.capMicros);
            return { runId: "run-1", outcome: "completed", costMicros: 1, summary: {}, sample: [] };
          },
        },
        sampleDirectory: directory,
        now: () => now,
      });
    for (const text of [
      '{"startedAt":',
      '{"startedAt":"2026-11-08","trigger":"weekly","capMicros":5}',
      '{"startedAt":"2026-11-08T00:00:00.000Z","trigger":"weekly","capMicros":-5}',
    ]) {
      const file = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}${text.length}.json`);
      await writeFile(file, text);
      const written = new Date(Date.parse(NOW) - REAL_EVAL_RETRY_MS);
      await utimes(file, written, written);
    }
    await timer(NOW).tick();
    expect(limits).toEqual([]);
    await timer(at(REAL_EVAL_INTERVAL_MS - REAL_EVAL_RETRY_MS)).tick();
    expect(limits).toEqual([500_000]);
    expect(
      (await readdir(directory)).filter((name) => name.startsWith(REAL_EVAL_IN_PROGRESS_PREFIX)),
    ).toEqual([]);
  });

  it("counts a marker with no allowance as having spent the whole weekly cap", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const file = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}zero.json`);
    await writeFile(
      file,
      JSON.stringify({
        runId: "run-zero",
        startedAt: at(-REAL_EVAL_RETRY_MS),
        trigger: "weekly",
        capMicros: 0,
      }),
    );
    const written = new Date(Date.parse(NOW) - REAL_EVAL_RETRY_MS);
    await utimes(file, written, written);
    expect(await readUnfinishedRealEvals(directory, NOW, 500_000)).toEqual([
      {
        startedAt: written.toISOString(),
        trigger: "weekly",
        outcome: "failed",
        costMicros: 500_000,
      },
    ]);
  });

  it("counts a marker it cannot read as spent and still checks the rest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const stuck = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}stuck.json`);
    await mkdir(stuck);
    const written = new Date(Date.parse(NOW) - REAL_EVAL_RETRY_MS);
    await utimes(stuck, written, written);
    const fine = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}zz.json`);
    await writeFile(
      fine,
      JSON.stringify({
        runId: "run-fine",
        startedAt: at(-REAL_EVAL_RETRY_MS),
        trigger: "weekly",
        capMicros: 7,
      }),
    );
    expect(await readUnfinishedRealEvals(directory, NOW, 500_000)).toEqual([
      {
        startedAt: written.toISOString(),
        trigger: "weekly",
        outcome: "failed",
        costMicros: 500_000,
      },
      { startedAt: at(-REAL_EVAL_RETRY_MS), trigger: "weekly", outcome: "failed", costMicros: 7 },
    ]);
    expect(await readUnfinishedRealEvals(directory, at(REAL_EVAL_INTERVAL_MS), 500_000)).toEqual(
      [],
    );
  });

  it("keeps the marker of an earlier unfinished run when a new run starts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const limits: number[] = [];
    const timer = (now: string) =>
      new ProductionRealEval({
        configuration,
        scope: { ownerId: "owner", agentId: "agent" } as never,
        store: { listRuns: async () => [] },
        service: {
          run: async (_trigger, input) => {
            limits.push(input.capMicros);
            throw new Error("SQLITE_FULL");
          },
        },
        sampleDirectory: directory,
        now: () => now,
        onFailure: () => undefined,
      });
    const earlier = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}earlier.json`);
    await writeFile(
      earlier,
      JSON.stringify({
        runId: "run-earlier",
        startedAt: at(-2 * REAL_EVAL_RETRY_MS),
        trigger: "weekly",
        capMicros: 200_000,
      }),
    );
    await timer(NOW).tick();
    await timer(at(REAL_EVAL_RETRY_MS)).tick();
    expect(limits).toEqual([300_000]);
    expect(await readdir(directory)).toHaveLength(2);
  });

  it("drops the marker of a run the database already recorded", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const marker = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}recorded.json`);
    await writeFile(
      marker,
      JSON.stringify({
        runId: "run-recorded",
        startedAt: at(-2 * REAL_EVAL_RETRY_MS),
        trigger: "weekly",
        capMicros: 500_000,
      }),
    );
    const limits: number[] = [];
    const runIds: (string | undefined)[] = [];
    await new ProductionRealEval({
      configuration,
      scope: { ownerId: "owner", agentId: "agent" } as never,
      store: {
        listRuns: async () => [
          {
            id: "run-recorded",
            startedAt: at(-2 * REAL_EVAL_RETRY_MS),
            finishedAt: at(-2 * REAL_EVAL_RETRY_MS),
            outcome: "failed" as const,
            trigger: "weekly" as const,
            model: "eval-model",
            costMicros: 100_000,
            summary: {},
          },
        ],
      },
      service: {
        run: async (_trigger, input) => {
          limits.push(input.capMicros);
          runIds.push(input.runId);
          return { runId: "run-2", outcome: "completed", costMicros: 1, summary: {}, sample: [] };
        },
      },
      sampleDirectory: directory,
      now: () => NOW,
    }).tick();
    expect(limits).toEqual([400_000]);
    expect(runIds[0]).toMatch(/^real-eval-run:/u);
    expect(await readdir(directory)).toEqual([]);
  });

  it("treats a marker dated in the future as unreadable and lets it expire", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const marker = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}future.json`);
    await writeFile(
      marker,
      JSON.stringify({
        runId: "run-future",
        startedAt: at(365 * REAL_EVAL_INTERVAL_MS),
        trigger: "weekly",
        capMicros: 1,
      }),
    );
    const future = new Date(Date.parse(NOW) + 365 * REAL_EVAL_INTERVAL_MS);
    await utimes(marker, future, future);
    const limits: number[] = [];
    const tick = (now: string) =>
      new ProductionRealEval({
        configuration,
        scope: { ownerId: "owner", agentId: "agent" } as never,
        store: { listRuns: async () => [] },
        service: {
          run: async (_trigger, input) => {
            limits.push(input.capMicros);
            return { runId: "run-2", outcome: "completed", costMicros: 1, summary: {}, sample: [] };
          },
        },
        sampleDirectory: directory,
        now: () => now,
      }).tick();
    await tick(at(2 * REAL_EVAL_RETRY_MS));
    expect(limits).toEqual([]);
    await tick(at(2 * REAL_EVAL_RETRY_MS + REAL_EVAL_INTERVAL_MS - 1));
    expect(limits).toEqual([]);
    await tick(at(2 * REAL_EVAL_RETRY_MS + REAL_EVAL_INTERVAL_MS));
    expect(limits).toEqual([500_000]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes week-old markers while the evaluation is off", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const old = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}old.json`);
    const fresh = path.join(directory, `${REAL_EVAL_IN_PROGRESS_PREFIX}fresh.json`);
    await writeFile(old, "{");
    await writeFile(fresh, "{");
    const written = new Date(Date.parse(NOW) - REAL_EVAL_INTERVAL_MS);
    await utimes(old, written, written);
    const expiry = new RealEvalSampleExpiry({ directory, now: () => NOW });
    expiry.start();
    await expiry.stop();
    await vi.waitFor(async () => {
      expect(await readdir(directory)).toEqual([path.basename(fresh)]);
    });
  });

  it("lets a sample whose time is in the future expire a week after it was first seen", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    const file = path.join(directory, REAL_EVAL_SAMPLE_FILE);
    await writeFile(file, "{}\n");
    const future = new Date(Date.parse(NOW) + 365 * REAL_EVAL_INTERVAL_MS);
    await utimes(file, future, future);
    expect(await expireRealEvalSample(directory, NOW)).toBe(false);
    expect(await expireRealEvalSample(directory, at(REAL_EVAL_INTERVAL_MS - 1))).toBe(false);
    expect(await expireRealEvalSample(directory, at(REAL_EVAL_INTERVAL_MS))).toBe(true);
  });

  it("keeps expiring the sample while the evaluation is off", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, REAL_EVAL_SAMPLE_FILE);
    await writeFile(file, "{}\n");
    const written = new Date(Date.parse(NOW) - REAL_EVAL_INTERVAL_MS);
    await utimes(file, written, written);
    const expiry = new RealEvalSampleExpiry({ directory, now: () => NOW });
    expiry.start();
    await expiry.stop();
    await vi.waitFor(async () => {
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
