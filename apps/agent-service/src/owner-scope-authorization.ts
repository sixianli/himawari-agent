import { createHash } from "node:crypto";
import {
  ACTION_KIND_RISK_BASELINE,
  ACTION_RULE_IDS,
  type ApprovalAskedBecause,
  type ApprovalDisplayInput,
  type ApprovalRequest,
  ActionPolicyService,
  actionGateFacts,
  type AuditLedgerPort,
  type AuthorityFence,
  type AuthorizationStorePort,
  BUILT_IN_ACTION_RULES,
  type CapabilityAuthorizationFactsPort,
  type ClockPort,
  computeActionRisk,
  decideActionRules,
  type GovernedActionIntent,
  type IdGeneratorPort,
  type IdempotentAgentCommand,
  type PermissionDecision,
  POLICY_FACT_CODES,
  type PolicyFactCode,
  type ProductConfiguration,
  RUN_SOURCE_FACT,
  RuleJudge,
  type RuleHit,
  type RuleRecord,
  type RunExecutionSource,
  type RunExecutionSourcePort,
  type RuntimeToolInvocation,
  runtimePolicyFacts,
  type ToolActionRegistry,
  type ToolActionRow,
} from "@himawari-agent/application";
import { APPROVAL_ALLOWANCE_INTENT_PREFIX } from "@himawari-agent/gateway-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  type ContextExternalContent,
  type ExternalContentSource,
  externalEventOrigin,
} from "./context-external-content.js";
import type { OwnerAllowances } from "./owner-allowances.js";
import type { OwnerIntentGate } from "./owner-intent-gate.js";
import type { ProductionMessageOptions } from "./production-message-options.js";
import { appendAuditRecord, applyOwnerPolicyAuthorization } from "./owner-policy-authorization.js";
import { parameterFingerprint } from "./parameter-fingerprint.js";
import { BUILT_IN_CAPABILITY_VERSION, builtInCapabilityFacts } from "./production-tool-actions.js";

export { parameterFingerprint };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface OwnerScopeDecisionContext {
  readonly tool: string;
  readonly parameterFingerprint: string;
  readonly externalSources: readonly string[];
  readonly display?: () => Promise<ApprovalDisplayInput>;
}

export interface OwnerScopeIntentExtras {
  readonly targets?: readonly { readonly type: string; readonly ref: string }[];
  readonly display?: () => Promise<ApprovalDisplayInput>;
  readonly step?: string;
}

const ASKED_BECAUSE_SOURCES = 5;

export const OWNER_SCOPE_POLICY_VERSION = "owner-scope.v1";

export function actionRefusalKey(intentId: string): string {
  return `action-refusal:${intentId}`;
}

export function actionRuleAuthorizationKey(ruleId: string): string {
  return `action-rule:${ruleId}`;
}

export interface OwnerScopeAuthorizationOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly store: AuthorizationStorePort;
  readonly audit: AuditLedgerPort;
  readonly state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
  readonly authority: () => AuthorityFence;
  readonly source: RunExecutionSourcePort;
  readonly installedCapabilities: CapabilityAuthorizationFactsPort;
  readonly registry: ToolActionRegistry;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly intentLifetimeMs: number;
  readonly rules?: readonly RuleRecord[];
  readonly externalContent?: Pick<ContextExternalContent, "read" | "mark">;
  readonly ownerIntent?: Pick<OwnerIntentGate, "confirm">;
  readonly allowances?: Pick<OwnerAllowances, "match">;
  readonly optionGrants?: Pick<ProductionMessageOptions, "claimGrant">;
}

export interface OwnerScopeFreeze {
  (key: string, value: unknown): Promise<unknown>;
}

function askedBecause(hit: RuleHit, externalSources: readonly string[]): ApprovalAskedBecause {
  const shown = externalSources.slice(0, ASKED_BECAUSE_SOURCES);
  const more = externalSources.length > shown.length ? `等 ${externalSources.length} 个来源` : "";
  const sources =
    shown.length > 0 ? `（${shown.map((source) => source.slice(0, 80)).join("、")}${more}）` : "";
  return Object.freeze({
    kind: "rule" as const,
    ruleId: hit.id,
    ruleText:
      hit.id === ACTION_RULE_IDS.askAfterExternalContent
        ? `这次对话里读过外来内容${sources}，读过之后要做有后果的事，先问你`
        : hit.id,
  });
}

function denied(reasonCode: string): PermissionDecision {
  return Object.freeze({ decision: "DENY", reasonCode, alternativesAllowed: false });
}

