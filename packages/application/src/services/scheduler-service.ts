import type { AgentId, AuthorityLeaseId } from "@himawari-agent/domain";
import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  type AuthorizationStorePort,
  type AuthorityLeasePort,
  type DataClassification,
  type GrantRecord,
  type ScheduledJob,
  type SchedulerPort,
} from "../ports/index.js";
import type { UnifiedTriggerPort } from "./unified-trigger-ingestion-service.js";

export interface SchedulerAuthorityFence {
  readonly leaseId: AuthorityLeaseId;
  readonly fencingToken: number;
}

export interface DispatchDueInput {
  readonly authority: SchedulerAuthorityFence;
  readonly limit: number;
}

export interface SchedulerDispatchRecord {
  readonly jobId: string;
  readonly outcome: "dispatched" | "duplicate" | "disabled";
  readonly reasonCode: string;
  readonly triggerResultRef: string | null;
  readonly nextRunAt: string | null;
}

export interface DispatchDueResult {
  readonly checkedAt: string;
  readonly records: readonly SchedulerDispatchRecord[];
}

export interface SchedulerServiceDependencies {
  readonly scheduler: SchedulerPort;
  readonly triggers: UnifiedTriggerPort;
  readonly authority: AuthorityLeasePort;
  readonly authorization: Pick<AuthorizationStorePort, "listGrants">;
  readonly clock: { now(): string };
}

