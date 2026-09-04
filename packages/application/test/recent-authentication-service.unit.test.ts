import {
  PORT_ERROR_CODES,
  RecentAuthenticationGuard,
  type GatewayAuthenticationContext,
  type OwnerIdentityBindingRecord,
  type OwnerIdentityStatePort,
  type ProductDeviceRecord,
  type ProductSessionRecord,
  type RecentAuthenticationEvidence,
  type SessionDeviceStatePort,
} from "../src/index.js";
import {
  createDeviceId,
  createOwnerId,
  createSessionId,
  type DeviceId,
  type OwnerId,
  type SessionId,
} from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-28T00:00:00.000Z";
const ownerId = createOwnerId("owner-recent-auth");
const otherOwnerId = createOwnerId("owner-recent-auth-other");
const deviceId = createDeviceId("device-recent-auth");
const otherDeviceId = createDeviceId("device-recent-auth-other");
const sessionId = createSessionId("session-recent-auth");
const authenticationRef = "sha256:recent-auth";
const externalSubjectRef = "sha256:external-subject";

class IdentityState implements OwnerIdentityStatePort {
  readonly bindings = new Map<string, OwnerIdentityBindingRecord>();

  async bindFirstOwner(input: {
    readonly ownerId: OwnerId;
    readonly externalSubjectRef: string;
    readonly boundAt: string;
  }) {
    const binding = { ...input, status: "active" as const };
    this.bindings.set(input.externalSubjectRef, binding);
    return binding;
  }

  async readBySubject(subject: string) {
    return this.bindings.get(subject);
  }

  async readByOwner(owner: OwnerId) {
    return [...this.bindings.values()].find((binding) => binding.ownerId === owner);
  }

  async repairBinding(input: {
    readonly ownerId: OwnerId;
    readonly externalSubjectRef: string;
    readonly repairedAt: string;
  }) {
    const binding = {
      ownerId: input.ownerId,
      externalSubjectRef: input.externalSubjectRef,
      boundAt: input.repairedAt,
      status: "active" as const,
    };
    this.bindings.set(input.externalSubjectRef, binding);
    return binding;
  }
}

class SessionState implements SessionDeviceStatePort {
  session: ProductSessionRecord;

  constructor() {
    this.session = {
      id: sessionId,
      ownerId,
      deviceId,
      revision: 0,
      authenticationRef,
      status: "active",
      firstAuthenticatedAt: NOW,
      lastActiveAt: NOW,
      recentAuthenticatedAt: NOW,
      revokedAt: null,
    };
  }

  async readSession(id: SessionId) {
    return id === this.session.id ? this.session : undefined;
  }

  async findSessionByAuthenticationRef(ref: string) {
    return ref === this.session.authenticationRef ? this.session : undefined;
  }

  async listSessions(owner: OwnerId, includeRevoked: boolean) {
    return owner === this.session.ownerId && (includeRevoked || this.session.status === "active")
      ? [this.session]
      : [];
  }

  async listDevices(
    owner: OwnerId,
    _includeRevoked: boolean,
  ): Promise<readonly ProductDeviceRecord[]> {
    return owner === this.session.ownerId
      ? [
          {
            id: this.session.deviceId,
            ownerId: this.session.ownerId,
            revision: 0,
            label: "test",
            status: this.session.status,
            firstSeenAt: NOW,
            lastSeenAt: NOW,
          },
        ]
      : [];
  }

  async saveDevice(
    device: Omit<ProductDeviceRecord, "revision">,
    _expectedRevision: number | null,
  ) {
    return { ...device, revision: 0 };
  }

  async revokeDevice(
    _id: DeviceId,
    _expectedRevision: number,
    _revokedAt: string,
  ): Promise<ProductDeviceRecord> {
    throw new Error("not used");
  }

  async saveSession(
    session: Omit<ProductSessionRecord, "revision">,
    _expectedRevision: number | null,
  ) {
    this.session = { ...session, revision: 0 };
    return this.session;
  }

  async revokeSession(
    _id: SessionId,
    _expectedRevision: number,
    _revokedAt: string,
  ): Promise<ProductSessionRecord> {
    throw new Error("not used");
  }
}

function authentication(overrides: Partial<GatewayAuthenticationContext> = {}) {
  return {
    subjectId: ownerId,
    ownerId,
    deviceId,
    authenticatedAt: NOW,
    authenticationRef,
    ...overrides,
  } satisfies GatewayAuthenticationContext;
}

