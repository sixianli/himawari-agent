import { DOMAIN_ERROR_CODES, DomainError } from "./errors.js";
import type { Session, Trigger } from "./entities.js";
import type { AgentId, OwnerId, RunId, SessionId, ThreadId, TriggerId } from "./identifiers.js";

export const RUN_STATUSES = [
  "accepted",
  "building_context",
  "running",
  "awaiting_approval",
  "reconciling_external_result",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Run {
  readonly id: RunId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly triggerId: TriggerId;
  readonly threadId?: ThreadId;
  readonly status: RunStatus;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  accepted: new Set(["building_context", "failed", "cancelled"]),
  building_context: new Set(["running", "failed", "cancelled"]),
  running: new Set([
    "awaiting_approval",
    "reconciling_external_result",
    "completed",
    "failed",
    "cancelled",
  ]),
  awaiting_approval: new Set(["running", "failed", "cancelled"]),
  reconciling_external_result: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

function assertRunOwnership(session: Session, trigger: Trigger): void {
  const triggerThreadConflicts =
    trigger.threadId !== undefined && trigger.threadId !== session.threadId;
  if (
    trigger.ownerId !== session.ownerId ||
    trigger.agentId !== session.agentId ||
    triggerThreadConflicts
  ) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.OWNERSHIP_MISMATCH,
      "createRun requires Session and Trigger ownership to match",
      {
        sessionId: session.id,
        sessionAgentId: session.agentId,
        sessionOwnerId: session.ownerId,
        sessionThreadId: session.threadId ?? "",
        triggerId: trigger.id,
        triggerAgentId: trigger.agentId,
        triggerOwnerId: trigger.ownerId,
        triggerThreadId: trigger.threadId ?? "",
      },
    );
  }
}

export function createRun(input: {
  readonly id: RunId;
  readonly session: Session;
  readonly trigger: Trigger;
}): Run {
  assertRunOwnership(input.session, input.trigger);

  return Object.freeze({
    id: input.id,
    ownerId: input.session.ownerId,
    agentId: input.session.agentId,
    sessionId: input.session.id,
    triggerId: input.trigger.id,
    ...(input.session.threadId ? { threadId: input.session.threadId } : {}),
    status: "accepted" as const,
  });
}

export function transitionRun(run: Run, next: RunStatus): Run {
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.RUN_ALREADY_TERMINAL,
      `Run ${run.id} is already terminal in ${run.status}`,
      { runId: run.id, currentStatus: run.status, requestedStatus: next },
    );
  }

  if (!ALLOWED_TRANSITIONS[run.status].has(next)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_RUN_TRANSITION,
      `Run ${run.id} cannot transition from ${run.status} to ${next}`,
      { runId: run.id, currentStatus: run.status, requestedStatus: next },
    );
  }

  return Object.freeze({ ...run, status: next });
}
