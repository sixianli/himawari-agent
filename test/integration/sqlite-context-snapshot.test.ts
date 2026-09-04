import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ThreadCommandService, type ThreadContextSnapshotQuery } from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createMessageId,
  createOwnerId,
  createSessionId,
  createThreadId,
  type ProductAuthorityFence,
  type RunId,
} from "@himawari-agent/domain";
import {
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-context-snapshot");
const AGENT_ID = createAgentId("agent-context-snapshot");
const DEPLOYMENT_ID = createDeploymentId("deployment-context-snapshot");
const LEASE_ID = createAuthorityLeaseId("lease-context-snapshot");
const AUTHORITY: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};
const CLOCK = new ManualClock("2026-09-04T00:00:00.000Z");
const repositories: SqliteProductStateRepository[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-context-snapshot-"));
  roots.push(root);
  const databasePath = path.join(root, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments
       (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
       VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases
       (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
        fencing_token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, 'context-snapshot-test', 1, 1, ?, '2026-09-05T00:00:00.000Z')`,
    )
    .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, CLOCK.now());
  const insertPayload = database.prepare(
    `INSERT INTO payloads
     (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, lifecycle_state, created_at)
     VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'active', ?)`,
  );
  for (const ref of [
    "payload-thread-create",
    "payload-result",
    "payload-message-1",
    "payload-message-2",
    "payload-message-3",
  ]) {
    insertPayload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, CLOCK.now());
  }
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot: root,
    databasePath,
    minimumFreeBytes: 0,
    now: () => CLOCK.now(),
  });
  repositories.push(repository);
  const commands = new ThreadCommandService({
    repository: repository.threadRepository(),
    clock: CLOCK,
    authority: () => AUTHORITY,
  });
  const created = await commands.create({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: createThreadId("thread-context-snapshot"),
    idempotencyKey: "context-snapshot-create",
    resultRef: "payload-thread-create",
  });
  const admissions = [];
  let revision = created.thread.revision;
  for (const [index, messageRef] of [
    "payload-message-1",
    "payload-message-2",
    "payload-message-3",
  ].entries()) {
    CLOCK.advance(1_000);
    const admitted = await commands.admitOwnerMessage({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: created.thread.id,
      expectedThreadRevision: revision,
      sessionId: createSessionId("session-context-snapshot"),
      idempotencyKey: `context-snapshot-message-${index + 1}`,
      contentRef: messageRef,
      sourceProofRef: `proof:${index + 1}`,
      dataClassification: "private",
      resultRef: "payload-result",
      messageId: createMessageId(`message-context-snapshot-${index + 1}`),
      occurredAt: CLOCK.now(),
    });
    revision = admitted.thread.revision;
    admissions.push(admitted);
  }
  return { databasePath, repository, threadId: created.thread.id, admissions };
}

function query(
  threadId: ReturnType<typeof createThreadId>,
  runId: RunId,
): ThreadContextSnapshotQuery {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId,
    runId,
    afterSequence: 0,
    limit: 1000,
  };
}

describe("SQLite context snapshot", () => {
  it("uses trigger sequence as the causal boundary and keeps a recent bounded window", async () => {
    const setup = await fixture();
    const thread = setup.repository.threadRepository();
    const first = setup.admissions[0];
    const second = setup.admissions[1];
    const third = setup.admissions[2];
    if (!first || !second || !third) throw new Error("Expected three admitted messages");

    const firstSnapshot = await thread.readContextSnapshot(
      query(setup.threadId, first.message.runId as RunId),
    );
    const secondSnapshot = await thread.readContextSnapshot(
      query(setup.threadId, second.message.runId as RunId),
    );
    const recentSnapshot = await thread.readContextSnapshot({
      ...query(setup.threadId, third.message.runId as RunId),
      limit: 1,
    });

    expect(firstSnapshot?.sourceWatermark).toBe(0);
    expect(firstSnapshot?.messages).toEqual([]);
    expect(secondSnapshot?.sourceWatermark).toBe(1);
    expect(secondSnapshot?.messages.map(({ id }) => id)).toEqual([first.message.id]);
    expect(recentSnapshot?.sourceWatermark).toBe(2);
    expect(recentSnapshot?.messages.map(({ id }) => id)).toEqual([second.message.id]);
  });

  it("fails closed when a user trigger no longer resolves to its committed message", async () => {
    const setup = await fixture();
    const first = setup.admissions[0];
    if (!first || !first.message.runId) throw new Error("Expected first Run");
    const database = openQualifiedDatabase(setup.databasePath);
    database
      .prepare(
        "UPDATE triggers SET source_id = 'missing-message' WHERE id = (SELECT trigger_id FROM runs WHERE id = ?)",
      )
      .run(first.message.runId);
    database.close();

    await expect(
      setup.repository
        .threadRepository()
        .readContextSnapshot(query(setup.threadId, first.message.runId as RunId)),
    ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  });
});
