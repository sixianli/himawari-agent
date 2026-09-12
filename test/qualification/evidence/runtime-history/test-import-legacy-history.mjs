import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { importQualifiedLegacyHistory } from "../../../../scripts/operations/hermes-native-history-import.mjs";

const runtime = process.argv[2];
assert(runtime && path.isAbsolute(runtime), "Pass the absolute candidate runtime path");
const require = createRequire(runtime + "/package.json");
const p = require("@himawari-agent/persistence-sqlite");
const {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} = require("@himawari-agent/platform-node");
const { qualifyLegacyPiHistory } = require("@himawari-agent/runtime-pi");
assert.equal(typeof qualifyLegacyPiHistory, "function");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "history-import-test-"))),
  sourceState = root + "/source";
await mkdir(sourceState);
await mkdir(sourceState + "/data");
const config = {
  ownerId: "owner-rehearsal",
  agentId: "agent-rehearsal",
  deploymentId: "deployment-rehearsal",
};
const protector = new EnvelopePayloadProtector({
  keys: new InMemoryDevelopmentSecretSource({ "key@v1": new Uint8Array(32).fill(9) }),
  activeKey: { keyRef: "key", kekVersion: "v1", dekVersion: "v1" },
});
const db = p.openQualifiedDatabase(sourceState + "/data/product.sqlite");
p.applyMigrations(db, (await p.loadBundledMigrations()).slice(0, 31));
const now = new Date().toISOString(),
  scope = [config.ownerId, config.agentId];
db.prepare("INSERT INTO owners (id,revision) VALUES (?,0)").run(config.ownerId);
db.prepare("INSERT INTO agents (id,owner_id,revision) VALUES (?,?,0)").run(
  config.agentId,
  config.ownerId,
);
db.prepare(
  "INSERT INTO deployments (id,owner_id,agent_id,revision,status,authority_epoch,fencing_token) VALUES (?,?,?,0,'active',1,1)",
).run(config.deploymentId, ...scope);
db.prepare(
  "INSERT INTO threads (id,owner_id,agent_id,revision,status,message_watermark,created_at,updated_at) VALUES ('thread-rehearsal',?,?,0,'open',1,?,?)",
).run(...scope, now, now);
async function put(message, ref) {
  const payload = await protector.protect({
    ownerId: config.ownerId,
    agentId: config.agentId,
    ref,
    dataClassification: "private",
    contentType: "application/json",
    plaintext: new TextEncoder().encode(JSON.stringify(message)),
    createdAt: now,
  });
  db.prepare(
    "INSERT INTO payloads (ref,owner_id,agent_id,classification,storage_kind,ciphertext,content_digest,lifecycle_state,created_at,content_type,encryption_metadata_json) VALUES (?,?,?,'private','sqlite_blob',?,?,'active',?,'application/json',?)",
  ).run(
    ref,
    ...scope,
    payload.ciphertext,
    payload.contentDigest,
    now,
    JSON.stringify(payload.encryption),
  );
  return payload;
}
const messages = [
  { role: "user", content: "写文章", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "text", text: "旧文章" }],
    provider: "test",
    model: "test",
    api: "openai-completions",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: "[REDACTED]",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 2,
  },
];
await put(messages[0], "prompt");
db.prepare(
  "INSERT INTO triggers (id,owner_id,agent_id,thread_id,idempotency_key,source_type,source_id,payload_ref,source_proof_ref,occurred_at) VALUES ('trigger-rehearsal',?,?,'thread-rehearsal','trigger-key','user_message','fixture','prompt','proof',?)",
).run(...scope, now);
db.prepare(
  "INSERT INTO runs (id,owner_id,agent_id,thread_id,session_id,trigger_id,revision,status,created_at,updated_at) VALUES ('run-rehearsal',?,?,'thread-rehearsal','session-rehearsal','trigger-rehearsal',0,'completed',?,?)",
).run(...scope, now, now);
db.prepare(
  "INSERT INTO thread_messages (id,owner_id,agent_id,thread_id,revision,sequence,role,content_ref,classification,committed_at,run_id) VALUES ('message-rehearsal',?,?,'thread-rehearsal',0,1,'owner','prompt','private',?,'run-rehearsal')",
).run(...scope, now);
const finalMessages = [];
for (let i = 0; i < messages.length; i++) {
  const ref = "native-" + i,
    payload = await put(messages[i], ref);
  db.prepare(
    "INSERT INTO run_payload_artifacts (owner_id,agent_id,run_id,purpose,operation_key,payload_ref,content_digest,content_type,classification,created_at) VALUES (?,?,'run-rehearsal','trace',?,?,?,'application/json','private',?)",
  ).run(...scope, "message-" + i, ref, payload.contentDigest, now);
  db.prepare(
    "INSERT INTO trace_events (id,owner_id,agent_id,session_id,thread_id,run_id,sequence,event_type,classification,payload_ref,occurred_at,recorded_at) VALUES (?,?,?,'session-rehearsal','thread-rehearsal','run-rehearsal',?,'runtime.message','private',?,?,?)",
  ).run("event-" + i, ...scope, i + 1, ref, now, now);
  finalMessages.push({
    payloadRef: ref,
    digest: payload.contentDigest,
    role: messages[i].role,
    traceSequence: i + 1,
  });
}
const candidate = {
  version: "himawari.legacy-history-import.v1",
  ...config,
  threadId: "thread-rehearsal",
  head: { message_watermark: 1, revision: 0 },
  source: [
    { runId: "run-rehearsal", status: "completed", sequence: 1, partialEvents: 0, finalMessages },
  ],
  history: qualifyLegacyPiHistory([
    { runId: "run-rehearsal", status: "completed", finalizedMessages: messages },
  ]),
};
async function seal(value) {
  const sealed = await protector.protect({
    ownerId: config.ownerId,
    agentId: config.agentId,
    ref: "candidate",
    dataClassification: "private",
    contentType: "application/json",
    plaintext: new TextEncoder().encode(JSON.stringify(value)),
    createdAt: now,
  });
  return { ...sealed, ciphertext: Buffer.from(sealed.ciphertext).toString("base64") };
}

