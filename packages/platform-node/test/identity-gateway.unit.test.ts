import type {
  OwnerIdentityBindingRecord,
  OwnerIdentityStatePort,
  ProductDeviceRecord,
  ProductSessionRecord,
  SessionDeviceStatePort,
} from "@himawari-agent/application";
import { RecentAuthenticationGuard } from "@himawari-agent/application";
import {
  createDeviceId,
  createOwnerId,
  createSessionId,
  type DeviceId,
  type OwnerId,
  type SessionId,
} from "@himawari-agent/domain";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet } from "jose";
import Fastify from "fastify";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  BreakGlassService,
  CloudflareAccessIdentityClient,
  CloudflareAccessJwtVerifier,
  IDENTITY_GATEWAY_ERROR_CODES,
  OwnerBootstrapService,
  ProductSessionAuthenticationService,
  SessionBoundCsrfService,
  digestIdentityCredential,
  registerIdentityGatewayRoutes,
} from "../src/identity-gateway.js";

const NOW = new Date("2026-08-27T00:00:00.000Z");
const ISSUER = "https://team.cloudflareaccess.com";
const AUDIENCE = "access-audience-01";
const OWNER_ID = createOwnerId("owner-01");

let firstPrivateKey: CryptoKey;
let secondPrivateKey: CryptoKey;
let firstJwks: JSONWebKeySet;
let secondJwks: JSONWebKeySet;

beforeAll(async () => {
  const first = await generateKeyPair("RS256", { extractable: true });
  const second = await generateKeyPair("RS256", { extractable: true });
  firstPrivateKey = first.privateKey;
  secondPrivateKey = second.privateKey;
  firstJwks = { keys: [{ ...(await exportJWK(first.publicKey)), kid: "key-01", alg: "RS256" }] };
  secondJwks = {
    keys: [{ ...(await exportJWK(second.publicKey)), kid: "key-02", alg: "RS256" }],
  };
});

async function token(input: {
  readonly key?: CryptoKey;
  readonly kid?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly notBefore?: number;
}) {
  const seconds = Math.floor(NOW.valueOf() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: input.kid ?? "key-01" })
    .setIssuer(input.issuer ?? ISSUER)
    .setAudience(input.audience ?? AUDIENCE)
    .setSubject(input.subject ?? "subject-01")
    .setIssuedAt(input.issuedAt ?? seconds)
    .setNotBefore(input.notBefore ?? seconds - 1)
    .setExpirationTime(input.expiresAt ?? seconds + 300)
    .sign(input.key ?? firstPrivateKey);
}

class IdentityState implements OwnerIdentityStatePort {
  binding: OwnerIdentityBindingRecord | undefined;

  async bindFirstOwner(input: {
    readonly ownerId: OwnerId;
    readonly externalSubjectRef: string;
    readonly boundAt: string;
  }) {
    if (this.binding) throw new Error("BOOTSTRAP_CONSUMED");
    this.binding = { ...input, status: "active" };
    return this.binding;
  }

  async readBySubject(externalSubjectRef: string) {
    return this.binding?.externalSubjectRef === externalSubjectRef ? this.binding : undefined;
  }

  async readByOwner(ownerId: OwnerId) {
    return this.binding?.ownerId === ownerId ? this.binding : undefined;
  }

  async repairBinding(input: {
    readonly ownerId: OwnerId;
    readonly externalSubjectRef: string;
    readonly repairedAt: string;
  }) {
    if (!this.binding || this.binding.ownerId !== input.ownerId) throw new Error("NOT_FOUND");
    this.binding = {
      ownerId: input.ownerId,
      externalSubjectRef: input.externalSubjectRef,
      boundAt: input.repairedAt,
      status: "active",
    };
    return this.binding;
  }
}

class SessionState implements SessionDeviceStatePort {
  readonly sessions = new Map<SessionId, ProductSessionRecord>();
  readonly devices = new Map<DeviceId, ProductDeviceRecord>();

