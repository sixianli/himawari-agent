import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import type {
  GatewayAuthenticationContext,
  OwnerIdentityStatePort,
  ProductDeviceRecord,
  ProductSessionRecord,
  SessionDeviceStatePort,
  VerifiedIdentityAssertion,
} from "@himawari-agent/application";
import {
  createDeviceId,
  createOwnerId,
  createSessionId,
  type DeviceId,
  type OwnerId,
  type SessionId,
} from "@himawari-agent/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";
import type {
  HttpGatewayAuthenticationInput,
  HttpGatewayAuthenticationPort,
  HttpGatewayCsrfPort,
} from "./http-gateway-server.js";

export const IDENTITY_GATEWAY_ERROR_CODES = Object.freeze({
  ASSERTION_INVALID: "IDENTITY_ASSERTION_INVALID",
  BOOTSTRAP_DISABLED: "IDENTITY_BOOTSTRAP_DISABLED",
  BOOTSTRAP_EXPIRED: "IDENTITY_BOOTSTRAP_EXPIRED",
  BOOTSTRAP_NOT_LOOPBACK: "IDENTITY_BOOTSTRAP_NOT_LOOPBACK",
  BOOTSTRAP_TOKEN_INVALID: "IDENTITY_BOOTSTRAP_TOKEN_INVALID",
  BREAK_GLASS_REJECTED: "IDENTITY_BREAK_GLASS_REJECTED",
  JWKS_INVALID: "IDENTITY_JWKS_INVALID",
  OWNER_NOT_BOUND: "IDENTITY_OWNER_NOT_BOUND",
  RECENT_AUTH_REQUIRED: "IDENTITY_RECENT_AUTH_REQUIRED",
  SESSION_INVALID: "IDENTITY_SESSION_INVALID",
} as const);

export class IdentityGatewayError extends Error {
  readonly code: (typeof IDENTITY_GATEWAY_ERROR_CODES)[keyof typeof IDENTITY_GATEWAY_ERROR_CODES];

  constructor(code: IdentityGatewayError["code"]) {
    super(code);
    this.name = "IdentityGatewayError";
    this.code = code;
  }
}

export interface JwksFetcher {
  fetch(url: URL): Promise<unknown>;
}

export interface CloudflareAccessJwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly jwksFetcher: JwksFetcher;
  readonly now?: () => Date;
  readonly cacheMilliseconds?: number;
  readonly clockToleranceSeconds?: number;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validateJwks(value: unknown): JSONWebKeySet {
  if (!value || typeof value !== "object" || !Array.isArray((value as { keys?: unknown }).keys)) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.JWKS_INVALID);
  }
  const keys = (value as { keys: unknown[] }).keys;
  if (keys.length === 0 || keys.length > 32) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.JWKS_INVALID);
  }
  for (const key of keys) {
    if (
      !key ||
      typeof key !== "object" ||
      typeof (key as { kty?: unknown }).kty !== "string" ||
      "d" in key ||
      "p" in key ||
      "q" in key
    ) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.JWKS_INVALID);
    }
  }
  return { keys: keys as JSONWebKeySet["keys"] };
}

export class CloudflareAccessJwtVerifier {
  private readonly options: CloudflareAccessJwtVerifierOptions;
  private cached: { readonly jwks: JSONWebKeySet; readonly expiresAt: number } | undefined;

