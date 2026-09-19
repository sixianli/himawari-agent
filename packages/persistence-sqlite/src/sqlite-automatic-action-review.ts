import type Database from "better-sqlite3";
import type {
  ApprovalRequest,
  AutomaticReviewDelegation,
  AutomaticReviewStart,
  AutomaticReviewFinish,
  AutomaticReviewRecord,
  GovernedApprovalRequest,
  GovernedGrantRecord,
  ResolveApprovalInput,
  RunExecutionLeaseClaim,
} from "@himawari-agent/application";
import { actionIntentFingerprint } from "@himawari-agent/application/action-intent-snapshot";
import {
  automaticReviewDelegationCovers,
  parseAutomaticReviewDecision,
} from "@himawari-agent/application/automatic-action-review";
import { SqliteRunDispatchOperations } from "./sqlite-run-dispatch-operations.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

/** Arbitration is synchronous: no model or payload I/O runs inside this transaction. */
export class SqliteAutomaticActionReview {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly approvals: {
    find(intentId: string): ApprovalRequest | undefined;
    create(input: ApprovalRequest): ApprovalRequest;
    resolve(input: ResolveApprovalInput): ApprovalRequest;
  };
  private readonly now: () => string;
  constructor(
    db: Database.Database,
    fail: SqliteApplicationFailure,
    approvals: SqliteAutomaticActionReview["approvals"],
    now: () => string = () => new Date().toISOString(),
  ) {
    this.db = db;
    this.fail = fail;
    this.approvals = approvals;
    this.now = now;
  }

