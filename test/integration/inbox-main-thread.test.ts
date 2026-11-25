import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MEMORY_ATTRIBUTES,
  type MemoryReminder,
  type PayloadProtectorPort,
  ThreadCommandService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createMemoryId,
  createOwnerId,
  createRunId,
  createSessionId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextExternalContent,
  externalEventOrigin,
} from "../../apps/agent-service/src/context-external-content.ts";
import { ProductionInbox } from "../../apps/agent-service/src/production-inbox.ts";
import {
  InboxRunRegistry,
  ProductionInboxDelivery,
} from "../../apps/agent-service/src/production-inbox-delivery.ts";
import { ProductionInboxWorker } from "../../apps/agent-service/src/production-inbox-worker.ts";
import { ProductionMainThread } from "../../apps/agent-service/src/production-main-thread.ts";
import {
  MEMORY_SAVED_EVENT_KIND,
  ProductionMemoryInbox,
} from "../../apps/agent-service/src/production-memory-inbox.ts";
import {
  ProductionReminderInbox,
  reminderMessageId,
} from "../../apps/agent-service/src/production-reminder-inbox.ts";
import {
  ProductionTellOwner,
  TellOwnerInputError,
} from "../../apps/agent-service/src/production-tell-owner.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-inbox-main");
const AGENT_ID = createAgentId("agent-inbox-main");
const DEPLOYMENT_ID = createDeploymentId("deployment-inbox-main");
const LEASE_ID = createAuthorityLeaseId("lease-inbox-main");
const START = "2026-11-25T00:00:00.000Z";
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const authority: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};

