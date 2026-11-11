import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadBundledMigrations, openQualifiedDatabase } from "../src/index.ts";
import { SqliteRealEvalOperations } from "../src/sqlite-real-eval-operations.ts";

const directories: string[] = [];
const OWNER = "owner-real-eval";
const AGENT = "agent-real-eval";
const T0 = "2026-11-11T00:00:00.000Z";
const T1 = "2026-11-18T00:00:00.000Z";
const SHA = "b".repeat(64);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function open() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  for (const ref of ["payload-memory", "payload-q1", "payload-q2"])
    database
      .prepare(
        `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type)
         VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:x', 'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
      )
      .run(ref, OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO memory_records (
        id, owner_id, agent_id, revision, status, content_ref, classification,
        source_thread_id, inference, confidence_permille, policy_version, provider_record_id, updated_at
      ) VALUES ('memory-1', ?, ?, 1, 'active', 'payload-memory', 'private', NULL, 0, 900, 'v1', NULL, ?)`,
    )
    .run(OWNER, AGENT, T0);
  const failures: string[] = [];
  const operations = new SqliteRealEvalOperations(
    database,
    (code) => {
      failures.push(code);
      throw new Error(code);
    },
    () => undefined,
  );
  return { database, operations, failures };
}

const scope = { ownerId: OWNER, agentId: AGENT };
const question = (id: string, ref: string, kind = "fact") => ({
  id,
  memoryId: "memory-1",
  memoryRevision: 1,
  kind,
  questionRef: ref,
  questionModel: "eval-model",
  promptSha256: SHA,
  createdAt: T0,
});

describe("[P4-5] real eval store", () => {
  it("adds each memory revision and kind once, lists in order and retires once", async () => {
    const { operations } = await open();
    expect(
      operations.execute("realEval.addQuestion", {
        ...scope,
        question: question("q1", "payload-q1"),
      }),
    ).toBe(true);
    expect(
      operations.execute("realEval.addQuestion", {
        ...scope,
        question: question("q2", "payload-q2"),
      }),
    ).toBe(false);
    expect(
      operations.execute("realEval.addQuestion", {
        ...scope,
        question: question("q2", "payload-q2", "abstain"),
      }),
    ).toBe(true);
    operations.execute("realEval.retireQuestion", {
      ...scope,
      id: "q1",
      reason: "memory_revised",
      at: T1,
    });
    operations.execute("realEval.retireQuestion", {
      ...scope,
      id: "q1",
      reason: "memory_inactive",
      at: T1,
    });
    const listed = operations.execute("realEval.listQuestions", scope) as {
      id: string;
      retiredReason: string | null;
    }[];
    expect(listed.map(({ id, retiredReason }) => [id, retiredReason])).toEqual([
      ["q1", "memory_revised"],
      ["q2", null],
    ]);
  });

  it("refuses a question for a memory owned by someone else", async () => {
    const { operations } = await open();
    expect(
      operations.execute("realEval.addQuestion", {
        ownerId: "other",
        agentId: AGENT,
        question: question("q1", "payload-q1"),
      }),
    ).toBe(false);
  });

  it("rejects malformed questions, retirements and runs before touching the table", async () => {
    const { operations, failures } = await open();
    expect(() =>
      operations.execute("realEval.addQuestion", {
        ...scope,
        question: question("q1", "payload-q1", "secret"),
      }),
    ).toThrow();
    expect(() =>
      operations.execute("realEval.retireQuestion", { ...scope, id: "q1", reason: "x", at: T1 }),
    ).toThrow();
    expect(() =>
      operations.execute("realEval.recordRun", {
        ...scope,
        run: {
          id: "r1",
          startedAt: T0,
          finishedAt: T1,
          outcome: "lucky",
          trigger: "weekly",
          model: "m",
          costMicros: 0,
          summary: {},
        },
      }),
    ).toThrow();
    expect(failures).toEqual([
      "PORT_INVALID_OPERATION",
      "PORT_INVALID_OPERATION",
      "PORT_INVALID_OPERATION",
    ]);
  });

  it("records runs and reads them back newest first with the summary intact", async () => {
    const { operations } = await open();
    for (const [id, startedAt] of [
      ["r1", T0],
      ["r2", T1],
    ] as const)
      operations.execute("realEval.recordRun", {
        ...scope,
        run: {
          id,
          startedAt,
          finishedAt: startedAt,
          outcome: "completed",
          trigger: "weekly",
          model: "eval-model",
          costMicros: 1200,
          summary: { scores: { fixed: { samples: 5 } } },
        },
      });
    const runs = operations.execute("realEval.listRuns", { ...scope, limit: 10 }) as {
      id: string;
      summary: unknown;
    }[];
    expect(runs.map(({ id }) => id)).toEqual(["r2", "r1"]);
    expect(runs[0]?.summary).toEqual({ scores: { fixed: { samples: 5 } } });
  });
});
