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
  return {
    revoked,
    control: new ProductionLoginDevicesControl({
      configuration: { ownerId: OWNER, agentId: AGENT } as never,
      state: {
        listDevices: async () => devices,
        revokeDevice: async (id: string) => {
          revoked.push(id);
          return device(id, "revoked");
        },
      } as never,
      recentAuthentication: { assertRecentAuthentication: async () => undefined } as never,
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
