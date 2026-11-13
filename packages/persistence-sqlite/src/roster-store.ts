import { applyMigrations, openQualifiedDatabase, type SqliteDatabase } from "./migration-engine.js";
import { ROSTER_MIGRATIONS } from "./roster-migrations.js";
import {
  assertTenantIdentifiers,
  normalizeTenantEmail,
  TENANT_KINDS,
  TENANT_STATUSES,
  type TenantIdentifiers,
  type TenantKind,
  type TenantStatus,
} from "./tenant-identity.js";

export const ROSTER_FILE_NAME = "roster.sqlite";

export const ROSTER_ERROR_CODES = Object.freeze({
  TENANT_EXISTS: "ROSTER_TENANT_EXISTS",
  EMAIL_TAKEN: "ROSTER_EMAIL_TAKEN",
  SUBJECT_TAKEN: "ROSTER_SUBJECT_TAKEN",
  IDENTIFIER_TAKEN: "ROSTER_IDENTIFIER_TAKEN",
  TENANT_NOT_FOUND: "ROSTER_TENANT_NOT_FOUND",
  SUBJECT_ALREADY_BOUND: "ROSTER_SUBJECT_ALREADY_BOUND",
  ARGUMENT_INVALID: "ROSTER_ARGUMENT_INVALID",
} as const);

export class RosterError extends Error {
  readonly code: (typeof ROSTER_ERROR_CODES)[keyof typeof ROSTER_ERROR_CODES];

  constructor(code: RosterError["code"], message: string) {
    super(message);
    this.name = "RosterError";
    this.code = code;
  }
}