export class OwnerScopeAuthorization {
  readonly #options: OwnerScopeAuthorizationOptions;
  readonly #policy: ActionPolicyService;
  readonly #judge = new RuleJudge();

  constructor(options: OwnerScopeAuthorizationOptions) {
    if (!Number.isSafeInteger(options.intentLifetimeMs) || options.intentLifetimeMs < 1)
      throw new Error("OWNER_SCOPE_INTENT_LIFETIME_INVALID");
    this.#options = options;
    this.#policy = new ActionPolicyService({
      store: options.store,
      capabilities: {
        inspect: async (ref) =>
          (await options.installedCapabilities.inspect(ref)) ??
          builtInCapabilityFacts(options.registry, ref),
      },
      policy: { version: OWNER_SCOPE_POLICY_VERSION, rules: [] },
      clock: options.clock,
      ids: options.ids,
    });
  }

  async authorize(
    invocation: RuntimeToolInvocation,
    row: ToolActionRow,
    freeze: OwnerScopeFreeze,
    signal?: AbortSignal,
    extras: OwnerScopeIntentExtras = {},
  ): Promise<PermissionDecision> {
    signal?.throwIfAborted();
    const { configuration, clock } = this.#options;
    if (row.authorization !== "owner_scope" || row.capabilityRef !== invocation.capabilityRef)
      return denied("tool_action_not_registered");
    const source = await this.#options.source.read(invocation.runId);
    if (
      !source ||
      source.runId !== invocation.runId ||
      source.ownerId !== configuration.ownerId ||
      source.agentId !== configuration.agentId
    )
      return denied("run_source_unavailable");
    const now = clock.now();
    const deadline = invocation.executionDeadlineAt;
    const expiresAt = new Date(
      deadline !== undefined && Number.isFinite(Date.parse(deadline))
        ? Date.parse(deadline)
        : Date.parse(now) + this.#options.intentLifetimeMs,
    ).toISOString();
    const inputDigest = digest(invocation.arguments);
    const id = `${APPROVAL_ALLOWANCE_INTENT_PREFIX}${digest([
      invocation.runId,
      invocation.toolCallId,
      invocation.capabilityRef,
      inputDigest,
      ...(extras.step === undefined ? [] : [extras.step]),
    ])}`;
    const externalSources = await this.#externalSources(invocation, source);
    const factCodes: PolicyFactCode[] = [RUN_SOURCE_FACT[source.sourceType]];
    if (externalSources.length > 0) factCodes.push(POLICY_FACT_CODES.contextExternalContent);
    if (row.ownerPresenceRequired) factCodes.push(POLICY_FACT_CODES.ownerPresenceRequired);
    if (row.standingRuleChange) factCodes.push(POLICY_FACT_CODES.standingRuleChange);
    if (row.himawariSideOnly) factCodes.push(POLICY_FACT_CODES.himawariSideOnly);
    const threadId = invocation.context?.threadId ?? source.threadId ?? `run:${invocation.runId}`;
    const build = (codes: readonly PolicyFactCode[]): GovernedActionIntent => {
      const unrated: Omit<GovernedActionIntent, "finalRisk"> = {
        contractVersion: "authorization.v2",
        id,
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        runId: invocation.runId,
        threadId,
        capabilityRef: invocation.capabilityRef,
        capabilityVersion: BUILT_IN_CAPABILITY_VERSION,
        operation: row.operation,
        resourceRef: id,
        resourceRefs: [id],
        targets: [
          { type: row.targetType, ref: configuration.ownerId },
          { type: "tool", ref: row.tool },
          { type: "input-digest", ref: inputDigest },
          ...(extras.targets ?? []),
        ],
        dataClassification: invocation.dataClassification,
        sideEffect: row.sideEffect,
        estimatedCostMicros: 0,
        frequency: { count: 1, intervalMs: null },
        idempotencyKey: id as GovernedActionIntent["idempotencyKey"],
        reversible: row.reversible,
        requestedAt: now,
        expiresAt,
        actionKind: row.actionKind,
        disclosure: row.disclosure,
        recipients: [],
        credentialOrAccessChange: false,
        modelClassification: {
          actionKind: row.actionKind,
          suggestedRisk: ACTION_KIND_RISK_BASELINE[row.actionKind],
          reasonCode: "product_owner_scope",
        },
        deterministicFacts: runtimePolicyFacts(codes),
      };
      return {
        ...unrated,
        finalRisk: computeActionRisk({ ...unrated, finalRisk: "LOW" }),
      };
    };
    let proposed = build(factCodes);
    if (
      this.#options.ownerIntent &&
      (await this.#options.ownerIntent.confirm({
        intent: proposed,
        source,
        row,
        invocation,
        externalSources,
      }))
    )
      proposed = build([...factCodes, POLICY_FACT_CODES.ownerIntentConfirmed]);
    if (expiresAt <= now) return denied("intent_expired");
    const intent = (await freeze(`owner-scope-intent:${id}`, proposed)) as GovernedActionIntent;
    if (
      intent.id !== id ||
      intent.runId !== invocation.runId ||
      intent.capabilityRef !== row.capabilityRef
    )
      return denied("intent_identity_changed");
    return this.decide(intent, source.sourceType, signal, {
      tool: row.tool,
      parameterFingerprint: parameterFingerprint(invocation.arguments),
      externalSources,
      ...(extras.display ? { display: extras.display } : {}),
    });
  }

  async #externalSources(
    invocation: RuntimeToolInvocation,
    source: RunExecutionSource,
  ): Promise<readonly string[]> {
    const marks = this.#options.externalContent;
    const eventOrigin = externalEventOrigin(source);
    if (!marks) return eventOrigin === null ? [] : [eventOrigin];
    if (eventOrigin !== null) await marks.mark(invocation.runId, eventOrigin);
    const found: ExternalContentSource[] = [...(await marks.read(invocation.runId))];
    return [...new Set(found.map(({ origin }) => origin))].sort();
  }

  async approvalOutcome(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: "unknown" | "pending" }
    | { readonly kind: "denied" | "expired" }
    | { readonly kind: "allowed"; readonly recentlyAuthenticated: boolean }
    | { readonly kind: "refused"; readonly reasonCode: string }
  > {
    const { configuration, clock, store } = this.#options;
    const approval = await store.getApproval(approvalId);
    if (
      !approval ||
      approval.ownerId !== configuration.ownerId ||
      approval.agentId !== configuration.agentId ||
      !("contractVersion" in approval.intentSnapshot)
    )
      return { kind: "unknown" };
    if (approval.status === "pending")
      return clock.now() >= approval.expiresAt ? { kind: "expired" } : { kind: "pending" };
    if (approval.status === "denied" || approval.status === "expired")
      return { kind: approval.status };
    const source = await this.#options.source.read(approval.runId);
    if (!source) return { kind: "refused", reasonCode: "run_source_unavailable" };
    const decision = await this.decide(
      approval.intentSnapshot as GovernedActionIntent,
      source.sourceType,
      signal,
    );
    if (decision.decision !== "ALLOW")
      return {
        kind: "refused",
        reasonCode: decision.decision === "DENY" ? decision.reasonCode : "approval_pending",
      };
    const governed = approval as ApprovalRequest & {
      readonly recentAuthenticationRef?: string | null;
    };
    return {
      kind: "allowed",
      recentlyAuthenticated:
        typeof governed.recentAuthenticationRef === "string" &&
        governed.recentAuthenticationRef !== "",
    };
  }

  async decide(
    intent: GovernedActionIntent,
    sourceType: RunExecutionSource["sourceType"],
    signal?: AbortSignal,
    context?: OwnerScopeDecisionContext,
  ): Promise<PermissionDecision> {
    const { clock } = this.#options;
    const id = intent.id;
    signal?.throwIfAborted();
    const rule = decideActionRules(
      this.#judge,
      actionGateFacts(intent, sourceType),
      this.#options.rules ?? BUILT_IN_ACTION_RULES,
    );
    if (rule.outcome === "refuse") {
      await this.#audit(intent, rule.hit, sourceType, context);
      return Object.freeze({
        decision: "DENY",
        reasonCode: "action_rule_refused",
        alternativesAllowed: true,
      });
    }
    const standing =
      rule.outcome === "allow_preauthorized" && rule.hit
        ? await this.#standingAuthorization(rule.hit)
        : undefined;
    if (standing && rule.hit)
      await applyOwnerPolicyAuthorization({
        store: this.#options.store,
        clock,
        ids: this.#options.ids,
        intent,
        key: standing.key,
        revision: standing.revision,
        auditId: `owner-scope-preauthorized:${digest([id, rule.hit.id, rule.hit.revision])}`,
        auditAction: "authorization.action_rule.preauthorized",
        appendAudit: (record) => appendAuditRecord(this.#options.audit, record),
      });
    const allowance =
      standing === undefined ? await this.#options.allowances?.match(intent) : undefined;
    if (allowance)
      await applyOwnerPolicyAuthorization({
        store: this.#options.store,
        clock,
        ids: this.#options.ids,
        intent,
        key: allowance.key,
        revision: allowance.revision,
        auditId: `owner-scope-allowance:${digest([id, allowance.key, allowance.revision])}`,
        auditAction: "authorization.owner_allowance.used",
        appendAudit: (record) => appendAuditRecord(this.#options.audit, record),
      });
    const chosen =
      standing === undefined && allowance === undefined && context
        ? await this.#options.optionGrants?.claimGrant({
            runId: intent.runId,
            tool: context.tool,
            parameterFingerprint: context.parameterFingerprint,
            intentId: id,
          })
        : undefined;
    if (chosen) {
      await applyOwnerPolicyAuthorization({
        store: this.#options.store,
        clock,
        ids: this.#options.ids,
        intent,
        key: chosen.key,
        revision: chosen.revision,
        auditId: `owner-scope-option:${digest([id, chosen.key, chosen.revision])}`,
        auditAction: "authorization.owner_option.chosen",
        appendAudit: (record) => appendAuditRecord(this.#options.audit, record),
      });
    }
    return this.#policy.evaluate(intent, {
      uiAvailable: true,
      approvalExpiresAt: intent.expiresAt,
      ...(context?.display ? { display: context.display } : {}),
      ...(rule.outcome === "ask_owner" && rule.hit
        ? { askedBecause: askedBecause(rule.hit, context?.externalSources ?? []) }
        : {}),
      ...(signal ? { signal } : {}),
    });
  }

  async #standingAuthorization(
    hit: RuleHit,
  ): Promise<{ readonly key: string; readonly revision: number } | undefined> {
    const { configuration, state, clock } = this.#options;
    const key = actionRuleAuthorizationKey(hit.id);
    const read = () => state.readScopedState(configuration.ownerId, configuration.agentId, key);
    let record = await read();
    if (record && record.value["enabled"] !== true) return undefined;
    if (!record || record.value["ruleRevision"] !== hit.revision) {
      const value = { enabled: true, ruleRevision: hit.revision, actorId: "default" };
      const idempotencyKey = `${key}:rule-revision:${hit.revision}`;
      await state.commitStateAndEvents({
        command: {
          ownerId: configuration.ownerId,
          agentId: configuration.agentId,
          commandType: "authorization.action_rule.default",
          idempotencyKey: idempotencyKey as IdempotentAgentCommand["idempotencyKey"],
          commandFingerprint: digest(value),
          authority: this.#options.authority(),
        },
        state: { key, expectedRevision: record?.revision ?? null, value },
        events: [],
        resultRef: key,
        committedAt: clock.now(),
      });
      record = await read();
      if (!record || record.value["enabled"] !== true) return undefined;
    }
    return { key, revision: record.revision };
  }

  async #audit(
    intent: GovernedActionIntent,
    hit: RuleHit | null,
    sourceType: RunExecutionSource["sourceType"],
    context: OwnerScopeDecisionContext | undefined,
  ): Promise<void> {
    const { configuration, state, clock } = this.#options;
    const key = actionRefusalKey(intent.id);
    const refusedAt = clock.now();
    const value = {
      intentId: intent.id,
      runId: intent.runId,
      ruleId: hit?.id ?? null,
      ruleRevision: hit?.revision ?? null,
      runSource: sourceType,
      tool: context?.tool ?? intent.capabilityRef,
      capabilityRef: intent.capabilityRef,
      parameterFingerprint: context?.parameterFingerprint ?? null,
      externalSources: [...(context?.externalSources ?? [])],
      refusedAt,
    };
    const read = () => state.readScopedState(configuration.ownerId, configuration.agentId, key);
    let existing = await read();
    if (!existing) {
      await state
        .commitStateAndEvents({
          command: {
            ownerId: configuration.ownerId,
            agentId: configuration.agentId,
            commandType: "authorization.action_rule.refused",
            idempotencyKey: key as IdempotentAgentCommand["idempotencyKey"],
            commandFingerprint: digest(value),
            authority: this.#options.authority(),
          },
          state: { key, expectedRevision: null, value },
          events: [],
          resultRef: key,
          committedAt: refusedAt,
        })
        .catch(async (error: unknown) => {
          if (!(await read())) throw error;
        });
      existing = await read();
    }
    const recorded = existing?.value["refusedAt"];
    await appendAuditRecord(this.#options.audit, {
      id: `owner-scope-rule:${digest([intent.id, `refused:${hit?.id ?? ""}`])}`,
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      action: "authorization.action_rule.refused",
      targetRef: key,
      outcome: "rejected",
      occurredAt: typeof recorded === "string" ? recorded : refusedAt,
    });
  }
}
