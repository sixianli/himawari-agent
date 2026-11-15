import type {
  PairedDeviceScope,
  WebPushAttempt,
  WebPushAttemptStatus,
  WebPushOutboxItem,
} from "@himawari-agent/application";
import {
  APPLE_PUSH_ACTIVITY_REF_PATTERN,
  APPLE_PUSH_CONFIGURATION_BOUNDS,
  APPLE_PUSH_ENVIRONMENTS,
  APPLE_PUSH_TOKEN_PATTERN,
  APPLE_PUSH_TOPIC_PATTERN,
  APPLE_PUSH_TYPES,
  type ApplePushActivityRun,
  type ApplePushDue,
  type ApplePushRegistration,
  type ApplePushStorePort,
  NOTIFICATION_ACTIONS,
  type NotificationAction,
  type NotificationActionToken,
  type NotificationActionTokenResult,
} from "@himawari-agent/application/apple-push";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { TIMING_DEFER_REFS } from "./sqlite-web-push-operations.ts";

type Input<TName extends keyof ApplePushStorePort> = Parameters<ApplePushStorePort[TName]>[0];

const registrationColumns = `r.id, r.owner_id AS ownerId, r.agent_id AS agentId,
  r.device_id AS deviceId, r.push_type AS pushType, r.activity_ref AS activityRef, r.token,
  r.environment, r.topic, r.locale, r.status, r.failure_code AS failureCode,
  r.created_at AS createdAt, r.updated_at AS updatedAt, r.last_delivered_at AS lastDeliveredAt`;

const ELIGIBLE_ALERT_REGISTRATION = `r.push_type = 'alert' AND r.status = 'active'
  AND EXISTS (SELECT 1 FROM paired_devices d
    WHERE d.id = r.device_id AND d.status = 'active' AND d.companion_of IS NULL)`;

const LOCALES: readonly ApplePushRegistration["locale"][] = ["zh-CN", "en", "ja"];

const ATTEMPT_STATUSES: readonly WebPushAttemptStatus[] = [
  "pending",
  "sent",
  "suppressed",
  "expired",
  "gone",
  "failed",
];

const TOKEN_HASH = /^[0-9a-f]{64}$/u;

interface TokenRow {
  readonly tokenHash: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly deviceId: string;
  readonly sourceKey: string;
  readonly action: string;
  readonly ownerPresence: number;
  readonly approvalRequestId: string | null;
  readonly approvalRevision: number | null;
  readonly approvalSnapshotHash: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
}

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function disablePushForRevokedDevices(
  database: Database.Database,
  deviceIds: readonly string[],
  now: string,
): void {
  const disable = database.prepare(
    `UPDATE apns_registrations
        SET status = 'disabled', failure_code = 'DEVICE_REVOKED', updated_at = ?
      WHERE device_id = ? AND status = 'active'`,
  );
  const forget = database.prepare("DELETE FROM notification_action_tokens WHERE device_id = ?");
  for (const deviceId of deviceIds) {
    disable.run(now, deviceId);
    forget.run(deviceId);
  }
}

