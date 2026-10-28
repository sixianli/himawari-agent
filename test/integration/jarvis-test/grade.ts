import type { JarvisCase, JarvisDataset } from "./cases.ts";
import {
  type CheckResult,
  checkAnswerText,
  checkEnvironment,
  checkFullRead,
  checkSearched,
  conclusionTerms,
  type ExcusedHit,
  finalAnswer,
  type Transcript,
} from "./graders.ts";
import { type DecisionJudge, judgeAnswer, type ReasoningJudge, type RuleVerdict } from "./judge.ts";

const EVIDENCE_OUTPUT_LIMIT = 4000;

export interface TrialGrade {
  readonly passed: boolean;
  readonly answer: string;
  readonly checks: readonly CheckResult[];
  readonly excused: readonly ExcusedHit[];
  readonly verdicts: readonly RuleVerdict[];
}

export function judgeEvidence(item: JarvisCase, transcript: Transcript): string {
  const lines = [`主人的请求：${item.prompt}`];
  const memories = item.memories ?? [];
  if (memories.length > 0)
    lines.push(`Himawari 记得的事：\n${memories.map(({ text }) => `- ${text}`).join("\n")}`);
  const tools = transcript.steps.flatMap((step) => (step.kind === "tool" ? [step] : []));
  lines.push(
    tools.length === 0
      ? "工具调用记录：没有调用任何工具。"
      : `工具调用记录：\n${tools
          .map(
            (step, index) =>
              `${index + 1}. ${step.name} ${JSON.stringify(step.args)} → ${step.isError ? "失败" : "成功"}\n${step.output.slice(0, EVIDENCE_OUTPUT_LIMIT)}`,
          )
          .join("\n")}`,
  );
  return lines.join("\n\n");
}

export async function gradeTrial(input: {
  readonly dataset: JarvisDataset;
  readonly item: JarvisCase;
  readonly transcript: Transcript;
  readonly workspaceRoot: string;
  readonly judges: { readonly decision: DecisionJudge | null; readonly reasoning: ReasoningJudge };
}): Promise<TrialGrade> {
  const { dataset, item, transcript, workspaceRoot } = input;
  const answer = finalAnswer(transcript);
  const text = checkAnswerText(answer, item.answer);
  const checks: CheckResult[] = [
    { check: "answered", passed: answer.trim().length > 0, detail: answer.slice(0, 80) },
    ...text.checks,
  ];
  if (item.answer.fullRead)
    checks.push(
      ...checkFullRead(
        transcript,
        item.files ?? [],
        item.answer.fullRead,
        workspaceRoot,
        conclusionTerms(item.answer),
      ),
    );
  if (item.answer.searched) checks.push(checkSearched(transcript));
  if (item.environment)
    checks.push(...(await checkEnvironment(workspaceRoot, item.environment, item.files ?? [])));
  const rules = item.judgeRules.map((id) => {
    const rule = dataset.judgeRules.find((candidate) => candidate.id === id);
    if (!rule) throw new Error(`JUDGE_RULE_UNKNOWN:${id}`);
    return rule;
  });
  const evidence = judgeEvidence(item, transcript);
  const verdicts =
    answer.trim().length === 0
      ? []
      : await judgeAnswer(
          rules.map((rule) => ({ rule, evidence, answer })),
          input.judges,
        );
  return {
    passed: checks.every(({ passed }) => passed) && verdicts.every(({ passed }) => passed),
    answer,
    checks,
    excused: text.excused,
    verdicts,
  };
}
