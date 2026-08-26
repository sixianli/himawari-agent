import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  schemaCatalog,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("SQLite product schema contract", () => {
  it("documents product ownership, lifecycle, encryption, deletion and migration responsibility", () => {
    expect(schemaCatalog.length).toBeGreaterThanOrEqual(40);
    for (const entry of schemaCatalog) {
      expect(entry).toMatchObject({
        table: expect.any(String),
        productPort: expect.any(String),
        lifecycle: expect.any(String),
        encryption: expect.stringMatching(/^(none|metadata_only|payload_reference|ciphertext)$/),
        deletion: expect.any(String),
        migrationOwner: "@himawari-agent/persistence-sqlite",
      });
    }
    expect(new Set(schemaCatalog.map(({ table }) => table)).size).toBe(schemaCatalog.length);
  });

  it("enforces command idempotency, authority fence, outbox, Payload ownership and tombstones", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-sqlite-schema-"));
    temporaryDirectories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());

    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-01', 0)").run();
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('agent-01', 'owner-01', 0)")
      .run();
    database
      .prepare(
        "INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token) VALUES ('deployment-01', 'owner-01', 'agent-01', 0, 'active', 8, 3)",
      )
      .run();
    database
      .prepare(
        "INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest, lifecycle_state, created_at) VALUES ('payload-01', 'owner-01', 'agent-01', 'private', 'sqlite_blob', X'00', 'sha256-payload-01', 'active', ?)",
      )
      .run("2026-08-26T00:00:00.000Z");
    database
      .prepare(
        "INSERT INTO command_results (id, owner_id, agent_id, idempotency_key, command_type, command_fingerprint, deployment_id, authority_epoch, fencing_token, result_ref, state_key, state_revision, committed_at) VALUES ('command-result-01', 'owner-01', 'agent-01', 'idempotency-01', 'thread.message.submit', 'sha256-command-01', 'deployment-01', 8, 3, 'result-01', 'thread:thread-01', 1, ?)",
      )
      .run("2026-08-26T00:00:00.000Z");
    expect(() =>
      database
        .prepare(
          "INSERT INTO command_results (id, owner_id, agent_id, idempotency_key, command_type, command_fingerprint, deployment_id, authority_epoch, fencing_token, result_ref, state_key, state_revision, committed_at) VALUES ('command-result-02', 'owner-01', 'agent-01', 'idempotency-01', 'thread.message.submit', 'sha256-command-01', 'deployment-01', 8, 3, 'result-01', 'thread:thread-01', 1, ?)",
        )
        .run("2026-08-26T00:00:00.000Z"),
    ).toThrow();
    database
      .prepare(
        "INSERT INTO reliable_events (id, owner_id, agent_id, idempotency_key, topic, payload_ref, publication_state, occurred_at) VALUES ('event-01', 'owner-01', 'agent-01', 'event-key-01', 'thread.message_committed', 'payload-01', 'pending', ?)",
      )
      .run("2026-08-26T00:00:00.000Z");
    database
      .prepare(
        "INSERT INTO deletion_tombstones (id, owner_id, agent_id, object_type, object_id, status, requested_at, purge_deadline_at) VALUES ('deletion-01', 'owner-01', 'agent-01', 'payload', 'payload-01', 'pending', ?, ?)",
      )
      .run("2026-08-26T00:01:00.000Z", "2026-09-25T00:01:00.000Z");

    expect(
      database
        .prepare("SELECT publication_state FROM reliable_events WHERE id = 'event-01'")
        .pluck()
        .get(),
    ).toBe("pending");
    expect(
      database
        .prepare("SELECT status FROM deletion_tombstones WHERE id = 'deletion-01'")
        .pluck()
        .get(),
    ).toBe("pending");

    database.close();
  });
});
