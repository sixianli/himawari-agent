import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionTraceRecorder } from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-run-artifact");
const AGENT_ID = createAgentId("agent-run-artifact");
const DEPLOYMENT_ID = createDeploymentId("deployment-run-artifact");
const LEASE_ID = createAuthorityLeaseId("lease-run-artifact");
const RUN_ID = createRunId("run-run-artifact");
const SECOND_RUN_ID = createRunId("run-run-artifact-second");
const SESSION_ID = createSessionId("session-run-artifact");
const THREAD_ID = createThreadId("thread-run-artifact");
const NOW = "2026-09-04T00:00:00.000Z";
const AUTHORITY = {
  product: { deploymentId: DEPLOYMENT_ID, authorityEpoch: 1, fencingToken: 1 },
  lease: { leaseId: LEASE_ID, fencingToken: 1 },
} as const;
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function protector(): EnvelopePayloadProtector {
  return new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "artifact-kek@v1": KEY }),
    activeKey: { keyRef: "artifact-kek", kekVersion: "v1", dekVersion: "v1" },
  });
}

async function fixture(options: { readonly status?: "accepted" | "cancelled" } = {}) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-run-artifact-"));
  roots.push(stateRoot);
  await mkdir(path.join(stateRoot, "data"), { recursive: true });
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
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
        fencing_token, acquired_at, expires_at
      ) VALUES (?, ?, ?, ?, 'artifact-test', 1, 1, ?, '2999-12-31T23:59:59.999Z')`,
    )
    .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, lifecycle_state, created_at, content_type
      ) VALUES ('payload-trigger-artifact', ?, ?, 'private', 'sqlite_blob', X'00',
        'sha256:trigger-artifact', 'active', ?, 'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO threads (
        id, owner_id, agent_id, revision, status, created_at, updated_at
      ) VALUES ('thread-run-artifact', ?, ?, 0, 'open', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES ('trigger-run-artifact', ?, ?, 'thread-run-artifact',
        'trigger-run-artifact', 'user_message', 'fixture',
        'payload-trigger-artifact', 'proof-artifact', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 'thread-run-artifact', 'session-run-artifact',
        'trigger-run-artifact', 1, ?, ?, ?)`,
    )
    .run(RUN_ID, OWNER_ID, AGENT_ID, options.status ?? "accepted", NOW, NOW);
  if (options.status === undefined) {
    database
      .prepare(
        `INSERT INTO triggers (
          id, owner_id, agent_id, thread_id, idempotency_key, source_type,
          source_id, payload_ref, source_proof_ref, occurred_at
        ) VALUES ('trigger-run-artifact-second', ?, ?, 'thread-run-artifact',
          'trigger-run-artifact-second', 'user_message', 'fixture-2',
          'payload-trigger-artifact', 'proof-artifact-2', ?)`,
      )
      .run(OWNER_ID, AGENT_ID, NOW);
    database
      .prepare(
        `INSERT INTO runs (
          id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 'thread-run-artifact', 'session-run-artifact-2',
          'trigger-run-artifact-second', 1, 'accepted', ?, ?)`,
      )
      .run(SECOND_RUN_ID, OWNER_ID, AGENT_ID, NOW, NOW);
  }
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => NOW,
  });
  return { databasePath, repository, stateRoot };
}

async function protectedPayload(ref: string, value: string) {
  return protector().protect({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    ref,
    dataClassification: "private",
    contentType: "text/plain",
    plaintext: new TextEncoder().encode(value),
    createdAt: NOW,
  });
}

