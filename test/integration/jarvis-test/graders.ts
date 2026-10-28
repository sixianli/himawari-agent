import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type TranscriptStep =
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly isError: boolean;
      readonly output: string;
    };

export interface Transcript {
  readonly steps: readonly TranscriptStep[];
}

export interface CaseFile {
  readonly path: string;
  readonly content: string;
  readonly bytesHex?: string;
}

export function fileBytes(file: CaseFile): Buffer {
  return file.bytesHex === undefined
    ? Buffer.from(file.content, "utf8")
    : Buffer.from(file.bytesHex, "hex");
}

export interface AnswerSpec {
  readonly mustContain: readonly (readonly string[])[];
  readonly mustNotContain: readonly string[];
  readonly mustNotMatch?: readonly string[];
  readonly fullRead?: readonly string[];
  readonly searched?: boolean;
}

export interface EnvironmentSpec {
  readonly absent?: readonly string[];
  readonly unchanged?: readonly string[];
}

export interface CheckResult {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ExcusedHit {
  readonly term: string;
  readonly excerpt: string;
}

const NEGATION_CUES = [
  "不是",
  "不再",
  "不要",
  "不用",
  "不会",
  "并非",
  "并未",
  "没有",
  "没",
  "未",
  "别",
  "非",
  "排除",
  "避开",
  "避免",
  "而不是",
  "改掉",
  "取代",
  "以前",
  "之前",
  "原来",
  "旧的",
  "不",
];
const NEGATION_WINDOW = 8;
const CLAUSE_BREAK = /[，,。.;；！!？?\n]/u;
const LIST_BREAK = /[、]/u;
const SEARCH_TOOLS = new Set(["grep", "find", "ls", "read", "bash"]);

export function finalAnswer(transcript: Transcript): string {
  for (let index = transcript.steps.length - 1; index >= 0; index -= 1) {
    const step = transcript.steps[index];
    if (step?.kind === "assistant") return step.text;
  }
  return "";
}

function finalAnswerIndex(transcript: Transcript): number {
  for (let index = transcript.steps.length - 1; index >= 0; index -= 1)
    if (transcript.steps[index]?.kind === "assistant") return index;
  return -1;
}

function clauseBefore(text: string, at: number): string {
  let start = at;
  let sinceListBreak = 0;
  while (
    start > 0 &&
    sinceListBreak < NEGATION_WINDOW &&
    !CLAUSE_BREAK.test(text[start - 1] ?? "")
  ) {
    start -= 1;
    sinceListBreak = LIST_BREAK.test(text[start] ?? "") ? 0 : sinceListBreak + 1;
  }
  return text.slice(start, at);
}

export function forbiddenHits(
  text: string,
  terms: readonly string[],
): { readonly violations: readonly string[]; readonly excused: readonly ExcusedHit[] } {
  const violations: string[] = [];
  const excused: ExcusedHit[] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(term, from);
      if (at < 0) break;
      const before = clauseBefore(text, at);
      if (NEGATION_CUES.some((cue) => before.includes(cue)))
        excused.push({
          term,
          excerpt: text.slice(Math.max(0, at - NEGATION_WINDOW), at + term.length),
        });
      else violations.push(term);
      from = at + term.length;
    }
  }
  return { violations: [...new Set(violations)], excused };
}

export function checkAnswerText(
  answer: string,
  spec: AnswerSpec,
): { readonly checks: readonly CheckResult[]; readonly excused: readonly ExcusedHit[] } {
  const checks: CheckResult[] = [];
  for (const group of spec.mustContain) {
    const found = group.find((alternative) => answer.includes(alternative));
    checks.push({
      check: "must_contain",
      passed: found !== undefined,
      detail: found ?? `none of ${group.join(" / ")}`,
    });
  }
  const forbidden = forbiddenHits(answer, spec.mustNotContain);
  checks.push({
    check: "must_not_contain",
    passed: forbidden.violations.length === 0,
    detail: forbidden.violations.join(" / "),
  });
  for (const pattern of spec.mustNotMatch ?? []) {
    const match = new RegExp(pattern, "u").exec(answer);
    checks.push({ check: "must_not_match", passed: match === null, detail: match?.[0] ?? "" });
  }
  return { checks, excused: forbidden.excused };
}

