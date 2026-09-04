import { createOwnerId, type OwnerId } from "@himawari-agent/domain";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type GatewayAuthenticationContext,
  type OwnerIdentityStatePort,
  type RecentAuthenticationEvidence,
  type RecentAuthenticationGuardPort,
  type RecentAuthenticationPolicy,
  type SessionDeviceStatePort,
} from "../ports/index.js";

const RECENT_AUTH_REASON = "RECENT_AUTH_REQUIRED";

export interface RecentAuthenticationGuardDependencies {
  readonly identityState: OwnerIdentityStatePort;
  readonly sessionState: SessionDeviceStatePort;
  readonly policy: RecentAuthenticationPolicy;
  readonly now: () => string;
}

function finiteTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSource(value: string): value is RecentAuthenticationEvidence["source"] {
  return value === "cloudflare_access_login_time" || value === "provider_step_up";
}

export class RecentAuthenticationGuard implements RecentAuthenticationGuardPort {
  readonly #dependencies: RecentAuthenticationGuardDependencies;

  constructor(dependencies: RecentAuthenticationGuardDependencies) {
    if (
      !validNonNegativeInteger(dependencies.policy.maximumAgeMilliseconds) ||
      !validNonNegativeInteger(dependencies.policy.clockSkewMilliseconds)
    ) {
      throw new TypeError("Recent authentication policy must use finite non-negative integers");
    }
    this.#dependencies = dependencies;
  }

  async assertRecentAuthentication(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly expectedAuthenticationRef: string | null;
  }): Promise<RecentAuthenticationEvidence> {
    const { authentication, expectedAuthenticationRef } = input;
    if (
      !expectedAuthenticationRef ||
      expectedAuthenticationRef !== authentication.authenticationRef
    ) {
      this.#reject("authentication_ref_mismatch");
    }

    const evidence = authentication.recentAuthenticationEvidence;
    if (!evidence) this.#reject("evidence_missing");
    if (
      evidence.authenticationRef !== authentication.authenticationRef ||
      evidence.ownerId !== authentication.ownerId ||
      evidence.deviceId !== authentication.deviceId ||
      !validSource(evidence.source)
    ) {
      this.#reject("evidence_session_mismatch");
    }

    const now = finiteTimestamp(this.#dependencies.now());
    const authenticatedAt = finiteTimestamp(evidence.authenticatedAt);
    const expiresAt = finiteTimestamp(evidence.expiresAt);
    if (now === null || authenticatedAt === null || expiresAt === null) {
      this.#reject("timestamp_invalid");
    }
    const skew = this.#dependencies.policy.clockSkewMilliseconds;
    if (
      authenticatedAt > now + skew ||
      expiresAt < authenticatedAt - skew ||
      now - authenticatedAt > this.#dependencies.policy.maximumAgeMilliseconds + skew ||
      now > expiresAt + skew
    ) {
      this.#reject("timestamp_expired");
    }

    const binding = await this.#dependencies.identityState.readBySubject(
      evidence.externalSubjectRef,
    );
    let ownerId: OwnerId;
    try {
      ownerId = createOwnerId(authentication.ownerId);
    } catch {
      this.#reject("identity_owner_invalid");
    }
    const ownerBinding = await this.#dependencies.identityState.readByOwner(ownerId);
    if (
      !binding ||
      binding.status !== "active" ||
      !ownerBinding ||
      ownerBinding.status !== "active" ||
      ownerBinding.externalSubjectRef !== evidence.externalSubjectRef ||
      binding.ownerId !== authentication.ownerId ||
      binding.ownerId !== evidence.ownerId ||
      authentication.subjectId !== binding.ownerId
    ) {
      this.#reject("identity_binding_mismatch");
    }

    const session = await this.#dependencies.sessionState.findSessionByAuthenticationRef(
      authentication.authenticationRef,
    );
    if (
      !session ||
      session.status !== "active" ||
      session.ownerId !== authentication.ownerId ||
      session.deviceId !== authentication.deviceId ||
      session.deviceId !== evidence.deviceId
    ) {
      this.#reject("session_inactive_or_mismatch");
    }
    return Object.freeze({ ...evidence });
  }

  #reject(reason: string): never {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "Recent Owner authentication evidence is required",
      { reasonCode: RECENT_AUTH_REASON, reason },
    );
  }
}

export function recentAuthenticationEvidence(input: {
  readonly source: RecentAuthenticationEvidence["source"];
  readonly assertion: {
    readonly externalSubjectRef: string;
    readonly expiresAt: string;
  };
  readonly ownerId: OwnerId;
  readonly deviceId: RecentAuthenticationEvidence["deviceId"];
  readonly authenticationRef: string;
  readonly authenticatedAt: string;
}): RecentAuthenticationEvidence {
  return Object.freeze({
    source: input.source,
    externalSubjectRef: input.assertion.externalSubjectRef,
    ownerId: input.ownerId,
    deviceId: input.deviceId,
    authenticationRef: input.authenticationRef,
    authenticatedAt: input.authenticatedAt,
    expiresAt: input.assertion.expiresAt,
  });
}
