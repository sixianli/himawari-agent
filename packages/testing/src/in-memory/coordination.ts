import type {
  AttentionCandidate,
  AttentionDecision,
  AttentionPort,
  AuthorityLeasePort,
  AuthorityLeaseRecord,
  ClockPort,
  ScheduledJob,
  SchedulerPort,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import type { AgentAuthorityLease, AgentId, AuthorityLeaseId } from "@himawari-agent/domain";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy } from "./helpers.js";

export class InMemoryScheduler implements SchedulerPort {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async upsert(job: ScheduledJob): Promise<ScheduledJob> {
    this.failures.checkpoint("scheduler.upsert");
    const stored = frozenCopy(job);
    this.jobs.set(job.id, stored);
    return frozenCopy(stored);
  }

  async listDue(at: string, limit: number): Promise<readonly ScheduledJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === "active" && job.nextRunAt <= at)
      .sort(
        (left, right) =>
          left.nextRunAt.localeCompare(right.nextRunAt) || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map(frozenCopy);
  }

  async cancel(jobId: string): Promise<ScheduledJob> {
    this.failures.checkpoint("scheduler.cancel");
    const current = this.jobs.get(jobId);
    if (!current) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Job ${jobId} not found`, {
        jobId,
      });
    }
    const cancelled = frozenCopy({ ...current, status: "cancelled" as const });
    this.jobs.set(jobId, cancelled);
    return frozenCopy(cancelled);
  }
}

export class ScriptedAttentionPort implements AttentionPort {
  private readonly decision: AttentionDecision;

  constructor(decision: AttentionDecision) {
    this.decision = frozenCopy(decision);
  }

  async evaluate(candidate: AttentionCandidate): Promise<AttentionDecision> {
    if (candidate.id !== this.decision.candidateId) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Attention decision does not match the candidate",
        { candidateId: candidate.id, decisionCandidateId: this.decision.candidateId },
      );
    }
    if (
      this.decision.level === "INTERRUPT" &&
      (this.decision.interruptAuthorizationRef === null ||
        this.decision.interruptAuthorizationRef !== candidate.interruptAuthorizationRef)
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "INTERRUPT requires matching explicit authorization",
        { candidateId: candidate.id },
      );
    }
    return frozenCopy(this.decision);
  }
}

export class InMemoryAuthorityLeasePort implements AuthorityLeasePort {
  private readonly records = new Map<AgentId, AuthorityLeaseRecord>();
  private readonly fencingTokens = new Map<AgentId, number>();
  private readonly clock: ClockPort;
  private readonly failures: FailureScheduler;

  constructor(clock: ClockPort, failures: FailureScheduler = NO_FAILURES) {
    this.clock = clock;
    this.failures = failures;
  }

  async claim(lease: AgentAuthorityLease, durationMs: number): Promise<AuthorityLeaseRecord> {
    this.failures.checkpoint("authority.claim");
    this.assertDuration(durationMs);
    const current = await this.current(lease.agentId);
    if (current) {
      if (current.lease.id === lease.id && current.lease.holderId === lease.holderId) {
        return frozenCopy(current);
      }
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Agent ${lease.agentId} already has a live authority lease`,
        { agentId: lease.agentId, currentLeaseId: current.lease.id },
      );
    }

    const fencingToken = (this.fencingTokens.get(lease.agentId) ?? 0) + 1;
    this.fencingTokens.set(lease.agentId, fencingToken);
    const acquiredAt = this.clock.now();
    const record = frozenCopy({
      lease,
      fencingToken,
      acquiredAt,
      expiresAt: this.expiresAt(durationMs),
    });
    this.records.set(lease.agentId, record);
    return frozenCopy(record);
  }

  async current(agentId: AgentId): Promise<AuthorityLeaseRecord | undefined> {
    const current = this.records.get(agentId);
    if (!current) return undefined;
    if (current.expiresAt <= this.clock.now()) {
      this.records.delete(agentId);
      return undefined;
    }
    return frozenCopy(current);
  }

  async renew(leaseId: AuthorityLeaseId, durationMs: number): Promise<AuthorityLeaseRecord> {
    this.failures.checkpoint("authority.renew");
    this.assertDuration(durationMs);
    const entry = [...this.records.entries()].find(([, record]) => record.lease.id === leaseId);
    if (!entry) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Authority lease ${leaseId} not found`,
        { leaseId },
      );
    }
    const [agentId] = entry;
    const current = await this.current(agentId);
    if (!current || current.lease.id !== leaseId) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Authority lease ${leaseId} is not live`,
        { leaseId },
      );
    }
    const renewed = frozenCopy({ ...current, expiresAt: this.expiresAt(durationMs) });
    this.records.set(agentId, renewed);
    return frozenCopy(renewed);
  }

  async release(leaseId: AuthorityLeaseId): Promise<void> {
    this.failures.checkpoint("authority.release");
    const entry = [...this.records.entries()].find(([, record]) => record.lease.id === leaseId);
    if (!entry) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Authority lease ${leaseId} not found`,
        { leaseId },
      );
    }
    this.records.delete(entry[0]);
  }

  private assertDuration(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Authority lease duration must be a positive integer",
        { durationMs: String(durationMs) },
      );
    }
  }

  private expiresAt(durationMs: number): string {
    return new Date(new Date(this.clock.now()).valueOf() + durationMs).toISOString();
  }
}