  async readSession(sessionId: SessionId) {
    return this.sessions.get(sessionId);
  }

  async findSessionByAuthenticationRef(authenticationRef: string) {
    return [...this.sessions.values()].find(
      (session) => session.authenticationRef === authenticationRef,
    );
  }

  async listSessions(ownerId: OwnerId, includeRevoked: boolean) {
    return [...this.sessions.values()].filter(
      (session) => session.ownerId === ownerId && (includeRevoked || session.status === "active"),
    );
  }

  async listDevices(ownerId: OwnerId, includeRevoked: boolean) {
    return [...this.devices.values()].filter(
      (device) => device.ownerId === ownerId && (includeRevoked || device.status === "active"),
    );
  }

  async saveDevice(device: Omit<ProductDeviceRecord, "revision">, expectedRevision: number | null) {
    const current = this.devices.get(device.id);
    const saved = {
      ...device,
      revision: expectedRevision === null ? 0 : (current?.revision ?? 0) + 1,
    };
    this.devices.set(device.id, saved);
    return saved;
  }

  async revokeDevice(deviceId: DeviceId, expectedRevision: number, revokedAt: string) {
    const current = this.devices.get(deviceId);
    if (!current || current.revision !== expectedRevision) throw new Error("CONFLICT");
    const saved = {
      ...current,
      revision: current.revision + 1,
      status: "revoked" as const,
      lastSeenAt: revokedAt,
    };
    this.devices.set(deviceId, saved);
    for (const [id, session] of this.sessions) {
      if (session.deviceId === deviceId && session.status === "active") {
        this.sessions.set(id, {
          ...session,
          revision: session.revision + 1,
          status: "revoked",
          revokedAt,
        });
      }
    }
    return saved;
  }

  async saveSession(
    session: Omit<ProductSessionRecord, "revision">,
    expectedRevision: number | null,
  ) {
    const current = this.sessions.get(session.id);
    const saved = {
      ...session,
      revision: expectedRevision === null ? 0 : (current?.revision ?? 0) + 1,
    };
    this.sessions.set(session.id, saved);
    return saved;
  }

  async revokeSession(sessionId: SessionId, expectedRevision: number, revokedAt: string) {
    const current = this.sessions.get(sessionId);
    if (!current || current.revision !== expectedRevision) throw new Error("CONFLICT");
    const saved = {
      ...current,
      revision: current.revision + 1,
      status: "revoked" as const,
      revokedAt,
    };
    this.sessions.set(sessionId, saved);
    return saved;
  }
}

describe("Cloudflare Access JWT verification", () => {
  it("validates RS256 claims and refreshes a bounded JWKS cache on kid rotation", async () => {
    let current = firstJwks;
    let fetches = 0;
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          fetches += 1;
          return current;
        },
      },
      now: () => NOW,
    });
    const first = await verifier.verify(await token({}));
    current = secondJwks;
    const second = await verifier.verify(
      await token({ key: secondPrivateKey, kid: "key-02", subject: "subject-02" }),
    );

    expect(first.externalSubjectRef).toMatch(/^sha256:/);
    expect(second.externalSubjectRef).not.toBe(first.externalSubjectRef);
    expect(fetches).toBe(2);
  });

  it.each([
    ["wrong issuer", { issuer: "https://wrong.example" }],
    ["wrong audience", { audience: "wrong-audience" }],
    ["expired", { expiresAt: Math.floor(NOW.valueOf() / 1000) - 60 }],
    ["future", { notBefore: Math.floor(NOW.valueOf() / 1000) + 300 }],
  ])("rejects %s assertions", async (_label, claims) => {
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    await expect(verifier.verify(await token(claims))).rejects.toMatchObject({
      code: IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID,
    });
  });

  it("rejects a forged signature", async () => {
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    const signed = await token({});
    const parts = signed.split(".");
    const signature = parts[2] ?? "";
    parts[2] = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
    const forged = parts.join(".");
    await expect(verifier.verify(forged)).rejects.toMatchObject({
      code: IDENTITY_GATEWAY_ERROR_CODES.ASSERTION_INVALID,
    });
  });
});

