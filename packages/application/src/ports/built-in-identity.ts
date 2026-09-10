import type { DeviceId, SessionId } from "@himawari-agent/domain";
import type { ProductSessionRecord } from "./identity.js";

/** Private server records. Never included in a browser projection or model context. */
export interface BuiltInAccount {
  readonly username: string;
  readonly passwordHash: string;
  readonly factorPayloadRef: string;
  readonly recoveryDigests: readonly string[];
  readonly revision: number;
}

export interface BuiltInChallenge {
  readonly digest: string;
  readonly credentialRevision: number;
  readonly expiresAt: string;
  readonly deviceLabel: string;
  /** Present only for an already authenticated session requesting step-up. */
  readonly authenticationRef: string | null;
}

export interface BuiltInSessionPolicy {
  readonly sessionIdleMilliseconds: number;
  readonly sessionAbsoluteMilliseconds: number;
}

/** Owner/Agent scoped; all compound writes are atomic in the durable implementation. */
export interface BuiltInIdentityStatePort {
  recordFailure(input: {
    readonly now: string;
    readonly phase: "password" | "factor";
  }): Promise<void>;
  readAccount(): Promise<BuiltInAccount | undefined>;
  provision(input: {
    readonly account: Omit<BuiltInAccount, "revision">;
    readonly expectedRevision: number | null;
    readonly now: string;
  }): Promise<void>;
  /** Reserve before expensive password work or factor verification; durable across restarts. */
  reserveAttempt(input: { readonly now: string }): Promise<boolean>;
  issueChallenge(input: {
    readonly challenge: BuiltInChallenge;
    readonly now: string;
  }): Promise<boolean>;
  readChallenge(digest: string): Promise<BuiltInChallenge | undefined>;
  finish(input: {
    readonly challengeDigest: string;
    readonly credentialRevision: number;
    readonly factor:
      | { readonly kind: "totp"; readonly counter: number }
      | { readonly kind: "recovery"; readonly digest: string };
    readonly sessionId: SessionId;
    readonly deviceId: DeviceId;
    readonly authenticationRef: string;
    readonly now: string;
    readonly policy: BuiltInSessionPolicy;
  }): Promise<ProductSessionRecord | undefined>;
  authenticate(input: {
    readonly touch?: boolean;
    readonly authenticationRef: string;
    readonly now: string;
    readonly policy: BuiltInSessionPolicy;
  }): Promise<ProductSessionRecord | undefined>;
}
