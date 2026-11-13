import type {
  DeviceActionRecord,
  DeviceActionRecordState,
  DeviceActionReopening,
  DeviceActionReportResult,
  DeviceActionSettlement,
  DeviceActionStorePort,
  DevicePolicy,
  DevicePolicyWriteResult,
  DeviceActionInsertResult,
  PairedDeviceScope,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof DeviceActionStorePort> = Parameters<DeviceActionStorePort[TName]>[0];

const STATES: readonly DeviceActionRecordState[] = [
  "waiting_owner",
  "queued",
  "delivered",
  "succeeded",
  "failed",
  "result_unknown",
  "expired",
  "rejected",
];
const OPEN_STATES = "'waiting_owner', 'queued', 'delivered', 'result_unknown'";
const ACTION_ID = /^dact_[0-9a-f]{32}$/u;
const ACTION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

const columns = `id, owner_id AS ownerId, agent_id AS agentId, revision, device_id AS deviceId, action,
  schema_version AS schemaVersion, arguments_ref AS argumentsRef, fingerprint,
  action_kind AS actionKind, risk, owner_presence AS ownerPresence, approval_id AS approvalId,
  data_classification AS dataClassification, state, reason_code AS reasonCode,
  result_ref AS resultRef, run_id AS runId, tool_call_id AS toolCallId, created_at AS createdAt,
  expires_at AS expiresAt, delivered_at AS deliveredAt, finished_at AS finishedAt,
  updated_at AS updatedAt`;

type Row = Omit<DeviceActionRecord, "ownerPresence"> & { readonly ownerPresence: number };

function toRecord(row: Row): DeviceActionRecord {
  return Object.freeze({ ...row, ownerPresence: row.ownerPresence === 1 });
}

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteDeviceActionOperations {
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
      case "deviceActions.insert":
        return this.insert(payload as Input<"insert">);
      case "deviceActions.read":
        return this.read(payload as Input<"read">);
      case "deviceActions.readInvocation":
        return this.readInvocation(payload as Input<"readInvocation">);
      case "deviceActions.list":
        return this.list(payload as Input<"list">);
      case "deviceActions.settleDue":
        return this.settleDue(payload as Input<"settleDue">);
      case "deviceActions.claim":
        return this.claim(payload as Input<"claim">);
      case "deviceActions.report":
        return this.report(payload as Input<"report">);
      case "deviceActions.forget":
        return this.forget(payload as Input<"forget">);
      case "deviceActions.decide":
        return this.decide(payload as Input<"decide">);
      case "deviceActions.setSupportedActions":
        return this.setSupportedActions(payload as Input<"setSupportedActions">);
      case "deviceActions.readPolicy":
        return this.readPolicy(payload as Input<"readPolicy">);
      case "deviceActions.writePolicy":
        return this.writePolicy(payload as Input<"writePolicy">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown device action operation ${operation}`);
    }
  }

  private time(value: string): string {
    if (!validTime(value)) this.fail("PORT_INVALID_OPERATION", "Device action time is invalid");
    return value;
  }

  private names(values: readonly string[]): string {
    if (
      !Array.isArray(values) ||
      values.length > 500 ||
      values.some((name) => typeof name !== "string" || name.length > 64 || !ACTION_NAME.test(name))
    )
      this.fail("PORT_INVALID_OPERATION", "Device action names are invalid");
    return JSON.stringify([...new Set(values)].sort());
  }

  private one(scope: PairedDeviceScope, id: string): DeviceActionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM device_actions WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(id, scope.ownerId, scope.agentId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  private insert(input: Input<"insert">): DeviceActionInsertResult {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const expiresAt = this.time(input.expiresAt);
    if (!ACTION_ID.test(input.id) || expiresAt <= now)
      this.fail("PORT_INVALID_OPERATION", "Device action is invalid");
    return this.database.transaction((): DeviceActionInsertResult => {
      const replayed = this.database
        .prepare(
          `SELECT ${columns} FROM device_actions
            WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND tool_call_id = ?`,
        )
        .get(input.ownerId, input.agentId, input.runId, input.toolCallId) as Row | undefined;
      if (replayed) return { kind: "replayed", record: toRecord(replayed) };
      if (input.state !== "rejected") {
        const open = this.database
          .prepare(
            `SELECT ${columns} FROM device_actions
              WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND fingerprint = ?
                AND state IN (${OPEN_STATES})
              ORDER BY created_at, id LIMIT 1`,
          )
          .get(input.ownerId, input.agentId, input.deviceId, input.fingerprint) as Row | undefined;
        if (open) return { kind: "open_duplicate", record: toRecord(open) };
      }
      const active = this.database
        .prepare(
          `SELECT 1 FROM paired_devices
            WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'active'`,
        )
        .get(input.deviceId, input.ownerId, input.agentId);
      if (!active) this.fail("PORT_INVALID_OPERATION", "Device is not active");
      const finished = input.state === "rejected" ? now : null;
      this.database
        .prepare(
          `INSERT INTO device_actions
             (id, owner_id, agent_id, revision, device_id, action, schema_version, arguments_ref,
              fingerprint, action_kind, risk, owner_presence, approval_id, data_classification,
              state, reason_code, run_id, tool_call_id, created_at, expires_at, finished_at,
              updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.agentId,
          input.deviceId,
          input.action,
          input.schemaVersion,
          input.argumentsRef,
          input.fingerprint,
          input.actionKind,
          input.risk,
          input.ownerPresence ? 1 : 0,
          input.approvalId,
          input.dataClassification,
          input.state,
          input.reasonCode,
          input.runId,
          input.toolCallId,
          now,
          expiresAt,
          finished,
          now,
        );
      return { kind: "created", record: this.one(input, input.id) as DeviceActionRecord };
    })();
  }

  private read(input: Input<"read">): DeviceActionRecord | undefined {
    return this.one(input, input.id);
  }

  private readInvocation(input: Input<"readInvocation">): DeviceActionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM device_actions
          WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND tool_call_id = ?`,
      )
      .get(input.ownerId, input.agentId, input.runId, input.toolCallId) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  private list(input: Input<"list">): readonly DeviceActionRecord[] {
    if (
      input.states.some((state) => !STATES.includes(state)) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 500 ||
      (input.finishedSince !== undefined && !validTime(input.finishedSince))
    )
      this.fail("PORT_INVALID_OPERATION", "Device action listing is invalid");
    if (input.states.length === 0) return [];
    const marks = input.states.map(() => "?").join(", ");
    return (
      this.database
        .prepare(
          `SELECT ${columns},
              (SELECT thread_id FROM runs WHERE runs.id = device_actions.run_id) AS threadId
            FROM device_actions
            WHERE owner_id = ? AND agent_id = ? AND (? IS NULL OR device_id = ?)
              AND state IN (${marks})
              AND (? IS NULL OR state IN (${OPEN_STATES}) OR finished_at >= ?)
            ORDER BY created_at, id LIMIT ?`,
        )
        .all(
          input.ownerId,
          input.agentId,
          input.deviceId,
          input.deviceId,
          ...input.states,
          input.finishedSince ?? null,
          input.finishedSince ?? null,
          input.limit,
        ) as Row[]
    ).map(toRecord);
  }

  private settleDue(input: Input<"settleDue">): DeviceActionSettlement {
    const now = this.time(input.now);
    return this.database.transaction((): DeviceActionSettlement => {
      const due = this.database
        .prepare(
          `SELECT id, state FROM device_actions
            WHERE owner_id = ? AND agent_id = ? AND expires_at <= ?
              AND state IN ('waiting_owner', 'queued', 'delivered')
            ORDER BY created_at, id`,
        )
        .all(input.ownerId, input.agentId, now) as { id: string; state: string }[];
      if (due.length === 0) return { expired: [], unknown: [] };
      this.assertDiskHeadroom();
      const expire = this.database.prepare(
        `UPDATE device_actions
            SET state = 'expired', reason_code = 'not_delivered_in_time', finished_at = ?,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND state IN ('waiting_owner', 'queued')`,
      );
      const lose = this.database.prepare(
        `UPDATE device_actions
            SET state = 'result_unknown', reason_code = 'report_missing', updated_at = ?,
                revision = revision + 1
          WHERE id = ? AND state = 'delivered'`,
      );
      const expired: DeviceActionRecord[] = [];
      const unknown: DeviceActionRecord[] = [];
      for (const { id, state } of due) {
        if (state === "delivered") {
          if (lose.run(now, id).changes === 1)
            unknown.push(this.one(input, id) as DeviceActionRecord);
        } else if (expire.run(now, now, id).changes === 1)
          expired.push(this.one(input, id) as DeviceActionRecord);
      }
      return { expired, unknown };
    })();
  }

  private claim(input: Input<"claim">): readonly DeviceActionRecord[] {
    const now = this.time(input.now);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Device action claim is invalid");
    return this.database.transaction(() => {
      const active = this.database
        .prepare(
          `SELECT 1 FROM paired_devices
            WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'active'`,
        )
        .get(input.deviceId, input.ownerId, input.agentId);
      if (!active) return [];
      const scope = [input.ownerId, input.agentId, input.deviceId] as const;
      const queued = this.database
        .prepare(
          `SELECT id FROM device_actions
            WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND state = 'queued'
              AND expires_at > ?
            ORDER BY created_at, id LIMIT ?`,
        )
        .all(...scope, now, input.limit) as { id: string }[];
      const unknown =
        queued.length >= input.limit
          ? []
          : (this.database
              .prepare(
                `SELECT id FROM device_actions
                  WHERE owner_id = ? AND agent_id = ? AND device_id = ?
                    AND state = 'result_unknown'
                  ORDER BY updated_at, created_at, id LIMIT ?`,
              )
              .all(...scope, input.limit - queued.length) as { id: string }[]);
      if (queued.length > 0) this.assertDiskHeadroom();
      const deliver = this.database.prepare(
        `UPDATE device_actions
            SET state = 'delivered', delivered_at = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND state = 'queued'`,
      );
      for (const { id } of queued) deliver.run(now, now, id);
      return [...queued, ...unknown].map(({ id }) => this.one(input, id) as DeviceActionRecord);
    })();
  }

  private report(input: Input<"report">): DeviceActionReportResult {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    return this.database.transaction((): DeviceActionReportResult => {
      const record = this.one(input, input.id);
      if (!record) return { kind: "not_found" };
      if (record.deviceId !== input.deviceId) return { kind: "wrong_device" };
      if (record.state === "succeeded" || record.state === "failed")
        return { kind: "replayed", record };
      if (record.state === "result_unknown") {
        if (input.outcome === "result_unknown") {
          this.database
            .prepare(
              `UPDATE device_actions SET updated_at = ?, revision = revision + 1
                WHERE id = ? AND state = 'result_unknown'`,
            )
            .run(now, input.id);
          return { kind: "replayed", record: this.one(input, input.id) as DeviceActionRecord };
        }
        if (!input.readBack) return { kind: "verify_only", record };
      } else if (record.state !== "delivered") return { kind: "not_delivered", record };
      if (input.outcome === "result_unknown")
        this.database
          .prepare(
            `UPDATE device_actions
                SET state = 'result_unknown', reason_code = ?, result_ref = COALESCE(?, result_ref),
                    updated_at = ?, revision = revision + 1
              WHERE id = ?`,
          )
          .run(input.reasonCode ?? "device_reported", input.resultRef, now, input.id);
      else
        this.database
          .prepare(
            `UPDATE device_actions
                SET state = ?, reason_code = ?, result_ref = ?, finished_at = ?, updated_at = ?,
                    revision = revision + 1
              WHERE id = ?`,
          )
          .run(
            input.outcome,
            input.outcome === "failed" ? (input.reasonCode ?? "device_reported") : null,
            input.resultRef,
            now,
            now,
            input.id,
          );
      return { kind: "recorded", record: this.one(input, input.id) as DeviceActionRecord };
    })();
  }

  private forget(input: Input<"forget">): DeviceActionReopening {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Device action reopen is invalid");
    return this.database.transaction((): DeviceActionReopening => {
      const scope = [input.ownerId, input.agentId, input.deviceId] as const;
      const delivered = this.database
        .prepare(
          `SELECT id FROM device_actions
            WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND state = 'delivered'
            ORDER BY created_at, id LIMIT ?`,
        )
        .all(...scope, input.limit) as { id: string }[];
      const lose = this.database.prepare(
        `UPDATE device_actions
            SET state = 'result_unknown', reason_code = 'device_lost_record', updated_at = ?,
                revision = revision + 1
          WHERE id = ? AND state = 'delivered'`,
      );
      const forgotten: DeviceActionRecord[] = [];
      for (const { id } of delivered)
        if (lose.run(now, id).changes === 1)
          forgotten.push(this.one(input, id) as DeviceActionRecord);
      const older =
        forgotten.length >= input.limit
          ? []
          : (
              this.database
                .prepare(
                  `SELECT ${columns} FROM device_actions
                    WHERE owner_id = ? AND agent_id = ? AND device_id = ?
                      AND state = 'result_unknown'
                      AND NOT (reason_code = 'device_lost_record' AND updated_at = ?)
                    ORDER BY updated_at, created_at, id LIMIT ?`,
                )
                .all(...scope, now, input.limit - forgotten.length) as Row[]
            ).map(toRecord);
      const pending = [...forgotten, ...older];
      return { forgotten, pending };
    })();
  }

  private decide(input: Input<"decide">): DeviceActionRecord | undefined {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    return this.database.transaction(() => {
      const record = this.one(input, input.id);
      if (!record || record.state !== "waiting_owner") return record;
      const reason = !input.approved
        ? "owner_denied"
        : record.ownerPresence && !input.ownerPresent
          ? "owner_presence_unproven"
          : record.expiresAt <= now
            ? "not_delivered_in_time"
            : null;
      if (reason === null)
        this.database
          .prepare(
            `UPDATE device_actions SET state = 'queued', updated_at = ?, revision = revision + 1
              WHERE id = ? AND state = 'waiting_owner'`,
          )
          .run(now, input.id);
      else
        this.database
          .prepare(
            `UPDATE device_actions
                SET state = ?, reason_code = ?, finished_at = ?, updated_at = ?,
                    revision = revision + 1
              WHERE id = ? AND state = 'waiting_owner'`,
          )
          .run(
            reason === "not_delivered_in_time" ? "expired" : "rejected",
            reason,
            now,
            now,
            input.id,
          );
      return this.one(input, input.id);
    })();
  }

  private setSupportedActions(input: Input<"setSupportedActions">): void {
    this.assertDiskHeadroom();
    const names = this.names(input.actions);
    this.database
      .prepare(
        `UPDATE paired_devices SET supported_actions = ?, revision = revision + 1
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'active'
            AND supported_actions <> ?`,
      )
      .run(names, input.deviceId, input.ownerId, input.agentId, names);
  }

  private readPolicy(input: Input<"readPolicy">): DevicePolicy {
    const row = this.database
      .prepare(
        `SELECT revision, blocked_actions AS blockedActions, updated_at AS updatedAt
           FROM device_policies WHERE device_id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(input.deviceId, input.ownerId, input.agentId) as
      | { revision: number; blockedActions: string; updatedAt: string }
      | undefined;
    return Object.freeze({
      ownerId: input.ownerId,
      agentId: input.agentId,
      deviceId: input.deviceId,
      revision: row?.revision ?? 0,
      blockedActions: Object.freeze(row ? (JSON.parse(row.blockedActions) as string[]) : []),
      updatedAt: row?.updatedAt ?? null,
    });
  }

  private writePolicy(input: Input<"writePolicy">): DevicePolicyWriteResult {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const names = this.names(input.blockedActions);
    return this.database.transaction((): DevicePolicyWriteResult => {
      const current = this.readPolicy(input);
      if (current.revision !== input.expectedRevision)
        return { kind: "revision_conflict", policy: current };
      const known = this.database
        .prepare("SELECT 1 FROM paired_devices WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(input.deviceId, input.ownerId, input.agentId);
      if (!known) this.fail("PORT_NOT_FOUND", "Device does not exist");
      this.database
        .prepare(
          `INSERT INTO device_policies
             (device_id, owner_id, agent_id, revision, blocked_actions, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT (device_id) DO UPDATE SET
             revision = device_policies.revision + 1, blocked_actions = excluded.blocked_actions,
             updated_at = excluded.updated_at`,
        )
        .run(input.deviceId, input.ownerId, input.agentId, names, now);
      const blocked = JSON.parse(names) as string[];
      const rejected: DeviceActionRecord[] = [];
      if (blocked.length > 0) {
        const marks = blocked.map(() => "?").join(", ");
        const open = this.database
          .prepare(
            `SELECT id FROM device_actions
              WHERE owner_id = ? AND agent_id = ? AND device_id = ?
                AND state IN ('waiting_owner', 'queued') AND action IN (${marks})
              ORDER BY created_at, id`,
          )
          .all(input.ownerId, input.agentId, input.deviceId, ...blocked) as { id: string }[];
        const reject = this.database.prepare(
          `UPDATE device_actions
              SET state = 'rejected', reason_code = 'device_policy', finished_at = ?,
                  updated_at = ?, revision = revision + 1
            WHERE id = ? AND state IN ('waiting_owner', 'queued')`,
        );
        for (const { id } of open)
          if (reject.run(now, now, id).changes === 1)
            rejected.push(this.one(input, id) as DeviceActionRecord);
      }
      return { kind: "written", policy: this.readPolicy(input), rejected };
    })();
  }
}
