import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProactiveSeal,
  type ModelInvocationEvent,
  type ProactiveHistoryReader,
  type ProactiveModelInvoker,
  type ProactiveSourceItem,
  ProactiveReplayService,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import { gatewayV2MessageSchema, type GatewayV2Command } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  DeterministicIdGenerator,
  DeterministicPayloadProtector,
  ManualClock,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionProactive } from "../../apps/agent-service/src/production-proactive.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-proactive-replay");
const AGENT_ID = createAgentId("agent-proactive-replay");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-07T10:00:00.000Z";
const FROM = "2025-11-01T00:00:00.000Z";
const TO = "2025-12-01T00:00:00.000Z";

function mail(id: string, subject: string, receivedAt: string, extra = {}): ProactiveSourceItem {
  return Object.freeze({
    source: "gmail" as const,
    messageId: id,
    threadId: `thread-${id}`,
    from: "Shop <news@shop.example>",
    fromAddress: "news@shop.example",
    subject,
    snippet: subject,
    link: `https://mail.google.com/mail/u/0/#all/thread-${id}`,
    receivedAt,
    categories: [],
    sentByOwner: false,
    body: subject,
    bodyTruncated: false,
    bodyUnavailable: false,
    attachments: [],
    ...extra,
  });
}

const MAILS = [
  mail("m-bill", "請求書 11/5 まで", "2025-11-03T00:00:00.000Z"),
  mail("m-news", "週刊ニュース", "2025-11-04T00:00:00.000Z"),
  mail("m-spam", "セール", "2025-11-05T00:00:00.000Z", { categories: ["spam"] }),
  mail("m-late", "最終確認", "2025-11-06T00:00:00.000Z"),
];