export interface TenantRecord extends TenantIdentifiers {
  readonly email: string;
  readonly externalSubjectRef: string | null;
  readonly kind: TenantKind;
  readonly status: TenantStatus;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface NewTenant {
  readonly identifiers: TenantIdentifiers;
  readonly email: string;
  readonly kind: TenantKind;
  readonly status?: TenantStatus;
  readonly expiresAt?: string | null;
}

export interface RosterWriteContext {
  readonly actor: string;
  readonly now: string;
}

export const LIMIT_SCOPE_KINDS = ["tenant", "others_total", "default_new"] as const;
export const LIMIT_METRICS = ["calls", "tokens", "usd_estimate"] as const;
export type LimitScopeKind = (typeof LIMIT_SCOPE_KINDS)[number];
export type LimitMetric = (typeof LIMIT_METRICS)[number];

export interface LimitRecord {
  readonly scopeKind: LimitScopeKind;
  readonly tenantId: string | null;
  readonly metric: LimitMetric;
  readonly monthlyLimit: number | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface RosterAuditRecord {
  readonly id: number;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly tenantId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

interface TenantRow {
  tenant_id: string;
  email: string;
  external_subject_ref: string | null;
  owner_id: string;
  agent_id: string;
  deployment_id: string;
  kind: TenantKind;
  status: TenantStatus;
  created_at: string;
  expires_at: string | null;
}

const TENANT_COLUMNS =
  "tenant_id, email, external_subject_ref, owner_id, agent_id, deployment_id, kind, status, created_at, expires_at";

function toTenant(row: TenantRow): TenantRecord {
  return Object.freeze({
    tenantId: row.tenant_id,
    email: row.email,
    externalSubjectRef: row.external_subject_ref,
    ownerId: row.owner_id,
    agentId: row.agent_id,
    deploymentId: row.deployment_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}

function argumentInvalid(message: string): RosterError {
  return new RosterError(ROSTER_ERROR_CODES.ARGUMENT_INVALID, message);
}

function mapConstraint(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  if (!message.startsWith("UNIQUE constraint failed")) return error;
  if (message.includes("tenants.tenant_id"))
    return new RosterError(ROSTER_ERROR_CODES.TENANT_EXISTS, "The tenant already exists");
  if (message.includes("tenants.email"))
    return new RosterError(ROSTER_ERROR_CODES.EMAIL_TAKEN, "The email is already in the roster");
  if (message.includes("tenants.external_subject_ref"))
    return new RosterError(
      ROSTER_ERROR_CODES.SUBJECT_TAKEN,
      "The login subject is already bound to another tenant",
    );
  return new RosterError(ROSTER_ERROR_CODES.IDENTIFIER_TAKEN, "An identifier is already in use");
}

export class RosterStore {
  readonly #database: SqliteDatabase;

  private constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  static open(databasePath: string): RosterStore {
    const database = openQualifiedDatabase(databasePath);
    try {
      applyMigrations(database, ROSTER_MIGRATIONS);
    } catch (error) {
      database.close();
      throw error;
    }
    return new RosterStore(database);
  }

  close(): void {
    this.#database.close();
  }

  revision(): number {
    return Number(
      this.#database.prepare("SELECT value FROM meta WHERE key = 'revision'").pluck().get(),
    );
  }

  list(): readonly TenantRecord[] {
    return (
      this.#database
        .prepare(`SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY created_at, tenant_id`)
        .all() as TenantRow[]
    ).map(toTenant);
  }

  findByTenantId(tenantId: string): TenantRecord | undefined {
    return this.#find("tenant_id", tenantId);
  }

  findByEmail(email: string): TenantRecord | undefined {
    return this.#find("email", normalizeTenantEmail(email));
  }

  findBySubjectReference(reference: string): TenantRecord | undefined {
    return this.#find("external_subject_ref", reference);
  }

  #find(column: string, value: string): TenantRecord | undefined {
    const row = this.#database
      .prepare(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE ${column} = ?`)
      .get(value) as TenantRow | undefined;
    return row === undefined ? undefined : toTenant(row);
  }

  add(input: NewTenant, context: RosterWriteContext): TenantRecord {
    assertTenantIdentifiers(input.identifiers);
    if (!TENANT_KINDS.includes(input.kind)) throw argumentInvalid("Unknown tenant kind");
    const status = input.status ?? "invited";
    if (!TENANT_STATUSES.includes(status)) throw argumentInvalid("Unknown tenant status");
    const email = normalizeTenantEmail(input.email);
    const { identifiers } = input;
    try {
      this.#database
        .transaction(() => {
          if (this.findByTenantId(identifiers.tenantId))
            throw new RosterError(ROSTER_ERROR_CODES.TENANT_EXISTS, "The tenant already exists");
          this.#database
            .prepare(
              `INSERT INTO tenants (tenant_id, email, external_subject_ref, owner_id, agent_id, deployment_id, kind, status, created_at, expires_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              identifiers.tenantId,
              email,
              identifiers.ownerId,
              identifiers.agentId,
              identifiers.deploymentId,
              input.kind,
              status,
              context.now,
              input.expiresAt ?? null,
            );
          this.#audit(context, "tenant.added", identifiers.tenantId, {
            kind: input.kind,
            status,
          });
        })
        .immediate();
    } catch (error) {
      throw mapConstraint(error);
    }
    return this.#require(identifiers.tenantId);
  }

