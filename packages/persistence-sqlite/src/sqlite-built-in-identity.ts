import { randomUUID } from "node:crypto";
import type {
  BuiltInAccount,
  BuiltInChallenge,
  BuiltInIdentityStatePort,
  BuiltInSessionPolicy,
  ProductSessionRecord,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.ts";

type Scope = { ownerId: string; agentId: string };
type Input<K extends keyof BuiltInIdentityStatePort> = Parameters<BuiltInIdentityStatePort[K]>[0];

export class SqliteBuiltInIdentityOperations {
  private readonly db: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly headroom: () => void;
  constructor(db: Database.Database, fail: SqliteApplicationFailure, headroom: () => void) {
    this.db = db;
    this.fail = fail;
    this.headroom = headroom;
  }

  execute(operation: string, payload: unknown): unknown {
    const scope = payload as Scope;
    if (operation === "builtInIdentity.readAccount") return this.account(scope);
    if (operation === "builtInIdentity.readChallenge")
      return this.challenge(scope, (payload as Scope & { digest: string }).digest);
    this.headroom();
    return this.db
      .transaction(() => {
        switch (operation) {
          case "builtInIdentity.recordFailure": {
            const { now, phase } = (payload as Scope & { input: Input<"recordFailure"> }).input;
            this.db
              .prepare(
                "INSERT INTO audit_records (id, owner_id, agent_id, action, target_ref, outcome, detail_ref, occurred_at) VALUES (?, ?, ?, ?, ?, 'rejected', NULL, ?)",
              )
              .run(
                `audit-auth-${randomUUID()}`,
                scope.ownerId,
                scope.agentId,
                `identity.${phase}_rejected`,
                scope.ownerId,
                now,
              );
            return;
          }
          case "builtInIdentity.provision":
            return this.provision(scope, (payload as Scope & { input: Input<"provision"> }).input);
          case "builtInIdentity.reserveAttempt":
            return this.attempt(
              scope,
              (payload as Scope & { input: Input<"reserveAttempt"> }).input.now,
            );
          case "builtInIdentity.issueChallenge": {
            const { challenge, now } = (payload as Scope & { input: Input<"issueChallenge"> })
              .input;
            if (
              this.account(scope)?.revision !== challenge.credentialRevision ||
              !this.bindingActive(scope)
            )
              return false;
            this.db
              .prepare("DELETE FROM built_in_challenges WHERE owner_id = ? AND expires_at <= ?")
              .run(scope.ownerId, now);
            this.db
              .prepare("INSERT INTO built_in_challenges VALUES (?, ?, ?, ?)")
              .run(challenge.digest, scope.ownerId, challenge.expiresAt, JSON.stringify(challenge));
            return true;
          }
          case "builtInIdentity.finish":
            return this.finish(scope, (payload as Scope & { input: Input<"finish"> }).input);
          case "builtInIdentity.authenticate": {
            const input = (payload as Scope & { input: Input<"authenticate"> }).input;
            const session = this.activeSession(
              scope,
              input.authenticationRef,
              input.now,
              input.policy,
            );
            if (!session) return undefined;
            if (input.touch === false) return session;
            this.db
              .prepare(
                "UPDATE product_sessions SET last_active_at = ?, revision = revision + 1 WHERE id = ?",
              )
              .run(input.now, session.id);
            this.db
              .prepare("UPDATE devices SET last_seen_at = ?, revision = revision + 1 WHERE id = ?")
              .run(input.now, session.deviceId);
            return { ...session, lastActiveAt: input.now, revision: session.revision + 1 };
          }
          default:
            return this.fail("PORT_INVALID_OPERATION", "Unknown built-in identity operation");
        }
      })
      .immediate();
  }

  private account(scope: Scope): BuiltInAccount | undefined {
    const row = this.db
      .prepare("SELECT account_json AS json FROM built_in_accounts WHERE owner_id = ?")
      .get(scope.ownerId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as BuiltInAccount) : undefined;
  }

  private challenge(scope: Scope, digest: string): BuiltInChallenge | undefined {
    const row = this.db
      .prepare(
        "SELECT challenge_json AS json FROM built_in_challenges WHERE owner_id = ? AND digest = ?",
      )
      .get(scope.ownerId, digest) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as BuiltInChallenge) : undefined;
  }

  private bindingActive(scope: Scope): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM owner_identity_bindings WHERE owner_id = ? AND external_subject_ref = ? AND status = 'active'",
        )
        .get(scope.ownerId, `built-in:${scope.ownerId}`),
    );
  }

  private audit(scope: Scope, action: string, now: string, target = scope.ownerId): void {
    this.db
      .prepare(
        "INSERT INTO audit_records (id, owner_id, agent_id, action, target_ref, outcome, detail_ref, occurred_at) VALUES (?, ?, ?, ?, ?, 'completed', NULL, ?)",
      )
      .run(`audit-auth-${randomUUID()}`, scope.ownerId, scope.agentId, action, target, now);
  }

  private provision(scope: Scope, input: Input<"provision">): void {
    const previous = this.account(scope);
    const owners = this.db.prepare("SELECT id FROM owners").all() as { id: string }[];
    if (
      owners.length !== 1 ||
      owners[0]?.id !== scope.ownerId ||
      (previous?.revision ?? null) !== input.expectedRevision
    )
      this.fail("PORT_CONFLICT", "Account provision revision conflict");
    const binding = this.db
      .prepare(
        "SELECT external_subject_ref AS subject FROM owner_identity_bindings WHERE owner_id = ?",
      )
      .get(scope.ownerId) as { subject: string } | undefined;
    if (binding && binding.subject !== `built-in:${scope.ownerId}`)
      this.fail(
        "PORT_CONFLICT",
        "External Owner migration requires an explicit identity migration",
      );
    // A factor must already be protected and owned by this product scope.
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ? AND classification = 'restricted' AND lifecycle_state = 'active'",
        )
        .get(input.account.factorPayloadRef, scope.ownerId, scope.agentId)
    )
      this.fail("PORT_INVALID_OPERATION", "Account factor Payload is unavailable");
    const account = { ...input.account, revision: (previous?.revision ?? 0) + 1 };
    this.db
      .prepare(
        "INSERT INTO built_in_accounts VALUES (?, ?, -1, ?, 0) ON CONFLICT(owner_id) DO UPDATE SET account_json = excluded.account_json, last_totp_counter = -1, attempt_window = excluded.attempt_window, attempt_count = 0",
      )
      .run(scope.ownerId, JSON.stringify(account), input.now);
    this.db
      .prepare(
        "INSERT INTO owner_identity_bindings VALUES (?, ?, ?, 'active') ON CONFLICT(owner_id) DO UPDATE SET status = 'active'",
      )
      .run(scope.ownerId, `built-in:${scope.ownerId}`, input.now);
    this.db.prepare("DELETE FROM built_in_challenges WHERE owner_id = ?").run(scope.ownerId);
    this.db
      .prepare(
        "UPDATE product_sessions SET status = 'revoked', revoked_at = ?, revision = revision + 1 WHERE owner_id = ? AND status = 'active'",
      )
      .run(input.now, scope.ownerId);
    this.db
      .prepare(
        "UPDATE devices SET status = 'revoked', revision = revision + 1 WHERE owner_id = ? AND status = 'active'",
      )
      .run(scope.ownerId);
    this.audit(
      scope,
      previous ? "identity.account_recovered" : "identity.account_created",
      input.now,
    );
  }

  private attempt(scope: Scope, now: string): boolean {
    const row = this.db
      .prepare(
        "SELECT attempt_window AS start, attempt_count AS count FROM built_in_accounts WHERE owner_id = ?",
      )
      .get(scope.ownerId) as { start: string; count: number } | undefined;
    if (!row) return false;
    const elapsed = Date.parse(now) - Date.parse(row.start);
    if (elapsed >= 300000) {
      this.db
        .prepare(
          "UPDATE built_in_accounts SET attempt_window = ?, attempt_count = 1 WHERE owner_id = ?",
        )
        .run(now, scope.ownerId);
      return true;
    }
    if (row.count >= 20 || elapsed < 0) return false;
    this.db
      .prepare("UPDATE built_in_accounts SET attempt_count = attempt_count + 1 WHERE owner_id = ?")
      .run(scope.ownerId);
    return true;
  }

  private activeSession(
    scope: Scope,
    ref: string,
    now: string,
    policy: BuiltInSessionPolicy,
  ): ProductSessionRecord | undefined {
    const account = this.account(scope);
    if (!account || !this.bindingActive(scope)) return undefined;
    const session = this.db
      .prepare(`SELECT s.id, s.owner_id AS ownerId, s.device_id AS deviceId, s.revision,
      s.authentication_ref AS authenticationRef, s.status, s.first_authenticated_at AS firstAuthenticatedAt,
      s.last_active_at AS lastActiveAt, s.recent_authenticated_at AS recentAuthenticatedAt, s.revoked_at AS revokedAt
      FROM product_sessions s JOIN devices d ON d.id = s.device_id JOIN built_in_session_credentials c ON c.session_id = s.id
      WHERE s.owner_id = ? AND d.owner_id = ? AND s.authentication_ref = ? AND s.status = 'active' AND d.status = 'active' AND c.credential_revision = ?`)
      .get(scope.ownerId, scope.ownerId, ref, account.revision) as ProductSessionRecord | undefined;
    if (!session) return undefined;
    const time = Date.parse(now);
    const first = Date.parse(session.firstAuthenticatedAt);
    const last = Date.parse(session.lastActiveAt);
    if (
      ![time, first, last].every(Number.isFinite) ||
      time < last ||
      time - first >= policy.sessionAbsoluteMilliseconds ||
      time - last >= policy.sessionIdleMilliseconds
    )
      return undefined;
    return session;
  }

  private finish(scope: Scope, input: Input<"finish">): ProductSessionRecord | undefined {
    const account = this.account(scope);
    const challenge = this.challenge(scope, input.challengeDigest);
    if (
      !account ||
      !challenge ||
      !this.bindingActive(scope) ||
      account.revision !== input.credentialRevision ||
      challenge.credentialRevision !== account.revision ||
      Date.parse(challenge.expiresAt) <= Date.parse(input.now)
    )
      return undefined;
    const prior = challenge.authenticationRef
      ? this.activeSession(scope, challenge.authenticationRef, input.now, input.policy)
      : undefined;
    if (challenge.authenticationRef && !prior) return undefined;
    if (input.factor.kind === "totp") {
      const change = this.db
        .prepare(
          "UPDATE built_in_accounts SET last_totp_counter = ? WHERE owner_id = ? AND last_totp_counter < ?",
        )
        .run(input.factor.counter, scope.ownerId, input.factor.counter);
      if (change.changes !== 1) return undefined;
    } else {
      const digest = input.factor.digest;
      if (!account.recoveryDigests.includes(digest)) return undefined;
      this.db.prepare("UPDATE built_in_accounts SET account_json = ? WHERE owner_id = ?").run(
        JSON.stringify({
          ...account,
          recoveryDigests: account.recoveryDigests.filter((value) => value !== digest),
        }),
        scope.ownerId,
      );
    }
    this.db
      .prepare("DELETE FROM built_in_challenges WHERE digest = ? AND owner_id = ?")
      .run(input.challengeDigest, scope.ownerId);
    const sessionId = prior?.id ?? input.sessionId;
    const deviceId = prior?.deviceId ?? input.deviceId;
    if (prior) {
      this.db
        .prepare(
          "UPDATE product_sessions SET authentication_ref = ?, recent_authenticated_at = ?, last_active_at = ?, revision = revision + 1 WHERE id = ?",
        )
        .run(input.authenticationRef, input.now, input.now, sessionId);
    } else {
      this.db
        .prepare("INSERT INTO devices VALUES (?, ?, 1, ?, 'active', ?, ?)")
        .run(deviceId, scope.ownerId, challenge.deviceLabel, input.now, input.now);
      this.db
        .prepare("INSERT INTO product_sessions VALUES (?, ?, ?, 1, ?, 'active', ?, ?, ?, NULL)")
        .run(
          sessionId,
          scope.ownerId,
          deviceId,
          input.authenticationRef,
          input.now,
          input.now,
          input.now,
        );
      this.db
        .prepare("INSERT INTO built_in_session_credentials VALUES (?, ?)")
        .run(sessionId, account.revision);
    }
    this.audit(
      scope,
      prior ? "identity.reauthenticated" : "identity.signed_in",
      input.now,
      sessionId,
    );
    if (input.factor.kind === "recovery")
      this.audit(scope, "identity.recovery_code_consumed", input.now, sessionId);
    return this.activeSession(scope, input.authenticationRef, input.now, input.policy);
  }
}
