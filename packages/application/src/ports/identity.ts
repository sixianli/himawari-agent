import type { DeviceId, OwnerId, SessionId } from "@himawari-agent/domain";

export interface IdentityAssertionRequest {
  readonly assertionRef: string;
  readonly expectedAudience: string;
  readonly observedAt: string;
}

export interface VerifiedIdentityAssertion {
  readonly externalSubjectRef: string;
  readonly issuer: string;
  readonly audience: string;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

export interface IdentityAssertionPort {
  verify(request: IdentityAssertionRequest): Promise<VerifiedIdentityAssertion>;
}

export interface ProductSessionRecord {
  readonly id: SessionId;
  readonly ownerId: OwnerId;
  readonly deviceId: DeviceId;
  readonly revision: number;
  readonly authenticationRef: string;
  readonly status: "active" | "revoked";
  readonly firstAuthenticatedAt: string;
  readonly lastActiveAt: string;
  readonly recentAuthenticatedAt: string;
  readonly revokedAt: string | null;
}

export interface ProductDeviceRecord {
  readonly id: DeviceId;
  readonly ownerId: OwnerId;
  readonly revision: number;
  readonly label: string;
  readonly status: "active" | "revoked";
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface OwnerIdentityBindingRecord {
  readonly ownerId: OwnerId;
  readonly externalSubjectRef: string;
  readonly boundAt: string;
  readonly status: "active" | "disabled";
}

export interface OwnerIdentityStatePort {
  bindFirstOwner(input: {
    readonly ownerId: OwnerId;
    readonly externalSubjectRef: string;
    readonly boundAt: string;
  }): Promise<OwnerIdentityBindingRecord>;
  readBySubject(externalSubjectRef: string): Promise<OwnerIdentityBindingRecord | undefined>;
  readByOwner(ownerId: OwnerId): Promise<OwnerIdentityBindingRecord | undefined>;
  repairBinding(input: {
    readonly ownerId: OwnerId;
    readonly externalSubjectRef: string;
    readonly repairedAt: string;
  }): Promise<OwnerIdentityBindingRecord>;
}

export interface SessionDeviceStatePort {
  readSession(sessionId: SessionId): Promise<ProductSessionRecord | undefined>;
  findSessionByAuthenticationRef(
    authenticationRef: string,
  ): Promise<ProductSessionRecord | undefined>;
  listSessions(ownerId: OwnerId, includeRevoked: boolean): Promise<readonly ProductSessionRecord[]>;
  listDevices(ownerId: OwnerId, includeRevoked: boolean): Promise<readonly ProductDeviceRecord[]>;
  saveDevice(
    device: Omit<ProductDeviceRecord, "revision">,
    expectedRevision: number | null,
  ): Promise<ProductDeviceRecord>;
  revokeDevice(
    deviceId: DeviceId,
    expectedRevision: number,
    revokedAt: string,
  ): Promise<ProductDeviceRecord>;
  saveSession(
    session: Omit<ProductSessionRecord, "revision">,
    expectedRevision: number | null,
  ): Promise<ProductSessionRecord>;
  revokeSession(
    sessionId: SessionId,
    expectedRevision: number,
    revokedAt: string,
  ): Promise<ProductSessionRecord>;
}
