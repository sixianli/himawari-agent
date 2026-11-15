import { readFileSync } from "node:fs";
import path from "node:path";
import type { MemoryCategory } from "@himawari-agent/application";
import type { AnswerSpec, CaseFile, EnvironmentSpec } from "./graders.ts";
import type { CalibrationSample, JudgeRule } from "./judge.ts";

export type Scenario =
  | "memory_correction"
  | "state_discipline"
  | "failure_transparency"
  | "proactive_next_step"
  | "forget_propagation";

export interface CaseMemory {
  readonly id: string;
  readonly text: string;
  readonly category: MemoryCategory;
  readonly importance: number;
  readonly entities?: readonly string[];
  readonly recordedAt: string;
  readonly validFrom?: string;
  readonly supersedes?: string;
  readonly derivedFrom?: readonly string[];
}

export interface CaseFailure {
  readonly tool: string;
  readonly match: string;
  readonly error?: string;
  readonly exitCode?: number;
  readonly output?: string;
}

export interface CaseToolResult {
  readonly tool: string;
  readonly outputs: readonly string[];
}

export interface CasePermissions {
  readonly readOnly?: readonly string[];
  readonly unreadable?: readonly string[];
}

export interface RealFailure {
  readonly command: string;
  readonly exitCode: number;
  readonly output?: string;
}

export interface JarvisCase {
  readonly id: string;
  readonly scenario: Scenario;
  readonly title: string;
  readonly prompt: string;
  readonly memories?: readonly CaseMemory[];
  readonly files?: readonly CaseFile[];
  readonly failures?: readonly CaseFailure[];
  readonly toolResults?: readonly CaseToolResult[];
  readonly shouldPropose?: boolean;
  readonly counterExample?: boolean;
  readonly permissions?: CasePermissions;
  readonly realFailures?: readonly RealFailure[];
  readonly context?: { readonly present: readonly string[]; readonly absent: readonly string[] };
  readonly flagged?: readonly string[];
  readonly environment?: EnvironmentSpec;
  readonly answer: AnswerSpec;
  readonly judgeRules: readonly string[];
}

export interface JarvisDataset {
  readonly schemaVersion: number;
  readonly datasetVersion: string;
  readonly today: string;
  readonly timeZone: string;
  readonly sharedMemories: readonly CaseMemory[];
  readonly judgeRules: readonly JudgeRule[];
  readonly cases: readonly JarvisCase[];
}

export interface CalibrationSet {
  readonly schemaVersion: number;
  readonly calibrationVersion: string;
  readonly samples: readonly CalibrationSample[];
}

export interface JudgeModel {
  readonly id: string;
  readonly version: string;
}

export interface JudgeModels {
  readonly schemaVersion: number;
  readonly decisionJudge: JudgeModel;
  readonly reasoningJudge: JudgeModel;
}

const FIXTURE_ROOT = path.resolve(import.meta.dirname, "../../fixtures/jarvis-test");

export function loadDataset(): JarvisDataset {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, "cases.json"), "utf8")) as JarvisDataset;
}

export function loadCalibration(): CalibrationSet {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_ROOT, "judge-calibration.json"), "utf8"),
  ) as CalibrationSet;
}

export function loadJudgeModels(): JudgeModels {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, "models.json"), "utf8")) as JudgeModels;
}
