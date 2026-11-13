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
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

export const PRODUCTION_LOGIN_DEVICE_OPERATIONS = Object.freeze([
  "login.devices.read",
  "login.device.revoke",
] as const);

export interface ProductionLoginDevicesControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly state: SessionDeviceStatePort;
  readonly recentAuthentication: RecentAuthenticationGuardPort;
  readonly clock: ClockPort;
}

const singleLine = (value: string): string => {
  let text = "";
  for (const character of value.replace(/\p{Cc}/gu, " ").trim()) {
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

  #owner(authentication: GatewayAuthenticationContext | undefined, scopeOwnerId: string) {
    const { ownerId } = this.#options.configuration;
    if (!authentication || authentication.ownerId !== ownerId || scopeOwnerId !== ownerId)
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
    const ownerId = this.#owner(authentication, query.scope.ownerId);
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
    if (command.type !== "login.device.revoke")
      throw new Error("LOGIN_DEVICES_OPERATION_NOT_INSTALLED");
    const ownerId = this.#owner(authentication, command.scope.ownerId);
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
