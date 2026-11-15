import type { ActionKind, ActionRiskLevel } from "./authorization.js";
import type { DataClassification } from "./common.js";
import type { PairedDeviceKind, PairedDeviceScope } from "./paired-devices.js";

export const DEVICE_ACTION_ID_PATTERN = /^dact_[0-9a-f]{32}$/u;

export const DEVICE_ACTION_RECORD_STATES = [
  "waiting_owner",
  "queued",
  "delivered",
  "succeeded",
  "failed",
  "result_unknown",
  "expired",
  "rejected",
] as const;
export type DeviceActionRecordState = (typeof DEVICE_ACTION_RECORD_STATES)[number];

export const DEVICE_ACTION_OPEN_STATES: readonly DeviceActionRecordState[] = Object.freeze([
  "waiting_owner",
  "queued",
  "delivered",
  "result_unknown",
]);

export const DEVICE_ACTION_REASON_CODES = [
  "approval_not_connected",
  "authorization_denied",
  "owner_denied",
  "owner_presence_unproven",
  "device_policy",
  "device_revoked",
  "device_unsupported",
  "device_reported",
  "report_missing",
  "device_lost_record",
  "not_delivered_in_time",
] as const;
export type DeviceActionReasonCode = (typeof DEVICE_ACTION_REASON_CODES)[number];

export const DEVICE_ACTION_REPORT_OUTCOMES = ["succeeded", "failed", "result_unknown"] as const;
export type DeviceActionReportOutcome = (typeof DEVICE_ACTION_REPORT_OUTCOMES)[number];

export const DEVICE_ACTION_DELIVERY_MODES = ["perform", "verify"] as const;
export type DeviceActionDeliveryMode = (typeof DEVICE_ACTION_DELIVERY_MODES)[number];

export interface DeviceActionRecord extends PairedDeviceScope {
  readonly id: string;
  readonly revision: number;
  readonly deviceId: string;
  readonly action: string;
  readonly schemaVersion: number;
  readonly argumentsRef: string;
  readonly fingerprint: string;
  readonly actionKind: ActionKind;
  readonly risk: ActionRiskLevel;
  readonly ownerPresence: boolean;
  readonly approvalId: string | null;
  readonly dataClassification: DataClassification;
  readonly state: DeviceActionRecordState;
  readonly reasonCode: DeviceActionReasonCode | null;
  readonly resultRef: string | null;
  readonly runId: string;
  readonly toolCallId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly deliveredAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
  readonly threadId?: string | null;
}

export interface DeviceActionInsert extends PairedDeviceScope {
  readonly id: string;
  readonly deviceId: string;
  readonly action: string;
  readonly schemaVersion: number;
  readonly argumentsRef: string;
  readonly fingerprint: string;
  readonly actionKind: ActionKind;
  readonly risk: ActionRiskLevel;
  readonly ownerPresence: boolean;
  readonly approvalId: string | null;
  readonly dataClassification: DataClassification;
  readonly state: "waiting_owner" | "queued" | "rejected";
  readonly reasonCode: DeviceActionReasonCode | null;
  readonly runId: string;
  readonly toolCallId: string;
  readonly now: string;
  readonly expiresAt: string;
}

export type DeviceActionInsertResult =
  | { readonly kind: "created"; readonly record: DeviceActionRecord }
  | { readonly kind: "replayed"; readonly record: DeviceActionRecord }
  | { readonly kind: "open_duplicate"; readonly record: DeviceActionRecord };

export interface DeviceActionSettlement {
  readonly expired: readonly DeviceActionRecord[];
  readonly unknown: readonly DeviceActionRecord[];
}

export interface DeviceActionReopening {
  readonly forgotten: readonly DeviceActionRecord[];
  readonly pending: readonly DeviceActionRecord[];
}

export type DeviceActionReportResult =
  | { readonly kind: "recorded"; readonly record: DeviceActionRecord }
  | { readonly kind: "replayed"; readonly record: DeviceActionRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "wrong_device" }
  | { readonly kind: "not_delivered"; readonly record: DeviceActionRecord }
  | { readonly kind: "verify_only"; readonly record: DeviceActionRecord };

