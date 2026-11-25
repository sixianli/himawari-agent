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
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.ts";
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
    const now = () => START;
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
    const open = async (key = "dentist", words = "帮我比较三家东京的牙科诊所") => {
      const said = await ownerSays(key, words);
      const opened = (await call(said.runId, "open_subthread", {
        ...BRIEF,
        owner_messages: [said.messageId],
      })) as { value: { subthread: string } };
      return { ...said, subthread: opened.value.subthread };
    };
    return {
      repository,
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
      cancelled,
    };
  }

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
});
