import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ThreadCommandService } from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionProposalControl } from "../../apps/agent-service/src/production-proposal-control.ts";
import {
  ProductionProposalBox,
  ProposalError,
} from "../../apps/agent-service/src/production-proposals.ts";
import {
  proposeTaskRun,
  registerTaskProposalHandler,
  TASK_RUN_PROPOSAL_TYPE,
} from "../../apps/agent-service/src/production-task-proposals.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-task-proposals");
const AGENT_ID = createAgentId("agent-task-proposals");
const DEPLOYMENT_ID = createDeploymentId("deployment-task-proposals");
const AUTHORITY: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};
const START = "2026-11-14T00:00:00.000Z";
const SESSION = { sessionId: "session-task-proposals", proofRef: "proof-task-proposals" };
const BASIS = [{ kind: "memory", ref: "memory:owner-note" }];

describe("task run proposals", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-task-proposals-"));
    directories.push(stateRoot);
    await mkdir(path.join(stateRoot, "data"));
    const file = path.join(stateRoot, "data", "product.sqlite");
    await copyMigratedDatabase(file);
    const database = openQualifiedDatabase(file);
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
        (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch, fencing_token,
          acquired_at, expires_at)
        VALUES (?, ?, ?, ?, 'holder-task-proposals', 1, 1, ?, '2026-11-15T00:00:00.000Z')`,
      )
      .run(
        createAuthorityLeaseId("lease-task-proposals"),
        OWNER_ID,
        AGENT_ID,
        DEPLOYMENT_ID,
        START,
      );
    database.close();
    const clock = { value: START };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath: file,
      minimumFreeBytes: 0,
      now: () => clock.value,
    });
    closers.push(() => repository.close());
    const adapters = createReferenceAdapterSet();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const configuration = { ownerId: OWNER_ID, agentId: AGENT_ID };
    const box = new ProductionProposalBox({
      configuration,
      store: repository.ownerProposals(),
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
    });
    const threads = repository.threadRepository();
    registerTaskProposalHandler({
      box,
      configuration,
      commands: new ThreadCommandService({
        repository: threads,
        clock: { now: () => clock.value },
        authority: () => AUTHORITY,
      }),
      threads,
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
      timeZone: "Asia/Shanghai",
    });
    const context = {
      box,
      origin: "inferred" as const,
      threadId: null,
      reason: "他说过周五要交周报",
    };
    const seen = async (proposalId: string) => {
      const found = (await box.list()).proposals.find((item) => item.proposalId === proposalId);
      if (!found) throw new Error("proposal not listed");
      return { version: found.version, fingerprint: found.fingerprint };
    };
    const database2 = () => openQualifiedDatabase(file);
    const read = async (ref: string) => {
      const payload = await payloads.get(ref as never);
      if (!payload) return undefined;
      return new TextDecoder().decode(await adapters.payloadProtector.unprotect({ payload }));
    };
    return { box, context, seen, repository, database2, read, clock };
  }

  async function failureOf(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return error instanceof ProposalError ? error.code : String(error);
    }
  }

  it("opens one run in a new conversation with the agreed text, recorded as proposal-triggered", async () => {
    const { box, context, seen, repository, database2, read } = await fixture();
    const task = "查一下下周去大阪的新干线票价，列出三个班次，把结果带回来。";
    const proposed = await proposeTaskRun(context, { text: task, basis: BASIS });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const outcome = await box.adopt(proposed.proposalId, await seen(proposed.proposalId), {
      session: SESSION,
    });
    expect(outcome).toMatchObject({ execution: "succeeded" });
    const database = database2();
    const rows = database
      .prepare(
        `SELECT r.id AS runId, r.status, r.session_id AS sessionId, t.source_type AS sourceType,
          t.source_proof_ref AS proof, t.payload_ref AS payloadRef,
          (SELECT COUNT(*) FROM runs) AS runCount
        FROM runs r JOIN triggers t ON t.id = r.trigger_id`,
      )
      .all() as Record<string, unknown>[];
    database.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "accepted",
      sessionId: SESSION.sessionId,
      sourceType: "external_event",
      runCount: 1,
    });
    expect(String(rows[0]?.["proof"])).toContain(proposed.proposalId);
    const text = await read(String(rows[0]?.["payloadRef"]));
    expect(text).toContain(task);
    expect(text).toContain("<<<已同意的任务>>>");
    expect(text).toContain("同意的一条提议");
    const unattended = await repository
      .runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY)
      .listUnattendedRuns?.({ failedSince: START, limit: 10 });
    expect(unattended?.map((run) => run.runId)).toEqual([rows[0]?.["runId"]]);
    expect((await box.list()).pendingCount).toBe(0);
  });

  it("[reverse] an ordinary owner message is still recorded as a user message and is not listed as unattended", async () => {
    const { repository } = await fixture();
    const commands = new ThreadCommandService({
      repository: repository.threadRepository(),
      clock: { now: () => START },
      authority: () => AUTHORITY,
    });
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const adapters = createReferenceAdapterSet();
    await payloads.put(
      await adapters.payloadProtector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: "payload-owner-message",
        contentType: "text/plain",
        dataClassification: "private",
        plaintext: new TextEncoder().encode("你好"),
        createdAt: START,
      }),
    );
    const created = await commands.create({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      idempotencyKey: "thread-owner",
      resultRef: "payload-owner-message",
    });
    await commands.admitOwnerMessage({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: created.thread.id,
      expectedThreadRevision: created.thread.revision,
      sessionId: "session-owner" as never,
      idempotencyKey: "submit-owner",
      contentRef: "payload-owner-message",
      sourceProofRef: "proof:owner",
      dataClassification: "private",
      resultRef: "payload-owner-message",
    });
    const unattended = await repository
      .runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY)
      .listUnattendedRuns?.({ failedSince: START, limit: 10 });
    expect(unattended).toEqual([]);
  });

  it("agreeing twice opens only one run", async () => {
    const { box, context, seen, database2 } = await fixture();
    const proposed = await proposeTaskRun(context, { text: "整理一下本周的待办", basis: BASIS });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const version = await seen(proposed.proposalId);
    await box.adopt(proposed.proposalId, version, { session: SESSION });
    expect(
      await failureOf(box.adopt(proposed.proposalId, version, { session: SESSION })),
    ).toBeDefined();
    const database = database2();
    const count = (database.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    database.close();
    expect(count).toBe(1);
  });

  it("[reverse] refuses to propose without an owner-side basis, with empty text, or with oversized text", async () => {
    const { box, context } = await fixture();
    expect(await proposeTaskRun(context, { text: "去查一下", basis: [] })).toEqual({
      refused: "TASK_BASIS_REQUIRED",
    });
    expect(await proposeTaskRun(context, { text: "   ", basis: BASIS })).toEqual({
      refused: "TASK_TEXT_INVALID",
    });
    expect(await proposeTaskRun(context, { text: "查".repeat(2001), basis: BASIS })).toEqual({
      refused: "TASK_TEXT_INVALID",
    });
    expect((await box.list()).pendingCount).toBe(0);
  });

  it("[reverse] a task drawn from external content cannot be agreed to without reading it in full", async () => {
    const { box, context, seen, database2 } = await fixture();
    const proposed = await proposeTaskRun(
      { ...context, origin: "external_content", externalContentSeen: true },
      { text: "回复这封邮件", basis: BASIS },
    );
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    expect(
      await failureOf(
        box.adopt(proposed.proposalId, await seen(proposed.proposalId), { session: SESSION }),
      ),
    ).toBe("PROPOSAL_FULL_READ_REQUIRED");
    const database = database2();
    const count = (database.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    database.close();
    expect(count).toBe(0);
  });

  it("[reverse] without a signed-in session nothing is opened, and the task cannot be undone", async () => {
    const { box, context, seen, database2 } = await fixture();
    const proposed = await proposeTaskRun(context, { text: "整理一下本周的待办", basis: BASIS });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    expect(await failureOf(box.adopt(proposed.proposalId, await seen(proposed.proposalId)))).toBe(
      "PROPOSAL_INVALID",
    );
    const database = database2();
    const count = (database.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    database.close();
    expect(count).toBe(0);
    await box.adopt(proposed.proposalId, await seen(proposed.proposalId), { session: SESSION });
    expect(await failureOf(box.undo(proposed.proposalId))).toBe("PROPOSAL_NOT_UNDOABLE");
  });

  it("takes the session and proof from the signed-in command that agreed to it", async () => {
    const { box, context, seen, database2 } = await fixture();
    const proposed = await proposeTaskRun(context, { text: "整理一下本周的待办", basis: BASIS });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const expected = await seen(proposed.proposalId);
    const control = new ProductionProposalControl({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      box,
      clock: { now: () => START },
    });
    await control.execute(
      {
        subjectId: "owner",
        sessionId: "session-from-command",
        authenticationRef: "auth-from-command",
      } as never,
      {
        kind: "command",
        type: "proposal.respond",
        actor: { actorType: "owner", actorId: "owner" },
        scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
        payload: {
          proposalId: proposed.proposalId,
          action: "adopt",
          expectedVersion: expected.version,
          fingerprint: expected.fingerprint,
          recentAuthenticationRef: null,
          fullReadToken: null,
        },
      } as never,
    );
    const database = database2();
    const row = database
      .prepare(
        `SELECT r.session_id AS sessionId, t.source_proof_ref AS proof
        FROM runs r JOIN triggers t ON t.id = r.trigger_id`,
      )
      .get() as { sessionId: string; proof: string };
    database.close();
    expect(row.sessionId).toBe("session-from-command");
    expect(row.proof).toContain("auth-from-command");
  });

  it("registers under the task.run type", () => {
    expect(TASK_RUN_PROPOSAL_TYPE).toBe("task.run");
  });
});
