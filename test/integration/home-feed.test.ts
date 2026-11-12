import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ApprovalRequest,
  createProactiveSeal,
  DEFAULT_HOME_FEED,
  DurableMemoryService,
  type HomeFeedConfiguration,
  type MemoryProviderProjectionPort,
  type ProductMemoryRecord,
  readProactiveOverview,
  type SensitiveMemoryApprovalRequest,
  type WebPushSendRequest,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createIdempotencyKey,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createRunId,
  createThreadId,
} from "@himawari-agent/domain";
import { type GatewayV2Snapshot, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet, DeterministicIdGenerator } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { HOME_TEXT, ProductionHomeControl } from "../../apps/agent-service/src/production-home.ts";
import { protectedMemoryCandidates } from "../../apps/agent-service/src/production-memory-capture.ts";
import { ProductionMemoryControl } from "../../apps/agent-service/src/production-memory-control.ts";
import { ProductionOwnerRuleWriter } from "../../apps/agent-service/src/production-owner-rules.ts";
import {
  ProductionWebPush,
  WebPushPresence,
} from "../../apps/agent-service/src/production-web-push.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-home-feed");
const AGENT_ID = createAgentId("agent-home-feed");
const THREAD_ID = createThreadId("thread-home");
const UNTITLED_THREAD_ID = createThreadId("thread-untitled");
const GENERATION_ID = createMemoryGenerationId("generation-home");
const RUN_ID = createRunId("run-owner");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const START = "2026-11-12T00:00:00.000Z";
const NOW = "2026-11-12T03:00:00.000Z";
const AUTHORITY = {
  deploymentId: createDeploymentId("deployment-home"),
  authorityEpoch: 1,
  fencingToken: 1,
};
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

type HomeSnapshot = Extract<GatewayV2Snapshot, { type: "home.snapshot" }>["payload"];

class NoopProvider implements MemoryProviderProjectionPort {
  async upsert(input: { readonly memory: ProductMemoryRecord }) {
    return input.memory.providerRecordId ?? `provider-${input.memory.id}`;
  }
  async delete() {}
  async search() {
    return [];
  }
  async clearScope() {}
}