const snapshot = await p.createVerifiedMigrationSnapshot(db, root + "/schema-before.sqlite");
p.applyMigrations(db, await p.loadBundledMigrations(), { snapshot });
db.close();
const options = {
  runtime,
  stateRoot: sourceState,
  config: { ...config, stateRoot: sourceState },
  protector,
  expectedThreadId: candidate.threadId,
};
const Database = require("better-sqlite3");
const counts = () => {
  const read = new Database(sourceState + "/data/product.sqlite", { readonly: true });
  try {
    return {
      snapshots: read
        .prepare(
          "SELECT count(*) AS n FROM run_payload_artifacts WHERE purpose='runtime_history' AND operation_key LIKE 'snapshot:%'",
        )
        .get().n,
      audits: read
        .prepare("SELECT count(*) AS n FROM audit_records WHERE action='owner.history.import'")
        .get().n,
    };
  } finally {
    read.close();
  }
};
const first = await importQualifiedLegacyHistory({ ...options, sealed: await seal(candidate) });
assert(first.passed && first.imported);
const afterFirst = counts();
assert.equal(afterFirst.snapshots, 1);
assert.equal(afterFirst.audits, 1);
const second = await importQualifiedLegacyHistory({ ...options, sealed: await seal(candidate) });
assert(second.passed && !second.imported);
assert.deepEqual(counts(), afterFirst);
const stale = structuredClone(candidate);
stale.head.revision = 123;
await assert.rejects(
  async () => importQualifiedLegacyHistory({ ...options, sealed: await seal(stale) }),
  /IMPORT_THREAD_CHANGED/,
);
const missing = structuredClone(candidate);
missing.source[0].finalMessages[0].digest = "wrong";
await assert.rejects(
  async () => importQualifiedLegacyHistory({ ...options, sealed: await seal(missing) }),
  /IMPORT_SOURCE_UNAVAILABLE/,
);
assert.deepEqual(counts(), afterFirst);
console.log(
  JSON.stringify({
    passed: true,
    testsPassed: 4,
    first,
    repeat: second,
    staleCandidateRejected: true,
    missingSourceRejected: true,
    snapshots: 1,
    importAuditEvents: 1,
    modelCalls: 0,
  }),
);