function assertScheduleShape(job: ScheduledJob): void {
  const numericValues = [
    job.intervalMs,
    job.minimumIntervalMs,
    job.occurrence,
    job.estimatedCostMicros,
  ];
  if (
    !numericValues.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    job.intervalMs <= 0 ||
    !isCanonicalTimestamp(job.nextRunAt) ||
    !isCanonicalTimestamp(job.expiresAt) ||
    (job.revokedAt !== null && !isCanonicalTimestamp(job.revokedAt)) ||
    job.id.length > 64 ||
    job.authorizationRef.length === 0 ||
    job.taskScopeRef.length === 0
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Scheduled job ${job.id} has an invalid schedule`,
      { jobId: job.id },
    );
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

const CLASSIFICATION_RANK: Readonly<Record<DataClassification, number>> = {
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
};

function grantAllowsJob(grant: GrantRecord, job: ScheduledJob): boolean {
  const intervalAllowed =
    grant.scope.maxFrequency.count >= 1 &&
    grant.scope.maxFrequency.intervalMs !== null &&
    job.intervalMs >= grant.scope.maxFrequency.intervalMs;
  const resourceAllowed =
    grant.scope.exactResourceRef === job.resourceRef ||
    grant.scope.resourcePrefixes.some((prefix) => job.resourceRef.startsWith(prefix));
  return (
    grant.kind === "long_term" &&
    grant.ownerId === job.ownerId &&
    grant.agentId === job.agentId &&
    grant.scope.capabilityRef === job.capabilityRef &&
    grant.scope.operations.includes(job.operation) &&
    resourceAllowed &&
    CLASSIFICATION_RANK[job.dataClassification] <=
      CLASSIFICATION_RANK[grant.scope.maxDataClassification] &&
    grant.scope.sideEffects.includes(job.sideEffect) &&
    job.estimatedCostMicros <= grant.scope.maxCostMicrosPerUse &&
    intervalAllowed &&
    new Date(job.expiresAt).valueOf() <= new Date(grant.expiresAt).valueOf() &&
    grant.uses < grant.maxUses &&
    grant.spentCostMicros + job.estimatedCostMicros <= grant.maxTotalCostMicros
  );
}

function disabledReason(
  job: ScheduledJob,
  grant: GrantRecord | undefined,
  now: string,
): string | undefined {
  if (job.revokedAt !== null) return "SCHEDULE_AUTHORIZATION_REVOKED";
  if (job.expiresAt <= now) return "SCHEDULE_AUTHORIZATION_EXPIRED";
  if (job.intervalMs < job.minimumIntervalMs) return "SCHEDULE_FREQUENCY_EXCEEDS_SCOPE";
  if (!grant) return "SCHEDULE_AUTHORIZATION_NOT_FOUND";
  if (grant.revokedAt !== null) return "SCHEDULE_AUTHORIZATION_REVOKED";
  if (now < grant.validFrom || now >= grant.expiresAt) {
    return "SCHEDULE_AUTHORIZATION_EXPIRED";
  }
  if (!grantAllowsJob(grant, job)) return "SCHEDULE_TASK_OUTSIDE_GRANT_SCOPE";
  return undefined;
}

function nextOccurrence(
  job: ScheduledJob,
  now: string,
): {
  readonly occurrence: number;
  readonly nextRunAt: string;
} {
  const interval = job.intervalMs;
  const scheduledAt = new Date(job.nextRunAt).valueOf();
  const nowMs = new Date(now).valueOf();
  const intervalsElapsed = Math.max(1, Math.floor((nowMs - scheduledAt) / interval) + 1);
  return Object.freeze({
    occurrence: job.occurrence + intervalsElapsed,
    nextRunAt: new Date(scheduledAt + intervalsElapsed * interval).toISOString(),
  });
}

function stableOccurrenceRef(job: ScheduledJob): string {
  return `${job.id}:${job.occurrence}`;
}

export class SchedulerService {
  private readonly dependencies: SchedulerServiceDependencies;

  constructor(dependencies: SchedulerServiceDependencies) {
    this.dependencies = dependencies;
  }

  async dispatchDue(input: DispatchDueInput): Promise<DispatchDueResult> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Scheduler dispatch limit must be a positive integer",
      );
    }
    const now = this.dependencies.clock.now();
    const jobs = await this.dependencies.scheduler.listDue(now, input.limit);
    const records: SchedulerDispatchRecord[] = [];
    for (const job of jobs) {
      assertScheduleShape(job);
      await this.assertAuthority(job.agentId, input.authority);
      const grants = await this.dependencies.authorization.listGrants(job.ownerId, job.agentId);
      const grant = grants.find(({ id }) => id === job.authorizationRef);
      const reasonCode = disabledReason(job, grant, now);
      if (reasonCode) {
        await this.disable(job);
        records.push({
          jobId: job.id,
          outcome: "disabled",
          reasonCode,
          triggerResultRef: null,
          nextRunAt: null,
        });
        continue;
      }

      const occurrenceRef = stableOccurrenceRef(job);
      const admission = await this.dependencies.triggers.ingest({
        messageId: `schedule-message:${occurrenceRef}`,
        correlationId: `schedule-correlation:${occurrenceRef}`,
        causationId: `schedule-job:${job.id}`,
        idempotencyKey: `schedule-command:${occurrenceRef}`,
        ownerId: job.ownerId,
        agentId: job.agentId,
        actorType: "scheduler",
        actorId: `scheduler:${job.id}`,
        dataClassification: job.dataClassification,
        triggerId: `schedule-trigger:${occurrenceRef}`,
        sourceType: "schedule",
        sourceId: job.id,
        occurredAt: job.nextRunAt,
        threadId: job.threadId,
        payloadRef: job.payloadRef,
        sourceProofRef: job.sourceProofRef,
      });
      const next = nextOccurrence(job, now);
      try {
        await this.dependencies.scheduler.upsert({ ...job, ...next }, job.revision);
        records.push({
          jobId: job.id,
          outcome: admission.replayed ? "duplicate" : "dispatched",
          reasonCode: admission.replayed ? "TRIGGER_ALREADY_ADMITTED" : "TRIGGER_ADMITTED",
          triggerResultRef: admission.resultRef,
          nextRunAt: next.nextRunAt,
        });
      } catch (error) {
        if (error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.CONFLICT) {
          records.push({
            jobId: job.id,
            outcome: "duplicate",
            reasonCode: "SCHEDULE_ALREADY_ADVANCED",
            triggerResultRef: admission.resultRef,
            nextRunAt: (await this.dependencies.scheduler.read(job.id))?.nextRunAt ?? null,
          });
          continue;
        }
        throw error;
      }
    }
    return Object.freeze({ checkedAt: now, records: Object.freeze(records) });
  }

  private async assertAuthority(
    agentId: AgentId,
    expected: SchedulerAuthorityFence,
  ): Promise<void> {
    const current = await this.dependencies.authority.current(agentId);
    if (
      !current ||
      current.lease.id !== expected.leaseId ||
      current.fencingToken !== expected.fencingToken
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Scheduler does not hold current authority for Agent ${agentId}`,
        { agentId },
      );
    }
  }

  private async disable(job: ScheduledJob): Promise<void> {
    try {
      await this.dependencies.scheduler.upsert({ ...job, status: "cancelled" }, job.revision);
    } catch (error) {
      if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT) {
        throw error;
      }
    }
  }
}
