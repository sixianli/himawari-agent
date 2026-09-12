import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

/** One-time recovery, through the ordinary repository lock, authority lease and protected history port. */
export async function importQualifiedLegacyHistory({
  runtime,
  stateRoot,
  config,
  sealed,
  protector,
  expectedThreadId,
}) {
  assert.equal(stateRoot, config.stateRoot, "IMPORT_STATE_ROOT_MISMATCH");
  const require = createRequire(path.join(runtime, "package.json"));
  const Database = require("better-sqlite3");
  const persistence = require("@himawari-agent/persistence-sqlite");
  const {
    RuntimeHistoryService,
    ProductionAuthorityLifecycle,
  } = require("@himawari-agent/agent-service");
  const { qualifyLegacyPiHistory } = require("@himawari-agent/runtime-pi");
  const candidate = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await protector.unprotect({
        ownerId: config.ownerId,
        agentId: config.agentId,
        payload: { ...sealed, ciphertext: Buffer.from(sealed.ciphertext, "base64") },
      }),
    ),
  );
  assert.equal(candidate.version, "himawari.legacy-history-import.v1");
  assert.equal(candidate.ownerId, config.ownerId);
  assert.equal(candidate.agentId, config.agentId);
  assert.equal(candidate.threadId, expectedThreadId, "IMPORT_THREAD_NOT_AUTHORIZED");
  assert(candidate.source.length > 0 && candidate.source.length <= 50);
  const databasePath = path.join(stateRoot, "data/product.sqlite");
  const preflight = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(
      preflight.prepare("SELECT max(sequence) AS n FROM schema_migration_ledger").get().n,
      32,
      "IMPORT_REQUIRES_SCHEMA_32",
    );
  } finally {
    preflight.close();
  }
  // Opening the repository acquires the same exclusive state-root lock as the service.
  const repo = await persistence.SqliteProductStateRepository.open({ stateRoot, databasePath });
  let lifecycle, db;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM runs WHERE status NOT IN ('completed','failed','cancelled')",
        )
        .get().n,
      0,
      "IMPORT_ACTIVE_RUNS",
    );
    const scope = [config.ownerId, config.agentId];
    const fingerprint = () =>
      createHash("sha256")
        .update(
          JSON.stringify({
            artifacts: db
              .prepare(
                "SELECT owner_id,agent_id,run_id,purpose,operation_key,payload_ref,content_digest,content_type,classification,created_at FROM run_payload_artifacts WHERE purpose != 'runtime_history' ORDER BY owner_id,agent_id,run_id,purpose,operation_key",
              )
              .all(),
            messages: db
              .prepare(
                "SELECT * FROM thread_messages ORDER BY owner_id,agent_id,thread_id,sequence",
              )
              .all(),
            runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
          }),
        )
        .digest("hex");
    const before = fingerprint();
    let qualified;
    assert.deepEqual(
      db
        .prepare(
          "SELECT message_watermark,revision FROM threads WHERE id=? AND owner_id=? AND agent_id=?",
        )
        .get(candidate.threadId, ...scope),
      candidate.head,
      "IMPORT_THREAD_CHANGED",
    );
    const runs = db
      .prepare(
        "SELECT runs.id,runs.status,MIN(m.sequence) AS sequence FROM runs JOIN thread_messages m ON m.run_id=runs.id AND m.owner_id=runs.owner_id AND m.agent_id=runs.agent_id WHERE runs.owner_id=? AND runs.agent_id=? AND runs.thread_id=? AND m.role='owner' GROUP BY runs.id ORDER BY sequence",
      )
      .all(...scope, candidate.threadId);
    assert.deepEqual(
      runs,
      candidate.source.map((r) => ({ id: r.runId, status: r.status, sequence: r.sequence })),
      "IMPORT_RUNS_CHANGED",
    );
    const legacy = [];
    for (const run of candidate.source) {
      assert(["completed", "failed", "cancelled"].includes(run.status), "IMPORT_ACTIVE_RUN");
      const eventCount = db
        .prepare(
          "SELECT count(*) AS n FROM trace_events WHERE owner_id=? AND agent_id=? AND run_id=? AND event_type='runtime.message'",
        )
        .get(...scope, run.runId).n;
      assert.equal(
        eventCount,
        run.partialEvents + run.finalMessages.length,
        "IMPORT_TRACE_CHANGED",
      );
      const finalizedMessages = [];
      for (const item of run.finalMessages) {
        const row = db
          .prepare(
            "SELECT p.* FROM payloads p JOIN run_payload_artifacts a ON a.payload_ref=p.ref AND a.owner_id=p.owner_id AND a.agent_id=p.agent_id WHERE a.owner_id=? AND a.agent_id=? AND a.run_id=? AND a.purpose='trace' AND a.payload_ref=? AND a.content_digest=? AND p.lifecycle_state='active'",
          )
          .get(...scope, run.runId, item.payloadRef, item.digest);
        assert(
          row && row.storage_kind === "sqlite_blob" && row.classification === "private",
          "IMPORT_SOURCE_UNAVAILABLE",
        );
        const plain = await protector.unprotect({
          ownerId: config.ownerId,
          agentId: config.agentId,
          payload: {
            ref: row.ref,
            dataClassification: row.classification,
            contentType: row.content_type,
            ciphertext: row.ciphertext,
            encryption: JSON.parse(row.encryption_metadata_json),
            contentDigest: row.content_digest,
            createdAt: row.created_at,
          },
        });
        const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
        assert.equal(message.role, item.role, "IMPORT_ROLE_CHANGED");
        finalizedMessages.push(message);
      }
      legacy.push({ runId: run.runId, status: run.status, finalizedMessages });
    }
    qualified = qualifyLegacyPiHistory(legacy);
    // Custom cancellation notes are generated metadata. Original native messages must match exactly.
    const original = (history) => history.messages.filter((m) => m.role !== "custom");
    assert.deepEqual(
      original(qualified),
      original(candidate.history),
      "IMPORT_CANDIDATE_CONTENT_CHANGED",
    );
    for (const field of [
      "coveredRunIds",
      "duplicateMessages",
      "repairedUsageTotals",
      "incompleteCancelledRuns",
    ])
      assert.deepEqual(qualified[field], candidate.history[field], "IMPORT_QUALIFICATION_CHANGED");

    const clock = { now: () => new Date().toISOString() };
    assert(
      !(await repo.authorityLeasePort(clock).current(config.agentId)),
      "IMPORT_AUTHORITY_STILL_ACTIVE",
    );
    lifecycle = new ProductionAuthorityLifecycle({
      ownerId: config.ownerId,
      agentId: config.agentId,
      deploymentId: config.deploymentId,
      deployment: repo.deploymentAuthorityPort(),
      leases: repo.authorityLeasePort(clock),
      clock,
      leaseDurationMs: 120000,
    });
    const active = await lifecycle.start();
    assert(active.authority && active.lease);
    const artifacts = repo.runPayloadArtifactPort(config.ownerId, config.agentId, {
      product: active.authority,
      lease: { leaseId: active.lease.lease.id, fencingToken: active.lease.fencingToken },
    });
    const dependencies = {
      ownerId: config.ownerId,
      agentId: config.agentId,
      clock,
      ids: { next: (namespace) => `${namespace}:${randomUUID()}` },
      artifacts,
      payloads: repo.payloadStore(config.ownerId, config.agentId),
      protector,
    };
    const history = new RuntimeHistoryService(dependencies),
      runId = qualified.coveredRunIds.at(-1);
    const existing = db
      .prepare(
        "SELECT run_id AS runId,operation_key AS operationKey,payload_ref AS payloadRef,classification AS dataClassification FROM run_payload_artifacts WHERE owner_id=? AND agent_id=? AND run_id=? AND purpose='runtime_history' AND operation_key LIKE 'snapshot:%' ORDER BY history_sequence DESC LIMIT 1",
      )
      .get(...scope, runId);
    const reference =
      existing ??
      (await history.save({
        runId,
        dataClassification: "private",
        messages: qualified.messages,
        coveredRunIds: qualified.coveredRunIds,
      }));
    const restored = await new RuntimeHistoryService(dependencies).load(reference, "private");
    assert.deepEqual(restored.messages, qualified.messages, "IMPORT_EXISTING_HISTORY_DIFFERS");
    assert.deepEqual(restored.coveredRunIds, qualified.coveredRunIds);
    assert.equal(fingerprint(), before, "IMPORT_ORIGINAL_RECORDS_CHANGED");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    if (!existing)
      await repo.auditLedger().append({
        id: `native-history-import:${randomUUID()}`,
        ownerId: config.ownerId,
        agentId: config.agentId,
        action: "owner.history.import",
        targetRef: candidate.threadId,
        outcome: "completed",
        occurredAt: clock.now(),
      });
    return {
      passed: true,
      imported: !existing,
      threadId: candidate.threadId,
      messageCount: restored.messages.length,
      coveredRuns: restored.coveredRunIds.length,
      originalRecordsUnchanged: true,
      foreignKeysValid: true,
      modelCalls: 0,
    };
  } finally {
    try {
      if (lifecycle) await lifecycle.stop();
    } finally {
      db?.close();
      await repo.close();
    }
  }
}
