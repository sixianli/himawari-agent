import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readRouteAuthorization } from "./read-s0-db.mjs";
import * as catalogModule from "./read-s0-db.mjs";
const require = createRequire(`${process.cwd()}/package.json`);
const Database = require("better-sqlite3");
const database = new Database(":memory:");
const digest = "a".repeat(64);
const oldRoot = "/fixture/releases/old/lib/himawari-agent", newRoot = "/fixture/releases/new/lib/himawari-agent";
const oldManifest = { ref: "capability:one", version: "1.0.0", integrity: `sha256:${digest}`, operations: ["read"], scopes: { network: [], filesystem: ["workspace:one"], secrets: [] }, cost: { currency: "USD", maxMicrosPerInvocation: 0 }, permissionRefs: [], health: { status: "healthy" }, runtime: { argv: [oldRoot + "/pi-tools/bin/node", oldRoot + "/runner.js", "host:one", "worker:one"] } };
const catalog = JSON.stringify({ lifecycle: "active", declaration: oldManifest });
database.exec("CREATE TABLE capability_declarations(id TEXT,owner_id TEXT,agent_id TEXT,version TEXT,status TEXT,revision INTEGER,integrity TEXT,record_json TEXT)");
database.prepare("INSERT INTO capability_declarations VALUES(?,?,?,?,?,?,?,?)").run("capability:one", "owner:one", "agent:one", "1.0.0", "active", 1, oldManifest.integrity, catalog);
database.pragma("query_only=ON");
const current = structuredClone(oldManifest);
current.runtime.argv[0] = newRoot + "/pi-tools/bin/node";
current.runtime.argv[1] = newRoot + "/runner.js";
const snapshot = { schemaVersion: "capability-deployment.v1", capabilities: [{ manifest: current, binding: { value: { hostId: "host:one", runtimeRoot: newRoot, runner: { path: newRoot + "/runner.js", sha256: digest } } } }] };
const configuration = { ownerId: "owner:one", agentId: "agent:one", runPolicy: {} };
const checks = [];
function test(name, run) { try { run(); checks.push({ name, passed: true }); } catch(error) { checks.push({ name, passed: false, error: String(error) }); } }
test("old catalog and new signed snapshot normalize only their own runtime prefix", () => {
 const actual = readRouteAuthorization(database, configuration, snapshot, () => digest, oldRoot);
 assert.equal(actual.capabilities[0].declarationInvariantMatchesSnapshot, true);
 assert.equal(actual.capabilities[0].runtimeRoot, newRoot);
 assert.equal(actual.capabilities[0].registryRecordSha256, createHash("sha256").update(catalog).digest("hex"));
});
for (const [name, change] of [["operation", value => value.operations.push("bash")], ["cost", value => value.cost.maxMicrosPerInvocation++], ["runner suffix", value => value.runtime.argv[1] += ".other"], ["prefix lookalike", value => value.runtime.argv[0] = newRoot + "-other/pi-tools/bin/node"]]) test("rejects " + name + " while allowing approved prefix move", () => {
 const changed = structuredClone(snapshot); change(changed.capabilities[0].manifest);
 assert.equal(readRouteAuthorization(database, configuration, changed, () => digest, oldRoot).capabilities[0].declarationInvariantMatchesSnapshot, false);
});
test("default S0 comparison still rejects unapproved prefix movement", () => assert.equal(readRouteAuthorization(database, configuration, snapshot, () => digest).capabilities[0].declarationInvariantMatchesSnapshot, false));
test("real catalog bytes remain unchanged", () => assert.equal(database.prepare("SELECT record_json FROM capability_declarations").get().record_json, catalog));
function readRouteAuthorizationCalls(source) {
 const calls = [];
 let index = 0;
 while (true) {
  const at = source.indexOf("readRouteAuthorization(", index);
  if (at === -1) break;
  index = at + "readRouteAuthorization(".length;
  if (/function\s+$/.test(source.slice(0, at))) continue;
  const args = [];
  let depth = 1, current = "";
  for (let i = index; i < source.length; i += 1) {
   const character = source[i];
   if (character === "(") depth += 1;
   else if (character === ")") { depth -= 1; if (depth === 0) { args.push(current.trim()); break; } }
   else if (character === "," && depth === 1) { args.push(current.trim()); current = ""; continue; }
   current += character;
  }
  calls.push(args);
 }
 return calls;
}
test("production catalog registration root normalizes a catalog registered by the previous change", () => {
 const registrationRoot = "__PKT_OLD_PREFIX__/lib/himawari-agent";
 const snapshotRoot = "/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent";
 const declaration = structuredClone(oldManifest);
 declaration.ref = "capability:production";
 declaration.runtime.argv[0] = registrationRoot + "/pi-tools/bin/node";
 declaration.runtime.argv[1] = registrationRoot + "/runner.js";
 database.pragma("query_only=OFF");
 database.prepare("INSERT INTO capability_declarations VALUES(?,?,?,?,?,?,?,?)").run("capability:production", "owner:one", "agent:one", "1.0.0", "active", 1, declaration.integrity, JSON.stringify({ lifecycle: "active", declaration }));
 database.pragma("query_only=ON");
 const signed = structuredClone(declaration);
 signed.runtime.argv[0] = snapshotRoot + "/pi-tools/bin/node";
 signed.runtime.argv[1] = snapshotRoot + "/runner.js";
 const productionSnapshot = { schemaVersion: "capability-deployment.v1", capabilities: [{ manifest: signed, binding: { value: { hostId: "host:one", runtimeRoot: snapshotRoot, runner: { path: snapshotRoot + "/runner.js", sha256: digest } } } }] };
 assert.equal(readRouteAuthorization(database, configuration, productionSnapshot, () => digest, catalogModule.catalogRegistrationPrefix + "/lib/himawari-agent").capabilities[0].declarationInvariantMatchesSnapshot, true);
 assert.equal(readRouteAuthorization(database, configuration, productionSnapshot, () => digest, snapshotRoot).capabilities[0].declarationInvariantMatchesSnapshot, false);
});
test("production callers pass the catalog registration root", () => {
 const sources = [
  ["read-s0-db.mjs", 1, /^`\$\{catalogRegistrationPrefix\}\/lib\/himawari-agent`$/],
  ["../maintenance/maintenance-common.mjs", 1, /^upgraded \? undefined : catalogRegistrationRuntimeRoot$/],
  ["../systemd/S7-startup-readback.mjs", 0, null],
 ].map(([relative, count, fifthArgument]) => ({ relative, count, fifthArgument, text: readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8") }));
 for (const { relative, count, fifthArgument, text } of sources) {
  const calls = readRouteAuthorizationCalls(text);
  assert.equal(calls.length, count, "unexpected readRouteAuthorization call count in " + relative);
  for (const args of calls) {
   assert.equal(args.length, 5, "readRouteAuthorization call in " + relative + " must pass five arguments");
   assert.match(args[4], fifthArgument, "fifth argument in " + relative + " must be the catalog registration root");
   assert.doesNotMatch(args[4], /oldPrefix|newPrefix/, "fifth argument in " + relative + " must not use a deployment prefix");
  }
 }
 assert.equal(sources[1].text.split("const catalogRegistrationRuntimeRoot = `${catalogRegistrationPrefix}/lib/himawari-agent`;").length - 1, 1, "maintenance-common.mjs must derive the registration root from catalogRegistrationPrefix");
 assert.equal(sources[2].text.split("catalogReader.readPostSwitchAuthorization(binding)").length - 1, 1, "S7-startup-readback.mjs must read the catalog through readPostSwitchAuthorization");
});
test("a first-tools S0 reads the directory grant without any capability snapshot", () => {
 const first = new Database(":memory:");
 first.exec("CREATE TABLE product_state_records(key TEXT,owner_id TEXT,agent_id TEXT,revision INTEGER,value_json TEXT)");
 const grantValue = JSON.stringify({ id: "directory:one", hostId: "host:one", canonicalRootId: "10:20", displayPath: "/fixture/workspace", operations: ["read"], pathPolicy: "canonical", mountPolicy: "same-device", expiresAt: "2999-01-01T00:00:00.000Z", revokedAt: null, revision: 3 });
 first.prepare("INSERT INTO product_state_records VALUES(?,?,?,?,?)").run("host-workspace:directory-grant:directory:one", "owner:one", "agent:one", 7, grantValue);
 first.pragma("query_only=ON");
 const firstConfiguration = { ownerId: "owner:one", agentId: "agent:one", runPolicy: { coding: { capabilityRef: "capability:one", capabilityVersion: "1.0.0", grantId: "directory:one", hostId: "host:one" }, other: { note: "not a route" } } };
 const workspace = { path: "/fixture/workspace", device: "10", inode: "20" };
 const grants = catalogModule.readGrantsWithoutSnapshot(first, firstConfiguration, workspace);
 assert.equal(grants.length, 1);
 assert.deepEqual({ ...grants[0], metadataSha256: undefined }, { routeKey: "coding", grantId: "directory:one", capabilityRef: "capability:one", capabilityVersion: "1.0.0", revision: 3, stateRevision: 7, hostId: "host:one", canonicalRootId: "10:20", displayPath: "/fixture/workspace", device: "10", inode: "20", pathPolicy: "canonical", mountPolicy: "same-device", expiresAt: "2999-01-01T00:00:00.000Z", revokedAt: null, readAllowed: true, hostMatchesRoute: true, rootMatchesSnapshot: true, currentlyUsable: true, metadataSha256: undefined });
 assert.equal(grants[0].metadataSha256, createHash("sha256").update(grantValue).digest("hex"));
 assert.throws(() => catalogModule.readGrantsWithoutSnapshot(first, firstConfiguration, { ...workspace, inode: "21" }), /GRANT_ROOT_NOT_BOUND/);
 assert.throws(() => catalogModule.readGrantsWithoutSnapshot(first, { ...firstConfiguration, runPolicy: {} }, workspace), /GRANT_ROUTE_SET_CHANGED/);
 first.close();
});
database.close();
const report = { passed: checks.every(value => value.passed), realSqlite: true, productionExecuted: false, total: checks.length, checks };
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
