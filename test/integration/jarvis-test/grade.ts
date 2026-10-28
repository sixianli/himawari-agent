import type { JarvisCase, JarvisDataset } from "./cases.ts";
import {
  type CheckResult,
  checkEnvironment,
  checkFullRead,
  checkSearched,
  finalAnswer,
  type Transcript,
} from "./graders.ts";
import { type DecisionJudge, judgeAnswer, type ReasoningJudge, type RuleVerdict } from "./judge.ts";

const EVIDENCE_OUTPUT_LIMIT = 4000;
export const EXPECTATIONS_RULE = "case_expectations_met";

export interface TrialContext {
  readonly systemInstruction: string;
  readonly material: string;
}

export interface TrialGrade {
  readonly passed: boolean;
  readonly answer: string;
  readonly checks: readonly CheckResult[];
  readonly verdicts: readonly RuleVerdict[];
}

export function judgeEvidence(
  item: JarvisCase,
  transcript: Transcript,
  context: TrialContext,
): string {
  const lines = [
    `主人的请求：${item.prompt}`,
    `Himawari 收到的系统说明：\n${context.systemInstruction}`,
    `Himawari 上下文里的记忆和资料：\n${context.material}`,
  ];
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

export function expectationsEvidence(item: JarvisCase, evidence: string): string {
  return `${evidence}\n\n评判要求：\n${item.answer.expectations.map((line) => `- ${line}`).join("\n")}`;
}

export async function gradeTrial(input: {
  readonly dataset: JarvisDataset;
  readonly item: JarvisCase;
  readonly transcript: Transcript;
  readonly context: TrialContext;
  readonly workspaceRoot: string;
  readonly judges: { readonly decision: DecisionJudge | null; readonly reasoning: ReasoningJudge };
}): Promise<TrialGrade> {
  const { dataset, item, transcript, workspaceRoot } = input;
  const answer = finalAnswer(transcript);
  const checks: CheckResult[] = [
    { check: "answered", passed: answer.trim().length > 0, detail: answer.slice(0, 80) },
  ];
  if (item.answer.fullRead)
    checks.push(
      ...checkFullRead(
        transcript,
        item.files ?? [],
        item.answer.fullRead,
        workspaceRoot,
        item.answer.conclusionCues ?? [],
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
  const evidence = judgeEvidence(item, transcript, input.context);
  const verdicts =
    answer.trim().length === 0
      ? []
      : await judgeAnswer(
          rules.map((rule) => ({
            rule,
            evidence:
              rule.id === EXPECTATIONS_RULE ? expectationsEvidence(item, evidence) : evidence,
            answer,
          })),
          input.judges,
        );
  return {
    passed: checks.every(({ passed }) => passed) && verdicts.every(({ passed }) => passed),
    answer,
    checks,
    verdicts,
  };
}
