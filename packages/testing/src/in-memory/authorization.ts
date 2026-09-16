import {
  actionIntentFingerprint,
  canonicalAuthorizationSnapshot,
  governedGrantAuthorityCovers,
  approvalMatchesIntent,
  isApprovalResolutionReplay,
} from "@himawari-agent/application/action-intent-snapshot";
import type {
  ApprovalRequest,
  AuthorizationReservation,
  ReserveAuthorizationInput,
  GovernedGrantRecord,
  GovernedCapabilityExecutionHandle,
  AuthorizationStorePort,
  ConsumeGrantInput,
  GrantRecord,
  ResolveApprovalInput,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy } from "./helpers.js";

export class InMemoryAuthorizationStore implements AuthorizationStorePort {
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly grants = new Map<string, GrantRecord>();
  private readonly reservations = new Map<string, AuthorizationReservation>();
  private readonly handles = new Map<
    string,
    { read: () => GovernedCapabilityExecutionHandle; revoke: (now: string) => void }
  >();
  private readonly usage = new Map<string, { grant: GrantRecord; input: ConsumeGrantInput }>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  private liveReservation(record: AuthorizationReservation, now: string): GovernedGrantRecord {
    const grant = this.grants.get(record.grantId) as GovernedGrantRecord | undefined;
    const approval = grant ? this.approvals.get(grant.sourceApprovalRequestId) : undefined;
    if (
      !grant ||
      !governedGrantAuthorityCovers(grant, record.intent, now) ||
      now >= record.expiresAt ||
      !approval ||
      approval.status !== "approved" ||
      approval.grantId !== grant.id ||
      (grant.kind === "one_time" && !approvalMatchesIntent(approval, record.intent))
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Reservation authority is no longer valid",
      );
    return grant;
  }

  async getAuthorizationReservation(id: string): Promise<AuthorizationReservation | undefined> {
    const record = this.reservations.get(id);
    return record ? frozenCopy(record) : undefined;
  }

