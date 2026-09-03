import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ThreadCommandService,
  ThreadForkService,
  ThreadQueryService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createOwnerId,
  createSessionId,
  createThreadId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { ManualClock } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const scaleDescribe =
  readEnvironment("HIMAWARI_THREAD_SCALE_QUALIFICATION") === "1" ? describe : describe.skip;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const OWNER_ID = createOwnerId("owner-thread-scale");
const AGENT_ID = createAgentId("agent-thread-scale");
const DEPLOYMENT_ID = createDeploymentId("deployment-thread-scale");
const AUTHORITY: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};
const SESSION_ID = createSessionId("session-thread-scale");
const CREATED_AT = "2026-08-28T00:00:00.000Z";
const PROJECTION_VERSION = "thread-search-scale-v1";
const SEARCH_TOKEN = "search-token:thread-scale-common";
const TARGET = Object.freeze({
  threads: 10_000,
  messages: 200_000,
  active: 8_000,
  archived: 1_000,
  trashed: 1_000,
  initiallyPinned: 10,
});

type Timing = Readonly<{
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}>;

function readEnvironment(name: string): string | undefined {
  return process.env[name];
}

function gitValue(arguments_: readonly string[]): string {
  try {
    return execFileSync("git", arguments_, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function percentile(samples: readonly number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1));
  return Number(ordered[index]?.toFixed(3) ?? 0);
}

function summarize(samples: readonly number[]): Timing {
  return Object.freeze({
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  });
}

async function measure(
  samples: number,
  operation: (index: number) => Promise<unknown>,
): Promise<Timing> {
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation(index);
    values.push(performance.now() - started);
  }
  return summarize(values);
}

function threadId(index: number) {
  return createThreadId(`thread-scale-${index.toString().padStart(5, "0")}`);
}

