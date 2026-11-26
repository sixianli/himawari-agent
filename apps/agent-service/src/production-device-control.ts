import {
  ApplicationPortError,
  type ClockPort,
  type DeviceConfiguration,
  type GatewayAuthenticationContext,
  type PairedDevice,
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
  type PairedDeviceService,
  presentDeviceLimits,
  presentPairedDevice,
} from "@himawari-agent/platform-node";

export const PRODUCTION_DEVICE_OPERATIONS = Object.freeze([
  "device.list.read",
  "device.rename",
  "device.revoke",
] as const);

export interface ProductionDeviceControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly devices: Pick<PairedDeviceService, "list" | "rename" | "revoke">;
  readonly deviceConfiguration: () => DeviceConfiguration;
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

  async #change(
    target: { readonly deviceId: string; readonly expectedRevision: number },
    apply: () => Promise<PairedDevice>,
    alreadyApplied: (device: PairedDevice) => boolean,
  ): Promise<{ resultRef: string; replayed: boolean }> {
    try {
      const device = await apply();
      return { resultRef: `device:${device.id}:${device.revision}`, replayed: false };
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
        throw error;
      const current = (await this.#options.devices.list(this.#scope())).find(
        (device) => device.id === target.deviceId,
      );
      if (!current || current.revision !== target.expectedRevision + 1 || !alreadyApplied(current))
        throw error;
      return { resultRef: `device:${current.id}:${current.revision}`, replayed: true };
    }
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "device.list.read") throw new Error("DEVICE_OPERATION_NOT_INSTALLED");
    const scope = this.#scope();
    const devices = await this.#options.devices.list(scope);
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
          };
        }),
        limits: presentDeviceLimits(this.#options.deviceConfiguration()).map(
          ({ key, unit, value }) => ({ key, unit, value }),
        ),
        generatedAt: this.#options.clock.now(),
      },
    } as GatewayV2Snapshot;
  }

  async execute(
    _authentication: GatewayAuthenticationContext,
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
      case "device.rename":
        return this.#change(
          command.payload,
          () => this.#options.devices.rename({ ...scope, ...command.payload }),
          (device) => device.status !== "revoked" && device.name === command.payload.name,
        );
      case "device.revoke":
        return this.#change(
          command.payload,
          () => this.#options.devices.revoke({ ...scope, ...command.payload }),
          (device) => device.status === "revoked",
        );
      default:
        throw new Error("DEVICE_OPERATION_NOT_INSTALLED");
    }
  }
}
