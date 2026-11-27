import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type PayloadProtectorPort, ThreadCommandService } from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunId,
  createSessionId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.ts";
import { ProductionApprovalAnswers } from "../../apps/agent-service/src/production-approval-answers.ts";
import { ProductionInbox } from "../../apps/agent-service/src/production-inbox.ts";
import {
  InboxRunRegistry,
  ProductionInboxDelivery,
} from "../../apps/agent-service/src/production-inbox-delivery.ts";
import { ProductionInboxWorker } from "../../apps/agent-service/src/production-inbox-worker.ts";
import { ProductionMainThread } from "../../apps/agent-service/src/production-main-thread.ts";
import { ProductionSubthreads } from "../../apps/agent-service/src/production-subthreads.ts";
import {
  ProductionThreadTasks,
  SubthreadToolError,
} from "../../apps/agent-service/src/production-thread-tasks.ts";
import { ProductionTimerControl } from "../../apps/agent-service/src/production-timer-control.ts";
import { fixture as contractFixture } from "../../packages/gateway-contracts/test/gateway-v2.fixture.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-subthreads");
const AGENT_ID = createAgentId("agent-subthreads");
const DEPLOYMENT_ID = createDeploymentId("deployment-subthreads");
const LEASE_ID = createAuthorityLeaseId("lease-subthreads");
const START = "2026-11-25T00:00:00.000Z";
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const authority: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};
const BRIEF = {
  objective: "比较三家东京的牙科诊所",
  background: "主人想找离公司近、评价好的牙医",
  done_when: "三家都有评价、价格和离公司多远",
  avoid: "不替主人预约",
  deliver: "一张三行的对比",
  matter: "找牙医",
  title: "比牙医",
};

