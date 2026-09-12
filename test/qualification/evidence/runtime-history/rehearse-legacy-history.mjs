import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// This entrypoint writes only to a fresh rehearsal directory. It is not a live importer.
export async function rehearseLegacyHistory({
  runtime,
  sourceState,
  work,
  config,
  sealed,
  protector,
}) {
  assert.equal(await realpath(sourceState), sourceState);
  assert.equal(await realpath(path.dirname(work)), path.dirname(work));
  assert(!work.startsWith(sourceState + "/") && work !== sourceState, "REHEARSAL_SOURCE_COLLISION");
  const require = createRequire(path.join(runtime, "package.json"));
  const Database = require("better-sqlite3");
  const persistence = require("@himawari-agent/persistence-sqlite");
  const {
    RuntimeHistoryService,
    ProductionAuthorityLifecycle,
  } = require("@himawari-agent/agent-service");
  const { qualifyLegacyPiHistory } = require("@himawari-agent/runtime-pi");
  const pi = await import(
    path.join(runtime, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")
  );
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
  assert(candidate.source.length > 0 && candidate.source.length <= 50);
  await mkdir(work, { mode: 0o700 });
  const stateRoot = path.join(work, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  const databasePath = path.join(stateRoot, "product.sqlite");
  const source = new Database(path.join(sourceState, "data/product.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await source.backup(databasePath);
  } finally {
    source.close();
  }
  const db = persistence.openQualifiedDatabase(databasePath);
  const scope = [config.ownerId, config.agentId];
  const digest = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const priorRows = () => ({
    artifacts: db
      .prepare(
        "SELECT owner_id,agent_id,run_id,purpose,operation_key,payload_ref,content_digest,content_type,classification,created_at FROM run_payload_artifacts WHERE purpose != ? ORDER BY owner_id,agent_id,run_id,purpose,operation_key",
      )
      .all("runtime_history"),
    messages: db
      .prepare("SELECT * FROM thread_messages ORDER BY owner_id,agent_id,thread_id,sequence")
      .all(),
    runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
  });
  let qualified, before, migration;
  try {
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
    before = digest(priorRows());
    const snapshot = await persistence.createVerifiedMigrationSnapshot(
      db,
      path.join(work, "schema-before.sqlite"),
    );
    migration = persistence.applyMigrations(db, await persistence.loadBundledMigrations(), {
      snapshot,
    });
    assert.equal(migration.currentSequence, 32);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(digest(priorRows()), before, "MIGRATION_SOURCE_CHANGED");
  } finally {
    db.close();
  }
  // Claim the ordinary product authority on the isolated copy after its copied lease expires.
  const clock = { now: () => new Date().toISOString() };
  const repo = await persistence.SqliteProductStateRepository.open({ stateRoot, databasePath });
  const lifecycle = new ProductionAuthorityLifecycle({
    ownerId: config.ownerId,
    agentId: config.agentId,
    deploymentId: config.deploymentId,
    deployment: repo.deploymentAuthorityPort(),
    leases: repo.authorityLeasePort(clock),
    clock,
    leaseDurationMs: 120000,
  });
  let ref, restored;
  try {
    const previous = await repo.authorityLeasePort(clock).current(config.agentId);
    if (previous) {
      const remaining = Date.parse(previous.expiresAt) - Date.now();
      assert(remaining <= 120000, "REHEARSAL_COPIED_LEASE_TOO_LONG");
      if (remaining > 0) await delay(remaining + 20);
    }
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
    const history = new RuntimeHistoryService(dependencies);
    ref = await history.save({
      runId: qualified.coveredRunIds.at(-1),
      dataClassification: "private",
      messages: qualified.messages,
      coveredRunIds: qualified.coveredRunIds,
    });
    restored = await new RuntimeHistoryService(dependencies).load(ref, "private");
    assert.deepEqual(restored.messages, qualified.messages);
    assert.deepEqual(restored.coveredRunIds, qualified.coveredRunIds);
    const session = pi.SessionManager.inMemory();
    for (const message of pi.convertToLlm(restored.messages)) session.appendMessage(message);
    const prompt = "现在的天气怎么样？";
    session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    assert.equal(session.buildSessionContext().messages.at(-1).content, prompt);
    await repo
      .auditLedger()
      .append({
        id: `native-history-rehearsal:${randomUUID()}`,
        ownerId: config.ownerId,
        agentId: config.agentId,
        action: "owner.history.rehearse",
        targetRef: candidate.threadId,
        outcome: "completed",
        occurredAt: clock.now(),
      });
  } finally {
    await lifecycle.stop();
    await repo.close();
  }
  const checked = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(checked.pragma("foreign_key_check"), []);
    const rows = {
      artifacts: checked
        .prepare(
          "SELECT owner_id,agent_id,run_id,purpose,operation_key,payload_ref,content_digest,content_type,classification,created_at FROM run_payload_artifacts WHERE purpose != ? ORDER BY owner_id,agent_id,run_id,purpose,operation_key",
        )
        .all("runtime_history"),
      messages: checked
        .prepare("SELECT * FROM thread_messages ORDER BY owner_id,agent_id,thread_id,sequence")
        .all(),
      runs: checked.prepare("SELECT * FROM runs ORDER BY id").all(),
    };
    assert.equal(digest(rows), before, "IMPORT_SOURCE_CHANGED");
  } finally {
    checked.close();
  }
  return {
    passed: true,
    scope: "isolated database rehearsal only",
    schemaSequence: migration.currentSequence,
    appliedSequences: migration.appliedSequences,
    messageCount: restored.messages.length,
    coveredRuns: restored.coveredRunIds.length,
    sourceRowsUnchanged: true,
    foreignKeysValid: true,
    latestPromptLast: true,
    modelCalls: 0,
    productionDatabaseWritten: false,
  };
}