export class SqliteApplePushOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "applePush.saveRegistration":
        return this.saveRegistration(payload as Input<"saveRegistration">);
      case "applePush.removeRegistration":
        return this.removeRegistration(payload as Input<"removeRegistration">);
      case "applePush.listRegistrations":
        return this.listRegistrations(payload as Input<"listRegistrations">);
      case "applePush.markRegistration":
        return this.markRegistration(payload as Input<"markRegistration">);
      case "applePush.routeOutbox":
        return this.routeOutbox(payload as Input<"routeOutbox">);
      case "applePush.listDue":
        return this.listDue(payload as Input<"listDue">);
      case "applePush.recordAttempt":
        return this.recordAttempt(payload as Input<"recordAttempt">);
      case "applePush.issueActionTokens":
        return this.issueActionTokens(payload as Input<"issueActionTokens">);
      case "applePush.readActionToken":
        return this.resolveActionToken(payload as Input<"readActionToken">, false);
      case "applePush.consumeActionToken":
        return this.resolveActionToken(payload as Input<"consumeActionToken">, true);
      case "applePush.setCompanion":
        return this.setCompanion(payload as Input<"setCompanion">);
      case "applePush.listActivityRuns":
        return this.listActivityRuns(payload as Input<"listActivityRuns">);
      case "applePush.readActivityRuns":
        return this.readActivityRuns(payload as Input<"readActivityRuns">);
      case "applePush.prune":
        return this.prune(payload as Input<"prune">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown Apple push operation ${operation}`);
    }
  }

  private time(value: string): string {
    if (!valid(value)) this.fail("PORT_INVALID_OPERATION", "Apple push time is invalid");
    return value;
  }

  private activeDevice(scope: PairedDeviceScope, deviceId: string) {
    const device = this.database
      .prepare(
        `SELECT id, kind, status, companion_of AS companionOf FROM paired_devices
          WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(deviceId, scope.ownerId, scope.agentId) as
      | { id: string; kind: string; status: string; companionOf: string | null }
      | undefined;
    if (!device) return this.fail("PORT_NOT_FOUND", "Paired device was not found");
    if (device.status !== "active")
      return this.fail("PORT_CONFLICT", "Paired device is not active");
    return device;
  }

  private readRegistration(id: string): ApplePushRegistration {
    const row = this.database
      .prepare(`SELECT ${registrationColumns} FROM apns_registrations r WHERE r.id = ?`)
      .get(id) as ApplePushRegistration | undefined;
    if (!row) return this.fail("PORT_NOT_FOUND", "Apple push registration was not found");
    return Object.freeze(row);
  }

  private saveRegistration(input: Input<"saveRegistration">): ApplePushRegistration {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    if (
      !/^apn_[A-Za-z0-9_-]{22}$/u.test(input.id) ||
      !APPLE_PUSH_TYPES.includes(input.pushType) ||
      !APPLE_PUSH_ENVIRONMENTS.includes(input.environment) ||
      !APPLE_PUSH_TOKEN_PATTERN.test(input.token) ||
      !APPLE_PUSH_TOPIC_PATTERN.test(input.topic) ||
      !LOCALES.includes(input.locale) ||
      !Number.isSafeInteger(input.activityLimit) ||
      input.activityLimit <
        APPLE_PUSH_CONFIGURATION_BOUNDS.liveActivityRegistrationsPerDevice.minimum ||
      input.activityLimit >
        APPLE_PUSH_CONFIGURATION_BOUNDS.liveActivityRegistrationsPerDevice.maximum ||
      (input.pushType === "liveactivity"
        ? input.activityRef !== "" && !APPLE_PUSH_ACTIVITY_REF_PATTERN.test(input.activityRef)
        : input.activityRef !== "")
    )
      this.fail("PORT_INVALID_OPERATION", "Apple push registration is invalid");
    return this.database.transaction(() => {
      this.activeDevice(input, input.deviceId);
      this.database
        .prepare(
          `INSERT INTO apns_registrations (
            id, owner_id, agent_id, device_id, push_type, activity_ref, token, environment,
            topic, locale, status, failure_code, created_at, updated_at, last_delivered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)
          ON CONFLICT (device_id, push_type, activity_ref) DO UPDATE SET
            token = excluded.token, environment = excluded.environment, topic = excluded.topic,
            locale = excluded.locale, status = 'active', failure_code = NULL,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.ownerId,
          input.agentId,
          input.deviceId,
          input.pushType,
          input.activityRef,
          input.token,
          input.environment,
          input.topic,
          input.locale,
          now,
          now,
        );
      const saved = this.database
        .prepare(
          `SELECT id FROM apns_registrations
            WHERE device_id = ? AND push_type = ? AND activity_ref = ?`,
        )
        .get(input.deviceId, input.pushType, input.activityRef) as { id: string };
      if (input.pushType === "liveactivity" && input.activityRef !== "")
        this.database
          .prepare(
            `DELETE FROM apns_registrations
              WHERE device_id = ? AND push_type = 'liveactivity' AND activity_ref <> ''
                AND id NOT IN (
                  SELECT id FROM apns_registrations
                   WHERE device_id = ? AND push_type = 'liveactivity' AND activity_ref <> ''
                   ORDER BY (id = ?) DESC, updated_at DESC, id DESC LIMIT ?)`,
          )
          .run(input.deviceId, input.deviceId, saved.id, input.activityLimit);
      return this.readRegistration(saved.id);
    })();
  }

  private removeRegistration(input: Input<"removeRegistration">): boolean {
    return (
      this.database
        .prepare(
          `DELETE FROM apns_registrations
            WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND push_type = ?
              AND activity_ref = ?`,
        )
        .run(input.ownerId, input.agentId, input.deviceId, input.pushType, input.activityRef)
        .changes > 0
    );
  }

  private listRegistrations(input: Input<"listRegistrations">): readonly ApplePushRegistration[] {
    if (!APPLE_PUSH_TYPES.includes(input.pushType))
      this.fail("PORT_INVALID_OPERATION", "Apple push type is invalid");
    return (
      this.database
        .prepare(
          `SELECT ${registrationColumns} FROM apns_registrations r
            JOIN paired_devices d ON d.id = r.device_id AND d.status = 'active'
            WHERE r.owner_id = ? AND r.agent_id = ? AND r.push_type = ? AND r.status = 'active'
              AND (? IS NULL OR r.activity_ref = ?)
              AND (? IS NULL OR r.device_id = ?)
            ORDER BY r.created_at, r.id`,
        )
        .all(
          input.ownerId,
          input.agentId,
          input.pushType,
          input.activityRef ?? null,
          input.activityRef ?? null,
          input.deviceId ?? null,
          input.deviceId ?? null,
        ) as ApplePushRegistration[]
    ).map((row) => Object.freeze(row));
  }

  private markRegistration(input: Input<"markRegistration">): void {
    const now = this.time(input.now);
    if (input.deliveredAt !== null) this.time(input.deliveredAt);
    if (
      !["active", "disabled"].includes(input.status) ||
      (input.failureCode !== null &&
        (input.failureCode.length < 1 || input.failureCode.length > 64))
    )
      this.fail("PORT_INVALID_OPERATION", "Apple push registration state is invalid");
    this.database
      .prepare(
        `UPDATE apns_registrations
            SET status = ?, failure_code = ?, updated_at = ?,
                last_delivered_at = coalesce(?, last_delivered_at)
          WHERE id = ? AND owner_id = ? AND agent_id = ?
            AND (? = 'disabled' OR failure_code IS NOT 'DEVICE_REVOKED')`,
      )
      .run(
        input.status,
        input.failureCode,
        now,
        input.deliveredAt,
        input.registrationId,
        input.ownerId,
        input.agentId,
        input.status,
      );
  }

  private routeOutbox(input: Input<"routeOutbox">): number {
    this.time(input.now);
    return this.database.transaction(() => {
      const routed = this.database
        .prepare(
          `UPDATE web_push_outbox SET channel = CASE
              WHEN NOT EXISTS (SELECT 1 FROM web_push_attempts a
                  WHERE a.owner_id = web_push_outbox.owner_id
                    AND a.agent_id = web_push_outbox.agent_id
                    AND a.source_key = web_push_outbox.source_key)
                AND EXISTS (SELECT 1 FROM apns_registrations r
                  WHERE r.owner_id = web_push_outbox.owner_id
                    AND r.agent_id = web_push_outbox.agent_id
                    AND ${ELIGIBLE_ALERT_REGISTRATION})
              THEN 'apns' ELSE 'web_push' END
            WHERE owner_id = ? AND agent_id = ? AND channel IS NULL`,
        )
        .run(input.ownerId, input.agentId).changes;
      const returned = this.database
        .prepare(
          `UPDATE web_push_outbox SET channel = 'web_push'
            WHERE owner_id = ? AND agent_id = ? AND channel = 'apns'
              AND NOT EXISTS (SELECT 1 FROM web_push_attempts a
                WHERE a.owner_id = web_push_outbox.owner_id
                  AND a.agent_id = web_push_outbox.agent_id
                  AND a.source_key = web_push_outbox.source_key AND a.channel = 'apns'
                  AND a.status IN ('pending', 'sent', 'suppressed', 'expired'))
              AND NOT EXISTS (SELECT 1 FROM apns_registrations r
                WHERE r.owner_id = web_push_outbox.owner_id
                  AND r.agent_id = web_push_outbox.agent_id
                  AND ${ELIGIBLE_ALERT_REGISTRATION}
                  AND NOT EXISTS (SELECT 1 FROM web_push_attempts a
                    WHERE a.owner_id = web_push_outbox.owner_id
                      AND a.agent_id = web_push_outbox.agent_id
                      AND a.source_key = web_push_outbox.source_key AND a.channel = 'apns'
                      AND a.subscription_id = r.id))`,
        )
        .run(input.ownerId, input.agentId).changes;
      return routed + returned;
    })();
  }

  private listDue(input: Input<"listDue">): readonly ApplePushDue[] {
    this.time(input.now);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Apple push limit is invalid");
    const rows = this.database
      .prepare(
        `SELECT o.source_key AS sourceKey, o.kind, o.source_ref AS sourceRef,
           o.thread_id AS threadId, o.created_at AS itemCreatedAt, o.expires_at AS expiresAt,
           o.defer_until AS deferUntil, o.defer_rule_refs AS deferRuleRefs,
           ${registrationColumns},
           a.status AS attemptStatus, a.attempts AS attemptCount,
           a.next_attempt_at AS nextAttemptAt, a.last_code AS lastCode,
           a.updated_at AS attemptUpdatedAt
         FROM web_push_outbox o
         JOIN apns_registrations r ON r.owner_id = o.owner_id AND r.agent_id = o.agent_id
           AND ${ELIGIBLE_ALERT_REGISTRATION}
         LEFT JOIN web_push_attempts a ON a.owner_id = o.owner_id AND a.agent_id = o.agent_id
           AND a.source_key = o.source_key AND a.channel = 'apns' AND a.subscription_id = r.id
         WHERE o.owner_id = ? AND o.agent_id = ? AND o.channel = 'apns'
           AND (o.defer_until IS NULL OR o.defer_until <= ?)
           AND (a.status IS NULL OR (a.status = 'pending'
             AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?)))
         ORDER BY o.created_at, o.source_key, r.created_at, r.id
         LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.now, input.now, input.limit) as Array<
      ApplePushRegistration & {
        sourceKey: string;
        kind: WebPushOutboxItem["kind"];
        sourceRef: string;
        threadId: string | null;
        itemCreatedAt: string;
        expiresAt: string;
        deferUntil: string | null;
        deferRuleRefs: string | null;
        attemptStatus: WebPushAttemptStatus | null;
        attemptCount: number | null;
        nextAttemptAt: string | null;
        lastCode: string | null;
        attemptUpdatedAt: string | null;
      }
    >;
    return rows.map((row) => ({
      item: {
        ownerId: row.ownerId,
        agentId: row.agentId,
        sourceKey: row.sourceKey,
        kind: row.kind,
        sourceRef: row.sourceRef,
        threadId: row.threadId,
        createdAt: row.itemCreatedAt,
        expiresAt: row.expiresAt,
        deferUntil: row.deferUntil,
        ...(row.deferRuleRefs === TIMING_DEFER_REFS ? { deferredByTiming: true } : {}),
      },
      registration: {
        id: row.id,
        ownerId: row.ownerId,
        agentId: row.agentId,
        deviceId: row.deviceId,
        pushType: row.pushType,
        activityRef: row.activityRef,
        token: row.token,
        environment: row.environment,
        topic: row.topic,
        locale: row.locale,
        status: row.status,
        failureCode: row.failureCode,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastDeliveredAt: row.lastDeliveredAt,
      },
      attempt:
        row.attemptStatus === null
          ? null
          : ({
              sourceKey: row.sourceKey,
              subscriptionId: row.id,
              status: row.attemptStatus,
              attempts: row.attemptCount ?? 0,
              nextAttemptAt: row.nextAttemptAt,
              lastCode: row.lastCode,
              updatedAt: row.attemptUpdatedAt ?? row.itemCreatedAt,
            } satisfies WebPushAttempt),
    }));
  }

  private recordAttempt(input: Input<"recordAttempt">): boolean {
    const now = this.time(input.now);
    if (input.nextAttemptAt !== null) this.time(input.nextAttemptAt);
    if (
      !ATTEMPT_STATUSES.includes(input.status) ||
      !Number.isSafeInteger(input.attempts) ||
      input.attempts < 0 ||
      input.attempts > 100 ||
      input.tag.length < 1 ||
      input.tag.length > 64
    )
      this.fail("PORT_INVALID_OPERATION", "Apple push attempt is invalid");
    return this.database.transaction(() => {
      const recorded =
        this.database
          .prepare(
            `INSERT INTO web_push_attempts (
              owner_id, agent_id, source_key, channel, push_type, subscription_id, status,
              attempts, next_attempt_at, last_code, updated_at
            ) SELECT ?, ?, ?, 'apns', 'alert', ?, ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM web_push_outbox
                WHERE owner_id = ? AND agent_id = ? AND source_key = ?)
            ON CONFLICT (owner_id, agent_id, source_key, channel, subscription_id) DO UPDATE SET
              status = excluded.status, attempts = excluded.attempts,
              next_attempt_at = excluded.next_attempt_at, last_code = excluded.last_code,
              updated_at = excluded.updated_at
            WHERE web_push_attempts.status = 'pending'`,
          )
          .run(
            input.ownerId,
            input.agentId,
            input.sourceKey,
            input.registrationId,
            input.status,
            input.attempts,
            input.nextAttemptAt,
            input.lastCode,
            now,
            input.ownerId,
            input.agentId,
            input.sourceKey,
          ).changes > 0;
      if (recorded && input.status === "sent")
        this.database
          .prepare(
            `INSERT INTO web_push_feedback (
              owner_id, agent_id, source_key, tag, kind, source_ref, thread_id, channel,
              first_sent_at, devices, opened_at, dismissed_at, updated_at
            ) SELECT owner_id, agent_id, source_key, ?, kind, source_ref, thread_id, 'apns',
                ?, 1, NULL, NULL, ?
              FROM web_push_outbox WHERE owner_id = ? AND agent_id = ? AND source_key = ?
            ON CONFLICT (owner_id, agent_id, source_key) DO UPDATE SET
              devices = min(100, web_push_feedback.devices + 1), updated_at = excluded.updated_at`,
          )
          .run(input.tag, now, now, input.ownerId, input.agentId, input.sourceKey);
      return recorded;
    })();
  }

  private issueActionTokens(input: Input<"issueActionTokens">): void {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const expiresAt = this.time(input.expiresAt);
    if (
      expiresAt <= now ||
      input.sourceKey.length < 1 ||
      input.sourceKey.length > 256 ||
      input.tokens.length < 1 ||
      input.tokens.length > 4 ||
      input.tokens.some(
        (token) =>
          !TOKEN_HASH.test(token.tokenHash) ||
          !NOTIFICATION_ACTIONS.includes(token.action) ||
          (token.approval !== null &&
            (!Number.isSafeInteger(token.approval.revision) || token.approval.revision < 1)),
      )
    )
      this.fail("PORT_INVALID_OPERATION", "Notification action token is invalid");
    this.database.transaction(() => {
      this.activeDevice(input, input.deviceId);
      this.database
        .prepare(
          `DELETE FROM notification_action_tokens
            WHERE owner_id = ? AND agent_id = ? AND source_key = ? AND device_id = ?
              AND used_at IS NULL`,
        )
        .run(input.ownerId, input.agentId, input.sourceKey, input.deviceId);
      const insert = this.database.prepare(
        `INSERT INTO notification_action_tokens (
          token_hash, owner_id, agent_id, device_id, source_key, action, owner_presence,
          approval_request_id, approval_revision, approval_snapshot_hash, created_at, expires_at,
          used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );
      for (const token of input.tokens)
        insert.run(
          token.tokenHash,
          input.ownerId,
          input.agentId,
          input.deviceId,
          input.sourceKey,
          token.action,
          token.ownerPresence ? 1 : 0,
          token.approval?.requestId ?? null,
          token.approval?.revision ?? null,
          token.approval?.snapshotHash ?? null,
          now,
          expiresAt,
        );
    })();
  }

  private resolveActionToken(
    input: Input<"consumeActionToken">,
    consume: boolean,
  ): NotificationActionTokenResult {
    const now = this.time(input.now);
    if (!TOKEN_HASH.test(input.tokenHash)) return { kind: "rejected", reason: "unknown" };
    const resolve = this.database.transaction((): NotificationActionTokenResult => {
      const row = this.database
        .prepare(
          `SELECT token_hash AS tokenHash, owner_id AS ownerId, agent_id AS agentId,
             device_id AS deviceId, source_key AS sourceKey, action,
             owner_presence AS ownerPresence,
             approval_request_id AS approvalRequestId, approval_revision AS approvalRevision,
             approval_snapshot_hash AS approvalSnapshotHash, created_at AS createdAt,
             expires_at AS expiresAt, used_at AS usedAt
           FROM notification_action_tokens WHERE token_hash = ?`,
        )
        .get(input.tokenHash) as TokenRow | undefined;
      if (!row) return { kind: "rejected", reason: "unknown" };
      const presenter = this.database
        .prepare(
          `SELECT status, companion_of AS companionOf, owner_id AS ownerId, agent_id AS agentId
             FROM paired_devices WHERE id = ?`,
        )
        .get(input.deviceId) as
        | { status: string; companionOf: string | null; ownerId: string; agentId: string }
        | undefined;
      if (
        !presenter ||
        presenter.ownerId !== row.ownerId ||
        presenter.agentId !== row.agentId ||
        (input.deviceId !== row.deviceId && presenter.companionOf !== row.deviceId)
      )
        return { kind: "rejected", reason: "other_device" };
      const issued = this.database
        .prepare("SELECT status FROM paired_devices WHERE id = ?")
        .get(row.deviceId) as { status: string } | undefined;
      if (presenter.status !== "active" || issued?.status !== "active")
        return { kind: "rejected", reason: "device_inactive" };
      if (row.usedAt !== null) return { kind: "rejected", reason: "used" };
      if (now >= row.expiresAt) return { kind: "rejected", reason: "expired" };
      let usedAt: string | null = null;
      if (consume) {
        const changed = this.database
          .prepare(
            `UPDATE notification_action_tokens SET used_at = ?
              WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
          )
          .run(now, input.tokenHash, now).changes;
        if (changed !== 1) return { kind: "rejected", reason: "used" };
        usedAt = now;
      }
      const token: NotificationActionToken = Object.freeze({
        tokenHash: row.tokenHash,
        ownerId: row.ownerId as NotificationActionToken["ownerId"],
        agentId: row.agentId as NotificationActionToken["agentId"],
        deviceId: row.deviceId,
        sourceKey: row.sourceKey,
        action: row.action as NotificationAction,
        ownerPresence: row.ownerPresence === 1,
        approval:
          row.approvalRequestId === null
            ? null
            : Object.freeze({
                requestId: row.approvalRequestId,
                revision: row.approvalRevision as number,
                snapshotHash: row.approvalSnapshotHash as string,
              }),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        usedAt,
      });
      return { kind: "accepted", token };
    });
    return consume ? resolve.immediate() : resolve();
  }

  private setCompanion(input: Input<"setCompanion">) {
    return this.database.transaction(() => {
      const read = this.database.prepare(
        `SELECT id, kind, status, companion_of AS companionOf FROM paired_devices
          WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      );
      const watch = read.get(input.deviceId, input.ownerId, input.agentId) as
        | { id: string; kind: string; status: string; companionOf: string | null }
        | undefined;
      const host = read.get(input.companionOf, input.ownerId, input.agentId) as
        | { id: string; kind: string; status: string }
        | undefined;
      if (!watch || !host || watch.status === "revoked" || host.status !== "active")
        return "not_found" as const;
      if (watch.kind !== "watch" || host.kind !== "iphone") return "not_a_watch" as const;
      if (watch.companionOf === host.id) return "already_linked" as const;
      if (watch.companionOf !== null) return "linked_elsewhere" as const;
      this.database
        .prepare("UPDATE paired_devices SET companion_of = ?, revision = revision + 1 WHERE id = ?")
        .run(host.id, watch.id);
      return "linked" as const;
    })();
  }

  private listActivityRuns(input: Input<"listActivityRuns">): readonly ApplePushActivityRun[] {
    this.time(input.createdAfter);
    this.time(input.createdBefore);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Apple push limit is invalid");
    return this.database
      .prepare(
        `SELECT id AS runId, thread_id AS threadId, status, created_at AS createdAt,
           updated_at AS updatedAt
         FROM runs
         WHERE owner_id = ? AND agent_id = ? AND thread_id IS NOT NULL
           AND status NOT IN ('completed', 'failed', 'cancelled')
           AND created_at > ? AND created_at <= ?
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(
        input.ownerId,
        input.agentId,
        input.createdAfter,
        input.createdBefore,
        input.limit,
      ) as ApplePushActivityRun[];
  }

  private readActivityRuns(input: Input<"readActivityRuns">): readonly ApplePushActivityRun[] {
    if (input.runIds.length > 500)
      this.fail("PORT_INVALID_OPERATION", "Apple push limit is invalid");
    const read = this.database.prepare(
      `SELECT id AS runId, thread_id AS threadId, status, created_at AS createdAt,
         updated_at AS updatedAt
       FROM runs WHERE owner_id = ? AND agent_id = ? AND id = ? AND thread_id IS NOT NULL`,
    );
    return [...new Set(input.runIds)].flatMap((runId) => {
      const run = read.get(input.ownerId, input.agentId, runId) as ApplePushActivityRun | undefined;
      return run ? [run] : [];
    });
  }

  private prune(input: Input<"prune">): number {
    this.time(input.expiredBefore);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Apple push limit is invalid");
    return this.database
      .prepare(
        `DELETE FROM notification_action_tokens WHERE token_hash IN (
          SELECT token_hash FROM notification_action_tokens
          WHERE owner_id = ? AND agent_id = ? AND expires_at < ?
          ORDER BY expires_at LIMIT ?)`,
      )
      .run(input.ownerId, input.agentId, input.expiredBefore, input.limit).changes;
  }
}
