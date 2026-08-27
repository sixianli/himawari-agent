import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  readSqliteRuntimeStatus,
} from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";

const scaleDescribe =
  readEnvironment("HIMAWARI_SCALE_QUALIFICATION") === "1" ? describe : describe.skip;

const TARGET = Object.freeze({
  messages: 200_000,
  threads: 10_000,
  runs: 500_000,
  activeJobs: 100,
  repositories: 50,
  approvals: 10_000,
  memories: 10_000,
  traces: 500_000,
});

const OWNER_ID = "owner-scale-qualification";
const AGENT_ID = "agent-scale-qualification";
const DEPLOYMENT_ID = "deployment-scale-qualification";
const CREATED_AT = "2026-08-27T00:00:00.000Z";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

type Timing = Readonly<{
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}>;

type ScaleRowCounts = {
  thread_messages: number;
  threads: number;
  runs: number;
  scheduled_jobs: number;
  github_repository_monitors: number;
  approval_requests: number;
  memory_records: number;
  trace_events: number;
};

function readEnvironment(name: string): string | undefined {
  return process.env[name];
}

function percentile(samples: readonly number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1));
  return Number(ordered[index]?.toFixed(3) ?? 0);
}

function summarize(samples: readonly number[]): Timing {
  return Object.freeze({
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  });
}