describe("Cloudflare Access get-identity freshness source", () => {
  it("uses the fixed get-identity endpoint with the official authorization cookie", async () => {
    const signed = await token({});
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    const assertion = await verifier.verifyForIdentityLookup(signed);
    const calls: Array<{ readonly url: URL; readonly init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        calls.push({ url: new URL(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            user_uuid: assertion.providerSubject,
            iat: Math.floor((NOW.valueOf() - 30_000) / 1000),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    try {
      const client = new CloudflareAccessIdentityClient({
        issuer: ISSUER,
        subjectBinding: "user_uuid_equals_sub",
        now: () => NOW,
      });
      await expect(
        client.read({
          assertionToken: signed,
          assertion,
          providerSubject: assertion.providerSubject,
        }),
      ).resolves.toMatchObject({
        source: "cloudflare_access_login_time",
        externalSubjectRef: assertion.externalSubjectRef,
        expiresAt: assertion.expiresAt,
        authenticatedAt: new Date(NOW.valueOf() - 30_000).toISOString(),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url.toString()).toBe(`${ISSUER}/cdn-cgi/access/get-identity`);
      expect(calls[0]?.init.redirect).toBe("error");
      expect(calls[0]?.init.headers).toMatchObject({
        Cookie: `CF_Authorization=${signed}`,
      });
      expect(calls[0]?.init.headers).not.toHaveProperty("cf-access-jwt-assertion");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a subject mismatch, oversized response, streaming overflow, and timed-out lookup", async () => {
    const signed = await token({});
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    const assertion = await verifier.verifyForIdentityLookup(signed);
    const client = new CloudflareAccessIdentityClient({
      issuer: ISSUER,
      subjectBinding: "user_uuid_equals_sub",
      maximumBodyBytes: 64,
      timeoutMilliseconds: 5,
      now: () => NOW,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ user_uuid: "other-subject", iat: 1 }), { status: 200 }),
      ),
    );
    try {
      await expect(
        client.read({
          assertionToken: signed,
          assertion,
          providerSubject: assertion.providerSubject,
        }),
      ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.FRESHNESS_UNAVAILABLE });
    } finally {
      vi.unstubAllGlobals();
    }

    let stalledBodyCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([123]));
          },
          pull() {
            return new Promise<void>(() => undefined);
          },
          cancel() {
            stalledBodyCancelled = true;
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );
    try {
      await expect(
        client.read({
          assertionToken: signed,
          assertion,
          providerSubject: assertion.providerSubject,
        }),
      ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.FRESHNESS_UNAVAILABLE });
      expect(stalledBodyCancelled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    let oversizedBodyCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([123]));
              },
              cancel() {
                oversizedBodyCancelled = true;
              },
            }),
            { status: 200, headers: { "content-length": "1000" } },
          ),
      ),
    );
    try {
      await expect(
        client.read({
          assertionToken: signed,
          assertion,
          providerSubject: assertion.providerSubject,
        }),
      ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.FRESHNESS_UNAVAILABLE });
      expect(oversizedBodyCancelled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    let errorBodyCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([123]));
              },
              cancel() {
                errorBodyCancelled = true;
              },
            }),
            { status: 401 },
          ),
      ),
    );
    try {
      await expect(
        client.read({
          assertionToken: signed,
          assertion,
          providerSubject: assertion.providerSubject,
        }),
      ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.FRESHNESS_UNAVAILABLE });
      expect(errorBodyCancelled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    let overflowBodyCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(100)));
          },
          cancel() {
            overflowBodyCancelled = true;
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );
    try {
      await expect(
        client.read({
          assertionToken: signed,
          assertion,
          providerSubject: assertion.providerSubject,
        }),
      ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.FRESHNESS_UNAVAILABLE });
      expect(overflowBodyCancelled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: URL | string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
              once: true,
            });
          }),
      ),
    );
    try {
      await expect(
        client.read({
          assertionToken: signed,
          assertion,
          providerSubject: assertion.providerSubject,
        }),
      ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.FRESHNESS_UNAVAILABLE });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Owner bootstrap and product sessions", () => {
  it("allows one short-lived loopback bootstrap and rejects replay/non-loopback/default-off", async () => {
    const identity = new IdentityState();
    const input = {
      remoteAddress: "127.0.0.1",
      token: "bootstrap-secret",
      ownerId: OWNER_ID,
      assertion: {
        externalSubjectRef: "subject-ref-01",
        issuer: ISSUER,
        audience: AUDIENCE,
        authenticatedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
      },
    };
    const bootstrap = new OwnerBootstrapService({
      enabled: true,
      expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
      tokenDigest: digestIdentityCredential(input.token),
      identityState: identity,
      now: () => NOW,
    });
    expect(await bootstrap.bootstrap(input)).toMatchObject({ ownerId: OWNER_ID });
    await expect(bootstrap.bootstrap(input)).rejects.toThrow("BOOTSTRAP_CONSUMED");

    const remote = new OwnerBootstrapService({
      enabled: true,
      expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
      tokenDigest: digestIdentityCredential(input.token),
      identityState: new IdentityState(),
      now: () => NOW,
    });
    await expect(remote.bootstrap({ ...input, remoteAddress: "10.0.0.2" })).rejects.toMatchObject({
      code: IDENTITY_GATEWAY_ERROR_CODES.BOOTSTRAP_NOT_LOOPBACK,
    });
    const disabled = new OwnerBootstrapService({
      enabled: false,
      expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
      tokenDigest: digestIdentityCredential(input.token),
      identityState: new IdentityState(),
      now: () => NOW,
    });
    await expect(disabled.bootstrap(input)).rejects.toMatchObject({
      code: IDENTITY_GATEWAY_ERROR_CODES.BOOTSTRAP_DISABLED,
    });
  });

  it("creates hashed product sessions, updates activity and enforces recent-auth/revocation", async () => {
    const signed = await token({});
    const identity = new IdentityState();
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    const assertion = await verifier.verify(signed);
    identity.binding = {
      ownerId: OWNER_ID,
      externalSubjectRef: assertion.externalSubjectRef,
      boundAt: NOW.toISOString(),
      status: "active",
    };
    const sessions = new SessionState();
    let current = NOW;
    const service = new ProductSessionAuthenticationService({
      verifier,
      identityState: identity,
      sessionState: sessions,
      now: () => current,
      createDeviceId: () => createDeviceId("device-01"),
      createSessionId: () => createSessionId("browser-session-01"),
      createToken: () => "session-secret-01",
    });
    const created = await service.create({ assertionToken: signed, deviceLabel: "MacBook" });
    expect(created.session.authenticationRef).toMatch(/^sha256:/);
    expect(created.session.authenticationRef).not.toContain(created.token);

    current = new Date(NOW.valueOf() + 5_000);
    const authenticated = await service.authenticate({
      accessAssertion: signed,
      sessionToken: created.token,
      method: "POST",
      path: "/api/gateway/v1/commands",
    });
    expect(authenticated).toMatchObject({ ownerId: OWNER_ID, deviceId: created.device.id });
    expect(authenticated.recentAuthenticationEvidence).toBeUndefined();

    current = new Date(NOW.valueOf() + 20_000);
    const active = await sessions.readSession(created.session.id);
    await sessions.revokeSession(created.session.id, active?.revision ?? -1, current.toISOString());
    await expect(
      service.authenticate({
        accessAssertion: signed,
        sessionToken: created.token,
        method: "GET",
        path: "/api/gateway/v1/events",
      }),
    ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.SESSION_INVALID });

    const otherSubject = await token({ subject: "subject-other" });
    await expect(
      service.create({ assertionToken: otherSubject, deviceLabel: "Unknown" }),
    ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.OWNER_NOT_BOUND });
  });

  it("does not promote an old but still valid assertion into recent authentication", async () => {
    const signed = await token({
      issuedAt: Math.floor((NOW.valueOf() - 120_000) / 1000),
      expiresAt: Math.floor((NOW.valueOf() + 300_000) / 1000),
    });
    const identity = new IdentityState();
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    const assertion = await verifier.verify(signed);
    identity.binding = {
      ownerId: OWNER_ID,
      externalSubjectRef: assertion.externalSubjectRef,
      boundAt: NOW.toISOString(),
      status: "active",
    };
    const sessions = new SessionState();
    const service = new ProductSessionAuthenticationService({
      verifier,
      identityState: identity,
      sessionState: sessions,
      now: () => NOW,
      createDeviceId: () => createDeviceId("device-old-assertion"),
      createSessionId: () => createSessionId("session-old-assertion"),
      createToken: () => "session-old-assertion-secret",
    });

    const created = await service.create({
      assertionToken: signed,
      deviceLabel: "Old assertion",
    });
    const authenticated = await service.authenticate({
      accessAssertion: signed,
      sessionToken: created.token,
      method: "GET",
      path: "/api/control-center/v1/config",
    });
    expect(authenticated.recentAuthenticationEvidence).toBeUndefined();
    const guard = new RecentAuthenticationGuard({
      identityState: identity,
      sessionState: sessions,
      policy: { maximumAgeMilliseconds: 60_000, clockSkewMilliseconds: 0 },
      now: () => NOW.toISOString(),
    });
    await expect(
      guard.assertRecentAuthentication({
        authentication: authenticated,
        expectedAuthenticationRef: created.session.authenticationRef,
      }),
    ).rejects.toMatchObject({
      code: "PORT_NOT_AUTHORITATIVE",
      details: { reasonCode: "RECENT_AUTH_REQUIRED", reason: "evidence_missing" },
    });
  });

  it("keeps provider freshness typed, session-bound, and optional for ordinary auth", async () => {
    const signed = await token({});
    const identity = new IdentityState();
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    const assertion = await verifier.verifyForIdentityLookup(signed);
    identity.binding = {
      ownerId: OWNER_ID,
      externalSubjectRef: assertion.externalSubjectRef,
      boundAt: NOW.toISOString(),
      status: "active",
    };
    const sessions = new SessionState();
    let providerAvailable = true;
    const service = new ProductSessionAuthenticationService({
      verifier,
      identityState: identity,
      sessionState: sessions,
      recentAuthenticationProvider: {
        async read(input) {
          if (!providerAvailable) throw new Error("bounded lookup unavailable");
          return {
            source: "cloudflare_access_login_time" as const,
            externalSubjectRef: input.assertion.externalSubjectRef,
            authenticatedAt: new Date(NOW.valueOf() - 30_000).toISOString(),
            expiresAt: input.assertion.expiresAt,
          };
        },
      },
      now: () => NOW,
      createDeviceId: () => createDeviceId("device-optional-freshness"),
      createSessionId: () => createSessionId("session-optional-freshness"),
      createToken: () => "session-optional-freshness-secret",
    });
    const created = await service.create({ assertionToken: signed, deviceLabel: "MacBook" });
    const fresh = await service.authenticate({
      accessAssertion: signed,
      sessionToken: created.token,
      method: "GET",
      path: "/api/control-center/v1/config",
    });
    expect(fresh.recentAuthenticationEvidence).toMatchObject({
      source: "cloudflare_access_login_time",
      externalSubjectRef: assertion.externalSubjectRef,
      ownerId: OWNER_ID,
      deviceId: created.device.id,
      authenticationRef: created.session.authenticationRef,
    });

    providerAvailable = false;
    const ordinary = await service.authenticate({
      accessAssertion: signed,
      sessionToken: created.token,
      method: "GET",
      path: "/api/gateway/v1/queries",
    });
    expect(ordinary.recentAuthenticationEvidence).toBeUndefined();
  });

  it.each([
    ["malformed", "not-a-date"],
    ["future", new Date(NOW.valueOf() + 60_000).toISOString()],
  ])("rejects %s persisted recent-auth timestamps", async (_label, recentAuthenticatedAt) => {
    const signed = await token({});
    const identity = new IdentityState();
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    const assertion = await verifier.verify(signed);
    identity.binding = {
      ownerId: OWNER_ID,
      externalSubjectRef: assertion.externalSubjectRef,
      boundAt: NOW.toISOString(),
      status: "active",
    };
    const sessions = new SessionState();
    const service = new ProductSessionAuthenticationService({
      verifier,
      identityState: identity,
      sessionState: sessions,
      now: () => NOW,
      createDeviceId: () => createDeviceId("device-invalid-recent-auth"),
      createSessionId: () => createSessionId("session-invalid-recent-auth"),
      createToken: () => "session-invalid-recent-auth-secret",
    });
    const created = await service.create({ assertionToken: signed, deviceLabel: "Fixture" });
    const session = await sessions.readSession(created.session.id);
    if (!session) throw new Error("session fixture missing");
    sessions.sessions.set(session.id, { ...session, recentAuthenticatedAt });
    const authenticated = await service.authenticate({
      accessAssertion: signed,
      sessionToken: created.token,
      method: "GET",
      path: "/api/control-center/v1/config",
    });
    expect(authenticated.recentAuthenticationEvidence).toBeUndefined();
    const guard = new RecentAuthenticationGuard({
      identityState: identity,
      sessionState: sessions,
      policy: { maximumAgeMilliseconds: 60_000, clockSkewMilliseconds: 0 },
      now: () => NOW.toISOString(),
    });
    await expect(
      guard.assertRecentAuthentication({
        authentication: authenticated,
        expectedAuthenticationRef: created.session.authenticationRef,
      }),
    ).rejects.toMatchObject({
      code: "PORT_NOT_AUTHORITATIVE",
      details: { reasonCode: "RECENT_AUTH_REQUIRED", reason: "evidence_missing" },
    });
  });

  it("issues session-bound CSRF tokens with expiry and rejects cross-session replay", async () => {
    let current = NOW;
    const csrf = new SessionBoundCsrfService({
      key: new Uint8Array(32).fill(7),
      ttlMilliseconds: 60_000,
      randomToken: () => "nonce-01",
      now: () => current,
    });
    const authentication = {
      subjectId: "owner-01",
      ownerId: "owner-01",
      deviceId: "device-01",
      authenticatedAt: NOW.toISOString(),
      authenticationRef: "sha256:session-01",
    };
    const csrfToken = await csrf.issue(authentication);
    expect(await csrf.verify({ authentication, token: csrfToken })).toBe(true);
    expect(
      await csrf.verify({
        authentication: { ...authentication, authenticationRef: "sha256:session-02" },
        token: csrfToken,
      }),
    ).toBe(false);
    current = new Date(NOW.valueOf() + 60_001);
    expect(await csrf.verify({ authentication, token: csrfToken })).toBe(false);
  });
});

