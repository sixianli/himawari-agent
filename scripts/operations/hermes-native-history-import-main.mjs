import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { importQualifiedLegacyHistory } from "./hermes-native-history-import.mjs";

const root = "/data/hermes/himawari";
const runtime = `${root}/releases/2026-09-11-control-center/lib/himawari-agent`;
const work = `${root}/qualifications/2026-09-12-native-history-cutover`;
const threadId = "thread:67f83b5e-f5ab-4313-9efd-94f30e4d97b3";
assert.equal(process.getuid(), 998);
assert.equal(process.argv.length, 3);
assert(["--preflight", "--import"].includes(process.argv[2]));
const config = JSON.parse(await readFile(`${root}/config/production.json`, "utf8"));
assert.equal(config.ownerId, "owner-james-26b80231-cdeb-4ad9-bb02-850541005fff");
assert.equal(config.agentId, "agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3");
assert.equal(config.deploymentId, "deployment-hermes-9e8dc197-146e-4465-bbd1-4246eb2fc96f");
assert.equal(config.stateRoot, `${root}/state`);
const require = createRequire(`${runtime}/package.json`);
const {
  EnvelopePayloadProtector,
  SystemdCredentialSecretSource,
} = require("@himawari-agent/platform-node");
const keys = config.secretReferences.filter((key) => key.purpose === "payload-encryption");
assert.equal(keys.length, 1);
const protector = new EnvelopePayloadProtector({
  keys: new SystemdCredentialSecretSource(`${root}/state/secrets`),
  activeKey: { keyRef: keys[0].ref, kekVersion: keys[0].version, dekVersion: "dek-v1" },
});
const sealed = JSON.parse(await readFile(`${work}/input/candidate.json`, "utf8"));
if (process.argv[2] === "--import") {
  console.log(
    JSON.stringify(
      await importQualifiedLegacyHistory({
        runtime,
        stateRoot: config.stateRoot,
        config,
        sealed,
        protector,
        expectedThreadId: threadId,
      }),
    ),
  );
} else {
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
  assert.equal(candidate.threadId, threadId);
  const Database = require("better-sqlite3");
  const db = new Database(`${config.stateRoot}/data/product.sqlite`, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(db.prepare("SELECT max(sequence) AS n FROM schema_migration_ledger").get().n, 31);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM runs WHERE status NOT IN ('completed','failed','cancelled')",
        )
        .get().n,
      0,
      "CUTOVER_ACTIVE_RUNS",
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM built_in_accounts").get().n,
      0,
      "CUTOVER_IDENTITY_SCOPE_CHANGED",
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT message_watermark,revision FROM threads WHERE id=? AND owner_id=? AND agent_id=?",
        )
        .get(threadId, config.ownerId, config.agentId),
      candidate.head,
      "IMPORT_THREAD_CHANGED",
    );
    const runs = db
      .prepare(
        "SELECT runs.id,runs.status,MIN(m.sequence) AS sequence FROM runs JOIN thread_messages m ON m.run_id=runs.id AND m.owner_id=runs.owner_id AND m.agent_id=runs.agent_id WHERE runs.owner_id=? AND runs.agent_id=? AND runs.thread_id=? AND m.role='owner' GROUP BY runs.id ORDER BY sequence",
      )
      .all(config.ownerId, config.agentId, threadId);
    assert.deepEqual(
      runs,
      candidate.source.map((run) => ({
        id: run.runId,
        status: run.status,
        sequence: run.sequence,
      })),
      "IMPORT_RUNS_CHANGED",
    );
    assert.equal(runs.length, 10);
    assert.equal(candidate.history.messages.length, 34);
    console.log(
      JSON.stringify({
        passed: true,
        schemaSequence: 31,
        activeRuns: 0,
        builtInAccounts: 0,
        historyHeadUnchanged: true,
        coveredRuns: runs.length,
        candidateMessages: 34,
        modelCalls: 0,
      }),
    );
  } finally {
    db.close();
  }
}