describe("[PR-1] replaying past mail through the proactive judgment", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(
    options: { failAfter?: number; mails?: ProactiveSourceItem[]; gate?: Promise<void> } = {},
  ) {
    const mails = options.mails ?? MAILS;
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-proactive-replay-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = new ManualClock(NOW);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    closers.push(() => repository.close());
    const ids = new DeterministicIdGenerator();
    const store = repository.proactive();
    const replays = repository.proactiveReplays();
    const protector = new DeterministicPayloadProtector();
    const payloadStore = repository.payloadStore(OWNER_ID, AGENT_ID);
    const seal = createProactiveSeal({ payloads: payloadStore, protector, ids });
    await store.writeSettings({
      ...scope,
      enabled: true,
      quietHours: [],
      importantSenders: [],
      now: NOW,
    });
    await store.saveConnection({
      ...scope,
      connection: {
        source: "gmail",
        accountRef: await seal.seal({ ...scope, text: "andy@example.com", at: NOW }),
        tokenRef: await seal.seal({ ...scope, text: "refresh-1", at: NOW }),
        cursor: "777",
        status: "connected",
        connectedAt: NOW,
        updatedAt: NOW,
      },
    });
    const prompts: string[] = [];
    const outputs = new Map<string, string>();
    let calls = 0;
    const write = async (ref: string, content: string) => {
      await payloadStore.put(
        await protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification: "private",
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(content),
          createdAt: NOW,
        }),
      );
    };
    const read = async (ref: string) => {
      const payload = await payloadStore.get(ref);
      return payload ? new TextDecoder().decode(await protector.unprotect({ payload })) : "";
    };
    const model: ProactiveModelInvoker = {
      model: {
        async *invoke(request: {
          invocationId: string;
          inputRef: string;
        }): AsyncGenerator<ModelInvocationEvent, void> {
          calls += 1;
          const prompt = await read(request.inputRef);
          const id = [...prompt.matchAll(/"id":"(m-[^"]+)"/gu)].at(-1)?.[1] ?? "";
          if (options.failAfter !== undefined && calls > options.failAfter) {
            yield {
              type: "model.failed",
              invocationId: request.invocationId,
              errorCode: "BOOM",
              occurredAt: NOW,
            } as unknown as ModelInvocationEvent;
            return;
          }
          const ref = `output-${request.invocationId}`;
          outputs.set(
            ref,
            JSON.stringify({
              items: [
                id === "m-bill"
                  ? {
                      id,
                      result: "act",
                      confidence: "sure",
                      todo: "11/5 までに支払う",
                      priority: "high",
                      dueAt: "2025-11-05T14:59:00.000Z",
                      reason: "",
                    }
                  : { id, result: "ignore", confidence: "sure", todo: "", reason: "" },
              ],
            }),
          );
          await write(ref, outputs.get(ref) ?? "");
          yield {
            type: "model.output",
            invocationId: request.invocationId,
            sequence: 1,
            payloadRef: ref,
            occurredAt: NOW,
          } as ModelInvocationEvent;
          yield {
            type: "model.completed",
            invocationId: request.invocationId,
            inputTokens: 100,
            outputTokens: 20,
            costMicros: 400,
            latencyMs: 1,
            occurredAt: NOW,
          } as ModelInvocationEvent;
        },
      } as never,
      modelRef: "replay-model",
      async prepare({ invocationId, prompt }) {
        prompts.push(prompt);
        const inputRef = `input-${invocationId}`;
        await write(inputRef, prompt);
        return {
          runId: `proactive:${invocationId}` as never,
          inputRef,
          allowedDisclosureRef: inputRef,
          secretHandleRefs: [],
          release: async () => undefined,
        };
      },
      readOutput: read,
      release: async (refs) => {
        for (const ref of refs) await payloadStore.delete(ref);
      },
    };
    const listed: { from: string; to: string; limit: number }[] = [];
    const history: ProactiveHistoryReader = {
      source: "gmail",
      async list(input) {
        await options.gate;
        listed.push({ from: input.from, to: input.to, limit: input.limit });
        return { kind: "ids", ids: mails.map(({ messageId }) => messageId).slice(0, input.limit) };
      },
      async read({ messageIds }) {
        return {
          kind: "items",
          items: mails.filter(({ messageId }) => messageIds.includes(messageId)),
        };
      },
    };
    const service = new ProactiveReplayService({
      scope,
      store,
      replays,
      seal,
      history,
      model,
      perCheckMs: 60_000,
      estimateCostMicros: () => 100,
      timeZone: "Asia/Tokyo",
      clock,
      ids,
    });
    const count = (table: string) => (repository as unknown as { count?: never }).count ?? table;
    return {
      service,
      replays,
      store,
      seal,
      prompts,
      listed,
      repository,
      payloadStore,
      count,
      clock,
      model,
      history,
    };
  }

  async function results(h: Awaited<ReturnType<typeof setup>>, runId: string) {
    return h.replays.listResults({ ...scope, runId, afterMessageId: null, limit: 50 });
  }

  it("judges each past mail as of when it arrived and keeps the live ledger untouched", async () => {
    const h = await setup();
    const { runId, done } = await h.service.start({
      from: FROM,
      to: TO,
      mailLimit: 10,
      budgetMicros: 100_000,
    });
    await done;
    const run = await h.replays.readRun({ ...scope, runId });
    expect(run).toMatchObject({
      status: "finished",
      reasonCode: "COMPLETED",
      listed: 4,
      judged: 4,
      costMicros: 1200,
    });
    const rows = await results(h, runId);
    expect(rows.map(({ messageId, outcome }) => [messageId, outcome])).toEqual([
      ["m-bill", "act"],
      ["m-late", "ignore"],
      ["m-news", "ignore"],
      ["m-spam", "skipped"],
    ]);
    expect(rows.find(({ messageId }) => messageId === "m-bill")).toMatchObject({
      push: false,
      priority: "high",
    });
    expect(rows.find(({ messageId }) => messageId === "m-spam")).toMatchObject({
      reasonCode: "category",
      contentRef: null,
    });
    expect(h.prompts).toHaveLength(3);
    expect(h.prompts[0]).toContain("2025-11-03");
    expect(h.prompts[0]).not.toContain("2026-11-07");
    expect(
      await h.store.unprocessed({ ...scope, source: "gmail", messageIds: ["m-bill"] }),
    ).toEqual(["m-bill"]);
    expect(
      await h.store.listDecisions({ ...scope, since: "2000-01-01T00:00:00.000Z", limit: 10 }),
    ).toEqual([]);
    expect(
      await h.store.listInsights({ ...scope, statuses: ["open", "done", "muted", "replied"] }),
    ).toEqual([]);
    expect((await h.store.readConnection({ ...scope, source: "gmail" }))?.cursor).toBe("777");
  });

  it("stops when the budget is reached and records the reason", async () => {
    const h = await setup();
    const { runId, done } = await h.service.start({
      from: FROM,
      to: TO,
      mailLimit: 10,
      budgetMicros: 450,
    });
    await done;
    expect(await h.replays.readRun({ ...scope, runId })).toMatchObject({
      status: "finished",
      reasonCode: "BUDGET_REACHED",
      judged: 1,
      costMicros: 400,
    });
  });

  it("stops after repeated model failures and allows only one running replay", async () => {
    const h = await setup({ failAfter: 0 });
    const first = await h.service.start({
      from: FROM,
      to: TO,
      mailLimit: 10,
      budgetMicros: 100_000,
    });
    await expect(
      h.service.start({ from: FROM, to: TO, mailLimit: 10, budgetMicros: 100_000 }),
    ).rejects.toMatchObject({ message: "PROACTIVE_REPLAY_ALREADY_RUNNING" });
    await first.done;
    expect(await h.replays.readRun({ ...scope, runId: first.runId })).toMatchObject({
      status: "failed",
      reasonCode: "REPEATED_FAILURES",
    });
    expect(
      (await results(h, first.runId))
        .filter(({ outcome }) => outcome !== "skipped")
        .every(({ outcome }) => outcome === "failed"),
    ).toBe(true);
  });

  it("rejects ranges in the future, empty ranges and oversized limits", async () => {
    const h = await setup();
    for (const request of [
      { from: FROM, to: "2026-12-01T00:00:00.000Z", mailLimit: 10, budgetMicros: 1000 },
      { from: TO, to: FROM, mailLimit: 10, budgetMicros: 1000 },
      { from: FROM, to: TO, mailLimit: 2001, budgetMicros: 1000 },
      { from: FROM, to: TO, mailLimit: 10, budgetMicros: 5_000_001 },
    ])
      await expect(h.service.start(request)).rejects.toMatchObject({
        message: "PROACTIVE_REPLAY_INVALID",
      });
    expect(h.listed).toEqual([]);
  });

  it("deleting a run releases its sealed text", async () => {
    const h = await setup();
    const { runId, done } = await h.service.start({
      from: FROM,
      to: TO,
      mailLimit: 1,
      budgetMicros: 100_000,
    });
    await done;
    const [only] = await results(h, runId);
    expect(only?.contentRef).not.toBeNull();
    const refs = await h.replays.deleteRun({ ...scope, runId });
    expect(refs).toEqual([only?.contentRef]);
    expect(await h.replays.readRun({ ...scope, runId })).toBeUndefined();
    expect(await h.service.interruptStale()).toBe(0);
  });

  it("marks a run left running by a restart as interrupted", async () => {
    const h = await setup();
    expect(
      await h.replays.startRun({
        ...scope,
        id: "stale-run",
        source: "gmail",
        rangeFrom: FROM,
        rangeTo: TO,
        mailLimit: 5,
        budgetMicros: 1000,
        now: NOW,
      }),
    ).toBe(true);
    expect(await h.service.interruptStale()).toBe(1);
    expect(await h.replays.readRun({ ...scope, runId: "stale-run" })).toMatchObject({
      status: "interrupted",
      reasonCode: "SERVICE_RESTARTED",
    });
    expect(await h.service.interruptStale()).toBe(0);
  });

  it("removes replay results and releases their text when proactive records are cleared", async () => {
    const h = await setup();
    const { runId, done } = await h.service.start({
      from: FROM,
      to: TO,
      mailLimit: 1,
      budgetMicros: 100_000,
    });
    await done;
    const [only] = await results(h, runId);
    const released = await h.store.clearRecords(scope);
    expect(released).toContain(only?.contentRef);
    expect(await h.replays.readRun({ ...scope, runId })).toBeUndefined();
  });

  it("drops mail outside the asked range even if the source returns it", async () => {
    const h = await setup({
      mails: [
        mail("m-in", "範囲内", "2025-11-10T00:00:00.000Z"),
        mail("m-before", "範囲外の前", "2025-10-31T23:59:59.000Z"),
        mail("m-after", "範囲外の後", "2025-12-01T00:00:00.000Z"),
      ],
    });
    const { runId, done } = await h.service.start({
      from: FROM,
      to: TO,
      mailLimit: 10,
      budgetMicros: 100_000,
    });
    await done;
    expect((await results(h, runId)).map(({ messageId }) => messageId)).toEqual(["m-in"]);
  });

  it("releases the sealed text when the stored result cannot be written", async () => {
    const h = await setup({
      mails: [mail("m-bill", "請求書 11/5 まで", "2025-11-03T00:00:00.000Z")],
    });
    const released: string[] = [];
    const release = h.seal.release.bind(h.seal);
    const failing = new ProactiveReplayService({
      scope,
      store: h.store,
      replays: { ...h.replays, recordResult: async () => Promise.reject(new Error("DISK_FULL")) },
      seal: {
        ...h.seal,
        release: async (input) => {
          released.push(...input.refs);
          await release(input);
        },
      },
      history: h.history,
      model: h.model,
      perCheckMs: 60_000,
      estimateCostMicros: () => 100,
      timeZone: "Asia/Tokyo",
      clock: h.clock,
      ids: new DeterministicIdGenerator(),
    });
    const { runId, done } = await failing.start({
      from: FROM,
      to: TO,
      mailLimit: 10,
      budgetMicros: 100_000,
    });
    await done;
    expect(released.length).toBeGreaterThan(0);
    expect(await h.replays.readRun({ ...scope, runId })).toMatchObject({
      status: "failed",
      reasonCode: "REPLAY_ERROR",
    });
  });

  it("stops a running replay on cancel and marks it interrupted", async () => {
    const h = await setup();
    const { runId, done } = await h.service.start({
      from: FROM,
      to: TO,
      mailLimit: 10,
      budgetMicros: 100_000,
    });
    await h.service.cancel();
    await done;
    expect(await h.replays.readRun({ ...scope, runId })).toMatchObject({
      status: "interrupted",
      reasonCode: "SERVICE_STOPPING",
    });
  });

  it("deleting a run through the service also removes the sealed text itself", async () => {
    const h = await setup();
    const { runId, done } = await h.service.start({
      from: FROM,
      to: TO,
      mailLimit: 1,
      budgetMicros: 100_000,
    });
    await done;
    const [only] = await results(h, runId);
    expect(await h.payloadStore.get(only?.contentRef ?? "")).toBeDefined();
    await h.service.deleteRun(runId);
    expect(await h.payloadStore.get(only?.contentRef ?? "")).toBeUndefined();
  });

  it("never reports masked values from replayed mail to the live sensitive-interception log", async () => {
    const h = await setup({
      mails: [
        mail("m-card", "カード 4111 1111 1111 1111 のご利用", "2025-11-03T00:00:00.000Z", {
          body: "カード番号 4111 1111 1111 1111 暗証番号 パスワード: hunter2hunter2",
        }),
      ],
    });
    const masked: unknown[] = [];
    const proactive = new ProductionProactive({
      scope,
      configuration: {
        modelRef: "replay-model",
        gmail: { clientId: "client-1", clientSecretRef: "google-oauth" },
        intervalMs: 900_000,
        perCheckMs: 60_000,
        dailyCostMicros: 1_000_000,
        bodyCharactersPerMail: 16_000,
        bodyCharactersPerBatch: 64_000,
        memoryMinimumSimilarity: 0.45,
        reviewBudgetSeconds: 120,
        reviewSecondsPerItem: 5,
      },
      timeZone: "Asia/Tokyo",
      store: h.store,
      seal: h.seal,
      oauth: {} as never,
      reader: { source: "gmail", fetch: async () => ({ kind: "failed", step: "none" }) },
      readAccount: async () => "andy@example.com",
      model: h.model,
      ledger: {} as never,
      readMemoryText: async () => undefined,
      estimateCostMicros: () => 100,
      feedback: async () => [],
      clock: h.clock,
      ids: new DeterministicIdGenerator(),
      onFailure: (error) => {
        throw error;
      },
      onMasked: (sightings) => masked.push(...sightings),
      replays: h.replays,
      history: h.history,
    });
    const command = gatewayV2MessageSchema.parse({
      schemaVersion: "gateway.v2",
      kind: "command",
      type: "proactive.replay.start",
      messageId: "message-replay",
      correlationId: "correlation-replay",
      causationId: null,
      dataClassification: "private",
      risk: "low",
      authorizationRef: "authorization-01",
      scope,
      authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType: "owner", actorId: "owner-subject" },
      idempotencyKey: "idempotency-replay",
      payload: { from: FROM, to: TO, mailLimit: 5, budgetMicros: 100_000 },
    }) as GatewayV2Command;
    const { resultRef } = await proactive.execute(command);
    const runId = resultRef.replace("proactive-replay:", "");
    for (let wait = 0; wait < 100; wait += 1) {
      const run = await h.replays.readRun({ ...scope, runId });
      if (run && run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await h.replays.readRun({ ...scope, runId })).toMatchObject({ status: "finished" });
    expect(h.prompts.join("\n")).not.toContain("4111 1111 1111 1111");
    expect(masked).toEqual([]);
  });

  it("keeps a stop request when a second start is refused, and refuses new starts after stop", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const h = await setup({ gate });
    const request = { from: FROM, to: TO, mailLimit: 10, budgetMicros: 100_000 };
    const first = await h.service.start(request);
    await expect(h.service.start(request)).rejects.toMatchObject({
      message: "PROACTIVE_REPLAY_ALREADY_RUNNING",
    });
    const stopping = h.service.cancel();
    await expect(h.service.start(request)).rejects.toMatchObject({
      message: "PROACTIVE_REPLAY_STOPPING",
    });
    open();
    await stopping;
    await first.done;
    expect(await h.replays.readRun({ ...scope, runId: first.runId })).toMatchObject({
      status: "interrupted",
      reasonCode: "SERVICE_STOPPING",
      judged: 0,
    });
  });
});
