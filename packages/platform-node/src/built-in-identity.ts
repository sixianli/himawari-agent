import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type {
  BuiltInIdentityStatePort,
  BuiltInSessionPolicy,
  GatewayAuthenticationContext,
  OwnerId,
} from "@himawari-agent/application";
import { createDeviceId, createSessionId } from "@himawari-agent/domain";
import { Secret, TOTP } from "otpauth";
import type {
  HttpGatewayAuthenticationInput,
  HttpGatewayAuthenticationPort,
} from "./http-gateway-server.js";

const COST = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const PREFIX = "scrypt-v1";

export class BuiltInAuthenticationError extends Error {
  readonly code: "IDENTITY_LOGIN_REJECTED" | "IDENTITY_RATE_LIMITED";
  constructor(
    code: "IDENTITY_LOGIN_REJECTED" | "IDENTITY_RATE_LIMITED" = "IDENTITY_LOGIN_REJECTED",
  ) {
    super(code);
    this.code = code;
    this.name = "BuiltInAuthenticationError";
  }
}

export function identityTokenDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeAccountUsername(value: string): string {
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(result)) throw new BuiltInAuthenticationError();
  return result;
}

async function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, COST, (error, value) => (error ? reject(error) : resolve(value))),
  );
}

export async function hashAccountPassword(password: string): Promise<string> {
  if (
    Array.from(password).length < 12 ||
    Array.from(password).length > 128 ||
    Buffer.byteLength(password) > 1024
  )
    throw new BuiltInAuthenticationError();
  const salt = randomBytes(16);
  const derived = await derive(password, salt);
  try {
    return `${PREFIX}$${salt.toString("hex")}$${derived.toString("hex")}`;
  } finally {
    derived.fill(0);
  }
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length > 1024 || Buffer.byteLength(password) > 1024) return false;
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded);
  if (!match?.[1] || !match[2]) return false;
  const result = await derive(password, Buffer.from(match[1], "hex"));
  try {
    return timingSafeEqual(result, Buffer.from(match[2], "hex"));
  } finally {
    result.fill(0);
  }
}

/** Returned once to the host administrator, never logged or sent to a model. */
export function createAccountFactors(username: string): {
  secret: Uint8Array;
  uri: string;
  recoveryCodes: readonly string[];
  recoveryDigests: readonly string[];
} {
  const otp = new TOTP({
    issuer: "Himawari",
    label: normalizeAccountUsername(username),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new Secret({ size: 20 }),
  });
  const recoveryCodes = Array.from(
    { length: 10 },
    () => randomBytes(16).toString("hex").match(/.{8}/g)?.join("-") ?? "",
  );
  return {
    secret: Buffer.from(otp.secret.base32, "utf8"),
    uri: otp.toString(),
    recoveryCodes,
    recoveryDigests: recoveryCodes.map((value) => identityTokenDigest(value.replaceAll("-", ""))),
  };
}

export interface BuiltInAuthenticationOptions {
  readonly ownerId: OwnerId;
  readonly state: BuiltInIdentityStatePort;
  readonly policy: BuiltInSessionPolicy;
  readonly readFactor: (payloadRef: string) => Promise<Uint8Array>;
  readonly now?: () => Date;
}