  constructor(options: CloudflareAccessJwtVerifierOptions) {
    const issuer = new URL(options.issuer);
    const jwks = new URL(options.jwksUrl);
    if (issuer.protocol !== "https:" || jwks.protocol !== "https:") {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.JWKS_INVALID);
    }
    const cacheMilliseconds = options.cacheMilliseconds ?? 300_000;
    const clockToleranceSeconds = options.clockToleranceSeconds ?? 30;
    if (
      !Number.isSafeInteger(cacheMilliseconds) ||
      cacheMilliseconds < 1_000 ||
      cacheMilliseconds > 3_600_000 ||
      !Number.isSafeInteger(clockToleranceSeconds) ||
      clockToleranceSeconds < 0 ||
      clockToleranceSeconds > 120
    ) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.JWKS_INVALID);
    }
    this.options = { ...options, cacheMilliseconds, clockToleranceSeconds };
  }

  async verify(
    token: string,
    observedAt = (this.options.now ?? (() => new Date()))(),
  ): Promise<VerifiedIdentityAssertion> {
    if (!token || token.length > 16_384) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
    }
    try {
      return await this.verifyWithCurrentKeys(token, observedAt, false);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) {
        throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
      }
      try {
        return await this.verifyWithCurrentKeys(token, observedAt, true);
      } catch {
        throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
      }
    }
  }

  private async verifyWithCurrentKeys(
    token: string,
    observedAt: Date,
    forceRefresh: boolean,
  ): Promise<VerifiedIdentityAssertion> {
    const jwks = await this.getJwks(observedAt, forceRefresh);
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
      algorithms: ["RS256"],
      issuer: this.options.issuer,
      audience: this.options.audience,
      currentDate: observedAt,
      clockTolerance: this.options.clockToleranceSeconds ?? 30,
    });
    if (
      protectedHeader.alg !== "RS256" ||
      typeof protectedHeader.kid !== "string" ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp)
    ) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
    }
    return Object.freeze({
      externalSubjectRef: sha256(`${this.options.issuer}\u0000${payload.sub}`),
      issuer: this.options.issuer,
      audience: this.options.audience,
      authenticatedAt: observedAt.toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    });
  }

  private async getJwks(observedAt: Date, forceRefresh: boolean): Promise<JSONWebKeySet> {
    if (!forceRefresh && this.cached && this.cached.expiresAt > observedAt.valueOf()) {
      return this.cached.jwks;
    }
    const fetched = validateJwks(
      await this.options.jwksFetcher.fetch(new URL(this.options.jwksUrl)),
    );
    this.cached = {
      jwks: fetched,
      expiresAt: observedAt.valueOf() + (this.options.cacheMilliseconds ?? 300_000),
    };
    return fetched;
  }
}

function isLoopback(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

function matchesDigest(secret: string, expectedDigest: string): boolean {
  const actual = Buffer.from(sha256(secret), "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export interface OwnerBootstrapServiceOptions {
  readonly enabled: boolean;
  readonly expiresAt: string;
  readonly tokenDigest: string;
  readonly identityState: OwnerIdentityStatePort;
  readonly now?: () => Date;
}

export class OwnerBootstrapService {
  private readonly options: OwnerBootstrapServiceOptions;

  constructor(options: OwnerBootstrapServiceOptions) {
    this.options = options;
  }

  async bootstrap(input: {
    readonly remoteAddress: string;
    readonly token: string;
    readonly ownerId: OwnerId;
    readonly assertion: VerifiedIdentityAssertion;
  }) {
    if (!this.options.enabled) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BOOTSTRAP_DISABLED);
    }
    if (!isLoopback(input.remoteAddress)) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BOOTSTRAP_NOT_LOOPBACK);
    }
    const now = (this.options.now ?? (() => new Date()))();
    if (now.valueOf() >= new Date(this.options.expiresAt).valueOf()) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BOOTSTRAP_EXPIRED);
    }
    if (!matchesDigest(input.token, this.options.tokenDigest)) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BOOTSTRAP_TOKEN_INVALID);
    }
    return this.options.identityState.bindFirstOwner({
      ownerId: input.ownerId,
      externalSubjectRef: input.assertion.externalSubjectRef,
      boundAt: now.toISOString(),
    });
  }
}

export interface ProductSessionAuthenticationServiceOptions {
  readonly verifier: CloudflareAccessJwtVerifier;
  readonly identityState: OwnerIdentityStatePort;
  readonly sessionState: SessionDeviceStatePort;
  readonly now?: () => Date;
  readonly createSessionId: () => SessionId;
  readonly createDeviceId: () => DeviceId;
  readonly createToken?: () => string;
}

export interface CreatedProductSession {
  readonly token: string;
  readonly session: ProductSessionRecord;
  readonly device: ProductDeviceRecord;
}

export class ProductSessionAuthenticationService implements HttpGatewayAuthenticationPort {
  private readonly options: ProductSessionAuthenticationServiceOptions;

  constructor(options: ProductSessionAuthenticationServiceOptions) {
    this.options = options;
  }