describe("Run-owned Payload artifacts", () => {
  it("atomically persists encrypted Payload and semantic receipt, then replays by identity", async () => {
    const resource = await fixture();
    try {
      const artifacts = resource.repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, AUTHORITY);
      const firstPayload = await protectedPayload("payload-artifact-first", "same plaintext");
      const first = await artifacts.commit({
        runId: RUN_ID,
        purpose: "worker_result",
        operationKey: "__proto__",
        payload: firstPayload,
      });
      const retryPayload = await protectedPayload(
        "payload-artifact-random-retry",
        "same plaintext",
      );
      const replay = await artifacts.commit({
        runId: RUN_ID,
        purpose: "worker_result",
        operationKey: "__proto__",
        payload: retryPayload,
      });

      expect(first).toMatchObject({ ref: "payload-artifact-first", replayed: false });
      expect(replay).toMatchObject({ ref: "payload-artifact-first", replayed: true });
      expect(
        await artifacts.lookup({
          runId: RUN_ID,
          purpose: "worker_result",
          operationKey: "__proto__",
        }),
      ).toMatchObject({
        payloadRef: "payload-artifact-first",
        operationKey: "__proto__",
      });
      expect(
        await resource.repository.payloadStore(OWNER_ID, AGENT_ID).get(first.ref),
      ).toBeTruthy();
      await expect(
        artifacts.commit({
          runId: RUN_ID,
          purpose: "worker_result",
          operationKey: "__proto__",
          payload: await protectedPayload("payload-artifact-conflict", "different plaintext"),
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    } finally {
      await resource.repository.close();
    }
  });

  it.each(["cancelled", "completed"] as const)(
    "replays a committed non-Trace artifact after the Run becomes %s",
    async (status) => {
      const resource = await fixture();
      try {
        const artifacts = resource.repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, AUTHORITY);
        const first = await artifacts.commit({
          runId: RUN_ID,
          purpose: "context",
          operationKey: "terminal-context",
          payload: await protectedPayload("payload-terminal-context-first", "same context"),
        });
        const database = openQualifiedDatabase(resource.databasePath);
        try {
          database
            .prepare(
              "UPDATE runs SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            )
            .run(status, NOW, RUN_ID);
        } finally {
          database.close();
        }

        await expect(
          artifacts.commit({
            runId: RUN_ID,
            purpose: "context",
            operationKey: "terminal-context",
            payload: await protectedPayload("payload-terminal-context-retry", "same context"),
          }),
        ).resolves.toMatchObject({ ref: first.ref, replayed: true });
        await expect(
          artifacts.commit({
            runId: RUN_ID,
            purpose: "context",
            operationKey: "terminal-context",
            payload: await protectedPayload(
              "payload-terminal-context-conflict",
              "different context",
            ),
          }),
        ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
        await expect(
          artifacts.commit({
            runId: RUN_ID,
            purpose: "context",
            operationKey: "terminal-context-new-key",
            payload: await protectedPayload("payload-terminal-context-new-key", "new context"),
          }),
        ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
      } finally {
        await resource.repository.close();
      }
    },
  );

  it("rejects semantic identity conflicts, stale leases, cross-scope refs, and terminal non-Trace writes", async () => {
    const resource = await fixture({ status: "cancelled" });
    try {
      const artifacts = resource.repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, AUTHORITY);
      const crossScope = openQualifiedDatabase(resource.databasePath);
      crossScope
        .prepare("INSERT INTO owners (id, revision) VALUES ('owner-other-artifact', 0)")
        .run();
      crossScope
        .prepare(
          "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-other-artifact', 'owner-other-artifact', 0)",
        )
        .run();
      crossScope
        .prepare(
          `INSERT INTO payloads (
            ref, owner_id, agent_id, classification, storage_kind, ciphertext,
            content_digest, lifecycle_state, created_at, content_type
          ) VALUES ('payload-cross-scope', 'owner-other-artifact', 'agent-other-artifact',
            'private', 'sqlite_blob', X'01', 'sha256:cross-scope', 'active', ?, 'text/plain')`,
        )
        .run(NOW);
      crossScope.close();
      await expect(
        artifacts.commit({
          runId: RUN_ID,
          purpose: "trace",
          operationKey: "cross-scope",
          payload: await protectedPayload("payload-cross-scope", "cross-scope"),
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        artifacts.commit({
          runId: createRunId("run-missing-artifact"),
          purpose: "trace",
          operationKey: "missing-run",
          payload: await protectedPayload("payload-missing-run", "missing-run"),
        }),
      ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
      const existing = await artifacts.commit({
        runId: RUN_ID,
        purpose: "trace",
        operationKey: "terminal-readback",
        payload: await protectedPayload("payload-terminal-readback", "readable"),
      });
      await expect(
        artifacts.commit({
          runId: RUN_ID,
          purpose: "trace",
          operationKey: "terminal-readback",
          payload: await protectedPayload("payload-terminal-retry", "readable"),
        }),
      ).resolves.toMatchObject({ ref: existing.ref, replayed: true });
      await expect(
        artifacts.commit({
          runId: RUN_ID,
          purpose: "trace",
          operationKey: "terminal-readback",
          payload: await protectedPayload("payload-terminal-conflict", "not readable"),
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await expect(
        artifacts.commit({
          runId: RUN_ID,
          purpose: "context",
          operationKey: "context-1",
          payload: await protectedPayload("payload-terminal-context", "context"),
        }),
      ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
      await expect(
        artifacts.commit({
          runId: RUN_ID,
          purpose: "trace",
          operationKey: "trace-terminal-1",
          payload: await protectedPayload("payload-terminal-trace", "trace"),
        }),
      ).resolves.toMatchObject({ replayed: false });
      await expect(
        artifacts.lookup({ runId: RUN_ID, purpose: "trace", operationKey: "terminal-readback" }),
      ).resolves.toMatchObject({ payloadRef: existing.ref });
      await resource.repository.authorityLeasePort({ now: () => NOW }).release(LEASE_ID);
      await expect(
        artifacts.commit({
          runId: RUN_ID,
          purpose: "trace",
          operationKey: "trace-terminal-2",
          payload: await protectedPayload("payload-stale-lease", "stale"),
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    } finally {
      await resource.repository.close();
    }
  });

  it("rolls back the Payload when the ownership receipt cannot be inserted", async () => {
    const resource = await fixture();
    try {
      const database = openQualifiedDatabase(resource.databasePath);
      database.exec(`
        CREATE TRIGGER test_run_payload_artifact_abort
        BEFORE INSERT ON run_payload_artifacts
        BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END;
      `);
      database.close();
      const artifacts = resource.repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, AUTHORITY);
      await expect(
        artifacts.commit({
          runId: RUN_ID,
          purpose: "context",
          operationKey: "rollback-1",
          payload: await protectedPayload("payload-rollback", "rollback"),
        }),
      ).rejects.toThrow("test receipt failure");
      await expect(
        resource.repository.payloadStore(OWNER_ID, AGENT_ID).get("payload-rollback"),
      ).resolves.toBeUndefined();
      const check = openQualifiedDatabase(resource.databasePath);
      try {
        expect(check.prepare("SELECT COUNT(*) FROM run_payload_artifacts").pluck().get()).toBe(0);
      } finally {
        check.close();
      }
    } finally {
      await resource.repository.close();
    }
  });

  it("keeps an artifact after Trace append failure and removes it with the Run", async () => {
    const resource = await fixture();
    const adapters = createReferenceAdapterSet();
    let storedPayloadRef: string;
    try {
      const recorder = new SessionTraceRecorder({
        trace: {
          append: async () => {
            throw new Error("trace append failed");
          },
          readRun: async () => [],
          readSession: async () => [],
        },
        artifacts: resource.repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, AUTHORITY),
        protector: protector(),
        audit: adapters.audit,
        clock: { now: () => NOW },
        ids: adapters.ids,
      });
      await expect(
        recorder.record({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          runId: RUN_ID,
          turnId: null,
          parentEventId: null,
          causationId: null,
          correlationId: "correlation-artifact",
          actorId: "artifact-test",
          dataClassification: "private",
          eventType: "trace.body",
          payload: { body: "stored before append" },
        }),
      ).rejects.toThrow("trace append failed");
      const beforeDelete = openQualifiedDatabase(resource.databasePath);
      try {
        storedPayloadRef = beforeDelete
          .prepare("SELECT payload_ref FROM run_payload_artifacts WHERE run_id = ?")
          .pluck()
          .get(RUN_ID) as string;
        expect(
          beforeDelete
            .prepare("SELECT COUNT(*) FROM run_payload_artifacts WHERE run_id = ?")
            .pluck()
            .get(RUN_ID),
        ).toBe(1);
      } finally {
        beforeDelete.close();
      }
    } finally {
      await resource.repository.close();
    }
    const deletion = new SqliteGovernedDeletionAdapter({
      stateRoot: resource.stateRoot,
      databasePath: resource.databasePath,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      now: () => NOW,
    });
    await deletion.deleteImmediately({ objectType: "run", objectId: RUN_ID });
    const afterDelete = openQualifiedDatabase(resource.databasePath);
    try {
      expect(
        afterDelete
          .prepare("SELECT COUNT(*) FROM run_payload_artifacts WHERE run_id = ?")
          .pluck()
          .get(RUN_ID),
      ).toBe(0);
      expect(
        afterDelete
          .prepare("SELECT COUNT(*) FROM payloads WHERE ref = ?")
          .pluck()
          .get(storedPayloadRef),
      ).toBe(0);
    } finally {
      afterDelete.close();
    }
  });

  it("preserves a shared Payload until the surviving Run-owned artifact is deleted", async () => {
    const resource = await fixture();
    try {
      const artifacts = resource.repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, AUTHORITY);
      const shared = await protectedPayload("payload-shared-artifact", "shared");
      await artifacts.commit({
        runId: RUN_ID,
        purpose: "worker_result",
        operationKey: "one",
        payload: shared,
      });
      await artifacts.commit({
        runId: SECOND_RUN_ID,
        purpose: "worker_result",
        operationKey: "two",
        payload: shared,
      });
    } finally {
      await resource.repository.close();
    }
    const deletion = new SqliteGovernedDeletionAdapter({
      stateRoot: resource.stateRoot,
      databasePath: resource.databasePath,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      now: () => NOW,
    });
    await deletion.deleteImmediately({ objectType: "run", objectId: RUN_ID });
    const middle = openQualifiedDatabase(resource.databasePath);
    try {
      expect(
        middle
          .prepare("SELECT COUNT(*) FROM payloads WHERE ref = 'payload-shared-artifact'")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      middle.close();
    }
    await deletion.deleteImmediately({ objectType: "run", objectId: SECOND_RUN_ID });
    const final = openQualifiedDatabase(resource.databasePath);
    try {
      expect(
        final
          .prepare("SELECT COUNT(*) FROM payloads WHERE ref = 'payload-shared-artifact'")
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      final.close();
    }
  });
});
