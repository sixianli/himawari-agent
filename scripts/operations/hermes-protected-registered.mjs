import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const root = "/data/hermes/himawari",
  q = root + "/state/deployment";
const config = JSON.parse(await readFile(q + "/production-prepared.json", "utf8"));
const snapshot = JSON.parse(await readFile(config.capabilityDeployment.snapshotPath, "utf8"));
const require = createRequire(
  root + "/releases/2026-09-11-control-center/lib/himawari-agent/package.json",
);
const Database = require("better-sqlite3");
const db = new Database(root + "/state/data/product.sqlite", { readonly: true });
const normalize = (m) => ({ ...m, health: { ...m.health, checkedAt: null }, reviewedAt: null });
for (const entry of snapshot.capabilities) {
  const row = db
    .prepare(
      "SELECT record_json FROM capability_declarations WHERE owner_id = ? AND agent_id = ? AND id = ?",
    )
    .get(config.ownerId, config.agentId, entry.manifest.ref);
  assert(row, "REGISTERED_CAPABILITY_MISSING");
  const record = JSON.parse(row.record_json);
  assert.equal(record.lifecycle, "active");
  assert.deepEqual(
    normalize(record.declaration),
    normalize(entry.manifest),
    "CAPABILITY_SEMANTICS_CHANGED",
  );
}
db.close();
console.log(
  JSON.stringify({ registeredCapabilitiesUnchanged: true, count: snapshot.capabilities.length }),
);
