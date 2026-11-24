import { randomBytes } from "node:crypto";
import {
  DEVICE_ACTION_REGISTRY,
  type DecisionLedgerPort,
  type DeviceActionAuthorizationPort,
  type DeviceActionContentPort,
  type DeviceActionDeliveryPort,
  type DeviceActionOpenRequestPort,
  type DeviceActionRegistry,
  DeviceActionService,
  type DeviceActionStorePort,
  type PairedDevice,
  type PairedDeviceScope,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type PerceptionConfiguration,
  type PerceptionStorePort,
  ReadOnlyDeviceActionAuthorization,
} from "@himawari-agent/application";
import { TOOL_RESULT_DEVICE_ACTION_INVALID } from "@himawari-agent/prompt-catalog";
import {
  type DeviceActionOutcome,
  type DeviceActionRequest,
  PerceptionToolError,
  type ProductionPerceptionToolsOptions,
} from "./production-perception-tools.js";

export interface ProductionDeviceActionsOptions {
  readonly scope: PairedDeviceScope;
  readonly store: DeviceActionStorePort;
  readonly perception: Pick<PerceptionStorePort, "listMirror">;
  readonly devices: (scope: PairedDeviceScope) => Promise<readonly PairedDevice[]>;
  readonly ledger: Pick<DecisionLedgerPort, "append">;
  readonly payloads: PayloadStorePort;
  readonly protector: Pick<PayloadProtectorPort, "protect" | "unprotect">;
  readonly delivery: DeviceActionDeliveryPort;
  readonly configuration: () => PerceptionConfiguration;
  readonly timeZone: string;
  readonly now: () => string;
  readonly registry?: DeviceActionRegistry;
  readonly authorization?: DeviceActionAuthorizationPort;
  readonly openRequests?: DeviceActionOpenRequestPort;
}

export function deviceActionContent(
  options: Pick<ProductionDeviceActionsOptions, "scope" | "payloads" | "protector" | "now">,
): DeviceActionContentPort {
  return {
    save: async ({ ref, value, dataClassification }) => {
      await options.payloads.put(
        await options.protector.protect({
          ...options.scope,
          ref,
          contentType: "application/json",
          dataClassification,
          plaintext: new TextEncoder().encode(JSON.stringify(value)),
          createdAt: options.now(),
        }),
      );
    },
    read: async (ref) => {
      const payload = await options.payloads.get(ref);
      if (!payload || payload.contentType !== "application/json") return undefined;
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await options.protector.unprotect({ ...options.scope, payload }),
        ),
      );
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    },
    discard: async (ref) => {
      await options.payloads.delete(ref);
    },
  };
}

export function createProductionDeviceActions(options: ProductionDeviceActionsOptions): {
  readonly service: DeviceActionService;
  readonly tools: Required<
    Pick<ProductionPerceptionToolsOptions, "actions" | "offered" | "perform">
  >;
} {
  const service = new DeviceActionService({
    scope: options.scope,
    registry: options.registry ?? DEVICE_ACTION_REGISTRY,
    store: options.store,
    devices: options.devices,
    mirror: (input) => options.perception.listMirror(input),
    authorization: options.authorization ?? new ReadOnlyDeviceActionAuthorization(),
    delivery: options.delivery,
    ...(options.openRequests ? { openRequests: options.openRequests } : {}),
    ledger: options.ledger,
    content: deviceActionContent(options),
    settings: () => {
      const configuration = options.configuration();
      return {
        expirySeconds: configuration.actionExpirySeconds,
        presenceExpirySeconds: configuration.actionPresenceExpirySeconds,
        waitMilliseconds: configuration.actionWaitSeconds * 1000,
        claimBatch: configuration.actionClaimBatch,
      };
    },
    timeZone: options.timeZone,
    now: options.now,
    newId: () => `dact_${randomBytes(16).toString("hex")}`,
  });
  return {
    service,
    tools: {
      actions: () => service.descriptions(),
      offered: (device) => service.offered(device),
      perform: async (request: DeviceActionRequest): Promise<DeviceActionOutcome> => {
        const outcome = await service.request({
          runId: request.invocation.runId,
          toolCallId: request.invocation.toolCallId,
          dataClassification: request.invocation.dataClassification,
          device: request.device,
          action: request.action.name,
          arguments: request.arguments,
        });
        if (outcome.kind === "invalid")
          throw new PerceptionToolError(
            "DEVICE_ACTION_INPUT_INVALID",
            outcome.note ?? TOOL_RESULT_DEVICE_ACTION_INVALID.text,
          );
        return {
          state: outcome.state === "delivered" ? "queued" : outcome.state,
          ...(outcome.reason === null ? {} : { reason: outcome.reason }),
          ...(outcome.evidence === null ? {} : { evidence: outcome.evidence }),
        };
      },
    },
  };
}
