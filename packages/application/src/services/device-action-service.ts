import { createIdempotencyKey, createRunId } from "@himawari-agent/domain";
import {
  TOOL_RESULT_DEVICE_ACTION_REASON_APPROVAL_NOT_CONNECTED,
  TOOL_RESULT_DEVICE_ACTION_REASON_DENIED,
  TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_LOST_RECORD,
  TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_POLICY,
  TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_REVOKED,
  TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_UNSUPPORTED,
  TOOL_RESULT_DEVICE_ACTION_REASON_NOT_DELIVERED,
  TOOL_RESULT_DEVICE_ACTION_REASON_OWNER_DENIED,
  TOOL_RESULT_DEVICE_ACTION_REASON_PRESENCE_UNPROVEN,
  TOOL_RESULT_DEVICE_ACTION_REASON_REPORT_MISSING,
  TOOL_RESULT_DEVICE_ACTION_REASON_TARGET_UNKNOWN,
} from "@himawari-agent/prompt-catalog";
import type { ActionKind, ActionRiskLevel, GovernedActionIntent } from "../ports/authorization.js";
import type { DataClassification } from "../ports/common.js";
import type { DecisionLedgerPort } from "../ports/decision-ledger.js";
import {
  DEVICE_ACTION_ID_PATTERN,
  DEVICE_ACTION_REPORT_OUTCOMES,
  type DeviceActionAuthorization,
  type DeviceActionAuthorizationPort,
  type DeviceActionDeliveryMode,
  type DeviceActionDeliveryPort,
  type DeviceActionIntent,
  type DeviceActionOpenRequestPort,
  type DeviceActionReasonCode,
  type DeviceActionRecord,
  type DeviceActionRecordState,
  type DeviceActionReportOutcome,
  type DeviceActionStorePort,
  type DevicePolicy,
} from "../ports/device-actions.js";
import type { PairedDevice, PairedDeviceScope } from "../ports/paired-devices.js";
import type { DeviceMirrorItem, DeviceMirrorKind } from "../ports/perception.js";
import { computeActionRisk } from "./action-policy-service.js";
import {
  DEVICE_ACTION_LOCALES,
  type DeviceActionArguments,
  type DeviceActionContext,
  type DeviceActionDetail,
  type DeviceActionReadBack,
  type DeviceActionRegistration,
  type DeviceActionRegistry,
  type DeviceActionTarget,
  type DeviceActionTargetData,
  type DeviceActionUndoPlan,
  describeDeviceActionParameters,
  deviceActionFingerprint,
  validateDeviceActionArguments,
} from "./device-action-registry.js";

export const DEVICE_ACTION_RESULT_MAXIMUM_BYTES = 64 * 1024;
export const DEVICE_ACTION_LISTED_TARGET_DAYS = 7;
export const DEVICE_ACTION_LISTED_TARGET_READS = 500;
export const DEVICE_ACTION_REASON_MAXIMUM_CHARACTERS = 500;

const MODEL_REASONS: Readonly<Record<DeviceActionReasonCode, string | null>> = Object.freeze({
  approval_not_connected: TOOL_RESULT_DEVICE_ACTION_REASON_APPROVAL_NOT_CONNECTED.text,
  authorization_denied: TOOL_RESULT_DEVICE_ACTION_REASON_DENIED.text,
  owner_denied: TOOL_RESULT_DEVICE_ACTION_REASON_OWNER_DENIED.text,
  owner_presence_unproven: TOOL_RESULT_DEVICE_ACTION_REASON_PRESENCE_UNPROVEN.text,
  device_policy: TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_POLICY.text,
  device_revoked: TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_REVOKED.text,
  device_unsupported: TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_UNSUPPORTED.text,
  device_reported: null,
  report_missing: TOOL_RESULT_DEVICE_ACTION_REASON_REPORT_MISSING.text,
  device_lost_record: TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_LOST_RECORD.text,
  not_delivered_in_time: TOOL_RESULT_DEVICE_ACTION_REASON_NOT_DELIVERED.text,
});

export const DEVICE_ACTION_TARGET_UNKNOWN_NOTE =
  TOOL_RESULT_DEVICE_ACTION_REASON_TARGET_UNKNOWN.text;

export interface DeviceActionSettings {
  readonly expirySeconds: number;
  readonly presenceExpirySeconds: number;
  readonly waitMilliseconds: number;
  readonly claimBatch: number;
}

