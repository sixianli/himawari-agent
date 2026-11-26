import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionId } from "@himawari-agent/domain";
import {
  FileSetupCodeSource,
  hashSetupCode,
  normalizeSetupCode,
  SETUP_CODE_ALPHABET,
  SETUP_CODE_LOCK_SECONDS,
  SETUP_CODE_WRONG_ATTEMPTS,
  writeSetupCode,
} from "@himawari-agent/platform-node";
import { SoftwarePasskey } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentId,
  type Harness,
  harness,
  issueSetupCode,
  ownerId,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
  signInDevice,
  signInRequest,
  web,
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

interface Started {
  readonly flowId: string;
  readonly publicKey: {
    readonly challenge: string;
    readonly rp: { readonly id: string; readonly name: string };
    readonly user: { readonly name: string };
    readonly rpId: string;
    readonly authenticatorSelection: Record<string, unknown>;
    readonly excludeCredentials: readonly { id: string }[];
    readonly allowCredentials: readonly unknown[];
    readonly userVerification: string;
  };
}

async function startSetup(h: Harness, setupCode: string, device = signInDevice().device) {
  return signInRequest(h, "setup/options", { setupCode, device });
}

async function setUp(h: Harness, passkey: SoftwarePasskey = h.passkey) {
  const client = signInDevice();
  const options = await startSetup(h, await issueSetupCode(h), client.device);
  expect(options.statusCode).toBe(200);
  const started = options.json() as Started;
  const finished = await signInRequest(h, "setup/finish", {
    flowId: started.flowId,
    credential: passkey.create(started.publicKey),
  });
  return { client, started, finished };
}

