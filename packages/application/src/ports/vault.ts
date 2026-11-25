import type { AgentId, OwnerId } from "@himawari-agent/domain";

export const VAULT_FORMAT = "himawari-vault-v1" as const;

export const VAULT_ITEM_KINDS = ["login", "api_key"] as const;
export type VaultItemKind = (typeof VAULT_ITEM_KINDS)[number];

export const VAULT_FIELDS = {
  login: { required: ["password"], optional: ["username", "totp"] },
  api_key: { required: ["api_key"], optional: [] },
} as const satisfies Record<
  VaultItemKind,
  { readonly required: readonly string[]; readonly optional: readonly string[] }
>;

export const VAULT_PHONE_ONLY_FIELDS: readonly string[] = Object.freeze(["totp"]);

export const VAULT_REQUEST_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type VaultRequestStatus = (typeof VAULT_REQUEST_STATUSES)[number];

export const VAULT_USAGE_OUTCOMES = ["approved", "denied", "expired", "filled", "failed"] as const;
export type VaultUsageOutcome = (typeof VAULT_USAGE_OUTCOMES)[number];

export const VAULT_LIMITS = Object.freeze({
  items: 500,
  nameCharacters: 64,
  originsPerItem: 8,
  itemsPerRequest: 8,
  purposeCharacters: 300,
  ciphertextBytes: 8_192,
  usageListed: 50,
  totpCodes: 6,
  requestTtlSeconds: 120,
});

export interface VaultScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface VaultItemInput {
  readonly id: string;
  readonly name: string;
  readonly kind: VaultItemKind;
  readonly origins: readonly string[];
  readonly fields: readonly string[];
  readonly version: number;
  readonly backgroundAllowed: boolean;
  readonly wrappedKey: string;
  readonly ciphertexts: Readonly<Record<string, string>>;
}

export interface VaultItemRecord extends VaultItemInput {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VaultManifest {
  readonly version: number;
  readonly signature: string;
}

export interface VaultManifestRecord extends VaultManifest {
  readonly updatedAt: string;
}

export interface VaultReleaseRequestRecord extends VaultScope {
  readonly id: string;
  readonly runId: string | null;
  readonly purpose: string;
  readonly itemIds: readonly string[];
  readonly itemVersions: readonly number[];
  readonly origin: string;
  readonly pageVersion: string | null;
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly status: VaultRequestStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly deviceId: string | null;
}

export interface VaultUsageRecord {
  readonly requestId: string;
  readonly itemId: string;
  readonly origin: string;
  readonly outcome: VaultUsageOutcome;
  readonly at: string;
}

export interface VaultUsageListed extends VaultUsageRecord {
  readonly purpose: string | null;
}

export type VaultChangeResult =
  | { readonly kind: "applied"; readonly manifest: VaultManifestRecord }
  | { readonly kind: "manifest_conflict"; readonly current: number }
  | { readonly kind: "version_not_newer"; readonly itemId: string }
  | { readonly kind: "unknown_item"; readonly itemId: string }
  | { readonly kind: "too_many_items" };

export interface VaultStorePort {
  listItems(input: VaultScope): Promise<readonly VaultItemRecord[]>;
  readManifest(input: VaultScope): Promise<VaultManifestRecord | null>;
  applyChange(
    input: VaultScope & {
      readonly expectedManifestVersion: number;
      readonly manifest: VaultManifest;
      readonly upserts: readonly VaultItemInput[];
      readonly deletes: readonly string[];
      readonly rotation: boolean;
      readonly maximumItems: number;
      readonly now: string;
    },
  ): Promise<VaultChangeResult>;
  createRequest(
    input: Omit<VaultReleaseRequestRecord, "decidedAt" | "deviceId" | "status">,
  ): Promise<void>;
  readRequest(
    input: VaultScope & { readonly id: string },
  ): Promise<VaultReleaseRequestRecord | null>;
  listPendingRequests(
    input: VaultScope & { readonly now: string },
  ): Promise<readonly VaultReleaseRequestRecord[]>;
  decideRequest(
    input: VaultScope & {
      readonly id: string;
      readonly nonce: string;
      readonly status: "approved" | "denied" | "expired";
      readonly deviceId: string | null;
      readonly now: string;
      readonly usage: VaultUsageRecord["outcome"];
    },
  ): Promise<VaultReleaseRequestRecord | null>;
  expireOverdue(input: VaultScope & { readonly now: string }): Promise<readonly string[]>;
  recordUsage(input: VaultScope & { readonly entries: readonly VaultUsageRecord[] }): Promise<void>;
  listUsage(
    input: VaultScope & { readonly itemId: string | null; readonly limit: number },
  ): Promise<readonly VaultUsageListed[]>;
}

export interface VaultEphemeralKey {
  readonly publicKey: string;
  open(
    sealed: { readonly enc: string; readonly ciphertext: string },
    aad: Uint8Array,
  ): Promise<Uint8Array>;
  dispose(): void;
}

export interface VaultCryptoPort {
  createEphemeral(): Promise<VaultEphemeralKey>;
  decryptField(itemKey: Uint8Array, ciphertext: string, aad: Uint8Array): Uint8Array;
  randomToken(bytes: number): string;
}

export interface VaultNotifierPort {
  approvalNeeded(
    input: VaultScope & { readonly requestId: string; readonly expiresAt: string },
  ): Promise<void>;
}
