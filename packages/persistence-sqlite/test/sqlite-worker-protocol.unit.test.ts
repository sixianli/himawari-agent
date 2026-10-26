import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, loadBundledMigrations } from "../src/migration-engine.js";

const ipc = vi.hoisted(() => ({
  configuration: {
    databasePath: "",
    writerSequence: 0,
    busyTimeoutMs: 1,
    minimumFreeBytes: 0,
    warningFreeBytes: 0,
  },
  on: vi.fn(),
  postMessage: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  workerData: ipc.configuration,
  parentPort: { on: ipc.on, postMessage: ipc.postMessage, close: ipc.close },
}));
let directory: string;
let listener: ((request: { id: number; operation: string; payload: unknown }) => void) | undefined;
let sequence = 0;
function request(operation: string, payload: unknown = {}) {
  if (!listener) throw new Error("Worker message listener is unavailable");
  const id = ++sequence;
  listener({ id, operation, payload });
  const response = ipc.postMessage.mock.calls.at(-1)?.[0];
  expect(response?.id).toBe(id);
  return response;
}
beforeEach(async () => {
  listener = undefined;
  vi.resetModules();
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "himawari-worker-contract-"));
  ipc.configuration.databasePath = path.join(directory, "state.sqlite");
  const database = new Database(ipc.configuration.databasePath);
  applyMigrations(database, await loadBundledMigrations());
  ipc.configuration.writerSequence = Number(
    database
      .prepare("SELECT value FROM schema_metadata WHERE key='current_sequence'")
      .pluck()
      .get(),
  );
  database.prepare("INSERT INTO owners(id,revision) VALUES ('owner',0)").run();
  database.prepare("INSERT INTO agents(id,owner_id,revision) VALUES ('agent','owner',0)").run();
  database
    .prepare(
      "INSERT INTO deployments(id,owner_id,agent_id,revision,status,authority_epoch,fencing_token) VALUES ('deployment','owner','agent',0,'active',1,1)",
    )
    .run();
  database.close();
  await import("../src/sqlite-worker.ts");
  listener = ipc.on.mock.calls.find(([event]) => event === "message")?.[1];
  expect(listener).toBeTypeOf("function");
});
afterEach(async () => {
  if (listener) request("close");
  await rm(directory, { recursive: true, force: true });
});
const recovery = () => ({
  scope: {
    ownerId: "owner",
    agentId: "agent",
    authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
    authorityLease: { leaseId: "lease", fencingToken: 1 },
  },
  now: "2026-09-14T00:00:00.000Z",
});
function change(value: Record<string, unknown>, field: string, replacement: unknown) {
  const copy = structuredClone(value);
  const keys = field.split(".");
  const last = keys.pop();
  if (!last) throw new Error("Expected fixture field");
  let parent = copy;
  for (const key of keys) parent = parent[key] as Record<string, unknown>;
  parent[last] = replacement;
  return copy;
}

const AUTHORITY_TABLES = [
  "grants",
  "approval_requests",
  "authorization_reservations",
  "authorization_usage",
  "capability_declarations",
  "capability_handles",
  "product_state_records",
];

describe("[NL-4] authority revision counter", () => {
  it("[NL-4] keeps an insert, update and delete trigger on every authority table after all migrations", () => {
    const database = new Database(ipc.configuration.databasePath, { readonly: true });
    try {
      const triggers = database
        .prepare("SELECT tbl_name, name FROM sqlite_master WHERE type = 'trigger'")
        .all() as { tbl_name: string; name: string }[];
      for (const table of AUTHORITY_TABLES)
        for (const operation of ["insert", "update", "delete"])
          expect(triggers).toContainEqual({
            tbl_name: table,
            name: `authority_revision_${table}_${operation}`,
          });
    } finally {
      database.close();
    }
  });

  it("[NL-4] raises the counter on authority writes and leaves it on unrelated writes", () => {
    expect(request("readAuthorityRevision")).toMatchObject({ ok: true, value: 0 });
    const writer = new Database(ipc.configuration.databasePath);
    try {
      writer.prepare("INSERT INTO owners (id, revision) VALUES ('nl4-owner', 0)").run();
      writer
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('nl4-agent', 'nl4-owner', 0)")
        .run();
      expect(request("readAuthorityRevision")).toMatchObject({ ok: true, value: 0 });
      writer
        .prepare(
          "INSERT INTO product_state_records (key, owner_id, agent_id, revision, value_json, updated_at) VALUES ('setting', 'nl4-owner', 'nl4-agent', 1, '{}', '2026-10-26T00:00:00.000Z')",
        )
        .run();
      expect(request("readAuthorityRevision")).toMatchObject({ ok: true, value: 1 });
      writer.prepare("UPDATE product_state_records SET revision = 2 WHERE key = 'setting'").run();
      writer.prepare("DELETE FROM product_state_records WHERE key = 'setting'").run();
    } finally {
      writer.close();
    }
    expect(request("readAuthorityRevision")).toMatchObject({ ok: true, value: 3 });
  });
});