  async create(input: {
    readonly assertionToken: string;
    readonly deviceLabel: string;
  }): Promise<CreatedProductSession> {
    const now = (this.options.now ?? (() => new Date()))();
    const assertion = await this.options.verifier.verify(input.assertionToken, now);
    const binding = await this.options.identityState.readBySubject(assertion.externalSubjectRef);
    if (!binding || binding.status !== "active") {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.OWNER_NOT_BOUND);
    }
    const device = await this.options.sessionState.saveDevice(
      {
        id: this.options.createDeviceId(),
        ownerId: binding.ownerId,
        label: input.deviceLabel.slice(0, 128),
        status: "active",
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
      },
      null,
    );
    const token = (this.options.createToken ?? (() => randomBytes(32).toString("base64url")))();
    const session = await this.options.sessionState.saveSession(
      {
        id: this.options.createSessionId(),
        ownerId: binding.ownerId,
        deviceId: device.id,
        authenticationRef: sha256(token),
        status: "active",
        firstAuthenticatedAt: now.toISOString(),
        lastActiveAt: now.toISOString(),
        recentAuthenticatedAt: now.toISOString(),
        revokedAt: null,
      },
      null,
    );
    return Object.freeze({ token, session, device });
  }

  async authenticate(input: HttpGatewayAuthenticationInput): Promise<GatewayAuthenticationContext> {
    if (!input.accessAssertion || !input.sessionToken) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.SESSION_INVALID);
    }
    const now = (this.options.now ?? (() => new Date()))();
    const assertion = await this.options.verifier.verify(input.accessAssertion, now);
    const binding = await this.options.identityState.readBySubject(assertion.externalSubjectRef);
    const session = await this.options.sessionState.findSessionByAuthenticationRef(
      sha256(input.sessionToken),
    );
    if (
      !binding ||
      binding.status !== "active" ||
      !session ||
      session.status !== "active" ||
      session.ownerId !== binding.ownerId
    ) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.SESSION_INVALID);
    }
    await this.options.sessionState.saveSession(
      { ...session, lastActiveAt: now.toISOString() },
      session.revision,
    );
    return Object.freeze({
      subjectId: binding.ownerId,
      ownerId: binding.ownerId,
      deviceId: session.deviceId,
      authenticatedAt: assertion.authenticatedAt,
      authenticationRef: session.authenticationRef,
    });
  }

  async assertRecentAuthentication(authenticationRef: string, maximumAgeMilliseconds: number) {
    const session =
      await this.options.sessionState.findSessionByAuthenticationRef(authenticationRef);
    const now = (this.options.now ?? (() => new Date()))().valueOf();
    if (
      !session ||
      session.status !== "active" ||
      now - new Date(session.recentAuthenticatedAt).valueOf() > maximumAgeMilliseconds
    ) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.RECENT_AUTH_REQUIRED);
    }
    return session;
  }
}

export interface BreakGlassManagementLock {
  release(): Promise<void>;
}

export interface BreakGlassManagementLockPort {
  acquire(): Promise<BreakGlassManagementLock>;
}

export function createFileBreakGlassManagementLock(lockPath: string): BreakGlassManagementLockPort {
  return Object.freeze({
    async acquire() {
      const handle = await open(lockPath, "wx", 0o600).catch(() => {
        throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BREAK_GLASS_REJECTED);
      });
      return Object.freeze({
        async release() {
          await handle.close();
          await unlink(lockPath).catch(() => undefined);
        },
      });
    },
  });
}

export interface BreakGlassAuditPort {
  record(input: {
    readonly action: "repair_owner_mapping" | "revoke_session" | "revoke_device" | "disable_public";
    readonly outcome: "succeeded" | "failed";
    readonly occurredAt: string;
  }): Promise<void>;
}

export interface BreakGlassServiceOptions {
  readonly credentialDigest: string;
  readonly identityState: OwnerIdentityStatePort;
  readonly sessionState: SessionDeviceStatePort;
  readonly managementLock: BreakGlassManagementLockPort;
  readonly audit: BreakGlassAuditPort;
  readonly disablePublicIngress: () => Promise<void>;
  readonly now?: () => Date;
}

export type BreakGlassAction =
  | {
      readonly type: "repair_owner_mapping";
      readonly ownerId: OwnerId;
      readonly externalSubjectRef: string;
    }
  | {
      readonly type: "revoke_session";
      readonly sessionId: SessionId;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "revoke_device";
      readonly deviceId: DeviceId;
      readonly expectedRevision: number;
    }
  | { readonly type: "disable_public" };

export class BreakGlassService {
  private readonly options: BreakGlassServiceOptions;

  constructor(options: BreakGlassServiceOptions) {
    this.options = options;
  }

