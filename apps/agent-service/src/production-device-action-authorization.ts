import {
  type ApprovalDisplayInput,
  approvalBodyPreview,
  APPROVAL_BODY_PREVIEW_DEFAULT_CHARACTERS,
  type DeviceActionAuthorization,
  type DeviceActionAuthorizationPort,
  type DeviceActionIntent,
  type DeviceActionResolution,
  type JsonObject,
  type PermissionDecision,
  ReadOnlyDeviceActionAuthorization,
  type ToolActionRegistry,
} from "@himawari-agent/application";
import type { OwnerScopeAuthorization } from "./owner-scope-authorization.js";
import { DEVICE_ACTION_CAPABILITY_REF } from "./production-perception-tools.js";

export type DeviceActionApprovalLocale = "zh-CN" | "en" | "ja";

export interface ProductionDeviceActionAuthorizationOptions {
  readonly ownerScope: Pick<OwnerScopeAuthorization, "authorize" | "approvalOutcome">;
  readonly registry: ToolActionRegistry;
  readonly locale?: DeviceActionApprovalLocale;
}

type RunId = Parameters<OwnerScopeAuthorization["authorize"]>[0]["runId"];

const identity = async (_key: string, value: unknown) => value;

function approvalDisplay(
  intent: DeviceActionIntent,
  locale: DeviceActionApprovalLocale,
): () => Promise<ApprovalDisplayInput> {
  return async () => ({
    displayTitle: intent.title[locale] ?? null,
    bodyPreview: approvalBodyPreview(
      intent.detail[locale] ?? "",
      APPROVAL_BODY_PREVIEW_DEFAULT_CHARACTERS,
    ),
    origin: null,
  });
}

function verdict(permission: PermissionDecision): DeviceActionAuthorization {
  if (permission.decision === "ALLOW") return { decision: "allow", ownerPresent: false };
  if (permission.decision === "ASK")
    return { decision: "approval", approvalId: permission.approvalRequest.id };
  return { decision: "deny", reasonCode: "authorization_denied" };
}

export function productionDeviceActionAuthorization(
  options: ProductionDeviceActionAuthorizationOptions,
): DeviceActionAuthorizationPort {
  const reads = new ReadOnlyDeviceActionAuthorization();
  const locale = options.locale ?? "zh-CN";
  return {
    authorize: async (intent) => {
      const direct = await reads.authorize(intent);
      if (direct.decision === "allow") return direct;
      if (!intent.untrustedOriginAllowed && intent.readUntrustedContent)
        return { decision: "deny", reasonCode: "authorization_denied" };
      const row = options.registry.forCapability(DEVICE_ACTION_CAPABILITY_REF);
      if (!row) return { decision: "deny", reasonCode: "authorization_denied" };
      const permission = await options.ownerScope.authorize(
        {
          runId: intent.runId as RunId,
          toolCallId: intent.toolCallId,
          capabilityRef: DEVICE_ACTION_CAPABILITY_REF,
          capabilityHandleRef: null,
          arguments: {
            action: intent.action,
            device: intent.deviceId,
            arguments: intent.arguments as JsonObject,
          },
          dataClassification: intent.dataClassification,
          executionDeadlineAt: intent.expiresAt,
        },
        {
          ...row,
          actionKind: intent.actionKind,
          reversible: intent.reversible,
          sideEffect: intent.reversible ? "reversible" : "irreversible",
          ownerPresenceRequired: intent.ownerPresence,
        },
        identity,
        undefined,
        {
          targets: [
            { type: "device", ref: intent.deviceId },
            { type: "device-action", ref: intent.action },
            ...(intent.target ? [intent.target] : []),
          ],
          display: approvalDisplay(intent, locale),
        },
      );
      return verdict(permission);
    },
    resolve: async (approvalId): Promise<DeviceActionResolution> => {
      const outcome = await options.ownerScope.approvalOutcome(approvalId);
      switch (outcome.kind) {
        case "pending":
        case "expired":
          return { decision: "pending" };
        case "unknown":
        case "refused":
          return { decision: "deny", reasonCode: "authorization_denied" };
        case "denied":
          return { decision: "deny", reasonCode: "owner_denied" };
        case "allowed":
          return { decision: "allow", ownerPresent: outcome.recentlyAuthenticated };
      }
    },
  };
}