describe("SQLite Worker request and failure protocol", () => {
  it("acknowledges readiness and serializes an empty durable read", () => {
    expect(request("ready")).toMatchObject({
      ok: true,
      value: { writerSequence: ipc.configuration.writerSequence },
    });
    expect(request("read", { key: "missing" })).toMatchObject({ ok: true, value: undefined });
    expect(request("listPending", { limit: 10 })).toMatchObject({ ok: true, value: [] });
    expect(request("status")).toMatchObject({
      ok: true,
      value: { storageMode: "normal", busyTimeoutMs: 1, outboxPending: 0 },
    });
  });
  it.each([null, [], "payload"])("rejects malformed recovery envelope %j", (payload) => {
    expect(request("recovery.run", payload)).toMatchObject({
      ok: false,
      error: {
        kind: "application",
        code: "PORT_NOT_AUTHORITATIVE",
        message: expect.stringContaining("payload"),
      },
    });
  });
  it.each([
    ["scope", null, "scope"],
    ["scope.authority", [], "authority"],
    ["scope.authorityLease", null, "authorityLease"],
    ["scope.authority.fencingToken", 0, "fencingToken"],
    ["scope.authorityLease.fencingToken", 1.5, "fencingToken"],
    ["scope.authorityLease.fencingToken", 2, "fences do not match"],
    ["scope.ownerId", "", "ownerId"],
    ["scope.agentId", 1, "agentId"],
    ["scope.authority.deploymentId", "", "deploymentId"],
    ["scope.authority.authorityEpoch", 0, "authorityEpoch"],
    ["scope.authorityLease.leaseId", "", "leaseId"],
    ["now", "", "now"],
    ["now", "invalid", "timestamp"],
  ])(
    "rejects incomplete recovery identity %s without modifying persisted state",
    (field, value, message) => {
      expect(request("recovery.run", change(recovery(), field as string, value))).toMatchObject({
        ok: false,
        error: {
          kind: "application",
          code: "PORT_NOT_AUTHORITATIVE",
          message: expect.stringContaining(message as string),
        },
      });
      const database = new Database(ipc.configuration.databasePath, { readonly: true });
      try {
        expect(
          database.prepare("SELECT revision FROM deployments WHERE id='deployment'").get(),
        ).toEqual({ revision: 0 });
      } finally {
        database.close();
      }
    },
  );
  it("reports stale deployment fences using the application error protocol", () => {
    expect(
      request("deployment.assertCurrent", {
        fence: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 2 },
      }),
    ).toMatchObject({ ok: false, error: { kind: "application", code: "PORT_NOT_AUTHORITATIVE" } });
    expect(request("deployment.read", { deploymentId: "deployment" })).toMatchObject({
      ok: true,
      value: { fencingToken: 1, revision: 0 },
    });
  });
  it("reports malformed operation payloads as persistence errors without killing the channel", () => {
    expect(request("read", null)).toMatchObject({
      ok: false,
      error: { kind: "persistence", code: "SQLITE_WORKER_ERROR" },
    });
    expect(request("ready")).toMatchObject({ ok: true });
  });
  it("turns a real SQLite writer lock into a retryable conflict", () => {
    const holder = new Database(ipc.configuration.databasePath);
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect(
        request("deployment.save", {
          deployment: {
            id: "deployment",
            ownerId: "owner",
            agentId: "agent",
            revision: 1,
            status: "active",
            authorityEpoch: 1,
            fencingToken: 1,
            transferId: null,
          },
          expectedRevision: 0,
        }),
      ).toMatchObject({
        ok: false,
        error: {
          kind: "application",
          code: "PORT_CONFLICT",
          message: "SQLite writer remained busy",
          details: { sqliteCode: "SQLITE_BUSY" },
        },
      });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(request("deployment.read", { deploymentId: "deployment" })).toMatchObject({
      ok: true,
      value: { revision: 0 },
    });
  });
});