export interface DeviceActionContentPort {
  save(input: {
    readonly ref: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly dataClassification: DataClassification;
  }): Promise<void>;
  read(ref: string): Promise<Readonly<Record<string, unknown>> | undefined>;
  discard(ref: string): Promise<void>;
}

export interface DeviceActionServiceOptions {
  readonly scope: PairedDeviceScope;
  readonly registry: DeviceActionRegistry;
  readonly store: DeviceActionStorePort;
  readonly devices: (scope: PairedDeviceScope) => Promise<readonly PairedDevice[]>;
  readonly mirror: (
    input: PairedDeviceScope & {
      readonly kind: DeviceMirrorKind;
      readonly includeDeleted: boolean;
    },
  ) => Promise<readonly DeviceMirrorItem[]>;
  readonly authorization: DeviceActionAuthorizationPort;
  readonly delivery: DeviceActionDeliveryPort;
  readonly openRequests?: DeviceActionOpenRequestPort;
  readonly ledger: Pick<DecisionLedgerPort, "append">;
  readonly content: DeviceActionContentPort;
  readonly settings: () => DeviceActionSettings;
  readonly timeZone: string;
  readonly now: () => string;
  readonly newId: () => string;
  readonly onReadFailed?: (failure: DeviceActionReadFailure) => void;
}

export interface DeviceActionReadFailure {
  readonly event: "device_action.read_failed";
  readonly action: string;
  readonly deviceId: string;
  readonly outcome: Exclude<DeviceActionReportOutcome, "succeeded">;
}

export interface DeviceActionDescription {
  readonly name: string;
  readonly reads: boolean;
  readonly confirm: boolean;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly usage?: string;
}

export type DeviceActionRequestOutcome =
  | { readonly kind: "invalid"; readonly note: string | null }
  | {
      readonly kind: "recorded";
      readonly actionId: string;
      readonly state: DeviceActionRecordState;
      readonly reason: string | null;
      readonly evidence: Readonly<Record<string, unknown>> | null;
      readonly detail: DeviceActionDetail;
    };

export interface DeviceActionDelivery {
  readonly id: string;
  readonly mode: DeviceActionDeliveryMode;
  readonly action: string;
  readonly schemaVersion: number;
  readonly arguments: DeviceActionArguments;
  readonly ownerPresence: boolean;
  readonly readBack: DeviceActionReadBack;
  readonly snapshotBefore: boolean;
  readonly reversible: boolean;
  readonly risk: ActionRiskLevel;
  readonly expiresAt: string;
  readonly detail: DeviceActionDetail;
  readonly confirmLabel: DeviceActionDetail;
  readonly declineLabel: DeviceActionDetail;
  readonly resultMaximumBytes: number;
}

export type DeviceActionUndoState = "none" | "available" | "pending" | "done" | "failed";

export type DeviceActionUndoOutcome =
  | { readonly kind: "not_found" | "not_undoable" }
  | DeviceActionRequestOutcome;

export interface DeviceActionView {
  readonly id: string;
  readonly deviceId: string;
  readonly action: string;
  readonly runId: string;
  readonly threadId: string | null;
  readonly state: DeviceActionRecordState;
  readonly detail: DeviceActionDetail;
  readonly confirmLabel: DeviceActionDetail;
  readonly declineLabel: DeviceActionDetail;
  readonly risk: ActionRiskLevel;
  readonly ownerPresence: boolean;
  readonly reversible: boolean;
  readonly undo: DeviceActionUndoState;
  readonly reasonCode: DeviceActionReasonCode | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DeviceActionReportReply =
  | { readonly kind: "recorded" | "replayed"; readonly state: DeviceActionRecordState }
  | { readonly kind: "invalid" | "not_found" | "not_delivered" | "verify_only" };

const undoToolCallId = (actionId: string, ownerPresent: boolean) =>
  ownerPresent ? `undo:${actionId}:owner` : `undo:${actionId}`;

const EMPTY_DETAIL: DeviceActionDetail = Object.freeze(
  Object.fromEntries(DEVICE_ACTION_LOCALES.map((locale) => [locale, ""])),
) as DeviceActionDetail;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RECONCILE_BATCH = 100;

export class ReadOnlyDeviceActionAuthorization implements DeviceActionAuthorizationPort {
  async authorize(intent: DeviceActionIntent): Promise<DeviceActionAuthorization> {
    if (intent.actionKind === "READ" && intent.risk === "LOW" && !intent.ownerPresence)
      return { decision: "allow", ownerPresent: false };
    return { decision: "deny", reasonCode: "approval_not_connected" };
  }
}

export class DeviceActionService {
  readonly #options: DeviceActionServiceOptions;

