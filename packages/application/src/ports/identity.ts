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

export interface SessionDeviceStatePort {
  readSession(sessionId: SessionId): Promise<ProductSessionRecord | undefined>;
  listSessions(ownerId: OwnerId, includeRevoked: boolean): Promise<readonly ProductSessionRecord[]>;
  listDevices(ownerId: OwnerId, includeRevoked: boolean): Promise<readonly ProductDeviceRecord[]>;
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
