import type { AgentId, OwnerId } from "@himawari-agent/domain";

export const PAIRED_DEVICE_KINDS = ["iphone", "watch", "mac"] as const;
export type PairedDeviceKind = (typeof PAIRED_DEVICE_KINDS)[number];

export const PAIRED_DEVICE_RELEASE_CHANNELS = [
  "direct",
  "testflight",
  "app_store",
  "mac_direct",
] as const;
export type PairedDeviceReleaseChannel = (typeof PAIRED_DEVICE_RELEASE_CHANNELS)[number];

export const PAIRED_DEVICE_STATUSES = ["pending", "active", "revoked"] as const;
export type PairedDeviceStatus = (typeof PAIRED_DEVICE_STATUSES)[number];

export const PAIRING_CODE_LIFETIME_MILLISECONDS = 10 * 60 * 1000;

export interface PairedDeviceScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface PairedDevice extends PairedDeviceScope {
  readonly id: string;
  readonly revision: number;
  readonly kind: PairedDeviceKind;
  readonly name: string;
  readonly releaseChannel: PairedDeviceReleaseChannel;
  readonly devicePublicKey: string;
  readonly confirmPublicKey: string;
  readonly status: PairedDeviceStatus;
  readonly supportedActions: readonly string[];
  readonly webDeviceId: string | null;
  readonly webSessionId: string | null;
  readonly pairedAt: string;
  readonly confirmedAt: string | null;
  readonly revokedAt: string | null;
  readonly lastSeenAt: string | null;
}

export type PairingRedeemResult =
  | { readonly kind: "paired"; readonly device: PairedDevice }
  | { readonly kind: "replayed"; readonly device: PairedDevice }
  | { readonly kind: "code_invalid" }
  | { readonly kind: "code_expired" }
  | { readonly kind: "code_used" };

export type NonceRecordResult = "accepted" | "replayed" | "full";

export interface PairedDeviceStorePort {
  createPairingCode(
    input: PairedDeviceScope & {
      readonly codeHash: string;
      readonly sessionId: string;
      readonly now: string;
      readonly expiresAt: string;
    },
  ): Promise<{ readonly expiresAt: string }>;
  redeemPairingCode(input: {
    readonly codeHash: string;
    readonly now: string;
    readonly device: {
      readonly id: string;
      readonly kind: PairedDeviceKind;
      readonly name: string;
      readonly releaseChannel: PairedDeviceReleaseChannel;
      readonly devicePublicKey: string;
      readonly confirmPublicKey: string;
    };
  }): Promise<PairingRedeemResult>;
  readDevice(deviceId: string): Promise<PairedDevice | undefined>;
  listDevices(input: PairedDeviceScope): Promise<readonly PairedDevice[]>;
  readOpenPairingCode(
    input: PairedDeviceScope & { readonly now: string },
  ): Promise<{ readonly expiresAt: string } | undefined>;
  confirmDevice(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly expectedRevision: number;
      readonly now: string;
      readonly webDeviceId: string;
      readonly webSessionId: string;
      readonly webAuthenticationRef: string;
    },
  ): Promise<PairedDevice>;
  renameDevice(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly expectedRevision: number;
      readonly name: string;
    },
  ): Promise<PairedDevice>;
  revokeDevice(
    input: PairedDeviceScope & {
      readonly deviceId: string;
      readonly expectedRevision: number;
      readonly now: string;
    },
  ): Promise<PairedDevice>;
  recordNonce(input: {
    readonly deviceId: string;
    readonly nonce: string;
    readonly now: string;
    readonly expiresAt: string;
    readonly maximumRetained: number;
  }): Promise<NonceRecordResult>;
  touchDevice(input: { readonly deviceId: string; readonly now: string }): Promise<void>;
}
