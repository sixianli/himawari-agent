export interface JudgeRule {
  readonly id: string;
  readonly question: string;
}

export interface JudgeQuestion {
  readonly rule: JudgeRule;
  readonly evidence: string;
  readonly answer: string;
}

export interface ModelIdentity {
  readonly id: string;
  readonly version: string;
}

export interface DecisionJudge {
  readonly identity: ModelIdentity;
  decide(questions: readonly JudgeQuestion[]): Promise<readonly number[]>;
}

export interface ReasoningVerdict {
  readonly passed: boolean;
  readonly quote: string;
  readonly reason: string;
}

export interface ReasoningJudge {
  readonly identity: ModelIdentity;
  judge(question: JudgeQuestion): Promise<ReasoningVerdict>;
}

export type JudgeTier = "decision" | "escalated" | "reasoning_only";

export interface RuleVerdict {
  readonly ruleId: string;
  readonly passed: boolean;
  readonly tier: JudgeTier;
  readonly probability: number | null;
  readonly quote: string | null;
  readonly reason: string | null;
}

export const DECISION_PASS_AT = 0.85;
export const DECISION_FAIL_AT = 0.15;
export const MAXIMUM_UNCERTAIN_SHARE = 0.2;

export interface CalibrationSample {
  readonly id: string;
  readonly rule: string;
  readonly evidence: string;
  readonly answer: string;
  readonly expected: boolean;
  readonly trap?: string;
}

export interface CalibrationResult {
  readonly qualified: boolean;
  readonly confidentMistakes: readonly string[];
  readonly uncertain: readonly string[];
}

function question(rules: readonly JudgeRule[], sample: CalibrationSample): JudgeQuestion {
  const rule = rules.find(({ id }) => id === sample.rule);
  if (!rule) throw new Error(`JUDGE_RULE_UNKNOWN:${sample.rule}`);
  return { rule, evidence: sample.evidence, answer: sample.answer };
}

export async function calibrateDecisionJudge(
  judge: DecisionJudge,
  rules: readonly JudgeRule[],
  samples: readonly CalibrationSample[],
): Promise<CalibrationResult> {
  const probabilities = await judge.decide(samples.map((sample) => question(rules, sample)));
  if (probabilities.length !== samples.length) throw new Error("DECISION_JUDGE_ANSWER_COUNT");
  const confidentMistakes: string[] = [];
  const uncertain: string[] = [];
  for (const [index, sample] of samples.entries()) {
    const probability = probabilities[index] ?? Number.NaN;
    const confidentPass = probability >= DECISION_PASS_AT;
    const confidentFail = probability <= DECISION_FAIL_AT;
    if ((confidentPass && !sample.expected) || (confidentFail && sample.expected))
      confidentMistakes.push(sample.id);
    else if (!confidentPass && !confidentFail) uncertain.push(sample.id);
  }
  return {
    qualified:
      confidentMistakes.length === 0 &&
      uncertain.length <= samples.length * MAXIMUM_UNCERTAIN_SHARE,
    confidentMistakes,
    uncertain,
  };
}

export async function calibrateReasoningJudge(
  judge: ReasoningJudge,
  rules: readonly JudgeRule[],
  samples: readonly CalibrationSample[],
): Promise<CalibrationResult> {
  const mistakes: string[] = [];
  for (const sample of samples) {
    const verdict = await judge.judge(question(rules, sample));
    if (verdict.passed !== sample.expected) mistakes.push(sample.id);
  }
  return { qualified: mistakes.length === 0, confidentMistakes: mistakes, uncertain: [] };
}

export async function judgeAnswer(
  questions: readonly JudgeQuestion[],
  judges: { readonly decision: DecisionJudge | null; readonly reasoning: ReasoningJudge },
): Promise<readonly RuleVerdict[]> {
  if (questions.length === 0) return [];
  if (!judges.decision)
    return Promise.all(
      questions.map(async (item) => {
        const verdict = await judges.reasoning.judge(item);
        return {
          ruleId: item.rule.id,
          passed: verdict.passed,
          tier: "reasoning_only" as const,
          probability: null,
          quote: verdict.quote,
          reason: verdict.reason,
        };
      }),
    );
  const probabilities = await judges.decision.decide(questions);
  if (probabilities.length !== questions.length) throw new Error("DECISION_JUDGE_ANSWER_COUNT");
  return Promise.all(
    questions.map(async (item, index) => {
      const probability = probabilities[index] ?? Number.NaN;
      if (probability >= DECISION_PASS_AT)
        return {
          ruleId: item.rule.id,
          passed: true,
          tier: "decision" as const,
          probability,
          quote: null,
          reason: null,
        };
      const verdict = await judges.reasoning.judge(item);
      return {
        ruleId: item.rule.id,
        passed: verdict.passed,
        tier: "escalated" as const,
        probability,
        quote: verdict.quote,
        reason: verdict.reason,
      };
    }),
  );
}
