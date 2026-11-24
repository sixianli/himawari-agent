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
  preauthorizeOwnerIntentConfirmed: "action_preauthorize_owner_intent_confirmed",
  preauthorizeHimawariSideAfterExternalContent:
    "action_preauthorize_himawari_side_after_external_content",
} as const);

const OWNER_INTENT_CONFIRMED_EXPRESSION =
  'action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && run_source == "user_message" && "context_external_content" in facts && "owner_intent_confirmed" in facts && !("owner_presence_required" in facts) && !("standing_rule_change" in facts)';

const HIMAWARI_SIDE_EXPRESSION =
  '"himawari_side_only" in facts && action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && !("owner_presence_required" in facts) && !("standing_rule_change" in facts)';

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
    revision: 3,
    gate: "action",
    expression: `action_kind != "READ" && target_type != "managed-task" && "context_external_content" in facts && !(${OWNER_INTENT_CONFIRMED_EXPRESSION}) && !(${HIMAWARI_SIDE_EXPRESSION})`,
    outcome: "ask_owner",
    origin: "built_in",
    source:
      "ADR 0257 决定 3、4；ADR 0285 决定 7：读过外来内容后，碰主人外面的账号设备、改规则、发出去、删、花钱先问，所有运行都一样",
    status: "active",
    examples: Object.freeze([
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
      example(
        true,
        {
          targets: [{ type: "owner-perception" }],
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "run_source_schedule" },
          ],
        },
        "schedule",
      ),
      example(false, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "himawari_side_only" },
          { code: "run_source_user_message" },
        ],
      }),
      example(
        false,
        {
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "himawari_side_only" },
            { code: "run_source_external_event" },
          ],
        },
        "external_event",
      ),
      example(true, {
        actionKind: "DELETE",
        finalRisk: "HIGH",
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "himawari_side_only" },
          { code: "run_source_user_message" },
        ],
      }),
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
      example(
        true,
        {
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "run_source_external_event" },
            { code: "run_source_owner_approved_task" },
          ],
        },
        "external_event",
      ),
      example(false, {}),
      example(false, {
        actionKind: "READ",
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "owner_intent_confirmed" },
          { code: "run_source_user_message" },
        ],
      }),
      example(true, {
        finalRisk: "HIGH",
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "owner_intent_confirmed" },
          { code: "run_source_user_message" },
        ],
      }),
    ]),
  }),
  Object.freeze({
    id: ACTION_RULE_IDS.preauthorizeOwnerIntentConfirmed,
    revision: 1,
    gate: "action",
    expression: OWNER_INTENT_CONFIRMED_EXPRESSION,
    outcome: "allow_preauthorized",
    origin: "built_in",
    source:
      "ADR 0257 决定 4：读过外来内容后，主人自己明说要做的中风险、能撤销、只动自己数据的动作，核对通过就直接做",
    status: "active",
    examples: Object.freeze([
      example(true, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "owner_intent_confirmed" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, {
        finalRisk: "HIGH",
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "owner_intent_confirmed" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, {
        reversible: false,
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "owner_intent_confirmed" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "owner_intent_confirmed" },
          { code: "run_source_user_message" },
          { code: "standing_rule_change" },
        ],
      }),
      example(
        false,
        {
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "owner_intent_confirmed" },
            { code: "run_source_schedule" },
          ],
        },
        "schedule",
      ),
      example(false, {
        deterministicFacts: [
          { code: "owner_intent_confirmed" },
          { code: "run_source_user_message" },
        ],
      }),
    ]),
  }),
  Object.freeze({
    id: ACTION_RULE_IDS.refuseBackgroundAfterExternalContent,
    revision: 3,
    gate: "action",
    expression:
      'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',
    outcome: "refuse",
    origin: "built_in",
    source:
      "ADR 0257 决定 3；ADR 0285 决定 7 停用：读过外来内容后不再直接拒绝，改由 action_ask_after_external_content 问主人",
    status: "retired",
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
      example(
        false,
        {
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "run_source_external_event" },
            { code: "run_source_owner_approved_task" },
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
    id: ACTION_RULE_IDS.preauthorizeHimawariSideAfterExternalContent,
    revision: 1,
    gate: "action",
    expression: `"context_external_content" in facts && ${HIMAWARI_SIDE_EXPRESSION}`,
    outcome: "allow_preauthorized",
    origin: "built_in",
    source:
      "ADR 0285 决定 7：读过外来内容后，只改 Himawari 自己这边、能撤回的动作直接做，记下是哪件外来的事引起的",
    status: "active",
    examples: Object.freeze([
      example(true, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "himawari_side_only" },
          { code: "run_source_user_message" },
        ],
      }),
      example(
        true,
        {
          deterministicFacts: [
            { code: "context_external_content" },
            { code: "himawari_side_only" },
            { code: "run_source_external_event" },
          ],
        },
        "external_event",
      ),
      example(false, {
        deterministicFacts: [{ code: "himawari_side_only" }, { code: "run_source_user_message" }],
      }),
      example(false, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, {
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "himawari_side_only" },
          { code: "run_source_user_message" },
          { code: "standing_rule_change" },
        ],
      }),
      example(false, {
        actionKind: "DELETE",
        finalRisk: "HIGH",
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "himawari_side_only" },
          { code: "run_source_user_message" },
        ],
      }),
      example(false, {
        disclosure: "named_recipients",
        recipients: ["someone@example.com"],
        deterministicFacts: [
          { code: "context_external_content" },
          { code: "himawari_side_only" },
          { code: "run_source_user_message" },
        ],
      }),
    ]),
  }),
  Object.freeze({
    id: ACTION_RULE_IDS.preauthorizeOwnTaskCancel,
    revision: 1,
    gate: "action",
    expression:
      'target_type == "managed-task" && action_kind == "CREATE_OR_UPDATE" && reversible == 0',
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
      example(false, { targets: [{ type: "managed-task" }], reversible: true }),
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