  async reserveAuthorization(input: ReserveAuthorizationInput): Promise<AuthorizationReservation> {
    const id = `authorization-reservation:${input.intent.id}`;
    const existing = this.reservations.get(id);
    if (existing) {
      if (
        existing.grantId !== input.grantId ||
        canonicalAuthorizationSnapshot(existing.intent) !==
          canonicalAuthorizationSnapshot(input.intent)
      )
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Reservation identity changed");
      if (existing.status === "released")
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Released operation requires a new intent",
        );
      this.liveReservation(existing, input.now);
      return frozenCopy(existing);
    }
    const grant = this.grants.get(input.grantId);
    if (!grant)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Reservation grant not found");
    const record: AuthorizationReservation = {
      id,
      grantId: grant.id,
      intent: input.intent,
      semanticSnapshotHash: actionIntentFingerprint(input.intent),
      status: "reserved",
      createdAt: input.now,
      expiresAt:
        grant.expiresAt < input.intent.expiresAt ? grant.expiresAt : input.intent.expiresAt,
      handleRef: null,
      invocationRef: null,
      resolvedAt: null,
      reasonCode: null,
    };
    this.liveReservation(record, input.now);
    for (const row of this.reservations.values()) {
      if (row.grantId === grant.id && row.status === "reserved" && row.expiresAt <= input.now)
        this.releaseReservation({
          reservationId: row.id,
          now: input.now,
          reasonCode: "reservation_expired",
        });
    }
    const held = [...this.reservations.values()].filter(
      (row) => row.grantId === grant.id && row.status === "reserved",
    );
    if (
      grant.uses + held.length >= grant.maxUses ||
      grant.spentCostMicros +
        held.reduce((cost, row) => cost + row.intent.estimatedCostMicros, 0) +
        input.intent.estimatedCostMicros >
        grant.maxTotalCostMicros
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Authorization quota is already reserved or committed",
        { reasonCode: "AUTHORIZATION_QUOTA_UNAVAILABLE" },
      );
    this.reservations.set(id, frozenCopy(record));
    return frozenCopy(record);
  }

  private releaseReservation(input: {
    reservationId: string;
    now: string;
    reasonCode: string;
  }): AuthorizationReservation {
    const record = this.reservations.get(input.reservationId);
    if (!record)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Reservation not found");
    if (record.status === "released") return frozenCopy(record);
    if (record.status === "committed")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        "Possibly dispatched quota cannot be refunded",
      );
    const handle = record.handleRef ? this.handles.get(record.handleRef) : undefined;
    if (handle?.read().uses)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Handle authority was consumed");
    handle?.revoke(input.now);
    const released = frozenCopy({
      ...record,
      status: "released" as const,
      resolvedAt: input.now,
      reasonCode: input.reasonCode,
    });
    this.reservations.set(record.id, released);
    return released;
  }

  async releaseAuthorization(input: {
    reservationId: string;
    now: string;
    reasonCode: string;
  }): Promise<AuthorizationReservation> {
    return this.releaseReservation(input);
  }

  bindReservationHandle(
    id: string,
    handle: GovernedCapabilityExecutionHandle,
    access: { read: () => GovernedCapabilityExecutionHandle; revoke: (now: string) => void },
  ): GovernedCapabilityExecutionHandle | undefined {
    const record = this.reservations.get(id);
    if (!record || record.status !== "reserved")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Reservation cannot issue a Handle",
      );
    this.liveReservation(record, handle.issuedAt);
    if (
      handle.authorization.ref !== record.grantId ||
      handle.authorization.type !== "grant" ||
      handle.ownerId !== record.intent.ownerId ||
      handle.agentId !== record.intent.agentId ||
      handle.runId !== record.intent.runId ||
      handle.capabilityRef !== record.intent.capabilityRef ||
      handle.capabilityVersion !== record.intent.capabilityVersion ||
      handle.operations.length !== 1 ||
      handle.operations[0] !== record.intent.operation ||
      handle.maxUses !== 1 ||
      handle.expiresAt > record.expiresAt ||
      handle.maxTotalCostMicros > record.intent.estimatedCostMicros
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Handle exceeds reservation",
      );
    if (record.handleRef) {
      const existing = this.handles.get(record.handleRef)?.read();
      if (!existing)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Bound Handle disappeared");
      const comparable = (value: GovernedCapabilityExecutionHandle) => ({
        ...value,
        ref: "",
        issuedAt: "",
      });
      if (
        canonicalAuthorizationSnapshot(comparable(existing)) !==
        canonicalAuthorizationSnapshot(comparable(handle))
      )
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Reservation Handle inputs changed",
        );
      return frozenCopy(existing);
    }
    this.handles.set(handle.ref, access);
    this.reservations.set(id, frozenCopy({ ...record, handleRef: handle.ref }));
    return undefined;
  }

  releaseUnusedHandle(handleRef: string, now: string): void {
    const row = [...this.reservations.values()].find(
      (record) => record.handleRef === handleRef && record.status === "reserved",
    );
    if (row)
      this.releaseReservation({
        reservationId: row.id,
        now,
        reasonCode: "handle_withdrawn_before_dispatch",
      });
  }

  releaseRun(runId: string, now: string): void {
    for (const row of this.reservations.values()) {
      if (row.intent.runId === runId && row.status === "reserved")
        this.releaseReservation({
          reservationId: row.id,
          now,
          reasonCode: "run_ended_before_dispatch",
        });
    }
  }

  commitReservationHandle(handleRef: string, invocationRef: string, now: string): void {
    const record = [...this.reservations.values()].find((row) => row.handleRef === handleRef);
    if (!record) return;
    if (record.status === "committed" && record.invocationRef === invocationRef) return;
    if (record.status !== "reserved")
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Reservation was already resolved");
    const grant = this.liveReservation(record, now);
    this.grants.set(
      grant.id,
      frozenCopy({
        ...grant,
        revision: grant.revision + 1,
        uses: grant.uses + 1,
        spentCostMicros: grant.spentCostMicros + record.intent.estimatedCostMicros,
      }),
    );
    this.reservations.set(
      record.id,
      frozenCopy({
        ...record,
        status: "committed",
        invocationRef,
        resolvedAt: now,
        reasonCode: "invocation_admitted",
      }),
    );
  }

  async createApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    this.failures.checkpoint("authorization.createApproval");
    const existing = [...this.approvals.values()].find(
      (record) => record.intentId === request.intentId,
    );
    if (existing) {
      if (!approvalMatchesIntent(existing, request.intentSnapshot))
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          "Approval intent identity changed",
        );
      return frozenCopy(existing);
    }
    if (this.approvals.has(request.id)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Approval ${request.id} already exists`,
        { approvalRequestId: request.id },
      );
    }
    this.approvals.set(request.id, frozenCopy(request));
    return frozenCopy(request);
  }

  async findApprovalByIntent(intentId: string): Promise<ApprovalRequest | undefined> {
    this.failures.checkpoint("authorization.findApprovalByIntent");
    const matches = [...this.approvals.values()].filter(
      (approval) => approval.intentId === intentId,
    );
    const latest = matches.at(-1);
    return latest ? frozenCopy(latest) : undefined;
  }

  async getApproval(approvalRequestId: string): Promise<ApprovalRequest | undefined> {
    this.failures.checkpoint("authorization.getApproval");
    const approval = this.approvals.get(approvalRequestId);
    return approval ? frozenCopy(approval) : undefined;
  }

  async listApprovals(ownerId: OwnerId, agentId: AgentId): Promise<readonly ApprovalRequest[]> {
    this.failures.checkpoint("authorization.listApprovals");
    return [...this.approvals.values()]
      .filter((approval) => approval.ownerId === ownerId && approval.agentId === agentId)
      .sort(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id),
      )
      .map(frozenCopy);
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<ApprovalRequest> {
    this.failures.checkpoint("authorization.resolveApproval");
    const current = this.approvals.get(input.approvalRequestId);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Approval ${input.approvalRequestId} not found`,
        { approvalRequestId: input.approvalRequestId },
      );
    }
    if (
      isApprovalResolutionReplay(
        current,
        input,
        current.grantId ? this.grants.get(current.grantId) : undefined,
      )
    )
      return frozenCopy(current);
    if (current.revision !== input.expectedRevision || current.status !== "pending") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Approval ${current.id} cannot be resolved from its current revision`,
        { approvalRequestId: current.id, status: current.status },
      );
    }
    if (current.semanticSnapshotHash !== input.semanticSnapshotHash) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Approval ${current.id} semantic snapshot changed`,
        { approvalRequestId: current.id },
      );
    }
    if ((input.resolution === "approved") !== (input.grant !== null)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Approved resolutions require exactly one Grant",
        { approvalRequestId: current.id },
      );
    }
    if (input.grant && this.grants.has(input.grant.id)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Grant ${input.grant.id} already exists`,
        { grantId: input.grant.id },
      );
    }

    const resolved = frozenCopy({
      ...current,
      revision: current.revision + 1,
      status: input.resolution,
      decidedAt: input.decidedAt,
      grantId: input.grant?.id ?? null,
      ...(input.recentAuthenticationRef !== undefined
        ? { recentAuthenticationRef: input.recentAuthenticationRef }
        : {}),
    });
    if (input.grant) this.grants.set(input.grant.id, frozenCopy(input.grant));
    this.approvals.set(current.id, resolved);
    return frozenCopy(resolved);
  }

  async listGrants(ownerId: OwnerId, agentId: AgentId): Promise<readonly GrantRecord[]> {
    this.failures.checkpoint("authorization.listGrants");
    return [...this.grants.values()]
      .filter((grant) => grant.ownerId === ownerId && grant.agentId === agentId)
      .map(frozenCopy);
  }

  async consumeGrant(input: ConsumeGrantInput): Promise<GrantRecord> {
    this.failures.checkpoint("authorization.consumeGrant");
    const current = this.grants.get(input.grantId);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Grant ${input.grantId} not found`,
        { grantId: input.grantId },
      );
    }
    if (
      current.revokedAt !== null ||
      input.consumedAt < current.validFrom ||
      input.consumedAt >= current.expiresAt
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Grant is revoked or expired",
      );
    if (input.usageId) {
      const replay = this.usage.get(input.usageId);
      if (replay) {
        if (
          replay.input.grantId !== input.grantId ||
          replay.input.runId !== input.runId ||
          replay.input.intentId !== input.intentId ||
          replay.input.operation !== input.operation ||
          replay.input.costMicros !== input.costMicros
        )
          throw new ApplicationPortError(
            PORT_ERROR_CODES.CONFLICT,
            "Authorization usage identity changed",
          );
        return frozenCopy(current);
      }
    }
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Grant ${current.id} has a stale revision`,
        { grantId: current.id },
      );
    }
    if (
      current.revokedAt !== null ||
      input.consumedAt < current.validFrom ||
      input.consumedAt >= current.expiresAt ||
      current.uses +
        [...this.reservations.values()].filter(
          (row) => row.grantId === current.id && row.status === "reserved",
        ).length >=
        current.maxUses ||
      current.spentCostMicros +
        [...this.reservations.values()]
          .filter((row) => row.grantId === current.id && row.status === "reserved")
          .reduce((cost, row) => cost + row.intent.estimatedCostMicros, 0) +
        input.costMicros >
        current.maxTotalCostMicros
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Grant ${current.id} is not consumable`,
        { grantId: current.id },
      );
    }
    const consumed = frozenCopy({
      ...current,
      revision: current.revision + 1,
      uses: current.uses + 1,
      spentCostMicros: current.spentCostMicros + input.costMicros,
    });
    this.grants.set(current.id, consumed);
    if (input.usageId) this.usage.set(input.usageId, { grant: consumed, input: frozenCopy(input) });
    return frozenCopy(consumed);
  }

  async revokeGrant(
    grantId: string,
    revokedAt: string,
    reasonCode: string,
    expectedRevision?: number,
  ): Promise<GrantRecord> {
    this.failures.checkpoint("authorization.revokeGrant");
    const current = this.grants.get(grantId);
    if (!current) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Grant ${grantId} not found`, {
        grantId,
      });
    }
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Grant ${current.id} has a stale revision`,
        { grantId: current.id },
      );
    }
    if (current.revokedAt !== null) return frozenCopy(current);
    const revoked = frozenCopy({
      ...current,
      revision: current.revision + 1,
      revokedAt,
      revocationReasonCode: reasonCode,
    });
    this.grants.set(grantId, revoked);
    return frozenCopy(revoked);
  }
}