function evidence(overrides: Partial<RecentAuthenticationEvidence> = {}) {
  return {
    source: "cloudflare_access_login_time" as const,
    externalSubjectRef,
    ownerId,
    deviceId,
    authenticationRef,
    authenticatedAt: NOW,
    expiresAt: "2026-08-28T01:00:00.000Z",
    ...overrides,
  } satisfies RecentAuthenticationEvidence;
}

function fixture() {
  const identityState = new IdentityState();
  identityState.bindings.set(externalSubjectRef, {
    ownerId,
    externalSubjectRef,
    boundAt: NOW,
    status: "active",
  });
  const sessionState = new SessionState();
  let now = NOW;
  const guard = new RecentAuthenticationGuard({
    identityState,
    sessionState,
    policy: { maximumAgeMilliseconds: 60_000, clockSkewMilliseconds: 0 },
    now: () => now,
  });
  return {
    guard,
    identityState,
    sessionState,
    setNow: (value: string) => {
      now = value;
    },
  };
}

describe("RecentAuthenticationGuard", () => {
  it("accepts current evidence and allows read-only replay without consuming it", async () => {
    const { guard } = fixture();
    const current = authentication({ recentAuthenticationEvidence: evidence() });
    await expect(
      guard.assertRecentAuthentication({
        authentication: current,
        expectedAuthenticationRef: authenticationRef,
      }),
    ).resolves.toMatchObject({ source: "cloudflare_access_login_time" });
    await expect(
      guard.assertRecentAuthentication({
        authentication: current,
        expectedAuthenticationRef: authenticationRef,
      }),
    ).resolves.toMatchObject({ authenticationRef });
  });

  it.each([
    ["missing evidence", authentication(), "evidence_missing"],
    [
      "stale evidence",
      authentication({
        recentAuthenticationEvidence: evidence({
          authenticatedAt: "2026-08-27T23:00:00.000Z",
        }),
      }),
      "timestamp_expired",
    ],
    [
      "future evidence",
      authentication({
        recentAuthenticationEvidence: evidence({
          authenticatedAt: "2026-08-28T00:00:01.000Z",
        }),
      }),
      "timestamp_expired",
    ],
    [
      "malformed evidence",
      authentication({
        recentAuthenticationEvidence: evidence({ authenticatedAt: "not-a-date" }),
      }),
      "timestamp_invalid",
    ],
    [
      "mismatched reference",
      authentication({ recentAuthenticationEvidence: evidence() }),
      "authentication_ref_mismatch",
    ],
  ])("rejects %s", async (_label, current, reason) => {
    const { guard } = fixture();
    await expect(
      guard.assertRecentAuthentication({
        authentication: current,
        expectedAuthenticationRef:
          reason === "authentication_ref_mismatch" ? "sha256:other" : authenticationRef,
      }),
    ).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      details: { reasonCode: "RECENT_AUTH_REQUIRED", reason },
    });
  });

  it("rejects revoked, cross-session, and cross-owner evidence", async () => {
    const revoked = fixture();
    revoked.sessionState.session = { ...revoked.sessionState.session, status: "revoked" };
    await expect(
      revoked.guard.assertRecentAuthentication({
        authentication: authentication({ recentAuthenticationEvidence: evidence() }),
        expectedAuthenticationRef: authenticationRef,
      }),
    ).rejects.toMatchObject({ details: { reason: "session_inactive_or_mismatch" } });

    const crossSession = fixture();
    await expect(
      crossSession.guard.assertRecentAuthentication({
        authentication: authentication({
          deviceId: otherDeviceId,
          recentAuthenticationEvidence: evidence({ deviceId: otherDeviceId }),
        }),
        expectedAuthenticationRef: authenticationRef,
      }),
    ).rejects.toMatchObject({ details: { reason: "session_inactive_or_mismatch" } });

    const crossOwner = fixture();
    await expect(
      crossOwner.guard.assertRecentAuthentication({
        authentication: authentication({
          ownerId: otherOwnerId,
          subjectId: otherOwnerId,
          recentAuthenticationEvidence: evidence({ ownerId: otherOwnerId }),
        }),
        expectedAuthenticationRef: authenticationRef,
      }),
    ).rejects.toMatchObject({ details: { reason: "identity_binding_mismatch" } });
  });
});
