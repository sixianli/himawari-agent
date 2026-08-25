import type {
  AttentionCandidate,
  AttentionDecision,
  AttentionDecisionCommit,
  AttentionDecisionCommitResult,
  AttentionPort,
  AttentionPolicyState,
  AttentionStatePort,
  AuthorityLeasePort,
  AuthorityLeaseRecord,
  ClockPort,
  DeliveryAttempt,
  DeliveryAttemptResult,
  DeliveryClaim,
  DeliveryPort,
  DeliveryRequest,
  DeliverySettlement,
  ScheduledJob,
  ScheduledJobWrite,
  SchedulerPort,
  WorkerRunEvent,
  WorkerRunPort,
  WorkerRunRequest,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import type { AgentAuthorityLease, AgentId, AuthorityLeaseId } from "@himawari-agent/domain";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy } from "./helpers.js";

function attentionScopeKey(ownerId: string, agentId: string): string {
  return JSON.stringify([ownerId, agentId]);
}

export class InMemoryAttentionStatePort implements AttentionStatePort {
  private readonly policies = new Map<string, AttentionPolicyState>();
  private readonly deliveries = new Map<string, DeliveryRequest>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async readPolicyState(ownerId: string, agentId: string): Promise<AttentionPolicyState> {
    return frozenCopy(
      this.policies.get(attentionScopeKey(ownerId, agentId)) ?? {
        revision: 0,
        decisions: [],
      },
    );
  }

  async commitDecision(input: AttentionDecisionCommit): Promise<AttentionDecisionCommitResult> {
    this.failures.checkpoint("attention.commitDecision");
    const key = attentionScopeKey(input.ownerId, input.agentId);
    const current = this.policies.get(key) ?? { revision: 0, decisions: [] };
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Attention policy state revision conflict",
        {
          expectedRevision: String(input.expectedRevision),
          currentRevision: String(current.revision),
        },
      );
    }
    if (
      input.record.ownerId !== input.ownerId ||
      input.record.agentId !== input.agentId ||
      current.decisions.some(({ candidateId }) => candidateId === input.record.candidateId)
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Attention decision ${input.record.candidateId} conflicts with current state`,
        { candidateId: input.record.candidateId },
      );
    }
    const deliveryMatches =
      input.record.decision.level === "SILENT"
        ? input.record.deliveryRequestId === null && input.delivery === null
        : input.delivery !== null &&
          input.record.deliveryRequestId === input.delivery.id &&
          input.record.candidateId === input.delivery.candidateId &&
          input.record.ownerId === input.delivery.ownerId &&
          input.record.agentId === input.delivery.agentId &&
          input.record.runId === input.delivery.runId &&
          input.record.decision.level === input.delivery.level &&
          input.delivery.status === "pending" &&
          input.delivery.assignedClientId === null &&
          input.delivery.attempts === 0;
    if (!deliveryMatches) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Attention decision ${input.record.candidateId} does not match its Delivery Request`,
        { candidateId: input.record.candidateId },
      );
    }
    if (input.delivery && this.deliveries.has(input.delivery.id)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Delivery request ${input.delivery.id} already exists`,
        { requestId: input.delivery.id },
      );
    }
    const state = frozenCopy({
      revision: current.revision + 1,
      decisions: [...current.decisions, input.record],
    });
    const delivery = input.delivery ? frozenCopy({ ...input.delivery, revision: 1 }) : null;
    this.policies.set(key, state);
    if (delivery) this.deliveries.set(delivery.id, delivery);
    return frozenCopy({ state, record: input.record, delivery });
  }

  async readDelivery(requestId: string): Promise<DeliveryRequest | undefined> {
    const request = this.deliveries.get(requestId);
    return request ? frozenCopy(request) : undefined;
  }

  async claimDelivery(
    requestId: string,
    clientId: string,
    claimedAt: string,
  ): Promise<DeliveryClaim> {
    this.failures.checkpoint("attention.claimDelivery");
    const current = this.deliveries.get(requestId);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Delivery request ${requestId} not found`,
        { requestId },
      );
    }
    if (current.status === "delivered") {
      return frozenCopy({ claimed: false, request: current, reasonCode: "ALREADY_DELIVERED" });
    }
    if (current.status === "delivering") {
      return frozenCopy({ claimed: false, request: current, reasonCode: "ALREADY_CLAIMED" });
    }
    const claimed = frozenCopy({
      ...current,
      revision: current.revision + 1,
      status: "delivering" as const,
      assignedClientId: clientId,
      attempts: current.attempts + 1,
      updatedAt: claimedAt,
    });
    this.deliveries.set(requestId, claimed);
    return frozenCopy({ claimed: true, request: claimed, reasonCode: "CLAIMED" });
  }

  async settleDelivery(input: DeliverySettlement): Promise<DeliveryRequest> {
    this.failures.checkpoint("attention.settleDelivery");
    const current = this.deliveries.get(input.requestId);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Delivery request ${input.requestId} not found`,
        { requestId: input.requestId },
      );
    }
    const validAcknowledgement =
      input.outcome === "delivered"
        ? input.acknowledgementRef !== null && input.errorCode === null
        : input.acknowledgementRef === null;
    if (
      current.status !== "delivering" ||
      current.revision !== input.expectedRevision ||
      current.assignedClientId !== input.clientId ||
      !validAcknowledgement
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Delivery request ${input.requestId} cannot settle from its current state`,
        { requestId: input.requestId },
      );
    }
    const delivered = input.outcome === "delivered";
    const settled = frozenCopy({
      ...current,
      revision: current.revision + 1,
      status: delivered ? ("delivered" as const) : ("pending" as const),
      assignedClientId: delivered ? current.assignedClientId : null,
      acknowledgementRef: delivered ? input.acknowledgementRef : null,
      lastErrorCode: delivered ? null : (input.errorCode ?? "DELIVERY_UNAVAILABLE"),
      updatedAt: input.settledAt,
    });
    this.deliveries.set(input.requestId, settled);
    return frozenCopy(settled);
  }
}

