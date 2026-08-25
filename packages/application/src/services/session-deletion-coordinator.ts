import type { AgentId, OwnerId, SessionId } from "@himawari-agent/domain";
import {
  DELETION_TARGETS,
  type AuditLedgerPort,
  type DeletionTarget,
  type DeletionTargetState,
  type SessionDeletionRecord,
  type SessionDeletionStatePort,
  type SessionDeletionTargetPort,
} from "../ports/observability.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import { PORT_ERROR_CODES, ApplicationPortError } from "../ports/common.js";

export interface SessionDeletionCoordinatorDependencies {
  readonly state: SessionDeletionStatePort;
  readonly targets: readonly SessionDeletionTargetPort[];
  readonly audit: AuditLedgerPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

export interface RequestSessionDeletionInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
}

function pendingTarget(): DeletionTargetState {
  return Object.freeze({ status: "pending", attempts: 0, lastErrorCode: null, verifiedAt: null });
}

function errorCode(error: unknown): string {
  return error instanceof ApplicationPortError ? error.code : "DELETION_TARGET_FAILED";
}

export class SessionDeletionCoordinator {
  private readonly dependencies: SessionDeletionCoordinatorDependencies;

  constructor(dependencies: SessionDeletionCoordinatorDependencies) {
    const counts = new Map<DeletionTarget, number>();
    for (const target of dependencies.targets) {
      counts.set(target.target, (counts.get(target.target) ?? 0) + 1);
    }
    const invalid = DELETION_TARGETS.filter((target) => counts.get(target) !== 1);
    if (invalid.length > 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Session deletion requires exactly one adapter for every target",
        { targets: invalid.join(",") },
      );
    }
    this.dependencies = dependencies;
  }

  async request(input: RequestSessionDeletionInput): Promise<SessionDeletionRecord> {
    const now = this.dependencies.clock.now();
    const record = await this.dependencies.state.create({
      id: this.dependencies.ids.next("deletion"),
      revision: 1,
      ownerId: input.ownerId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      status: "pending",
      targets: {
        payload: pendingTarget(),
        search: pendingTarget(),
        cache: pendingTarget(),
        archive: pendingTarget(),
      },
      requestedAt: now,
      updatedAt: now,
    });
    return this.process(record);
  }

  async resume(deletionId: string): Promise<SessionDeletionRecord> {
    const record = await this.dependencies.state.get(deletionId);
    if (!record) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Session deletion ${deletionId} not found`,
        { deletionId },
      );
    }
    if (record.status === "verified") return record;
    return this.process(record);
  }

  assertVerified(record: SessionDeletionRecord): void {
    if (
      record.status !== "verified" ||
      DELETION_TARGETS.some((target) => record.targets[target].status !== "verified")
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Session deletion ${record.id} is not verified`,
        { deletionId: record.id, status: record.status },
      );
    }
  }

  private async process(initial: SessionDeletionRecord): Promise<SessionDeletionRecord> {
    let current = initial;
    for (const targetName of DELETION_TARGETS) {
      if (current.targets[targetName].status === "verified") continue;
      const adapter = this.dependencies.targets.find(({ target }) => target === targetName);
      if (!adapter) throw new Error(`Missing deletion target ${targetName}`);

      const attempts = current.targets[targetName].attempts + 1;
      let nextTarget: DeletionTargetState;
      try {
        await adapter.deleteSession(current.sessionId);
        const verified = await adapter.verifySessionDeleted(current.sessionId);
        nextTarget = verified
          ? {
              status: "verified",
              attempts,
              lastErrorCode: null,
              verifiedAt: this.dependencies.clock.now(),
            }
          : {
              status: "failed",
              attempts,
              lastErrorCode: "DELETION_NOT_VERIFIED",
              verifiedAt: null,
            };
      } catch (error) {
        nextTarget = {
          status: "failed",
          attempts,
          lastErrorCode: errorCode(error),
          verifiedAt: null,
        };
      }

      const targets = Object.freeze({
        ...current.targets,
        [targetName]: Object.freeze(nextTarget),
      });
      const verified = DELETION_TARGETS.every((target) => targets[target].status === "verified");
      current = await this.dependencies.state.save(
        {
          ...current,
          revision: current.revision + 1,
          targets,
          status: verified ? "verified" : "incomplete",
          updatedAt: this.dependencies.clock.now(),
        },
        current.revision,
      );
    }

    await this.dependencies.audit.append({
      id: this.dependencies.ids.next("audit"),
      ownerId: current.ownerId,
      agentId: current.agentId,
      action: "session.delete",
      targetRef: current.sessionId,
      outcome: current.status === "verified" ? "completed" : "failed",
      occurredAt: this.dependencies.clock.now(),
    });
    return current;
  }
}
