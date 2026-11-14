import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { beforeAll, describe, expect, it } from "vitest";
import { appendHistory } from "../../../scripts/jarvis-test/history.mjs";
import { useSqliteContractExecution } from "../sqlite-contract-execution.fixture.ts";
import { type JarvisCase, loadCalibration, loadDataset } from "./cases.ts";
import { gatewayDecisionJudge, gatewayReasoningJudge, type JudgeUsage } from "./gateway-judges.ts";
import { gradeTrial, type TrialGrade } from "./grade.ts";
import { calibrateDecisionJudge, calibrateReasoningJudge, type RuleVerdict } from "./judge.ts";
import { runTrial, SUBJECT_MODEL, type TrialResult, type TrialUsage } from "./live-harness.ts";

interface LiveEnvironment {
  readonly HIMAWARI_JARVIS_LIVE?: string;
  readonly HIMAWARI_JARVIS_CASES?: string;
  readonly HIMAWARI_JARVIS_TRIALS?: string;
  readonly HIMAWARI_JARVIS_TOKEN_LIMIT?: string;
  readonly HIMAWARI_JARVIS_CALIBRATED?: string;
  readonly HIMAWARI_JARVIS_RECORD?: string;
  readonly HIMAWARI_JARVIS_OUTPUT?: string;
  readonly HIMAWARI_JARVIS_COST_LIMIT_MICROS?: string;
  readonly AI_GATEWAY_API_KEY?: string;
}

const environment = process.env as unknown as LiveEnvironment;
const LIVE = environment.HIMAWARI_JARVIS_LIVE === "1";
const DEFAULT_TOKEN_LIMIT = 2_500_000;
const PARALLEL_CASES = 3;
const ROUND_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const PROXY_INJECTED_KEY = "proxy-injected";

interface CaseOutcome {
  readonly item: JarvisCase;
  readonly trials: {
    readonly result: TrialResult | null;
    readonly grade: TrialGrade | null;
    readonly durationMs: number | null;
  }[];
}

function judgeTier(verdicts: readonly RuleVerdict[], judged: boolean) {
  if (!judged) return "code_only" as const;
  if (verdicts.some(({ tier }) => tier === "reasoning_only")) return "reasoning_only" as const;
  if (verdicts.some(({ tier }) => tier === "escalated")) return "escalated" as const;
  return "decision" as const;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size)
    results.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  return results;
}