describe("[ADR-0309] signing in from the App with a passkey", () => {
  it("tells the App the setup code shape and the passkey domain without signing in", async () => {
    const h = await harness();
    const response = await h.app.inject({
      method: "GET",
      url: "/api/device/v1/sign-in",
      headers: { host: "himawari.example" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rpId: "himawari.example",
      setupCode: { length: 8, groupSize: 4, alphabet: SETUP_CODE_ALPHABET },
    });
    for (const confusable of ["0", "O", "1", "I", "L"])
      expect(SETUP_CODE_ALPHABET).not.toContain(confusable);
    await h.repository.close();
  });

  it("creates a passkey with a setup code, registers the device as usable and uses the code up", async () => {
    const h = await harness();
    const { client, started, finished } = await setUp(h);
    expect(started.publicKey.rp).toEqual({ id: "himawari.example", name: "Himawari" });
    expect(started.publicKey.user.name).toBe("Himawari · himawari.example");
    expect(started.publicKey.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    expect(finished.statusCode).toBe(201);
    const device = (finished.json() as { device: Record<string, unknown> }).device;
    expect(device).toMatchObject({ status: "active", name: "Andy iPhone", kind: "iphone" });
    expect(JSON.stringify(finished.json())).not.toMatch(/session|authentication|PublicKey/iu);

    const config = await send(
      h,
      signedRequest(
        h,
        {
          deviceId: device["id"] as string,
          keys: client.keys,
          confirmKeys: client.confirmKeys,
          revision: 0,
        },
        { method: "GET", path: "/api/device/v1/config" },
      ),
    );
    expect(config.statusCode).toBe(200);

    const stored = await h.repository.pairedDevices().readDevice(device["id"] as string);
    const session = stored?.webSessionId
      ? await h.repository.sessionDeviceState().readSession(createSessionId(stored.webSessionId))
      : undefined;
    expect(session?.status).toBe("active");
    expect(session?.authenticationRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const passkeys = await h.repository.pairedDevices().listPasskeys({ ownerId, agentId });
    expect(passkeys).toMatchObject([{ credentialId: h.passkey.credentialId, backedUp: true }]);
    expect(await readdir(path.join(h.stateRoot, "sign-in"))).toEqual([]);
    expect(h.signedIn).toEqual([device["id"]]);

    const again = await startSetup(h, "ABCD-EFGH");
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ error: { code: "DEVICE_SETUP_CODE_EXPIRED" } });
    await h.repository.close();
  });

  it("keeps the setup code usable when the owner cancels the passkey sheet, and refuses it once used", async () => {
    const h = await harness();
    const code = await issueSetupCode(h);
    const cancelled = await startSetup(h, code.toLowerCase().replace("-", " "));
    expect(cancelled.statusCode).toBe(200);
    const retried = await startSetup(h, code);
    expect(retried.statusCode).toBe(200);
    const started = retried.json() as Started;
    const finished = await signInRequest(h, "setup/finish", {
      flowId: started.flowId,
      credential: h.passkey.create(started.publicKey),
    });
    expect(finished.statusCode).toBe(201);
    const stale = cancelled.json() as Started;
    const late = await signInRequest(h, "setup/finish", {
      flowId: stale.flowId,
      credential: new SoftwarePasskey(h.origin).create(stale.publicKey),
    });
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ error: { code: "DEVICE_SETUP_CODE_EXPIRED" } });
    const reused = await startSetup(h, code);
    expect(reused.statusCode).toBe(410);
    await h.repository.close();
  });

  it("tells a wrong code, an expired code and too many tries apart, with Retry-After", async () => {
    const h = await harness();
    const none = await startSetup(h, "ABCD-EFGH");
    expect(none.statusCode).toBe(410);
    const code = await issueSetupCode(h, 1);
    const wrongCode = code === "ABCD-EFGH" ? "ABCD-EFGJ" : "ABCD-EFGH";
    for (let attempt = 1; attempt < SETUP_CODE_WRONG_ATTEMPTS; attempt += 1) {
      const wrong = await startSetup(h, wrongCode);
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toMatchObject({ error: { code: "DEVICE_SETUP_CODE_INVALID" } });
    }
    const locked = await startSetup(h, wrongCode);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBe(String(SETUP_CODE_LOCK_SECONDS));
    expect(locked.json()).toMatchObject({ error: { code: "DEVICE_SETUP_CODE_ATTEMPTS" } });
    const stillLocked = await startSetup(h, code);
    expect(stillLocked.statusCode).toBe(429);
    expect(Number(stillLocked.headers["retry-after"])).toBeGreaterThan(0);

    h.clock.advance(SETUP_CODE_LOCK_SECONDS * 1000);
    const expired = await startSetup(h, code);
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: { code: "DEVICE_SETUP_CODE_EXPIRED" } });

    const fresh = await issueSetupCode(h);
    expect((await startSetup(h, fresh)).statusCode).toBe(200);
    await h.repository.close();
  });

  it("signs a second device in with the same passkey and tells the other devices", async () => {
    const h = await harness();
    const first = await pairAndConfirm(h, "Andy iPhone");
    const client = signInDevice("Andy Mac", "mac");
    const options = await signInRequest(h, "options", { device: client.device });
    expect(options.statusCode).toBe(200);
    const started = options.json() as Started;
    expect(started.publicKey).toMatchObject({
      rpId: "himawari.example",
      allowCredentials: [],
      userVerification: "required",
    });
    const finished = await signInRequest(h, "finish", {
      flowId: started.flowId,
      credential: h.passkey.get(started.publicKey),
    });
    expect(finished.statusCode).toBe(200);
    const mac = (finished.json() as { device: { id: string; kind: string } }).device;
    expect(mac.kind).toBe("mac");
    expect(h.signedIn).toEqual([first.deviceId, mac.id]);

    const listed = await send(
      h,
      signedRequest(h, first, { method: "GET", path: "/api/device/v1/devices" }),
    );
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      thisDeviceId: string;
      devices: { id: string }[];
      server: { origin: string; since: string | null };
    };
    expect(body.thisDeviceId).toBe(first.deviceId);
    expect(body.devices.map((device) => device.id).sort()).toEqual([first.deviceId, mac.id].sort());
    expect(body.server).toEqual({ origin: "https://himawari.example", since: expect.any(String) });

    const replay = await signInRequest(h, "finish", {
      flowId: started.flowId,
      credential: h.passkey.get(started.publicKey),
    });
    expect(replay.statusCode).toBe(410);
    expect(replay.json()).toMatchObject({ error: { code: "DEVICE_SIGN_IN_FLOW_EXPIRED" } });
    await h.repository.close();
  });

  it("refuses a passkey the server does not know, a wrong origin and a missing face check", async () => {
    const h = await harness();
    await pairAndConfirm(h);
    const attempt = async (passkey: SoftwarePasskey, origin?: string) => {
      const options = await signInRequest(h, "options", { device: signInDevice().device });
      const started = options.json() as Started;
      return signInRequest(h, "finish", {
        flowId: started.flowId,
        credential: passkey.get(started.publicKey, origin),
      });
    };
    const stranger = await attempt(new SoftwarePasskey(h.origin));
    expect(stranger.statusCode).toBe(401);
    expect(stranger.json()).toMatchObject({ error: { code: "DEVICE_PASSKEY_REJECTED" } });
    expect((await attempt(h.passkey, "https://evil.example")).statusCode).toBe(401);
    h.passkey.userVerified = false;
    expect((await attempt(h.passkey)).statusCode).toBe(401);
    h.passkey.userVerified = true;
    expect((await attempt(h.passkey)).statusCode).toBe(200);
    expect(h.signedIn).toHaveLength(2);
    await h.repository.close();
  });

  it("rejects malformed device fields before checking the setup code", async () => {
    const h = await harness();
    const code = await issueSetupCode(h);
    const { device } = signInDevice();
    for (const invalid of [
      { ...device, kind: "ipad" },
      { ...device, releaseChannel: "sideload" },
      { ...device, confirmPublicKey: device.devicePublicKey },
      { ...device, extra: true },
      { ...device, name: "" },
      { ...device, name: "Andy​iPhone" },
    ]) {
      const response = await signInRequest(h, "setup/options", {
        setupCode: code,
        device: invalid,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (await signInRequest(h, "setup/options", { setupCode: code, device, extra: 1 })).statusCode,
    ).toBe(400);
    expect((await startSetup(h, code)).statusCode).toBe(200);
    await h.repository.close();
  });

  it("removes another device only with the confirm key, and signs this device out with its own key", async () => {
    const h = await harness();
    const phone = await pairAndConfirm(h, "Andy iPhone");
    const mac = await pairAndConfirm(h, "Andy Mac", "mac");
    const macDevice = await h.repository.pairedDevices().readDevice(mac.deviceId);
    const body = JSON.stringify({ deviceId: mac.deviceId, expectedRevision: macDevice?.revision });
    const plain = await send(
      h,
      signedRequest(h, phone, { method: "POST", path: "/api/device/v1/devices/revoke", body }),
    );
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ error: { code: "DEVICE_CONFIRMATION_REQUIRED" } });

    const challenge = await send(
      h,
      signedRequest(h, phone, {
        method: "POST",
        path: "/api/device/v1/approvals/challenge",
        body: "{}",
      }),
    );
    const confirmed = await send(
      h,
      signedRequest(h, phone, {
        method: "POST",
        path: "/api/device/v1/devices/revoke",
        body,
        confirmKey: phone.confirmKeys.privateKey,
        nonce: (challenge.json() as { challenge: string }).challenge,
      }),
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ device: { id: mac.deviceId, status: "revoked" } });
    const macAfter = await send(
      h,
      signedRequest(h, mac, { method: "GET", path: "/api/device/v1/config" }),
    );
    expect(macAfter.statusCode).toBe(403);

    const phoneDevice = await h.repository.pairedDevices().readDevice(phone.deviceId);
    const out = await send(
      h,
      signedRequest(h, phone, {
        method: "POST",
        path: "/api/device/v1/devices/revoke",
        body: JSON.stringify({ deviceId: phone.deviceId, expectedRevision: phoneDevice?.revision }),
      }),
    );
    expect(out.statusCode).toBe(200);
    expect(h.wiped).toEqual([mac.deviceId, phone.deviceId]);
    await h.repository.close();
  });

  it("renames a device from the App", async () => {
    const h = await harness();
    const phone = await pairAndConfirm(h);
    const stored = await h.repository.pairedDevices().readDevice(phone.deviceId);
    const renamed = await send(
      h,
      signedRequest(h, phone, {
        method: "POST",
        path: "/api/device/v1/devices/rename",
        body: JSON.stringify({
          deviceId: phone.deviceId,
          expectedRevision: stored?.revision,
          name: "Work iPhone",
        }),
      }),
    );
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ device: { name: "Work iPhone" } });
    await h.repository.close();
  });

  it("no longer offers the QR pairing routes", async () => {
    const h = await harness();
    const pair = await h.app.inject({
      method: "POST",
      url: "/api/device/v1/pair",
      headers: { host: "himawari.example", "content-type": "application/json" },
      payload: "{}",
    });
    expect(pair.statusCode).toBe(404);
    expect((await web(h, "pairing-codes")).status).toBe(404);
    expect((await web(h, "confirm", {})).status).toBe(404);
    await h.repository.close();
  });
});

