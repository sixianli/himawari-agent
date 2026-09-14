import { rm } from "node:fs/promises";
import path from "node:path";
import { ApplicationPortError, type PortErrorCode } from "@himawari-agent/application";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";
import { SqliteDurableOperations } from "../../packages/persistence-sqlite/src/sqlite-durable-operations.ts";
import {
  AGENT_ID,
  capability,
  handle,
  OWNER_ID,
  openRepository,
  RUN_ID,
  T0,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

// Exercise the real SQL implementation independently of the already-covered Worker transport.
async function fixture() {
  const f = await openRepository();
  const store = f.repository.capabilityStore(OWNER_ID, AGENT_ID);
  await store.create(capability());
  await store.createExecutionHandle(handle());
  await f.repository.close();
  const database = openQualifiedDatabase(path.join(f.stateRoot, "product.sqlite"));
  const operations = new SqliteDurableOperations(
    database,
    (code, message, details) => {
      throw new ApplicationPortError(code as PortErrorCode, message, details);
    },
    () => {},
  );
  const scope = { ownerId: OWNER_ID, agentId: AGENT_ID, runId: RUN_ID, at: T1 };
  return {
    database,
    operations,
    scope,
    list: () => operations.execute("capability.listRunHandles", scope),
    close: async () => {
      database.close();
      await rm(f.stateRoot, { recursive: true, force: true });
    },
  };
}

describe("active capability handles in durable state", () => {
  it("returns only current, time-valid handles and retains durable records rejected by the projection", async () => {
    const f = await fixture();
    try {
      expect(f.list()).toEqual([handle()]);
      const substitutions: readonly [string, unknown][] = [
        ["ownerId", "other"],
        ["agentId", "other"],
        ["runId", "other"],
        ["revokedAt", T0],
        ["handleVersion", undefined],
        ["handleVersion", "capability-handle.v1"],
        ["expiresAt", "invalid"],
        ["issuedAt", "invalid"],
        ["issuedAt", T2],
        ["expiresAt", T1],
        ["workerEndedAt", T0],
        ["authorityFence", 2],
        ["capabilityVersion", "2.0.0"],
      ];
      for (const [key, value] of substitutions) {
        const record = { ...handle(), [key]: value };
        f.database
          .prepare("UPDATE capability_handles SET record_json=? WHERE id=?")
          .run(JSON.stringify(record), handle().ref);
        expect(f.list(), key).toEqual([]);
        const row = f.database
          .prepare("SELECT record_json AS record FROM capability_handles WHERE id=?")
          .get(handle().ref) as { record: string };
        expect(JSON.parse(row.record), key).toEqual(JSON.parse(JSON.stringify(record)));
      }
      f.database
        .prepare("UPDATE capability_handles SET record_json=? WHERE id=?")
        .run(JSON.stringify(handle()), handle().ref);
      for (const lifecycle of [
        "active",
        "update_proposed",
        "update_approved",
        "disabled",
        "discovered",
      ]) {
        f.database
          .prepare("UPDATE capability_declarations SET record_json=? WHERE id=?")
          .run(JSON.stringify({ ...capability(), lifecycle }), capability().ref);
        expect(f.list(), lifecycle).toEqual(
          ["active", "update_proposed", "update_approved"].includes(lifecycle) ? [handle()] : [],
        );
      }
    } finally {
      await f.close();
    }
  });
  it("returns no handles after the active deployment disappears and rejects an invalid lookup time", async () => {
    const f = await fixture();
    try {
      expect(() =>
        f.operations.execute("capability.listRunHandles", { ...f.scope, at: "invalid" }),
      ).toThrow("Invalid handle lookup time");
      f.database.prepare("UPDATE deployments SET status='retired'").run();
      expect(f.list()).toEqual([]);
      expect(f.database.prepare("SELECT count(*) AS count FROM capability_handles").get()).toEqual({
        count: 1,
      });
    } finally {
      await f.close();
    }
  });
  it("makes revocation idempotent and prevents direct handle consumption", async () => {
    const f = await fixture();
    try {
      const scope = { ...f.scope, handleRef: handle().ref, revokedAt: T1 };
      const revoked = f.operations.execute("capability.revokeHandle", scope);
      expect(revoked).toEqual({ ...handle(), revokedAt: T1 });
      expect(f.operations.execute("capability.revokeHandle", { ...scope, revokedAt: T2 })).toEqual(
        revoked,
      );
      expect(f.list()).toEqual([]);
      expect(() =>
        f.operations.execute("capability.revokeHandle", { ...scope, handleRef: "missing" }),
      ).toThrow("not found");
      expect(() => f.operations.execute("capability.consumeHandle", {})).toThrow(
        "Direct Capability Handle consumption is retired",
      );
      expect(f.operations.execute("capability.getHandle", scope)).toEqual(revoked);
    } finally {
      await f.close();
    }
  });
});
