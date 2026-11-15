import type { DeterministicPolicyFact } from "../ports/authorization.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";

export interface PolicyFactDefinition {
  readonly code: string;
  readonly label: { readonly zh: string; readonly en: string; readonly ja: string };
}

export const POLICY_FACT_CODES = Object.freeze({
  externalModelDisclosure: "external_model_disclosure",
  externalProviderDisclosure: "external_provider_disclosure",
  privateWorkspaceRead: "private_workspace_read",
  runSourceUserMessage: "run_source_user_message",
  runSourceSchedule: "run_source_schedule",
  runSourceExternalEvent: "run_source_external_event",
  contextExternalContent: "context_external_content",
  ownerPresenceRequired: "owner_presence_required",
  standingRuleChange: "standing_rule_change",
  ownerIntentConfirmed: "owner_intent_confirmed",
} as const);

export type PolicyFactCode = (typeof POLICY_FACT_CODES)[keyof typeof POLICY_FACT_CODES];

export const POLICY_FACT_REGISTRY: readonly PolicyFactDefinition[] = Object.freeze(
  [
    {
      code: POLICY_FACT_CODES.externalModelDisclosure,
      label: {
        zh: "内容会发给外部模型",
        en: "Content goes to an external model",
        ja: "内容が外部のモデルに送られます",
      },
    },
    {
      code: POLICY_FACT_CODES.externalProviderDisclosure,
      label: {
        zh: "内容会发给外部服务方",
        en: "Content goes to an external provider",
        ja: "内容が外部のサービスに送られます",
      },
    },
    {
      code: POLICY_FACT_CODES.privateWorkspaceRead,
      label: {
        zh: "读取私人工作目录",
        en: "Reads a private workspace",
        ja: "個人の作業フォルダを読み取ります",
      },
    },
    {
      code: POLICY_FACT_CODES.runSourceUserMessage,
      label: {
        zh: "这一轮由你的消息发起",
        en: "This run was started by your message",
        ja: "この実行はあなたのメッセージで始まりました",
      },
    },
    {
      code: POLICY_FACT_CODES.runSourceSchedule,
      label: {
        zh: "这一轮由定时任务发起",
        en: "This run was started by a schedule",
        ja: "この実行はスケジュールで始まりました",
      },
    },
    {
      code: POLICY_FACT_CODES.runSourceExternalEvent,
      label: {
        zh: "这一轮由外部事件发起",
        en: "This run was started by an external event",
        ja: "この実行は外部のイベントで始まりました",
      },
    },
    {
      code: POLICY_FACT_CODES.contextExternalContent,
      label: {
        zh: "她看得到的内容里有外来内容",
        en: "Her context contains outside content",
        ja: "彼女が見ている内容に外部の内容が含まれています",
      },
    },
    {
      code: POLICY_FACT_CODES.ownerPresenceRequired,
      label: {
        zh: "要你本人在场",
        en: "Needs you in person",
        ja: "あなた本人の確認が必要です",
      },
    },
    {
      code: POLICY_FACT_CODES.standingRuleChange,
      label: {
        zh: "改的是长期规则",
        en: "Changes a standing rule",
        ja: "長期のルールを変更します",
      },
    },
    {
      code: POLICY_FACT_CODES.ownerIntentConfirmed,
      label: {
        zh: "你自己明说过要做这件事",
        en: "You said you wanted this done",
        ja: "あなた自身がこの操作を明確に求めました",
      },
    },
  ].map((definition) => Object.freeze({ ...definition, label: Object.freeze(definition.label) })),
);

const KNOWN_CODES: ReadonlySet<string> = new Set(POLICY_FACT_REGISTRY.map(({ code }) => code));

export function isPolicyFactCode(code: string): code is PolicyFactCode {
  return KNOWN_CODES.has(code);
}

export function assertPolicyFactCodes(facts: readonly Pick<DeterministicPolicyFact, "code">[]) {
  const codes = facts.map(({ code }) => code);
  const unknown = codes.find((code) => !KNOWN_CODES.has(code));
  const ordered = codes.every((code, index) => index === 0 || (codes[index - 1] ?? "") < code);
  if (unknown !== undefined || !ordered)
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "ActionIntent policy facts must be registered, unique and sorted by code",
      { code: unknown ?? "order" },
    );
}

export function sortPolicyFacts(
  facts: readonly DeterministicPolicyFact[],
): readonly DeterministicPolicyFact[] {
  return Object.freeze(
    [...facts].sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    ),
  );
}

export function runtimePolicyFacts(
  codes: readonly PolicyFactCode[],
): readonly DeterministicPolicyFact[] {
  return Object.freeze(
    [...new Set(codes)]
      .sort()
      .map((code) => Object.freeze({ code, minimumRisk: "LOW", source: "runtime" } as const)),
  );
}

export const RUN_SOURCE_FACT: Readonly<
  Record<"user_message" | "schedule" | "external_event", PolicyFactCode>
> = Object.freeze({
  user_message: POLICY_FACT_CODES.runSourceUserMessage,
  schedule: POLICY_FACT_CODES.runSourceSchedule,
  external_event: POLICY_FACT_CODES.runSourceExternalEvent,
});
