import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ApprovalRequest,
  createProactiveSeal,
  type DataClassification,
  DEFAULT_HOME_FEED,
  DEFAULT_HOME_URGENCY,
  HOME_URGENCY_ITEMS_PER_READ,
  type HomeUrgencyConfiguration,
  type HomeUrgencyRunResult,
  HomeUrgencyService,
  type HomeUrgencyStorePort,
  MODEL_USAGE_PURPOSES,
  type ModelInvocationEvent,
  type ModelInvocationRequest,
  type ProactiveModelInvoker,
  readProactiveOverview,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  type GatewayV2Snapshot,
  gatewayV2MessageSchema,
  HOME_LABEL_BASES,
  HOME_RANKS,
  HOME_SENTENCE_BASES,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { HOME_URGENCY } from "@himawari-agent/prompt-catalog";
import { createReferenceAdapterSet, DeterministicIdGenerator } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { HOME_TEXT, ProductionHomeControl } from "../../apps/agent-service/src/production-home.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-home-urgency");
const AGENT_ID = createAgentId("agent-home-urgency");
const THREAD_ID = createThreadId("thread-home-urgency");
const RUN_ID = createRunId("run-home-urgency");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const START = "2026-11-12T00:00:00.000Z";
const NOW = "2026-11-12T03:00:00.000Z";
const MODEL_REF = "urgency-model";
const AUTHORITY = {
  deploymentId: createDeploymentId("deployment-home-urgency"),
  authorityEpoch: 1,
  fencingToken: 1,
};
const HOUR_MS = 3_600_000;

type HomeSnapshot = Extract<GatewayV2Snapshot, { type: "home.snapshot" }>["payload"];
type Locale = "zh-CN" | "en" | "ja";

interface NewItem {
  readonly n: number;
  readonly kind: string;
  readonly deadline: string | null;
  readonly facts?: Record<string, unknown>;
  readonly copy?: boolean;
}

interface Asked {
  readonly prompt: string;
  readonly dataClassification: DataClassification;
  readonly reference: readonly Record<string, unknown>[];
  readonly fresh: readonly NewItem[];
  readonly last: Record<string, unknown>;
}

type Answer =
  | { readonly output: string; readonly costMicros?: number }
  | { readonly fail: string; readonly costMicros?: number };

function asked(prompt: string, dataClassification: DataClassification): Asked {
  const lines = prompt.slice(HOME_URGENCY.text.length + 1).split("\n");
  return {
    prompt,
    dataClassification,
    reference: JSON.parse(lines[1] as string),
    fresh: JSON.parse(lines[3] as string),
    last: JSON.parse(lines[4] as string),
  };
}

const scoreAll =
  (score: (item: NewItem) => number) =>
  (call: Asked): Answer => ({
    output: JSON.stringify({
      items: call.fresh.map((item) => ({ n: item.n, score: score(item) })),
    }),
    costMicros: 300,
  });

