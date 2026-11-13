import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MEMORY_SOURCE_REF_MAX_LENGTH } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  countSources,
  renderCounts,
  SOURCE_REF_MAX_LENGTH,
} from "../../scripts/operations/memory-source-report.mjs";
import { repositoryRoot } from "../fixtures/product-path-harness.ts";

const T0 = "2026-11-08T01:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("[P1-1] memory source report", () => {
  it("writes the reminder reference prefix the same way in the page, the script and the writer", async () => {
    const read = (file: string) => readFile(path.join(repositoryRoot, file), "utf8");
    const REMINDER_SOURCE_PREFIX = /REMINDER_SOURCE_PREFIX = "([^"]+)"/.exec(
      await read("packages/gateway-contracts/src/memory-source.ts"),
    )?.[1];
    expect(REMINDER_SOURCE_PREFIX).toBe("memory-content:reminder:");
    const EXTERNAL_PREFIX = /EXTERNAL_PROPOSAL_MEMORY_PREFIX = "([^"]+)"/.exec(
      await read("packages/gateway-contracts/src/memory-source.ts"),
    )?.[1];
    expect(EXTERNAL_PREFIX).toBe("memory:mcp:");
    expect(await read("scripts/operations/memory-source-report.mjs")).toContain(
      `LIKE '${EXTERNAL_PREFIX}%'`,
    );
    expect(await read("apps/agent-service/src/production-mcp-memory-writer.ts")).toContain(
      `EXTERNAL_PROPOSAL_MEMORY_PREFIX = "${EXTERNAL_PREFIX}"`,
    );
    const EXTERNAL_RULE_PREFIX = /EXTERNAL_RULE_MEMORY_PREFIX = "([^"]+)"/.exec(
      await read("packages/gateway-contracts/src/memory-source.ts"),
    )?.[1];
    expect(EXTERNAL_RULE_PREFIX).toBe("memory:rule:mcp:");
    expect(await read("scripts/operations/memory-source-report.mjs")).toContain(
      `LIKE '${EXTERNAL_RULE_PREFIX}%'`,
    );
    expect(await read("apps/agent-service/src/production-mcp-rule-writer.ts")).toContain(
      `EXTERNAL_RULE_MEMORY_PREFIX = "${EXTERNAL_RULE_PREFIX}"`,
    );
    expect(await read("scripts/operations/memory-source-report.mjs")).toContain(
      `NOT LIKE '${REMINDER_SOURCE_PREFIX}%'`,
    );
    expect(await read("apps/agent-service/src/production-reminder-writer.ts")).toContain(
      `\`${REMINDER_SOURCE_PREFIX}\${key}\``,
    );
  });

  it("uses the same reference length limit as the memory page", () => {
    expect(SOURCE_REF_MAX_LENGTH).toBe(MEMORY_SOURCE_REF_MAX_LENGTH);
  });

  it("counts each memory in exactly one source class, as the memory page does", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-memory-source-"));
    directories.push(root);
    const database = openQualifiedDatabase(path.join(root, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
    database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
    for (const thread of ["t1", "t2", "t3", "t4"])
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
          VALUES (?, 'o', 'a', 1, 'open', ?, ?)`,
        )
        .run(thread, T0, T0);
    const payload = (ref: string) =>
      database
        .prepare(
          `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
            content_digest, lifecycle_state, created_at)
          VALUES (?, 'o', 'a', 'private', 'sqlite_blob', x'00', 'digest', 'active', ?)`,
        )
        .run(ref, T0);
    for (const ref of [
      "c",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
      "d1",
      "d2",
      "d3",
      "d4",
      "d5",
      "d6",
      "e1",
      "e2",
    ])
      payload(ref);
    database
      .prepare(
        `INSERT INTO memory_import_batches (id, owner_id, agent_id, source, item_count, created_at)
        VALUES ('b1', 'o', 'a', 'codex', 1, ?)`,
      )
      .run(T0);
    const memory = (id: string, content: string, thread: string | null, status = "active") =>
      database
        .prepare(
          `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref,
            classification, source_thread_id, inference, confidence_permille, policy_version, updated_at)
          VALUES (?, 'o', 'a', 1, ?, ?, 'private', ?, 0, 900, 'p', ?)`,
        )
        .run(id, status, content, thread, T0);
    memory("memory:capture-found", "m1", "t1");
    memory("memory:capture-wrong-thread", "m2", "t2");
    memory("memory:capture-unmatched", "m3", "t1");
    memory("memory:import:b1:0", "m4", null);
    memory("memory:owner:1", "m5", null);
    memory("memory:mcp:proposal-1", "e1", null);
    memory("memory:rule:mcp:proposal-2", "e2", null);
    memory("memory:lost-thread", "m6", null);
    memory("memory:tidy", "m7", null);
    memory("memory:trashed", "m8", "t1", "trashed");
    memory("memory:reminder", "m9", "t1");
    memory("memory:reminder-long", "d1", "t1");
    memory("memory:reminder-mixed", "d2", "t1");
    memory("memory:partial", "d3", "t1");
    memory("memory:in-trash", "d4", "t3");
    memory("memory:being-deleted", "d5", "t4");
    database
      .prepare("UPDATE memory_records SET import_batch_id = 'b1' WHERE id = 'memory:import:b1:0'")
      .run();
    const message = (id: string, thread: string, sequence: number, role: string, ref: string) =>
      database
        .prepare(
          `INSERT INTO thread_messages (id, owner_id, agent_id, thread_id, revision, sequence, role,
            content_ref, classification, committed_at)
          VALUES (?, 'o', 'a', ?, 0, ?, ?, ?, 'private', ?)`,
        )
        .run(id, thread, sequence, role, ref, T0);
    message("msg-1", "t1", 1, "owner", "c");
    message("msg-partial", "t1", 2, "owner", "d1");
    message("msg-trash", "t3", 1, "owner", "d2");
    message("msg-deleting", "t4", 1, "owner", "d3");
    database
      .prepare("UPDATE thread_messages SET message_status = 'partial' WHERE id = 'msg-partial'")
      .run();
    database.prepare("UPDATE threads SET status = 'trashed' WHERE id = 't3'").run();
    database.prepare("UPDATE threads SET status = 'deletion_pending' WHERE id = 't4'").run();
    const provenance = (id: string, ref: string) =>
      database
        .prepare(
          `INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted)
          VALUES (?, 'reference', ?, 0)`,
        )
        .run(id, ref);
    provenance("memory:capture-found", "c");
    provenance("memory:capture-wrong-thread", "c");
    provenance("memory:capture-unmatched", "not-a-message");
    provenance("memory:reminder", "memory-content:reminder:key-1");
    provenance("memory:reminder-long", "memory-content:reminder:key-2");
    provenance("memory:reminder-long", `x${"y".repeat(600)}`);
    provenance("memory:reminder-mixed", "memory-content:reminder:key-3");
    provenance("memory:reminder-mixed", "not-a-reminder");
    provenance("memory:partial", "d1");
    provenance("memory:in-trash", "d2");
    provenance("memory:being-deleted", "d3");
    const event = (id: string, deleted: number) =>
      database
        .prepare(
          `INSERT INTO memory_history_events (memory_id, kind, content_ref, source_deleted, occurred_at)
          VALUES (?, 'created', 'c', ?, ?)`,
        )
        .run(id, deleted, T0);
    event("memory:lost-thread", 1);
    event("memory:tidy", 0);
    const counts = countSources(database);
    database.close();
    expect(counts).toEqual({
      total: 15,
      jump: 1,
      reminder: 2,
      unavailable: 6,
      import: 1,
      owner: 1,
      external: 2,
      deleted: 1,
      tidy: 1,
    });
    expect(renderCounts(counts)).toContain("| 来源已不可查 | 6 |");
  });
});
