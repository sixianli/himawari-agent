import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { decodePayload } from "./hermes-three-fixes-model-diagnostic.mjs";
const root = "/data/hermes/himawari";
const runtime = root + "/releases/2026-09-11-control-center/lib/himawari-agent";
const hash = (v) =>
  createHash("sha256")
    .update(JSON.stringify(v) ?? "null")
    .digest("hex");
assert.equal(process.getuid(), 0);
assert.equal(hostname(), "hermes-home");
assert.equal(process.argv.length, 2);
assert.equal(
  createHash("sha256")
    .update(await readFile(new URL("./hermes-three-fixes-model-diagnostic.mjs", import.meta.url)))
    .digest("hex"),
  "977c5291adc22f4b165e530ee60a8ac676012627d2a9d9ad510080ed530f970d",
);
assert.equal(
  JSON.parse(await readFile("/etc/himawari/runtime.json", "utf8")).runtimeDigest,
  "7b05555bbb12cb281d182c3c91d809f40b1dad2ac6c0e466799a051d2ffe57bd",
);
const require = createRequire(`${runtime}/package.json`);
const { EnvelopePayloadProtector } = require("@himawari-agent/platform-node");
const Database = require("better-sqlite3");
const config = JSON.parse(await readFile(`${root}/config/production.json`, "utf8"));
assert.equal(config.ownerId, "owner-james-26b80231-cdeb-4ad9-bb02-850541005fff");
assert.equal(config.agentId, "agent-himawari-626217e1-dcd6-464f-9758-72c5b5b638b3");
const keys = config.secretReferences.filter((x) => x.purpose === "payload-encryption");
assert.equal(keys.length, 1);
const key = keys[0];
assert(/^[a-zA-Z0-9._-]+$/.test(key.ref) && /^[a-zA-Z0-9._-]+$/.test(key.version));
const protector = new EnvelopePayloadProtector({
  keys: {
    resolve: async (ref, version) => {
      assert.equal(ref, key.ref);
      assert.equal(version, key.version);
      const raw = await readFile(`${root}/state/secrets/${ref}.${version}`);
      const text = raw.toString().trim();
      const bytes = /^[A-Za-z0-9+/]{43}=$/.test(text)
        ? Buffer.from(text, "base64")
        : /^[a-f0-9]{64}$/i.test(text)
          ? Buffer.from(text, "hex")
          : raw;
      assert.equal(bytes.length, 32);
      return bytes;
    },
  },
  activeKey: { keyRef: key.ref, kekVersion: key.version, dekVersion: "dek-v1" },
});
const db = new Database(`${root}/state/data/product.sqlite`, {
  readonly: true,
  fileMustExist: true,
});
db.pragma("query_only = ON");
const scope = [config.ownerId, config.agentId];
const payload = async (ref) => {
  const p = db
    .prepare(
      "SELECT * FROM payloads WHERE owner_id=? AND agent_id=? AND ref=? AND lifecycle_state='active'",
    )
    .get(...scope, ref);
  return decodePayload(p, protector, scope);
};
const runId = "run:2199cbdf-b1a1-42e1-9d81-d8105dc44d03";
try {
  const run = db
    .prepare("SELECT thread_id,status FROM runs WHERE owner_id=? AND agent_id=? AND id=?")
    .get(...scope, runId);
  assert.equal(run.thread_id, "thread:63599620-84b5-44d5-adc3-61c65cc83041");
  const refs = db
    .prepare(
      "SELECT operation_key,payload_ref FROM run_payload_artifacts WHERE owner_id=? AND agent_id=? AND run_id=? AND purpose='trace' ORDER BY created_at",
    )
    .all(...scope, runId);
  const report = {
    runId,
    status: run.status,
    readOnly: true,
    modelCalls: 0,
    results: [],
    continuations: [],
  };
  const seen = new Set();
  for (const ref of refs) {
    if (ref.operation_key.startsWith("runtime-continuation:")) {
      const v = await payload(ref.payload_ref);
      report.continuations.push({
        toolProgress: v.value?.toolProgress,
        batchKeys: Object.keys(v.value?.batch ?? {}),
      });
    } else if (ref.operation_key.includes(":tool_result:")) {
      const v = await payload(ref.payload_ref);
      if (seen.has(v.toolCallId)) continue;
      seen.add(v.toolCallId);
      const text = v.result?.content?.[0]?.text;
      let envelope;
      try {
        envelope = JSON.parse(text);
      } catch {}
      report.results.push({
        toolCallId: v.toolCallId,
        toolName: v.toolName,
        isError: v.isError,
        schemaVersion: envelope?.schemaVersion,
        envelopeTool: envelope?.tool,
        sourceCallIdMatches: envelope?.source?.toolCallId === v.toolCallId,
        contentHash: hash(envelope?.content ?? text),
        fieldHashes: envelope
          ? Object.fromEntries(
              Object.entries(envelope)
                .filter(([k]) => k !== "source")
                .map(([k, v]) => [k, hash(v)]),
            )
          : null,
        sourceHashes: envelope?.source
          ? Object.fromEntries(Object.entries(envelope.source).map(([k, v]) => [k, hash(v)]))
          : null,
      });
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
