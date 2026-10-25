import { createHash } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";

export const SANDBOX_PURGE_ERROR_CODES = Object.freeze({
  DIGEST_MISMATCH: "SANDBOX_PURGE_DIGEST_MISMATCH",
} as const);

const OWNED_TABLES = [
  "sandbox_workspace_occupancy",
  "sandbox_workspace_barriers",
  "sandbox_execution_observations",
  "sandbox_operation_observations",
  "sandbox_execution_intents",
] as const;

const UNCONFIRMED_SRT_RECORD = `r.owner_id=@owner AND r.agent_id=@agent AND r.preparation_state<>'reserved'
    AND json_extract(r.plan_json,'$.backendRef')='srt'
    AND json_extract(r.facts_json,'$.resource.cleanup')='unknown'
    AND NOT EXISTS(SELECT 1 FROM sandbox_release_receipts receipt WHERE receipt.job_id=r.job_id)`;

export interface UnconfirmedSandboxRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly threadId: string | null;
  readonly startedAt: string | null;
  readonly directories: readonly {
    readonly hostId: string;
    readonly canonicalRootId: string;
    readonly access: string;
    readonly file?: string;
  }[];
}

export interface UnconfirmedSandboxManifest {
  readonly digest: string;
  readonly records: readonly UnconfirmedSandboxRecord[];
  readonly counts: Readonly<Record<string, number>>;
}

export class SqliteUnconfirmedSandboxPurge {
  readonly #databasePath: string;
  readonly #owner: string;
  readonly #agent: string;
  readonly #now: () => string;

  constructor(options: {
    readonly databasePath: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly now?: () => string;
  }) {
    this.#databasePath = options.databasePath;
    this.#owner = options.ownerId;
    this.#agent = options.agentId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  list(): UnconfirmedSandboxManifest {
    const database = new BetterSqlite3(this.#databasePath, { readonly: true, fileMustExist: true });
    try {
      return database.transaction(() => this.#manifest(database).manifest)();
    } finally {
      database.close();
    }
  }

  purge(
    digest: string,
  ): UnconfirmedSandboxManifest & { readonly deletedJobIds: readonly string[] } {
    const database = new BetterSqlite3(this.#databasePath, { fileMustExist: true });
    try {
      database.pragma("foreign_keys = ON");
      return database
        .transaction(() => {
          const { manifest, plans } = this.#manifest(database);
          if (manifest.digest !== digest)
            throw new Error(SANDBOX_PURGE_ERROR_CODES.DIGEST_MISMATCH);
          const jobIds = manifest.records.map((record) => record.jobId);
          if (jobIds.length === 0) return { ...manifest, deletedJobIds: jobIds };
          const now = this.#now();
          const tombstone = database.prepare(
            `INSERT INTO deletion_tombstones (
              id, owner_id, agent_id, object_type, object_id, status,
              requested_at, purge_deadline_at, verified_at, record_json
            ) VALUES (?, @owner, @agent, ?, ?, 'verified', @now, @now, @now, ?)`,
          );
          const scope = { owner: this.#owner, agent: this.#agent, now };
          for (const jobId of jobIds)
            tombstone.run(
              `sandbox-execution-deletion:${jobId}`,
              "sandbox_execution",
              jobId,
              JSON.stringify({
                schemaVersion: "sandbox-execution-deletion.v1",
                purgeDigest: digest,
                plan: plans.get(jobId),
              }),
              scope,
            );
          tombstone.run(
            `sandbox-unconfirmed-purge:${digest}`,
            "sandbox_unconfirmed_purge",
            digest,
            JSON.stringify({
              schemaVersion: "sandbox-unconfirmed-purge.v1",
              digest,
              jobIds,
              counts: manifest.counts,
            }),
            scope,
          );
          const marks = jobIds.map(() => "?").join(",");
          for (const table of OWNED_TABLES)
            database.prepare(`DELETE FROM ${table} WHERE job_id IN (${marks})`).run(...jobIds);
          database
            .prepare(`DELETE FROM sandbox_execution_records WHERE job_id IN (${marks})`)
            .run(...jobIds);
          database
            .prepare(
              `INSERT INTO audit_records (
                id, owner_id, agent_id, action, target_ref, outcome, detail_ref, occurred_at
              ) VALUES (?, ?, ?, 'sandbox.unconfirmed_records_deleted', ?, 'completed', NULL, ?)`,
            )
            .run(`audit-sandbox-purge:${digest}`, this.#owner, this.#agent, digest, now);
          return { ...manifest, deletedJobIds: jobIds };
        })
        .immediate();
    } finally {
      database.close();
    }
  }

  #manifest(database: InstanceType<typeof BetterSqlite3>) {
    const scope = { owner: this.#owner, agent: this.#agent };
    const rows = database
      .prepare(
        `SELECT r.job_id AS jobId, r.run_id AS runId, run.thread_id AS threadId,
          r.started_at AS startedAt, r.plan_json AS plan
        FROM sandbox_execution_records r
        LEFT JOIN runs run ON run.id=r.run_id AND run.owner_id=r.owner_id AND run.agent_id=r.agent_id
        WHERE ${UNCONFIRMED_SRT_RECORD}
        ORDER BY r.job_id`,
      )
      .all(scope) as {
      jobId: string;
      runId: string;
      threadId: string | null;
      startedAt: string | null;
      plan: string;
    }[];
    const claims = database.prepare(
      "SELECT claim_json AS claim FROM sandbox_workspace_occupancy WHERE job_id=? ORDER BY scope_ref",
    );
    const records = rows.map(({ plan: _plan, ...row }) => ({
      ...row,
      directories: (claims.all(row.jobId) as { claim: string }[]).map(({ claim }) => {
        const value = JSON.parse(claim) as {
          hostId: string;
          canonicalRootId: string;
          access: string;
          file?: { name: string };
        };
        return {
          hostId: value.hostId,
          canonicalRootId: value.canonicalRootId,
          access: value.access,
          ...(value.file ? { file: value.file.name } : {}),
        };
      }),
    }));
    const count = (table: string) =>
      (
        database
          .prepare(
            `SELECT count(*) AS count FROM ${table}
            WHERE job_id IN (SELECT r.job_id FROM sandbox_execution_records r WHERE ${UNCONFIRMED_SRT_RECORD})`,
          )
          .get(scope) as { count: number }
      ).count;
    const counts = Object.fromEntries(
      ["sandbox_execution_records", ...OWNED_TABLES].map((table) => [table, count(table)]),
    );
    const digest = `sha256:${createHash("sha256")
      .update(JSON.stringify({ schemaVersion: "sandbox-unconfirmed-purge.v1", records, counts }))
      .digest("hex")}`;
    return {
      manifest: { digest, records, counts },
      plans: new Map(rows.map((row) => [row.jobId, JSON.parse(row.plan) as unknown])),
    };
  }
}
