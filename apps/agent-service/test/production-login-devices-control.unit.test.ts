import { ApplicationPortError, PORT_ERROR_CODES } from "@himawari-agent/application";
import { isGatewayErrorReasonCode } from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import { ProductionLoginDevicesControl } from "../src/production-login-devices-control.ts";

const OWNER = "owner-01";
const AGENT = "agent-01";
const NOW = "2026-11-13T00:00:00.000Z";

const authentication = {
  ownerId: OWNER,
  subjectId: OWNER,
  deviceId: "device-current",
  authenticatedAt: NOW,
  authenticationRef: "authentication:current",
};

const device = (id: string, status: "active" | "revoked" = "active") => ({
  id,
  ownerId: OWNER,
  revision: 1,
  label: id,
  status,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
});

function control(devices = [device("device-current"), device("device-other")]) {
  const revoked: string[] = [];
  const checks: unknown[] = [];
  return {
    revoked,
    checks,
    control: new ProductionLoginDevicesControl({
      configuration: { ownerId: OWNER, agentId: AGENT } as never,
      state: {
        listDevices: async (_owner: string, includeRevoked: boolean) =>
          includeRevoked ? devices : devices.filter(({ id }) => !revoked.includes(id)),
        revokeDevice: async (id: string) => {
          revoked.push(id);
          return device(id, "revoked");
        },
      } as never,
      recentAuthentication: {
        assertRecentAuthentication: async (input: unknown) => {
          checks.push(input);
        },
      } as never,
      clock: { now: () => NOW },
    }),
  };
}

const scope = (agentId: string) => ({ ownerId: OWNER, agentId });

