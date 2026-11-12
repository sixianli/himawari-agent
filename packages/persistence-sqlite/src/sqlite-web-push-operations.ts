import { createHash } from "node:crypto";
import type {
  WebPushAttempt,
  WebPushAttemptStatus,
  WebPushDue,
  WebPushFeedback,
  WebPushFinishedRun,
  WebPushKind,
  WebPushOutboxItem,
  WebPushScope,
  WebPushStorePort,
  WebPushSubscription,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import { recordDecisionSignal } from "./decision-signals.ts";
import { insertLedgerRow } from "./sqlite-decision-ledger-operations.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof WebPushStorePort> = Parameters<WebPushStorePort[TName]>[0];

const subscriptionColumns = `s.id, s.owner_id AS ownerId, s.agent_id AS agentId, s.endpoint,
  s.p256dh, s.auth, s.locale, s.device_label AS deviceLabel, s.state,
  s.failure_code AS failureCode, s.created_at AS createdAt, s.updated_at AS updatedAt,
  s.last_delivered_at AS lastDeliveredAt`;

const WEB_PUSH_LOCALES: readonly WebPushSubscription["locale"][] = ["zh-CN", "en", "ja"];

const WEB_PUSH_KINDS: readonly WebPushKind[] = ["reminder", "approval", "run"];

type KindsRow = { reminder: number; approval: number; run: number };

const ATTEMPT_STATUSES: readonly WebPushAttemptStatus[] = [
  "pending",
  "sent",
  "suppressed",
  "expired",
  "gone",
  "failed",
];

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteWebPushOperations {
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
      case "webPush.saveSubscription":
        return this.saveSubscription(payload as Input<"saveSubscription">);
      case "webPush.removeSubscription":
        return this.removeSubscription(payload as Input<"removeSubscription">);
      case "webPush.listSubscriptions":
        return this.listSubscriptions(payload as WebPushScope);
      case "webPush.readKinds":
        return this.readKinds(payload as WebPushScope);
      case "webPush.setKind":
        return this.setKind(payload as Input<"setKind">);
      case "webPush.writeKinds":
        return this.writeKinds(payload as Input<"writeKinds">);
      case "webPush.markSubscription":
        return this.markSubscription(payload as Input<"markSubscription">);
      case "webPush.readCursor":
        return this.readCursor(payload as Input<"readCursor">);
      case "webPush.enqueue":
        return this.enqueue(payload as Input<"enqueue">);
      case "webPush.listDue":
        return this.listDue(payload as Input<"listDue">);
      case "webPush.deferItem":
        return this.deferItem(payload as Input<"deferItem">);
      case "webPush.recordAttempt":
        return this.recordAttempt(payload as Input<"recordAttempt">);
      case "webPush.recordReactions":
        return this.recordReactions(payload as Input<"recordReactions">);
      case "webPush.listFeedback":
        return this.listFeedback(payload as Input<"listFeedback">);
      case "webPush.listFinishedRuns":
        return this.listFinishedRuns(payload as Input<"listFinishedRuns">);
      case "webPush.prune":
        return this.prune(payload as Input<"prune">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown web push operation ${operation}`);
    }
  }

  private time(value: string) {
    if (!valid(value)) this.fail("PORT_INVALID_OPERATION", "Web push time is invalid");
  }

  private limit(value: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 500)
      this.fail("PORT_INVALID_OPERATION", "Web push limit is invalid");
  }

  private readSubscription(scope: WebPushScope, id: string): WebPushSubscription | undefined {
    const row = this.database
      .prepare(
        `SELECT ${subscriptionColumns} FROM web_push_subscriptions s
         WHERE s.owner_id = ? AND s.agent_id = ? AND s.id = ?`,
      )
      .get(scope.ownerId, scope.agentId, id) as WebPushSubscription | undefined;
    return row;
  }

  private saveSubscription(input: Input<"saveSubscription">): WebPushSubscription {
    this.assertDiskHeadroom();
    this.time(input.now);
    if (
      !input.endpoint.startsWith("https://") ||
      input.endpoint.length > 2048 ||
      !WEB_PUSH_LOCALES.includes(input.locale) ||
      input.deviceLabel.length < 1 ||
      input.deviceLabel.length > 64
    )
      this.fail("PORT_INVALID_OPERATION", "Web push subscription is invalid");
    this.database
      .prepare(
        `INSERT INTO web_push_subscriptions (
          id, owner_id, agent_id, endpoint, p256dh, auth, locale, device_label,
          notify_reminder, notify_approval, notify_run, state, failure_code, created_at,
          updated_at, last_delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'active', NULL, ?, ?, NULL)
        ON CONFLICT (owner_id, agent_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh,
          auth = excluded.auth, locale = excluded.locale, device_label = excluded.device_label,
          state = 'active', failure_code = NULL, updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.ownerId,
        input.agentId,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.locale,
        input.deviceLabel,
        input.now,
        input.now,
      );
    return this.database
      .prepare(
        `SELECT ${subscriptionColumns} FROM web_push_subscriptions s
         WHERE s.owner_id = ? AND s.agent_id = ? AND s.endpoint = ?`,
      )
      .get(input.ownerId, input.agentId, input.endpoint) as WebPushSubscription;
  }

  private readKinds(scope: WebPushScope): readonly WebPushKind[] {
    const row = this.database
      .prepare(
        `SELECT notify_reminder AS reminder, notify_approval AS approval, notify_run AS run
         FROM web_push_account_kinds WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(scope.ownerId, scope.agentId) as KindsRow | undefined;
    if (!row) return WEB_PUSH_KINDS;
    const enabled = [row.reminder, row.approval, row.run];
    return WEB_PUSH_KINDS.filter((_, index) => enabled[index] === 1);
  }

  private setKind(input: Input<"setKind">): readonly WebPushKind[] {
    this.assertDiskHeadroom();
    this.time(input.now);
    const index = WEB_PUSH_KINDS.indexOf(input.kind);
    if (index < 0 || typeof input.enabled !== "boolean")
      this.fail("PORT_INVALID_OPERATION", "Web push kind is invalid");
    const column = ["notify_reminder", "notify_approval", "notify_run"][index] as string;
    const flags = [1, 1, 1];
    flags[index] = input.enabled ? 1 : 0;
    this.database
      .prepare(
        `INSERT INTO web_push_account_kinds (
          owner_id, agent_id, notify_reminder, notify_approval, notify_run, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner_id, agent_id) DO UPDATE SET ${column} = excluded.${column},
          updated_at = excluded.updated_at`,
      )
      .run(input.ownerId, input.agentId, ...flags, input.now);
    return this.readKinds(input);
  }

  private writeKinds(input: Input<"writeKinds">): readonly WebPushKind[] {
    this.assertDiskHeadroom();
    this.time(input.now);
    if (input.kinds.some((kind) => !WEB_PUSH_KINDS.includes(kind)))
      this.fail("PORT_INVALID_OPERATION", "Web push kinds are invalid");
    const [reminder, approval, run] = WEB_PUSH_KINDS.map((kind) =>
      input.kinds.includes(kind) ? 1 : 0,
    );
    this.database
      .prepare(
        `INSERT INTO web_push_account_kinds (
          owner_id, agent_id, notify_reminder, notify_approval, notify_run, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner_id, agent_id) DO UPDATE SET notify_reminder = excluded.notify_reminder,
          notify_approval = excluded.notify_approval, notify_run = excluded.notify_run,
          updated_at = excluded.updated_at`,
      )
      .run(input.ownerId, input.agentId, reminder, approval, run, input.now);
    return this.readKinds(input);
  }

  private removeSubscription(input: Input<"removeSubscription">): boolean {
    return (
      this.database
        .prepare(
          "DELETE FROM web_push_subscriptions WHERE owner_id = ? AND agent_id = ? AND id = ?",
        )
        .run(input.ownerId, input.agentId, input.subscriptionId).changes > 0
    );
  }

  private listSubscriptions(scope: WebPushScope): readonly WebPushSubscription[] {
    return this.database
      .prepare(
        `SELECT ${subscriptionColumns} FROM web_push_subscriptions s
         WHERE s.owner_id = ? AND s.agent_id = ? ORDER BY s.created_at, s.id`,
      )
      .all(scope.ownerId, scope.agentId)
      .map((row) => row as WebPushSubscription);
  }

  private markSubscription(input: Input<"markSubscription">): void {
    this.time(input.now);
    if (input.deliveredAt !== null) this.time(input.deliveredAt);
    if (!["active", "paused"].includes(input.state))
      this.fail("PORT_INVALID_OPERATION", "Web push subscription state is invalid");
    if (!this.readSubscription(input, input.subscriptionId)) return;
    this.database
      .prepare(
        `UPDATE web_push_subscriptions SET state = ?, failure_code = ?, updated_at = ?,
          last_delivered_at = COALESCE(?, last_delivered_at)
         WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .run(
        input.state,
        input.failureCode,
        input.now,
        input.deliveredAt,
        input.ownerId,
        input.agentId,
        input.subscriptionId,
      );
  }

  private readCursor(input: Input<"readCursor">): string | null {
    const row = this.database
      .prepare(
        "SELECT cursor FROM web_push_cursors WHERE owner_id = ? AND agent_id = ? AND source = ?",
      )
      .get(input.ownerId, input.agentId, input.source) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  private enqueue(input: Input<"enqueue">): number {
    this.assertDiskHeadroom();
    this.time(input.now);
    for (const item of input.items) this.assertItem(input, item);
    const insert = this.database.prepare(
      `INSERT INTO web_push_outbox (
        owner_id, agent_id, source_key, kind, source_ref, thread_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner_id, agent_id, source_key) DO NOTHING`,
    );
    return this.database.transaction(() => {
      let added = 0;
      for (const item of input.items)
        added += insert.run(
          input.ownerId,
          input.agentId,
          item.sourceKey,
          item.kind,
          item.sourceRef,
          item.threadId,
          item.createdAt,
          item.expiresAt,
        ).changes;
      if (input.cursor)
        this.database
          .prepare(
            `INSERT INTO web_push_cursors (owner_id, agent_id, source, cursor, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, agent_id, source) DO UPDATE SET cursor = excluded.cursor,
               updated_at = excluded.updated_at`,
          )
          .run(input.ownerId, input.agentId, input.cursor.source, input.cursor.value, input.now);
      return added;
    })();
  }

  private assertItem(scope: WebPushScope, item: WebPushOutboxItem) {
    if (
      item.ownerId !== scope.ownerId ||
      item.agentId !== scope.agentId ||
      !["reminder", "approval", "run"].includes(item.kind) ||
      item.sourceKey.length < 1 ||
      item.sourceKey.length > 256 ||
      item.sourceRef.length < 1 ||
      item.sourceRef.length > 256 ||
      !valid(item.createdAt) ||
      !valid(item.expiresAt)
    )
      this.fail("PORT_INVALID_OPERATION", "Web push item is invalid");
  }

  private listDue(input: Input<"listDue">): readonly WebPushDue[] {
    this.time(input.now);
    this.limit(input.limit);
    const rows = this.database
      .prepare(
        `SELECT o.source_key AS sourceKey, o.kind, o.source_ref AS sourceRef,
           o.thread_id AS threadId, o.created_at AS itemCreatedAt, o.expires_at AS expiresAt,
           o.defer_until AS deferUntil,
           ${subscriptionColumns},
           a.status AS attemptStatus, a.attempts AS attemptCount,
           a.next_attempt_at AS nextAttemptAt, a.last_code AS lastCode,
           a.updated_at AS attemptUpdatedAt
         FROM web_push_outbox o
         JOIN web_push_subscriptions s ON s.owner_id = o.owner_id AND s.agent_id = o.agent_id
           AND s.state = 'active'
         LEFT JOIN web_push_attempts a ON a.owner_id = o.owner_id AND a.agent_id = o.agent_id
           AND a.source_key = o.source_key AND a.subscription_id = s.id
         WHERE o.owner_id = ? AND o.agent_id = ?
           AND (o.defer_until IS NULL OR o.defer_until <= ?)
           AND (a.status IS NULL OR (a.status = 'pending'
             AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?)))
         ORDER BY o.created_at, o.source_key, s.created_at, s.id
         LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.now, input.now, input.limit) as Array<
      WebPushSubscription & {
        sourceKey: string;
        kind: WebPushOutboxItem["kind"];
        sourceRef: string;
        threadId: string | null;
        itemCreatedAt: string;
        expiresAt: string;
        deferUntil: string | null;
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
      },
      subscription: {
        id: row.id,
        ownerId: row.ownerId,
        agentId: row.agentId,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        locale: row.locale,
        deviceLabel: row.deviceLabel,
        state: row.state,
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

  private deferItem(input: Input<"deferItem">): boolean {
    this.time(input.now);
    this.time(input.deferUntil);
    this.time(input.expiresAt);
    if (
      input.ruleRefs.length < 1 ||
      input.ruleRefs.length > 16 ||
      input.ruleRefs.some((ref) => ref.length < 1 || ref.length > 256) ||
      new Set(input.ruleRefs).size !== input.ruleRefs.length
    )
      this.fail("PORT_INVALID_OPERATION", "Web push deferral rule references are invalid");
    const refs = [...input.ruleRefs].sort();
    const digest = createHash("sha256")
      .update(JSON.stringify([input.ownerId, input.agentId, input.sourceKey, input.deferUntil]))
      .digest("hex");
    return this.database
      .transaction(() => {
        const current = this.database.prepare(
          `SELECT 1 FROM rule_book_rules
           WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ? AND status IN ('active', 'needs_review')`,
        );
        const stale = refs.some((ref) => {
          const at = ref.lastIndexOf("@");
          return (
            at < 1 ||
            current.get(
              input.ownerId,
              input.agentId,
              ref.slice(0, at),
              Number(ref.slice(at + 1)),
            ) === undefined
          );
        });
        if (stale) return true;
        const stored =
          this.database
            .prepare(
              `UPDATE web_push_outbox SET defer_until = ?, defer_rule_refs = ?, expires_at = ?
             WHERE owner_id = ? AND agent_id = ? AND source_key = ?`,
            )
            .run(
              input.deferUntil,
              JSON.stringify(refs),
              input.expiresAt,
              input.ownerId,
              input.agentId,
              input.sourceKey,
            ).changes > 0;
        if (!stored) return false;
        insertLedgerRow(this.database, {
          id: `web-push-${digest}`,
          ownerId: input.ownerId,
          agentId: input.agentId,
          kind: "web_push",
          decidedAt: input.now,
          outcome: "deferred",
          reasonCode: "push_quiet_hours",
          subjectRef: input.sourceKey,
          inputs: { memoryIds: [], ruleIds: refs },
          reasonRef: null,
          contentRef: null,
          costMicros: 0,
          durationMs: 0,
        });
        return true;
      })
      .immediate();
  }

  private recordAttempt(input: Input<"recordAttempt">): boolean {
    this.time(input.now);
    if (input.nextAttemptAt !== null) this.time(input.nextAttemptAt);
    if (
      !ATTEMPT_STATUSES.includes(input.status) ||
      !Number.isSafeInteger(input.attempts) ||
      input.attempts < 0 ||
      input.attempts > 100 ||
      input.tag.length < 1 ||
      input.tag.length > 64
    )
      this.fail("PORT_INVALID_OPERATION", "Web push attempt is invalid");
    return this.database.transaction(() => {
      const recorded =
        this.database
          .prepare(
            `INSERT INTO web_push_attempts (
              owner_id, agent_id, source_key, subscription_id, status, attempts, next_attempt_at,
              last_code, updated_at
            ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM web_push_outbox
                WHERE owner_id = ? AND agent_id = ? AND source_key = ?)
            ON CONFLICT (owner_id, agent_id, source_key, subscription_id) DO UPDATE SET
              status = excluded.status, attempts = excluded.attempts,
              next_attempt_at = excluded.next_attempt_at, last_code = excluded.last_code,
              updated_at = excluded.updated_at
            WHERE web_push_attempts.status = 'pending'`,
          )
          .run(
            input.ownerId,
            input.agentId,
            input.sourceKey,
            input.subscriptionId,
            input.status,
            input.attempts,
            input.nextAttemptAt,
            input.lastCode,
            input.now,
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
            ) SELECT owner_id, agent_id, source_key, ?, kind, source_ref, thread_id, 'web_push',
                ?, 1, NULL, NULL, ?
              FROM web_push_outbox WHERE owner_id = ? AND agent_id = ? AND source_key = ?
            ON CONFLICT (owner_id, agent_id, source_key) DO UPDATE SET
              devices = min(100, web_push_feedback.devices + 1), updated_at = excluded.updated_at`,
          )
          .run(input.tag, input.now, input.now, input.ownerId, input.agentId, input.sourceKey);
      return recorded;
    })();
  }

  private recordReactions(input: Input<"recordReactions">): number {
    this.assertDiskHeadroom();
    this.time(input.now);
    if (input.reactions.length > 50)
      this.fail("PORT_INVALID_OPERATION", "Web push reactions are invalid");
    for (const event of input.reactions) {
      this.time(event.occurredAt);
      if (
        !["opened", "dismissed"].includes(event.reaction) ||
        event.tag.length < 1 ||
        event.tag.length > 64
      )
        this.fail("PORT_INVALID_OPERATION", "Web push reaction is invalid");
    }
    const statements = {
      opened: this.database.prepare(
        `UPDATE web_push_feedback SET opened_at = max(first_sent_at, min(?, ?)), updated_at = ?
         WHERE owner_id = ? AND agent_id = ? AND tag = ? AND opened_at IS NULL`,
      ),
      dismissed: this.database.prepare(
        `UPDATE web_push_feedback SET dismissed_at = max(first_sent_at, min(?, ?)), updated_at = ?
         WHERE owner_id = ? AND agent_id = ? AND tag = ? AND dismissed_at IS NULL`,
      ),
    };
    const openedFeedback = this.database.prepare(
      `SELECT feedback.source_key AS sourceKey, feedback.opened_at AS openedAt,
        feedback.first_sent_at AS firstSentAt, decision.id AS decisionId
       FROM web_push_feedback feedback
       JOIN decision_ledger decision
         ON decision.owner_id = feedback.owner_id AND decision.agent_id = feedback.agent_id
        AND decision.push_source_key = feedback.source_key AND decision.kind = 'proactive'
       WHERE feedback.owner_id = ? AND feedback.agent_id = ? AND feedback.tag = ?`,
    );
    return this.database.transaction(() => {
      let recorded = 0;
      for (const event of input.reactions) {
        const changes = statements[event.reaction].run(
          event.occurredAt,
          input.now,
          input.now,
          input.ownerId,
          input.agentId,
          event.tag,
        ).changes;
        recorded += changes;
        if (event.reaction !== "opened" || changes === 0) continue;
        const opened = openedFeedback.all(input.ownerId, input.agentId, event.tag) as {
          sourceKey: string;
          openedAt: string;
          firstSentAt: string;
          decisionId: string;
        }[];
        for (const row of opened)
          recordDecisionSignal(this.database, {
            ownerId: input.ownerId,
            agentId: input.agentId,
            decisionId: row.decisionId,
            signal: "opened",
            occurredAt: row.openedAt,
            delayMs: Date.parse(row.openedAt) - Date.parse(row.firstSentAt),
            detail: {},
            sourceRef: row.sourceKey,
            recordedAt: input.now,
          });
      }
      return recorded;
    })();
  }

  private listFeedback(input: Input<"listFeedback">): readonly WebPushFeedback[] {
    this.time(input.sentFrom);
    this.limit(input.limit);
    return this.database
      .prepare(
        `SELECT source_key AS sourceKey, tag, kind, source_ref AS sourceRef,
           thread_id AS threadId, channel, first_sent_at AS firstSentAt, devices,
           opened_at AS openedAt, dismissed_at AS dismissedAt
         FROM web_push_feedback
         WHERE owner_id = ? AND agent_id = ? AND first_sent_at >= ?
         ORDER BY first_sent_at, source_key LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.sentFrom, input.limit) as WebPushFeedback[];
  }

  private listFinishedRuns(input: Input<"listFinishedRuns">): readonly WebPushFinishedRun[] {
    this.limit(input.limit);
    const separator = input.afterCursor.indexOf("|");
    const after = separator < 0 ? input.afterCursor : input.afterCursor.slice(0, separator);
    const afterId = separator < 0 ? "" : input.afterCursor.slice(separator + 1);
    this.time(after);
    return (
      this.database
        .prepare(
          `SELECT id AS runId, thread_id AS threadId, status, updated_at AS finishedAt,
             EXISTS (SELECT 1 FROM run_coordination_checkpoints checkpoint
               WHERE checkpoint.owner_id = runs.owner_id AND checkpoint.agent_id = runs.agent_id
                 AND checkpoint.run_id = runs.id
                 AND checkpoint.diagnostic_code = 'RUNTIME_TOOL_RESULT_UNKNOWN') AS resultUnconfirmed
           FROM runs
           WHERE owner_id = ? AND agent_id = ? AND thread_id IS NOT NULL
             AND status IN ('completed', 'failed')
             AND NOT EXISTS (SELECT 1 FROM run_background_holds hold
               WHERE hold.owner_id = runs.owner_id AND hold.agent_id = runs.agent_id
                 AND hold.run_id = runs.id)
             AND (updated_at > ? OR (updated_at = ? AND id > ?))
           ORDER BY updated_at, id LIMIT ?`,
        )
        .all(input.ownerId, input.agentId, after, after, afterId, input.limit) as Array<
        Omit<WebPushFinishedRun, "cursor" | "resultUnconfirmed"> & { resultUnconfirmed: number }
      >
    ).map((run) => ({
      ...run,
      resultUnconfirmed: Boolean(run.resultUnconfirmed),
      cursor: `${run.finishedAt}|${run.runId}`,
    }));
  }

  private prune(input: Input<"prune">): number {
    this.time(input.expiredBefore);
    this.limit(input.limit);
    return this.database
      .prepare(
        `DELETE FROM web_push_outbox WHERE rowid IN (
          SELECT rowid FROM web_push_outbox
          WHERE owner_id = ? AND agent_id = ? AND expires_at < ?
          ORDER BY expires_at LIMIT ?)`,
      )
      .run(input.ownerId, input.agentId, input.expiredBefore, input.limit).changes;
  }
}
