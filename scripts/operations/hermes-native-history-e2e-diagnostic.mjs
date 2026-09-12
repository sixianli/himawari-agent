// Bounded read-only diagnostic: export structure and known markers, never raw messages or keys.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const root = "/data/hermes/himawari";
const runtime = `${root}/releases/2026-09-11-control-center/lib/himawari-agent`;
const runs = [
  "run:e4e4913a-0d85-4a88-80e9-0fe68fe7e040",
  "run:8047c3f2-5336-4386-8d64-0f74e1889ddc",
  "run:49a9dac9-20c9-462e-b605-0b992a468a6a",
];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const markers = [
  "最后一条用户消息",
  "本轮请求时间",
  "配置时区",
  "天气",
  "学习资料",
  "植物养护",
  "海风花园",
  "海风书签84",
  "青柠灯塔72",
  "e2e-20260912-note.txt",
  "东京",
  "2026-09-12",
  "2026-09-11",
];
export function summarize(value) {
  const text = JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(text),
    sha256: sha(text),
    markers: markers.filter((s) => text.includes(s)),
    dates: [...new Set(text.match(/2026-09-\d{2}(?:T[\d:.]+Z)?/g) || [])].slice(0, 20),
  };
}
export function facts(value) {
  const result = [];
  const walk = (v, path = "", depth = 0) => {
    if (depth > 14 || result.length > 300) return;
    if (Array.isArray(v)) {
      v.slice(0, 100).forEach((x, i) => {
        walk(x, `${path}[${i}]`, depth + 1);
      });
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (typeof v !== "string") return;
    if (
      /(?:^|\.)(?:phase|status|outcome|kind|operation|errorCode|reasonCode|cleanup|supervision|stopReason)$/.test(
        path,
      ) &&
      /^[a-zA-Z0-9_.:-]{1,100}$/.test(v)
    )
      result.push({ path, value: v });
    const codes = [
      ...new Set(
        v.match(
          /\b(?:RUNTIME|RUN|PORT|SANDBOX|COMMAND|CAPABILITY|PAYLOAD|PI|AUTHORITY|EXECUTION|TOOL)_[A-Z0-9_]{2,100}\b/g,
        ) || [],
      ),
    ];
    if (codes.length) result.push({ path, codes });
  };
  walk(value);
  return result;
}
export async function decodePayload(p, protector, scope) {
  assert(p && p.storage_kind === "sqlite_blob" && p.ciphertext.length < 4000000);
  // SqliteDurableOperations.ensureMetadataPayload creates this exact empty marker.
  if (p.content_type === "application/x-himawari-metadata") {
    assert.equal(p.ciphertext.length, 0);
    assert.equal(p.content_digest, `metadata:${p.ref}`);
    assert.equal(p.encryption_metadata_json, null);
    return { kind: "metadata_reference_only" };
  }
  const encryption = JSON.parse(p.encryption_metadata_json);
  assert(encryption?.algorithm === "aes-256-gcm-envelope-v1", "UNRECOGNIZED_PAYLOAD_ENVELOPE");
  const bytes = await protector.unprotect({
    ownerId: scope[0],
    agentId: scope[1],
    payload: {
      ref: p.ref,
      dataClassification: p.classification,
      contentType: p.content_type,
      contentDigest: p.content_digest,
      createdAt: p.created_at,
      ciphertext: p.ciphertext,
      encryption,
      storage: { kind: "inline" },
    },
  });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
async function main() {
  assert.equal(process.getuid(), 0);
  assert.equal(process.argv.length, 2);
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
  const report = { observedAt: new Date().toISOString(), readOnly: true, modelCalls: 0, runs: [] };
  try {
    for (const runId of runs) {
      const run = db
        .prepare(
          "SELECT id,status,created_at,updated_at FROM runs WHERE owner_id=? AND agent_id=? AND id=?",
        )
        .get(...scope, runId);
      assert(run);
      const item = {
        ...run,
        providers: [],
        checkpoints: [],
        trace: [],
        receipts: [],
        jobs: [],
        coordination: db
          .prepare(
            "SELECT phase,terminal_status,diagnostic_code,updated_at FROM run_coordination_checkpoints WHERE owner_id=? AND agent_id=? AND run_id=?",
          )
          .get(...scope, runId),
      };
      for (const a of db
        .prepare(
          "SELECT payload_ref,created_at FROM run_payload_artifacts WHERE owner_id=? AND agent_id=? AND run_id=? AND purpose='trace' AND operation_key LIKE '%:provider_request:%' ORDER BY created_at",
        )
        .all(...scope, runId)) {
        const request = await payload(a.payload_ref);
        const messages = request.messages ?? request.input ?? [];
        item.providers.push({
          at: a.created_at,
          keys: Object.keys(request),
          model: request.model,
          system: request.system ? summarize(request.system) : null,
          messages: Array.isArray(messages)
            ? messages.map((m, index) => ({
                index,
                role: m.role ?? m.type,
                toolCalls: Array.isArray(m.tool_calls)
                  ? m.tool_calls.map((x) => ({ id: x.id, name: x.function?.name }))
                  : [],
                toolCallId: m.tool_call_id ?? null,
                ...summarize(m.content ?? m),
              }))
            : summarize(messages),
        });
      }
      for (const c of db
        .prepare(
          "SELECT phase,checkpoint_ref,created_at FROM run_checkpoints WHERE owner_id=? AND agent_id=? AND run_id=? ORDER BY revision",
        )
        .all(...scope, runId))
        item.checkpoints.push({
          phase: c.phase,
          at: c.created_at,
          facts: facts(await payload(c.checkpoint_ref)),
        });
      for (const e of db
        .prepare(
          "SELECT event_type,payload_ref,occurred_at FROM trace_events WHERE owner_id=? AND agent_id=? AND run_id=? AND event_type NOT IN ('runtime.message','runtime.activity') ORDER BY sequence",
        )
        .all(...scope, runId)) {
        if (e.payload_ref)
          item.trace.push({
            type: e.event_type,
            at: e.occurred_at,
            facts: facts(await payload(e.payload_ref)),
          });
      }
      item.receipts = db
        .prepare(
          "SELECT operation,invocation_id,worker_run_id,requested_at,deadline_at FROM capability_invocation_receipts WHERE owner_id=? AND agent_id=? AND run_id=? ORDER BY requested_at",
        )
        .all(...scope, runId);
      item.jobs = db
        .prepare(
          "SELECT job_id,started_at,facts_json FROM sandbox_execution_records WHERE owner_id=? AND agent_id=? AND run_id=?",
        )
        .all(...scope, runId)
        .map((j) => ({
          jobId: j.job_id,
          startedAt: j.started_at,
          facts: facts(JSON.parse(j.facts_json)),
        }));
      report.runs.push(item);
    }
  } finally {
    db.close();
  }
  const out = `${root}/qualifications/2026-09-12-native-history-e2e-diagnostic-v2`;
  await mkdir(out, { mode: 0o711 });
  await writeFile(`${out}/summary.json`, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o644,
    flag: "wx",
  });
  console.log("Diagnostic written: " + out + "/summary.json");
}
if (/\/hermes-native-history-e2e-diagnostic(?:-v2)?\.mjs$/.test(process.argv[1] ?? ""))
  await main();