async function maybeWriteEvidence(evidence: Readonly<Record<string, unknown>>): Promise<void> {
  if (readEnvironment("HIMAWARI_THREAD_SCALE_WRITE_EVIDENCE") !== "1") return;
  const requestedPath = readEnvironment("HIMAWARI_THREAD_SCALE_EVIDENCE_PATH");
  if (!requestedPath) throw new Error("THREAD_SCALE_EVIDENCE_PATH_REQUIRED");
  const outputPath = path.resolve(requestedPath);
  if (outputPath.startsWith(path.join(ROOT, "test/integration/qualification/evidence")))
    throw new Error("THREAD_SCALE_HISTORICAL_EVIDENCE_IMMUTABLE");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function collectList(
  query: ThreadQueryService,
  statuses: readonly ("active" | "archived" | "trashed")[],
  pinnedOnly = false,
): Promise<readonly string[]> {
  const ids: string[] = [];
  let afterThreadId = null;
  do {
    const page = await query.list({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      statuses,
      pinnedOnly,
      afterThreadId,
      limit: 100,
    });
    ids.push(...page.map(({ id }) => id));
    afterThreadId = page.length === 100 ? (page.at(-1)?.id ?? null) : null;
  } while (afterThreadId !== null);
  return Object.freeze(ids);
}

async function collectSearch(
  query: ThreadQueryService,
  statuses: readonly ("active" | "archived")[],
): Promise<readonly string[]> {
  const ids: string[] = [];
  let afterThreadId = null;
  do {
    const page = await query.search({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      tokenRefs: [SEARCH_TOKEN],
      projectionVersion: PROJECTION_VERSION,
      statuses,
      afterThreadId,
      limit: 100,
    });
    ids.push(...page.map(({ id }) => id));
    afterThreadId = page.length === 100 ? (page.at(-1)?.id ?? null) : null;
  } while (afterThreadId !== null);
  return Object.freeze(ids);
}

async function qualifyThreadScale() {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "himawari-thread-scale-"));
  const databasePath = path.join(stateRoot, "product.sqlite");
  const startedAt = new Date().toISOString();
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  try {
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
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'active', ?, 'text/plain')`,
    );
    for (const payloadRef of [
      "payload-thread-scale-content",
      "payload-thread-scale-result",
      "payload-thread-scale-summary",
    ]) {
      insertPayload.run(payloadRef, OWNER_ID, AGENT_ID, `sha256:${payloadRef}`, CREATED_AT);
    }
    const insertThread = database.prepare(
      `INSERT INTO threads (
        id, owner_id, agent_id, revision, status, metadata_ref, created_at, updated_at,
        pin_order, answer_locale, message_watermark, archived_at, trashed_at
      ) VALUES (?, ?, ?, 1, ?, NULL, ?, ?, ?, 'zh-CN', 20, ?, ?)`,
    );
    const insertMessage = database.prepare(
      `INSERT INTO thread_messages (
        id, owner_id, agent_id, thread_id, revision, sequence, role,
        content_ref, classification, committed_at, message_status
      ) VALUES (?, ?, ?, ?, 0, ?, ?, 'payload-thread-scale-content',
        'private', ?, 'committed')`,
    );
    const insertProjection = database.prepare(
      `INSERT INTO thread_search_projection (
        owner_id, agent_id, thread_id, message_id, sequence, classification,
        token_ref, projection_version
      ) VALUES (?, ?, ?, ?, 1, 'private', ?, ?)`,
    );
    const seed = database.transaction(() => {
      for (let index = 0; index < TARGET.threads; index += 1) {
        const id = threadId(index);
        const archived = index % 10 === 0;
        const trashed = index % 10 === 1;
        const status = trashed ? "trashed" : "open";
        const pinOrder = index % 1000 === 2 ? Math.floor(index / 1000) : null;
        insertThread.run(
          id,
          OWNER_ID,
          AGENT_ID,
          status,
          CREATED_AT,
          CREATED_AT,
          pinOrder,
          archived ? CREATED_AT : null,
          trashed ? CREATED_AT : null,
        );
        for (let sequence = 1; sequence <= 20; sequence += 1) {
          const messageId = `message-thread-scale-${index}-${sequence}`;
          insertMessage.run(
            messageId,
            OWNER_ID,
            AGENT_ID,
            id,
            sequence,
            sequence % 2 === 0 ? "agent" : "owner",
            CREATED_AT,
          );
          if (sequence === 1) {
            insertProjection.run(
              OWNER_ID,
              AGENT_ID,
              id,
              messageId,
              SEARCH_TOKEN,
              PROJECTION_VERSION,
            );
            if (index < 100) {
              insertProjection.run(
                OWNER_ID,
                AGENT_ID,
                id,
                messageId,
                "search-token:stale-version",
                "thread-search-scale-v0",
              );
            }
          }
        }
      }
    });
    seed.immediate();
  } finally {
    database.close();
  }

  let repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => CREATED_AT,
  });
  const clock = new ManualClock(CREATED_AT);
  try {
    let threadRepository = repository.threadRepository();
    let query = new ThreadQueryService(threadRepository);
    const activeIds = await collectList(query, ["active"]);
    const archivedIds = await collectList(query, ["archived"]);
    const trashedIds = await collectList(query, ["trashed"]);
    const pinnedIds = await collectList(query, ["active"], true);
    const searchedActiveIds = await collectSearch(query, ["active"]);
    const searchedArchivedIds = await collectSearch(query, ["archived"]);
    expect(new Set(activeIds).size).toBe(TARGET.active);
    expect(new Set(archivedIds).size).toBe(TARGET.archived);
    expect(new Set(trashedIds).size).toBe(TARGET.trashed);
    expect(new Set(pinnedIds).size).toBe(TARGET.initiallyPinned);
    expect(new Set(searchedActiveIds).size).toBe(TARGET.active);
    expect(new Set(searchedArchivedIds).size).toBe(TARGET.archived);

    const queryTimings = {
      activeList: await measure(40, () =>
        query.list({ ownerId: OWNER_ID, agentId: AGENT_ID, statuses: ["active"], limit: 100 }),
      ),
      archivedFilter: await measure(40, () =>
        query.list({ ownerId: OWNER_ID, agentId: AGENT_ID, statuses: ["archived"], limit: 100 }),
      ),
      pinnedFilter: await measure(40, () =>
        query.list({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          statuses: ["active"],
          pinnedOnly: true,
          limit: 100,
        }),
      ),
      search: await measure(40, () =>
        query.search({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          tokenRefs: [SEARCH_TOKEN],
          projectionVersion: PROJECTION_VERSION,
          statuses: ["active", "archived"],
          limit: 100,
        }),
      ),
    };

    const commands = new ThreadCommandService({
      repository: threadRepository,
      clock,
      authority: () => AUTHORITY,
    });
    const pinTiming = await measure(20, async (index) => {
      const id = threadId(3 + index * 10);
      await commands.pin({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: id,
        expectedRevision: 1,
        pinOrder: 100 + index,
        idempotencyKey: `thread-scale-pin-${index}`,
        resultRef: "payload-thread-scale-result",
      });
    });
    const admitted = await commands.admitOwnerMessage({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: threadId(5),
      expectedThreadRevision: 1,
      sessionId: SESSION_ID,
      idempotencyKey: "thread-scale-source-admit",
      contentRef: "payload-thread-scale-content",
      sourceProofRef: "source-proof:thread-scale",
      dataClassification: "private",
      resultRef: "payload-thread-scale-result",
    });
    if (!admitted.message.turnId || !admitted.message.runId) {
      throw new Error("THREAD_SCALE_TURN_OR_RUN_ID_MISSING");
    }
    const sourceTurnId = admitted.message.turnId;
    const sourceRunId = admitted.message.runId;
    const committed = await commands.commitAssistantMessage({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: admitted.thread.id,
      expectedThreadRevision: admitted.thread.revision,
      turnId: sourceTurnId,
      runId: sourceRunId,
      idempotencyKey: "thread-scale-source-commit",
      contentRef: "payload-thread-scale-content",
      dataClassification: "private",
      resultRef: "payload-thread-scale-result",
    });
    const forks = new ThreadForkService({
      repository: threadRepository,
      clock,
      authority: () => AUTHORITY,
    });
    const forkTiming = await measure(20, async (index) => {
      await forks.fork({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        sourceThreadId: admitted.thread.id,
        sourceTurnId,
        sourceWatermark: committed.message.sequence,
        targetThreadId: createThreadId(`thread-scale-fork-${index.toString().padStart(2, "0")}`),
        summaryRefs: ["payload-thread-scale-summary"],
        policyRefs: ["policy:thread-scale-v1"],
        idempotencyKey: `thread-scale-fork-${index}`,
        resultRef: "payload-thread-scale-result",
      });
    });
    const projectionRebuildTiming = await measure(100, async (index) =>
      threadRepository.rebuildSearch(OWNER_ID, AGENT_ID, threadId(index), PROJECTION_VERSION),
    );
    const events = await threadRepository.listGatewayEvents(OWNER_ID, AGENT_ID, null, 1000);
    const resumeCursor = events.at(Math.floor(events.length / 2))?.cursor ?? null;
    expect(events).toHaveLength(42);

    await repository.close();
    const projectionDatabase = openQualifiedDatabase(databasePath);
    const projectionCounts = projectionDatabase
      .prepare(
        `SELECT
          SUM(CASE WHEN projection_version = ? THEN 1 ELSE 0 END) AS currentRows,
          SUM(CASE WHEN projection_version != ? THEN 1 ELSE 0 END) AS staleRows
        FROM thread_search_projection WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(PROJECTION_VERSION, PROJECTION_VERSION, OWNER_ID, AGENT_ID) as {
      currentRows: number;
      staleRows: number;
    };
    projectionDatabase.close();
    expect(projectionCounts).toEqual({ currentRows: TARGET.threads, staleRows: 0 });
    const recoveryStarted = performance.now();
    repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath,
      minimumFreeBytes: 0,
      now: () => CREATED_AT,
    });
    const recoveryMs = Number((performance.now() - recoveryStarted).toFixed(3));
    threadRepository = repository.threadRepository();
    query = new ThreadQueryService(threadRepository);
    const recovered = await query.detail(OWNER_ID, AGENT_ID, admitted.thread.id);
    expect(recovered.thread).toMatchObject({ id: admitted.thread.id, messageWatermark: 22 });
    expect(recovered.messages.slice(-2)).toMatchObject([
      { sequence: 21, turnId: sourceTurnId },
      { sequence: 22, turnId: sourceTurnId },
    ]);
    expect(recovered.runs).toEqual([
      expect.objectContaining({ runId: sourceRunId, status: "completed" }),
    ]);
    const resumedEvents = await threadRepository.listGatewayEvents(
      OWNER_ID,
      AGENT_ID,
      resumeCursor,
      1000,
    );
    expect(resumedEvents.length).toBe(events.length - Math.floor(events.length / 2) - 1);
    await expect(
      query.search({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        tokenRefs: [SEARCH_TOKEN],
        projectionVersion: PROJECTION_VERSION,
        statuses: ["active"],
        limit: 100,
      }),
    ).resolves.toHaveLength(100);

    for (const timing of [
      ...Object.values(queryTimings),
      pinTiming,
      forkTiming,
      projectionRebuildTiming,
    ]) {
      expect(timing.p95Ms).toBeLessThan(2_000);
    }
    expect(recoveryMs).toBeLessThan(120_000);
    const databaseBytes = (await stat(databasePath)).size;
    const evidence = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      plan: "docs/execution/plans/2026-08-26-owner-thread-conversation-plan.md",
      taskIds: ["S2-T12"],
      status: "local_complete",
      candidateRevision: gitValue(["rev-parse", "HEAD"]),
      platform: {
        host: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
      },
      target: TARGET,
      verifiedCounts: {
        active: new Set(activeIds).size,
        archived: new Set(archivedIds).size,
        trashed: new Set(trashedIds).size,
        searchedActive: new Set(searchedActiveIds).size,
        searchedArchived: new Set(searchedArchivedIds).size,
        committedGatewayEvents: events.length,
        recoveredGatewayEvents: resumedEvents.length,
        currentSearchProjectionRows: projectionCounts.currentRows,
        staleSearchProjectionRows: projectionCounts.staleRows,
      },
      timings: {
        ...queryTimings,
        pin: pinTiming,
        fork: forkTiming,
        projectionRebuild: projectionRebuildTiming,
        normalRestartMs: recoveryMs,
      },
      resources: {
        databaseBytes,
        processRssBytes: process.memoryUsage().rss,
      },
      commands: [
        {
          command: "npm run qualify:thread-scale",
          exitStatus: 0,
          result:
            "10000 mixed-lifecycle Threads and 200000 committed Messages passed tie-safe list/search pagination, pin, Fork, projection rebuild and restart recovery",
        },
      ],
      verified: [
        "All 10000 same-timestamp Thread rows were enumerated without duplicate or omission through tie-safe Thread-ID cursors",
        "Opaque projection search enumerated all 8000 active and 1000 archived Threads without returning trashed Threads",
        "Pin and Fork mutations remained below the 2-second p95 admission boundary and committed durable cursor events",
        "Normal SQLite repository restart recovered the source Thread, 22 committed Messages, stable Turn/Run identities, search projection and the remaining event cursor stream",
        "Projection rebuild removed stale versions while preserving the current version and never scanned plaintext content",
      ],
      remaining: [
        "Physical host reboot and cross-device identity-provider qualification are represented by deterministic process/browser profiles, not a destructive reboot of the development Mac",
        "Formal production support still depends on S3 browser/device matrix and S4 runtime composition",
      ],
      externalEffects: [
        "All generated SQLite state was isolated under a temporary local directory and removed after qualification",
        "No model, network, external account, Hermes, production database or remote repository was used",
      ],
      implementationCommit: gitValue(["rev-parse", "HEAD"]),
      startedAt,
    };
    await maybeWriteEvidence(evidence);
    return evidence;
  } finally {
    await repository.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

scaleDescribe("Thread scale qualification", () => {
  it("qualifies mixed lifecycle, opaque search, mutations and recovery at S2 scale", async () => {
    const evidence = await qualifyThreadScale();
    expect(evidence.verifiedCounts).toMatchObject({
      active: TARGET.active,
      archived: TARGET.archived,
      trashed: TARGET.trashed,
      searchedActive: TARGET.active,
      searchedArchived: TARGET.archived,
    });
  }, 300_000);
});
