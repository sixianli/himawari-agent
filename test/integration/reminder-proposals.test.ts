import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  type MemoryProviderProjectionPort,
  type ProductMemoryRecord,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId, createThreadId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductionProposalBox,
  ProposalError,
} from "../../apps/agent-service/src/production-proposals.ts";
import {
  proposeReminderCreate,
  proposeReminderReschedule,
  registerReminderProposalHandlers,
} from "../../apps/agent-service/src/production-reminder-proposals.ts";
import { ProductionReminderWriter } from "../../apps/agent-service/src/production-reminder-writer.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-reminder-proposals");
const AGENT_ID = createAgentId("agent-reminder-proposals");
const THREAD_ID = createThreadId("thread-reminder-proposals");
const START = "2026-11-14T00:00:00.000Z";
const ZONE = "Asia/Shanghai";

class RecordingProvider implements MemoryProviderProjectionPort {
  readonly deleted: string[] = [];
  async upsert(input: { readonly memory: ProductMemoryRecord }) {
    return `provider-${input.memory.id}`;
  }
  async delete(id: string) {
    this.deleted.push(id);
  }
  async search() {
    return [];
  }
  async clearScope() {}
}

describe("reminder proposals", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-reminder-proposals-"));
    directories.push(stateRoot);
    const file = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(file);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'open', ?, ?)`,
      )
      .run(THREAD_ID, OWNER_ID, AGENT_ID, START, START);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-1', 'generation-1', ?, ?, ?, 1, 1, 'policy-1', 'completed', 1, ?)`,
      )
      .run(OWNER_ID, AGENT_ID, THREAD_ID, START);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES ('generation-1', 'checkpoint-1', ?, ?, ?, 'completed', 'model-1', 'policy-1', NULL)`,
      )
      .run(OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const clock = { value: START };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.value,
    });
    closers.push(() => repository.close());
    const adapters = createReferenceAdapterSet();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const provider = new RecordingProvider();
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider,
      content: {
        readText: async (ref) => {
          const payload = await payloads.get(ref);
          if (!payload) throw new Error("missing");
          return new TextDecoder().decode(await adapters.payloadProtector.unprotect({ payload }));
        },
      },
      workerId: "reminder-proposals-test",
      now: () => clock.value,
    });
    const configuration = { ownerId: OWNER_ID, agentId: AGENT_ID };
    const writer = new ProductionReminderWriter({
      configuration,
      memory,
      state: repository.productMemoryState(),
      book: repository.memoryBook(),
      reminders: repository.memoryReminders(),
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
      timeZone: ZONE,
    });
    const box = new ProductionProposalBox({
      configuration,
      store: repository.ownerProposals(),
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
    });
    registerReminderProposalHandlers({ box, writer, clock: { now: () => clock.value } });
    const context = { box, writer, timeZone: ZONE, origin: "inferred" as const, threadId: null };
    const seen = async (proposalId: string) => {
      const found = (await box.list()).proposals.find((item) => item.proposalId === proposalId);
      if (!found) throw new Error("proposal not listed");
      return { version: found.version, fingerprint: found.fingerprint };
    };
    const seed = (key = "seed", due = "2026-11-20T12:10") =>
      writer.create({ key, text: "出门提醒", due, repeat: "none" });
    const reminder = (id: string) => repository.memoryReminders().read(id);
    const memoryStatus = (id: string) => repository.productMemoryState().read(id as never);
    const withoutDelete = new ProductionReminderWriter({
      configuration,
      memory: { applyProposal: memory.applyProposal.bind(memory) } as never,
      state: repository.productMemoryState(),
      book: repository.memoryBook(),
      reminders: repository.memoryReminders(),
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
      timeZone: ZONE,
    });
    return {
      box,
      writer,
      withoutDelete,
      file,
      context,
      seen,
      seed,
      reminder,
      memoryStatus,
      clock,
      provider,
    };
  }

  async function failureOf(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return error instanceof ProposalError ? error.code : String(error);
    }
  }

  it("[P1-6] reschedules a reminder after the owner agrees, reads it back, and undo restores the old time", async () => {
    const { box, context, seen, seed, reminder } = await fixture();
    const created = await seed();
    const before = await reminder(created.reminderId);
    const proposed = await proposeReminderReschedule(context, {
      reminderId: created.reminderId,
      due: "2026-11-20T09:40",
    });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const listed = (await box.list()).proposals.find(
      (item) => item.proposalId === proposed.proposalId,
    );
    expect(listed?.summary).toContain("出门提醒");
    expect(listed?.summary).toContain("2026-11-20 12:10");
    expect(listed?.summary).toContain("2026-11-20 09:40");
    expect(await reminder(created.reminderId)).toEqual(before);
    const outcome = await box.adopt(proposed.proposalId, await seen(proposed.proposalId));
    expect(outcome).toMatchObject({ execution: "succeeded" });
    const moved = await reminder(created.reminderId);
    expect(moved?.dueAt).toBe("2026-11-20T01:40:00.000Z");
    expect(moved?.status).toBe("scheduled");
    expect(await box.undo(proposed.proposalId)).toEqual({ replayed: false });
    const restored = await reminder(created.reminderId);
    expect(restored?.dueAt).toBe(before?.dueAt);
    expect(restored?.remindAt).toBe(before?.remindAt);
    expect(await box.undo(proposed.proposalId)).toEqual({ replayed: true });
  });

  it("[P1-6][reverse] does nothing when the owner changed the reminder after it was proposed", async () => {
    const { box, context, writer, seen, seed, reminder } = await fixture();
    const created = await seed();
    const proposed = await proposeReminderReschedule(context, {
      reminderId: created.reminderId,
      due: "2026-11-20T09:40",
    });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const version = await seen(proposed.proposalId);
    const current = await reminder(created.reminderId);
    await writer.moveSchedule({
      reminderId: created.reminderId,
      expectedUpdatedAt: current?.updatedAt ?? "",
      dueAt: "2026-11-22T04:00:00.000Z",
      remindAt: "2026-11-22T03:00:00.000Z",
    });
    expect(await failureOf(box.adopt(proposed.proposalId, version))).toBe("PROPOSAL_SUPERSEDED");
    expect((await reminder(created.reminderId))?.dueAt).toBe("2026-11-22T04:00:00.000Z");
  });

  it("[P1-6][reverse] refuses to propose a past time, an unchanged time, or an unknown reminder", async () => {
    const { context, seed, box } = await fixture();
    const created = await seed();
    expect(
      await proposeReminderReschedule(context, {
        reminderId: created.reminderId,
        due: "2026-11-10T09:40",
      }),
    ).toEqual({ refused: "REMINDER_TIME_INVALID" });
    expect(
      await proposeReminderReschedule(context, {
        reminderId: created.reminderId,
        due: "2026-11-20T12:10",
      }),
    ).toEqual({ refused: "REMINDER_TIME_UNCHANGED" });
    expect(
      await proposeReminderReschedule(context, {
        reminderId: "reminder:memory:reminder:nope",
        due: "2026-11-20T09:40",
      }),
    ).toEqual({ refused: "REMINDER_NOT_FOUND" });
    expect((await box.list()).pendingCount).toBe(0);
  });

  it("[P1-6] creates a reminder once, and undo cancels it and deletes the memory it hung on", async () => {
    const { box, context, seen, reminder, memoryStatus } = await fixture();
    const proposed = await proposeReminderCreate(context, {
      text: "周五交周报",
      due: "2026-11-20T15:00",
    });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const again = await proposeReminderCreate(context, {
      text: "周五交周报",
      due: "2026-11-20T15:00",
    });
    expect(again).toEqual(proposed);
    expect((await box.list()).pendingCount).toBe(1);
    const outcome = await box.adopt(proposed.proposalId, await seen(proposed.proposalId));
    expect(outcome).toMatchObject({ execution: "succeeded" });
    const reminderId = String((outcome as { detail?: unknown }).detail);
    const made = await reminder(reminderId);
    expect(made?.status).toBe("scheduled");
    expect(made?.dueAt).toBe("2026-11-20T07:00:00.000Z");
    expect(await box.undo(proposed.proposalId)).toEqual({ replayed: false });
    expect((await reminder(reminderId))?.status).toBe("cancelled");
    expect((await memoryStatus(made?.memoryId ?? ""))?.status).toBe("deletion_pending");
  });

  it("[P1-6][reverse] refuses an empty reminder text and a past time, and asks to read a long text in full", async () => {
    const { context, box } = await fixture();
    expect(await proposeReminderCreate(context, { text: "  ", due: "2026-11-20T15:00" })).toEqual({
      refused: "REMINDER_INPUT_INVALID",
    });
    expect(
      await proposeReminderCreate(context, { text: "周五交周报", due: "2026-11-01T15:00" }),
    ).toEqual({ refused: "REMINDER_TIME_INVALID" });
    const long = "很长的提醒".repeat(30);
    const proposed = await proposeReminderCreate(context, { text: long, due: "2026-11-20T15:00" });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const listed = (await box.list()).proposals.find(
      (item) => item.proposalId === proposed.proposalId,
    );
    expect(listed?.requiresFullRead).toBe(true);
    expect(listed?.summary.length).toBeLessThanOrEqual(200);
  });
  it("[P1-6][reverse] refuses to create a yearly reminder whose shown date has passed instead of rolling it to next year", async () => {
    const { box, context, seen, clock, reminder } = await fixture();
    const proposed = await proposeReminderCreate(context, {
      text: "年度提醒",
      due: "2026-11-20T15:00",
      repeat: "yearly",
    });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const version = await seen(proposed.proposalId);
    clock.value = "2026-11-25T00:00:00.000Z";
    expect(await failureOf(box.adopt(proposed.proposalId, version))).toBe("PROPOSAL_SUPERSEDED");
    expect(
      await reminder("reminder:memory:reminder:proposal:" + proposed.proposalId),
    ).toBeUndefined();
  });

  it("[P1-6] keeps the conversation and external-content source on a reminder created from a proposal", async () => {
    const { box, context, seen, reminder, memoryStatus } = await fixture();
    const proposed = await proposeReminderCreate(
      { ...context, threadId: THREAD_ID, externalOrigins: ["web:example.test"] },
      { text: "周五交周报", due: "2026-11-20T15:00" },
    );
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const outcome = await box.adopt(proposed.proposalId, await seen(proposed.proposalId));
    const made = await reminder(String((outcome as { detail?: unknown }).detail));
    const memory = await memoryStatus(made?.memoryId ?? "");
    expect(memory?.sourceThreadId).toBe(THREAD_ID);
    expect(memory?.sourceRefs.some((ref) => ref.includes("web:example.test"))).toBe(true);
  });

  it("[P1-6] lets undo finish when the old time was already restored but the proposal still says succeeded", async () => {
    const { box, context, writer, seen, seed, reminder } = await fixture();
    const created = await seed();
    const before = await reminder(created.reminderId);
    const proposed = await proposeReminderReschedule(context, {
      reminderId: created.reminderId,
      due: "2026-11-20T09:40",
    });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    await box.adopt(proposed.proposalId, await seen(proposed.proposalId));
    const moved = await reminder(created.reminderId);
    await writer.moveSchedule({
      reminderId: created.reminderId,
      expectedUpdatedAt: moved?.updatedAt ?? "",
      dueAt: before?.dueAt ?? "",
      remindAt: before?.remindAt ?? "",
    });
    expect(await box.undo(proposed.proposalId)).toEqual({ replayed: false });
  });

  it("[P1-6][reverse] reports a stable error code when undo finds the reminder changed by the owner", async () => {
    const { box, context, writer, seen, seed, reminder } = await fixture();
    const created = await seed();
    const proposed = await proposeReminderReschedule(context, {
      reminderId: created.reminderId,
      due: "2026-11-20T09:40",
    });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    await box.adopt(proposed.proposalId, await seen(proposed.proposalId));
    const moved = await reminder(created.reminderId);
    await writer.moveSchedule({
      reminderId: created.reminderId,
      expectedUpdatedAt: moved?.updatedAt ?? "",
      dueAt: "2026-11-22T04:00:00.000Z",
      remindAt: "2026-11-22T03:00:00.000Z",
    });
    expect(await failureOf(box.undo(proposed.proposalId))).toBe("PROPOSAL_NOT_UNDOABLE");
  });

  it("[P1-6] still creates the reminder when the source conversation was deleted after the proposal", async () => {
    const { box, context, seen, reminder, memoryStatus, file } = await fixture();
    const proposed = await proposeReminderCreate(
      { ...context, threadId: THREAD_ID },
      { text: "周五交周报", due: "2026-11-20T15:00" },
    );
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const version = await seen(proposed.proposalId);
    const raw = openQualifiedDatabase(file);
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM threads WHERE id = ?").run(THREAD_ID);
    raw.close();
    const outcome = await box.adopt(proposed.proposalId, version);
    expect(outcome).toMatchObject({ execution: "succeeded" });
    const made = await reminder(String((outcome as { detail?: unknown }).detail));
    expect((await memoryStatus(made?.memoryId ?? ""))?.sourceThreadId).toBeNull();
  });

  it("[P1-6][reverse] refuses to create a reminder whose date no longer matches the one the owner saw", async () => {
    const { writer } = await fixture();
    await expect(
      writer.create({
        key: "stale",
        text: "年度提醒",
        due: "2026-11-20T15:00",
        repeat: "yearly",
        expectedDueAt: "2025-11-20T07:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "REMINDER_TIME_INVALID" });
  });

  it("[P1-6][reverse] refuses to withdraw a created reminder when the memory cannot be deleted, and leaves it scheduled", async () => {
    const { withoutDelete, writer, reminder } = await fixture();
    const created = await writer.create({
      key: "nodelete",
      text: "周五交周报",
      due: "2026-11-20T15:00",
      repeat: "none",
    });
    await expect(withoutDelete.withdraw(created.reminderId)).rejects.toMatchObject({
      code: "REMINDER_MEMORY_NOT_READY",
    });
    expect((await reminder(created.reminderId))?.status).toBe("scheduled");
  });

  it("[P1-6] lets undo of a created reminder finish after the withdraw already ran", async () => {
    const { box, context, writer, seen, reminder } = await fixture();
    const proposed = await proposeReminderCreate(context, {
      text: "周五交周报",
      due: "2026-11-20T15:00",
    });
    if (!("proposalId" in proposed)) throw new Error(proposed.refused);
    const outcome = await box.adopt(proposed.proposalId, await seen(proposed.proposalId));
    const reminderId = String((outcome as { detail?: unknown }).detail);
    await writer.withdraw(reminderId);
    expect(await box.undo(proposed.proposalId)).toEqual({ replayed: false });
    expect((await reminder(reminderId))?.status).toBe("cancelled");
  });
});