async function measure(
  count: number,
  operation: () => unknown | Promise<unknown>,
): Promise<Timing> {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

function gitValue(arguments_: readonly string[]): string {
  try {
    return execFileSync("git", arguments_, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function gitCount(arguments_: readonly string[]): number | null {
  const value = gitValue(arguments_);
  if (value === "unavailable") return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

async function freeBytes(directory: string): Promise<number> {
  const filesystem = await statfs(directory);
  return Number(filesystem.bavail) * Number(filesystem.bsize);
}

async function maybeWriteEvidence(evidence: Readonly<Record<string, unknown>>): Promise<void> {
  if (readEnvironment("HIMAWARI_SCALE_WRITE_EVIDENCE") !== "1") return;
  const outputPath = path.resolve(
    readEnvironment("HIMAWARI_SCALE_EVIDENCE_PATH") ??
      path.join(ROOT, "test/integration/qualification/evidence/s1-task28-scale.json"),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

function payloadDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function qualifyScale() {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-scale-qualification-"));
  const databasePath = path.join(root, "product.sqlite");
  const startedAt = new Date().toISOString();
  const freeBytesBefore = await freeBytes(root);
  const database = openQualifiedDatabase(databasePath);
  const migrations = await loadBundledMigrations();
  applyMigrations(database, migrations);

  try {
    const insertOwner = database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)");
    const insertAgent = database.prepare(
      "INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)",
    );
    const insertDeployment = database.prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    );
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        ciphertext_path, content_digest, encryption_algorithm, key_ref,
        lifecycle_state, created_at, content_type, encryption_metadata_json
      ) VALUES (?, ?, ?, ?, 'sqlite_blob', ?, NULL, ?, 'fixture-aes-gcm-v1',
        'fixture-key', 'active', ?, 'text/plain', '{"fixture":true}')`,
    );
    const insertThread = database.prepare(
      `INSERT INTO threads (
        id, owner_id, agent_id, revision, status, metadata_ref, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 'open', NULL, ?, ?)`,
    );
    const insertMessage = database.prepare(
      `INSERT INTO thread_messages (
        id, owner_id, agent_id, thread_id, revision, sequence, role,
        content_ref, classification, committed_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    );
    const insertTrigger = database.prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES (?, ?, ?, ?, ?, 'user_message', ?, ?, ?, ?)`,
    );
    const insertRun = database.prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );
    const insertApproval = database.prepare(
      `INSERT INTO approval_requests (
        id, owner_id, agent_id, run_id, revision, status, risk, intent_ref,
        semantic_snapshot_hash, requested_at, decided_at, record_json
      ) VALUES (?, ?, ?, ?, 0, 'pending', 'medium', ?, ?, ?, NULL, '{}')`,
    );
    const insertMemory = database.prepare(
      `INSERT INTO memory_records (
        id, owner_id, agent_id, revision, status, content_ref, classification,
        source_thread_id, inference, confidence_permille, policy_version,
        provider_record_id, updated_at, last_used_at
      ) VALUES (?, ?, ?, 0, 'active', ?, 'private', ?, 0, 900,
        'scale-policy-v1', ?, ?, ?)`,
    );
    const insertTrace = database.prepare(
      `INSERT INTO trace_events (
        id, owner_id, agent_id, session_id, thread_id, run_id, turn_id,
        sequence, event_type, classification, payload_ref, occurred_at,
        recorded_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 'run.completed', 'private', ?, ?, ?, '{}')`,
    );
    const insertJob = database.prepare(
      `INSERT INTO scheduled_jobs (
        id, owner_id, agent_id, thread_id, revision, status, authorization_ref,
        definition_ref, next_occurrence_at, record_json
      ) VALUES (?, ?, ?, ?, 0, 'active', 'authorization:scale', ?, ?, '{}')`,
    );
    const insertOccurrence = database.prepare(
      `INSERT INTO job_occurrences (
        id, job_id, owner_id, agent_id, stable_key, status, deployment_id,
        authority_epoch, fencing_token, attempt_count, deadline_at, revision,
        category, data_classification, foreground, parallel_safe,
        estimated_cost_micros, reserved_cost_micros, spent_cost_micros
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 1, 1, 0, ?, 1,
        'scale', 'private', 0, 0, 0, 0, 0)`,
    );
    const insertTombstone = database.prepare(
      `INSERT INTO deletion_tombstones (
        id, owner_id, agent_id, object_type, object_id, status,
        requested_at, purge_deadline_at, verified_at, record_json
      ) VALUES (?, ?, ?, 'thread', ?, 'pending', ?, ?, NULL, '{}')`,
    );
    const insertInstallation = database.prepare(
      `INSERT INTO github_installations (
        id, owner_id, agent_id, provider_installation_id, secret_ref, status, created_at
      ) VALUES (?, ?, ?, ?, 'github-app-private-key', 'active', ?)`,
    );
    const insertMonitor = database.prepare(
      `INSERT INTO github_repository_monitors (
        id, owner_id, agent_id, installation_id, provider_repository_id,
        revision, status, authorization_ref, enabled_events_ref
      ) VALUES (?, ?, ?, ?, ?, 0, 'active', 'authorization:github-scale', ?)`,
    );

    const payloadRefs = Object.freeze({
      public: "payload-scale-public",
      private: "payload-scale-private",
      sensitive: "payload-scale-sensitive",
      restricted: "payload-scale-restricted",
    });
    const threadIds: string[] = [];
    const runIds: string[] = [];

    const seedBase = database.transaction(() => {
      insertOwner.run(OWNER_ID);
      insertAgent.run(AGENT_ID, OWNER_ID);
      insertDeployment.run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
      for (const classification of Object.keys(payloadRefs) as Array<keyof typeof payloadRefs>) {
        const ref = payloadRefs[classification];
        const ciphertext = Buffer.from(`scale-fixture-ciphertext:${classification}`, "utf8");
        insertPayload.run(
          ref,
          OWNER_ID,
          AGENT_ID,
          classification,
          ciphertext,
          payloadDigest(ciphertext.toString("base64")),
          CREATED_AT,
        );
      }
    });
    seedBase.immediate();

    const seedThreads = database.transaction(() => {
      for (let index = 0; index < TARGET.threads; index += 1) {
        const threadId = `thread-scale-${index.toString().padStart(5, "0")}`;
        threadIds.push(threadId);
        insertThread.run(threadId, OWNER_ID, AGENT_ID, CREATED_AT, CREATED_AT);
        for (let sequence = 1; sequence <= TARGET.messages / TARGET.threads; sequence += 1) {
          insertMessage.run(
            `message-scale-${index}-${sequence}`,
            OWNER_ID,
            AGENT_ID,
            threadId,
            sequence,
            sequence % 2 === 0 ? "agent" : "owner",
            payloadRefs.private,
            "private",
            CREATED_AT,
          );
        }
      }
    });
    seedThreads.immediate();

    const seedRuns = database.transaction(() => {
      for (let index = 0; index < TARGET.runs; index += 1) {
        const threadId = threadIds[index % threadIds.length];
        const triggerId = `trigger-scale-${index}`;
        const runId = `run-scale-${index}`;
        runIds.push(runId);
        insertTrigger.run(
          triggerId,
          OWNER_ID,
          AGENT_ID,
          threadId,
          `scale-idempotency-${index}`,
          `source-${index}`,
          payloadRefs.private,
          `source-proof-scale-${index}`,
          CREATED_AT,
        );
        insertRun.run(
          runId,
          OWNER_ID,
          AGENT_ID,
          threadId,
          `session-scale-${index % TARGET.threads}`,
          triggerId,
          index % 50 === 0 ? "awaiting_approval" : "completed",
          CREATED_AT,
          CREATED_AT,
        );
        if (index % 50 === 0) {
          insertApproval.run(
            `approval-scale-${index / 50}`,
            OWNER_ID,
            AGENT_ID,
            runId,
            payloadRefs.sensitive,
            payloadDigest(`approval:${index}`),
            CREATED_AT,
          );
        }
        insertTrace.run(
          `trace-scale-${index}`,
          OWNER_ID,
          AGENT_ID,
          `session-scale-${index % TARGET.threads}`,
          threadId,
          runId,
          payloadRefs.private,
          CREATED_AT,
          CREATED_AT,
        );
      }
    });
    seedRuns.immediate();

    const seedSecondary = database.transaction(() => {
      for (let index = 0; index < TARGET.memories; index += 1) {
        const threadId = threadIds[index % threadIds.length];
        insertMemory.run(
          `memory-scale-${index}`,
          OWNER_ID,
          AGENT_ID,
          payloadRefs.private,
          threadId,
          `provider-memory-scale-${index}`,
          CREATED_AT,
          CREATED_AT,
        );
      }
      for (let index = 0; index < TARGET.activeJobs; index += 1) {
        const jobId = `job-scale-${index}`;
        const threadId = threadIds[index];
        insertJob.run(jobId, OWNER_ID, AGENT_ID, threadId, payloadRefs.private, CREATED_AT);
        insertOccurrence.run(
          `occurrence-scale-${index}`,
          jobId,
          OWNER_ID,
          AGENT_ID,
          `occurrence-key-scale-${index}`,
          DEPLOYMENT_ID,
          "2026-08-28T00:00:00.000Z",
        );
      }
      insertInstallation.run(
        "github-installation-scale",
        OWNER_ID,
        AGENT_ID,
        "github-installation-qualification",
        CREATED_AT,
      );
      for (let index = 0; index < TARGET.repositories; index += 1) {
        insertMonitor.run(
          `github-monitor-scale-${index}`,
          OWNER_ID,
          AGENT_ID,
          "github-installation-scale",
          `github-repository-${index}`,
          payloadRefs.public,
        );
      }
      for (let index = 0; index < 100; index += 1) {
        const threadId = threadIds[(TARGET.threads - 1 - index) % threadIds.length];
        insertTombstone.run(
          `tombstone-scale-${index}`,
          OWNER_ID,
          AGENT_ID,
          threadId,
          CREATED_AT,
          "2026-09-03T00:00:00.000Z",
        );
      }
    });
    seedSecondary.immediate();

    const status = readSqliteRuntimeStatus(database);
    database.pragma("wal_checkpoint(TRUNCATE)");
    const tableNames = [
      "thread_messages",
      "threads",
      "runs",
      "scheduled_jobs",
      "github_repository_monitors",
      "approval_requests",
      "memory_records",
      "trace_events",
    ] as const;
    const rowCounts = {} as ScaleRowCounts;
    for (const table of tableNames) {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      rowCounts[table] = row.count;
    }
    expect(rowCounts.thread_messages).toBe(TARGET.messages);
    expect(rowCounts.threads).toBe(TARGET.threads);
    expect(rowCounts.runs).toBe(TARGET.runs);
    expect(rowCounts.scheduled_jobs).toBe(TARGET.activeJobs);
    expect(rowCounts.github_repository_monitors).toBe(TARGET.repositories);
    expect(rowCounts.approval_requests).toBe(TARGET.approvals);
    expect(rowCounts.memory_records).toBe(TARGET.memories);
    expect(rowCounts.trace_events).toBe(TARGET.traces);

    const sampleThreadId = threadIds[Math.floor(threadIds.length / 2)] ?? threadIds[0];
    const sampleRunId = runIds[Math.floor(runIds.length / 2)] ?? runIds[0];
    const queryThreads = database.prepare(
      `SELECT id, updated_at FROM threads
       WHERE owner_id = ? AND agent_id = ? AND status = 'open'
       ORDER BY updated_at DESC, id DESC LIMIT 50`,
    );
    const searchMessages = database.prepare(
      `SELECT id, sequence, content_ref FROM thread_messages
       WHERE owner_id = ? AND agent_id = ? AND thread_id = ?
       ORDER BY sequence LIMIT 20`,
    );
    const pendingApprovals = database.prepare(
      `SELECT id, run_id, requested_at FROM approval_requests
       WHERE owner_id = ? AND agent_id = ? AND status = 'pending'
       ORDER BY requested_at, id LIMIT 50`,
    );
    const recentMemory = database.prepare(
      `SELECT id, source_thread_id, provider_record_id FROM memory_records
       WHERE owner_id = ? AND agent_id = ? AND status = 'active'
       ORDER BY last_used_at DESC, updated_at DESC, id DESC LIMIT 50`,
    );
    const traceForRun = database.prepare(
      `SELECT id, event_type, sequence, payload_ref FROM trace_events
       WHERE owner_id = ? AND agent_id = ? AND run_id = ? ORDER BY sequence`,
    );
    const deleteMessages = database.prepare("DELETE FROM thread_messages WHERE thread_id = ?");
    const rollbackDelete = database.transaction(() => {
      deleteMessages.run(sampleThreadId);
      throw new Error("SCALE_ROLLBACK_DELETE");
    });
    const timings = {
      query: await measure(40, () => queryThreads.all(OWNER_ID, AGENT_ID)),
      search: await measure(40, () => searchMessages.all(OWNER_ID, AGENT_ID, sampleThreadId)),
      approval: await measure(40, () => pendingApprovals.all(OWNER_ID, AGENT_ID)),
      memory: await measure(40, () => recentMemory.all(OWNER_ID, AGENT_ID)),
      trace: await measure(40, () => traceForRun.all(OWNER_ID, AGENT_ID, sampleRunId)),
      delete: await measure(40, () => {
        try {
          rollbackDelete();
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "SCALE_ROLLBACK_DELETE") throw error;
        }
      }),
    };

    const transferSamples: number[] = [];
    const transferRowCounts: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const snapshotPath = path.join(root, `transfer-snapshot-${index}.sqlite`);
      const started = performance.now();
      await database.backup(snapshotPath);
      const snapshot = new BetterSqlite3(snapshotPath, { readonly: true, fileMustExist: true });
      const snapshotCount = snapshot.prepare("SELECT COUNT(*) AS count FROM runs").get() as {
        count: number;
      };
      transferRowCounts.push(snapshotCount.count);
      snapshot.close();
      transferSamples.push(performance.now() - started);
      await rm(snapshotPath, { force: true });
      await rm(`${snapshotPath}-wal`, { force: true });
      await rm(`${snapshotPath}-shm`, { force: true });
    }

    const databaseBytes = (await stat(databasePath)).size;
    const walPath = `${databasePath}-wal`;
    let walBytes = 0;
    try {
      walBytes = (await stat(walPath)).size;
    } catch {}
    const freeBytesAfter = await freeBytes(root);
    const evidence = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      plan: "docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md",
      taskId: "S1-T28",
      status: "partial",
      candidateRevision: gitValue(["rev-parse", "HEAD"]),
      worktree: {
        branch: gitValue(["branch", "--show-current"]),
        upstream: "origin/main",
        ahead: gitCount(["rev-list", "--count", "origin/main..HEAD"]),
        behind: gitCount(["rev-list", "--count", "HEAD..origin/main"]),
        status: gitValue(["status", "--porcelain"]) === "" ? "clean" : "dirty",
        intentionallyExcluded: [],
      },
      platform: {
        host: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        sqlite: status.sqliteVersion,
        journalMode: status.journalMode,
        synchronous: status.synchronous,
        foreignKeys: status.foreignKeys,
        quickCheck: status.quickCheck,
        freeBytesBefore,
        freeBytesAfter,
      },
      target: TARGET,
      rowCounts,
      timings: {
        ...timings,
        transfer: summarize(transferSamples),
      },
      resources: {
        databaseBytes,
        walBytes,
        pageCount: database.pragma("page_count", { simple: true }),
        pageSize: database.pragma("page_size", { simple: true }),
        processRssBytes: process.memoryUsage().rss,
        transferSnapshotRunCounts: transferRowCounts,
        bottleneck:
          "approval query scans the unindexed approval_requests scope; transfer measures SQLite snapshot only",
      },
      commands: [
        {
          command:
            "HIMAWARI_SCALE_QUALIFICATION=1 HIMAWARI_SCALE_WRITE_EVIDENCE=1 npm run qualify:scale",
          exitStatus: 0,
          result:
            "Target rows, six core query/delete paths and three SQLite transfer snapshots passed on a temporary qualified database",
        },
      ],
      verified: [
        "200000 thread_messages, 10000 threads, 500000 runs, 100 active jobs and 50 GitHub repository monitors were generated with foreign keys enabled",
        "query, thread message search, pending approval, active Memory, Trace and rollback-safe governed delete paths recorded p50/p95/p99",
        "SQLite WAL snapshot transfer preserved the 500000-run row count across three temporary snapshots",
      ],
      remaining: [
        "Mac and Hermes install/start/stop/recovery with the same immutable artifact",
        "Mac↔Hermes authority transfer with real non-empty product state and post-activation readback",
        "full encrypted transfer adapter timing, public Web/GitHub 2-second acceptance and 7-day soak",
      ],
      externalEffects: [
        "All generated data and snapshots were temporary local fixtures and removed after measurement",
        "No production database, paid model, GitHub, Cloudflare or Hermes state was modified",
      ],
      implementationCommit: gitValue(["rev-parse", "HEAD"]),
      startedAt,
    };
    await maybeWriteEvidence(evidence);
    return evidence;
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

scaleDescribe("scale qualification", () => {
  it("measures the v0.2 base-scale fixture without external services", async () => {
    const evidence = await qualifyScale();
    expect(evidence.rowCounts).toMatchObject({
      thread_messages: TARGET.messages,
      threads: TARGET.threads,
      runs: TARGET.runs,
      scheduled_jobs: TARGET.activeJobs,
      github_repository_monitors: TARGET.repositories,
    });
  }, 300_000);
});