describe("subthreads opened by the main conversation", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-subthreads-"));
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
        VALUES (?, ?, ?, ?, 'holder-subthreads', 1, 1, ?, '2026-11-26T00:00:00.000Z')`,
      )
      .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, START);
    database.close();
    let current = START;
    const now = () => current;
    const setNow = (value: string) => {
      current = value;
    };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath: file,
      minimumFreeBytes: 0,
      now,
    });
    closers.push(() => repository.close());
    const protector: PayloadProtectorPort = createReferenceAdapterSet().payloadProtector;
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
    const runSources = repository.runExecutionSource(OWNER_ID, AGENT_ID);
    const externalContent = new ContextExternalContent({
      configuration: scope,
      state: repository,
      source: runSources,
      authority: () => ({ leaseId: LEASE_ID, fencingToken: 1 }),
      clock: { now },
    });
    const store = repository.subthreads();
    const tasks: ProductionThreadTasks = new ProductionThreadTasks({
      ...scope,
      store,
      payloads,
      protector,
      clock: { now },
      conversation: (runId) => subthreads.conversation(runId),
    });
    const subthreads: ProductionSubthreads = new ProductionSubthreads({
      ...scope,
      mainThread,
      threads,
      commands,
      store,
      tasks,
      externalContent,
      threadOf: async (runId) => (await runSources.read(createRunId(runId)))?.threadId,
      payloads,
      protector,
      clock: { now },
    });
    const query = <T>(sql: string, ...parameters: unknown[]) => {
      const handle = openQualifiedDatabase(file);
      try {
        return handle.prepare(sql).all(...parameters) as T[];
      } finally {
        handle.close();
      }
    };
    const delivery = new ProductionInboxDelivery({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      mainThread,
      threads,
      commands,
      runs: repository.runLifecycle(OWNER_ID, AGENT_ID, authority),
      ledger: repository.decisionLedger(),
      externalContent,
      registry: new InboxRunRegistry(),
      payloads,
      protector,
      clock: { now },
      pollMs: 5,
      subthreads,
      checkpoints: repository.runCheckpointStore(OWNER_ID, AGENT_ID, authority),
    });
    const inboxStore = repository.inbox();
    const inbox = new ProductionInbox({
      scope,
      store: inboxStore,
      payloads,
      protector,
      clock: { now },
    });
    inbox.sources.register({
      kind: "mail",
      describe: "新邮件",
      externalContent: true,
      fromOwner: false,
      priority: 5,
    });
    subthreads.registerSources(inbox.sources);
    const cancelled: string[] = [];
    subthreads.attach({
      inbox,
      cancelThreadRuns: async (threadId) => {
        cancelled.push(threadId);
      },
    });
    const worker = new ProductionInboxWorker({
      scope,
      inbox,
      store: inboxStore,
      payloads,
      protector,
      clock: { now },
      delivery,
      runTimeoutMs: 60_000,
    });
    const text = async (ref: string) => {
      const payload = await payloads.get(ref as never);
      if (!payload) return undefined;
      return new TextDecoder().decode(await protector.unprotect({ ...scope, payload }));
    };
    const write = async (ref: string, content: string) => {
      await payloads.put(
        await protector.protect({
          ...scope,
          ref,
          contentType: "text/plain",
          dataClassification: "private",
          plaintext: new TextEncoder().encode(content),
          createdAt: now(),
        }),
      );
    };
    const ownerSays = async (key: string, words: string) => {
      const main = await mainThread.ensure();
      const thread = await threads.read(OWNER_ID, AGENT_ID, main);
      await write(`owner:${key}`, words);
      await commands.admitOwnerMessage({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: main,
        expectedThreadRevision: thread?.revision ?? 0,
        sessionId: createSessionId(`session-${key}`),
        idempotencyKey: `owner-${key}`,
        contentRef: `owner:${key}` as never,
        sourceProofRef: "owner-proof",
        dataClassification: "private",
        resultRef: `owner:${key}` as never,
      });
      const row = query<{ id: string; run_id: string }>(
        "SELECT id, run_id FROM thread_messages WHERE content_ref = ?",
        `owner:${key}`,
      )[0];
      if (!row) throw new Error("owner message missing");
      return { messageId: row.id, runId: createRunId(row.run_id) };
    };
    const finish = async (threadId: string, runId: string) => {
      const thread = await threads.read(OWNER_ID, AGENT_ID, threadId as never);
      const turn = query<{ id: string }>("SELECT id FROM turns WHERE run_id = ?", runId)[0];
      if (!thread || !turn) throw new Error("run state missing");
      await write(`answer:${runId}`, "好");
      await commands.commitAssistantMessage({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: threadId as never,
        expectedThreadRevision: thread.revision,
        turnId: turn.id as never,
        runId: createRunId(runId),
        idempotencyKey: `final:${runId}`,
        contentRef: `answer:${runId}` as never,
        dataClassification: "private",
        resultRef: `answer:${runId}` as never,
      });
    };
    const admittedOn = async (threadId: string, handled: Promise<unknown>) => {
      let settled: unknown;
      void handled.then(
        (value) => {
          settled = value ?? "settled";
        },
        (error: unknown) => {
          settled = error;
        },
      );
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (settled !== undefined)
          throw new Error(
            `delivery ended early: ${String(JSON.stringify(settled) ?? settled)} ${String(settled)}`,
          );
        const runs = query<{ id: string }>(
          "SELECT id FROM runs WHERE thread_id = ? AND id LIKE 'run:inbox:%' AND status = 'accepted'",
          threadId,
        );
        if (runs[0]) return runs[0].id;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("no run admitted");
    };
    const deliverOne = async () => {
      const claim = await worker.claim();
      if (!claim) throw new Error("nothing queued");
      const target = claim.threadId ?? (await mainThread.ensure());
      const handled = worker.handle(claim);
      const runId = await admittedOn(target, handled);
      return { claim, handled, runId, threadId: target };
    };
    let calls = 0;
    const call = (runId: string, tool: string, args: Record<string, unknown>, callId?: string) => {
      calls += 1;
      const invocation = {
        runId: createRunId(runId),
        toolCallId: callId ?? `call-${calls}`,
        capabilityRef: tool.startsWith("task_") ? `owner.plan.${tool}` : `owner.subthread.${tool}`,
        capabilityHandleRef: null,
        arguments: args,
        dataClassification: "private",
      } as never;
      return tool.startsWith("task_") ? tasks.run(invocation) : subthreads.run(invocation);
    };
    const open = async (
      key = "dentist",
      words = "帮我比较三家东京的牙科诊所",
      matter = BRIEF.matter,
    ) => {
      const said = await ownerSays(key, words);
      const opened = (await call(said.runId, "open_subthread", {
        ...BRIEF,
        matter,
        owner_messages: [said.messageId],
      })) as { value: { subthread: string } };
      return { ...said, subthread: opened.value.subthread };
    };
    const started = async (threadId: string) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const delivered = await deliverOne().catch((error: unknown) => {
          if (error instanceof Error && error.message.startsWith("delivery ended early"))
            return undefined;
          throw error;
        });
        if (!delivered) continue;
        if (delivered.threadId === threadId) return delivered;
        await finish(delivered.threadId, delivered.runId);
        await delivered.handled;
      }
      throw new Error(`nothing delivered to ${threadId}`);
    };
    const settle = async (delivered: {
      threadId: string;
      runId: string;
      handled: Promise<unknown>;
    }) => {
      await finish(delivered.threadId, delivered.runId);
      await delivered.handled;
    };
    const lastMessage = async (runId: string) => {
      const row = query<{ content_ref: string }>(
        "SELECT content_ref FROM thread_messages WHERE run_id = ? ORDER BY sequence LIMIT 1",
        runId,
      )[0];
      return (await text(row?.content_ref ?? "")) ?? "";
    };
    return {
      repository,
      file,
      threads,
      mainThread,
      externalContent,
      store,
      subthreads,
      inbox,
      worker,
      query,
      text,
      finish,
      deliverOne,
      ownerSays,
      call,
      open,
      started,
      settle,
      lastMessage,
      cancelled,
      setNow,
    };
  }

  const timerEvents = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.query<{ source_ref: string; source_version: string; thread_id: string }>(
      "SELECT source_ref, source_version, thread_id FROM inbox_events WHERE source_kind = 'timer' ORDER BY created_at, source_version",
    );
  const timers = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.query<{ status: string; next_at: string | null; run_count: number; created_by: string }>(
      "SELECT status, next_at, run_count, created_by FROM subthread_timers ORDER BY id",
    );

  it("[ADR-0285] schedules a daily task in its own subthread and wakes it once per due time", async () => {
    const f = await fixture();
    const said = await f.ownerSays("umbrella", "每晚九点查一下明天要不要带伞");
    const scheduled = (await f.call(said.runId, "schedule_task", {
      task: "查东京明天会不会下雨，会下就提醒带伞",
      schedule: { daily_at: "21:00" },
      created_by: "owner",
      matter: "带伞",
      title: "查明天带伞",
    })) as { value: { subthread: string; timer: string; next_at: string } };
    expect(scheduled.value.next_at).toBe("2026-11-25T12:00:00.000Z");
    expect(timers(f)).toEqual([
      {
        status: "active",
        next_at: "2026-11-25T12:00:00.000Z",
        run_count: 0,
        created_by: "owner",
      },
    ]);
    expect(f.query("SELECT COUNT(*) AS n FROM inbox_events")).toEqual([{ n: 0 }]);
    f.setNow("2026-11-25T11:59:00.000Z");
    await f.subthreads.tickTimers();
    expect(timerEvents(f)).toEqual([]);
    f.setNow("2026-11-25T12:00:05.000Z");
    await f.subthreads.tickTimers();
    await f.subthreads.tickTimers();
    expect(timerEvents(f)).toEqual([
      {
        source_ref: scheduled.value.timer,
        source_version: "2026-11-25T12:00:00.000Z",
        thread_id: scheduled.value.subthread,
      },
    ]);
    expect(timers(f)[0]).toMatchObject({
      status: "active",
      next_at: "2026-11-26T12:00:00.000Z",
      run_count: 1,
    });
    const delivered = await f.started(scheduled.value.subthread);
    const first = await f.lastMessage(delivered.runId);
    expect(first).toContain("每次到点会叫醒你做一次");
    expect(first).toContain("查东京明天会不会下雨，会下就提醒带伞");
    expect(first).toContain("每天 21:00（Asia/Tokyo）");
    expect(first).toContain("第 1 次，2026-11-25 21:00（Asia/Tokyo）");
    await f.settle(delivered);
    const views = await f.subthreads.listTimers();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ title: "查明天带伞", schedule: "每天 21:00（Asia/Tokyo）" });
    expect(f.query("SELECT status FROM subthreads")).toEqual([{ status: "open" }]);
  });

  it("REVERSE: after the service was down a recurring task runs only its latest missed time, and a late follow-up runs once", async () => {
    const f = await fixture();
    const said = await f.ownerSays("watch", "每五分钟看一下那个页面，下午再跟进一次");
    const every = (await f.call(said.runId, "schedule_task", {
      task: "看一下那个页面有没有更新",
      schedule: { every_minutes: 5 },
      created_by: "agreed",
      matter: "盯页面",
      title: "盯页面",
    })) as { value: { timer: string; next_at: string } };
    expect(every.value.next_at).toBe("2026-11-25T00:05:00.000Z");
    const once = (await f.call(said.runId, "schedule_task", {
      task: "跟进那封信有没有回",
      schedule: { once_at: "2026-11-25T09:10:00+09:00" },
      created_by: "self",
      matter: "跟进回信",
      title: "跟进回信",
    })) as { value: { timer: string; next_at: string } };
    expect(once.value.next_at).toBe("2026-11-25T00:10:00.000Z");
    f.setNow("2026-11-25T00:21:30.000Z");
    await f.subthreads.tickTimers();
    await f.subthreads.tickTimers();
    expect(
      timerEvents(f).map(({ source_ref, source_version }) => [source_ref, source_version]),
    ).toEqual([
      [once.value.timer, "2026-11-25T00:10:00.000Z"],
      [every.value.timer, "2026-11-25T00:20:00.000Z"],
    ]);
    const rows = f.query<{ id: string; status: string; next_at: string | null; run_count: number }>(
      "SELECT id, status, next_at, run_count FROM subthread_timers",
    );
    expect(rows.find((row) => row.id === every.value.timer)).toMatchObject({
      status: "active",
      next_at: "2026-11-25T00:25:00.000Z",
      run_count: 1,
    });
    expect(rows.find((row) => row.id === once.value.timer)).toMatchObject({
      status: "finished",
      next_at: null,
      run_count: 1,
    });
    f.setNow("2026-11-25T00:24:00.000Z");
    await f.subthreads.tickTimers();
    expect(timerEvents(f)).toHaveLength(2);
  });

  it("REVERSE: a paused, cancelled or stopped timer does not fire, and a resumed one does", async () => {
    const f = await fixture();
    const said = await f.ownerSays("three", "定三个每五分钟的检查");
    const make = async (title: string) =>
      (
        (await f.call(said.runId, "schedule_task", {
          task: `${title}的检查`,
          schedule: { every_minutes: 5 },
          created_by: "owner",
          matter: title,
          title,
        })) as { value: { timer: string; subthread: string } }
      ).value;
    const paused = await make("暂停的");
    const cancelled = await make("撤销的");
    const stopped = await make("叫停的");
    await f.subthreads.pauseTimer(paused.timer);
    await f.subthreads.cancelTimer(cancelled.timer);
    await f.call(said.runId, "stop_subthread", { subthread: stopped.subthread, reason: "不要了" });
    f.setNow("2026-11-25T00:06:00.000Z");
    await f.subthreads.tickTimers();
    expect(timerEvents(f)).toEqual([]);
    const status = () =>
      Object.fromEntries(
        f
          .query<{ id: string; status: string }>("SELECT id, status FROM subthread_timers")
          .map((row) => [row.id, row.status]),
      );
    expect(status()).toEqual({
      [paused.timer]: "paused",
      [cancelled.timer]: "cancelled",
      [stopped.timer]: "cancelled",
    });
    expect(
      f.query("SELECT status FROM subthreads WHERE thread_id = ?", cancelled.subthread),
    ).toEqual([{ status: "stopped" }]);
    await f.subthreads.resumeTimer(paused.timer);
    await f.subthreads.tickTimers();
    expect(timerEvents(f)).toEqual([]);
    f.setNow("2026-11-25T00:10:30.000Z");
    await f.subthreads.tickTimers();
    expect(timerEvents(f).map((event) => event.source_ref)).toEqual([paused.timer]);
  });

  it("[ADR-0285] lists every timer for the owner's App and lets the owner pause, resume and cancel one", async () => {
    const f = await fixture();
    const said = await f.ownerSays("list", "每晚九点查一下明天要不要带伞");
    const scheduled = (
      (await f.call(said.runId, "schedule_task", {
        task: "查东京明天会不会下雨",
        schedule: { daily_at: "21:00" },
        created_by: "owner",
        owner_messages: [said.messageId],
        matter: "带伞",
        title: "查明天带伞",
      })) as { value: { timer: string; subthread: string } }
    ).value;
    const rent = {
      id: "reminder:memory-rent",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      memoryId: "memory-rent",
      status: "scheduled",
      dueAt: "2026-11-27T23:00:00.000Z",
      remindAt: "2026-11-27T23:00:00.000Z",
      repeat: "none",
      dismissedAt: null,
      createdAt: START,
      updatedAt: START,
    } as const;
    const reminderRows = new Map<string, typeof rent | (typeof rent & { status: "cancelled" })>([
      [rent.id, rent],
    ]);
    const control = new ProductionTimerControl({
      subthreads: f.subthreads,
      scope,
      clock: { now: () => START },
      reminders: {
        writer: {
          list: async () => ({
            reminders: [...reminderRows.values()]
              .filter((row) => row.status === "scheduled")
              .map((row) => ({
                reminderId: row.id,
                memoryId: row.memoryId,
                text: "交房租",
                dueAt: row.dueAt,
                remindAt: row.remindAt,
                repeat: row.repeat,
              })),
            more: false,
          }),
          cancel: async (id: string) => {
            const row = reminderRows.get(id);
            if (!row) throw new Error("REMINDER_NOT_FOUND");
            reminderRows.set(id, { ...row, status: "cancelled" as never });
            return row as never;
          },
        },
        read: async (id: string) => reminderRows.get(id) as never,
      },
    });
    const change = (action: string, actorType = "owner", timerId = scheduled.timer) =>
      control.execute({
        kind: "command",
        type: "timers.change",
        actor: { actorType, actorId: "owner" },
        scope,
        payload: { timerId, action },
      } as never);
    const read = async () =>
      (
        (await control.query({
          kind: "query",
          type: "timers.read",
          payload: {},
        } as never)) as unknown as {
          payload: { timers: Record<string, unknown>[] };
        }
      ).payload.timers;
    expect(await read()).toEqual([
      {
        timerId: scheduled.timer,
        kind: "recurring",
        title: "查明天带伞",
        task: "查东京明天会不会下雨",
        ownerWords: "- 每晚九点查一下明天要不要带伞",
        schedule: "每天 21:00（Asia/Tokyo）",
        createdBy: "owner",
        status: "active",
        nextAt: "2026-11-25T12:00:00.000Z",
        lastAt: null,
        runCount: 0,
        spentMicros: 0,
        runBudgetMicros: 500_000,
        lastResult: null,
        createdAt: START,
      },
      {
        timerId: rent.id,
        kind: "reminder",
        title: null,
        task: "交房租",
        ownerWords: null,
        schedule: "一次，2026-11-28 08:00（Asia/Tokyo）",
        createdBy: "owner",
        status: "active",
        nextAt: rent.remindAt,
        lastAt: null,
        runCount: 0,
        spentMicros: 0,
        runBudgetMicros: null,
        lastResult: null,
        createdAt: START,
      },
    ]);
    await expect(change("pause", "owner", rent.id)).rejects.toThrow("TIMER_ACTION_NOT_SUPPORTED");
    await change("cancel", "owner", rent.id);
    expect((await read()).map((row) => row["kind"])).toEqual(["recurring"]);
    f.setNow("2026-11-25T12:00:05.000Z");
    await f.subthreads.tickTimers();
    const wake = await f.started(scheduled.subthread);
    await f.call(wake.runId, "tell_main", { kind: "progress", text: "明天不下雨，不用带伞" });
    await f.settle(wake);
    expect((await read())[0]).toMatchObject({
      lastAt: "2026-11-25T12:00:00.000Z",
      runCount: 1,
      lastResult: { text: "明天不下雨，不用带伞", at: "2026-11-25T12:00:05.000Z" },
    });
    await change("pause");
    expect((await read())[0]).toMatchObject({ status: "paused" });
    await change("pause");
    expect((await read())[0]).toMatchObject({ status: "paused" });
    await change("resume");
    expect((await read())[0]).toMatchObject({
      status: "active",
      nextAt: "2026-11-26T12:00:00.000Z",
    });
    await expect(change("cancel", "client")).rejects.toThrow("TIMER_OWNER_REQUIRED");
    await expect(change("cancel", "owner", "timer:missing")).rejects.toThrow("TIMER_NOT_FOUND");
    expect((await read())[0]).toMatchObject({ status: "active" });
    await change("cancel");
    expect((await read())[0]).toMatchObject({ status: "cancelled", nextAt: null });
    await expect(change("resume")).rejects.toThrow("TIMER_STATE_CHANGED");
    expect(f.query("SELECT status FROM subthreads")).toEqual([{ status: "stopped" }]);
    f.setNow("2026-11-26T12:00:05.000Z");
    await f.subthreads.tickTimers();
    expect(timerEvents(f)).toHaveLength(1);
  });

  it("[I-126] sends the timer list to the App when the owner's words, the task and the last result span several lines", async () => {
    const f = await fixture();
    const first = await f.ownerSays("lines-1", "每晚九点查一下明天要不要带伞");
    const second = await f.ownerSays("lines-2", "下雨的话顺便提醒我穿厚点");
    const scheduled = (
      (await f.call(second.runId, "schedule_task", {
        task: "查东京明天会不会下雨\n下雨就提醒带伞和穿厚点",
        schedule: { daily_at: "21:00" },
        created_by: "owner",
        owner_messages: [first.messageId, second.messageId],
        matter: "带伞",
        title: "🌂查明天带伞和穿衣提醒🌂查明天带伞和穿衣",
      })) as { value: { timer: string; subthread: string } }
    ).value;
    f.setNow("2026-11-25T12:00:05.000Z");
    await f.subthreads.tickTimers();
    const wake = await f.started(scheduled.subthread);
    await f.call(wake.runId, "tell_main", { kind: "progress", text: "明天有雨\n记得带伞" });
    await f.settle(wake);
    const control = new ProductionTimerControl({
      subthreads: f.subthreads,
      scope,
      clock: { now: () => START },
    });
    const snapshot = await control.query({
      kind: "query",
      type: "timers.read",
      payload: {},
    } as never);
    const sent = gatewayV2MessageSchema.parseJson(
      gatewayV2MessageSchema.serialize(
        contractFixture("snapshot", "timers.snapshot", snapshot.payload) as never,
      ),
    ) as unknown as { payload: { timers: Record<string, unknown>[] } };
    expect(sent.payload.timers[0]).toMatchObject({
      title: "🌂查明天带伞和穿衣提醒🌂查明天带伞和穿衣",
      task: "查东京明天会不会下雨\n下雨就提醒带伞和穿厚点",
      ownerWords: "- 每晚九点查一下明天要不要带伞\n- 下雨的话顺便提醒我穿厚点",
      lastResult: { text: "明天有雨\n记得带伞" },
    });
  });

  it("REVERSE: refuses a schedule that is not exactly one of the three kinds and stores nothing", async () => {
    const f = await fixture();
    const said = await f.ownerSays("bad", "定个时");
    for (const schedule of [
      {},
      { daily_at: "25:00" },
      { every_minutes: 1 },
      { once_at: "2026-11-25T21:00:00" },
      { daily_at: "21:00", every_minutes: 5 },
    ])
      await expect(
        f.call(said.runId, "schedule_task", {
          task: "查天气",
          schedule,
          created_by: "owner",
          matter: "天气",
          title: "查天气",
        }),
      ).rejects.toBeInstanceOf(SubthreadToolError);
    await expect(
      f.call(said.runId, "schedule_task", {
        task: "查天气",
        schedule: { daily_at: "21:00" },
        created_by: "someone",
        matter: "天气",
        title: "查天气",
      }),
    ).rejects.toBeInstanceOf(SubthreadToolError);
    expect(f.query("SELECT COUNT(*) AS n FROM subthread_timers")).toEqual([{ n: 0 }]);
    expect(f.query("SELECT COUNT(*) AS n FROM subthreads")).toEqual([{ n: 0 }]);
  });

  it("opens a hidden subthread whose first run reads the brief and the owner's own words", async () => {
    const f = await fixture();
    const { subthread, runId } = await f.open();
    const main = await f.mainThread.ensure();
    expect(f.query("SELECT origin FROM threads WHERE id = ?", subthread)).toEqual([
      { origin: "think" },
    ]);
    expect(
      f.query<{ parent_thread_id: string; matter: string; status: string }>(
        "SELECT parent_thread_id, matter, status FROM subthreads",
      ),
    ).toEqual([{ parent_thread_id: main, matter: "找牙医", status: "open" }]);
    const again = (await f.call(
      runId,
      "open_subthread",
      {
        ...BRIEF,
        owner_messages: [
          f.query<{ id: string }>("SELECT id FROM thread_messages WHERE role = 'owner'")[0]?.id,
        ],
      },
      "call-1",
    )) as { value: { subthread: string } };
    expect(again.value.subthread).toBe(subthread);
    expect(f.query("SELECT COUNT(*) AS n FROM subthreads")).toEqual([{ n: 1 }]);
    const delivered = await f.deliverOne();
    expect(delivered.threadId).toBe(subthread);
    const message = f.query<{ role: string; internal: number; content_ref: string }>(
      "SELECT role, internal, content_ref FROM thread_messages WHERE run_id = ?",
      delivered.runId,
    )[0];
    expect(message).toMatchObject({ role: "system", internal: 0 });
    const brief = (await f.text(message?.content_ref ?? "")) ?? "";
    expect(brief).toContain("你现在在一个子线程里");
    expect(brief).toContain("比较三家东京的牙科诊所");
    expect(brief).toContain("- 帮我比较三家东京的牙科诊所");
    expect(
      f.query(
        "SELECT source_type FROM triggers WHERE id = (SELECT trigger_id FROM runs WHERE id = ?)",
        delivered.runId,
      ),
    ).toEqual([{ source_type: "schedule" }]);
    await f.finish(subthread, delivered.runId);
    expect(await delivered.handled).toMatchObject({ status: "done", result: "handled" });
    expect(f.query("SELECT outcome FROM inbox_events WHERE thread_id = ?", subthread)).toEqual([
      { outcome: "delivered" },
    ]);
    const visible = await f.threads.list({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      statuses: ["active"],
      pinnedOnly: false,
      afterThreadId: null,
      limit: 20,
    });
    expect(visible.map((thread) => thread.id)).not.toContain(subthread);
  });

  it("REVERSE: refuses a brief that names a message the owner did not write, and opens nothing", async () => {
    const f = await fixture();
    const said = await f.ownerSays("one", "帮我查牙医");
    await expect(
      f.call(said.runId, "open_subthread", { ...BRIEF, owner_messages: ["message:not-owner"] }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      f.call(said.runId, "open_subthread", {
        ...BRIEF,
        owner_messages: [said.messageId],
        extra: 1,
      }),
    ).rejects.toBeInstanceOf(SubthreadToolError);
    expect(f.query("SELECT COUNT(*) AS n FROM subthreads")).toEqual([{ n: 0 }]);
    expect(f.query("SELECT COUNT(*) AS n FROM inbox_events")).toEqual([{ n: 0 }]);
  });

  it("keeps a plan, refuses to hand back while a to-do is open, then wakes the main conversation with the result", async () => {
    const f = await fixture();
    const { subthread, runId: ownerRun } = await f.open();
    await f.finish(await f.mainThread.ensure(), ownerRun);
    const first = await f.deliverOne();
    const run = first.runId;
    const created = (await f.call(run, "task_create", {
      subject: "查三家诊所的评价",
      description: "每家找到至少一个评分",
      active_form: "正在查评价",
    })) as { value: { task: number } };
    expect(created.value.task).toBe(1);
    await f.call(run, "task_create", {
      subject: "算离公司多远",
      description: "每家写出步行或电车时间",
      active_form: "正在算距离",
      blocked_by: [1],
    });
    await expect(
      f.call(run, "task_update", { task: 1, add_blocked_by: [2] }),
    ).rejects.toMatchObject({ code: "TASK_CYCLE" });
    await f.call(run, "task_update", { task: 1, status: "in_progress" });
    const listed = (await f.call(run, "task_list", {})) as {
      value: { tasks: { task: number; status: string; blocked_by: number[] }[] };
    };
    expect(listed.value.tasks).toEqual([
      { task: 1, subject: "查三家诊所的评价", status: "in_progress", blocked_by: [] },
      { task: 2, subject: "算离公司多远", status: "pending", blocked_by: [1] },
    ]);
    await expect(
      f.call(run, "return_result", { conclusion: "还没查完", criteria: ["评价：还没查完"] }),
    ).rejects.toMatchObject({ code: "TASKS_OPEN" });
    await f.call(run, "task_update", { task: 1, status: "completed" });
    await f.call(run, "task_update", { task: 2, status: "deleted" });
    const got = (await f.call(run, "task_get", { task: 2 })) as { value: { status: string } };
    expect(got.value.status).toBe("deleted");
    expect(
      ((await f.call(run, "task_list", {})) as { value: { tasks: unknown[] } }).value.tasks,
    ).toHaveLength(1);
    await expect(
      f.call(run, "open_subthread", { ...BRIEF, owner_messages: ["x"] }),
    ).rejects.toMatchObject({
      code: "NOT_HERE",
    });
    await f.call(run, "return_result", {
      conclusion: "A 诊所评价最好，步行 5 分钟",
      criteria: ["评价：三家都查了", "距离：A 最近"],
      outputs: ["https://example.com/a"],
    });
    await f.finish(subthread, run);
    await first.handled;
    expect(f.query("SELECT status FROM subthreads")).toEqual([{ status: "returned" }]);
    expect(
      f.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM thread_task_changes WHERE thread_id = ?",
        subthread,
      ),
    ).toEqual([{ n: 5 }]);
    const toMain = await f.deliverOne();
    const main = await f.mainThread.ensure();
    expect(toMain.threadId).toBe(main);
    const message = f.query<{ role: string; internal: number; content_ref: string }>(
      "SELECT role, internal, content_ref FROM thread_messages WHERE run_id = ?",
      toMain.runId,
    )[0];
    expect(message).toMatchObject({ role: "system", internal: 1 });
    const event = (await f.text(message?.content_ref ?? "")) ?? "";
    expect(event).toContain(`子线程 ${subthread}（找牙医）result`);
    expect(event).toContain("A 诊所评价最好");
    expect(await f.externalContent.readThread(main)).toEqual([]);
    const viewed = (await f.call(toMain.runId, "view_subthread", {
      subthread,
      history: true,
    })) as { value: { status: string; result: string; tasks: unknown[]; history: unknown[] } };
    expect(viewed.value.status).toBe("returned");
    expect(viewed.value.result).toContain("A 诊所评价最好");
    expect(viewed.value.history).toHaveLength(5);
    await f.finish(main, toMain.runId);
    await toMain.handled;
    const finished = await f.repository.webPush().listFinishedRuns({
      ...scope,
      afterCursor: "2000-01-01T00:00:00.000Z|",
      limit: 50,
    });
    expect(finished.map(({ runId }) => runId)).toEqual([ownerRun]);
  });

  it("wakes the main conversation for a question but only notes plain progress", async () => {
    const f = await fixture();
    const { subthread } = await f.open();
    const first = await f.deliverOne();
    const progress = (await f.call(first.runId, "tell_main", {
      kind: "progress",
      text: "查到两家了",
    })) as { value: { woke_main: boolean } };
    expect(progress.value.woke_main).toBe(false);
    expect(f.query("SELECT COUNT(*) AS n FROM inbox_events WHERE thread_id IS NULL")).toEqual([
      { n: 0 },
    ]);
    await f.call(first.runId, "tell_main", { kind: "question", text: "第三家要周日开门的吗" });
    expect(f.query("SELECT source_kind FROM inbox_events WHERE thread_id IS NULL")).toEqual([
      { source_kind: "subthread" },
    ]);
    await f.finish(subthread, first.runId);
    await first.handled;
  });

  it("forwards new words to the subthread and stops it so nothing more is delivered", async () => {
    const f = await fixture();
    const { subthread, runId } = await f.open();
    const first = await f.deliverOne();
    await f.finish(subthread, first.runId);
    await first.handled;
    await f.call(runId, "send_to_subthread", { subthread, text: "只要周六开门的" });
    const second = await f.deliverOne();
    expect(second.threadId).toBe(subthread);
    const note = f.query<{ content_ref: string }>(
      "SELECT content_ref FROM thread_messages WHERE run_id = ?",
      second.runId,
    )[0];
    const words = (await f.text(note?.content_ref ?? "")) ?? "";
    expect(words).toContain("以下是主对话发来的话");
    expect(words).toContain("只要周六开门的");
    await f.finish(subthread, second.runId);
    await second.handled;
    await f.call(runId, "stop_subthread", { subthread, reason: "主人不要了" });
    expect(f.cancelled).toEqual([subthread]);
    expect(f.query("SELECT status FROM subthreads")).toEqual([{ status: "stopped" }]);
    await expect(
      f.call(runId, "send_to_subthread", { subthread, text: "再查一家" }),
    ).rejects.toMatchObject({ code: "SUBTHREAD_CLOSED" });
    await expect(
      f.call(runId, "send_to_subthread", { subthread: "thread:other", text: "x" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SUBTHREAD" });
  });

  it("carries the main conversation's outside-content mark into a subthread it opens", async () => {
    const f = await fixture();
    const said = await f.ownerSays("mail", "看看那封邮件说的诊所");
    const main = await f.mainThread.ensure();
    await f.externalContent.mark(said.runId, "external_event:mail");
    const opened = (await f.call(said.runId, "open_subthread", {
      ...BRIEF,
      owner_messages: [said.messageId],
    })) as { value: { subthread: string } };
    expect(
      (await f.externalContent.readThread(opened.value.subthread)).map((s) => s.origin),
    ).toEqual(["external_event:mail"]);
    expect((await f.externalContent.readThread(main)).length).toBe(1);
    expect(f.query("SELECT external_content FROM inbox_events")).toEqual([{ external_content: 1 }]);
    expect(await f.subthreads.kindOfThread(main)).toBe("main");
    expect(await f.subthreads.kindOfThread(opened.value.subthread)).toBe("subthread");
  });

  it("shares a result through the board: the waiter wakes, reads it, and readers hear about a new version", async () => {
    const f = await fixture();
    const main = await f.mainThread.ensure();
    const flight = await f.open("flight", "帮我订 12 月 3 日去大阪的机票", "大阪出差");
    const dinner = await f.open("dinner", "再帮我订个餐馆", "大阪出差");
    await f.finish(main, flight.runId);
    await f.finish(main, dinner.runId);
    const flightRun = await f.started(flight.subthread);
    await f.settle(flightRun);
    const dinnerRun = await f.started(dinner.subthread);
    expect(
      (await f.call(dinnerRun.runId, "view_results", {})) as { value: { results: unknown[] } },
    ).toMatchObject({ value: { matter: "大阪出差", results: [] } });
    expect(
      await f.call(dinnerRun.runId, "wait_result", {
        subthread: flight.subthread,
        name: "落地时间",
      }),
    ).toEqual({ value: { waiting: true } });
    expect(f.query("SELECT COUNT(*) AS n FROM result_board_waits")).toEqual([{ n: 1 }]);
    await f.settle(dinnerRun);
    expect(
      await f.call(flightRun.runId, "record_result", {
        name: "落地时间",
        summary: "12 月 3 日 9:05 到关西机场",
        body: "NH 99 羽田 7:30 起飞，关西 9:05 落地，确认号 ABC123",
      }),
    ).toEqual({ value: { recorded: true, name: "落地时间", version: 1 } });
    expect(f.query("SELECT COUNT(*) AS n FROM result_board_waits")).toEqual([{ n: 0 }]);
    expect(f.query("SELECT COUNT(*) AS n FROM result_board_notices")).toEqual([{ n: 0 }]);
    const stored = f.query<Record<string, unknown>>("SELECT * FROM result_board_entries");
    expect(JSON.stringify(stored)).not.toContain("关西");
    const woke = await f.started(dinner.subthread);
    const wakeText = await f.lastMessage(woke.runId);
    expect(wakeText).toContain("你在等的结果到了");
    expect(wakeText).toContain("落地时间");
    expect(wakeText).not.toContain("关西");
    expect(wakeText).not.toContain("以下是主对话发来的话");
    const read = (await f.call(woke.runId, "view_results", {
      subthread: flight.subthread,
      name: "落地时间",
    })) as { value: { body: string; version: number } };
    expect(read.value).toMatchObject({ version: 1, body: expect.stringContaining("ABC123") });
    await f.settle(woke);
    await expect(f.call(flight.runId, "view_results", {})).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
    const catalog = (await f.call(flight.runId, "view_results", { matter: "大阪出差" })) as {
      value: { results: { subthread: string; name: string; summary: string; version: number }[] };
    };
    expect(catalog.value.results).toEqual([
      {
        subthread: flight.subthread,
        name: "落地时间",
        summary: "12 月 3 日 9:05 到关西机场",
        version: 1,
        recorded_at: "2026-11-25T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("ABC123");
    await f.call(flight.runId, "view_results", {
      matter: "大阪出差",
      subthread: flight.subthread,
      name: "落地时间",
    });
    await f.call(flightRun.runId, "record_result", {
      name: "落地时间",
      summary: "改签：12 月 3 日 10:20 到关西机场",
      body: "NH 101，关西 10:20 落地",
    });
    const changed = f.query<{ thread_id: string | null; source_kind: string }>(
      "SELECT thread_id, source_kind FROM inbox_events WHERE outcome IS NULL AND source_kind = 'result_board' ORDER BY thread_id",
    );
    expect(changed).toEqual([
      { thread_id: null, source_kind: "result_board" },
      { thread_id: dinner.subthread, source_kind: "result_board" },
    ]);
    const nextForDinner = await f.started(dinner.subthread);
    expect(await f.lastMessage(nextForDinner.runId)).toContain("现在是第 2 版");
    await f.settle(nextForDinner);
  });

  it("REVERSE: refuses waits across matters and in a circle, and tells a waiter when the result can no longer come", async () => {
    const f = await fixture();
    const main = await f.mainThread.ensure();
    const flight = await f.open("flight", "帮我订机票", "大阪出差");
    const dinner = await f.open("dinner", "再订个餐馆", "大阪出差");
    const hotel = await f.open("hotel", "再订个酒店", "大阪出差");
    const other = await f.open("other", "顺便查牙医", "找牙医");
    for (const said of [flight, dinner, hotel, other]) await f.finish(main, said.runId);
    const runs = new Map<string, string>();
    for (const opened of [flight, dinner, hotel, other]) {
      const delivered = await f.started(opened.subthread);
      runs.set(opened.subthread, delivered.runId);
      await f.settle(delivered);
    }
    const run = (thread: string) => runs.get(thread) as string;
    await expect(
      f.call(run(dinner.subthread), "wait_result", { subthread: other.subthread, name: "x" }),
    ).rejects.toMatchObject({ code: "OTHER_MATTER" });
    await expect(
      f.call(run(dinner.subthread), "wait_result", { subthread: dinner.subthread, name: "x" }),
    ).rejects.toMatchObject({ code: "OTHER_MATTER" });
    await expect(
      f.call(run(dinner.subthread), "view_results", { subthread: other.subthread }),
    ).rejects.toMatchObject({ code: "OTHER_MATTER" });
    await f.call(run(dinner.subthread), "wait_result", {
      subthread: flight.subthread,
      name: "落地",
    });
    await f.call(run(flight.subthread), "wait_result", {
      subthread: hotel.subthread,
      name: "地址",
    });
    await expect(
      f.call(run(hotel.subthread), "wait_result", { subthread: dinner.subthread, name: "店名" }),
    ).rejects.toMatchObject({ code: "WAIT_CYCLE" });
    await f.call(run(hotel.subthread), "tell_main", { kind: "stuck", text: "大阪那周全满了" });
    const gone = await f.started(flight.subthread);
    expect(await f.lastMessage(gone.runId)).toContain("那个子线程说做不下去了");
    await f.settle(gone);
    expect(
      await f.call(run(flight.subthread), "wait_result", {
        subthread: hotel.subthread,
        name: "地址",
      }),
    ).toEqual({ value: { unavailable: "那个子线程说做不下去了" } });
    await expect(
      f.call(run(flight.subthread), "return_result", {
        conclusion: "订好了",
        criteria: ["有确认号"],
        results: ["没记过的名字"],
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RESULT" });
    await f.call(run(flight.subthread), "return_result", {
      conclusion: "订好了",
      criteria: ["有确认号"],
    });
    const returned = await f.started(dinner.subthread);
    expect(await f.lastMessage(returned.runId)).toContain("已经交回结果，没有记这一条");
    await f.settle(returned);
    expect(f.query("SELECT COUNT(*) AS n FROM result_board_waits")).toEqual([{ n: 0 }]);
    expect(
      await f.call(run(dinner.subthread), "wait_result", {
        subthread: hotel.subthread,
        name: "地址",
      }),
    ).toEqual({ value: { unavailable: "那个子线程说做不下去了" } });
    await f.call(flight.runId, "send_to_subthread", {
      subthread: hotel.subthread,
      text: "换个区找",
    });
    expect(
      await f.call(run(dinner.subthread), "wait_result", {
        subthread: hotel.subthread,
        name: "地址",
      }),
    ).toEqual({ value: { waiting: true } });
    expect(
      await f.call(run(dinner.subthread), "wait_result", {
        subthread: flight.subthread,
        name: "落地",
      }),
    ).toEqual({ value: { unavailable: "那个子线程已经交回结果，没有记这一条" } });
    await f.call(flight.runId, "stop_subthread", {
      subthread: hotel.subthread,
      reason: "不住了",
    });
    const stopped = await f.started(dinner.subthread);
    expect(await f.lastMessage(stopped.runId)).toContain("那个子线程被叫停了");
    await f.settle(stopped);
    await expect(
      f.call(run(flight.subthread), "record_result", { name: "迟到", summary: "x", body: "x" }),
    ).rejects.toMatchObject({ code: "SUBTHREAD_CLOSED" });
  });

  it("REVERSE: folds odd characters out of names, caps versions, and never stores result text in the clear", async () => {
    const f = await fixture();
    const main = await f.mainThread.ensure();
    const flight = await f.open("flight", "帮我订机票", "大阪出差");
    await f.finish(main, flight.runId);
    const delivered = await f.started(flight.subthread);
    await f.settle(delivered);
    const odd = "落地\n时间\u202E\u0007 ";
    const first = (await f.call(delivered.runId, "record_result", {
      name: odd,
      summary: "第一行\n第二行",
      body: "正文",
    })) as { value: { name: string } };
    expect(first.value.name).toBe("落地 时间");
    const catalog = (await f.call(delivered.runId, "view_results", {})) as {
      value: { results: { name: string; summary: string }[] };
    };
    expect(catalog.value.results).toMatchObject([{ name: "落地 时间", summary: "第一行 第二行" }]);
    const read = (await f.call(delivered.runId, "view_results", {
      subthread: flight.subthread,
      name: odd,
    })) as { value: { body: string } };
    expect(read.value.body).toBe("正文");
    for (let version = 2; version <= 20; version += 1)
      await f.call(delivered.runId, "record_result", {
        name: "落地 时间",
        summary: `第 ${version} 版`,
        body: "正文",
      });
    await expect(
      f.call(delivered.runId, "record_result", { name: "落地 时间", summary: "多一版", body: "x" }),
    ).rejects.toMatchObject({ code: "RESULT_LIMIT" });
    expect(f.query("SELECT COUNT(*) AS n FROM result_board_entries")).toEqual([{ n: 20 }]);
    const refs = f.query<{ summary_ref: string; body_ref: string }>(
      "SELECT summary_ref, body_ref FROM result_board_entries",
    );
    expect(JSON.stringify(f.query("SELECT * FROM result_board_entries"))).not.toContain("正文");
    expect(await f.text(refs[0]?.body_ref ?? "")).toBe("正文");
  });

  it("carries the writer's outside-content mark to whoever reads its result, and not otherwise", async () => {
    const f = await fixture();
    const main = await f.mainThread.ensure();
    const mail = await f.open("mail", "看邮件里说的航班", "大阪出差");
    const plain = await f.open("plain", "查天气", "大阪出差");
    const reader = await f.open("reader", "订餐馆", "大阪出差");
    for (const said of [mail, plain, reader]) await f.finish(main, said.runId);
    const runs = new Map<string, string>();
    for (const opened of [mail, plain, reader]) {
      const delivered = await f.started(opened.subthread);
      runs.set(opened.subthread, delivered.runId);
      await f.settle(delivered);
    }
    const run = (thread: string) => runs.get(thread) as string;
    await f.externalContent.markThread(
      mail.subthread,
      createRunId(run(mail.subthread)),
      "external_event:mail",
    );
    await f.call(run(reader.subthread), "wait_result", {
      subthread: plain.subthread,
      name: "天气",
    });
    await f.call(run(plain.subthread), "record_result", {
      name: "天气",
      summary: "晴",
      body: "晴，最高 15 度",
    });
    expect(
      f.query<{ external_content: number }>(
        "SELECT external_content FROM inbox_events WHERE source_kind = 'result_board'",
      ),
    ).toEqual([{ external_content: 0 }]);
    const woke = await f.started(reader.subthread);
    await f.settle(woke);
    expect(await f.externalContent.readThread(reader.subthread)).toEqual([]);
    await f.call(run(mail.subthread), "record_result", {
      name: "航班",
      summary: "邮件说改乘 NH 101",
      body: "邮件正文摘录",
    });
    expect(
      (
        (await f.call(run(reader.subthread), "view_results", { subthread: plain.subthread })) as {
          value: { results: unknown[] };
        }
      ).value.results,
    ).toHaveLength(1);
    expect(await f.externalContent.readThread(reader.subthread)).toEqual([]);
    await f.call(run(reader.subthread), "view_results", {});
    expect(
      (await f.externalContent.readThread(reader.subthread)).map(({ origin }) => origin),
    ).toEqual(["external_event:mail"]);
  });

  it("shows the main conversation a status board of unfinished subthreads and the owner a background-work view", async () => {
    const f = await fixture();
    const main = await f.mainThread.ensure();
    expect(await f.subthreads.statusBoard(main, "private")).toBeUndefined();
    const dinner = await f.open("dinner", "订个餐馆", "大阪出差");
    const dentist = await f.open("dentist", "顺便找牙医", "找牙医");
    const flight = await f.open("flight", "再帮我订机票", "大阪出差");
    for (const said of [dinner, dentist, flight]) await f.finish(main, said.runId);
    const runs = new Map<string, string>();
    for (const opened of [dinner, dentist, flight]) {
      const delivered = await f.started(opened.subthread);
      runs.set(opened.subthread, delivered.runId);
      if (opened !== flight) await f.settle(delivered);
      else {
        await f.call(delivered.runId, "task_create", {
          subject: "查 12 月 3 日的航班",
          description: "列出上午到关西的直飞",
          active_form: "正在查航班",
        });
        await f.call(delivered.runId, "task_update", { task: 1, status: "in_progress" });
        await f.call(delivered.runId, "task_create", {
          subject: "订票",
          description: "按主人选的订",
          active_form: "正在订票",
        });
        await f.call(delivered.runId, "tell_main", {
          kind: "progress",
          text: "查到三个选项，正在比价",
        });
        const board = (await f.subthreads.statusBoard(main, "private")) ?? "";
        const lines = board.split("\n").slice(1);
        const flightLine = `- subthread ${flight.subthread} (大阪出差) status=queued`;
        expect(lines).toHaveLength(6);
        expect(lines.slice(lines.indexOf(flightLine), lines.indexOf(flightLine) + 4)).toEqual([
          flightLine,
          "  progress: 查到三个选项，正在比价",
          "  task 1 [in_progress] 正在查航班",
          "  task 2 [pending] 订票",
        ]);
        expect(lines).toContain(`- subthread ${dinner.subthread} (大阪出差) status=idle`);
        expect(lines).toContain(`- subthread ${dentist.subthread} (找牙医) status=idle`);
        expect(board).toContain("【后台在办】");
        await f.settle(delivered);
      }
    }
    const run = (thread: string) => runs.get(thread) as string;
    await f.call(run(dinner.subthread), "wait_result", {
      subthread: flight.subthread,
      name: "落地",
    });
    await f.call(run(dentist.subthread), "tell_main", { kind: "question", text: "要周日开门的吗" });
    const board = (await f.subthreads.statusBoard(main, "private")) ?? "";
    expect(board).toContain(`${flight.subthread} (大阪出差) status=queued`);
    expect(board).toContain(`${dinner.subthread} (大阪出差) status=waiting_result`);
    expect(board).toContain(`${dentist.subthread} (找牙医) status=waiting_answer`);
    expect(await f.subthreads.statusBoard(main, "private")).toBe(board);
    expect(await f.subthreads.statusBoard(flight.subthread, "private")).toBeUndefined();
    await f.call(flight.runId, "send_to_subthread", { subthread: dentist.subthread, text: "要" });
    expect(await f.subthreads.statusBoard(main, "private")).toContain(
      `${dentist.subthread} (找牙医) status=queued`,
    );
    await f.call(flight.runId, "stop_subthread", {
      subthread: dentist.subthread,
      reason: "不要了",
    });
    expect(await f.subthreads.statusBoard(main, "private")).not.toContain(dentist.subthread);
    const work = await f.subthreads.backgroundWork();
    expect(work.matters.map(({ matter }) => matter)).toEqual(["大阪出差", "找牙医"]);
    expect(
      work.matters[0]?.subthreads.find(({ subthreadId }) => subthreadId === flight.subthread),
    ).toMatchObject({
      subthreadId: flight.subthread,
      status: "open",
      activity: "queued",
      progress: "查到三个选项，正在比价",
      runCount: 1,
      spentMicros: 0,
      budgetMicros: 500_000,
      title: "比牙医",
      runs: [{ runId: run(flight.subthread), status: "completed" }],
      tasks: [
        {
          number: 1,
          status: "in_progress",
          subject: "查 12 月 3 日的航班",
          activeForm: "正在查航班",
        },
        { number: 2, status: "pending", subject: "订票", activeForm: "正在订票" },
      ],
    });
    const flightRow = work.matters[0]?.subthreads.find(
      ({ subthreadId }) => subthreadId === flight.subthread,
    );
    expect(flightRow?.exchanges.map(({ direction, kind }) => [direction, kind])).toEqual([
      ["to_subthread", "brief"],
      ["to_main", "progress"],
    ]);
    expect(flightRow?.exchanges[1]?.text).toBe("查到三个选项，正在比价");
    const dentistRow = work.matters[1]?.subthreads[0];
    expect(dentistRow?.exchanges.map(({ direction, kind }) => [direction, kind])).toEqual([
      ["to_subthread", "brief"],
      ["to_main", "question"],
      ["to_subthread", "message"],
    ]);
    expect(dentistRow?.exchanges[1]?.text).toContain("要周日开门的吗");
    expect(dentistRow?.exchanges[2]?.text).toBe("要");
    expect(work.matters[1]?.subthreads[0]).toMatchObject({
      subthreadId: dentist.subthread,
      status: "stopped",
      activity: "finished",
    });
  });

  it("REVERSE: leaves out of the status board what the run may not show its model", async () => {
    const f = await fixture();
    const main = await f.mainThread.ensure();
    const flight = await f.open("flight", "帮我订机票", "大阪出差");
    await f.finish(main, flight.runId);
    const delivered = await f.started(flight.subthread);
    await f.call(delivered.runId, "task_create", {
      subject: "护照号 TK1234567 填进订票单",
      description: "按护照填",
      active_form: "正在填护照",
    });
    await f.call(delivered.runId, "tell_main", {
      kind: "progress",
      text: "公开信息：查到三个航班",
    });
    const tasks = f.query<{ classification: string }>("SELECT classification FROM thread_tasks");
    const board = (await f.subthreads.statusBoard(main, "public")) ?? "";
    if (tasks[0]?.classification !== "public") expect(board).not.toContain("TK1234567");
    expect(board).toContain("task 1 [pending]");
    await f.settle(delivered);
  });
  it("[ADR-0285] has a subthread carry on by itself when a run ends with its plan unfinished, once per run, and stop when the plan is done", async () => {
    const f = await fixture();
    const opened = await f.open();
    await f.finish(await f.mainThread.ensure(), opened.runId);
    const first = await f.started(opened.subthread);
    await f.call(first.runId, "task_create", {
      subject: "查评价",
      description: "看三家的评分",
      active_form: "正在查评价",
    });
    await f.settle(first);
    const continues = () =>
      f.query<{ source_version: string; thread_id: string; status: string }>(
        "SELECT source_version, thread_id, status FROM inbox_events WHERE source_kind = 'subthread_continue' ORDER BY created_at, source_version",
      );
    expect(continues()).toEqual([
      { source_version: first.runId, thread_id: opened.subthread, status: "queued" },
    ]);
    expect(
      await f.subthreads.afterRun({
        threadId: opened.subthread,
        runId: first.runId,
        cutOff: false,
      }),
    ).toBe("continued");
    expect(continues()).toHaveLength(1);
    const second = await f.started(opened.subthread);
    const message = await f.lastMessage(second.runId);
    expect(message).toContain("接着做。上一次运行结束时，计划里还有没做完的待办。");
    expect(message).not.toContain("以下是主对话发来的话");
    await f.call(second.runId, "task_update", { task: 1, status: "completed" });
    await f.settle(second);
    expect(continues().map(({ status }) => status)).toEqual(["done"]);
    expect(await f.worker.claim()).toBeUndefined();
  });

  it("REVERSE: does not carry a subthread on while it waits for an answer, a sibling's result or after it said it is stuck", async () => {
    const f = await fixture();
    const asking = await f.open("asking", "帮我订餐馆", "大阪出差");
    const sibling = await f.open("sibling", "再订机票", "大阪出差");
    const main = await f.mainThread.ensure();
    for (const said of [asking, sibling]) await f.finish(main, said.runId);
    const runs = new Map<string, string>();
    for (const opened of [asking, sibling]) {
      const delivered = await f.started(opened.subthread);
      runs.set(opened.subthread, delivered.runId);
      await f.call(delivered.runId, "task_create", {
        subject: "等",
        description: "等",
        active_form: "在等",
      });
      if (opened === asking)
        await f.call(delivered.runId, "tell_main", { kind: "question", text: "几个人？" });
      else
        await f.call(delivered.runId, "wait_result", { subthread: asking.subthread, name: "餐馆" });
      await f.settle(delivered);
    }
    expect(
      f.query("SELECT COUNT(*) AS n FROM inbox_events WHERE source_kind = 'subthread_continue'"),
    ).toEqual([{ n: 0 }]);
    await f.call(runs.get(asking.subthread) as string, "tell_main", {
      kind: "stuck",
      text: "订不到",
    });
    expect(
      await f.subthreads.afterRun({
        threadId: asking.subthread,
        runId: runs.get(asking.subthread) as string,
        cutOff: true,
      }),
    ).toBe("settled");
  });

  it("[ADR-0285] carries on a subthread cut off at the run time limit even without a plan, and retries a run that failed for another reason", async () => {
    const f = await fixture();
    const opened = await f.open();
    await f.finish(await f.mainThread.ensure(), opened.runId);
    const fail = (runId: string, diagnosticCode: string) => {
      const handle = openQualifiedDatabase(f.file);
      try {
        handle
          .prepare(
            `INSERT INTO run_coordination_checkpoints (run_id, owner_id, agent_id, revision, phase,
              runtime_event_count, terminal_status, diagnostic_code, updated_at)
             VALUES (?, ?, ?, 1, 'failed', 0, 'failed', ?, ?)`,
          )
          .run(runId, OWNER_ID, AGENT_ID, diagnosticCode, START);
        handle.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
      } finally {
        handle.close();
      }
    };
    const first = await f.started(opened.subthread);
    fail(first.runId, "RUNTIME_MODEL_UNAVAILABLE");
    expect(await first.handled).toMatchObject({ status: "done", result: "retry" });
    expect(
      f.query("SELECT COUNT(*) AS n FROM inbox_events WHERE source_kind = 'subthread_continue'"),
    ).toEqual([{ n: 0 }]);
    const retried = await f.started(opened.subthread);
    fail(retried.runId, "RUN_EXECUTION_DEADLINE_EXCEEDED");
    expect(await retried.handled).toMatchObject({ status: "done", result: "handled" });
    expect(
      f.query<{ outcome: string; reason_code: string }>(
        "SELECT outcome, reason_code FROM inbox_events WHERE run_id = ?",
        retried.runId,
      ),
    ).toEqual([{ outcome: "continued", reason_code: "subthread_cut_off" }]);
    const resumed = await f.started(opened.subthread);
    expect(await f.lastMessage(resumed.runId)).toContain(
      "接着做。上一次运行到了时限被截停，最后一步可能没做完。",
    );
    await f.settle(resumed);
    expect(await f.worker.claim()).toBeUndefined();
  });

  it("[ADR-0285] stops a subthread at its budget, tells the main conversation once, and lets it carry on only when the main conversation raises the budget", async () => {
    const f = await fixture();
    const said = await f.ownerSays("budget", "帮我比较三家东京的牙科诊所");
    const main = await f.mainThread.ensure();
    const opened = (await f.call(said.runId, "open_subthread", {
      ...BRIEF,
      owner_messages: [said.messageId],
      budget: 0.01,
    })) as { value: { subthread: string } };
    const subthread = opened.value.subthread;
    await f.finish(main, said.runId);
    const first = await f.started(subthread);
    await f.call(first.runId, "task_create", {
      subject: "查评价",
      description: "看三家的评分",
      active_form: "正在查评价",
    });
    const spend = (runId: string, micros: number) => {
      const handle = openQualifiedDatabase(f.file);
      try {
        handle
          .prepare(
            `INSERT INTO model_budget_accounts (owner_id, agent_id, account_id, parent_kind, run_id,
              data_classification, reserved_cost_micros, spent_cost_micros, status, revision)
             VALUES (?, ?, ?, 'run', ?, 'private', 0, ?, 'active', 0)`,
          )
          .run(OWNER_ID, AGENT_ID, `run:${runId}`, runId, micros);
      } finally {
        handle.close();
      }
    };
    spend(first.runId, 12_000);
    await f.settle(first);
    const budgetEvents = () =>
      f.query<{ summary_ref: string }>(
        "SELECT summary_ref FROM inbox_events WHERE source_kind = 'subthread' AND source_ref LIKE 'budget:%'",
      );
    expect(budgetEvents()).toHaveLength(1);
    expect(
      f.query("SELECT COUNT(*) AS n FROM inbox_events WHERE source_kind = 'subthread_continue'"),
    ).toEqual([{ n: 0 }]);
    const told = (await f.text(budgetEvents()[0]?.summary_ref ?? "")) ?? "";
    expect(told).toContain(`子线程 ${subthread}（找牙医）budget：`);
    expect(told).toContain("已经花了 0.01 美元，预算 0.01 美元；计划里 1 条待办做完了 0 条");
    expect(await f.subthreads.overBudget(subthread)).toBe(true);
    expect(budgetEvents()).toHaveLength(1);
    const board = (await f.subthreads.statusBoard(main, "private")) ?? "";
    expect(board).toContain(`${subthread} (找牙医) status=over_budget spent=0.01/0.01 USD`);
    const work = await f.subthreads.backgroundWork();
    expect(work.matters[0]?.subthreads[0]).toMatchObject({
      activity: "over_budget",
      spentMicros: 12_000,
      budgetMicros: 10_000,
    });
    await expect(
      f.call(said.runId, "send_to_subthread", { subthread, text: "接着查" }),
    ).rejects.toMatchObject({ code: "OVER_BUDGET" });
    await expect(
      f.call(said.runId, "send_to_subthread", { subthread, text: "接着查", budget: 0.012 }),
    ).rejects.toMatchObject({ code: "BUDGET_TOO_LOW" });
    await f.call(said.runId, "send_to_subthread", { subthread, text: "接着查", budget: 0.05 });
    expect(await f.subthreads.statusBoard(main, "private")).toContain(
      `${subthread} (找牙医) status=queued`,
    );
    const second = await f.started(subthread);
    expect(await f.lastMessage(second.runId)).toContain("接着查");
    await f.call(second.runId, "task_update", { task: 1, status: "completed" });
    await f.settle(second);
    expect(budgetEvents()).toHaveLength(1);
  });

  it("REVERSE: does not start a run for a subthread already over its budget", async () => {
    const f = await fixture();
    const opened = await f.open();
    await f.finish(await f.mainThread.ensure(), opened.runId);
    const first = await f.started(opened.subthread);
    await f.call(first.runId, "task_create", {
      subject: "查评价",
      description: "看三家的评分",
      active_form: "正在查评价",
    });
    await f.settle(first);
    const handle = openQualifiedDatabase(f.file);
    try {
      handle
        .prepare(
          `INSERT INTO model_budget_accounts (owner_id, agent_id, account_id, parent_kind, run_id,
            data_classification, reserved_cost_micros, spent_cost_micros, status, revision)
           VALUES (?, ?, ?, 'run', ?, 'private', 100000, 400000, 'active', 0)`,
        )
        .run(OWNER_ID, AGENT_ID, `run:${first.runId}`, first.runId);
    } finally {
      handle.close();
    }
    const claim = await f.worker.claim();
    expect(claim?.threadId).toBe(opened.subthread);
    expect(await f.worker.handle(claim as never)).toMatchObject({ result: "handled" });
    expect(
      f.query<{ outcome: string }>(
        "SELECT outcome FROM inbox_events WHERE source_kind = 'subthread_continue'",
      ),
    ).toEqual([{ outcome: "over_budget" }]);
    expect(f.query("SELECT COUNT(*) AS n FROM runs WHERE thread_id = ?", opened.subthread)).toEqual(
      [{ n: 1 }],
    );
    expect(
      f.query("SELECT COUNT(*) AS n FROM inbox_events WHERE source_ref LIKE 'budget:%'"),
    ).toEqual([{ n: 1 }]);
  });

  it("[ADR-0285] parks a subthread run that waits for the owner's approval, tells the main conversation, and carries on once the approved run ends", async () => {
    const f = await fixture();
    const opened = await f.open();
    await f.finish(await f.mainThread.ensure(), opened.runId);
    const first = await f.started(opened.subthread);
    await f.call(first.runId, "task_create", {
      subject: "订票",
      description: "订最便宜的一班",
      active_form: "正在订票",
    });
    const setStatus = (status: string) => {
      const handle = openQualifiedDatabase(f.file);
      try {
        handle.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, first.runId);
      } finally {
        handle.close();
      }
    };
    setStatus("awaiting_approval");
    expect(await first.handled).toMatchObject({ status: "done", result: "handled" });
    expect(
      f.query<{ outcome: string; reason_code: string }>(
        "SELECT outcome, reason_code FROM inbox_events WHERE run_id = ?",
        first.runId,
      ),
    ).toEqual([{ outcome: "awaiting_approval", reason_code: "subthread_awaiting_approval" }]);
    expect(f.query("SELECT approval_run_id FROM subthreads")).toEqual([
      { approval_run_id: first.runId },
    ]);
    const told = f.query<{ thread_id: string | null }>(
      "SELECT thread_id FROM inbox_events WHERE source_ref LIKE 'approval:%'",
    );
    expect(told).toEqual([{ thread_id: null }]);
    const work = await f.subthreads.backgroundWork();
    expect(work.matters[0]?.subthreads[0]?.activity).toBe("running");
    const continues = () =>
      f.query("SELECT COUNT(*) AS n FROM inbox_events WHERE source_kind = 'subthread_continue'");
    await f.worker.claim();
    expect(continues()).toEqual([{ n: 0 }]);
    setStatus("accepted");
    await f.finish(opened.subthread, first.runId);
    await f.worker.claim();
    expect(f.query("SELECT approval_run_id FROM subthreads")).toEqual([{ approval_run_id: null }]);
    expect(continues()).toEqual([{ n: 1 }]);
  });

  it("[ADR-0285] turns the owner's answer to an approval card into one inbox row, then carries the subthread on", async () => {
    const f = await fixture();
    const opened = await f.open();
    await f.finish(await f.mainThread.ensure(), opened.runId);
    const first = await f.started(opened.subthread);
    await f.call(first.runId, "task_create", {
      subject: "订票",
      description: "订最便宜的一班",
      active_form: "正在订票",
    });
    const setStatus = (status: string) => {
      const handle = openQualifiedDatabase(f.file);
      try {
        handle.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, first.runId);
      } finally {
        handle.close();
      }
    };
    setStatus("awaiting_approval");
    await first.handled;
    const answers = new ProductionApprovalAnswers({
      threadOf: async (runId) =>
        f.query<{ thread_id: string }>("SELECT thread_id FROM runs WHERE id = ?", runId)[0]
          ?.thread_id,
      mainThread: f.mainThread,
    });
    answers.registerSource(f.inbox.sources);
    answers.attach(f.inbox);
    const approval = {
      id: "approval-ticket",
      runId: first.runId,
      status: "approved",
    } as never;
    await answers.answered(approval);
    await answers.answered(approval);
    await answers.answered({
      id: "approval-ticket",
      runId: first.runId,
      status: "pending",
    } as never);
    const rows = () =>
      f.query<{ thread_id: string; status: string; from_owner: number; priority: number }>(
        "SELECT thread_id, status, from_owner, priority FROM inbox_events WHERE source_kind = 'approval_answer'",
      );
    expect(rows()).toEqual([
      { thread_id: opened.subthread, status: "queued", from_owner: 1, priority: 1 },
    ]);
    const claim = await f.worker.claim();
    expect(claim?.fromOwner).toBe(true);
    const handled = f.worker.handle(claim as never);
    setStatus("running");
    await new Promise((resolve) => setTimeout(resolve, 40));
    setStatus("accepted");
    await f.finish(opened.subthread, first.runId);
    expect(await handled).toMatchObject({ status: "done", result: "handled" });
    expect(
      f.query(
        "SELECT outcome, reason_code FROM inbox_events WHERE source_kind = 'approval_answer'",
      ),
    ).toEqual([{ outcome: "resumed", reason_code: "approval_answered" }]);
    expect(f.query("SELECT approval_run_id FROM subthreads")).toEqual([{ approval_run_id: null }]);
    expect(
      f.query("SELECT COUNT(*) AS n FROM inbox_events WHERE source_kind = 'subthread_continue'"),
    ).toEqual([{ n: 1 }]);
    await answers.answered(approval);
    expect(rows()).toHaveLength(1);
  });

  it("REVERSE: does not carry a subthread on after its approval run was cancelled", async () => {
    const f = await fixture();
    const opened = await f.open();
    await f.finish(await f.mainThread.ensure(), opened.runId);
    const first = await f.started(opened.subthread);
    await f.call(first.runId, "task_create", {
      subject: "订票",
      description: "订最便宜的一班",
      active_form: "正在订票",
    });
    const handle = openQualifiedDatabase(f.file);
    try {
      handle.prepare("UPDATE runs SET status = 'awaiting_approval' WHERE id = ?").run(first.runId);
    } finally {
      handle.close();
    }
    expect(await first.handled).toMatchObject({ status: "done", result: "handled" });
    const again = openQualifiedDatabase(f.file);
    try {
      again.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(first.runId);
    } finally {
      again.close();
    }
    await f.worker.claim();
    expect(f.query("SELECT approval_run_id FROM subthreads")).toEqual([{ approval_run_id: null }]);
    expect(
      f.query("SELECT COUNT(*) AS n FROM inbox_events WHERE source_kind = 'subthread_continue'"),
    ).toEqual([{ n: 0 }]);
  });
});