describe.each(["worker", "direct"] as const)("home feed through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture(settings: HomeFeedConfiguration = DEFAULT_HOME_FEED) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-home-feed-"));
    directories.push(stateRoot);
    const file = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(file);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    for (const threadId of [THREAD_ID, UNTITLED_THREAD_ID])
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'open', ?, ?)`,
        )
        .run(threadId, OWNER_ID, AGENT_ID, START, START);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-home', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, START);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-home', ?, ?, ?, 'completed', 'model-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();

    let now = NOW;
    const clock = { now: () => now };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: clock.now,
    });
    closers.push(() => repository.close());
    const sql = <T>(run: (handle: ReturnType<typeof openQualifiedDatabase>) => T): T => {
      const handle = openQualifiedDatabase(file);
      try {
        return run(handle);
      } finally {
        handle.close();
      }
    };
    const protector = createReferenceAdapterSet().payloadProtector;
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const put = async (
      ref: string,
      text: string,
      dataClassification: "private" | "sensitive" = "private",
    ) => {
      await payloads.put(
        await protector.protect({
          ...scope,
          ref,
          dataClassification,
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(text),
          createdAt: START,
        }),
      );
      return ref;
    };
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider: new NoopProvider(),
      content: { readText: async () => "fixture" },
      workerId: "home-worker",
      now: clock.now,
      maximumProjectionAttempts: 3,
      projectionLeaseMs: 10_000,
    });
    const threads = repository.threadRepository();
    const ownerRules = new ProductionOwnerRuleWriter({
      configuration: scope,
      rules: repository.ownerRules(),
      memory,
      memories: repository.productMemoryState(),
      book: repository.memoryBook(),
      threads,
      payloads,
      protector,
      clock,
    });
    const control = new ProductionMemoryControl({
      configuration: scope,
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      approvals: repository.sensitiveMemoryApprovals(),
      memory,
      book: repository.memoryBook(),
      ledger: repository.decisionLedger(),
      consolidation: { store: repository.memoryConsolidation(), undo: async () => undefined },
      conversationReviews: {
        store: repository.memoryConversationReviews(),
        undo: async () => undefined,
      },
      reminders: repository.memoryReminders(),
      ownerRules,
      payloads,
      protector,
      clock,
      onAudit: () => undefined,
    });
    const proactiveStore = repository.proactive();
    const seal = createProactiveSeal({
      payloads,
      protector,
      ids: new DeterministicIdGenerator(),
    });
    const failures: unknown[] = [];
    const sourceFailures: string[] = [];
    const titled = async (threadId: string) => {
      const thread = await threads.read(OWNER_ID, AGENT_ID, createThreadId(threadId));
      if (!thread || thread.status !== "active") return null;
      const payload = thread.titleRef ? await payloads.get(thread.titleRef) : undefined;
      return {
        title: payload
          ? new TextDecoder().decode(await protector.unprotect({ ...scope, payload })).trim() ||
            null
          : null,
      };
    };
    const runThread = async (runId: string) =>
      (await repository.runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY).readRun(createRunId(runId)))
        ?.run.threadId ?? null;
    const listApprovals = () =>
      repository.authorizationStore().listApprovals(OWNER_ID, AGENT_ID, { status: "pending" });
    const home = new ProductionHomeControl({
      settings,
      proactive: {
        overview: () =>
          readProactiveOverview({
            scope,
            source: "gmail",
            store: proactiveStore,
            seal,
            timeZone: "Asia/Tokyo",
            dailyCostMicros: 1_000_000,
            now: clock.now(),
            feedback: async () => [],
          }),
      },
      memory: control,
      listApprovals,
      runThread,
      runs: repository.runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY),
      threadTitle: titled,
      clock,
      onSourceFailure: (source) => sourceFailures.push(source),
    });

    const read = async (locale: "zh-CN" | "en" | "ja" = "zh-CN"): Promise<HomeSnapshot> => {
      const snapshot = await home.query(
        gatewayV2MessageSchema.parse({
          schemaVersion: "gateway.v2",
          kind: "query",
          type: "home.read",
          messageId: "message-home",
          correlationId: "correlation-home",
          causationId: null,
          dataClassification: "private",
          risk: "low",
          authorizationRef: null,
          scope,
          authority: AUTHORITY,
          actor: { actorType: "owner", actorId: "owner-subject" },
          payload: { locale },
        }) as never,
      );
      const parsed = gatewayV2MessageSchema.parse(JSON.parse(JSON.stringify(snapshot)));
      if (parsed.type !== "home.snapshot") throw new Error("snapshot");
      expect(sourceFailures).toEqual([]);
      return parsed.payload;
    };

    const seedRun = (
      id: string,
      options: {
        readonly sourceType: "user_message" | "schedule" | "external_event";
        readonly status: string;
        readonly threadId?: string;
        readonly when?: string;
        readonly hold?: "open" | "released";
      },
    ) =>
      sql((handle) => {
        const when = options.when ?? START;
        const threadId = options.threadId ?? THREAD_ID;
        handle
          .prepare(
            `INSERT OR IGNORE INTO payloads (
              ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
              encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
            ) VALUES ('payload-trigger', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:trigger',
              'fixture', 'fixture-key', 'active', ?, 'application/octet-stream')`,
          )
          .run(OWNER_ID, AGENT_ID, START);
        handle
          .prepare(
            `INSERT INTO triggers (
              id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
              payload_ref, source_proof_ref, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'payload-trigger', 'proof', ?)`,
          )
          .run(
            `trigger-${id}`,
            OWNER_ID,
            AGENT_ID,
            threadId,
            `key-${id}`,
            options.sourceType,
            id,
            when,
          );
        handle
          .prepare(
            `INSERT INTO runs (
              id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'session', ?, 2, ?, ?, ?)`,
          )
          .run(id, OWNER_ID, AGENT_ID, threadId, `trigger-${id}`, options.status, when, when);
        if (options.hold)
          handle
            .prepare(
              `INSERT INTO run_background_holds (
                owner_id, agent_id, run_id, task_ref, thread_id, started_at, deadline_at,
                parked_at, released_at, outcome
              ) VALUES (?, ?, ?, 'task-1', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              OWNER_ID,
              AGENT_ID,
              id,
              threadId,
              when,
              at(600),
              when,
              options.hold === "released" ? when : null,
              options.hold === "released" ? "failed" : null,
            );
      });
    seedRun(RUN_ID, { sourceType: "user_message", status: "running" });

    const approval = (id: string, extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
      id,
      revision: 1,
      ...scope,
      runId: RUN_ID,
      intentId: `intent-${id}`,
      intentSnapshot: {
        id: `intent-${id}`,
        ...scope,
        runId: RUN_ID,
        capabilityRef: "capability-home",
        operation: "read",
        resourceRef: "resource-home",
        dataClassification: "private",
        sideEffect: "none",
        estimatedCostMicros: 0,
        frequency: { count: 1, intervalMs: null },
        idempotencyKey: createIdempotencyKey(`intent-${id}`),
        reversible: true,
        requestedAt: at(-30),
      },
      semanticSnapshotHash: `hash-${id}`,
      status: "pending",
      deliveryState: "deliverable",
      requestedAt: at(-30),
      expiresAt: at(3 * 1440),
      decidedAt: null,
      grantId: null,
      ...extra,
    });
    const createApproval = (id: string, extra: Partial<ApprovalRequest> = {}) =>
      repository.authorizationStore().createApproval(approval(id, extra));

    let decisions = 0;
    const recordMail = async (
      mails: readonly {
        readonly id: string;
        readonly summary: string;
        readonly floorRaised?: boolean;
        readonly dueAt?: string | null;
        readonly result?: "act" | "know" | "check";
        readonly priority?: "high" | "medium" | "low" | null;
      }[],
    ) => {
      decisions += 1;
      const insights = [];
      for (const mail of mails)
        insights.push({
          id: `insight-${mail.id}`,
          threadId: `gmail-thread-${mail.id}`,
          lastMessageId: `gmail-message-${mail.id}`,
          result: mail.result ?? ("act" as const),
          floorRaised: mail.floorRaised ?? false,
          contentRef: await seal.seal({
            ...scope,
            text: JSON.stringify({
              summary: mail.summary,
              reason: "原因",
              basis: "model",
              from: "田中 <tanaka@example.com>",
              subject: `主题 ${mail.id}`,
              link: `https://mail.google.com/mail/u/0/#inbox/${mail.id}`,
            }),
            at: clock.now(),
          }),
          dueAt: mail.dueAt ?? null,
          priority: mail.priority === undefined ? ("high" as const) : mail.priority,
          push: false,
        });
      await proactiveStore.record({
        ...scope,
        decision: {
          id: `proactive-decision:${decisions}`,
          scenario: "gmail",
          checkedAt: clock.now(),
          counts: {
            fetched: mails.length,
            skipped: 0,
            judged: mails.length,
            act: mails.length,
            know: 0,
            check: 0,
            ignore: 0,
            floorRaised: 0,
            pushed: 0,
          },
          verdict: "silent",
          reasonCode: "NO_PUSH",
          pushSourceKey: null,
          costMicros: 0,
          durationMs: 1,
          ownerRating: null,
          ratedAt: null,
        },
        inputs: {
          ruleIds: [],
          sourceIds: mails.map(({ id }) => `gmail-message-${id}`),
          floorHits: {},
          memoryInjected: false,
          memoryIds: [],
          usedMemoryIds: [],
          tentativeMemoryIds: [],
          memoryByMail: {},
          memoryRecall: "off",
        } as never,
        modelPayloads: [],
        processed: [],
        insights,
        repliedThreads: [],
        push: null,
        cursor: null,
      });
    };

    const remember = async (
      id: string,
      text: string,
      dataClassification: "private" | "sensitive" = "private",
    ) => {
      await put(`payload-${id}`, text, dataClassification);
      return memory.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId(id),
            ...scope,
            contentRef: `payload-${id}`,
            dataClassification,
            sourceThreadId: THREAD_ID,
            sourceRefs: [`message-${id}`],
            inference: false,
            confidencePermille: 1000,
            policyVersion: "memory-policy-v1",
          },
        } as never,
        GENERATION_ID,
      );
    };
    const remind = async (id: string, text: string, remindAt: string, dueAt: string) => {
      await remember(`memory-${id}`, text);
      await repository.memoryReminders().schedule({
        id,
        ...scope,
        memoryId: createMemoryId(`memory-${id}`),
        dueAt,
        remindAt,
        repeat: "none",
        status: "scheduled",
        dismissedAt: null,
        createdAt: START,
        updatedAt: START,
      });
    };
    const memoryRequest = async (id: string, text: string) => {
      await put(`message-${id}`, text, "sensitive");
      const request: SensitiveMemoryApprovalRequest = {
        id,
        ...scope,
        runId: RUN_ID,
        threadId: THREAD_ID,
        generationId: GENERATION_ID,
        sourceRef: `message-${id}`,
        sourceClassification: "private",
        candidateOrdinal: 0,
        productMemoryId: createMemoryId(`memory-request-${id}`),
        decision: "create",
        existingMemoryId: null,
        dataClassification: "sensitive",
        policyVersion: "memory-policy-v1",
        modelDescriptorRef: "model-fixture",
        status: "pending",
        deliveryState: "queued_no_ui",
        requestedAt: at(-20),
        decidedAt: null,
        committedAt: null,
      };
      await repository.sensitiveMemoryApprovals().create(request);
      await protectedMemoryCandidates({ payloads, protector, clock }).store({
        request,
        candidate: { text, sensitiveTopic: "health" } as never,
      });
      return request;
    };

    const sender = {
      publicKey: "public-key",
      requests: [] as WebPushSendRequest[],
      async send(request: WebPushSendRequest) {
        this.requests.push(request);
        return { kind: "sent" as const };
      },
    };
    const push = new ProductionWebPush({
      ...scope,
      store: repository.webPush(),
      sender,
      presence: new WebPushPresence(),
      reminders: repository.memoryReminders(),
      memories: repository.productMemoryState(),
      readMemoryText: async (record) => {
        const payload = await payloads.get(record.contentRef);
        return payload
          ? new TextDecoder().decode(await protector.unprotect({ ...scope, payload }))
          : undefined;
      },
      listApprovals,
      awaitingCount: () => home.awaitingCount(),
      runThread,
      threadTitle: titled,
      publicOrigin: "https://himawari.example",
      timeZone: "Asia/Tokyo",
      now: clock.now,
      onFailure: (error) => failures.push(error),
    });

    return {
      repository,
      home,
      read,
      sql,
      put,
      seedRun,
      createApproval,
      approval,
      recordMail,
      proactiveStore,
      remember,
      remind,
      memoryRequest,
      memory,
      push,
      sender,
      failures,
      setNow: (value: string) => {
        now = value;
      },
    };
  }

  const keys = (snapshot: HomeSnapshot) => snapshot.items.map(({ key }) => key);

  it("is empty, with a zero count, when nothing has happened", async () => {
    const f = await fixture();
    const snapshot = await f.read();
    expect(snapshot.items).toEqual([]);
    expect(snapshot.awaitingCount).toBe(0);
    expect(snapshot.awaitingTruncated).toBe(false);
    expect(snapshot.incompleteSources).toEqual([]);
    expect(snapshot.upcoming).toEqual([]);
    expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(await f.home.awaitingCount()).toBe(0);
  });

  it("shows a pending approval, also one queued without a screen, and drops it once it expires", async () => {
    const f = await fixture();
    await f.createApproval("approval-shown", { expiresAt: at(60) });
    await f.createApproval("approval-queued", {
      deliveryState: "queued_no_ui",
      expiresAt: at(120),
    });
    const snapshot = await f.read();
    expect(keys(snapshot)).toEqual(["approval:approval-shown", "approval:approval-queued"]);
    expect(snapshot.awaitingCount).toBe(2);
    expect(snapshot.items[0]).toMatchObject({
      kind: "approval",
      awaitsOwner: true,
      sentence: null,
      sentenceBasis: "none",
      target: { type: "approval", id: "approval-shown", threadId: THREAD_ID },
      deadline: at(60),
      rank: "deadline",
      actions: [
        { action: "approved", label: "同意", labelBasis: "catalog", polarity: "positive" },
        { action: "denied", label: "不同意", labelBasis: "catalog", polarity: "negative" },
      ],
    });

    f.setNow(at(61));
    const later = await f.read();
    expect(keys(later)).toEqual(["approval:approval-queued"]);
    expect(later.awaitingCount).toBe(1);
    expect(later.revision).not.toBe(snapshot.revision);
  });

  it("drops an approval once it is answered", async () => {
    const f = await fixture();
    const created = await f.createApproval("approval-answered");
    expect((await f.read()).awaitingCount).toBe(1);
    await f.repository.authorizationStore().resolveApproval({
      approvalRequestId: created.id,
      expectedRevision: created.revision,
      semanticSnapshotHash: created.semanticSnapshotHash,
      resolution: "denied",
      decidedAt: NOW,
      grant: null,
    });
    const snapshot = await f.read();
    expect(snapshot.items).toEqual([]);
    expect(snapshot.awaitingCount).toBe(0);
  });

  it("shows open mail reminders with what the mail check recorded, and drops one marked done", async () => {
    const f = await fixture();
    await f.recordMail([
      { id: "plain", summary: "田中把会改到 15:00" },
      { id: "rule", summary: "入管局来信", floorRaised: true, result: "know", priority: null },
      { id: "quiet", summary: "只是知会", result: "know", priority: null },
      { id: "low", summary: "不急的事", priority: "low" },
    ]);
    const snapshot = await f.read();
    expect(keys(snapshot)).toEqual(["insight:insight-rule", "insight:insight-plain"]);
    expect(snapshot.items.map(({ rank }) => rank)).toEqual(["rule", "unscored"]);
    expect(snapshot.awaitingCount).toBe(2);
    expect(snapshot.items[1]).toMatchObject({
      kind: "heads_up",
      sentence: "田中把会改到 15:00",
      sentenceBasis: "recorded",
      target: {
        type: "mail",
        id: "insight-plain",
        link: "https://mail.google.com/mail/u/0/#inbox/plain",
      },
      source: {
        type: "mail",
        from: "田中 <tanaka@example.com>",
        label: "主题 plain",
        decisionId: "proactive-decision:1",
      },
      actions: [{ action: "done" }, { action: "mute" }],
    });

    expect(
      await f.proactiveStore.updateInsight({
        ...scope,
        insightId: "insight-plain",
        status: "done",
        now: NOW,
      }),
    ).toBe(true);
    const after = await f.read();
    expect(keys(after)).toEqual(["insight:insight-rule"]);
    expect(after.awaitingCount).toBe(1);
  });

  it("shows a memory reminder once it is due, lists the rest as upcoming, and drops one dismissed", async () => {
    const f = await fixture();
    await f.remind("reminder-due", "给妈妈打电话", at(-10), at(120));
    await f.remind("reminder-later", "交报税材料", at(5 * 1440), at(6 * 1440));
    const snapshot = await f.read();
    expect(keys(snapshot)).toEqual(["reminder:reminder-due"]);
    expect(snapshot.awaitingCount).toBe(1);
    expect(snapshot.items[0]).toMatchObject({
      kind: "heads_up",
      sentence: "给妈妈打电话",
      sentenceBasis: "recorded",
      target: { type: "memory", id: "memory-reminder-due", threadId: THREAD_ID },
      deadline: at(120),
      rank: "deadline",
      dataClassification: "private",
      actions: [{ action: "dismiss" }, { action: "snooze" }, { action: "cancel" }],
    });
    expect(snapshot.upcoming).toEqual([
      {
        reminderId: "reminder-later",
        memoryId: "memory-reminder-later",
        text: "交报税材料",
        dueAt: at(6 * 1440),
        repeat: "none",
        sourceThreadId: THREAD_ID,
      },
    ]);

    const stored = await f.repository.memoryReminders().read("reminder-due");
    if (!stored) throw new Error("reminder");
    await f.repository.memoryReminders().update({
      id: stored.id,
      expectedUpdatedAt: stored.updatedAt,
      status: "dismissed",
      dueAt: stored.dueAt,
      remindAt: stored.remindAt,
      dismissedAt: NOW,
      updatedAt: NOW,
    });
    const after = await f.read();
    expect(after.items).toEqual([]);
    expect(after.awaitingCount).toBe(0);
  });

  it("shows a sensitive memory waiting for a yes with its own classification", async () => {
    const f = await fixture();
    const request = await f.memoryRequest("memory-request-1", "我的血压偏高");
    const snapshot = await f.read();
    expect(snapshot.awaitingCount).toBe(1);
    expect(snapshot.items[0]).toMatchObject({
      key: "memory_request:memory-request-1",
      kind: "memory_confirm",
      sentence: "我的血压偏高",
      target: { type: "memory_request", id: "memory-request-1", threadId: THREAD_ID },
      dataClassification: "sensitive",
      rank: "unscored",
      actions: [
        { action: "approved", label: "记下", polarity: "positive" },
        { action: "rejected", label: "不记", polarity: "negative" },
      ],
    });
    await f.repository
      .sensitiveMemoryApprovals()
      .resolve({ requestId: request.id, resolution: "rejected", decidedAt: NOW });
    expect((await f.read()).awaitingCount).toBe(0);
  });

  it("asks for Gmail to be reconnected in the reader's language and stops once it is connected again", async () => {
    const f = await fixture();
    const connection = {
      source: "gmail" as const,
      accountRef: await f.put("payload-account", "andy@example.com"),
      tokenRef: await f.put("payload-token", "token"),
      cursor: null,
      status: "connected" as const,
      connectedAt: START,
      updatedAt: START,
    };
    await f.proactiveStore.saveConnection({ ...scope, connection });
    expect((await f.read()).items).toEqual([]);
    await f.proactiveStore.markConnection({
      ...scope,
      source: "gmail",
      status: "needs_reconnect",
      cursor: null,
      now: at(-15),
    });
    for (const locale of ["zh-CN", "en", "ja"] as const) {
      const snapshot = await f.read(locale);
      expect(snapshot.awaitingCount).toBe(1);
      expect(snapshot.items[0]).toMatchObject({
        key: "connection:gmail",
        kind: "problem",
        awaitsOwner: true,
        sentence: HOME_TEXT[locale].gmailReconnect,
        sentenceBasis: "catalog",
        target: { type: "connection", id: "gmail" },
        createdAt: at(-15),
        actions: [{ action: "reconnect", label: HOME_TEXT[locale].actions.reconnect }],
      });
    }
    await f.proactiveStore.markConnection({
      ...scope,
      source: "gmail",
      status: "connected",
      cursor: null,
      now: NOW,
    });
    expect((await f.read()).awaitingCount).toBe(0);
  });

  it("asks for a rule to be confirmed again when its source memory changed, and not while it is active", async () => {
    const f = await fixture();
    await f.remember("memory-rule-immigration", "入管局的邮件以后必须通知我");
    f.sql((handle) =>
      handle
        .prepare("UPDATE memory_records SET category = 'rule' WHERE id = ?")
        .run("memory-rule-immigration"),
    );
    expect(
      await f.repository.ownerRules().create({
        ...scope,
        ruleId: "owner:immigration",
        parameters: {
          type: "mail_must_notify",
          summary: "日本入管局相关的邮件一律提醒",
          params: { senderDomains: ["isa.go.jp"], phrases: ["在留資格"] },
        },
        source: "chat:thread-home",
        sourceMemoryId: "memory-rule-immigration",
        now: START,
      }),
    ).toBe("created");
    expect((await f.read()).items).toEqual([]);
    f.sql((handle) =>
      handle
        .prepare("UPDATE memory_records SET status = 'archived', updated_at = ? WHERE id = ?")
        .run(at(-5), "memory-rule-immigration"),
    );
    const snapshot = await f.read();
    expect(snapshot.awaitingCount).toBe(1);
    expect(snapshot.items[0]).toMatchObject({
      key: "rule:owner:immigration",
      kind: "problem",
      awaitsOwner: true,
      sentence: HOME_TEXT["zh-CN"].ruleReview,
      sentenceBasis: "catalog",
      target: { type: "rule", id: "owner:immigration" },
      source: { type: "rule", label: "日本入管局相关的邮件一律提醒" },
      actions: [{ action: "reconfirm" }, { action: "undo" }],
    });
  });

  it("shows unattended runs and failures without counting them, and never an empty sentence", async () => {
    const f = await fixture();
    f.seedRun("run-scheduled", {
      sourceType: "schedule",
      status: "running",
      threadId: UNTITLED_THREAD_ID,
      when: at(-40),
    });
    f.seedRun("run-background", {
      sourceType: "user_message",
      status: "completed",
      when: at(-30),
      hold: "open",
    });
    f.seedRun("run-failed", { sourceType: "external_event", status: "failed", when: at(-20) });
    f.seedRun("run-background-failed", {
      sourceType: "user_message",
      status: "failed",
      when: at(-10),
      hold: "released",
    });
    f.seedRun("run-failed-long-ago", {
      sourceType: "schedule",
      status: "failed",
      when: at(-3 * 1440),
    });
    f.seedRun("run-owner-failed", { sourceType: "user_message", status: "failed", when: at(-5) });
    f.seedRun("run-scheduled-done", { sourceType: "schedule", status: "completed", when: at(-5) });

    const snapshot = await f.read();
    expect(snapshot.awaitingCount).toBe(0);
    expect(await f.home.awaitingCount()).toBe(0);
    expect(snapshot.items.map(({ key, kind }) => [key, kind])).toEqual([
      ["run:run-background-failed", "problem"],
      ["run:run-failed", "problem"],
      ["run:run-background", "running"],
      ["run:run-scheduled", "running"],
    ]);
    expect(
      snapshot.items.every(({ awaitsOwner, rank }) => !awaitsOwner && rank === "recency"),
    ).toBe(true);
    const untitled = snapshot.items.find(({ key }) => key === "run:run-scheduled");
    expect(untitled).toMatchObject({
      sentence: null,
      sentenceBasis: "none",
      target: { type: "thread", id: UNTITLED_THREAD_ID },
      actions: [],
    });
  });

  it("orders rule hits, then near deadlines, then the rest, the same on every read and after a restart of the reader", async () => {
    const f = await fixture();
    await f.createApproval("approval-far", { expiresAt: at(5 * 1440) });
    await f.memoryRequest("memory-request-1", "我的血压偏高");
    await f.remind("reminder-due", "给妈妈打电话", at(-10), at(90));
    await f.recordMail([
      { id: "plain", summary: "普通邮件" },
      { id: "due", summary: "明早要交", dueAt: at(600) },
      { id: "rule", summary: "入管局来信", floorRaised: true },
    ]);
    f.seedRun("run-scheduled", { sourceType: "schedule", status: "running", when: at(-1) });
    const expected = [
      ["insight:insight-rule", "rule"],
      ["reminder:reminder-due", "deadline"],
      ["insight:insight-due", "deadline"],
      ["approval:approval-far", "unscored"],
      ["insight:insight-plain", "unscored"],
      ["memory_request:memory-request-1", "unscored"],
      ["run:run-scheduled", "recency"],
    ];
    const first = await f.read();
    expect(first.items.map(({ key, rank }) => [key, rank])).toEqual(expected);
    expect(first.awaitingCount).toBe(6);
    expect(first.items.filter(({ awaitsOwner }) => awaitsOwner)).toHaveLength(6);
    const second = await f.read();
    expect(second.revision).toBe(first.revision);
    expect(second.items).toEqual(first.items);
  });

  it("keeps the real count and says so when the list is cut", async () => {
    const f = await fixture({ ...DEFAULT_HOME_FEED, awaitingLimit: 2, sourceReadLimit: 2 });
    for (let index = 0; index < 4; index += 1)
      await f.remind(`reminder-${index}`, `提醒 ${index}`, at(-10 - index), at(60 + index));
    await f.createApproval("approval-1");
    const snapshot = await f.read();
    expect(snapshot.items.filter(({ awaitsOwner }) => awaitsOwner)).toHaveLength(2);
    expect(snapshot.awaitingCount).toBe(5);
    expect(snapshot.awaitingTruncated).toBe(true);
    expect(await f.home.awaitingCount()).toBe(5);
  });

  it("puts the same number on the web push badge as the home count", async () => {
    const f = await fixture();
    await f.repository.webPush().saveSubscription({
      ...scope,
      id: "phone",
      endpoint: "https://push.example/phone",
      p256dh: "key-phone",
      auth: "auth-phone",
      locale: "zh-CN",
      deviceLabel: "phone",
      now: NOW,
    });
    await f.repository
      .webPush()
      .writeKinds({ ...scope, kinds: ["reminder", "approval", "run"], now: NOW });
    await f.createApproval("approval-1", { expiresAt: at(60) });
    await f.memoryRequest("memory-request-1", "我的血压偏高");
    await f.recordMail([{ id: "plain", summary: "普通邮件" }]);
    await f.remind("reminder-old", "七小时前到点的提醒", at(-7 * 60), at(-6 * 60));
    f.seedRun("run-scheduled", { sourceType: "schedule", status: "running", when: at(-1) });

    const snapshot = await f.read();
    expect(snapshot.awaitingCount).toBe(4);
    await f.push.tick();
    await f.push.tick();
    expect(f.failures).toEqual([]);
    const badges = f.sender.requests.map(
      ({ payload }) =>
        (JSON.parse(payload) as { notification: Record<string, string> }).notification["app_badge"],
    );
    expect(badges).toEqual(["4"]);
  });
});
