import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendHistory,
  compare,
  readHistory,
  renderTrend,
  summarize,
  validateRecord,
} from "../../scripts/jarvis-test/history.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SCENARIOS = ["memory_correction", "state_discipline", "failure_transparency"];

function record({
  passing = 6,
  datasetVersion = "jarvis-test-2026-10-28.1",
  decision = true,
} = {}) {
  return {
    schemaVersion: 1,
    runAt: "2026-11-02T00:30:00.000Z",
    commit: "0123456789abcdef",
    datasetVersion,
    calibrationVersion: "jarvis-judge-calibration-2026-10-28.1",
    graderCalibrated: false,
    trials: 3,
    models: {
      subject: { id: "deepseek/deepseek-v4.1-flash", version: "catalog-2026-10-06" },
      decisionJudge: decision ? { id: "typesafe-ai/jev", version: "jev-2026-09" } : null,
      reasoningJudge: { id: "fixture/reasoning", version: "v1" },
    },
    judgeMode: decision ? "two_tier" : "reasoning_only",
    tokens: { subject: 120000, judge: 9000 },
    tokenLimit: 2000000,
    costMicros: null,
    stoppedByLimit: false,
    cases: SCENARIOS.flatMap((scenario, scenarioIndex) =>
      Array.from({ length: 6 }, (_, index) => ({
        id: `${scenarioIndex}-${index}`,
        scenario,
        trials: index < passing ? [true, true, true] : [true, false, true],
        jev_probability: decision ? 0.9 : null,
        judge_tier: decision ? "decision" : "reasoning_only",
      })),
    ),
  };
}

describe("Jarvis Test score history", () => {
  it("summarizes and renders the proactive next-step scenario, and rejects a scenario it does not know", () => {
    const base = record();
    const proactive = {
      ...base,
      cases: [
        ...base.cases,
        {
          id: "9a",
          scenario: "proactive_next_step",
          trials: [true, true, false],
          jev_probability: 0.8,
          judge_tier: "decision",
        },
      ],
    };
    expect(() => validateRecord(proactive)).not.toThrow();
    expect(summarize(proactive).proactive_next_step).toMatchObject({ cases: 1, passAll: 0 });
    expect(renderTrend([proactive])).toContain("#9 主动提下一步  3 次全过 0/1");
    const unknown = {
      ...base,
      cases: [...base.cases, { ...proactive.cases.at(-1), scenario: "not_a_scenario" }],
    };
    expect(() => validateRecord(unknown)).toThrow();
  });

  it("rejects records whose models are not pinned or whose judge mode disagrees", () => {
    const unpinned = record();
    unpinned.models.subject = { id: "deepseek/deepseek-v4.1-flash", version: "" };
    expect(() => validateRecord(unpinned)).toThrow("models.subject");
    const mismatch = record();
    mismatch.judgeMode = "reasoning_only";
    expect(() => validateRecord(mismatch)).toThrow("judgeMode");
    const badTier = record();
    badTier.cases[0].judge_tier = "guess";
    expect(() => validateRecord(badTier)).toThrow("judge_tier");
  });

  it("appends one line per run and reads it back", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "himawari-jarvis-history-"));
    roots.push(root);
    const file = path.join(root, "history.jsonl");
    expect(await readHistory(file)).toEqual([]);
    await appendHistory(file, record());
    await appendHistory(file, record({ passing: 5 }));
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(
      (await readHistory(file)).map((item) => summarize(item).memory_correction.passAll),
    ).toEqual([6, 5]);
  });

  it("reports the all-trials rate, the single-trial rate and the mean decision probability", () => {
    expect(summarize(record({ passing: 4 })).state_discipline).toEqual({
      cases: 6,
      passAll: 4,
      passAt1: 16 / 18,
      jevMeanProbability: 0.9,
    });
    expect(summarize(record({ decision: false })).state_discipline.jevMeanProbability).toBeNull();
  });

  it("flags a drop only when at least two cases stop passing", () => {
    expect(compare(record(), record({ passing: 5 })).memory_correction).toBe("wobble");
    expect(compare(record(), record({ passing: 4 })).memory_correction).toBe("drop");
    expect(compare(record({ passing: 4 }), record()).memory_correction).toBe("rise");
    expect(compare(undefined, record()).memory_correction).toBe("first");
    expect(
      compare(record(), record({ passing: 2, datasetVersion: "jarvis-test-next" }))
        .memory_correction,
    ).toBe("dataset_changed");
  });

  it("renders times in JST and marks the uncalibrated first round", () => {
    const text = renderTrend([record(), record({ passing: 4 })]);
    expect(text).toContain("2026-11-02 09:30 JST");
    expect(text).toContain("校准前");
    expect(text).toContain("3 次全过 4/6");
    expect(text).toContain("▼ 下降");
    expect(text).toContain("费用 未测量");
  });

  it("explains an empty history instead of printing a blank trend", () => {
    expect(renderTrend([])).toContain("还没有真模型评测记录");
  });

  it("prints every committed round from the npm script", () => {
    const output = execFileSync(process.execPath, ["scripts/jarvis-test/trend.mjs"], {
      encoding: "utf8",
    });
    const rounds = readFileSync("evals/jarvis-test/history.jsonl", "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(rounds.length).toBeGreaterThan(0);
    for (const round of rounds) expect(output).toContain(`提交 ${round.commit.slice(0, 7)}`);
  });

  it("refuses a live round when no gateway key can reach the request", () => {
    const environment = { PATH: process.env.PATH ?? "" };
    const result = spawnSync(
      process.execPath,
      ["scripts/jarvis-test/live.mjs", "--confirm-cost=1"],
      { encoding: "utf8", env: environment },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("JARVIS_LIVE_KEY_REQUIRED");
    const unknown = spawnSync(process.execPath, ["scripts/jarvis-test/live.mjs", "--trails=1"], {
      encoding: "utf8",
      env: environment,
    });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("JARVIS_LIVE_UNKNOWN_OPTION");
  });

  it("refuses a live round until a spending cap is confirmed", () => {
    const environment = { PATH: process.env.PATH ?? "", AI_GATEWAY_API_KEY: "unused" };
    for (const options of [[], ["--confirm-cost=0"], ["--confirm-cost=abc"], ["--trials=1"]]) {
      const result = spawnSync(process.execPath, ["scripts/jarvis-test/live.mjs", ...options], {
        encoding: "utf8",
        env: environment,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("JARVIS_LIVE_COST_APPROVAL_REQUIRED");
      expect(result.stderr).toContain("美元");
    }
  });

  it("refuses a live round when the gateway already rejects a one-token request", async () => {
    const refusal = JSON.stringify({
      error: {
        message: "User budget exceeded. Current spend: $3.16, limit: $3.00.",
        type: "quota_for_entity_exceeded",
      },
    });
    const server = http.createServer((_request, response) => {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(refusal);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address();
      const result = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          ["scripts/jarvis-test/live.mjs", "--confirm-cost=1"],
          {
            env: {
              PATH: process.env.PATH ?? "",
              AI_GATEWAY_API_KEY: "unused",
              HIMAWARI_JARVIS_PREFLIGHT_URL: `http://127.0.0.1:${port}/v1`,
            },
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (status) => resolve({ status, stderr }));
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("JARVIS_LIVE_GATEWAY_REFUSED");
      expect(result.stderr).toContain("HTTP 402");
      expect(result.stderr).toContain("User budget exceeded");
    } finally {
      server.close();
    }
  });
});
