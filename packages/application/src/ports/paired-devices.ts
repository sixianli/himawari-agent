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

export interface OwnerPasskey extends PairedDeviceScope {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly backedUp: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface SignedInDeviceInput {
  readonly id: string;
  readonly kind: PairedDeviceKind;
  readonly name: string;
  readonly releaseChannel: PairedDeviceReleaseChannel;
  readonly devicePublicKey: string;
  readonly confirmPublicKey: string;
  readonly webDeviceId: string;
  readonly webSessionId: string;
  readonly webAuthenticationRef: string;
}

export type SignInPasskeyInput =
  | {
      readonly kind: "created";
      readonly setupCodeHash: string;
      readonly credentialId: string;
      readonly publicKey: string;
      readonly signCount: number;
      readonly transports: readonly string[];
      readonly backedUp: boolean;
    }
  | {
      readonly kind: "used";
      readonly credentialId: string;
      readonly signCount: number;
      readonly backedUp: boolean;
    };

export type SignInDeviceResult =
  | { readonly kind: "signed_in"; readonly device: PairedDevice }
  | { readonly kind: "setup_code_used" }
  | { readonly kind: "passkey_unknown" }
  | { readonly kind: "passkey_exists" };

export type NonceRecordResult = "accepted" | "replayed" | "full";

export interface PairedDeviceStorePort {
  listPasskeys(input: PairedDeviceScope): Promise<readonly OwnerPasskey[]>;
  readPasskey(credentialId: string): Promise<OwnerPasskey | undefined>;
  signInDevice(
    input: PairedDeviceScope & {
      readonly now: string;
      readonly passkey: SignInPasskeyInput;
      readonly device: SignedInDeviceInput;
    },
  ): Promise<SignInDeviceResult>;
  readDevice(deviceId: string): Promise<PairedDevice | undefined>;
  listDevices(input: PairedDeviceScope): Promise<readonly PairedDevice[]>;
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