  setStatus(tenantId: string, status: TenantStatus, context: RosterWriteContext): TenantRecord {
    if (!TENANT_STATUSES.includes(status)) throw argumentInvalid("Unknown tenant status");
    this.#database
      .transaction(() => {
        const previous = this.#require(tenantId);
        this.#database
          .prepare("UPDATE tenants SET status = ? WHERE tenant_id = ?")
          .run(status, tenantId);
        this.#audit(context, "tenant.status_changed", tenantId, {
          from: previous.status,
          to: status,
        });
      })
      .immediate();
    return this.#require(tenantId);
  }

  bindSubject(tenantId: string, reference: string, context: RosterWriteContext): TenantRecord {
    return this.#writeSubject(tenantId, reference, context, false);
  }

  rebindSubject(tenantId: string, reference: string, context: RosterWriteContext): TenantRecord {
    return this.#writeSubject(tenantId, reference, context, true);
  }

  #writeSubject(
    tenantId: string,
    reference: string,
    context: RosterWriteContext,
    rebind: boolean,
  ): TenantRecord {
    if (!/^[0-9a-f]{64}$/.test(reference)) throw argumentInvalid("Invalid subject reference");
    try {
      this.#database
        .transaction(() => {
          const previous = this.#require(tenantId);
          if (!rebind && previous.externalSubjectRef !== null)
            throw new RosterError(
              ROSTER_ERROR_CODES.SUBJECT_ALREADY_BOUND,
              "The tenant already has a bound login subject",
            );
          this.#database
            .prepare("UPDATE tenants SET external_subject_ref = ? WHERE tenant_id = ?")
            .run(reference, tenantId);
          this.#audit(context, rebind ? "tenant.rebound" : "tenant.bound", tenantId, {});
        })
        .immediate();
    } catch (error) {
      throw mapConstraint(error);
    }
    return this.#require(tenantId);
  }

  setLimit(
    input: {
      readonly scopeKind: LimitScopeKind;
      readonly tenantId: string | null;
      readonly metric: LimitMetric;
      readonly monthlyLimit: number | null;
    },
    context: RosterWriteContext,
  ): LimitRecord {
    if (
      !LIMIT_SCOPE_KINDS.includes(input.scopeKind) ||
      !LIMIT_METRICS.includes(input.metric) ||
      (input.scopeKind === "tenant") !== (input.tenantId !== null) ||
      (input.monthlyLimit !== null &&
        (!Number.isSafeInteger(input.monthlyLimit) || input.monthlyLimit < 0))
    )
      throw argumentInvalid("Invalid limit");
    this.#database
      .transaction(() => {
        if (input.tenantId !== null) this.#require(input.tenantId);
        this.#database
          .prepare(
            `INSERT INTO limits (scope_kind, tenant_id, metric, monthly_limit, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope_kind, ifnull(tenant_id, ''), metric)
           DO UPDATE SET monthly_limit = excluded.monthly_limit,
                         updated_by = excluded.updated_by,
                         updated_at = excluded.updated_at`,
          )
          .run(
            input.scopeKind,
            input.tenantId,
            input.metric,
            input.monthlyLimit,
            context.actor,
            context.now,
          );
        this.#audit(context, "limit.changed", input.tenantId, {
          scopeKind: input.scopeKind,
          metric: input.metric,
          monthlyLimit: input.monthlyLimit,
        });
      })
      .immediate();
    const limit = this.listLimits().find(
      (entry) =>
        entry.scopeKind === input.scopeKind &&
        entry.tenantId === input.tenantId &&
        entry.metric === input.metric,
    );
    if (!limit) throw argumentInvalid("Limit was not stored");
    return limit;
  }

  listLimits(): readonly LimitRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT scope_kind, tenant_id, metric, monthly_limit, updated_by, updated_at
           FROM limits ORDER BY scope_kind, ifnull(tenant_id, ''), metric`,
        )
        .all() as {
        scope_kind: LimitScopeKind;
        tenant_id: string | null;
        metric: LimitMetric;
        monthly_limit: number | null;
        updated_by: string;
        updated_at: string;
      }[]
    ).map((row) =>
      Object.freeze({
        scopeKind: row.scope_kind,
        tenantId: row.tenant_id,
        metric: row.metric,
        monthlyLimit: row.monthly_limit,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      }),
    );
  }

  listAudit(): readonly RosterAuditRecord[] {
    return (
      this.#database
        .prepare("SELECT id, at, actor, action, tenant_id, detail FROM audit ORDER BY id")
        .all() as {
        id: number;
        at: string;
        actor: string;
        action: string;
        tenant_id: string | null;
        detail: string;
      }[]
    ).map((row) =>
      Object.freeze({
        id: row.id,
        at: row.at,
        actor: row.actor,
        action: row.action,
        tenantId: row.tenant_id,
        detail: JSON.parse(row.detail) as Record<string, unknown>,
      }),
    );
  }

  #require(tenantId: string): TenantRecord {
    const tenant = this.findByTenantId(tenantId);
    if (!tenant)
      throw new RosterError(ROSTER_ERROR_CODES.TENANT_NOT_FOUND, "The tenant is not in the roster");
    return tenant;
  }

  #audit(
    context: RosterWriteContext,
    action: string,
    tenantId: string | null,
    detail: Record<string, unknown>,
  ): void {
    this.#database
      .prepare("INSERT INTO audit (at, actor, action, tenant_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(context.now, context.actor, action, tenantId, JSON.stringify(detail));
  }
}
