import {
  ApplicationPortError,
  type ClockPort,
  type DeviceConfiguration,
  type GatewayAuthenticationContext,
  type PairedDeviceScope,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  type DevicePairingAccess,
  type PairedDeviceService,
  pairingAccessFields,
  presentDeviceLimits,
  presentPairedDevice,
} from "@himawari-agent/platform-node";

export const PRODUCTION_DEVICE_OPERATIONS = Object.freeze([
  "device.list.read",
  "device.pairing.start",
  "device.pairing.confirm",
  "device.rename",
  "device.revoke",
] as const);

export interface ProductionDeviceControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly devices: Pick<
    PairedDeviceService,
    "list" | "openPairing" | "startPairingWithCode" | "confirm" | "rename" | "revoke"
  >;
  readonly deviceConfiguration: () => DeviceConfiguration;
  readonly pairingAccess?: DevicePairingAccess;
  readonly clock: ClockPort;
}

export class ProductionDeviceControl {
  readonly #options: ProductionDeviceControlOptions;

  constructor(options: ProductionDeviceControlOptions) {
    this.#options = options;
  }

  #scope(): PairedDeviceScope {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId } as PairedDeviceScope;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "device.list.read") throw new Error("DEVICE_OPERATION_NOT_INSTALLED");
    const scope = this.#scope();
    const [devices, pairing] = await Promise.all([
      this.#options.devices.list(scope),
      this.#options.devices.openPairing(scope),
    ]);
    return {
      ...query,
      kind: "snapshot",
      type: "device.list.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        devices: devices.map((device) => {
          const view = presentPairedDevice(device);
          return {
            id: view.id,
            revision: view.revision,
            kind: view.kind,
            name: view.name,
            releaseChannel: view.releaseChannel,
            status: view.status,
            pairedAt: view.pairedAt,
            lastSeenAt: view.lastSeenAt,
            pairingNumber: view.pairingNumber,
          };
        }),
        limits: presentDeviceLimits(this.#options.deviceConfiguration()).map(
          ({ key, unit, value }) => ({ key, unit, value }),
        ),
        pairing: pairing
          ? {
              expiresAt: pairing.expiresAt,
              access: this.#options.pairingAccess
                ? pairingAccessFields(this.#options.pairingAccess)
                : null,
            }
          : null,
        generatedAt: this.#options.clock.now(),
      },
    } as GatewayV2Snapshot;
  }

  async execute(
    authentication: GatewayAuthenticationContext,
    command: GatewayV2Command,
  ): Promise<{ resultRef: string; replayed: boolean }> {
    const scope = this.#scope();
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== scope.ownerId ||
      command.scope.agentId !== scope.agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "DEVICE_OWNER_REQUIRED");
    switch (command.type) {
      case "device.pairing.start": {
        if (!authentication.sessionId)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.NOT_AUTHORITATIVE,
            "DEVICE_PAIRING_SESSION_REQUIRED",
          );
        const pairing = await this.#options.devices.startPairingWithCode({
          ...scope,
          sessionId: authentication.sessionId,
          code: command.payload.pairingCode,
        });
        return { resultRef: `device-pairing:${pairing.expiresAt}`, replayed: false };
      }
      case "device.pairing.confirm": {
        const device = await this.#options.devices.confirm({ ...scope, ...command.payload });
        return { resultRef: `device:${device.id}:${device.revision}`, replayed: false };
      }
      case "device.rename": {
        const device = await this.#options.devices.rename({ ...scope, ...command.payload });
        return { resultRef: `device:${device.id}:${device.revision}`, replayed: false };
      }
      case "device.revoke": {
        const device = await this.#options.devices.revoke({ ...scope, ...command.payload });
        return { resultRef: `device:${device.id}:${device.revision}`, replayed: false };
      }
      default:
        throw new Error("DEVICE_OPERATION_NOT_INSTALLED");
    }
  }
}