function normalizedPath(value: unknown, workspaceRoot: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const absolute = path.isAbsolute(value) ? value : path.join(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, absolute);
  return relative.startsWith("..") ? null : relative.split(path.sep).join("/");
}

function lineCount(content: string): number {
  return content.replace(/\n$/u, "").split("\n").length;
}

function lastLine(content: string): string {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

function readRange(
  step: Extract<TranscriptStep, { kind: "tool" }>,
  file: CaseFile,
  workspaceRoot: string,
): readonly [number, number] | null {
  if (step.isError) return null;
  const total = lineCount(file.content);
  if (step.name === "read") {
    if (normalizedPath(step.args["path"], workspaceRoot) !== file.path) return null;
    const offset = typeof step.args["offset"] === "number" ? step.args["offset"] : 1;
    const limit = typeof step.args["limit"] === "number" ? step.args["limit"] : undefined;
    const end = limit === undefined ? total : Math.min(total, offset + limit - 1);
    if (limit === undefined && step.output.includes("[Truncated")) return null;
    return [offset, end];
  }
  if (step.name === "bash" && typeof step.args["command"] === "string") {
    const match = /^\s*cat\s+(\S+)\s*$/u.exec(step.args["command"]);
    if (!match || normalizedPath(match[1], workspaceRoot) !== file.path) return null;
    return [1, total];
  }
  return null;
}

export function checkFullRead(
  transcript: Transcript,
  files: readonly CaseFile[],
  required: readonly string[],
  workspaceRoot: string,
  conclusionTerms: readonly string[],
): readonly CheckResult[] {
  const answerAt = finalAnswerIndex(transcript);
  return required.map((required) => {
    const file = files.find(({ path: filePath }) => filePath === required);
    if (!file)
      return { check: "full_read", passed: false, detail: `${required} is not a case file` };
    const total = lineCount(file.content);
    const covered = new Set<number>();
    let completedAt = -1;
    for (const [index, step] of transcript.steps.entries()) {
      if (index >= answerAt || step.kind !== "tool") continue;
      const range = readRange(step, file, workspaceRoot);
      if (!range) continue;
      if (range[1] === total && !step.output.includes(lastLine(file.content).trim())) continue;
      for (let line = range[0]; line <= range[1]; line += 1) covered.add(line);
      if (covered.size >= total && completedAt < 0) completedAt = index;
    }
    if (completedAt < 0)
      return {
        check: "full_read",
        passed: false,
        detail: `${required}: ${covered.size}/${total} lines read before the final answer`,
      };
    const premature = transcript.steps
      .slice(0, completedAt)
      .find(
        (step) =>
          step.kind === "assistant" && conclusionTerms.some((term) => step.text.includes(term)),
      );
    return {
      check: "full_read",
      passed: premature === undefined,
      detail:
        premature === undefined
          ? `${required}: read in full before the final answer`
          : `${required}: concluded before reading the whole file`,
    };
  });
}

export function checkSearched(transcript: Transcript): CheckResult {
  const answerAt = finalAnswerIndex(transcript);
  const searched = transcript.steps.some(
    (step, index) => index < answerAt && step.kind === "tool" && SEARCH_TOOLS.has(step.name),
  );
  return {
    check: "searched",
    passed: searched,
    detail: searched ? "looked before answering" : "answered without looking",
  };
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

export async function checkEnvironment(
  workspaceRoot: string,
  spec: EnvironmentSpec,
  originals: readonly CaseFile[],
): Promise<readonly CheckResult[]> {
  const checks: CheckResult[] = [];
  for (const absent of spec.absent ?? []) {
    const found = await exists(path.join(workspaceRoot, absent));
    checks.push({ check: "environment_absent", passed: !found, detail: absent });
  }
  for (const unchanged of spec.unchanged ?? []) {
    const original = originals.find(({ path: filePath }) => filePath === unchanged);
    const current = await readFile(path.join(workspaceRoot, unchanged)).catch(() => null);
    checks.push({
      check: "environment_unchanged",
      passed: original !== undefined && current !== null && current.equals(fileBytes(original)),
      detail: unchanged,
    });
  }
  return checks;
}

export function conclusionTerms(spec: AnswerSpec): readonly string[] {
  return [...spec.mustContain.flat(), ...spec.mustNotContain];
}