describe("[home-urgency] model urgency scores on the home feed", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const deletionRoot = await mkdtemp(path.join(tmpdir(), "himawari-home-urgency-"));
    directories.push(deletionRoot);
    const stateRoot = path.join(deletionRoot, "data");
    await mkdir(stateRoot);
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
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
          encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
        ) VALUES ('payload-trigger', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:trigger',
          'fixture', 'fixture-key', 'active', ?, 'application/octet-stream')`,
      )
      .run(OWNER_ID, AGENT_ID, START);
    database
      .prepare(
        `INSERT INTO triggers (
          id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
          payload_ref, source_proof_ref, occurred_at
        ) VALUES ('trigger-1', ?, ?, ?, 'key-1', 'user_message', 'source-1', 'payload-trigger',
          'proof', ?)`,
      )
      .run(OWNER_ID, AGENT_ID, THREAD_ID, START);
    database
      .prepare(
        `INSERT INTO runs (
          id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'session', 'trigger-1', 2, 'running', ?, ?)`,
      )
      .run(RUN_ID, OWNER_ID, AGENT_ID, THREAD_ID, START, START);
    database.close();

    let now = NOW;
    const clock = { now: () => now };
    const sql = <T>(run: (handle: ReturnType<typeof openQualifiedDatabase>) => T): T => {
      const handle = openQualifiedDatabase(file);
      try {
        return run(handle);
      } finally {
        handle.close();
      }
    };
    const calls: Asked[] = [];
    let answer: (call: Asked) => Answer = scoreAll(() => 500);
    let locale: Locale | null = "zh-CN";
    let allowed: readonly DataClassification[] = ["public", "private", "sensitive"];
    let titleClassification: DataClassification = "private";
    const results: HomeUrgencyRunResult[] = [];
    const released: string[] = [];
    const failures: unknown[] = [];

    const open = async (
      settings: Partial<HomeUrgencyConfiguration> = {},
      wrapStore: (store: HomeUrgencyStorePort) => HomeUrgencyStorePort = (store) => store,
    ) => {
      const repository = await SqliteProductStateRepository.open({
        stateRoot,
        minimumFreeBytes: 0,
        now: clock.now,
      });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await repository.close();
      };
      closers.push(close);
      const protector = createReferenceAdapterSet().payloadProtector;
      const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
      const seal = createProactiveSeal({
        payloads,
        protector,
        ids: new DeterministicIdGenerator(),
      });
      const proactiveStore = repository.proactive();
      const outputs = new Map<string, string>();
      const replies = new Map<string, Answer>();
      const model: ProactiveModelInvoker = {
        modelRef: MODEL_REF,
        get allowedDataClassifications() {
          return allowed;
        },
        model: {
          async *invoke(request: ModelInvocationRequest): AsyncIterable<ModelInvocationEvent> {
            const reply = replies.get(request.invocationId) as Answer;
            const occurredAt = clock.now();
            yield { type: "model.started", invocationId: request.invocationId, occurredAt };
            if ("fail" in reply) {
              yield {
                type: "model.failed",
                invocationId: request.invocationId,
                errorCode: reply.fail,
                retryable: false,
                occurredAt,
              } as ModelInvocationEvent;
              return;
            }
            yield {
              type: "model.output",
              invocationId: request.invocationId,
              sequence: 1,
              payloadRef: `out-${request.invocationId}`,
              occurredAt,
            };
            yield {
              type: "model.completed",
              invocationId: request.invocationId,
              inputTokens: 200,
              outputTokens: 10,
              costMicros: reply.costMicros ?? 0,
              latencyMs: 5,
              occurredAt,
            };
          },
        } as unknown as ProactiveModelInvoker["model"],
        async prepare({ invocationId, prompt, dataClassification }) {
          const call = asked(prompt, dataClassification);
          calls.push(call);
          const reply = answer(call);
          replies.set(invocationId, reply);
          if ("output" in reply) outputs.set(`out-${invocationId}`, reply.output);
          return {
            runId: `home-urgency:${invocationId}` as never,
            inputRef: `in-${invocationId}`,
            allowedDisclosureRef: `in-${invocationId}`,
            secretHandleRefs: [],
            release: async () => undefined,
          };
        },
        readOutput: async (ref) => outputs.get(ref) ?? "",
        release: async (refs) => {
          released.push(...refs);
        },
      };
      const home = new ProductionHomeControl({
        settings: DEFAULT_HOME_FEED,
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
        listApprovals: () =>
          repository.authorizationStore().listApprovals(OWNER_ID, AGENT_ID, { status: "pending" }),
        runThread: async (runId) =>
          (await repository.runLifecycle(OWNER_ID, AGENT_ID, AUTHORITY).readRun(createRunId(runId)))
            ?.run.threadId ?? null,
        threadTitle: async () => ({
          title: "和田中约时间",
          dataClassification: titleClassification,
        }),
        clock,
        onSourceFailure: (source) => failures.push(source),
        urgency: {
          scope,
          settings: { ...DEFAULT_HOME_URGENCY, ...settings },
          store: wrapStore(repository.homeUrgency()),
          seal,
          model,
          modelAllows: (classification) => allowed.includes(classification),
          timeZone: "Asia/Tokyo",
          estimateCostMicros: () => 400,
          readLocale: async () => locale,
          onScored: (result) => results.push(result),
          onFailure: (error) => failures.push(error),
        },
      });
      const read = async (reader: Locale = "zh-CN"): Promise<HomeSnapshot> => {
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
            payload: { locale: reader },
          }) as never,
        );
        const parsed = gatewayV2MessageSchema.parse(JSON.parse(JSON.stringify(snapshot)));
        if (parsed.type !== "home.snapshot") throw new Error("snapshot");
        return parsed.payload;
      };
      let decisions = sql(
        (handle) => handle.prepare("SELECT count(*) FROM decision_ledger").pluck().get() as number,
      );
      const recordMail = async (
        mails: readonly {
          readonly id: string;
          readonly summary: string;
          readonly floorRaised?: boolean;
          readonly dueAt?: string | null;
        }[],
      ) => {
        decisions += 1;
        const insights = [];
        for (const mail of mails)
          insights.push({
            id: `insight-${mail.id}`,
            threadId: `gmail-thread-${mail.id}`,
            lastMessageId: `gmail-message-${mail.id}`,
            result: "act" as const,
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
            priority: "high" as const,
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
      const createApproval = (id: string, extra: Partial<ApprovalRequest> = {}) =>
        repository.authorizationStore().createApproval({
          id,
          revision: 1,
          ...scope,
          runId: RUN_ID,
          intentId: `intent-${id}`,
          intentSnapshot: {
            id: `intent-${id}`,
            ...scope,
            runId: RUN_ID,
            capabilityRef: "capability-mail",
            operation: "send",
            resourceRef: "mailto:tanaka@example.com",
            dataClassification: "private",
            sideEffect: "irreversible",
            estimatedCostMicros: 0,
            frequency: { count: 1, intervalMs: null },
            idempotencyKey: createIdempotencyKey(`intent-${id}`),
            reversible: false,
            requestedAt: NOW,
          } as ApprovalRequest["intentSnapshot"],
          semanticSnapshotHash: `hash-${id}`,
          status: "pending",
          deliveryState: "deliverable",
          requestedAt: NOW,
          expiresAt: new Date(Date.parse(NOW) + 72 * HOUR_MS).toISOString(),
          decidedAt: null,
          grantId: null,
          ...extra,
        });
      return { repository, home, read, recordMail, createApproval, close, payloads, model, seal };
    };

    const rows = () =>
      sql(
        (handle) =>
          handle
            .prepare(
              `SELECT item_key AS itemKey, status, score, failure_code AS failureCode,
                affirm_label AS affirmLabel, copy_locale AS copyLocale,
                sentence_ref AS sentenceRef, cost_micros AS costMicros,
                invocation_id AS invocationId, approval_request_id AS approvalRequestId,
                model_ref AS modelRef, prompt_id AS promptId
              FROM home_item_scores ORDER BY created_at, id`,
            )
            .all() as {
            itemKey: string;
            status: string;
            score: number | null;
            failureCode: string | null;
            affirmLabel: string | null;
            copyLocale: string | null;
            sentenceRef: string | null;
            costMicros: number;
            invocationId: string;
            approvalRequestId: string | null;
            modelRef: string;
            promptId: string;
          }[],
      );
    return {
      open,
      sql,
      rows,
      calls,
      results,
      failures,
      released,
      advance: (ms: number) => {
        now = new Date(Date.parse(now) + ms).toISOString();
      },
      answerWith: (next: (call: Asked) => Answer) => {
        answer = next;
      },
      setLocale: (next: Locale | null) => {
        locale = next;
      },
      allow: (next: readonly DataClassification[]) => {
        allowed = next;
      },
      setTitleClassification: (next: DataClassification) => {
        titleClassification = next;
      },
      deletionRoot,
      databasePath: file,
    };
  }

  const keys = (snapshot: HomeSnapshot) => snapshot.items.map(({ key, rank }) => `${key}|${rank}`);

  it("scores new items once, in one call, and orders the feed by score", async () => {
    const state = await fixture();
    const { home, read, recordMail } = await state.open();
    await recordMail([
      { id: "low", summary: "周报已发" },
      { id: "high", summary: "合同今天要签" },
      { id: "mid", summary: "下周聚餐投票" },
    ]);
    expect(keys(await read())).toEqual([
      "insight:insight-high|unscored",
      "insight:insight-low|unscored",
      "insight:insight-mid|unscored",
    ]);
    state.answerWith(
      scoreAll((item) =>
        String(item.facts?.["text"]).includes("合同")
          ? 900
          : String(item.facts?.["text"]).includes("聚餐")
            ? 400
            : 100,
      ),
    );
    expect(await home.score()).toEqual({
      attempted: 3,
      recorded: 3,
      failures: [],
      stoppedBy: "done",
    });
    expect(state.calls).toHaveLength(1);
    const [call] = state.calls as [Asked];
    expect(call.prompt.startsWith(`${HOME_URGENCY.text}\n参照：\n[]\n新条目：\n`)).toBe(true);
    expect(call.fresh.map(({ n, kind }) => [n, kind])).toEqual([
      [1, "heads_up"],
      [2, "heads_up"],
      [3, "heads_up"],
    ]);
    expect(call.last).toEqual({
      now: NOW,
      timeZone: "Asia/Tokyo",
      language: "zh-CN",
      affirmMax: 6,
    });
    expect(keys(await read())).toEqual([
      "insight:insight-high|model",
      "insight:insight-mid|model",
      "insight:insight-low|model",
    ]);
    expect(await home.score()).toMatchObject({ attempted: 0, stoppedBy: "nothing_new" });
    expect(state.calls).toHaveLength(1);
    expect(state.rows().map(({ itemKey, status, score }) => [itemKey, status, score])).toEqual([
      ["insight:insight-high", "done", 900],
      ["insight:insight-low", "done", 100],
      ["insight:insight-mid", "done", 400],
    ]);
    expect(new Set(state.rows().map(({ invocationId }) => invocationId)).size).toBe(1);
    expect(state.rows()[0]).toMatchObject({
      modelRef: MODEL_REF,
      promptId: expect.stringMatching(/^home\.urgency@[0-9a-f]{12}$/u),
    });
    expect(state.failures).toEqual([]);
  });

  it("puts a new item first until it is scored, then sends the scored ones as reference without rescoring them", async () => {
    const state = await fixture();
    const { home, read, recordMail } = await state.open();
    await recordMail([
      { id: "b", summary: "乙" },
      { id: "a", summary: "甲" },
    ]);
    state.answerWith(scoreAll((item) => (item.facts?.["text"] === "甲" ? 300 : 700)));
    await home.score();
    state.advance(60_000);
    await recordMail([{ id: "c", summary: "丙" }]);
    expect(keys(await read())).toEqual([
      "insight:insight-c|unscored",
      "insight:insight-b|model",
      "insight:insight-a|model",
    ]);
    state.answerWith(scoreAll(() => 500));
    await home.score();
    const second = state.calls[1] as Asked;
    expect(
      second.reference.map((item) => [item["score"], (item["facts"] as { text: string }).text]),
    ).toEqual([
      [300, "甲"],
      [700, "乙"],
    ]);
    expect(second.fresh.map(({ facts }) => facts?.["text"])).toEqual(["丙"]);
    expect(keys(await read())).toEqual([
      "insight:insight-b|model",
      "insight:insight-c|model",
      "insight:insight-a|model",
    ]);
    expect(state.rows().filter(({ itemKey }) => itemKey === "insight:insight-a")).toHaveLength(1);
  });

  it("sends the same bytes for the same open items whatever order they were stored in", async () => {
    const one = await fixture();
    const first = await one.open();
    await first.recordMail([
      { id: "a", summary: "甲" },
      { id: "b", summary: "乙" },
    ]);
    await first.home.score();
    const two = await fixture();
    const second = await two.open();
    await second.recordMail([{ id: "b", summary: "乙" }]);
    await second.recordMail([{ id: "a", summary: "甲" }]);
    await second.home.score();
    expect(two.calls[0]?.prompt).toBe(one.calls[0]?.prompt);
  });

  it("keeps the order after a restart without calling the model again", async () => {
    const state = await fixture();
    const before = await state.open();
    await before.recordMail([
      { id: "a", summary: "甲" },
      { id: "b", summary: "乙" },
    ]);
    state.answerWith(scoreAll((item) => (item.facts?.["text"] === "甲" ? 800 : 200)));
    await before.home.score();
    const order = keys(await before.read());
    await before.close();
    const after = await state.open();
    expect(keys(await after.read())).toEqual(order);
    expect(await after.home.score()).toMatchObject({ stoppedBy: "nothing_new" });
    expect(state.calls).toHaveLength(1);
  });

  it("keeps rule hits and near deadlines above any model score", async () => {
    const state = await fixture();
    const { home, read, recordMail } = await state.open();
    await recordMail([
      { id: "scored", summary: "模型说最急" },
      { id: "rule", summary: "重要发件人", floorRaised: true },
      {
        id: "soon",
        summary: "一小时后到期",
        dueAt: new Date(Date.parse(NOW) + HOUR_MS).toISOString(),
      },
    ]);
    state.answerWith(scoreAll((item) => (item.facts?.["text"] === "模型说最急" ? 1000 : 0)));
    await home.score();
    expect(keys(await read())).toEqual([
      "insight:insight-rule|rule",
      "insight:insight-soon|deadline",
      "insight:insight-scored|model",
    ]);
  });

  it.each([
    ["an empty reply", { output: "" }],
    ["text that is not JSON", { output: "我不知道" }],
    ["a failed call", { fail: "TIMEOUT" }],
    ["only invented numbers", { output: '{"items":[{"n":9,"score":1},{"n":0,"score":1}]}' }],
  ] as const)("[negative] still returns every item after %s", async (_name, reply) => {
    const state = await fixture();
    const { home, read, recordMail } = await state.open();
    await recordMail([
      { id: "a", summary: "甲" },
      { id: "b", summary: "乙" },
    ]);
    state.answerWith(() => ({ ...reply, costMicros: 250 }));
    const result = await home.score();
    expect(result).toMatchObject({ attempted: 2, recorded: 0, stoppedBy: "done" });
    expect(keys(await read())).toEqual([
      "insight:insight-a|unscored",
      "insight:insight-b|unscored",
    ]);
    expect((await read()).awaitingCount).toBe(2);
    expect(state.rows().map(({ status, failureCode }) => [status, failureCode])).toEqual(
      "fail" in reply
        ? [
            ["failed", "MODEL_FAILED:TIMEOUT"],
            ["failed", "MODEL_FAILED:TIMEOUT"],
          ]
        : [
            ["failed", "URGENCY_ITEM_INVALID"],
            ["failed", "URGENCY_ITEM_INVALID"],
          ],
    );
  });

  it("[negative] scores only the numbered items the model answered, uses the first of a repeat, and does not retry a failed item for 24 hours", async () => {
    const state = await fixture();
    const { home, read, recordMail } = await state.open();
    await recordMail([
      { id: "a", summary: "甲" },
      { id: "b", summary: "乙" },
    ]);
    state.answerWith(() => ({
      output: '{"items":[{"n":1,"score":600},{"n":1,"score":1},{"n":7,"score":5}]}',
      costMicros: 300,
    }));
    expect(await home.score()).toEqual({
      attempted: 2,
      recorded: 1,
      failures: ["URGENCY_ITEM_INVALID"],
      stoppedBy: "done",
    });
    expect(keys(await read())).toEqual(["insight:insight-b|unscored", "insight:insight-a|model"]);
    state.answerWith(scoreAll(() => 50));
    state.advance(23 * HOUR_MS);
    expect(await home.score()).toMatchObject({ attempted: 0, stoppedBy: "nothing_new" });
    expect(state.calls).toHaveLength(1);
    state.advance(HOUR_MS);
    expect(await home.score()).toMatchObject({ attempted: 0, stoppedBy: "nothing_new" });
    state.advance(1);
    expect(await home.score()).toMatchObject({ attempted: 1, recorded: 1 });
    expect(state.calls[1]?.fresh.map(({ facts }) => facts?.["text"])).toEqual(["乙"]);
    expect(state.rows().map(({ itemKey, status, score }) => [itemKey, status, score])).toEqual([
      ["insight:insight-a", "done", 600],
      ["insight:insight-b", "failed", null],
      ["insight:insight-b", "done", 50],
    ]);
  });

  it("[negative] stops at the daily call limit, counts a call once however many items it scored, and resumes the next day", async () => {
    const state = await fixture();
    const { home, read, recordMail } = await state.open({ dailyLimit: 1 });
    await recordMail([
      { id: "a", summary: "甲" },
      { id: "b", summary: "乙" },
    ]);
    await home.score();
    state.advance(60_000);
    await recordMail([{ id: "c", summary: "丙" }]);
    expect(await home.score()).toMatchObject({ attempted: 0, stoppedBy: "daily_limit" });
    expect(state.calls).toHaveLength(1);
    expect(keys(await read())[0]).toBe("insight:insight-c|unscored");
    state.advance(24 * HOUR_MS);
    expect(await home.score()).toMatchObject({ attempted: 1, recorded: 1 });
  });

  it("allows a second call on the same day when the limit is two", async () => {
    const state = await fixture();
    const { home, recordMail } = await state.open({ dailyLimit: 2 });
    await recordMail([
      { id: "a", summary: "甲" },
      { id: "b", summary: "乙" },
    ]);
    await home.score();
    state.advance(60_000);
    await recordMail([{ id: "c", summary: "丙" }]);
    expect(await home.score()).toMatchObject({ attempted: 1, recorded: 1 });
  });

  it("[negative] stops before the call when the day's cost cap would be passed", async () => {
    const state = await fixture();
    const { home, recordMail } = await state.open({ dailyCostMicros: 600 });
    await recordMail([{ id: "a", summary: "甲" }]);
    await home.score();
    state.advance(60_000);
    await recordMail([{ id: "b", summary: "乙" }]);
    expect(await home.score()).toMatchObject({ attempted: 0, stoppedBy: "daily_cost" });
    expect(state.calls).toHaveLength(1);
  });

  it("[negative] does nothing when scoring is turned off", async () => {
    const state = await fixture();
    const { home, recordMail } = await state.open({ enabled: false });
    await recordMail([{ id: "a", summary: "甲" }]);
    expect(await home.score()).toMatchObject({ stoppedBy: "disabled" });
    expect(state.calls).toEqual([]);
  });

  it("scores an item again only when its text changes", async () => {
    const state = await fixture();
    const { home, recordMail } = await state.open();
    await recordMail([{ id: "a", summary: "甲" }]);
    await home.score();
    state.advance(60_000);
    await recordMail([{ id: "a", summary: "甲" }]);
    expect(await home.score()).toMatchObject({ stoppedBy: "nothing_new" });
    state.advance(60_000);
    await recordMail([{ id: "a", summary: "甲，今天截止" }]);
    expect(await home.score()).toMatchObject({ attempted: 1, recorded: 1 });
    expect(state.calls).toHaveLength(2);
  });

  it("shows the model's sentence and button label for an approval, and approvalCopy, which push is to read, returns the same pair", async () => {
    const state = await fixture();
    const { home, read, createApproval } = await state.open();
    await createApproval("send");
    const plain = (await read()).items[0];
    expect(plain).toMatchObject({ sentence: null, sentenceBasis: "none", rank: "unscored" });
    expect(plain?.actions[0]).toMatchObject({ label: "同意", labelBasis: "catalog" });
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({
          n,
          score: 820,
          sentence: "给田中发确认邮件",
          affirm: "发出去",
        })),
      }),
      costMicros: 300,
    }));
    await home.score();
    const [call] = state.calls as [Asked];
    expect(call.fresh).toEqual([
      {
        n: 1,
        kind: "approval",
        deadline: new Date(Date.parse(NOW) + 72 * HOUR_MS).toISOString(),
        facts: {
          capability: "capability-mail",
          conversation: "和田中约时间",
          estimatedCostMicros: 0,
          frequency: { count: 1, intervalMs: null },
          operation: "send",
          resource: "mailto:tanaka@example.com",
          reversible: false,
          sideEffect: "irreversible",
        },
        copy: true,
      },
    ]);
    const item = (await read()).items[0];
    expect(item).toMatchObject({
      key: "approval:send",
      sentence: "给田中发确认邮件",
      sentenceBasis: "model",
      rank: "model",
    });
    expect(item?.actions).toEqual([
      {
        action: "approved",
        label: "发出去",
        labelBasis: "model",
        polarity: "positive",
        ownerPresence: false,
        reviewLabel: null,
      },
      {
        action: "denied",
        label: "不同意",
        labelBasis: "catalog",
        polarity: "negative",
        ownerPresence: false,
        reviewLabel: null,
      },
    ]);
    expect(
      await home.approvalCopy({
        approvalRequestId: "send",
        semanticSnapshotHash: "hash-send",
        locale: "zh-CN",
      }),
    ).toEqual({ sentence: "给田中发确认邮件", affirmLabel: "发出去" });
    const [row] = state.rows();
    expect(row).toMatchObject({
      approvalRequestId: "send",
      affirmLabel: "发出去",
      copyLocale: "zh-CN",
    });
    expect(
      state.sql((handle) =>
        handle
          .prepare("SELECT hex(ciphertext) AS stored FROM payloads WHERE ref = ?")
          .pluck()
          .get(row?.sentenceRef),
      ),
    ).not.toContain(Buffer.from("给田中发确认邮件").toString("hex").toUpperCase());
  });

  it("[negative] falls back to the catalogue wording when the approval's content hash is not the scored one, or the reader's language differs", async () => {
    const state = await fixture();
    const { home, read, createApproval } = await state.open();
    await createApproval("send");
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({ n, score: 1, sentence: "发邮件", affirm: "发出去" })),
      }),
    }));
    await home.score();
    expect(
      await home.approvalCopy({
        approvalRequestId: "send",
        semanticSnapshotHash: "hash-changed",
        locale: "zh-CN",
      }),
    ).toEqual({ sentence: null, affirmLabel: null });
    expect(
      await home.approvalCopy({
        approvalRequestId: "other",
        semanticSnapshotHash: "hash-send",
        locale: "zh-CN",
      }),
    ).toEqual({ sentence: null, affirmLabel: null });
    const english = (await read("en")).items[0];
    expect(english).toMatchObject({ sentence: null, sentenceBasis: "none" });
    expect(english?.actions[0]).toMatchObject({
      label: HOME_TEXT.en.actions.approved,
      labelBasis: "catalog",
    });
  });

  it.each([
    ["one character over the limit", "改到九点四十分", "同意"],
    ["the same words as the negative button", "不同意", "同意"],
    ["missing", undefined, "同意"],
    ["empty", "   ", "同意"],
  ] as const)(
    "[negative] keeps the catalogue button when the model's label is %s",
    async (_name, affirm, expected) => {
      const state = await fixture();
      const { home, read, createApproval } = await state.open();
      await createApproval("send");
      state.answerWith((call) => ({
        output: JSON.stringify({
          items: call.fresh.map(({ n }) => ({ n, score: 1, sentence: "发邮件", affirm })),
        }),
      }));
      await home.score();
      const item = (await read()).items[0];
      expect(item).toMatchObject({ sentence: "发邮件", sentenceBasis: "model" });
      expect(item?.actions[0]).toMatchObject({ label: expected, labelBasis: "catalog" });
    },
  );

  it("accepts a label exactly at the limit, and follows a changed limit without a new call", async () => {
    const state = await fixture();
    const first = await state.open();
    await first.createApproval("send");
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({ n, score: 1, affirm: "改到九点四十" })),
      }),
    }));
    await first.home.score();
    expect((await first.read()).items[0]?.actions[0]).toMatchObject({
      label: "改到九点四十",
      labelBasis: "model",
    });
    await first.close();
    const second = await state.open({ affirmLabelMax: { "zh-CN": 5 } });
    expect((await second.read()).items[0]?.actions[0]).toMatchObject({
      label: "同意",
      labelBasis: "catalog",
    });
    expect(state.calls).toHaveLength(1);
  });

  it("keeps 'review first' on an approval that needs the owner present, with the model's label for the confirm step", async () => {
    const state = await fixture();
    const { home, read, createApproval } = await state.open();
    await createApproval("present", { recentAuthenticationRequired: true } as never);
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({ n, score: 1, sentence: "发邮件", affirm: "发出去" })),
      }),
    }));
    await home.score();
    expect((await read()).items[0]?.actions[0]).toEqual({
      action: "approved",
      label: "发出去",
      labelBasis: "model",
      polarity: "positive",
      ownerPresence: true,
      reviewLabel: "看内容再定",
    });
  });

  it("[negative] never writes model wording onto a mail item even when the model sends some", async () => {
    const state = await fixture();
    const { home, read, recordMail } = await state.open();
    await recordMail([{ id: "a", summary: "甲" }]);
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({ n, score: 5, sentence: "模型改写", affirm: "好的" })),
      }),
    }));
    await home.score();
    const item = (await read()).items[0];
    expect(item).toMatchObject({ sentence: "甲", sentenceBasis: "recorded" });
    expect(item?.actions.map(({ label, labelBasis }) => [label, labelBasis])).toEqual([
      ["完成", "catalog"],
      ["不再提醒", "catalog"],
    ]);
    expect(state.rows()[0]).toMatchObject({
      affirmLabel: null,
      sentenceRef: null,
      copyLocale: null,
    });
  });

  it("[negative] sends only kind and deadline for an item the model may not read, and never sends a restricted one", async () => {
    const state = await fixture();
    const { home, read, createApproval } = await state.open();
    state.allow(["public", "private"]);
    const intent = (id: string, dataClassification: DataClassification) =>
      ({
        id: `intent-${id}`,
        ...scope,
        runId: RUN_ID,
        capabilityRef: "capability-secret",
        operation: "绝密操作",
        resourceRef: "resource-secret",
        dataClassification,
        sideEffect: "irreversible",
        estimatedCostMicros: 0,
        frequency: { count: 1, intervalMs: null },
        idempotencyKey: createIdempotencyKey(`intent-${id}`),
        reversible: false,
        requestedAt: NOW,
      }) as ApprovalRequest["intentSnapshot"];
    await createApproval("sensitive", { intentSnapshot: intent("sensitive", "sensitive") });
    await createApproval("restricted", { intentSnapshot: intent("restricted", "restricted") });
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({ n, score: 300, sentence: "编的", affirm: "编的" })),
      }),
    }));
    await home.score();
    const [call] = state.calls as [Asked];
    expect(call.prompt).not.toContain("绝密");
    expect(call.dataClassification).toBe("private");
    expect(call.fresh).toEqual([
      {
        n: 1,
        kind: "approval",
        deadline: new Date(Date.parse(NOW) + 72 * HOUR_MS).toISOString(),
      },
    ]);
    expect(
      state
        .rows()
        .map(({ itemKey, affirmLabel, sentenceRef }) => [itemKey, affirmLabel, sentenceRef]),
    ).toEqual([["approval:sensitive", null, null]]);
    const snapshot = await read();
    expect(keys(snapshot).sort()).toEqual([
      "approval:restricted|unscored",
      "approval:sensitive|model",
    ]);
    for (const item of snapshot.items) {
      expect(item).toMatchObject({ sentence: null, sentenceBasis: "none" });
      expect(item.actions[0]).toMatchObject({ label: "同意", labelBasis: "catalog" });
    }
    expect(await home.score()).toMatchObject({ stoppedBy: "nothing_new" });
  });

  it("raises the call's classification to sensitive only when sensitive content is really sent", async () => {
    const state = await fixture();
    const { home, createApproval } = await state.open();
    await createApproval("sensitive", {
      intentSnapshot: {
        id: "intent-sensitive",
        ...scope,
        runId: RUN_ID,
        capabilityRef: "capability-mail",
        operation: "send",
        resourceRef: "resource",
        dataClassification: "sensitive",
        sideEffect: "irreversible",
        estimatedCostMicros: 0,
        frequency: { count: 1, intervalMs: null },
        idempotencyKey: createIdempotencyKey("intent-sensitive"),
        reversible: false,
        requestedAt: NOW,
      } as ApprovalRequest["intentSnapshot"],
    });
    await home.score();
    expect(state.calls[0]?.dataClassification).toBe("sensitive");
    expect(state.calls[0]?.fresh[0]?.copy).toBe(true);
  });

  it("asks the model to write in the owner's language and uses English when none is set", async () => {
    const state = await fixture();
    const { home, read, createApproval } = await state.open();
    state.setLocale(null);
    await createApproval("send");
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({
          n,
          score: 1,
          sentence: "Email Tanaka",
          affirm: "Send it",
        })),
      }),
    }));
    await home.score();
    expect(state.calls[0]?.last).toMatchObject({ language: "en", affirmMax: 16 });
    expect((await read("en")).items[0]).toMatchObject({
      sentence: "Email Tanaka",
      sentenceBasis: "model",
    });
    expect((await read("ja")).items[0]).toMatchObject({ sentence: null, sentenceBasis: "none" });
  });

  it("[negative] releases the sealed sentence and backs off in memory when the score cannot be stored", async () => {
    const state = await fixture();
    const { home, read, createApproval } = await state.open({}, (store) => ({
      ...store,
      recordCall: async () => {
        throw Object.assign(new Error("disk"), { code: "SQLITE_FULL" });
      },
    }));
    await createApproval("send");
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({ n, score: 1, sentence: "发邮件", affirm: "发出去" })),
      }),
    }));
    const payloads = () =>
      state.sql(
        (handle) => handle.prepare("SELECT count(*) FROM payloads").pluck().get() as number,
      );
    const before = payloads();
    expect(await home.score()).toEqual({
      attempted: 1,
      recorded: 0,
      failures: ["URGENCY_STORE_FAILED:SQLITE_FULL"],
      stoppedBy: "done",
    });
    expect(payloads()).toBe(before);
    expect(state.rows()).toEqual([]);
    expect(await home.score()).toMatchObject({ stoppedBy: "nothing_new" });
    expect(state.calls).toHaveLength(1);
    expect(keys(await read())).toEqual(["approval:send|unscored"]);
  });

  it("[negative] refuses to change or delete a score, and removes it with its approval", async () => {
    const state = await fixture();
    const { home, createApproval, recordMail, close } = await state.open();
    await createApproval("send");
    await recordMail([{ id: "a", summary: "甲" }]);
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({ n, score: 1, sentence: "发邮件", affirm: "发出去" })),
      }),
    }));
    await home.score();
    await close();
    state.sql((handle) => {
      expect(() => handle.prepare("UPDATE home_item_scores SET score = 999").run()).toThrow(
        /HOME_ITEM_SCORE_IMMUTABLE/u,
      );
      expect(() => handle.prepare("DELETE FROM home_item_scores").run()).toThrow(
        /HOME_ITEM_SCORE_IMMUTABLE/u,
      );
      handle.prepare("DELETE FROM approval_requests WHERE id = 'send'").run();
    });
    expect(state.rows().map(({ itemKey }) => itemKey)).toEqual(["insight:insight-a"]);
  });

  it("[negative] the store refuses wording on a row without an approval and a second score for the same item text", async () => {
    const state = await fixture();
    const { repository, home, recordMail } = await state.open();
    await recordMail([{ id: "a", summary: "甲" }]);
    await home.score();
    const store = repository.homeUrgency();
    const [row] = state.sql(
      (handle) =>
        handle
          .prepare("SELECT item_key AS itemKey, text_digest AS textDigest FROM home_item_scores")
          .all() as {
          itemKey: string;
          textDigest: string;
        }[],
    );
    const attempt = {
      id: "manual-1",
      invocationId: "manual",
      itemKey: row?.itemKey as string,
      textDigest: row?.textDigest as string,
      approvalRequestId: null,
      modelRef: MODEL_REF,
      promptId: "home.urgency@manual",
      dataClassification: "private" as const,
      costMicros: 0,
      durationMs: 0,
      createdAt: NOW,
    };
    await expect(
      store.recordCall({
        ...scope,
        failures: [],
        records: [
          {
            ...attempt,
            id: "manual-0",
            itemKey: "insight:fresh",
            score: 7,
            sentenceRef: null,
            affirmLabel: null,
            copyLocale: null,
          },
          { ...attempt, score: 5, sentenceRef: null, affirmLabel: null, copyLocale: null },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      store.recordCall({
        ...scope,
        failures: [],
        records: [
          {
            ...attempt,
            itemKey: "insight:other",
            score: 5,
            sentenceRef: null,
            affirmLabel: "发出去",
            copyLocale: "zh-CN",
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      store.recordCall({
        ...scope,
        failures: [],
        records: [
          {
            ...attempt,
            itemKey: "insight:other",
            score: 1001,
            sentenceRef: null,
            affirmLabel: null,
            copyLocale: null,
          },
        ],
      }),
    ).rejects.toThrow();
    expect(state.rows()).toHaveLength(1);
  });

  it.each([
    ["sensitive", null],
    ["restricted", null],
    ["private", "和田中约时间"],
    ["public", "和田中约时间"],
  ] as const)(
    "[negative] sends the conversation title of a private approval only when the title is not classified higher (title %s)",
    async (classification, expected) => {
      const state = await fixture();
      const { home, createApproval } = await state.open();
      state.setTitleClassification(classification);
      await createApproval("send");
      await home.score();
      const [call] = state.calls as [Asked];
      expect(call.dataClassification).toBe("private");
      expect(call.fresh[0]?.facts?.["conversation"]).toBe(expected);
      if (expected === null) expect(call.prompt).not.toContain("和田中约时间");
    },
  );

  it("deleting the approval's conversation removes its scores and the sealed sentence", async () => {
    const state = await fixture();
    const { home, createApproval, recordMail, close } = await state.open();
    await createApproval("send");
    await recordMail([{ id: "a", summary: "甲" }]);
    state.answerWith((call) => ({
      output: JSON.stringify({
        items: call.fresh.map(({ n }) => ({ n, score: 1, sentence: "发邮件", affirm: "发出去" })),
      }),
    }));
    await home.score();
    await close();
    const sentenceRef = state.rows().find(({ sentenceRef }) => sentenceRef !== null)?.sentenceRef;
    expect(sentenceRef).toBeTruthy();
    const deletion = await new SqliteGovernedDeletionAdapter({
      stateRoot: state.deletionRoot,
      databasePath: state.databasePath,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      now: () => NOW,
    }).deleteImmediately({ objectType: "thread", objectId: THREAD_ID });
    expect(deletion.lifecycle).toBe("deleted_verified");
    expect(state.rows().map(({ itemKey }) => itemKey)).toEqual(["insight:insight-a"]);
    expect(
      state.sql((handle) =>
        handle.prepare("SELECT COUNT(*) FROM payloads WHERE ref = ?").pluck().get(sentenceRef),
      ),
    ).toBe(0);
  });

  it("releases the prompt and the reply once the call is over", async () => {
    const state = await fixture();
    const { home, recordMail } = await state.open();
    await recordMail([{ id: "a", summary: "甲" }]);
    await home.score();
    expect(state.released.filter((ref) => ref.startsWith("in-"))).toHaveLength(1);
    expect(state.released.filter((ref) => ref.startsWith("out-"))).toHaveLength(1);
  });

  it("releases the prompt when the model call fails", async () => {
    const state = await fixture();
    const { home, recordMail } = await state.open();
    await recordMail([{ id: "a", summary: "甲" }]);
    state.answerWith(() => ({ fail: "MODEL_DOWN" }));
    await home.score();
    expect(state.released.filter((ref) => ref.startsWith("in-"))).toHaveLength(1);
  });

  it("[negative] approvalCopy drops a stored sentence that would not pass the reply checks", async () => {
    const state = await fixture();
    const { home, repository, seal, createApproval } = await state.open();
    await createApproval("send");
    const sentenceRef = await seal.seal({
      ...scope,
      text: "发\u202E出去",
      at: NOW,
      dataClassification: "private",
    });
    await repository.homeUrgency().recordCall({
      ...scope,
      failures: [],
      records: [
        {
          id: "manual-copy",
          invocationId: "manual-copy",
          itemKey: "approval:send",
          textDigest: createHash("sha256").update("hash-send").digest("hex"),
          approvalRequestId: "send",
          modelRef: MODEL_REF,
          promptId: "home.urgency@manual",
          dataClassification: "private",
          costMicros: 0,
          durationMs: 0,
          createdAt: NOW,
          score: 5,
          sentenceRef,
          affirmLabel: "发出去",
          copyLocale: "zh-CN",
        },
      ],
    });
    expect(
      await home.approvalCopy({
        approvalRequestId: "send",
        semanticSnapshotHash: "hash-send",
        locale: "zh-CN",
      }),
    ).toEqual({ sentence: null, affirmLabel: "发出去" });
  });

  it("stopping waits for a scoring call already under way", async () => {
    const state = await fixture();
    const { home, recordMail } = await state.open();
    await recordMail([{ id: "a", summary: "甲" }]);
    void home.score();
    await home.stopScoring();
    expect(state.results).toHaveLength(1);
    expect(state.calls).toHaveLength(1);
  });

  it("[negative] reads the scores of more open items than the store takes in one read", async () => {
    const state = await fixture();
    const { repository, model, seal } = await state.open();
    const many = Array.from({ length: HOME_URGENCY_ITEMS_PER_READ + 1 }, (_, index) => ({
      key: `insight:filler-${index}`,
      digestBasis: `filler-${index}`,
    }));
    const service = new HomeUrgencyService({
      scope,
      store: repository.homeUrgency(),
      seal,
      model,
      modelAllows: () => true,
      settings: DEFAULT_HOME_URGENCY,
      timeZone: "Asia/Tokyo",
      clock: { now: () => NOW },
      digest: (text) => createHash("sha256").update(text).digest("hex"),
      estimateCostMicros: () => 0,
      candidates: async () => [],
      locale: async () => "zh-CN",
    });
    await expect(service.scores(many)).resolves.toEqual(new Map());
    const edges = [many[0], many[HOME_URGENCY_ITEMS_PER_READ]].map((item, index) => ({
      id: `edge-${index}`,
      invocationId: "edge",
      itemKey: item?.key as string,
      textDigest: createHash("sha256")
        .update(item?.digestBasis as string)
        .digest("hex"),
      approvalRequestId: null,
      modelRef: MODEL_REF,
      promptId: "home.urgency@edge",
      dataClassification: "private" as const,
      costMicros: 0,
      durationMs: 0,
      createdAt: NOW,
      score: 100 + index,
      sentenceRef: null,
      affirmLabel: null,
      copyLocale: null,
    }));
    await repository.homeUrgency().recordCall({ ...scope, failures: [], records: edges });
    expect([...(await service.scores(many)).entries()]).toEqual([
      [many[0]?.key, 100],
      [many[HOME_URGENCY_ITEMS_PER_READ]?.key, 101],
    ]);
    await expect(
      repository.homeUrgency().listScores({
        ...scope,
        items: many.map(({ key }) => ({ itemKey: key, textDigest: "0".repeat(64) })),
      }),
    ).rejects.toThrow();
  });

  it("meters the new purpose, and every contract value has a place in the table or the ranking", async () => {
    const state = await fixture();
    state.sql((handle) => {
      const insert = handle.prepare(
        `INSERT INTO model_usage_observations (
          owner_id, agent_id, run_id, invocation_id, purpose, source, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_reported,
          occurred_at
        ) VALUES (?, ?, 'run', ?, ?, 'model-port', 'p', 'm', 1, 1, 0, 0, 0, ?)`,
      );
      for (const purpose of MODEL_USAGE_PURPOSES)
        insert.run(OWNER_ID, AGENT_ID, `invocation-${purpose}`, purpose, NOW);
      expect(() =>
        insert.run(OWNER_ID, AGENT_ID, "invocation-unknown", "home-something", NOW),
      ).toThrow(/CHECK/u);
    });
    expect(MODEL_USAGE_PURPOSES).toContain("home-urgency");
    expect(HOME_RANKS).toContain("model");
    expect(HOME_SENTENCE_BASES).toContain("model");
    expect(HOME_LABEL_BASES).toContain("model");
  });
});