  constructor(options: DeviceActionServiceOptions) {
    this.#options = options;
  }

  descriptions(): readonly DeviceActionDescription[] {
    const { registry } = this.#options;
    return registry.names().map((name) => {
      const registration = registry.get(name) as DeviceActionRegistration;
      const reads = registration.actionKind === "READ" && registration.escalation === null;
      return Object.freeze({
        name,
        reads,
        confirm: !reads,
        parameters: describeDeviceActionParameters(registration.parameters),
        ...(registration.usage === undefined ? {} : { usage: registration.usage }),
      });
    });
  }

  async offered(device: PairedDevice): Promise<readonly string[]> {
    const policy = await this.#options.store.readPolicy({
      ...this.#options.scope,
      deviceId: device.id,
    });
    return this.#allowed(device, policy);
  }

  #allowed(device: PairedDevice, policy: DevicePolicy): readonly string[] {
    return this.#options.registry
      .supportedBy(device.kind, device.supportedActions)
      .filter((name) => !policy.blockedActions.includes(name));
  }

  #localTime = (milliseconds: number): string => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: this.#options.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(milliseconds))
        .map(({ type, value }) => [type, value]),
    );
    return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}`;
  };

  async #context(
    registration: DeviceActionRegistration,
    args: DeviceActionArguments,
    deviceId: string,
  ): Promise<DeviceActionContext | undefined> {
    const rule = registration.target;
    const id = rule === null ? undefined : args[rule.idKey];
    if (rule === null || id === undefined) return { target: null, localTime: this.#localTime };
    const item = (
      await this.#options.mirror({
        ...this.#options.scope,
        kind: rule.mirrorKind,
        includeDeleted: false,
      })
    ).find((entry) => entry.deviceId === deviceId && entry.externalId === id);
    if (item && item.data !== null) return { target: item.data, localTime: this.#localTime };
    const listed = rule.listedBy ? await this.#listed(rule, id, deviceId) : null;
    return listed ? { target: listed, localTime: this.#localTime } : undefined;
  }

  async #listed(
    rule: DeviceActionTarget,
    id: unknown,
    deviceId: string,
  ): Promise<DeviceActionTargetData | null> {
    const lister = rule.listedBy;
    if (!lister || typeof id !== "string") return null;
    const since = new Date(
      Date.parse(this.#options.now()) - DEVICE_ACTION_LISTED_TARGET_DAYS * 86_400_000,
    ).toISOString();
    const reads = (
      await this.#options.store.list({
        ...this.#options.scope,
        deviceId,
        states: ["succeeded"],
        limit: DEVICE_ACTION_LISTED_TARGET_READS,
        finishedSince: since,
      })
    )
      .filter((record) => record.action === lister.action && record.resultRef !== null)
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
    for (const record of reads) {
      const stored = await this.#options.content.read(record.resultRef as string);
      const evidence = plainObject(stored?.["evidence"]) ? stored["evidence"] : null;
      const done = plainObject(evidence?.["done"]) ? evidence["done"] : null;
      const items = Array.isArray(done?.[lister.list]) ? (done[lister.list] as unknown[]) : [];
      const found = items.find(
        (entry): entry is Record<string, unknown> => plainObject(entry) && entry[rule.idKey] === id,
      );
      if (found)
        return Object.freeze(
          Object.fromEntries(
            Object.entries(found).filter(
              (pair): pair is [string, string | number | boolean] =>
                pair[0] !== rule.idKey && ["string", "number", "boolean"].includes(typeof pair[1]),
            ),
          ),
        );
    }
    return null;
  }

  async #detail(record: DeviceActionRecord): Promise<{
    readonly detail: DeviceActionDetail;
    readonly arguments: DeviceActionArguments;
    readonly registration: DeviceActionRegistration | undefined;
  }> {
    const stored = await this.#options.content.read(record.argumentsRef);
    const args = plainObject(stored?.["arguments"]) ? stored["arguments"] : {};
    const detail = plainObject(stored?.["detail"])
      ? (stored["detail"] as DeviceActionDetail)
      : EMPTY_DETAIL;
    return { detail, arguments: args, registration: this.#options.registry.get(record.action) };
  }

  async #ledger(record: DeviceActionRecord): Promise<void> {
    await this.#options.ledger.append({
      id: `ledger:device-action:${record.id}:${record.state}`,
      ...this.#options.scope,
      kind: "device_action",
      decidedAt: record.updatedAt,
      outcome: record.state,
      reasonCode: `device_action_${record.reasonCode ?? record.actionKind.toLowerCase()}`,
      subjectRef: record.id,
      inputs: { memoryIds: [], ruleIds: [] },
      reasonRef: null,
      contentRef: null,
      costMicros: 0,
      durationMs: 0,
    });
  }

  async reconcile(approvalId?: string): Promise<void> {
    const { authorization, store, scope } = this.#options;
    const resolve = authorization.resolve?.bind(authorization);
    if (!resolve) return;
    const waiting = await store.list({
      ...scope,
      deviceId: null,
      states: ["waiting_owner"],
      limit: RECONCILE_BATCH,
      ...(approvalId === undefined ? {} : { approvalId }),
    });
    for (const record of waiting) {
      if (record.approvalId === null) continue;
      const outcome = await resolve(record.approvalId);
      if (outcome.decision === "pending") continue;
      await this.#apply({
        actionId: record.id,
        approved: outcome.decision === "allow",
        ownerPresent: outcome.decision === "allow" && outcome.ownerPresent,
      });
    }
  }

  async settle(): Promise<void> {
    await this.reconcile();
    const settled = await this.#options.store.settleDue({
      ...this.#options.scope,
      now: this.#options.now(),
    });
    for (const record of [...settled.expired, ...settled.unknown]) {
      await this.#ledger(record);
      this.#options.delivery.settled(record.id);
    }
  }

  async #outcome(record: DeviceActionRecord): Promise<DeviceActionRequestOutcome> {
    const { detail } = await this.#detail(record);
    const result =
      record.resultRef === null ? undefined : await this.#options.content.read(record.resultRef);
    const reported = typeof result?.["reason"] === "string" ? result["reason"] : null;
    return {
      kind: "recorded",
      actionId: record.id,
      state: record.state,
      reason:
        record.reasonCode === null ? reported : (MODEL_REASONS[record.reasonCode] ?? reported),
      evidence: plainObject(result?.["evidence"]) ? result["evidence"] : null,
      detail,
    };
  }

  async request(input: {
    readonly runId: string;
    readonly toolCallId: string;
    readonly dataClassification: DataClassification;
    readonly device: PairedDevice;
    readonly action: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<DeviceActionRequestOutcome> {
    const { scope, store, registry } = this.#options;
    await this.settle();
    const replayed = await store.readInvocation({
      ...scope,
      runId: input.runId,
      toolCallId: input.toolCallId,
    });
    if (replayed) return this.#repeated(replayed, input.device.id, input.action);
    const registration = registry.get(input.action);
    if (!registration) return { kind: "invalid", note: null };
    const args = validateDeviceActionArguments(registration.parameters, input.arguments);
    if (!args) return { kind: "invalid", note: null };
    const context = await this.#context(registration, args, input.device.id);
    if (!context) return { kind: "invalid", note: DEVICE_ACTION_TARGET_UNKNOWN_NOTE };
    const now = this.#options.now();
    const settings = this.#options.settings();
    const actionKind = registry.kindOf(registration, args, context);
    const ownerPresence = registration.ownerPresence(args, context);
    const id = this.#options.newId();
    if (!DEVICE_ACTION_ID_PATTERN.test(id)) throw new Error("DEVICE_ACTION_ID_INVALID");
    const expiresAt = new Date(
      Date.parse(now) +
        (ownerPresence ? settings.presenceExpirySeconds : settings.expirySeconds) * 1000,
    ).toISOString();
    const targetRef = registration.target === null ? undefined : args[registration.target.idKey];
    const target =
      registration.target === null || targetRef === undefined
        ? null
        : { type: registration.target.mirrorKind, ref: String(targetRef) };
    const risk = this.#risk({
      id,
      runId: input.runId,
      toolCallId: input.toolCallId,
      action: input.action,
      schemaVersion: registration.schemaVersion,
      actionKind,
      reversible: registration.reversible,
      target,
      deviceId: input.device.id,
      dataClassification: input.dataClassification,
      recipients: registration.recipients?.(args) ?? [],
      now,
      expiresAt,
    });
    const detail = registration.detail(args, context);
    const policy = await store.readPolicy({ ...scope, deviceId: input.device.id });
    const supported = registry
      .supportedBy(input.device.kind, input.device.supportedActions)
      .includes(input.action);
    const intent: DeviceActionIntent = {
      ...scope,
      actionId: id,
      runId: input.runId,
      toolCallId: input.toolCallId,
      deviceId: input.device.id,
      deviceKind: input.device.kind,
      action: input.action,
      schemaVersion: registration.schemaVersion,
      arguments: args,
      actionKind,
      risk,
      target,
      reversible: registration.reversible,
      ownerPresence,
      title: registration.title,
      detail,
      dataClassification: input.dataClassification,
      requestedAt: now,
      expiresAt,
    };
    const decision: DeviceActionAuthorization = !supported
      ? { decision: "deny", reasonCode: "device_unsupported" }
      : policy.blockedActions.includes(input.action)
        ? { decision: "deny", reasonCode: "device_policy" }
        : await this.#options.authorization.authorize(intent);
    const verdict: DeviceActionAuthorization =
      decision.decision === "allow" && ownerPresence && !decision.ownerPresent
        ? { decision: "deny", reasonCode: "owner_presence_unproven" }
        : decision;
    const argumentsRef = `device-action:${id}:arguments`;
    await this.#options.content.save({
      ref: argumentsRef,
      value: { arguments: args, detail },
      dataClassification: input.dataClassification,
    });
    const inserted = await store
      .insert({
        ...scope,
        id,
        deviceId: input.device.id,
        action: input.action,
        schemaVersion: registration.schemaVersion,
        argumentsRef,
        fingerprint: deviceActionFingerprint(input.action, args),
        actionKind,
        risk,
        ownerPresence,
        approvalId: verdict.decision === "approval" ? verdict.approvalId : null,
        dataClassification: input.dataClassification,
        state:
          verdict.decision === "allow"
            ? "queued"
            : verdict.decision === "approval"
              ? "waiting_owner"
              : "rejected",
        reasonCode: verdict.decision === "deny" ? verdict.reasonCode : null,
        runId: input.runId,
        toolCallId: input.toolCallId,
        now,
        expiresAt,
      })
      .catch(async (error: unknown) => {
        await this.#options.content.discard(argumentsRef).catch(() => undefined);
        throw error;
      });
    if (inserted.kind !== "created") {
      await this.#options.content.discard(argumentsRef).catch(() => undefined);
      return this.#repeated(inserted.record, input.device.id, input.action);
    }
    await this.#ledger(inserted.record);
    if (inserted.record.state !== "queued") return this.#outcome(inserted.record);
    return this.#outcome(await this.#dispatch(inserted.record, detail, settings.waitMilliseconds));
  }

  async #repeated(
    record: DeviceActionRecord,
    deviceId: string,
    action: string,
  ): Promise<DeviceActionRequestOutcome> {
    if (record.deviceId !== deviceId || record.action !== action)
      return { kind: "invalid", note: null };
    if (record.state === "result_unknown" || record.state === "queued")
      this.#options.delivery.announce(record.deviceId);
    return this.#outcome(record);
  }

  async #dispatch(
    record: DeviceActionRecord,
    detail: DeviceActionDetail,
    waitMilliseconds: number,
  ): Promise<DeviceActionRecord> {
    const { delivery, store, scope } = this.#options;
    if (!delivery.connected(record.deviceId)) {
      await this.#options.openRequests?.requestOpen({ record, detail });
      return record;
    }
    const waiting = delivery.waitFor(record.id, waitMilliseconds);
    delivery.announce(record.deviceId);
    await waiting;
    return (await store.read({ ...scope, id: record.id })) ?? record;
  }

  #risk(input: {
    readonly id: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly action: string;
    readonly schemaVersion: number;
    readonly actionKind: ActionKind;
    readonly reversible: boolean;
    readonly target: { readonly type: string; readonly ref: string } | null;
    readonly deviceId: string;
    readonly dataClassification: DataClassification;
    readonly recipients: readonly string[];
    readonly now: string;
    readonly expiresAt: string;
  }): ActionRiskLevel {
    const resourceRef = input.target
      ? `${input.target.type}:${input.target.ref}`
      : `device:${input.deviceId}`;
    const intent: GovernedActionIntent = {
      id: input.id,
      ...this.#options.scope,
      runId: createRunId(input.runId),
      capabilityRef: "device.action",
      operation: input.action,
      resourceRef,
      dataClassification: input.dataClassification,
      sideEffect:
        input.actionKind === "READ" ? "none" : input.reversible ? "reversible" : "irreversible",
      estimatedCostMicros: 0,
      frequency: { count: 1, intervalMs: null },
      idempotencyKey: createIdempotencyKey(`${input.runId}:${input.toolCallId}`),
      reversible: input.reversible,
      requestedAt: input.now,
      contractVersion: "authorization.v2",
      threadId: "",
      actionKind: input.actionKind,
      capabilityVersion: String(input.schemaVersion),
      targets: input.target ? [input.target] : [],
      resourceRefs: [resourceRef],
      disclosure: input.recipients.length > 0 ? "named_recipients" : "none",
      recipients: input.recipients,
      credentialOrAccessChange: false,
      expiresAt: input.expiresAt,
      modelClassification: {
        actionKind: input.actionKind,
        suggestedRisk: "LOW",
        reasonCode: "device_action_registry",
      },
      deterministicFacts: [],
      finalRisk: "LOW",
    };
    return computeActionRisk(intent);
  }

  async #delivery(record: DeviceActionRecord): Promise<DeviceActionDelivery | undefined> {
    const { detail, arguments: args, registration } = await this.#detail(record);
    if (!registration) return undefined;
    return Object.freeze({
      id: record.id,
      mode: record.state === "result_unknown" ? "verify" : "perform",
      action: record.action,
      schemaVersion: record.schemaVersion,
      arguments: args,
      ownerPresence: record.ownerPresence,
      readBack: registration.readBack,
      snapshotBefore: registration.snapshotBefore,
      reversible: registration.reversible,
      risk: record.risk,
      expiresAt: record.expiresAt,
      detail,
      confirmLabel: registration.confirmLabel,
      declineLabel: registration.declineLabel,
      resultMaximumBytes: DEVICE_ACTION_RESULT_MAXIMUM_BYTES,
    });
  }

  async claim(deviceId: string): Promise<readonly DeviceActionDelivery[]> {
    await this.settle();
    const records = await this.#options.store.claim({
      ...this.#options.scope,
      deviceId,
      now: this.#options.now(),
      limit: this.#options.settings().claimBatch,
    });
    const deliveries: DeviceActionDelivery[] = [];
    for (const record of records) {
      if (record.state === "delivered" && record.deliveredAt === record.updatedAt)
        await this.#ledger(record);
      const delivery = await this.#delivery(record);
      if (delivery) deliveries.push(delivery);
    }
    return deliveries;
  }

  async reopen(deviceId: string): Promise<readonly DeviceActionDelivery[]> {
    await this.settle();
    const now = this.#options.now();
    const reopening = await this.#options.store.forget({
      ...this.#options.scope,
      deviceId,
      now,
      limit: this.#options.settings().claimBatch,
    });
    for (const record of reopening.forgotten) {
      await this.#ledger(record);
      this.#options.delivery.settled(record.id);
    }
    const deliveries: DeviceActionDelivery[] = [];
    for (const record of reopening.pending) {
      const delivery = await this.#delivery(record);
      if (delivery) deliveries.push(delivery);
    }
    return deliveries;
  }

  async report(
    deviceId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<DeviceActionReportReply> {
    const { id, outcome, readBack, evidence, reason } = body;
    if (
      Object.keys(body).some(
        (key) => !["id", "outcome", "readBack", "evidence", "reason"].includes(key),
      ) ||
      typeof id !== "string" ||
      !DEVICE_ACTION_ID_PATTERN.test(id) ||
      !(DEVICE_ACTION_REPORT_OUTCOMES as readonly unknown[]).includes(outcome) ||
      typeof readBack !== "boolean" ||
      (evidence !== undefined && !plainObject(evidence)) ||
      (reason !== undefined &&
        (typeof reason !== "string" ||
          reason.length === 0 ||
          [...reason].length > DEVICE_ACTION_REASON_MAXIMUM_CHARACTERS)) ||
      (outcome === "succeeded" && reason !== undefined) ||
      new TextEncoder().encode(JSON.stringify(evidence ?? {})).length >
        DEVICE_ACTION_RESULT_MAXIMUM_BYTES
    )
      return { kind: "invalid" };
    const { scope, store } = this.#options;
    const existing = await store.read({ ...scope, id });
    if (!existing || existing.deviceId !== deviceId) return { kind: "not_found" };
    const registration = this.#options.registry.get(existing.action);
    if (
      outcome === "succeeded" &&
      registration !== undefined &&
      registration.readBack !== "none" &&
      !readBack
    )
      return { kind: "invalid" };
    const resultRef =
      evidence === undefined && reason === undefined
        ? null
        : `device-action:${id}:result:${existing.revision}`;
    const accepted =
      existing.state === "delivered" ||
      (existing.state === "result_unknown" && readBack && outcome !== "result_unknown");
    if (resultRef !== null && accepted)
      await this.#options.content.save({
        ref: resultRef,
        value: { evidence: evidence ?? null, reason: reason ?? null },
        dataClassification: existing.dataClassification,
      });
    const reported = await store
      .report({
        ...scope,
        id,
        deviceId,
        outcome: outcome as DeviceActionReportOutcome,
        readBack,
        resultRef: accepted ? resultRef : null,
        reasonCode: outcome === "succeeded" ? null : "device_reported",
        now: this.#options.now(),
      })
      .catch(async (error: unknown) => {
        if (resultRef !== null && accepted)
          await this.#options.content.discard(resultRef).catch(() => undefined);
        throw error;
      });
    if (reported.kind === "not_found" || reported.kind === "wrong_device")
      return { kind: "not_found" };
    if (reported.kind === "not_delivered" || reported.kind === "verify_only")
      return { kind: reported.kind };
    if (reported.kind === "recorded") {
      await this.#ledger(reported.record);
      this.#options.delivery.settled(id);
      if (registration?.actionKind === "READ" && outcome !== "succeeded")
        this.#options.onReadFailed?.({
          event: "device_action.read_failed",
          action: existing.action,
          deviceId,
          outcome: outcome as Exclude<DeviceActionReportOutcome, "succeeded">,
        });
    }
    return { kind: reported.kind, state: reported.record.state };
  }

  async reportSupported(
    device: PairedDevice,
    names: unknown,
  ): Promise<readonly string[] | undefined> {
    if (
      !Array.isArray(names) ||
      names.length > 500 ||
      names.some((name) => typeof name !== "string" || name.length === 0 || name.length > 64)
    )
      return undefined;
    const kept = this.#options.registry.supportedBy(device.kind, names as string[]);
    await this.#options.store.setSupportedActions({
      ...this.#options.scope,
      deviceId: device.id,
      actions: kept,
    });
    return kept;
  }

  async policy(device: PairedDevice): Promise<{
    readonly revision: number;
    readonly actions: readonly {
      readonly name: string;
      readonly title: DeviceActionDetail;
      readonly allowed: boolean;
    }[];
  }> {
    const policy = await this.#options.store.readPolicy({
      ...this.#options.scope,
      deviceId: device.id,
    });
    return {
      revision: policy.revision,
      actions: this.#options.registry
        .supportedBy(device.kind, device.supportedActions)
        .map((name) => ({
          name,
          title: this.#options.registry.get(name)?.title ?? EMPTY_DETAIL,
          allowed: !policy.blockedActions.includes(name),
        })),
    };
  }

  async changePolicy(input: {
    readonly device: PairedDevice;
    readonly ownerPresent: boolean;
    readonly expectedRevision: unknown;
    readonly blockedActions: unknown;
  }): Promise<"written" | "invalid" | "owner_presence_required" | "revision_conflict"> {
    if (!input.ownerPresent) return "owner_presence_required";
    const { registry, store, scope } = this.#options;
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      (input.expectedRevision as number) < 0 ||
      !Array.isArray(input.blockedActions) ||
      input.blockedActions.some((name) => typeof name !== "string" || !registry.get(name)) ||
      new Set(input.blockedActions).size !== input.blockedActions.length
    )
      return "invalid";
    const now = this.#options.now();
    const written = await store.writePolicy({
      ...scope,
      deviceId: input.device.id,
      expectedRevision: input.expectedRevision as number,
      blockedActions: input.blockedActions as string[],
      now,
    });
    if (written.kind === "revision_conflict") return "revision_conflict";
    for (const record of written.rejected) {
      await this.#ledger(record);
      this.#options.delivery.settled(record.id);
    }
    await this.#options.ledger.append({
      id: `ledger:device-policy:${input.device.id}:${written.policy.revision}`,
      ...scope,
      kind: "device_action",
      decidedAt: now,
      outcome: "policy_changed",
      reasonCode: "device_policy_owner_change",
      subjectRef: input.device.id,
      inputs: { memoryIds: [], ruleIds: [] },
      reasonRef: null,
      contentRef: null,
      costMicros: 0,
      durationMs: 0,
    });
    return "written";
  }

  async decide(input: {
    readonly actionId: string;
    readonly approved: boolean;
    readonly ownerPresent: boolean;
  }): Promise<DeviceActionRecordState | undefined> {
    await this.settle();
    return this.#apply(input);
  }

  async #apply(input: {
    readonly actionId: string;
    readonly approved: boolean;
    readonly ownerPresent: boolean;
  }): Promise<DeviceActionRecordState | undefined> {
    const { store, scope } = this.#options;
    const before = await store.read({ ...scope, id: input.actionId });
    if (!before) return undefined;
    const record = await store.decide({
      ...scope,
      id: input.actionId,
      approved: input.approved,
      ownerPresent: input.ownerPresent,
      now: this.#options.now(),
    });
    if (!record) return undefined;
    if (before.state === "waiting_owner" && record.state !== "waiting_owner") {
      await this.#ledger(record);
      if (record.state === "queued")
        await this.#dispatch(record, (await this.#detail(record)).detail, 0);
    }
    return record.state;
  }

  async #undoPlan(record: DeviceActionRecord): Promise<DeviceActionUndoPlan | null> {
    if (record.state !== "succeeded") return null;
    const registration = this.#options.registry.get(record.action);
    if (!registration?.undo) return null;
    const { arguments: args } = await this.#detail(record);
    const result =
      record.resultRef === null ? undefined : await this.#options.content.read(record.resultRef);
    const evidence = plainObject(result?.["evidence"]) ? result["evidence"] : {};
    const plan = registration.undo(args, evidence);
    const target = plan && this.#options.registry.get(plan.action);
    if (!plan || !target || !validateDeviceActionArguments(target.parameters, plan.arguments))
      return null;
    return plan;
  }

  async #undoState(record: DeviceActionRecord): Promise<DeviceActionUndoState> {
    const read = (ownerPresent: boolean) =>
      this.#options.store.readInvocation({
        ...this.#options.scope,
        runId: record.runId,
        toolCallId: undoToolCallId(record.id, ownerPresent),
      });
    const ownerReverse = await read(true);
    const plainReverse = await read(false);
    const reverse = ownerReverse ?? (plainReverse?.state === "rejected" ? null : plainReverse);
    if (reverse) {
      if (reverse.state === "succeeded") return "done";
      return reverse.state === "failed" ||
        reverse.state === "rejected" ||
        reverse.state === "expired"
        ? "failed"
        : "pending";
    }
    return (await this.#undoPlan(record)) ? "available" : "none";
  }

  async #undoKey(record: DeviceActionRecord, ownerPresent: boolean): Promise<string> {
    const read = (owner: boolean) =>
      this.#options.store.readInvocation({
        ...this.#options.scope,
        runId: record.runId,
        toolCallId: undoToolCallId(record.id, owner),
      });
    if (await read(true)) return undoToolCallId(record.id, true);
    const plain = await read(false);
    if (plain && plain.state !== "rejected") return undoToolCallId(record.id, false);
    return undoToolCallId(record.id, ownerPresent);
  }

  async undo(input: {
    readonly device: PairedDevice;
    readonly actionId: string;
    readonly ownerPresent: boolean;
  }): Promise<DeviceActionUndoOutcome> {
    const { scope, store } = this.#options;
    const record = await store.read({ ...scope, id: input.actionId });
    if (!record || record.deviceId !== input.device.id) return { kind: "not_found" };
    const plan = await this.#undoPlan(record);
    if (!plan) return { kind: "not_undoable" };
    return this.request({
      runId: record.runId,
      toolCallId: await this.#undoKey(record, input.ownerPresent),
      dataClassification: record.dataClassification,
      device: input.device,
      action: plan.action,
      arguments: plan.arguments,
    });
  }

  async views(input: {
    readonly deviceId: string | null;
    readonly states: readonly DeviceActionRecordState[];
    readonly limit: number;
    readonly finishedSince?: string;
  }): Promise<readonly DeviceActionView[]> {
    await this.settle();
    const records = await this.#options.store.list({ ...this.#options.scope, ...input });
    const views: DeviceActionView[] = [];
    for (const record of records) {
      const outcome = await this.#outcome(record);
      if (outcome.kind !== "recorded") continue;
      views.push(
        Object.freeze({
          id: record.id,
          deviceId: record.deviceId,
          state: record.state,
          action: record.action,
          runId: record.runId,
          threadId: record.threadId ?? null,
          detail: outcome.detail,
          confirmLabel: this.#options.registry.get(record.action)?.confirmLabel ?? EMPTY_DETAIL,
          declineLabel: this.#options.registry.get(record.action)?.declineLabel ?? EMPTY_DETAIL,
          risk: record.risk,
          ownerPresence: record.ownerPresence,
          reversible: this.#options.registry.get(record.action)?.reversible ?? false,
          undo: await this.#undoState(record),
          reasonCode: record.reasonCode,
          reason: outcome.reason,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }),
      );
    }
    return views;
  }
}
