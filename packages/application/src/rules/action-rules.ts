import type { GovernedActionIntent } from "../ports/authorization.js";
import type { RunExecutionSource } from "../ports/run-execution-source.js";
import type { RuleOutcome, RuleRecord } from "./rule-book.js";
import type { RuleFacts } from "./rule-expression.js";
import type { RuleHit, RuleJudge } from "./rule-judge.js";

export const ACTION_RULE_IDS = Object.freeze({
  preauthorizeOwnerData: "action_preauthorize_owner_data",
  preauthorizeOwnTaskCancel: "action_preauthorize_own_task_cancel",
  askAfterExternalContent: "action_ask_after_external_content",
  refuseBackgroundAfterExternalContent: "action_refuse_background_after_external_content",
} as const);

export const ACTION_RULE_OUTCOMES = Object.freeze([
  "allow_preauthorized",
  "ask_owner",
  "refuse",
] as const);
export type ActionRuleOutcome = (typeof ACTION_RULE_OUTCOMES)[number];

const STRICTNESS: Readonly<Record<ActionRuleOutcome, number>> = Object.freeze({
  allow_preauthorized: 0,
  ask_owner: 1,
  refuse: 2,
});

export interface ActionGateInput {
  readonly actionKind: GovernedActionIntent["actionKind"];
  readonly finalRisk: GovernedActionIntent["finalRisk"];
  readonly reversible: boolean;
  readonly disclosure: GovernedActionIntent["disclosure"];
  readonly recipients: readonly string[];
  readonly targets: readonly { readonly type: string }[];
  readonly deterministicFacts: readonly { readonly code: string }[];
}

export function actionGateFacts(
  intent: ActionGateInput,
  runSource: RunExecutionSource["sourceType"],
): RuleFacts {
  return Object.freeze({
    action_kind: intent.actionKind,
    risk: intent.finalRisk,
    reversible: intent.reversible ? 1 : 0,
    disclosure: intent.disclosure,
    recipient_count: intent.recipients.length,
    run_source: runSource,
    target_type: intent.targets[0]?.type ?? "",
    facts: Object.freeze(intent.deterministicFacts.map(({ code }) => code).sort()),
  });
}

function example(
  hit: boolean,
  overrides: Partial<ActionGateInput>,
  runSource: RunExecutionSource["sourceType"] = "user_message",
) {
  return Object.freeze({
    facts: actionGateFacts(
      {
        actionKind: "CREATE_OR_UPDATE",
        finalRisk: "MEDIUM",
        reversible: true,
        disclosure: "none",
        recipients: [],
        targets: [{ type: "owner-reminder" }],
        deterministicFacts: [{ code: "run_source_user_message" }],
        ...overrides,
      },
      runSource,
    ),
    hit,
  });
}

export const BUILT_IN_ACTION_RULES: readonly RuleRecord[] = Object.freeze([
  Object.freeze({
    id: ACTION_RULE_IDS.preauthorizeOwnerData,
    revision: 1,
    gate: "action",
    expression:
      'action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && !("context_external_content" in facts) && !("owner_presence_required" in facts)',
    outcome: "allow_preauthorized",
    origin: "built_in",
    source: "ADR 0257 决定 3；愿景“常规判断应由规则手册预先授权”",
    status: "active",
    examples: Object.freeze([
      example(true, {}),
      example(
        true,
        {
          deterministicFacts: [{ code: "run_source_schedule" }, { code: "standing_rule_change" }],
        },
        "schedule",
      ),
      example(false, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, {
        deterministicFacts: [
          { code: "owner_presence_required" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, { actionKind: "DELETE", finalRisk: "HIGH" }),
      example(false, { finalRisk: "HIGH" }),
      example(false, { reversible: false }),
      example(false, { disclosure: "named_recipients", recipients: ["someone@example.com"] }),
    ]),
  }),
  Object.freeze({
    id: ACTION_RULE_IDS.askAfterExternalContent,
    revision: 1,
    gate: "action",
    expression:
      'action_kind != "READ" && target_type != "managed-task" && "context_external_content" in facts',
    outcome: "ask_owner",
    origin: "built_in",
    source: "ADR 0257 决定 3、4；苹果端设计“指令和数据的界线”",
    status: "active",
    examples: Object.freeze([
      example(true, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "run_source_user_message" },
        ],
      }),
      example(true, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "run_source_user_message" },
          { code: "standing_rule_change" },
        ],
      }),
      example(false, {}),
      example(false, {
        actionKind: "READ",
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "run_source_user_message" },
        ],
      }),
    ]),
  }),
  Object.freeze({
    id: ACTION_RULE_IDS.refuseBackgroundAfterExternalContent,
    revision: 1,
    gate: "action",
    expression:
      'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
    outcome: "refuse",
    origin: "built_in",
    source: "ADR 0257 决定 3；苹果端设计“指令和数据的界线”：后台一律不做",
    status: "active",
    examples: Object.freeze([
      example(
        true,
        {
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "run_source_schedule" },
          ],
        },
        "schedule",
      ),
      example(
        true,
        {
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "run_source_external_event" },
          ],
        },
        "external_event",
      ),
      example(false, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, { deterministicFacts: [{ code: "run_source_schedule" }] }, "schedule"),
      example(
        false,
        {
          actionKind: "READ",
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "run_source_schedule" },
          ],
        },
        "schedule",
      ),
    ]),
  }),
  Object.freeze({
    id: ACTION_RULE_IDS.preauthorizeOwnTaskCancel,
    revision: 1,
    gate: "action",
    expression: 'target_type == "managed-task" && action_kind == "CREATE_OR_UPDATE"',
    outcome: "allow_preauthorized",
    origin: "built_in",
    source: "ADR 0257 第 2 步：停止这一轮自己开的任务，最坏是一件自己开的活停了，可以重开",
    status: "active",
    examples: Object.freeze([
      example(true, { targets: [{ type: "managed-task" }], reversible: false }),
      example(
        true,
        {
          targets: [{ type: "managed-task" }],
          reversible: false,
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "run_source_schedule" },
          ],
        },
        "schedule",
      ),
      example(false, {}),
      example(false, { targets: [{ type: "managed-task" }], actionKind: "READ", finalRisk: "LOW" }),
    ]),
  }),
]);

export interface ActionRuleDecision {
  readonly outcome: ActionRuleOutcome | null;
  readonly hit: RuleHit | null;
}

function isActionOutcome(outcome: RuleOutcome): outcome is ActionRuleOutcome {
  return (ACTION_RULE_OUTCOMES as readonly string[]).includes(outcome);
}

export function decideActionRules(
  judge: RuleJudge,
  facts: RuleFacts,
  rules: readonly RuleRecord[] = BUILT_IN_ACTION_RULES,
): ActionRuleDecision {
  let strictest: RuleHit | null = null;
  for (const hit of judge.decide("action", facts, rules).hits) {
    if (!isActionOutcome(hit.outcome)) continue;
    if (
      strictest === null ||
      STRICTNESS[hit.outcome] > STRICTNESS[strictest.outcome as ActionRuleOutcome]
    )
      strictest = hit;
  }
  return Object.freeze({
    outcome: strictest ? (strictest.outcome as ActionRuleOutcome) : null,
    hit: strictest,
  });
}