describe("[ADR-0309] associated domain file", () => {
  it("lists the App ids from the push configuration and is absent without it", async () => {
    const h = await harness({
      applePush: {
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        secretRef: "apns",
        topics: ["win.example.app", "win.example.app.mac"],
        environments: ["development"],
        widgetRefreshMinimumSeconds: 900,
        liveActivityUpdateMinimumSeconds: 60,
        liveActivityStartAfterSeconds: 60,
        liveActivityStaleAfterSeconds: 3600,
        actionTokenLifetimeSeconds: 600,
        requestTimeoutSeconds: 10,
        liveActivityRegistrationsPerDevice: 4,
      },
    });
    const response = await h.app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
      headers: { host: "himawari.example" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/u);
    expect(response.json()).toEqual({
      webcredentials: { apps: ["TEAM123456.win.example.app", "TEAM123456.win.example.app.mac"] },
    });
    const plain = await harness();
    const missing = await plain.app.inject({
      method: "GET",
      url: "/.well-known/apple-app-site-association",
      headers: { host: "himawari.example" },
    });
    expect(missing.statusCode).toBe(404);
    await h.repository.close();
    await plain.repository.close();
  });
});

describe("[ADR-0309] setup code file", () => {
  it("writes only a hash, replaces the previous code and ignores a code for another owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-setup-code-"));
    try {
      const now = new Date("2026-11-26T08:00:00.000Z");
      const first = await writeSetupCode({
        stateRoot: root,
        scope: { ownerId, agentId },
        code: "ABCDEFGH",
        now,
        minutes: 15,
      });
      expect(first.codeHash).toBe(hashSetupCode("ABCDEFGH"));
      expect(first.expiresAt).toBe("2026-11-26T08:15:00.000Z");
      const file = path.join(root, "sign-in", "setup-code.json");
      expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
      expect(((await stat(path.dirname(file))).mode & 0o777).toString(8)).toBe("700");
      await writeSetupCode({
        stateRoot: root,
        scope: { ownerId, agentId },
        code: "JKMNPQRS",
        now,
        minutes: 15,
      });
      const source = new FileSetupCodeSource(root);
      expect((await source.read())?.codeHash).toBe(hashSetupCode("JKMNPQRS"));
      await source.discard(hashSetupCode("ABCDEFGH"));
      expect(await source.read()).toBeDefined();
      await source.discard(hashSetupCode("JKMNPQRS"));
      expect(await source.read()).toBeUndefined();
      expect(normalizeSetupCode(" abcd-efgh ")).toBe("ABCDEFGH");
      expect(normalizeSetupCode("ABCD-EFG0")).toBeUndefined();
      expect(normalizeSetupCode("ABCDEFG")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