describe("ProductionLoginDevicesControl scope", () => {
  it.each([AGENT, "agent-other"])(
    "answers a device list only for its own agent: %s",
    async (agentId) => {
      const { control: devices } = control();
      const read = devices.query(
        { type: "login.devices.read", scope: scope(agentId), payload: {} } as never,
        { authentication } as never,
      );
      if (agentId === AGENT)
        await expect(read).resolves.toMatchObject({ type: "login.devices.snapshot" });
      else await expect(read).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    },
  );

  it.each([AGENT, "agent-other"])(
    "revokes a device only for its own agent: %s",
    async (agentId) => {
      const { control: devices, revoked } = control();
      const revoke = devices.execute({
        authentication,
        command: {
          type: "login.device.revoke",
          scope: scope(agentId),
          payload: { deviceId: "device-other", recentAuthenticationRef: "authentication:current" },
        },
      } as never);
      if (agentId === AGENT) {
        await expect(revoke).resolves.toMatchObject({ replayed: false });
        expect(revoked).toEqual(["device-other"]);
      } else {
        await expect(revoke).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
        expect(revoked).toEqual([]);
      }
    },
  );

  it("shows a long device label with control characters as one line of at most 80 characters", async () => {
    const { control: devices } = control([
      { ...device("device-current"), label: `\u0007${"a".repeat(127)}` },
      { ...device("device-other"), label: "\u202Eenohp\u2066x\u2069" },
    ]);
    const snapshot = await devices.query(
      { type: "login.devices.read", scope: scope(AGENT), payload: {} } as never,
      { authentication } as never,
    );
    if (snapshot.type !== "login.devices.snapshot") throw new Error(snapshot.type);
    expect(snapshot.payload.devices.map(({ label }) => label)).toEqual(["a".repeat(80), "enohp x"]);
  });

  const revokeOthers = (
    agentId = AGENT,
    recentAuthenticationRef: string | null = "authentication:current",
  ) => ({
    authentication,
    command: {
      type: "login.devices.revoke_others",
      scope: scope(agentId),
      payload: { recentAuthenticationRef },
    },
  });

  it("signs out every other device after one recent authentication and keeps the current one", async () => {
    const {
      control: devices,
      revoked,
      checks,
    } = control([device("device-current"), device("device-laptop"), device("device-tablet")]);
    await expect(devices.execute(revokeOthers() as never)).resolves.toEqual({
      resultRef: "device-current",
      replayed: false,
    });
    expect(revoked).toEqual(["device-laptop", "device-tablet"]);
    expect(checks).toEqual([
      { authentication, expectedAuthenticationRef: "authentication:current" },
    ]);
  });

  it("tries again with the fresh revision when another device changed in between, and gives up after three rounds", async () => {
    const conflict = () => new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "changed");
    const build = (failures: number) => {
      const active = new Map([
        ["device-current", 1],
        ["device-laptop", 1],
        ["device-tablet", 1],
      ]);
      let left = failures;
      const revoked: string[] = [];
      const attempts: string[] = [];
      const devices = new ProductionLoginDevicesControl({
        configuration: { ownerId: OWNER, agentId: AGENT } as never,
        state: {
          listDevices: async () =>
            [...active].map(([id, revision]) => ({ ...device(id), revision })),
          revokeDevice: async (id: string, revision: number) => {
            attempts.push(id);
            if (id === "device-laptop" && left > 0) {
              left -= 1;
              active.set(id, revision + 1);
              throw conflict();
            }
            if (active.get(id) !== revision) throw conflict();
            active.delete(id);
            revoked.push(id);
            return device(id, "revoked");
          },
        } as never,
        recentAuthentication: { assertRecentAuthentication: async () => undefined } as never,
        clock: { now: () => NOW },
      });
      return { devices, revoked, active, attempts };
    };
    const once = build(1);
    await expect(once.devices.execute(revokeOthers() as never)).resolves.toMatchObject({
      replayed: false,
    });
    expect([...once.active.keys()]).toEqual(["device-current"]);
    expect(once.revoked.sort()).toEqual(["device-laptop", "device-tablet"]);
    const always = build(99);
    const stillChanging = await always.devices
      .execute(revokeOthers() as never)
      .catch((error) => error);
    expect(stillChanging).toMatchObject({
      code: PORT_ERROR_CODES.CONFLICT,
      message: "LOGIN_DEVICES_STILL_CHANGING",
    });
    expect(isGatewayErrorReasonCode(stillChanging.message)).toBe(true);
    expect([...always.active.keys()]).toEqual(["device-current", "device-laptop"]);
    expect(always.attempts.filter((id) => id === "device-laptop")).toHaveLength(3);
  });

  it("passes a storage conflict through at once instead of retrying it as a changed device", async () => {
    const attempts: string[] = [];
    const storageError = new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "disk headroom", {
      reason: "disk_headroom",
    });
    const devices = new ProductionLoginDevicesControl({
      configuration: { ownerId: OWNER, agentId: AGENT } as never,
      state: {
        listDevices: async () => [device("device-current"), device("device-laptop")],
        revokeDevice: async (id: string) => {
          attempts.push(id);
          throw storageError;
        },
      } as never,
      recentAuthentication: { assertRecentAuthentication: async () => undefined } as never,
      clock: { now: () => NOW },
    });
    await expect(devices.execute(revokeOthers() as never)).rejects.toBe(storageError);
    expect(attempts).toEqual(["device-laptop"]);
  });

  it("answers replayed without asking for recent authentication when no other device is signed in", async () => {
    const { control: devices, revoked, checks } = control([device("device-current")]);
    await expect(devices.execute(revokeOthers(AGENT, null) as never)).resolves.toEqual({
      resultRef: "device-current",
      replayed: true,
    });
    expect([revoked, checks]).toEqual([[], []]);
  });

  it("signs out no device when recent authentication fails or the agent is another one", async () => {
    const { control: devices, revoked } = control();
    await expect(devices.execute(revokeOthers("agent-other") as never)).rejects.toMatchObject({
      code: "PORT_NOT_AUTHORITATIVE",
    });
    const strict = new ProductionLoginDevicesControl({
      configuration: { ownerId: OWNER, agentId: AGENT } as never,
      state: {
        listDevices: async () => [device("device-current"), device("device-other")],
        revokeDevice: async (id: string) => {
          revoked.push(id);
          return device(id, "revoked");
        },
      } as never,
      recentAuthentication: {
        assertRecentAuthentication: async () => {
          throw new Error("RECENT_AUTHENTICATION_REQUIRED");
        },
      } as never,
      clock: { now: () => NOW },
    });
    await expect(strict.execute(revokeOthers(AGENT, null) as never)).rejects.toThrow(
      "RECENT_AUTHENTICATION_REQUIRED",
    );
    expect(revoked).toEqual([]);
  });

  it("refuses a device list and a revoke without a signed-in owner", async () => {
    const { control: devices, revoked } = control();
    await expect(
      devices.query({ type: "login.devices.read", scope: scope(AGENT), payload: {} } as never),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    await expect(
      devices.execute({
        authentication: { ...authentication, ownerId: "owner-other" },
        command: {
          type: "login.device.revoke",
          scope: scope(AGENT),
          payload: { deviceId: "device-other", recentAuthenticationRef: "authentication:current" },
        },
      } as never),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    expect(revoked).toEqual([]);
  });
});
