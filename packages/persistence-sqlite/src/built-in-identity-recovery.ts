import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/** Called inside the restore/activation transaction, before restored state admits traffic. */
export function invalidateRecoveredBuiltInIdentity(
  db: Database.Database,
  input: { ownerId: string; agentId: string; now: string; requireAccountRecovery: boolean },
): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'built_in_accounts'")
      .get()
  )
    return;
  if (!db.prepare("SELECT 1 FROM built_in_accounts WHERE owner_id = ?").get(input.ownerId)) return;
  db.prepare("DELETE FROM built_in_challenges WHERE owner_id = ?").run(input.ownerId);
  db.prepare(
    "UPDATE product_sessions SET status = 'revoked', revoked_at = ?, revision = revision + 1 WHERE owner_id = ? AND status = 'active'",
  ).run(input.now, input.ownerId);
  db.prepare(
    "UPDATE devices SET status = 'revoked', revision = revision + 1 WHERE owner_id = ? AND status = 'active'",
  ).run(input.ownerId);
  if (input.requireAccountRecovery) {
    // Backup rollback must never re-enable an old password, consumed recovery code or session.
    db.prepare(
      "UPDATE owner_identity_bindings SET status = 'disabled' WHERE owner_id = ? AND external_subject_ref = ?",
    ).run(input.ownerId, `built-in:${input.ownerId}`);
  }
  db.prepare(
    "INSERT INTO audit_records (id, owner_id, agent_id, action, target_ref, outcome, detail_ref, occurred_at) VALUES (?, ?, ?, ?, ?, 'completed', NULL, ?)",
  ).run(
    `audit-auth-${randomUUID()}`,
    input.ownerId,
    input.agentId,
    input.requireAccountRecovery
      ? "identity.backup_recovery_required"
      : "identity.transfer_sessions_revoked",
    input.ownerId,
    input.now,
  );
}
