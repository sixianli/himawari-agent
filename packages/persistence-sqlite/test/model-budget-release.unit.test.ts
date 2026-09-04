import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteModelBudgetOperations,
} from "../src/index.ts";

const OWNER_ID = "owner-model-budget-release";
const AGENT_ID = "agent-model-budget-release";
const DEPLOYMENT_ID = "deployment-model-budget-release";
const AUTHORITY_LEASE_ID = "lease-model-budget-release";
const RUN_ID = "run-model-budget-release";
const ACCOUNT_ID = `run:${RUN_ID}`;
const OPERATION_KEY = "model-release-call";
const NOW = "2026-09-05T00:00:00.000Z";
const FAR_FUTURE = "2999-12-31T23:59:59.999Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  throw error;
}

async function fixture(status: "reserved" | "started" | "unknown" | "settled" = "reserved") {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-model-budget-release-"));
  temporaryDirectories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases (
        id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
        fencing_token, acquired_at, expires_at, released_at
      ) VALUES (?, ?, ?, ?, 'holder-model-budget-release', 1, 1, ?, ?, NULL)`,
    )
    .run(AUTHORITY_LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW, FAR_FUTURE);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, lifecycle_state, created_at, content_type
      ) VALUES ('payload-model-budget-release', ?, ?, 'private', 'sqlite_blob', X'00',
        'sha256:model-budget-release', 'active', ?, 'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES ('trigger-model-budget-release', ?, ?, NULL, 'trigger-model-budget-release',
        'schedule', 'model-budget-release', 'payload-model-budget-release',
        'proof-model-budget-release', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'session-model-budget-release',
        'trigger-model-budget-release', 1, 'running', ?, ?)`,
    )
    .run(RUN_ID, OWNER_ID, AGENT_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO model_budget_accounts (
        owner_id, agent_id, account_id, parent_kind, run_id, occurrence_id,
        data_classification, reserved_cost_micros, spent_cost_micros, status, revision
      ) VALUES (?, ?, ?, 'run', ?, NULL, 'private', 25, 0, 'active', 0)`,
    )
    .run(OWNER_ID, AGENT_ID, ACCOUNT_ID, RUN_ID);

  const allocationValues =
    status === "unknown"
      ? ["unknown", null, NOW, null, "provider_unresolved"]
      : status === "settled"
        ? ["settled", null, null, NOW, null]
        : [status, status === "started" ? NOW : null, null, null, null];
  database
    .prepare(
      `INSERT INTO model_budget_allocations (
        owner_id, agent_id, account_id, operation_key, model_ref,
        data_classification, estimated_cost_micros, actual_cost_micros,
        status, reserved_at, started_at, observed_at, settled_at, reason_code
      ) VALUES (?, ?, ?, ?, 'model-release-fixture', 'private', 25, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      OWNER_ID,
      AGENT_ID,
      ACCOUNT_ID,
      OPERATION_KEY,
      status === "settled" ? 25 : null,
      allocationValues[0],
      NOW,
      allocationValues[1],
      allocationValues[2],
      allocationValues[3],
      allocationValues[4],
    );

  const operations = new SqliteModelBudgetOperations(database, fail, () => undefined);
  return { database, operations };
}

function request(scope = { ownerId: OWNER_ID, agentId: AGENT_ID }) {
  return {
    scope: {
      ...scope,
      authority: {
        deploymentId: DEPLOYMENT_ID,
        authorityEpoch: 1,
        fencingToken: 1,
      },
      authorityLease: {
        leaseId: AUTHORITY_LEASE_ID,
        fencingToken: 1,
      },
    },
    input: {
      parent: { kind: "run", runId: RUN_ID },
      operationKey: OPERATION_KEY,
      releasedAt: NOW,
    },
  };
}

describe("SQLite model budget reservation release", () => {
  it("atomically releases a reserved allocation and replays idempotently", async () => {
    const resource = await fixture();
    try {
      const released = resource.operations.execute("modelBudget.releaseReserved", request()) as {
        readonly account: { readonly reservedCostMicros: number; readonly revision: number };
        readonly allocation: { readonly status: string };
        readonly replayed: boolean;
      };
      expect(released).toMatchObject({
        account: { reservedCostMicros: 0, revision: 1 },
        allocation: { status: "released" },
        replayed: false,
      });

      const replay = resource.operations.execute(
        "modelBudget.releaseReserved",
        request(),
      ) as typeof released;
      expect(replay).toMatchObject({
        account: { reservedCostMicros: 0, revision: 1 },
        allocation: { status: "released" },
        replayed: true,
      });
      expect(
        resource.database
          .prepare(
            `SELECT status, actual_cost_micros AS actualCostMicros,
              reason_code AS reasonCode FROM model_budget_allocations
             WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND operation_key = ?`,
          )
          .get(OWNER_ID, AGENT_ID, ACCOUNT_ID, OPERATION_KEY),
      ).toEqual({ status: "released", actualCostMicros: null, reasonCode: null });
    } finally {
      resource.database.close();
    }
  });

  it.each(["started", "unknown", "settled"] as const)(
    "does not release a %s allocation or alter its account",
    async (status) => {
      const resource = await fixture(status);
      try {
        expect(() => resource.operations.execute("modelBudget.releaseReserved", request())).toThrow(
          expect.objectContaining({ code: "PORT_CONFLICT" }),
        );
        expect(
          resource.database
            .prepare(
              `SELECT reserved_cost_micros AS reservedCostMicros, revision
               FROM model_budget_accounts WHERE owner_id = ? AND agent_id = ? AND account_id = ?`,
            )
            .get(OWNER_ID, AGENT_ID, ACCOUNT_ID),
        ).toEqual({ reservedCostMicros: 25, revision: 0 });
        expect(
          resource.database
            .prepare(
              `SELECT status FROM model_budget_allocations
               WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND operation_key = ?`,
            )
            .get(OWNER_ID, AGENT_ID, ACCOUNT_ID, OPERATION_KEY),
        ).toEqual({ status });
      } finally {
        resource.database.close();
      }
    },
  );

  it("rejects a different authority scope before changing the reservation", async () => {
    const resource = await fixture();
    try {
      expect(() =>
        resource.operations.execute(
          "modelBudget.releaseReserved",
          request({ ownerId: "owner-other-model-budget-release", agentId: AGENT_ID }),
        ),
      ).toThrow(expect.objectContaining({ code: "PORT_NOT_AUTHORITATIVE" }));
      expect(
        resource.database
          .prepare(
            "SELECT reserved_cost_micros AS reservedCostMicros, status FROM model_budget_accounts WHERE account_id = ?",
          )
          .get(ACCOUNT_ID),
      ).toEqual({ reservedCostMicros: 25, status: "active" });
    } finally {
      resource.database.close();
    }
  });
});