describe("outside events in the main conversation", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture(options: { readonly reminderGraceMs?: number } = {}) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-inbox-main-"));
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
        VALUES (?, ?, ?, ?, 'holder-inbox-main', 1, 1, ?, '2026-11-26T00:00:00.000Z')`,
      )
      .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, START);
    database.close();
    const clock = { value: START };
    const now = () => clock.value;
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath: file,
      minimumFreeBytes: 0,
      now,
    });
    closers.push(() => repository.close());
    const adapters = createReferenceAdapterSet();
    const protector: PayloadProtectorPort = adapters.payloadProtector;
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const threads = repository.threadRepository();
    const commands = new ThreadCommandService({
      repository: threads,
      clock: { now },
      authority: () => authority,
    });
    const mainThread = new ProductionMainThread({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threads,
      commands,
      payloads,
      protector,
      clock: { now },
    });
    const externalContent = new ContextExternalContent({
      configuration: scope,
      state: repository,
      source: repository.runExecutionSource(OWNER_ID, AGENT_ID),
      authority: () => ({ leaseId: LEASE_ID, fencingToken: 1 }),
      clock: { now },
    });
    const registry = new InboxRunRegistry();
    const ledger = repository.decisionLedger();
    const messageExists = async (threadId: string, messageId: string) =>
      (
        await threads.readCommittedMessagesByIds({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          threadId: threadId as never,
          messageIds: [messageId as never],
        })
      ).length > 0;
    const due: MemoryReminder[] = [];
    const reminders = new ProductionReminderInbox({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      reminders: {
        listDue: async () => due,
        read: async (id) => due.find((reminder) => reminder.id === id),
      },
      reminderText: async (reminder) =>
        reminder.memoryId === "memory:rent" ? "交房租" : undefined,
      formatDue: (dueAt) => `北京时间 ${dueAt.slice(11, 16)}`,
      messageExists,
      commands,
      ledger,
      push: repository.webPush(),
      payloads,
      protector,
      clock: { now },
    });
    const delivery = new ProductionInboxDelivery({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      mainThread,
      threads,
      commands,
      runs: repository.runLifecycle(OWNER_ID, AGENT_ID, authority),
      ledger,
      externalContent,
      registry,
      payloads,
      protector,
      clock: { now },
      pollMs: 5,
      reminders,
      ...(options.reminderGraceMs !== undefined
        ? { reminderGraceMs: options.reminderGraceMs }
        : {}),
      cancelRun: async ({ runId }) => {
        const handle = openQualifiedDatabase(file);
        try {
          handle.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(runId);
        } finally {
          handle.close();
        }
      },
    });
    const tellOwner = new ProductionTellOwner({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      registry,
      commands,
      ledger,
      push: repository.webPush(),
      payloads,
      protector,
      clock: { now },
      messageExists,
    });
    const store = repository.inbox();
    const inbox = new ProductionInbox({ scope, store, payloads, protector, clock: { now } });
    inbox.sources.register({
      kind: "mail",
      describe: "新邮件",
      externalContent: true,
      fromOwner: false,
      priority: 5,
    });
    reminders.registerSource(inbox.sources);
    reminders.attach(inbox);
    const worker = new ProductionInboxWorker({
      scope,
      inbox,
      store,
      payloads,
      protector,
      clock: { now },
      delivery,
      runTimeoutMs: 60_000,
    });
    const text = async (ref: string) => {
      const payload = await payloads.get(ref as never);
      if (!payload) return undefined;
      return new TextDecoder().decode(
        await protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }),
      );
    };
    const write = async (ref: string, content: string) => {
      await payloads.put(
        await protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          contentType: "text/plain",
          dataClassification: "private",
          plaintext: new TextEncoder().encode(content),
          createdAt: now(),
        }),
      );
    };
    const query = <T>(sql: string, ...parameters: unknown[]) => {
      const handle = openQualifiedDatabase(file);
      try {
        return handle.prepare(sql).all(...parameters) as T[];
      } finally {
        handle.close();
      }
    };
    const admitted = async () => {
      for (;;) {
        const runs = query<{ id: string; status: string }>(
          "SELECT id, status FROM runs WHERE id LIKE 'run:inbox:%' AND status = 'accepted'",
        );
        if (runs[0]) return createRunId(runs[0].id);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const finish = async (runId: ReturnType<typeof createRunId>, thought: string) => {
      const main = await mainThread.ensure();
      const thread = await threads.read(OWNER_ID, AGENT_ID, main);
      const turn = query<{ id: string }>("SELECT id FROM turns WHERE run_id = ?", runId)[0];
      if (!thread || !turn) throw new Error("run state missing");
      await write(`thought:${runId}`, thought);
      await commands.commitAssistantMessage({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: main,
        expectedThreadRevision: thread.revision,
        turnId: turn.id as never,
        runId,
        idempotencyKey: `final:${runId}`,
        contentRef: `thought:${runId}` as never,
        dataClassification: "private",
        resultRef: `thought:${runId}` as never,
      });
    };
    const mail = (ref: string, summary: string) =>
      inbox.submit({
        sourceKind: "mail",
        sourceRef: ref,
        sourceVersion: "1",
        summary,
        externalContent: true,
      });
    const memories = new ProductionMemoryInbox({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      state: repository.productMemoryState(),
      mainThread,
      formatTime: (iso) => `北京时间 ${iso.slice(11, 16)}`,
      clock: { now },
    });
    memories.registerSource(inbox.sources);
    memories.attach(inbox);
    const remember = async (id: string, content: string, sourceThreadId: string | null) => {
      const contentRef = `memory-content:${id}`;
      await write(contentRef, content);
      await repository.productMemoryState().save(
        {
          id: createMemoryId(id),
          ...scope,
          revision: 1,
          status: "active",
          contentRef: contentRef as never,
          dataClassification: "private",
          sourceThreadId: sourceThreadId as never,
          sourceRefs: [`message-${id}`],
          inference: false,
          confidencePermille: 950,
          policyVersion: "memory-capture:v2",
          providerRecordId: null,
          lastUsedAt: null,
          updatedAt: now(),
          attributes: DEFAULT_MEMORY_ATTRIBUTES,
        },
        null,
      );
    };
    return {
      repository,
      memories,
      remember,
      inbox,
      threads,
      commands,
      mainThread,
      externalContent,
      tellOwner,
      worker,
      ledger,
      text,
      write,
      query,
      admitted,
      finish,
      mail,
      clock,
      due,
      reminders,
    };
  }

  it("writes the event as a hidden system message, speaks with tell_owner and records the decision", async () => {
    const f = await fixture();
    expect((await f.mail("gmail:1", "发件人 school@example.com：周四家长会")).accepted).toBe(true);
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    const handled = f.worker.handle(claim);
    const runId = await f.admitted();
    const main = await f.mainThread.ensure();
    const eventMessage = f.query<{ role: string; internal: number; content_ref: string }>(
      "SELECT role, internal, content_ref FROM thread_messages WHERE run_id = ? AND role <> 'agent'",
      runId,
    )[0];
    expect(eventMessage).toMatchObject({ role: "system", internal: 1 });
    const eventText = (await f.text(eventMessage?.content_ref ?? "")) ?? "";
    expect(eventText).toContain("不是主人说的话");
    expect(eventText).toContain("周四家长会");
    let origins: readonly string[] = [];
    for (let attempt = 0; attempt < 200 && origins.length === 0; attempt += 1) {
      origins = (await f.externalContent.readThread(main)).map(({ origin }) => origin);
      if (origins.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(origins).toEqual(["external_event:mail"]);
    expect(await f.threads.listRuns(OWNER_ID, AGENT_ID, main)).toEqual([]);
    const said = (await f.tellOwner.run({
      runId,
      toolCallId: "call-1",
      capabilityRef: "owner.tell",
      capabilityHandleRef: null,
      arguments: { text: "学校周四开家长会，要我记进日历吗？", push: true, reason: "要你拿主意" },
    } as never)) as { messageId: string; pushed: boolean };
    expect(said.pushed).toBe(true);
    await f.finish(runId, "这封要告诉主人");
    expect(await handled).toEqual({
      status: "done",
      entryIds: claim.entries.map((e) => e.id),
      result: "handled",
    });
    const visible = await f.threads.listMessages(OWNER_ID, AGENT_ID, main, 0, 20);
    expect(visible.map(({ role, id }) => [role, id])).toEqual([["agent", said.messageId]]);
    const rows = f.query<{
      verdict: string;
      reason_code: string;
      inputs: string;
      push_source_key: string;
    }>(
      "SELECT verdict, reason_code, inputs, push_source_key FROM decision_ledger WHERE kind = 'proactive'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: "pushed", reason_code: "told_pushed" });
    expect(JSON.parse(rows[0]?.inputs ?? "{}")).toMatchObject({
      messageId: said.messageId,
      sourceIds: ["gmail:1"],
    });
    const pushes = f.query<{ source_key: string; kind: string; source_ref: string }>(
      "SELECT source_key, kind, source_ref FROM web_push_outbox",
    );
    expect(pushes).toEqual([
      { source_key: rows[0]?.push_source_key, kind: "reminder", source_ref: said.messageId },
    ]);
    expect(pushes[0]?.source_key.startsWith("said:")).toBe(true);
    expect(f.query<{ outcome: string }>("SELECT outcome FROM inbox_events")[0]?.outcome).toBe(
      "told",
    );
  });

  it("records silence with her thought when she does not speak, and nothing shows or pushes", async () => {
    const f = await fixture();
    await f.mail("gmail:ad", "发件人 shop@example.com：限时打折");
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    const handled = f.worker.handle(claim);
    const runId = await f.admitted();
    await f.finish(runId, "广告，不打扰主人");
    await handled;
    const main = await f.mainThread.ensure();
    expect(await f.threads.listMessages(OWNER_ID, AGENT_ID, main, 0, 20)).toEqual([]);
    const finalAnswer = f.query<{ internal: number }>(
      "SELECT internal FROM thread_messages WHERE run_id = ? AND role = 'agent'",
      runId,
    );
    expect(finalAnswer).toEqual([{ internal: 1 }]);
    const rows = f.query<{ verdict: string; reason_code: string; reason_ref: string }>(
      "SELECT verdict, reason_code, reason_ref FROM decision_ledger WHERE kind = 'proactive'",
    );
    expect(rows).toMatchObject([{ verdict: "silent", reason_code: "kept_silent" }]);
    expect(await f.text(rows[0]?.reason_ref ?? "")).toBe("广告，不打扰主人");
    expect(f.query("SELECT 1 FROM web_push_outbox")).toEqual([]);
    expect(f.query<{ outcome: string }>("SELECT outcome FROM inbox_events")[0]?.outcome).toBe(
      "silent",
    );
  });

  it("[ADR-0285] puts a memory saved outside the main conversation into the inbox by number only, and records her silence", async () => {
    const f = await fixture();
    const main = await f.mainThread.ensure();
    await f.remember("memory:oolong", "主人喜欢喝乌龙茶", null);
    await f.remember("memory:said-here", "主人下周三去大阪出差", main);
    expect(await f.memories.tick()).toBe(1);
    expect(await f.memories.tick()).toBe(0);
    const rows = f.query<{ source_ref: string; summary_ref: string; priority: number }>(
      "SELECT source_ref, summary_ref, priority FROM inbox_events WHERE source_kind = ?",
      MEMORY_SAVED_EVENT_KIND,
    );
    expect(rows).toMatchObject([{ source_ref: "memory:oolong", priority: 5 }]);
    const summary = await f.text(rows[0]?.summary_ref ?? "");
    expect(summary).toContain("第 1 条");
    expect(summary).toContain("memory_open");
    expect(summary).not.toContain("乌龙茶");
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    expect(claim.threadId).toBeNull();
    const handled = f.worker.handle(claim);
    const runId = await f.admitted();
    await f.finish(runId, "和时间无关的口味偏好，不用说");
    expect(await handled).toMatchObject({ status: "done", result: "handled" });
    expect(await f.threads.listMessages(OWNER_ID, AGENT_ID, main, 0, 20)).toEqual([]);
    expect(
      f.query<{ verdict: string }>("SELECT verdict FROM decision_ledger WHERE kind = 'proactive'"),
    ).toEqual([{ verdict: "silent" }]);
  });

  it("REVERSE: after a restart the same saved memory adds no second inbox row", async () => {
    const f = await fixture();
    await f.remember("memory:oolong", "主人喜欢喝乌龙茶", null);
    expect(await f.memories.tick()).toBe(1);
    const fresh = new ProductionMemoryInbox({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      state: f.repository.productMemoryState(),
      mainThread: f.mainThread,
      formatTime: (iso) => iso,
      clock: { now: () => f.clock.value },
    });
    fresh.attach(f.inbox);
    expect(await fresh.tick()).toBe(0);
    expect(
      f.query("SELECT 1 FROM inbox_events WHERE source_kind = ?", MEMORY_SAVED_EVENT_KIND),
    ).toHaveLength(1);
  });

  it("keeps one inbox row and one decision when the same mail arrives twice", async () => {
    const f = await fixture();
    await f.mail("gmail:2", "同一封");
    expect(await f.mail("gmail:2", "同一封")).toMatchObject({ accepted: true, duplicate: true });
    expect(f.query("SELECT 1 FROM inbox_events")).toHaveLength(1);
  });

  it("refuses tell_owner outside a run that an outside event started", async () => {
    const f = await fixture();
    await expect(
      f.tellOwner.run({
        runId: createRunId("run:owner"),
        toolCallId: "call-1",
        capabilityRef: "owner.tell",
        capabilityHandleRef: null,
        arguments: { text: "你好", push: false, reason: "测试" },
      } as never),
    ).rejects.toBeInstanceOf(TellOwnerInputError);
  });

  it("waits while the owner's own reply is still running", async () => {
    const f = await fixture();
    const main = await f.mainThread.ensure();
    const thread = await f.threads.read(OWNER_ID, AGENT_ID, main);
    await f.write("owner-says", "你好");
    await f.commands.admitOwnerMessage({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: main,
      expectedThreadRevision: thread?.revision ?? 0,
      sessionId: createSessionId("session-owner"),
      idempotencyKey: "owner-1",
      contentRef: "owner-says" as never,
      sourceProofRef: "owner-proof",
      dataClassification: "private",
      resultRef: "owner-says" as never,
    });
    await f.mail("gmail:3", "一封邮件");
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    expect(await f.worker.handle(claim)).toMatchObject({ status: "done", result: "yield" });
    expect(f.query("SELECT 1 FROM runs WHERE id LIKE 'run:inbox:%'")).toEqual([]);
  });

  it("stops an outside event's run when the owner speaks and puts the event back in the inbox", async () => {
    const f = await fixture();
    await f.mail("gmail:4", "一封要慢慢看的邮件");
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    const handled = f.worker.handle(claim);
    const runId = await f.admitted();
    const main = await f.mainThread.ensure();
    const thread = await f.threads.read(OWNER_ID, AGENT_ID, main);
    await f.write("owner-speaks", "帮我设个明早 7 点的闹钟");
    await f.commands.admitOwnerMessage({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: main,
      expectedThreadRevision: thread?.revision ?? 0,
      sessionId: createSessionId("session-owner-speaks"),
      idempotencyKey: "owner-speaks",
      contentRef: "owner-speaks" as never,
      sourceProofRef: "owner-proof",
      dataClassification: "private",
      resultRef: "owner-speaks" as never,
    });
    expect(await handled).toMatchObject({ status: "done", result: "yield" });
    expect(f.query<{ status: string }>("SELECT status FROM runs WHERE id = ?", runId)).toEqual([
      { status: "cancelled" },
    ]);
    expect(f.query<{ status: string }>("SELECT status FROM inbox_events")).toEqual([
      { status: "queued" },
    ]);
    expect(f.query("SELECT 1 FROM decision_ledger")).toEqual([]);
  });

  it("lets an outside event's run finish when the owner has not spoken", async () => {
    const f = await fixture();
    await f.mail("gmail:5", "不急的邮件");
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    const handled = f.worker.handle(claim);
    const runId = await f.admitted();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.query<{ status: string }>("SELECT status FROM runs WHERE id = ?", runId)).toEqual([
      { status: "accepted" },
    ]);
    await f.finish(runId, "不用管");
    expect(await handled).toMatchObject({ status: "done", result: "handled" });
  });

  it("names outside events by their kind, so the origin list does not grow with every event", () => {
    const origin = (sourceId: string) =>
      externalEventOrigin({ sourceType: "external_event", sourceId } as never);
    expect(origin("message:inbox:mail:aaa")).toBe("external_event:mail");
    expect(origin("message:inbox:mail:bbb")).toBe("external_event:mail");
  });

  const rent = (remindAt = "2026-11-25T00:00:00.000Z"): MemoryReminder =>
    ({
      id: "reminder:rent",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      memoryId: "memory:rent",
      dueAt: remindAt,
      remindAt,
      repeat: "none",
      status: "scheduled",
      dismissedAt: null,
      createdAt: START,
      updatedAt: START,
    }) as MemoryReminder;

  it("[ADR-0285] wakes her for a due reminder, once, and lets her leave it in the main conversation without pushing", async () => {
    const f = await fixture();
    f.due.push(rent());
    expect(await f.reminders.tick()).toBe(1);
    await f.reminders.tick();
    expect(
      f.query<{ source_kind: string; priority: number }>(
        "SELECT source_kind, priority FROM inbox_events",
      ),
    ).toEqual([{ source_kind: "reminder", priority: 1 }]);
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    const handled = f.worker.handle(claim);
    const runId = await f.admitted();
    const eventText =
      (await f.text(
        f.query<{ content_ref: string }>(
          "SELECT content_ref FROM thread_messages WHERE run_id = ? AND role <> 'agent'",
          runId,
        )[0]?.content_ref ?? "",
      )) ?? "";
    expect(eventText).toContain("主人定的提醒到点了：交房租（定的时间：北京时间 00:00）");
    const said = (await f.tellOwner.run({
      runId,
      toolCallId: "call-rent",
      capabilityRef: "owner.tell",
      capabilityHandleRef: null,
      arguments: {
        text: "交房租的提醒到了，你上午说已经交了，所以没推手机。",
        push: false,
        reason: "主人说过已经交了",
      },
    } as never)) as { messageId: string; pushed: boolean };
    expect(said.messageId).toBe(reminderMessageId("reminder:rent", rent().remindAt));
    await f.finish(runId, "已经交了，不推");
    expect(await handled).toMatchObject({ result: "handled" });
    const main = await f.mainThread.ensure();
    const visible = await f.threads.listMessages(OWNER_ID, AGENT_ID, main, 0, 20);
    expect(visible.map(({ id }) => id)).toEqual([said.messageId]);
    expect(f.query("SELECT 1 FROM web_push_outbox")).toEqual([]);
    expect(
      f.query<{ verdict: string; reason_code: string }>(
        "SELECT verdict, reason_code FROM decision_ledger WHERE kind = 'proactive'",
      ),
    ).toEqual([{ verdict: "silent", reason_code: "told_in_app" }]);
  });

  it("REVERSE: writes the reminder's own words into the main conversation and pushes them when her run fails", async () => {
    const f = await fixture();
    f.due.push(rent());
    await f.reminders.tick();
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    const handled = f.worker.handle(claim);
    const runId = await f.admitted();
    const handle = openQualifiedDatabase(
      f.query<{ file: string }>("PRAGMA database_list")[0]?.file ?? "",
    );
    try {
      handle.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
    } finally {
      handle.close();
    }
    expect(await handled).toMatchObject({ result: "handled" });
    expect(f.query<{ outcome: string }>("SELECT outcome FROM inbox_events")).toEqual([
      { outcome: "reminder_fallback" },
    ]);
    const main = await f.mainThread.ensure();
    const visible = await f.threads.listMessages(OWNER_ID, AGENT_ID, main, 0, 20);
    const messageId = reminderMessageId("reminder:rent", rent().remindAt);
    expect(visible.map(({ id }) => id)).toEqual([messageId]);
    expect(await f.text(visible[0]?.contentRef ?? "")).toBe("交房租");
    expect(
      f.query<{ kind: string; source_ref: string }>("SELECT kind, source_ref FROM web_push_outbox"),
    ).toEqual([{ kind: "reminder", source_ref: messageId }]);
  });

  it("REVERSE: keeps one reminder message when her run is too slow and then finishes late", async () => {
    const f = await fixture({ reminderGraceMs: 0 });
    f.due.push(rent());
    await f.reminders.tick();
    const claim = await f.worker.claim();
    if (!claim) throw new Error("no claim");
    const handled = f.worker.handle(claim);
    const runId = await f.admitted();
    const messageId = reminderMessageId("reminder:rent", rent().remindAt);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (f.query("SELECT 1 FROM thread_messages WHERE id = ?", messageId).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const late = (await f.tellOwner.run({
      runId,
      toolCallId: "call-late",
      capabilityRef: "owner.tell",
      capabilityHandleRef: null,
      arguments: { text: "该交房租了", push: true, reason: "到点了" },
    } as never)) as { alreadyTold?: boolean };
    expect(late.alreadyTold).toBe(true);
    await f.finish(runId, "到点提醒");
    expect(await handled).toMatchObject({ result: "handled" });
    const main = await f.mainThread.ensure();
    const visible = await f.threads.listMessages(OWNER_ID, AGENT_ID, main, 0, 20);
    expect(visible.map(({ id }) => id)).toEqual([messageId]);
    expect(f.query("SELECT 1 FROM web_push_outbox")).toHaveLength(1);
  });
});
