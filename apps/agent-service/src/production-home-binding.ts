import type { ApprovalRequest } from "@himawari-agent/application";
import { HOME_BINDING_MAXIMUM } from "@himawari-agent/gateway-contracts";

export type HomeCommandType =
  | "approval.respond"
  | "proactive.insight.respond"
  | "memory.approval.respond"
  | "memory.reminder.respond"
  | "memory.external.respond"
  | "memory.rule.respond";

export interface HomeCommand {
  readonly type: HomeCommandType;
  readonly payload: Readonly<Record<string, unknown>>;
}

const PREFIX = "b1.";
const COMMAND_TYPES: ReadonlySet<string> = new Set<HomeCommandType>([
  "approval.respond",
  "proactive.insight.respond",
  "memory.approval.respond",
  "memory.reminder.respond",
  "memory.external.respond",
  "memory.rule.respond",
]);

export function encodeHomeBinding(command: HomeCommand): string | null {
  const encoded = `${PREFIX}${Buffer.from(JSON.stringify([command.type, command.payload])).toString("base64url")}`;
  return encoded.length <= HOME_BINDING_MAXIMUM ? encoded : null;
}

export function decodeHomeBinding(binding: string): HomeCommand | null {
  if (binding.length > HOME_BINDING_MAXIMUM || !binding.startsWith(PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(binding.slice(PREFIX.length), "base64url").toString("utf8"),
    );
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [type, payload] = parsed as [unknown, unknown];
    if (typeof type !== "string" || !COMMAND_TYPES.has(type)) return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return { type: type as HomeCommandType, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

export const insightCommand = (insightId: string, action: "done" | "mute"): HomeCommand => ({
  type: "proactive.insight.respond",
  payload: { insightId, action, rating: null },
});

export const reminderCommand = (
  reminderId: string,
  action: "dismiss" | "snooze" | "cancel",
): HomeCommand => ({
  type: "memory.reminder.respond",
  payload: { reminderId, action },
});

export const memoryRequestCommand = (
  requestId: string,
  resolution: "approved" | "rejected",
): HomeCommand => ({
  type: "memory.approval.respond",
  payload: { requestId, resolution, editedText: null },
});

export const externalCommand = (proposalId: string, decision: "keep" | "reject"): HomeCommand => ({
  type: "memory.external.respond",
  payload: { items: [{ proposalId, decision, editedText: null }] },
});

export const ruleCommand = (target: string, action: "reconfirm" | "undo"): HomeCommand => ({
  type: "memory.rule.respond",
  payload: { target, action },
});

export const approvalCommand = (
  approval: Pick<ApprovalRequest, "id" | "revision" | "semanticSnapshotHash">,
  decision: "approved" | "denied",
): HomeCommand => ({
  type: "approval.respond",
  payload: {
    approvalRequestId: approval.id,
    expectedRevision: approval.revision,
    decision,
    semanticSnapshotHash: approval.semanticSnapshotHash,
    editedPayloadRef: null,
    recentAuthenticationRef: "device",
  },
});
