import type { DeviceId, OwnerId } from "@himawari-agent/domain";
import type { GatewayAuthenticationContext } from "./gateway.js";
import type { VerifiedIdentityAssertion } from "./identity.js";

export type RecentAuthenticationEvidenceSource =
  | "cloudflare_access_login_time"
  | "built_in_mfa"
  | "provider_step_up";

/**
 * Evidence that a trusted identity provider observed a recent authentication
 * for this exact product session. This is not an authorization grant.
 */
export interface RecentAuthenticationEvidence {
  readonly source: RecentAuthenticationEvidenceSource;
  readonly externalSubjectRef: string;
  readonly ownerId: OwnerId;
  readonly deviceId: DeviceId;
  readonly authenticationRef: string;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

/** The provider result before it is bound to the product session. */
export interface RecentAuthenticationProviderResult {
  readonly source: RecentAuthenticationEvidenceSource;
  readonly externalSubjectRef: string;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

export interface RecentAuthenticationEvidenceProvider {
  read(input: {
    readonly assertionToken: string;
    readonly assertion: VerifiedIdentityAssertion;
    /** The verified provider `sub`, kept transiently for provider binding. */
    readonly providerSubject: string;
  }): Promise<RecentAuthenticationProviderResult>;
}

export interface RecentAuthenticationPolicy {
  /** Required product policy; no implicit duration is supplied. */
  readonly maximumAgeMilliseconds: number;
  readonly clockSkewMilliseconds: number;
}

export interface RecentAuthenticationGuardPort {
  assertRecentAuthentication(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly expectedAuthenticationRef: string | null;
  }): Promise<RecentAuthenticationEvidence>;
}
