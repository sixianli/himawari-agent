import { invalidateRecoveredBuiltInIdentity } from "../../packages/persistence-sqlite/src/built-in-identity-recovery.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import { RecentAuthenticationGuard } from "@himawari-agent/application";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  BuiltInAuthenticationService,
  createAccountFactors,
  hashAccountPassword,
  EnvelopePayloadProtector,
  SessionBoundCsrfService,
  buildHttpGatewayServer,
  registerBuiltInIdentityRoutes,
} from "@himawari-agent/platform-node";
import { TOTP } from "otpauth";
import { expect, it } from "vitest";

it(
  "requires real password and MFA, rotates proof, consumes recovery once and persists expiry/revocation",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-built-in-auth-"));
    const ownerId = createOwnerId("owner-native-test");
    const agentId = createAgentId("agent-native-test");
    const databasePath = path.join(root, "product.sqlite");
    const db = openQualifiedDatabase(databasePath);
    applyMigrations(db, await loadBundledMigrations());
    db.prepare("INSERT INTO owners VALUES (?, 0)").run(ownerId);
    db.prepare("INSERT INTO agents VALUES (?, ?, 0)").run(agentId, ownerId);
    db.close();
    let repo = await SqliteProductStateRepository.open({
      stateRoot: root,
      databasePath,
      minimumFreeBytes: 0,
    });
    let now = new Date("2026-09-10T00:00:00.000Z");
    const policy = { sessionIdleMilliseconds: 60000, sessionAbsoluteMilliseconds: 300000 };
    const factors = createAccountFactors("test-owner");
    const factorText = Buffer.from(factors.secret).toString("utf8");
    const protector = new EnvelopePayloadProtector({
      keys: {
        kind: "memory-development",
        productionSuitable: false,
        resolve: async () => new Uint8Array(32).fill(7),
      },
      activeKey: { keyRef: "test-kek", kekVersion: "v1", dekVersion: "v1" },
    });
    const payload = await protector.protect({
      ownerId,
      agentId,
      ref: "payload-native-factor",
      plaintext: factors.secret,
      dataClassification: "restricted",
      contentType: "application/vnd.himawari.identity-factor",
      createdAt: now.toISOString(),
    });
    await repo.payloadStore(ownerId, agentId).put(payload);
    const account = {
      username: "test-owner",
      passwordHash: await hashAccountPassword("test-only-long-password"),
      factorPayloadRef: payload.ref,
      recoveryDigests: factors.recoveryDigests,
    };
    const state = () => repo.builtInIdentityState(ownerId, agentId);
    await state().provision({ account, expectedRevision: null, now: now.toISOString() });
    const service = () =>
      new BuiltInAuthenticationService({
        ownerId,
        state: state(),
        policy,
        now: () => now,
        readFactor: async (ref) => {
          const stored = await repo.payloadStore(ownerId, agentId).get(ref);
          if (!stored) throw new Error("missing protected factor");
          return protector.unprotect({ ownerId, agentId, payload: stored });
        },
      });
    let auth = service();
    const begin = (authenticationRef?: string) =>
      auth.begin({
        username: "test-owner",
        password: "test-only-long-password",
        deviceLabel: "Test browser",
        ...(authenticationRef ? { authenticationRef } : {}),
      });
    const tokenInput = (sessionToken: string) => ({
      sessionToken,
      accessAssertion: null,
      method: "GET",
      path: "/api/control-center/v1/config",
    });
    const code = () => new TOTP({ secret: factorText }).generate({ timestamp: now.getTime() });
    try {
      await expect(
        auth.begin({ username: "test-owner", password: "wrong-password", deviceLabel: "test" }),
      ).rejects.toMatchObject({ code: "IDENTITY_LOGIN_REJECTED" });
      const challenge = await begin();
      expect(await repo.sessionDeviceState().listSessions(ownerId, false)).toHaveLength(0);
      await expect(auth.authenticate(tokenInput(challenge))).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });
      await expect(auth.finish(challenge, "invalid")).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });
      const logins = await Promise.allSettled([
        auth.finish(challenge, code()),
        auth.finish(challenge, code()),
      ]);
      expect(logins.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      const first = logins.find((entry) => entry.status === "fulfilled");
      if (first?.status !== "fulfilled") throw new Error("No authenticated session");
      let context = await auth.authenticate(tokenInput(first.value.token));
      expect(context.recentAuthenticationEvidence).toMatchObject({
        source: "built_in_mfa",
        authenticatedAt: now.toISOString(),
      });
      const sameWindow = await begin();
      await expect(auth.finish(sameWindow, code())).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });
      now = new Date(now.getTime() + 30000);
      const stepUp = await auth.finish(await begin(context.authenticationRef), code());
      await expect(auth.authenticate(tokenInput(first.value.token))).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });
      context = await auth.authenticate(tokenInput(stepUp.token));
      expect(context.sessionId).toBe(first.value.sessionId);
      expect(await repo.sessionDeviceState().listDevices(ownerId, false)).toHaveLength(1);
      await repo.close();
      repo = await SqliteProductStateRepository.open({
        stateRoot: root,
        databasePath,
        minimumFreeBytes: 0,
      });
      auth = service();
      expect(
        (await auth.authenticate(tokenInput(stepUp.token))).recentAuthenticationEvidence
          ?.authenticatedAt,
      ).toBe(now.toISOString());
      now = new Date(now.getTime() + 60000);
      await expect(auth.revalidate(context)).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });
      const recoveryCode = factors.recoveryCodes[0];
      if (!recoveryCode) throw new Error("Missing recovery code");
      const recovered = await auth.finish(await begin(), recoveryCode);
      await expect(auth.finish(await begin(), recoveryCode)).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });
      const recoveredContext = await auth.authenticate(tokenInput(recovered.token));
      const device = (await repo.sessionDeviceState().listDevices(ownerId, false)).find(
        (value) => value.id === recoveredContext.deviceId,
      );
      if (!device) throw new Error("Missing device");
      await repo.sessionDeviceState().revokeDevice(device.id, device.revision, now.toISOString());
      await expect(auth.authenticate(tokenInput(recovered.token))).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });
      // Provisioning is a protected host action and must invalidate outstanding login challenges.
      now = new Date(now.getTime() + 300000);
      const pending = await begin();
      await state().provision({ account, expectedRevision: 1, now: now.toISOString() });
      await expect(auth.finish(pending, code())).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });

      const staticRoot = path.join(root, "browser");
      await mkdir(staticRoot);
      await writeFile(
        path.join(staticRoot, "index.html"),
        "<!doctype html><title>auth fixture</title>",
      );
      const csrf = new SessionBoundCsrfService({ key: new Uint8Array(32).fill(9), now: () => now });
      const app = buildHttpGatewayServer({
        publicOrigin: "https://agent.example.test",
        staticRoot,
        authentication: auth,
        csrf,
      });
      registerBuiltInIdentityRoutes(app, {
        publicOrigin: "https://agent.example.test",
        sessionCookieName: "himawari_session",
        sessions: auth,
        state: repo.sessionDeviceState(),
        csrf,
        recentAuthentication: new RecentAuthenticationGuard({
          identityState: repo.ownerIdentityState(),
          sessionState: repo.sessionDeviceState(),
          policy: { maximumAgeMilliseconds: 60000, clockSkewMilliseconds: 0 },
          now: () => now.toISOString(),
        }),
        sessionAbsoluteMilliseconds: policy.sessionAbsoluteMilliseconds,
        now: () => now,
      });
      try {
        const headers = {
          host: "agent.example.test",
          origin: "https://agent.example.test",
          "sec-fetch-site": "same-origin",
        };
        const body = {
          username: "test-owner",
          password: "test-only-long-password",
          deviceLabel: "Phone",
        };
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/identity/v1/password",
              headers: { ...headers, origin: "https://evil.example.test" },
              payload: body,
            })
          ).statusCode,
        ).toBe(401);
        const password = await app.inject({
          method: "POST",
          url: "/api/identity/v1/password",
          headers,
          payload: body,
        });
        expect(password.statusCode).toBe(202);
        const challengeCookie = password.cookies[0];
        expect(challengeCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
        const verified = await app.inject({
          method: "POST",
          url: "/api/identity/v1/verify",
          headers,
          cookies: { himawari_session_challenge: challengeCookie?.value ?? "" },
          payload: { code: code() },
        });
        expect(verified.statusCode).toBe(201);
        expect(verified.json()).toEqual({ authenticated: true });
        const token =
          verified.cookies.find((entry) => entry.name === "himawari_session")?.value ?? "";
        const cookies = { himawari_session: token };
        const devices = await app.inject({ url: "/api/identity/v1/devices", headers, cookies });
        expect(devices.statusCode).toBe(200);
        expect(devices.body).not.toContain("authenticationRef");
        expect(
          (await app.inject({ method: "POST", url: "/api/identity/v1/logout", headers, cookies }))
            .statusCode,
        ).toBe(401);
        const proof = await auth.authenticate(tokenInput(token));
        const csrfToken = await csrf.issue(proof);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/identity/v1/logout",
              headers: { ...headers, "x-csrf-token": csrfToken },
              cookies,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await app.inject({ url: "/api/identity/v1/devices", headers, cookies })).statusCode,
        ).toBe(401);
      } finally {
        await app.close();
      }
      now = new Date(now.getTime() + 300000);
      for (let i = 0; i < 20; i++)
        expect(await state().reserveAttempt({ now: now.toISOString() })).toBe(true);
      await repo.close();
      repo = await SqliteProductStateRepository.open({
        stateRoot: root,
        databasePath,
        minimumFreeBytes: 0,
      });
      expect(await state().reserveAttempt({ now: now.toISOString() })).toBe(false);
      await state().provision({ account, expectedRevision: 2, now: now.toISOString() });
      auth = service();
      const beforeRestore = await auth.finish(await begin(), code());
      await repo.close();
      const restored = openQualifiedDatabase(databasePath);
      restored.transaction(() =>
        invalidateRecoveredBuiltInIdentity(restored, {
          ownerId,
          agentId,
          now: now.toISOString(),
          requireAccountRecovery: true,
        }),
      )();
      restored.close();
      repo = await SqliteProductStateRepository.open({
        stateRoot: root,
        databasePath,
        minimumFreeBytes: 0,
      });
      auth = service();
      await expect(auth.authenticate(tokenInput(beforeRestore.token))).rejects.toMatchObject({
        code: "IDENTITY_LOGIN_REJECTED",
      });
      await expect(begin()).rejects.toMatchObject({ code: "IDENTITY_LOGIN_REJECTED" });
      await state().provision({ account, expectedRevision: 3, now: now.toISOString() });
      expect(await auth.finish(await begin(), code())).toHaveProperty("sessionId");
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