export class BuiltInAuthenticationService implements HttpGatewayAuthenticationPort {
  private passwordWorkActive = false;
  private readonly now: () => Date;
  private readonly options: BuiltInAuthenticationOptions;
  constructor(options: BuiltInAuthenticationOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  async assertReady(): Promise<void> {
    if (!(await this.options.state.readAccount())) throw new BuiltInAuthenticationError();
  }

  async begin(input: {
    username: string;
    password: string;
    deviceLabel: string;
    authenticationRef?: string;
  }): Promise<string> {
    if (this.passwordWorkActive) throw new BuiltInAuthenticationError("IDENTITY_RATE_LIMITED");
    this.passwordWorkActive = true;
    try {
      if (!(await this.options.state.reserveAttempt({ now: this.now().toISOString() })))
        throw new BuiltInAuthenticationError("IDENTITY_RATE_LIMITED");
      const account = await this.options.state.readAccount();
      if (!account) throw new BuiltInAuthenticationError();
      const verified = await verifyPassword(input.password, account.passwordHash);
      if (!verified || normalizeAccountUsername(input.username) !== account.username)
        throw new BuiltInAuthenticationError();
      const token = randomBytes(32).toString("base64url");
      const now = this.now();
      const issued = await this.options.state.issueChallenge({
        now: now.toISOString(),
        challenge: {
          digest: identityTokenDigest(token),
          credentialRevision: account.revision,
          expiresAt: new Date(now.getTime() + 300000).toISOString(),
          deviceLabel: input.deviceLabel.trim().slice(0, 80) || "Browser",
          authenticationRef: input.authenticationRef ?? null,
        },
      });
      if (!issued) throw new BuiltInAuthenticationError();
      return token;
    } catch (error) {
      if (error instanceof BuiltInAuthenticationError && error.code !== "IDENTITY_RATE_LIMITED")
        await this.options.state.recordFailure({
          now: this.now().toISOString(),
          phase: "password",
        });
      throw error;
    } finally {
      this.passwordWorkActive = false;
    }
  }

  async finish(
    challengeToken: string,
    code: string,
  ): Promise<{ token: string; sessionId: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challengeToken) || code.length > 80)
      throw new BuiltInAuthenticationError();
    if (!(await this.options.state.reserveAttempt({ now: this.now().toISOString() })))
      throw new BuiltInAuthenticationError("IDENTITY_RATE_LIMITED");
    try {
      const challengeDigest = identityTokenDigest(challengeToken);
      const challenge = await this.options.state.readChallenge(challengeDigest);
      const account = await this.options.state.readAccount();
      const now = this.now();
      if (
        !challenge ||
        !account ||
        challenge.credentialRevision !== account.revision ||
        Date.parse(challenge.expiresAt) <= now.getTime()
      )
        throw new BuiltInAuthenticationError();
      let factor: Parameters<BuiltInIdentityStatePort["finish"]>[0]["factor"];
      const normalized = code.trim().replaceAll("-", "").toLowerCase();
      if (/^\d{6}$/.test(normalized)) {
        const bytes = await this.options.readFactor(account.factorPayloadRef);
        try {
          const otp = new TOTP({
            secret: Buffer.from(bytes).toString("utf8"),
            algorithm: "SHA1",
            digits: 6,
            period: 30,
          });
          const delta = otp.validate({ token: normalized, timestamp: now.getTime(), window: 1 });
          if (delta === null) throw new BuiltInAuthenticationError();
          factor = { kind: "totp", counter: Math.floor(now.getTime() / 30000) + delta };
        } finally {
          bytes.fill(0);
        }
      } else if (/^[a-f0-9]{32}$/.test(normalized)) {
        factor = { kind: "recovery", digest: identityTokenDigest(normalized) };
      } else throw new BuiltInAuthenticationError();
      const token = randomBytes(32).toString("base64url");
      const session = await this.options.state.finish({
        challengeDigest,
        credentialRevision: account.revision,
        factor,
        sessionId: createSessionId(`session-${randomUUID()}`),
        deviceId: createDeviceId(`device-${randomUUID()}`),
        authenticationRef: identityTokenDigest(token),
        now: now.toISOString(),
        policy: this.options.policy,
      });
      if (!session) throw new BuiltInAuthenticationError();
      return { token, sessionId: session.id };
    } catch (error) {
      if (error instanceof BuiltInAuthenticationError)
        await this.options.state.recordFailure({ now: this.now().toISOString(), phase: "factor" });
      throw error;
    }
  }

  async revalidate(authentication: GatewayAuthenticationContext): Promise<void> {
    const session = await this.options.state.authenticate({
      authenticationRef: authentication.authenticationRef,
      now: this.now().toISOString(),
      policy: this.options.policy,
      touch: false,
    });
    if (
      !session ||
      session.ownerId !== authentication.ownerId ||
      session.deviceId !== authentication.deviceId
    )
      throw new BuiltInAuthenticationError();
  }

  async authenticate(input: HttpGatewayAuthenticationInput): Promise<GatewayAuthenticationContext> {
    if (!input.sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(input.sessionToken))
      throw new BuiltInAuthenticationError();
    const session = await this.options.state.authenticate({
      authenticationRef: identityTokenDigest(input.sessionToken),
      now: this.now().toISOString(),
      policy: this.options.policy,
    });
    if (!session) throw new BuiltInAuthenticationError();
    return Object.freeze<GatewayAuthenticationContext>({
      subjectId: this.options.ownerId,
      ownerId: this.options.ownerId,
      deviceId: session.deviceId,
      authenticatedAt: session.recentAuthenticatedAt,
      authenticationRef: session.authenticationRef,
      sessionId: session.id,
      recentAuthenticationEvidence: {
        source: "built_in_mfa",
        externalSubjectRef: `built-in:${this.options.ownerId}`,
        ownerId: this.options.ownerId,
        deviceId: session.deviceId,
        authenticationRef: session.authenticationRef,
        authenticatedAt: session.recentAuthenticatedAt,
        expiresAt: new Date(
          Date.parse(session.firstAuthenticatedAt) +
            this.options.policy.sessionAbsoluteMilliseconds,
        ).toISOString(),
      },
    });
  }
}
