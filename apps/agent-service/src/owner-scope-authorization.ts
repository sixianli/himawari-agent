import { createHash } from "node:crypto";
import {
  ACTION_KIND_RISK_BASELINE,
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
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { appendAuditRecord, applyOwnerPolicyAuthorization } from "./owner-policy-authorization.js";
import { BUILT_IN_CAPABILITY_VERSION, builtInCapabilityFacts } from "./production-tool-actions.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const OWNER_SCOPE_POLICY_VERSION = "owner-scope.v1";

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
}

export interface OwnerScopeFreeze {
  (key: string, value: unknown): Promise<unknown>;
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
    const id = `owner-scope:${digest([
      invocation.runId,
      invocation.toolCallId,
      invocation.capabilityRef,
      inputDigest,
    ])}`;
    const factCodes: PolicyFactCode[] = [RUN_SOURCE_FACT[source.sourceType]];
    if (row.ownerPresenceRequired) factCodes.push(POLICY_FACT_CODES.ownerPresenceRequired);
    if (row.standingRuleChange) factCodes.push(POLICY_FACT_CODES.standingRuleChange);
    const unrated: Omit<GovernedActionIntent, "finalRisk"> = {
      contractVersion: "authorization.v2",
      id,
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      runId: invocation.runId,
      threadId: invocation.context?.threadId ?? source.threadId ?? `run:${invocation.runId}`,
      capabilityRef: row.capabilityRef,
      capabilityVersion: BUILT_IN_CAPABILITY_VERSION,
      operation: row.operation,
      resourceRef: id,
      resourceRefs: [id],
      targets: [
        { type: row.targetType, ref: configuration.ownerId },
        { type: "tool", ref: row.tool },
        { type: "input-digest", ref: inputDigest },
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
      deterministicFacts: runtimePolicyFacts(factCodes),
    };
    const proposed: GovernedActionIntent = {
      ...unrated,
      finalRisk: computeActionRisk({ ...unrated, finalRisk: "LOW" }),
    };
    if (expiresAt <= now) return denied("intent_expired");
    const intent = (await freeze(`owner-scope-intent:${id}`, proposed)) as GovernedActionIntent;
    if (
      intent.id !== id ||
      intent.runId !== invocation.runId ||
      intent.capabilityRef !== row.capabilityRef
    )
      return denied("intent_identity_changed");
    return this.decide(intent, source.sourceType, signal);
  }

  async decide(
    intent: GovernedActionIntent,
    sourceType: RunExecutionSource["sourceType"],
    signal?: AbortSignal,
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
      await this.#audit(intent, `refused:${rule.hit?.id ?? ""}`, "rejected");
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
    return this.#policy.evaluate(intent, {
      uiAvailable: true,
      approvalExpiresAt: intent.expiresAt,
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

  async #audit(intent: GovernedActionIntent, detail: string, outcome: "rejected"): Promise<void> {
    await appendAuditRecord(this.#options.audit, {
      id: `owner-scope-rule:${digest([intent.id, detail])}`,
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      action: "authorization.action_rule.refused",
      targetRef: intent.id,
      outcome,
      occurredAt: this.#options.clock.now(),
    });
  }
}