  async execute(input: {
    readonly remoteAddress: string;
    readonly credential: string;
    readonly action: BreakGlassAction;
  }): Promise<void> {
    if (
      !isLoopback(input.remoteAddress) ||
      !matchesDigest(input.credential, this.options.credentialDigest)
    ) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BREAK_GLASS_REJECTED);
    }
    const lock = await this.options.managementLock.acquire();
    const occurredAt = (this.options.now ?? (() => new Date()))().toISOString();
    try {
      switch (input.action.type) {
        case "repair_owner_mapping":
          await this.options.identityState.repairBinding({
            ownerId: input.action.ownerId,
            externalSubjectRef: input.action.externalSubjectRef,
            repairedAt: occurredAt,
          });
          break;
        case "revoke_session":
          await this.options.sessionState.revokeSession(
            input.action.sessionId,
            input.action.expectedRevision,
            occurredAt,
          );
          break;
        case "revoke_device":
          await this.options.sessionState.revokeDevice(
            input.action.deviceId,
            input.action.expectedRevision,
            occurredAt,
          );
          break;
        case "disable_public":
          await this.options.disablePublicIngress();
          break;
      }
      await this.options.audit.record({
        action: input.action.type,
        outcome: "succeeded",
        occurredAt,
      });
    } catch (error) {
      await this.options.audit.record({ action: input.action.type, outcome: "failed", occurredAt });
      throw error;
    } finally {
      await lock.release();
    }
  }
}

export function digestIdentityCredential(secret: string): string {
  return sha256(secret);
}

export interface SessionBoundCsrfServiceOptions {
  readonly key: Uint8Array;
  readonly now?: () => Date;
  readonly ttlMilliseconds?: number;
  readonly randomToken?: () => string;
}

export class SessionBoundCsrfService implements HttpGatewayCsrfPort {
  private readonly options: SessionBoundCsrfServiceOptions;

  constructor(options: SessionBoundCsrfServiceOptions) {
    const ttlMilliseconds = options.ttlMilliseconds ?? 30 * 60_000;
    if (
      options.key.byteLength < 32 ||
      !Number.isSafeInteger(ttlMilliseconds) ||
      ttlMilliseconds < 60_000 ||
      ttlMilliseconds > 24 * 60 * 60_000
    ) {
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.SESSION_INVALID);
    }
    this.options = { ...options, ttlMilliseconds };
  }

  async issue(authentication: GatewayAuthenticationContext): Promise<string> {
    const issuedAt = (this.options.now ?? (() => new Date()))().valueOf();
    const nonce = (this.options.randomToken ?? (() => randomBytes(18).toString("base64url")))();
    const prefix = `v1.${issuedAt}.${nonce}`;
    return `${prefix}.${this.signature(prefix, authentication.authenticationRef)}`;
  }

  async verify(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly token: string | null;
  }): Promise<boolean> {
    if (!input.token || input.token.length > 512) return false;
    const parts = input.token.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return false;
    const issuedAt = Number(parts[1]);
    const nonce = parts[2];
    const signature = parts[3];
    if (
      !Number.isSafeInteger(issuedAt) ||
      !nonce ||
      !signature ||
      !/^[A-Za-z0-9_-]+$/.test(nonce) ||
      !/^[A-Za-z0-9_-]+$/.test(signature)
    ) {
      return false;
    }
    const now = (this.options.now ?? (() => new Date()))().valueOf();
    if (issuedAt > now + 5_000 || now - issuedAt > (this.options.ttlMilliseconds ?? 30 * 60_000)) {
      return false;
    }
    const expected = this.signature(
      `v1.${issuedAt}.${nonce}`,
      input.authentication.authenticationRef,
    );
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    return (
      actualBytes.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(actualBytes, expectedBytes)
    );
  }

  private signature(prefix: string, authenticationRef: string): string {
    return createHmac("sha256", this.options.key)
      .update(`${prefix}\u0000${authenticationRef}`)
      .digest("base64url");
  }
}

export interface IdentityGatewayRouteOptions {
  readonly publicOrigin: string;
  readonly verifier: CloudflareAccessJwtVerifier;
  readonly bootstrap: OwnerBootstrapService;
  readonly sessions: ProductSessionAuthenticationService;
  readonly breakGlass: BreakGlassService;
  readonly sessionCookieName?: string;
}

function strictRecord<const Field extends string>(
  value: unknown,
  allowedFields: readonly Field[],
): Readonly<Record<Field, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedFields.includes(key as Field))) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
  }
  return record as Readonly<Record<Field, unknown>>;
}

function requiredRouteString(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
  }
  return value;
}

function routeHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function assertSessionCreationOrigin(request: FastifyRequest, origin: URL): void {
  if (
    routeHeader(request, "host") !== origin.host ||
    routeHeader(request, "origin") !== origin.origin ||
    routeHeader(request, "sec-fetch-site") !== "same-origin"
  ) {
    throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID);
  }
}

function parseBreakGlassAction(value: unknown): BreakGlassAction {
  const record = strictRecord(value, [
    "type",
    "ownerId",
    "externalSubjectRef",
    "sessionId",
    "deviceId",
    "expectedRevision",
  ]);
  switch (record.type) {
    case "repair_owner_mapping":
      return {
        type: "repair_owner_mapping",
        ownerId: createOwnerId(requiredRouteString(record.ownerId, 128)),
        externalSubjectRef: requiredRouteString(record.externalSubjectRef, 256),
      };
    case "revoke_session":
      if (
        !Number.isSafeInteger(record.expectedRevision) ||
        (record.expectedRevision as number) < 0
      ) {
        throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BREAK_GLASS_REJECTED);
      }
      return {
        type: "revoke_session",
        sessionId: createSessionId(requiredRouteString(record.sessionId, 128)),
        expectedRevision: record.expectedRevision as number,
      };
    case "revoke_device":
      if (
        !Number.isSafeInteger(record.expectedRevision) ||
        (record.expectedRevision as number) < 0
      ) {
        throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BREAK_GLASS_REJECTED);
      }
      return {
        type: "revoke_device",
        deviceId: createDeviceId(requiredRouteString(record.deviceId, 128)),
        expectedRevision: record.expectedRevision as number,
      };
    case "disable_public":
      return { type: "disable_public" };
    default:
      throw new IdentityGatewayError(IDENTITY_GATEWAY_ERROR_CODES.BREAK_GLASS_REJECTED);
  }
}

function respondWithIdentityError(reply: FastifyReply, error: unknown): FastifyReply {
  const code =
    error instanceof IdentityGatewayError
      ? error.code
      : IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID;
  return reply
    .code(code === IDENTITY_GATEWAY_ERROR_CODES.BOOTSTRAP_DISABLED ? 404 : 403)
    .header("cache-control", "no-store")
    .send({ error: { code } });
}

export function registerIdentityGatewayRoutes(
  app: FastifyInstance,
  options: IdentityGatewayRouteOptions,
): void {
  const publicOrigin = new URL(options.publicOrigin);

  app.post("/bootstrap", async (request, reply) => {
    try {
      const body = strictRecord(request.body, ["token", "ownerId", "assertionToken"]);
      const assertionToken = requiredRouteString(body.assertionToken, 16_384);
      const assertion = await options.verifier.verify(assertionToken);
      const binding = await options.bootstrap.bootstrap({
        remoteAddress: request.ip,
        token: requiredRouteString(body.token),
        ownerId: createOwnerId(requiredRouteString(body.ownerId, 128)),
        assertion,
      });
      return reply.code(201).header("cache-control", "no-store").send(binding);
    } catch (error) {
      return respondWithIdentityError(reply, error);
    }
  });

  app.post("/api/identity/v1/sessions", async (request, reply) => {
    try {
      assertSessionCreationOrigin(request, publicOrigin);
      const body = strictRecord(request.body, ["deviceLabel"]);
      const assertionToken = requiredRouteString(
        routeHeader(request, "cf-access-jwt-assertion"),
        16_384,
      );
      const created = await options.sessions.create({
        assertionToken,
        deviceLabel: requiredRouteString(body.deviceLabel, 128),
      });
      const cookieName = options.sessionCookieName ?? "himawari_session";
      reply.header(
        "set-cookie",
        `${cookieName}=${encodeURIComponent(created.token)}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      );
      return reply.code(201).header("cache-control", "no-store").send({
        session: created.session,
        device: created.device,
      });
    } catch (error) {
      return respondWithIdentityError(reply, error);
    }
  });

  app.post("/break-glass", async (request, reply) => {
    try {
      const body = strictRecord(request.body, ["credential", "action"]);
      await options.breakGlass.execute({
        remoteAddress: request.ip,
        credential: requiredRouteString(body.credential),
        action: parseBreakGlassAction(body.action),
      });
      return reply.code(204).header("cache-control", "no-store").send();
    } catch (error) {
      return respondWithIdentityError(reply, error);
    }
  });
}