  readDelegation(input: {
    ownerId: string;
    agentId: string;
    key: string;
  }): { revision: number; value: AutomaticReviewDelegation } | undefined {
    const row = this.db
      .prepare(
        "SELECT revision, value_json AS valueJson FROM product_state_records WHERE key=? AND owner_id=? AND agent_id=?",
      )
      .get(input.key, input.ownerId, input.agentId) as
      | { revision: number; valueJson: string }
      | undefined;
    return row ? { revision: row.revision, value: JSON.parse(row.valueJson) } : undefined;
  }
  get(reviewId: string): AutomaticReviewRecord | undefined {
    const row = this.db
      .prepare("SELECT record_json AS json FROM automatic_action_reviews WHERE id=?")
      .get(reviewId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  private guard(start: AutomaticReviewStart, lease: RunExecutionLeaseClaim, now: string): void {
    const { request, intent } = start;
    if (
      request.schemaVersion !== "automatic-review.v1" ||
      request.runId !== intent.runId ||
      request.intentFingerprint !== actionIntentFingerprint(intent) ||
      intent.finalRisk === "CRITICAL" ||
      intent.credentialOrAccessChange ||
      !Number.isFinite(Date.parse(request.deadlineAt)) ||
      now >= request.deadlineAt ||
      request.deadlineAt > request.approvalExpiresAt ||
      request.approvalExpiresAt > intent.expiresAt
    )
      this.fail("PORT_NOT_AUTHORITATIVE", "Automatic review request expired or changed");
    const delegation = this.readDelegation({
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      key: start.delegation.key,
    });
    if (
      !delegation ||
      delegation.revision !== start.delegation.revision ||
      !automaticReviewDelegationCovers(delegation.value, request, now)
    )
      this.fail("PORT_NOT_AUTHORITATIVE", "Automatic review delegation revoked or changed");
    const original = start.executionLease;
    for (const key of [
      "executionLeaseId",
      "authorityLeaseId",
      "authorityFencingToken",
      "deploymentId",
      "authorityEpoch",
      "fencingToken",
      "consumerId",
    ] as const)
      if (lease[key] !== original[key])
        this.fail("PORT_NOT_AUTHORITATIVE", "Automatic review execution authority changed");
    new SqliteRunDispatchOperations(
      this.db,
      {
        ownerId: intent.ownerId,
        agentId: intent.agentId,
        authority: {
          deploymentId: lease.deploymentId,
          authorityEpoch: lease.authorityEpoch,
          fencingToken: lease.fencingToken,
        },
        authorityLease: {
          leaseId: lease.authorityLeaseId,
          fencingToken: lease.authorityFencingToken,
        },
        consumerId: lease.consumerId,
      },
      this.fail,
    ).assertHeldInTransaction({
      runId: intent.runId,
      executionLeaseId: lease.executionLeaseId,
      expectedLeaseRevision: lease.expectedLeaseRevision,
      at: now,
    });
    const run = this.db
      .prepare("SELECT status FROM runs WHERE id=? AND owner_id=? AND agent_id=?")
      .get(intent.runId, intent.ownerId, intent.agentId) as { status: string } | undefined;
    if (!run || ["completed", "failed", "cancelled"].includes(run.status))
      this.fail("PORT_NOT_AUTHORITATIVE", "Automatic review Run ended");
  }
  private payload(start: AutomaticReviewStart, ref: string): void {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM payloads WHERE ref=? AND owner_id=? AND agent_id=? AND lifecycle_state='active' AND encryption_algorithm IS NOT NULL AND key_ref IS NOT NULL",
        )
        .get(ref, start.intent.ownerId, start.intent.agentId)
    )
      this.fail("PORT_NOT_AUTHORITATIVE", "Automatic review requires a scoped protected payload");
  }
  claim(
    input: AutomaticReviewStart,
  ): { record: AutomaticReviewRecord; claimed: boolean } | undefined {
    return this.db
      .transaction(() => {
        const old = this.db
          .prepare("SELECT record_json AS json FROM automatic_action_reviews WHERE intent_id=?")
          .get(input.intent.id) as { json: string } | undefined;
        if (old) {
          const record = JSON.parse(old.json) as AutomaticReviewRecord;
          if (
            record.request.intentFingerprint !== input.request.intentFingerprint ||
            record.intent.ownerId !== input.intent.ownerId ||
            record.intent.agentId !== input.intent.agentId
          )
            this.fail("PORT_CONFLICT", "Automatic review intent identity changed");
          return { record, claimed: false };
        }
        if (this.approvals.find(input.intent.id)) return undefined;
        const now = this.now();
        this.guard(input, input.executionLease, now);
        this.payload(input, input.request.inputRef);
        const record: AutomaticReviewRecord = {
          ...input,
          startedAt: now,
          status: "pending",
          result: null,
        };
        this.db
          .prepare(
            "INSERT INTO automatic_action_reviews(id, intent_id, owner_id, agent_id, run_id, record_json) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            input.request.reviewId,
            input.intent.id,
            input.intent.ownerId,
            input.intent.agentId,
            input.intent.runId,
            JSON.stringify(record),
          );
        return { record, claimed: true };
      })
      .immediate();
  }
  finish(input: AutomaticReviewFinish): AutomaticReviewRecord {
    return this.db
      .transaction(() => {
        const record = this.get(input.reviewId);
        if (!record) return this.fail("PORT_NOT_FOUND", "Automatic review missing");
        const decision = parseAutomaticReviewDecision(record.request, input.decision);
        if (record.result) {
          if (
            record.result.decision !== decision.decision ||
            record.result.reasonCode !== decision.reasonCode ||
            record.result.outputRef !== input.outputRef
          )
            this.fail("PORT_CONFLICT", "Automatic review result changed");
          return record;
        }
        const now = this.now();
        this.guard(record, input.executionLease, now);
        this.payload(record, input.outputRef);
        // Never create authority after a human request or decision has won the race.
        if (this.approvals.find(record.intent.id))
          this.fail("PORT_CONFLICT", "An approval already owns this request");
        let approvalRequestId: string | null = null;
        if (decision.decision === "approve" || decision.decision === "deny") {
          const intent = record.intent;
          approvalRequestId = `automatic-approval:${record.request.reviewId}`;
          const approval: GovernedApprovalRequest = {
            id: approvalRequestId,
            revision: 1,
            ownerId: intent.ownerId,
            agentId: intent.agentId,
            runId: intent.runId,
            intentId: intent.id,
            intentSnapshot: intent,
            semanticSnapshotHash: record.request.intentFingerprint,
            status: "pending",
            deliveryState: "queued_no_ui",
            requestedAt: record.startedAt,
            expiresAt: record.request.approvalExpiresAt,
            decidedAt: null,
            grantId: null,
            finalRisk: intent.finalRisk,
            recentAuthenticationRequired: false,
            recentAuthenticationRef: null,
            policyAuthorization: record.delegation,
            automaticReview: {
              reviewId: record.request.reviewId,
              configurationVersion: record.request.configurationVersion,
              modelRef: record.request.modelRef,
              outputRef: input.outputRef,
            },
          };
          this.approvals.create(approval);
          // Build authority only from the original intent; the reviewer supplies no scope.
          const grant: GovernedGrantRecord | null =
            decision.decision === "approve"
              ? {
                  id: `automatic-grant:${record.request.reviewId}`,
                  revision: 1,
                  ownerId: intent.ownerId,
                  agentId: intent.agentId,
                  kind: "one_time",
                  intentFingerprint: record.request.intentFingerprint,
                  sourceApprovalRequestId: approvalRequestId,
                  validFrom: now,
                  expiresAt: record.request.approvalExpiresAt,
                  maxUses: 1,
                  uses: 0,
                  maxTotalCostMicros: intent.estimatedCostMicros,
                  spentCostMicros: 0,
                  revokedAt: null,
                  revocationReasonCode: null,
                  scope: {
                    capabilityRef: intent.capabilityRef,
                    capabilityVersion: intent.capabilityVersion,
                    operations: [intent.operation],
                    exactResourceRef: intent.resourceRef,
                    resourceIdentities: [...intent.resourceRefs],
                    resourcePrefixes: [],
                    maxDataClassification: intent.dataClassification,
                    sideEffects: [intent.sideEffect],
                    maxCostMicrosPerUse: intent.estimatedCostMicros,
                    maxFrequency: intent.frequency,
                    disclosure: intent.disclosure,
                    recipients: [...intent.recipients],
                    credentialOrAccessChange: false,
                  },
                }
              : null;
          this.approvals.resolve({
            approvalRequestId,
            expectedRevision: 1,
            semanticSnapshotHash: record.request.intentFingerprint,
            resolution: grant ? "approved" : "denied",
            decidedAt: now,
            grant,
          });
        }
        const resolved: AutomaticReviewRecord = {
          ...record,
          status: "finished",
          result: {
            decision: decision.decision,
            reasonCode: decision.reasonCode,
            outputRef: input.outputRef,
            completedAt: now,
            approvalRequestId,
          },
        };
        this.db
          .prepare("UPDATE automatic_action_reviews SET record_json=? WHERE id=?")
          .run(JSON.stringify(resolved), input.reviewId);
        return resolved;
      })
      .immediate();
  }
}
