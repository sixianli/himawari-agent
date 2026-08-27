import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  PORT_ERROR_CODES,
  type AuthorityLeasePort,
  type ClockPort,
  type CommitStateAndEventsInput,
} from "@himawari-agent/application";
import {
  activateDeployment,
  createAgent,
  createAgentAuthorityLease,
  createAgentId,
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createOwner,
  createOwnerId,
  createTransferId,
  type DeploymentAuthorityState,
  retireDeployment,
} from "@himawari-agent/domain";
import {
  SQLITE_PERSISTENCE_ERROR_CODES,
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  authorityLeasePortConformance,
  productStateRepositoryPortConformance,
} from "@himawari-agent/testing/conformance";
import { afterEach, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];
const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/sqlite-transaction-child.test.ts", import.meta.url),
);
const FIXTURE_CONFIG_PATH = fileURLToPath(
  new URL("../fixtures/vitest.sqlite-crash.config.ts", import.meta.url),
);
const VITEST_PATH = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function newStateRoot(prefix = "himawari-sqlite-product-") {
  const stateRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(stateRoot);
  return { stateRoot, databasePath: path.join(stateRoot, "product.sqlite") };
}

async function seedAuthority(input: {
  databasePath: string;
  ownerId: string;
  agentId: string;
  leaseId: string;
  payloadRefs: readonly string[];
  deploymentStatus?: "inactive_ready" | "active" | "retired_pending_transfer" | "retired";
  authorityEpoch?: number;
  fencingToken?: number;
  insertLease?: boolean;
}) {
  const database = openQualifiedDatabase(input.databasePath);
  applyMigrations(database, await loadBundledMigrations());
  const authorityEpoch = input.authorityEpoch ?? 1;
  const fencingToken = input.fencingToken ?? 1;
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(input.ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(input.agentId, input.ownerId);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      `deployment:${input.agentId}`,
      input.ownerId,
      input.agentId,
      input.deploymentStatus ?? "active",
      authorityEpoch,
      fencingToken,
    );
  if (input.insertLease ?? true) {
    database
      .prepare(
        `INSERT INTO authority_leases (
          id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
          fencing_token, acquired_at, expires_at
        ) VALUES (?, ?, ?, ?, 'holder-sqlite', ?, ?, ?, ?)`,
      )
      .run(
        input.leaseId,
        input.ownerId,
        input.agentId,
        `deployment:${input.agentId}`,
        authorityEpoch,
        fencingToken,
        "2026-08-26T00:00:00.000Z",
        "2999-12-31T23:59:59.999Z",
      );
  }
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, lifecycle_state, created_at
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'active', ?)`,
  );
  for (const payloadRef of input.payloadRefs) {
    insertPayload.run(
      payloadRef,
      input.ownerId,
      input.agentId,
      `sha256:${payloadRef}`,
      "2026-08-26T00:00:00.000Z",
    );
  }
  database.close();
}

productStateRepositoryPortConformance({
  create: async ({ ownerId, agentId }) => {
    const paths = await newStateRoot();
    const leaseId = createAuthorityLeaseId("lease-product-state-conformance");
    await seedAuthority({
      databasePath: paths.databasePath,
      ownerId,
      agentId,
      leaseId,
      payloadRefs: ["payload-event-conformance-01", "payload-event-conformance-02"],
    });
    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => "2026-08-26T00:00:00.000Z",
    });
    return { repository, authority: { leaseId, fencingToken: 1 } };
  },
  dispose: ({ repository }) => (repository as SqliteProductStateRepository).close(),
});

const authorityRepositories = new WeakMap<object, SqliteProductStateRepository>();
authorityLeasePortConformance({
  create: async (clock) => {
    const paths = await newStateRoot("himawari-sqlite-authority-");
    await seedAuthority({
      databasePath: paths.databasePath,
      ownerId: "owner-conformance",
      agentId: "agent-conformance",
      leaseId: "unused-authority-lease",
      payloadRefs: [],
      fencingToken: 0,
      insertLease: false,
    });
    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    const port = repository.authorityLeasePort(clock);
    authorityRepositories.set(port, repository);
    return port;
  },
  dispose: async (port: AuthorityLeasePort) => {
    await authorityRepositories.get(port)?.close();
  },
});

function commitInput(suffix: string): CommitStateAndEventsInput {
  const idempotencyKey = createIdempotencyKey(`command-sqlite-${suffix}`);
  return {
    command: {
      ownerId: createOwnerId("owner-sqlite-integration"),
      agentId: createAgentId("agent-sqlite-integration"),
      idempotencyKey,
      commandType: "run.transition",
      commandFingerprint: `run.transition:${suffix}`,
      authority: {
        leaseId: createAuthorityLeaseId("lease-sqlite-integration"),
        fencingToken: 1,
      },
    },
    state: {
      key: `run:sqlite-${suffix}`,
      expectedRevision: null,
      value: { status: "accepted", suffix },
    },
    events: [
      {
        id: `event-sqlite-${suffix}`,
        idempotencyKey,
        topic: "run.accepted",
        payloadRef: `payload-sqlite-${suffix}`,
        occurredAt: "2026-08-26T00:00:00.000Z",
      },
    ],
    resultRef: `run:sqlite-${suffix}`,
    committedAt: "2026-08-26T00:00:00.000Z",
  };
}

async function integrationRepository(
  suffix: string,
  options: Parameters<typeof SqliteProductStateRepository.open>[0] = { stateRoot: "unused" },
) {
  const paths = await newStateRoot();
  await seedAuthority({
    databasePath: paths.databasePath,
    ownerId: "owner-sqlite-integration",
    agentId: "agent-sqlite-integration",
    leaseId: "lease-sqlite-integration",
    payloadRefs: [`payload-sqlite-${suffix}`],
  });
  const repository = await SqliteProductStateRepository.open({
    ...paths,
    minimumFreeBytes: 0,
    now: () => "2026-08-26T00:00:00.000Z",
    ...options,
    stateRoot: paths.stateRoot,
    databasePath: paths.databasePath,
  });
  return { ...paths, repository };
}

describe("SQLite product-state transaction boundary", () => {
  it("persists deployment lifecycle and permanently fences retired deployments", async () => {
    const paths = await newStateRoot("himawari-sqlite-deployment-");
    const database = openQualifiedDatabase(paths.databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-deployment', 0)").run();
    database
      .prepare(
        "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-deployment', 'owner-deployment', 0)",
      )
      .run();
    database.close();
    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
    });
    const port = repository.deploymentAuthorityPort();
    const inactive: DeploymentAuthorityState = {
      id: createDeploymentId("deployment-lifecycle"),
      ownerId: createOwnerId("owner-deployment"),
      agentId: createAgentId("agent-deployment"),
      revision: 0,
      status: "inactive_ready",
      authorityEpoch: 7,
      fencingToken: 0,
      transferId: createTransferId("transfer-deployment"),
    };
    expect(await port.save(inactive, 0)).toEqual(inactive);
    const active = activateDeployment(inactive, { authorityEpoch: 8, fencingToken: 1 });
    expect(await port.save(active, 0)).toEqual(active);
    await expect(
      port.assertCurrent({
        deploymentId: active.id,
        authorityEpoch: 8,
        fencingToken: 1,
      }),
    ).resolves.toEqual(active);
    const retiring = retireDeployment(active, "retired_pending_transfer");
    const retired = retireDeployment(retiring, "retired");
    await port.save(retiring, 1);
    await port.save(retired, 2);
    await expect(
      port.assertCurrent({
        deploymentId: retired.id,
        authorityEpoch: 8,
        fencingToken: 1,
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    await expect(port.save({ ...active, revision: 4 }, 3)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.CONFLICT,
    });
    expect(await port.read(retired.id)).toEqual(retired);
    await repository.close();
  });

  it("uses a persisted lease to authorize the product transaction", async () => {
    const paths = await newStateRoot("himawari-sqlite-lease-commit-");
    await seedAuthority({
      databasePath: paths.databasePath,
      ownerId: "owner-sqlite-integration",
      agentId: "agent-sqlite-integration",
      leaseId: "unused-authority-lease",
      payloadRefs: ["payload-sqlite-persisted-lease", "payload-sqlite-stale-lease"],
      insertLease: false,
    });
    const clock: ClockPort = { now: () => "2026-08-26T00:00:00.000Z" };
    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    const owner = createOwner(createOwnerId("owner-sqlite-integration"));
    const agent = createAgent({ id: createAgentId("agent-sqlite-integration"), owner });
    const lease = createAgentAuthorityLease({
      id: createAuthorityLeaseId("lease-sqlite-integration"),
      agent,
      holderId: createAuthorityHolderId("holder-sqlite-integration"),
    });
    const claimed = await repository.authorityLeasePort(clock).claim(lease, 60_000);
    expect(claimed.fencingToken).toBe(1);
    await expect(
      repository.commitStateAndEvents(commitInput("persisted-lease")),
    ).resolves.toMatchObject({ replayed: false, state: { revision: 1 } });
    await repository.authorityLeasePort(clock).release(lease.id);
    await expect(repository.commitStateAndEvents(commitInput("stale-lease"))).rejects.toMatchObject(
      {
        code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      },
    );
    await repository.close();
  });

  it("runs synchronous driver work outside the service event loop and serializes writers", async () => {
    const { repository } = await integrationRepository("isolated", {
      stateRoot: "unused",
      qualification: { holdBeforeCommitMs: 250 },
    });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    const input = commitInput("isolated");
    const [first, second] = await Promise.all([
      repository.commitStateAndEvents(input),
      repository.commitStateAndEvents(input),
    ]);
    clearInterval(timer);

    expect(ticks).toBeGreaterThan(10);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const status = await repository.operationalStatus();
    expect(status).toMatchObject({
      busyTimeoutMs: 5000,
      queuedWriters: 0,
      maxObservedQueuedWriters: 2,
    });
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(status.walBytes).toBeGreaterThanOrEqual(0);
    expect(status.lastTransactionDurationMs).toBeGreaterThan(0);
    await repository.close();
  });

  it("holds one recoverable state-root lock", async () => {
    const { stateRoot, databasePath, repository } = await integrationRepository("lock");
    await expect(
      SqliteProductStateRepository.open({ stateRoot, databasePath, minimumFreeBytes: 0 }),
    ).rejects.toMatchObject({ code: SQLITE_PERSISTENCE_ERROR_CODES.STATE_ROOT_LOCKED });
    await repository.close();

    const reopened = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath,
      minimumFreeBytes: 0,
    });
    await reopened.close();
  });

  it("rejects inactive deployments, stale epochs and stale fencing tokens", async () => {
    const paths = await newStateRoot();
    await seedAuthority({
      databasePath: paths.databasePath,
      ownerId: "owner-sqlite-integration",
      agentId: "agent-sqlite-integration",
      leaseId: "lease-sqlite-integration",
      payloadRefs: ["payload-sqlite-authority"],
      deploymentStatus: "inactive_ready",
    });
    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => "2026-08-26T00:00:00.000Z",
    });
    await expect(repository.commitStateAndEvents(commitInput("authority"))).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    });
    await repository.close();

    const database = openQualifiedDatabase(paths.databasePath);
    database.prepare("UPDATE deployments SET status = 'active', authority_epoch = 2").run();
    database.close();
    const reopened = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => "2026-08-26T00:00:00.000Z",
    });
    await expect(reopened.commitStateAndEvents(commitInput("authority"))).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    });
    await reopened.close();

    const staleFenceDatabase = openQualifiedDatabase(paths.databasePath);
    staleFenceDatabase
      .prepare("UPDATE deployments SET authority_epoch = 1, fencing_token = 2")
      .run();
    staleFenceDatabase.close();
    const staleFenceRepository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => "2026-08-26T00:00:00.000Z",
    });
    await expect(
      staleFenceRepository.commitStateAndEvents(commitInput("authority")),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    await staleFenceRepository.close();
  });

  it("bounds SQLITE_BUSY and resumes after the competing writer releases", async () => {
    const { databasePath, repository } = await integrationRepository("busy", {
      stateRoot: "unused",
      busyTimeoutMs: 20,
    });
    const blocker = openQualifiedDatabase(databasePath);
    blocker.exec("BEGIN IMMEDIATE");
    await expect(repository.commitStateAndEvents(commitInput("busy"))).rejects.toMatchObject({
      code: PORT_ERROR_CODES.CONFLICT,
      details: { sqliteCode: "SQLITE_BUSY" },
    });
    blocker.exec("ROLLBACK");

    await expect(repository.commitStateAndEvents(commitInput("busy"))).resolves.toMatchObject({
      replayed: false,
      state: { revision: 1 },
    });
    blocker.close();
    await repository.close();
  });

  it("keeps passive checkpoint bounded by a long reader and truncates after release", async () => {
    const { databasePath, repository } = await integrationRepository("reader");
    const reader = openQualifiedDatabase(databasePath);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM reliable_events").pluck().get();
    await repository.commitStateAndEvents(commitInput("reader"));

    const bounded = await repository.checkpoint("passive");
    expect(bounded.log).toBeGreaterThanOrEqual(bounded.checkpointed);
    reader.exec("ROLLBACK");
    const released = await repository.checkpoint("truncate");
    expect(released).toMatchObject({ busy: 0, log: 0, checkpointed: 0 });

    reader.close();
    await repository.close();
  });

  it("enters write restriction below the configured disk headroom", async () => {
    const { repository } = await integrationRepository("headroom", {
      stateRoot: "unused",
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    await expect(repository.commitStateAndEvents(commitInput("headroom"))).rejects.toMatchObject({
      code: PORT_ERROR_CODES.CONFLICT,
      details: { reason: "disk_headroom" },
    });
    expect(await repository.operationalStatus()).toMatchObject({
      storageMode: "write_restricted",
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(await repository.read("run:sqlite-headroom")).toBeUndefined();
    await repository.close();
  });

  it("reports warning headroom without blocking bounded writes", async () => {
    const { repository } = await integrationRepository("headroom-warning", {
      stateRoot: "unused",
      minimumFreeBytes: 0,
      warningFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(await repository.operationalStatus()).toMatchObject({
      storageMode: "warning",
      minimumFreeBytes: 0,
      warningFreeBytes: Number.MAX_SAFE_INTEGER,
      outboxPending: 0,
      backgroundJobsPending: 0,
      memoryProjectionPending: 0,
      sseEventRows: 0,
      deletionPending: 0,
    });
    expect((await repository.operationalStatus()).databaseBytes).toBeGreaterThan(0);
    await expect(
      repository.commitStateAndEvents(commitInput("headroom-warning")),
    ).resolves.toMatchObject({ replayed: false });
    await repository.close();
  });

  it("rolls back an actual SQLITE_FULL transaction", async () => {
    const paths = await newStateRoot();
    await seedAuthority({
      databasePath: paths.databasePath,
      ownerId: "owner-sqlite-integration",
      agentId: "agent-sqlite-integration",
      leaseId: "lease-sqlite-integration",
      payloadRefs: ["payload-sqlite-full"],
    });
    const limiter = openQualifiedDatabase(paths.databasePath);
    const currentPages = limiter.pragma("page_count", { simple: true }) as number;
    limiter.pragma(`max_page_count = ${currentPages}`);
    limiter.close();
    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
      now: () => "2026-08-26T00:00:00.000Z",
      qualification: { maximumPageCount: currentPages },
    });
    const baseInput = commitInput("full");
    const input = {
      ...baseInput,
      state: {
        ...baseInput.state,
        value: { body: "x".repeat(256 * 1024), status: "accepted" },
      },
    };
    await expect(repository.commitStateAndEvents(input)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.CONFLICT,
      details: { sqliteCode: "SQLITE_FULL" },
    });
    expect(await repository.read("run:sqlite-full")).toBeUndefined();
    expect(await repository.listPending(10)).toEqual([]);
    await repository.close();
  });

  it.each(["after_state", "after_result", "after_event"] as const)(
    "rolls back every mutation when a child process dies at %s",
    async (checkpoint) => {
      const paths = await newStateRoot("himawari-sqlite-crash-");
      await seedAuthority({
        databasePath: paths.databasePath,
        ownerId: "owner-sqlite-crash",
        agentId: "agent-sqlite-crash",
        leaseId: "lease-sqlite-crash",
        payloadRefs: ["payload-sqlite-crash"],
      });
      await expect(
        executeFile(
          process.execPath,
          [VITEST_PATH, "run", "--config", FIXTURE_CONFIG_PATH, "--run", FIXTURE_PATH],
          {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            env: {
              ...process.env,
              HIMAWARI_SQLITE_CRASH_DATABASE: paths.databasePath,
              HIMAWARI_SQLITE_CRASH_STATE_ROOT: paths.stateRoot,
              HIMAWARI_SQLITE_CRASH_AT: checkpoint,
            },
          },
        ),
      ).rejects.toMatchObject({ code: 1 });

      const repository = await SqliteProductStateRepository.open({
        ...paths,
        minimumFreeBytes: 0,
      });
      expect(await repository.read("run:sqlite-crash")).toBeUndefined();
      expect(await repository.listPending(10)).toEqual([]);
      expect(
        await repository.findCommandResult({
          ownerId: createOwnerId("owner-sqlite-crash"),
          agentId: createAgentId("agent-sqlite-crash"),
          idempotencyKey: createIdempotencyKey("command-sqlite-crash"),
        }),
      ).toBeUndefined();
      await repository.close();
      const recovered = openQualifiedDatabase(paths.databasePath);
      expect(recovered.pragma("quick_check", { simple: true })).toBe("ok");
      expect(recovered.pragma("foreign_key_check")).toEqual([]);
      recovered.close();
    },
  );

  it("replays a complete commit when the child dies after COMMIT but before reply", async () => {
    const paths = await newStateRoot("himawari-sqlite-after-commit-");
    await seedAuthority({
      databasePath: paths.databasePath,
      ownerId: "owner-sqlite-crash",
      agentId: "agent-sqlite-crash",
      leaseId: "lease-sqlite-crash",
      payloadRefs: ["payload-sqlite-crash"],
    });
    await expect(
      executeFile(
        process.execPath,
        [VITEST_PATH, "run", "--config", FIXTURE_CONFIG_PATH, "--run", FIXTURE_PATH],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          env: {
            ...process.env,
            HIMAWARI_SQLITE_CRASH_DATABASE: paths.databasePath,
            HIMAWARI_SQLITE_CRASH_STATE_ROOT: paths.stateRoot,
            HIMAWARI_SQLITE_CRASH_AT: "after_commit",
          },
        },
      ),
    ).rejects.toMatchObject({ code: 1 });

    const repository = await SqliteProductStateRepository.open({
      ...paths,
      minimumFreeBytes: 0,
    });
    const crashInput: CommitStateAndEventsInput = {
      command: {
        ownerId: createOwnerId("owner-sqlite-crash"),
        agentId: createAgentId("agent-sqlite-crash"),
        idempotencyKey: createIdempotencyKey("command-sqlite-crash"),
        commandType: "run.transition",
        commandFingerprint: "run.transition:crash-matrix",
        authority: {
          leaseId: createAuthorityLeaseId("lease-sqlite-crash"),
          fencingToken: 1,
        },
      },
      state: {
        key: "run:sqlite-crash",
        expectedRevision: null,
        value: { status: "accepted" },
      },
      events: [
        {
          id: "event-sqlite-crash",
          idempotencyKey: createIdempotencyKey("command-sqlite-crash"),
          topic: "run.accepted",
          payloadRef: "payload-sqlite-crash",
          occurredAt: "2026-08-26T00:00:00.000Z",
        },
      ],
      resultRef: "run:sqlite-crash",
      committedAt: "2026-08-26T00:00:00.000Z",
    };
    await expect(repository.commitStateAndEvents(crashInput)).resolves.toMatchObject({
      replayed: true,
      state: { revision: 1 },
      events: [{ id: "event-sqlite-crash" }],
    });
    await repository.close();
  });
});
