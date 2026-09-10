import cookiePlugin from "@fastify/cookie";
import { ApplicationPortError, PORT_ERROR_CODES } from "@himawari-agent/application";
import type {
  GatewayAuthenticationContext,
  RecentAuthenticationGuardPort,
  SessionDeviceStatePort,
} from "@himawari-agent/application";
import { createDeviceId, createOwnerId, createSessionId } from "@himawari-agent/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  BuiltInAuthenticationError,
  type BuiltInAuthenticationService,
} from "./built-in-identity.js";
import type { HttpGatewayCsrfPort } from "./http-gateway-server.js";

export interface BuiltInIdentityRouteOptions {
  readonly publicOrigin: string;
  readonly sessionCookieName: string;
  readonly sessions: BuiltInAuthenticationService;
  readonly state: SessionDeviceStatePort;
  readonly csrf: HttpGatewayCsrfPort;
  readonly recentAuthentication: RecentAuthenticationGuardPort;
  readonly sessionAbsoluteMilliseconds: number;
  readonly now?: () => Date;
}

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    throw new BuiltInAuthenticationError();
  return value as Record<string, unknown>;
}
function field(value: unknown, maximum = 1024): string {
  if (typeof value !== "string" || !value || value.length > maximum)
    throw new BuiltInAuthenticationError();
  return value;
}

export function registerBuiltInIdentityRoutes(
  app: FastifyInstance,
  options: BuiltInIdentityRouteOptions,
): void {
  const origin = new URL(options.publicOrigin);
  const cookieName = options.sessionCookieName;
  const challengeCookie = `${cookieName}_challenge`;
  const cookie = {
    path: "/",
    httpOnly: true,
    secure: origin.protocol === "https:",
    sameSite: "strict" as const,
  };
  const now = options.now ?? (() => new Date());
  const assertOrigin = (request: FastifyRequest): void => {
    if (
      request.headers.host !== origin.host ||
      request.headers.origin !== origin.origin ||
      request.headers["sec-fetch-site"] !== "same-origin"
    )
      throw new BuiltInAuthenticationError();
  };
  const authenticate = (request: FastifyRequest) =>
    options.sessions.authenticate({
      accessAssertion: null,
      sessionToken: request.cookies[cookieName] ?? null,
      method: request.method,
      path: request.url,
    });
  const mutate = async (request: FastifyRequest): Promise<GatewayAuthenticationContext> => {
    assertOrigin(request);
    const authentication = await authenticate(request);
    if (
      !(await options.csrf.verify({
        authentication,
        token:
          typeof request.headers["x-csrf-token"] === "string"
            ? request.headers["x-csrf-token"]
            : null,
        method: request.method,
        path: request.url,
      }))
    )
      throw new BuiltInAuthenticationError();
    return authentication;
  };
  // Encapsulation prevents route-specific error handling from changing Gateway semantics.
  app.register(async (routes) => {
    await routes.register(cookiePlugin);
    routes.addHook("onRequest", async (_request, reply) => {
      reply.header("cache-control", "no-store");
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (
        error instanceof ApplicationPortError &&
        error.code === PORT_ERROR_CODES.NOT_AUTHORITATIVE
      ) {
        void reply.code(403).send({ error: "RECENT_AUTH_REQUIRED" });
        return;
      }
      if (!(error instanceof BuiltInAuthenticationError)) {
        void reply.code(500).send({ error: "IDENTITY_SERVICE_UNAVAILABLE" });
        return;
      }
      const code = error.code;
      if (code === "IDENTITY_RATE_LIMITED") reply.header("retry-after", "300");
      void reply.code(code === "IDENTITY_RATE_LIMITED" ? 429 : 401).send({ error: code });
    });
    for (const kind of ["password", "reauthenticate"] as const) {
      routes.post(`/api/identity/v1/${kind}`, { bodyLimit: 4096 }, async (request, reply) => {
        assertOrigin(request);
        const authentication = kind === "reauthenticate" ? await mutate(request) : undefined;
        const body = fields(request.body, ["username", "password", "deviceLabel"]);
        const challenge = await options.sessions.begin({
          username: field(body["username"], 64),
          password: field(body["password"]),
          deviceLabel: field(body["deviceLabel"], 80),
          ...(authentication ? { authenticationRef: authentication.authenticationRef } : {}),
        });
        reply.setCookie(challengeCookie, challenge, { ...cookie, maxAge: 300 });
        return reply.code(202).send({ step: "second-factor" });
      });
    }
    routes.post("/api/identity/v1/verify", { bodyLimit: 1024 }, async (request, reply) => {
      assertOrigin(request);
      const body = fields(request.body, ["code"]);
      const result = await options.sessions.finish(
        request.cookies[challengeCookie] ?? "",
        field(body["code"], 80),
      );
      reply.clearCookie(challengeCookie, cookie);
      reply.setCookie(cookieName, result.token, {
        ...cookie,
        maxAge: options.sessionAbsoluteMilliseconds / 1000,
      });
      return reply.code(201).send({ authenticated: true });
    });
    routes.post("/api/identity/v1/logout", async (request, reply) => {
      const auth = await mutate(request);
      if (!auth.sessionId) throw new BuiltInAuthenticationError();
      const session = await options.state.readSession(createSessionId(auth.sessionId));
      if (!session || session.authenticationRef !== auth.authenticationRef)
        throw new BuiltInAuthenticationError();
      await options.state.revokeSession(session.id, session.revision, now().toISOString());
      reply.clearCookie(cookieName, cookie).clearCookie(challengeCookie, cookie);
      return { authenticated: false };
    });
    routes.get("/api/identity/v1/devices", async (request) => {
      const auth = await authenticate(request);
      const devices = await options.state.listDevices(createOwnerId(auth.ownerId), false);
      return {
        devices: devices.map(({ id, label, lastSeenAt }) => ({
          id,
          label,
          lastSeenAt,
          current: id === auth.deviceId,
        })),
      };
    });
    routes.post("/api/identity/v1/devices/revoke", { bodyLimit: 1024 }, async (request) => {
      const auth = await mutate(request);
      await options.recentAuthentication.assertRecentAuthentication({
        authentication: auth,
        expectedAuthenticationRef: auth.authenticationRef,
      });
      const body = fields(request.body, ["deviceId"]);
      const id = createDeviceId(field(body["deviceId"], 128));
      const device = (await options.state.listDevices(createOwnerId(auth.ownerId), false)).find(
        (entry) => entry.id === id,
      );
      if (!device) throw new BuiltInAuthenticationError();
      await options.state.revokeDevice(id, device.revision, now().toISOString());
      return { revoked: true };
    });
  });
}