export class DeterministicDeliveryPort implements DeliveryPort {
  private readonly results: Readonly<Record<string, DeliveryAttemptResult>>;
  private readonly defaultResult: DeliveryAttemptResult;
  private readonly attempts: DeliveryAttempt[] = [];

  constructor(
    results: Readonly<Record<string, DeliveryAttemptResult>> = {},
    defaultResult: DeliveryAttemptResult = {
      outcome: "unavailable",
      acknowledgementRef: null,
      errorCode: "CLIENT_UNAVAILABLE",
    },
  ) {
    this.results = frozenCopy(results);
    this.defaultResult = frozenCopy(defaultResult);
  }

  async deliver(input: DeliveryAttempt): Promise<DeliveryAttemptResult> {
    if (
      input.request.status !== "delivering" ||
      input.request.assignedClientId !== input.clientId
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Delivery adapter requires a request claimed by the same client",
        { requestId: input.request.id, clientId: input.clientId },
      );
    }
    this.attempts.push(frozenCopy(input));
    return frozenCopy(this.results[input.clientId] ?? this.defaultResult);
  }

  observedAttempts(): readonly DeliveryAttempt[] {
    return this.attempts.map(frozenCopy);
  }
}

export class ScriptedWorkerRunPort implements WorkerRunPort {
  private readonly events: readonly WorkerRunEvent[];
  private readonly eventsByWorker: Readonly<Record<string, readonly WorkerRunEvent[]>>;
  private readonly replays = new Map<
    string,
    { readonly fingerprint: string; readonly events: readonly WorkerRunEvent[] }
  >();
  private readonly requests: WorkerRunRequest[] = [];
  private readonly cancellations = new Map<string, string>();

  constructor(
    events: readonly WorkerRunEvent[] = [],
    eventsByWorker: Readonly<Record<string, readonly WorkerRunEvent[]>> = {},
  ) {
    this.events = frozenCopy([...events]);
    this.eventsByWorker = frozenCopy(eventsByWorker);
  }

  async *run(request: WorkerRunRequest): AsyncIterable<WorkerRunEvent> {
    const fingerprint = JSON.stringify(request);
    const replay = this.replays.get(request.idempotencyKey);
    if (replay && replay.fingerprint !== fingerprint) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Worker idempotency key ${request.idempotencyKey} was reused with another request`,
        { idempotencyKey: request.idempotencyKey },
      );
    }
    const events = replay?.events ?? this.eventsByWorker[request.workerRunId] ?? this.events;
    if (!replay) {
      this.requests.push(frozenCopy(request));
      this.replays.set(request.idempotencyKey, {
        fingerprint,
        events: frozenCopy([...events]),
      });
    }
    for (const event of events) {
      yield frozenCopy({ ...event, workerRunId: request.workerRunId });
    }
  }

  async cancel(workerRunId: string, reasonCode: string): Promise<void> {
    this.cancellations.set(workerRunId, reasonCode);
  }

  observedRequests(): readonly WorkerRunRequest[] {
    return this.requests.map(frozenCopy);
  }

  cancellationReason(workerRunId: string): string | undefined {
    return this.cancellations.get(workerRunId);
  }
}

export class InMemoryScheduler implements SchedulerPort {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async read(jobId: string): Promise<ScheduledJob | undefined> {
    const job = this.jobs.get(jobId);
    return job ? frozenCopy(job) : undefined;
  }

  async upsert(job: ScheduledJobWrite, expectedRevision: number | null): Promise<ScheduledJob> {
    this.failures.checkpoint("scheduler.upsert");
    const current = this.jobs.get(job.id);
    const currentRevision = current?.revision ?? null;
    if (currentRevision !== expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Scheduled job ${job.id} revision conflict`,
        {
          jobId: job.id,
          expectedRevision: String(expectedRevision),
          currentRevision: String(currentRevision),
        },
      );
    }
    const stored = frozenCopy({ ...job, revision: (current?.revision ?? 0) + 1 });
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

  async cancel(jobId: string, expectedRevision: number): Promise<ScheduledJob> {
    this.failures.checkpoint("scheduler.cancel");
    const current = this.jobs.get(jobId);
    if (!current) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Job ${jobId} not found`, {
        jobId,
      });
    }
    if (current.revision !== expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Scheduled job ${jobId} revision conflict`,
        {
          jobId,
          expectedRevision: String(expectedRevision),
          currentRevision: String(current.revision),
        },
      );
    }
    if (current.status === "cancelled") return frozenCopy(current);
    const cancelled = frozenCopy({
      ...current,
      revision: current.revision + 1,
      status: "cancelled" as const,
    });
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