export interface DevicePolicy extends PairedDeviceScope {
  readonly deviceId: string;
  readonly revision: number;
  readonly blockedActions: readonly string[];
  readonly updatedAt: string | null;
}

export type DevicePolicyWriteResult =
  | {
      readonly kind: "written";
      readonly policy: DevicePolicy;
      readonly rejected: readonly DeviceActionRecord[];
    }
  | { readonly kind: "revision_conflict"; readonly policy: DevicePolicy };

export interface DeviceActionStorePort {
  insert(input: DeviceActionInsert): Promise<DeviceActionInsertResult>;
  read(input: PairedDeviceScope & { readonly id: string }): Promise<DeviceActionRecord | undefined>;
  readInvocation(
    input: PairedDeviceScope & { readonly runId: string; readonly toolCallId: string },
  ): Promise<DeviceActionRecord | undefined>;
  list(
    input: PairedDeviceScope & {
      readonly deviceId: string | null;
      readonly states: readonly DeviceActionRecordState[];
      readonly limit: number;
      readonly finishedSince?: string;
    },
  ): Promise<readonly DeviceActionRecord[]>;
  settleDue(input: PairedDeviceScope & { readonly now: string }): Promise<DeviceActionSettlement>;
  claim(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly now: string;
      readonly limit: number;
    },
  ): Promise<readonly DeviceActionRecord[]>;
  report(
    input: PairedDeviceScope & {
      readonly id: string;
      readonly deviceId: string;
      readonly outcome: DeviceActionReportOutcome;
      readonly readBack: boolean;
      readonly resultRef: string | null;
      readonly reasonCode: DeviceActionReasonCode | null;
      readonly now: string;
    },
  ): Promise<DeviceActionReportResult>;
  forget(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly now: string;
      readonly limit: number;
    },
  ): Promise<DeviceActionReopening>;
  decide(
    input: PairedDeviceScope & {
      readonly id: string;
      readonly approved: boolean;
      readonly ownerPresent: boolean;
      readonly now: string;
    },
  ): Promise<DeviceActionRecord | undefined>;
  setSupportedActions(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly actions: readonly string[];
    },
  ): Promise<void>;
  readPolicy(input: PairedDeviceScope & { readonly deviceId: string }): Promise<DevicePolicy>;
  writePolicy(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly expectedRevision: number;
      readonly blockedActions: readonly string[];
      readonly now: string;
    },
  ): Promise<DevicePolicyWriteResult>;
}

export interface DeviceActionIntent extends PairedDeviceScope {
  readonly actionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly deviceId: string;
  readonly deviceKind: PairedDeviceKind;
  readonly action: string;
  readonly schemaVersion: number;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly actionKind: ActionKind;
  readonly risk: ActionRiskLevel;
  readonly target: { readonly type: string; readonly ref: string } | null;
  readonly reversible: boolean;
  readonly ownerPresence: boolean;
  readonly untrustedOriginAllowed: boolean;
  readonly readUntrustedContent: boolean;
  readonly dataClassification: DataClassification;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export type DeviceActionAuthorization =
  | { readonly decision: "allow"; readonly ownerPresent: boolean }
  | { readonly decision: "approval"; readonly approvalId: string }
  | { readonly decision: "deny"; readonly reasonCode: DeviceActionReasonCode };

export interface DeviceActionAuthorizationPort {
  authorize(intent: DeviceActionIntent): Promise<DeviceActionAuthorization>;
}

export interface DeviceActionDeliveryPort {
  connected(deviceId: string): boolean;
  announce(deviceId: string): void;
  settled(actionId: string): void;
  waitFor(actionId: string, milliseconds: number): Promise<void>;
}

export interface DeviceActionOpenRequestPort {
  requestOpen(input: {
    readonly record: DeviceActionRecord;
    readonly detail: Readonly<Record<string, string>>;
  }): Promise<void>;
}