describe.skipIf(!LIVE)("Jarvis Test live round", () => {
  useSqliteContractExecution("worker");
  beforeAll(() => {
    if (process.env["HTTPS_PROXY"] || process.env["https_proxy"])
      setGlobalDispatcher(new EnvHttpProxyAgent());
  });

  it(
    "runs every case against the real model and records the round",
    async () => {
      const dataset = loadDataset();
      const calibration = loadCalibration();
      const selected = environment.HIMAWARI_JARVIS_CASES?.split(",").map((id) => id.trim());
      const cases = selected
        ? dataset.cases.filter(({ id }) => selected.includes(id))
        : dataset.cases;
      const trials = Number(environment.HIMAWARI_JARVIS_TRIALS ?? 3);
      const tokenLimit = Number(environment.HIMAWARI_JARVIS_TOKEN_LIMIT ?? DEFAULT_TOKEN_LIMIT);
      const fullRound = !selected && trials === 3;
      const key = environment.AI_GATEWAY_API_KEY?.trim();
      const secret = async () => (key && key.length > 0 ? key : PROXY_INJECTED_KEY);
      const startedAt = new Date().toISOString();
      const output =
        environment.HIMAWARI_JARVIS_OUTPUT ??
        path.resolve(".ci-output/jarvis-test", startedAt.replace(/[:.]/gu, "-"));
      await mkdir(output, { recursive: true });
      const subjectUsage: TrialUsage = {
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        costReported: false,
      };
      const judgeUsage: JudgeUsage = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
      const spent = () =>
        subjectUsage.inputTokens +
        subjectUsage.outputTokens +
        judgeUsage.inputTokens +
        judgeUsage.outputTokens;
      const costLimitMicros = Number(environment.HIMAWARI_JARVIS_COST_LIMIT_MICROS);
      expect(costLimitMicros).toBeGreaterThan(0);
      const costSpent = () => subjectUsage.costMicros + judgeUsage.costMicros;
      const overLimit = () => spent() >= tokenLimit || costSpent() >= costLimitMicros;

      const reasoning = gatewayReasoningJudge({ secret, usage: judgeUsage });
      const decisionCandidate = gatewayDecisionJudge({ secret, usage: judgeUsage });
      const decisionCalibration = await calibrateDecisionJudge(
        decisionCandidate,
        dataset.judgeRules,
        calibration.samples,
      );
      const reasoningCalibration = await calibrateReasoningJudge(
        reasoning,
        dataset.judgeRules,
        calibration.samples,
      );
      const decision = decisionCalibration.qualified ? decisionCandidate : null;
      await writeFile(
        path.join(output, "calibration.json"),
        `${JSON.stringify({ decision: decisionCalibration, reasoning: reasoningCalibration }, null, 2)}\n`,
      );

      const scratch = await mkdtemp(path.join(tmpdir(), "himawari-jarvis-live-"));
      let stoppedByLimit = false;
      try {
        const outcomes: CaseOutcome[] = await inBatches(cases, PARALLEL_CASES, async (item) => {
          const results: CaseOutcome["trials"] = [];
          for (let trial = 1; trial <= trials; trial += 1) {
            if (overLimit()) {
              stoppedByLimit = true;
              results.push({ result: null, grade: null, durationMs: null });
              continue;
            }
            const trialStartedAt = performance.now();
            const result = await runTrial({
              dataset,
              item,
              root: scratch,
              trial,
              secret,
              usage: subjectUsage,
              overLimit,
            });
            const durationMs = Math.round(performance.now() - trialStartedAt);
            if (result.outcome === "stopped_by_limit") stoppedByLimit = true;
            const grade = await gradeTrial({
              dataset,
              item,
              transcript: result.transcript,
              context: result.context,
              workspaceRoot: result.workspaceRoot,
              judges: { decision, reasoning },
            });
            await writeFile(
              path.join(output, `${item.id}-trial-${trial}.json`),
              `${JSON.stringify({ case: item.id, trial, durationMs, result, grade }, null, 2)}\n`,
            );
            results.push({ result, grade, durationMs });
          }
          return { item, trials: results };
        });

        const record = {
          schemaVersion: 1,
          runAt: startedAt,
          commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          datasetVersion: dataset.datasetVersion,
          calibrationVersion: calibration.calibrationVersion,
          graderCalibrated:
            environment.HIMAWARI_JARVIS_CALIBRATED === "1" && reasoningCalibration.qualified,
          trials,
          models: {
            subject: SUBJECT_MODEL,
            decisionJudge: decision ? decision.identity : null,
            reasoningJudge: reasoning.identity,
          },
          judgeMode: decision ? "two_tier" : "reasoning_only",
          tokens: {
            subject: subjectUsage.inputTokens + subjectUsage.outputTokens,
            judge: judgeUsage.inputTokens + judgeUsage.outputTokens,
          },
          tokenLimit,
          costLimitMicros,
          costMicros: subjectUsage.costReported
            ? subjectUsage.costMicros + judgeUsage.costMicros
            : null,
          subjectCostMicros: subjectUsage.costReported ? subjectUsage.costMicros : null,
          stoppedByLimit,
          cases: outcomes.map(({ item, trials: runs }) => {
            const verdicts = runs.flatMap(({ grade }) => grade?.verdicts ?? []);
            return {
              id: item.id,
              scenario: item.scenario,
              ...(item.shouldPropose === undefined ? {} : { shouldPropose: item.shouldPropose }),
              trials: runs.map(({ grade }) => grade?.passed === true),
              jev_probability: mean(
                verdicts.flatMap(({ probability }) => (probability === null ? [] : [probability])),
              ),
              judge_tier: judgeTier(verdicts, item.judgeRules.length > 0),
              durationsMs: runs.map(({ durationMs }) => durationMs),
            };
          }),
        };
        await writeFile(path.join(output, "round.json"), `${JSON.stringify(record, null, 2)}\n`);
        if (fullRound && environment.HIMAWARI_JARVIS_RECORD === "1")
          await appendHistory(path.resolve("evals/jarvis-test/history.jsonl"), record);
        expect(record.cases).toHaveLength(cases.length);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    ROUND_TIMEOUT_MS,
  );
});