describe("break-glass boundary", () => {
  it("uses loopback credential, exclusive lock and a fixed action allowlist with audit", async () => {
    const identity = new IdentityState();
    identity.binding = {
      ownerId: OWNER_ID,
      externalSubjectRef: "old-subject",
      boundAt: NOW.toISOString(),
      status: "active",
    };
    const sessions = new SessionState();
    let locked = false;
    let disabled = false;
    const audit: string[] = [];
    const service = new BreakGlassService({
      credentialDigest: digestIdentityCredential("recovery-secret"),
      identityState: identity,
      sessionState: sessions,
      managementLock: {
        async acquire() {
          if (locked) throw new Error("LOCKED");
          locked = true;
          return {
            async release() {
              locked = false;
            },
          };
        },
      },
      audit: {
        async record(entry) {
          audit.push(`${entry.action}:${entry.outcome}`);
        },
      },
      async disablePublicIngress() {
        disabled = true;
      },
      now: () => NOW,
    });
    await service.execute({
      remoteAddress: "::1",
      credential: "recovery-secret",
      action: {
        type: "repair_owner_mapping",
        ownerId: OWNER_ID,
        externalSubjectRef: "new-subject",
      },
    });
    await service.execute({
      remoteAddress: "127.0.0.1",
      credential: "recovery-secret",
      action: { type: "disable_public" },
    });
    expect(identity.binding?.externalSubjectRef).toBe("new-subject");
    expect(disabled).toBe(true);
    expect(audit).toEqual(["repair_owner_mapping:succeeded", "disable_public:succeeded"]);
    await expect(
      service.execute({
        remoteAddress: "10.0.0.2",
        credential: "recovery-secret",
        action: { type: "disable_public" },
      }),
    ).rejects.toMatchObject({ code: IDENTITY_GATEWAY_ERROR_CODES.BREAK_GLASS_REJECTED });
  });

  it("keeps bootstrap, session creation and break-glass on independent minimal routes", async () => {
    const signed = await token({});
    const identity = new IdentityState();
    const sessions = new SessionState();
    const verifier = new CloudflareAccessJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: `${ISSUER}/cdn-cgi/access/certs`,
      jwksFetcher: {
        async fetch() {
          return firstJwks;
        },
      },
      now: () => NOW,
    });
    const bootstrap = new OwnerBootstrapService({
      enabled: true,
      expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
      tokenDigest: digestIdentityCredential("bootstrap-secret"),
      identityState: identity,
      now: () => NOW,
    });
    const sessionService = new ProductSessionAuthenticationService({
      verifier,
      identityState: identity,
      sessionState: sessions,
      now: () => NOW,
      createDeviceId: () => createDeviceId("device-route-01"),
      createSessionId: () => createSessionId("session-route-01"),
      createToken: () => "route-session-secret",
    });
    let publicDisabled = false;
    const breakGlass = new BreakGlassService({
      credentialDigest: digestIdentityCredential("recovery-secret"),
      identityState: identity,
      sessionState: sessions,
      managementLock: {
        async acquire() {
          return { async release() {} };
        },
      },
      audit: { async record() {} },
      async disablePublicIngress() {
        publicDisabled = true;
      },
      now: () => NOW,
    });
    const app = Fastify({ logger: false });
    registerIdentityGatewayRoutes(app, {
      publicOrigin: "https://agent.example.test",
      verifier,
      bootstrap,
      sessions: sessionService,
      breakGlass,
    });
    const bootstrapped = await app.inject({
      method: "POST",
      url: "/bootstrap",
      payload: { token: "bootstrap-secret", ownerId: OWNER_ID, assertionToken: signed },
    });
    expect(bootstrapped.statusCode).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: "/api/identity/v1/sessions",
      headers: {
        host: "agent.example.test",
        origin: "https://agent.example.test",
        "sec-fetch-site": "same-origin",
        "cf-access-jwt-assertion": signed,
      },
      payload: { deviceLabel: "MacBook" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["set-cookie"]).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(created.body).not.toContain("route-session-secret");

    const recovered = await app.inject({
      method: "POST",
      url: "/break-glass",
      payload: { credential: "recovery-secret", action: { type: "disable_public" } },
    });
    expect(recovered.statusCode).toBe(204);
    expect(publicDisabled).toBe(true);
    await app.close();
  });
});
