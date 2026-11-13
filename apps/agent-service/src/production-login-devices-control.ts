import {
  ApplicationPortError,
  type ClockPort,
  type GatewayAuthenticationContext,
  type GatewayV2QueryContext,
  PORT_ERROR_CODES,
  type ProductConfiguration,
  type RecentAuthenticationGuardPort,
  type SessionDeviceStatePort,
} from "@himawari-agent/application";
import type {
  GatewayErrorReasonCode,
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export const PRODUCTION_LOGIN_DEVICE_OPERATIONS = Object.freeze([
  "login.devices.read",
  "login.device.revoke",
  "login.devices.revoke_others",
] as const);

export interface ProductionLoginDevicesControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly state: SessionDeviceStatePort;
  readonly recentAuthentication: RecentAuthenticationGuardPort;
  readonly clock: ClockPort;
}

const REVOKE_OTHERS_ATTEMPTS = 3;
const LOGIN_DEVICES_STILL_CHANGING: GatewayErrorReasonCode = "LOGIN_DEVICES_STILL_CHANGING";

const singleLine = (value: string): string => {
  let text = "";
  for (const character of value.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, " ").trim()) {
    if (text.length + character.length > 80) break;
    text += character;
  }
  return text.length > 0 ? text : "?";
};

export class ProductionLoginDevicesControl {
  readonly #options: ProductionLoginDevicesControlOptions;

  constructor(options: ProductionLoginDevicesControlOptions) {
    this.#options = options;
  }

  #owner(
    authentication: GatewayAuthenticationContext | undefined,
    scope: { readonly ownerId: string; readonly agentId: string },
  ) {
    const { ownerId, agentId } = this.#options.configuration;
    if (
      !authentication ||
      authentication.ownerId !== ownerId ||
      scope.ownerId !== ownerId ||
      scope.agentId !== agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "LOGIN_DEVICES_OWNER_REQUIRED",
      );
    return ownerId;
  }

  async query(query: GatewayV2Query, context?: GatewayV2QueryContext): Promise<GatewayV2Snapshot> {
    if (query.type !== "login.devices.read")
      throw new Error("LOGIN_DEVICES_OPERATION_NOT_INSTALLED");
    const authentication = context?.authentication;
    const ownerId = this.#owner(authentication, query.scope);
    const devices = [...(await this.#options.state.listDevices(ownerId, false))].sort(
      (left, right) =>
        (right.lastSeenAt > left.lastSeenAt ? 1 : right.lastSeenAt < left.lastSeenAt ? -1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    return {
      ...query,
      kind: "snapshot",
      type: "login.devices.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        devices: devices.map((device) => ({
          deviceId: device.id,
          label: singleLine(device.label),
          firstSeenAt: device.firstSeenAt,
          lastSeenAt: device.lastSeenAt,
          current: device.id === authentication?.deviceId,
        })),
        generatedAt: this.#options.clock.now(),
      },
    };
  }

  async execute(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly command: GatewayV2Command;
  }): Promise<{ resultRef: string; replayed: boolean }> {
    const { authentication, command } = input;
    if (command.type === "login.devices.revoke_others") {
      const ownerId = this.#owner(authentication, command.scope);
      const others = (await this.#options.state.listDevices(ownerId, false)).filter(
        (device) => device.id !== authentication.deviceId,
      );
      if (others.length === 0) return { resultRef: authentication.deviceId, replayed: true };
      await this.#options.recentAuthentication.assertRecentAuthentication({
        authentication,
        expectedAuthenticationRef: command.payload.recentAuthenticationRef,
      });
      const revokedAt = this.#options.clock.now();
      let remaining = others;
      for (
        let attempt = 0;
        attempt < REVOKE_OTHERS_ATTEMPTS && remaining.length > 0;
        attempt += 1
      ) {
        const conflicts = new Map<string, { revision: number; error: unknown }>();
        for (const device of remaining)
          await this.#options.state
            .revokeDevice(device.id, device.revision, revokedAt)
            .catch((error: unknown) => {
              if (
                !(error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.CONFLICT)
              )
                throw error;
              conflicts.set(device.id, { revision: device.revision, error });
            });
        remaining = (await this.#options.state.listDevices(ownerId, false)).filter(
          (device) => device.id !== authentication.deviceId,
        );
        for (const device of remaining) {
          const conflict = conflicts.get(device.id);
          if (conflict && conflict.revision === device.revision) throw conflict.error;
        }
      }
      if (remaining.length > 0)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, LOGIN_DEVICES_STILL_CHANGING);
      return { resultRef: authentication.deviceId, replayed: false };
    }
    if (command.type !== "login.device.revoke")
      throw new Error("LOGIN_DEVICES_OPERATION_NOT_INSTALLED");
    const ownerId = this.#owner(authentication, command.scope);
    if (command.payload.deviceId === authentication.deviceId)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "LOGIN_DEVICE_IS_CURRENT");
    const all = await this.#options.state.listDevices(ownerId, true);
    const device = all.find((entry) => entry.id === command.payload.deviceId);
    if (!device)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "LOGIN_DEVICE_NOT_FOUND");
    if (device.status === "revoked") return { resultRef: device.id, replayed: true };
    await this.#options.recentAuthentication.assertRecentAuthentication({
      authentication,
      expectedAuthenticationRef: command.payload.recentAuthenticationRef,
    });
    await this.#options.state.revokeDevice(device.id, device.revision, this.#options.clock.now());
    return { resultRef: device.id, replayed: false };
  }
}
