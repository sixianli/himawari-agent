import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApplicationPortError,
  createProactiveSeal,
  type DataClassification,
  DEFAULT_REVIEW_PREREVIEW,
  type ModelInvocationEvent,
  type ModelInvocationRequest,
  type ProactiveModelInvoker,
  prereviewAuditPicked,
  type ReviewPrereviewConfiguration,
  type ReviewPrereviewStorePort,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  createGmailReader,
  createGoogleOAuth,
  readGmailAccount,
} from "@himawari-agent/platform-node";
import {
  DeterministicIdGenerator,
  DeterministicPayloadProtector,
  ManualClock,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionProactive } from "../../apps/agent-service/src/production-proactive.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-prereview");
const AGENT_ID = createAgentId("agent-prereview");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOV_4_10AM_JST = "2026-11-04T01:00:00.000Z";
const MODEL_REF = "prereview-model";
const DAY_MS = 86_400_000;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Settings = Partial<Omit<ReviewPrereviewConfiguration, "reduction">> & {
  readonly reduction?: Partial<ReviewPrereviewConfiguration["reduction"]>;
};

function reply(prompt: string): { output: string; costMicros: number } {
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as { text: string };
  if (data.text.includes("down")) return { output: "MODEL_DOWN", costMicros: 0 };
  if (data.text.includes("broken")) return { output: "not a rating", costMicros: 700 };
  if (data.text.includes("unsure"))
    return { output: '{"rating":"unsure","confidence":0}', costMicros: 300 };
  if (data.text.includes("drop"))
    return { output: '{"rating":"missed","confidence":950}', costMicros: 300 };
  return { output: '{"rating":"useful","confidence":950}', costMicros: 300 };
}

describe("[P4-8] model pre-rating in the running service", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-prereview-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = new ManualClock(NOV_4_10AM_JST);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    closers.push(() => repository.close());
    const raw = openQualifiedDatabase(databasePath);
    closers.push(async () => {
      raw.close();
    });
    const ids = new DeterministicIdGenerator();
    const store = repository.proactive();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const protector = new DeterministicPayloadProtector();
    const seal = createProactiveSeal({ payloads, protector, ids });
    const fetch = async () => new Response("{}", { status: 500 });
    const oauth = createGoogleOAuth({
      clientId: "client-1",
      clientSecret: "test-secret",
      redirectUri: "https://himawari.example/callback",
      fetch,
    });
    const texts = new Map<string, string>();
    const classifications = new Map<string, DataClassification>();
    const prompts: string[] = [];
    const outputs = new Map<string, string>();
    const costs = new Map<string, number>();
    const invocations: string[] = [];
    const reads: string[] = [];
    const released: string[] = [];
    const releaseFails = { input: false, output: false };
    const allowed: DataClassification[] = ["public", "private", "sensitive", "restricted"];
    const model: ProactiveModelInvoker = {
      modelRef: MODEL_REF,
      allowedDataClassifications: allowed,
      model: {
        async *invoke(request: ModelInvocationRequest): AsyncIterable<ModelInvocationEvent> {
          invocations.push(request.invocationId);
          const at = clock.now();
          yield { type: "model.started", invocationId: request.invocationId, occurredAt: at };
          yield {
            type: "model.output",
            invocationId: request.invocationId,
            sequence: 1,
            payloadRef: `out-${request.invocationId}`,
            occurredAt: at,
          };
          if (outputs.get(`out-${request.invocationId}`) === "MODEL_DOWN") {
            yield {
              type: "model.failed",
              invocationId: request.invocationId,
              errorCode: "PROVIDER_DOWN",
              retryable: true,
              latencyMs: 5,
              occurredAt: at,
            };
            return;
          }
          yield {
            type: "model.completed",
            invocationId: request.invocationId,
            inputTokens: 200,
            outputTokens: 10,
            costMicros: costs.get(request.invocationId) ?? 0,
            latencyMs: 5,
            occurredAt: at,
          };
        },
      } as unknown as ProactiveModelInvoker["model"],
      async prepare({ invocationId, prompt }) {
        prompts.push(prompt);
        const answer = reply(prompt);
        outputs.set(`out-${invocationId}`, answer.output);
        costs.set(invocationId, answer.costMicros);
        return {
          runId: `prereview:${invocationId}` as never,
          inputRef: `in-${invocationId}`,
          allowedDisclosureRef: `in-${invocationId}`,
          secretHandleRefs: [],
          release: async () => undefined,
        };
      },
      readOutput: async (ref) => outputs.get(ref) ?? "",
      release: async (refs) => {
        for (const ref of refs) {
          if (releaseFails.input && ref.startsWith("in-")) throw new Error("EIO");
          if (releaseFails.output && ref.startsWith("out-")) throw new Error("EIO");
          released.push(ref);
        }
      },
    };
    const failures: unknown[] = [];
    const ledger = repository.decisionLedger();
    const service = (
      settings: Settings = {},
      wrapStore: (store: ReviewPrereviewStorePort) => ReviewPrereviewStorePort = (store) => store,
    ) =>
      new ProductionProactive({
        scope,
        configuration: {
          modelRef: MODEL_REF,
          gmail: { clientId: "client-1", clientSecretRef: "google-oauth" },
          intervalMs: 900_000,
          perCheckMs: 180_000,
          dailyCostMicros: 1_000_000,
          bodyCharactersPerMail: 16_000,
          bodyCharactersPerBatch: 64_000,
          relatedMailsPerMail: 6,
          relatedCharactersPerMail: 12_000,
          relatedCharactersPerRelatedMail: 2_000,
          relatedRequestsPerCheck: 300,
          wholeThreadMailsPerMail: 50,
          wholeThreadCharactersPerMail: 60_000,
          ruleReplayDays: 30,
          ruleReplayMailsPerOutcome: 300,
          memoryMinimumSimilarity: 0.45,
          reviewBudgetSeconds: 600,
          reviewSecondsPerItem: 5,
          reviewSilentSharePermille: 500,
          reviewPrereview: {
            ...DEFAULT_REVIEW_PREREVIEW,
            ...settings,
            reduction: { ...DEFAULT_REVIEW_PREREVIEW.reduction, ...settings.reduction },
          },
          reviewMemoryUnusedDays: 90,
        },
        timeZone: "Asia/Tokyo",
        store,
        seal,
        oauth,
        reader: createGmailReader({ oauth, fetch }),
        readAccount: (accessToken) => readGmailAccount({ accessToken, fetch }),
        ledger,
        readMemoryText: async (ref) => {
          reads.push(ref);
          return texts.get(ref);
        },
        readMemoryClassification: async (ref) => classifications.get(ref),
        prereview: {
          store: wrapStore(repository.reviewPrereview()),
          model,
          digest: sha256,
          estimateCostMicros: () => 100,
        },
        model,
        estimateCostMicros: () => 100,
        feedback: async () => [],
        clock,
        ids,
        onFailure: (error) => failures.push(error),
      });
    const skipped = async (
      id: string,
      text: string | null,
      decidedAt: string,
      reasonCode = "transient_ignored",
      classification: DataClassification = "private",
    ) => {
      const ref = text === null ? null : `memory-${id}`;
      if (ref !== null && text !== null) {
        texts.set(ref, text);
        classifications.set(ref, classification);
        await payloads.put(
          await protector.protect({
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            ref,
            dataClassification: classification,
            contentType: "text/plain",
            plaintext: new TextEncoder().encode(text),
            createdAt: clock.now(),
          }),
        );
      }
      await ledger.append({
        id,
        ...scope,
        kind: "memory_candidate",
        decidedAt,
        outcome: "discarded",
        reasonCode,
        subjectRef: `subject-${id}`,
        inputs: { memoryIds: [], ruleIds: [] },
        reasonRef: null,
        contentRef: ref,
        costMicros: 0,
        durationMs: 0,
        category: "preference",
        confidencePermille: 500,
        inferred: false,
      });
    };
    const rows = () =>
      raw
        .prepare(
          `SELECT decision_id AS decisionId, status, rating, confidence_permille AS confidence,
            failure_code AS failureCode, cost_micros AS costMicros, text_digest AS digest,
            created_at AS createdAt
          FROM decision_prereviews ORDER BY created_at, id`,
        )
        .all() as {
        decisionId: string;
        status: string;
        rating: string | null;
        confidence: number | null;
        failureCode: string | null;
        costMicros: number;
        digest: string;
        createdAt: string;
      }[];
    return {
      allowed,
      clock,
      failures,
      invocations,
      ledger,
      prompts,
      raw,
      reads,
      released,
      releaseFails,
      rows,
      service,
      skipped,
      store,
      texts,
    };
  }

  it("[P4-8] pre-rates waiting decisions into their own table and never sends or changes the owner's rating", async () => {
    const h = await setup();
    const twoDaysAgo = new Date(Date.parse(NOV_4_10AM_JST) - 2 * DAY_MS).toISOString();
    await h.skipped("rated-earlier", "我上周说想换工作 drop", twoDaysAgo);
    await h.ledger.rate({
      ...scope,
      decisionId: "rated-earlier",
      rating: "missed",
      now: twoDaysAgo,
    });
    await h.skipped("fresh", "我最近想吃牛肉", NOV_4_10AM_JST);
    await h.skipped("restricted", null, NOV_4_10AM_JST, "restricted_excluded");

    const proactive = h.service();
    const result = await proactive.prereview();

    expect(result).toMatchObject({ attempted: 2, recorded: 2, failures: [], stoppedBy: "done" });
    expect(h.rows().map(({ decisionId, status, rating }) => [decisionId, status, rating])).toEqual(
      expect.arrayContaining([
        ["rated-earlier", "done", "missed"],
        ["fresh", "done", "useful"],
      ]),
    );
    expect(h.rows().some(({ decisionId }) => decisionId === "restricted")).toBe(false);
    for (const prompt of h.prompts) {
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(data).sort()).toEqual(["category", "group", "options", "text"]);
    }
    expect((await h.ledger.read({ ...scope, decisionId: "fresh" }))?.entry.ownerRating).toBeNull();
    expect(
      (await h.ledger.read({ ...scope, decisionId: "rated-earlier" }))?.entry.ownerRating,
    ).toBe("missed");

    await h.ledger.rate({ ...scope, decisionId: "fresh", rating: "missed", now: h.clock.now() });
    expect(h.rows().find(({ decisionId }) => decisionId === "fresh")?.rating).toBe("useful");
    expect((await h.ledger.read({ ...scope, decisionId: "fresh" }))?.entry.ownerRating).toBe(
      "missed",
    );

    expect(await proactive.prereview()).toMatchObject({ attempted: 0, recorded: 0 });
    expect(h.failures).toEqual([]);
  });

  it("[P4-8] releases the prompt and the reply of every pre-rating call, even when the model fails or one release fails", async () => {
    const h = await setup();
    await h.skipped("kept", "我最近想吃牛肉", NOV_4_10AM_JST);
    await h.skipped("broken", "broken reply", NOV_4_10AM_JST);
    await h.skipped("down", "provider down", NOV_4_10AM_JST);
    h.releaseFails.input = true;

    expect(await h.service().prereview()).toMatchObject({ attempted: 3, recorded: 1 });

    expect(h.invocations).toHaveLength(3);
    expect([...h.released].sort()).toEqual(h.invocations.map((id) => `out-${id}`).sort());
    h.releaseFails.input = false;
    await h.skipped("later", "想记住的事", NOV_4_10AM_JST);
    await h.service().prereview();
    const last = h.invocations.at(-1);
    expect(h.released.slice(-2).sort()).toEqual([`in-${last}`, `out-${last}`]);
    h.releaseFails.output = true;
    await h.skipped("output-stuck", "想买一本书", NOV_4_10AM_JST);
    await h.service().prereview();
    expect(h.released.at(-1)).toBe(`in-${h.invocations.at(-1)}`);
  });

  it("[P4-8] skips subjects the pre-rating model may not receive, sends nothing for them and keeps their slot free", async () => {
    const h = await setup();
    h.allowed.splice(0, h.allowed.length, "public", "private");
    await h.skipped("secret-a", "想记住私密的 A", NOV_4_10AM_JST, "transient_ignored", "sensitive");
    await h.skipped("secret-b", "想记住私密的 B", NOV_4_10AM_JST, "transient_ignored", "sensitive");
    await h.skipped("plain", "我最近想吃牛肉", NOV_4_10AM_JST);

    const result = await h.service().prereview();

    expect(result).toMatchObject({
      attempted: 1,
      recorded: 1,
      failures: [],
      skippedClassification: 2,
      stoppedBy: "done",
    });
    expect(h.invocations).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts.join("\n")).not.toContain("私密");
    expect(h.rows().map(({ decisionId }) => decisionId)).toEqual(["plain"]);
    h.allowed.push("sensitive");
    const again = await h.service().prereview();
    expect(again).toMatchObject({ attempted: 2, recorded: 2, skippedClassification: 0 });
    expect(
      h
        .rows()
        .map(({ decisionId }) => decisionId)
        .sort(),
    ).toEqual(["plain", "secret-a", "secret-b"]);
  });

  it("[P4-8] skipped subjects do not take the per-run slot and are not built again while still disallowed", async () => {
    const h = await setup();
    h.allowed.splice(0, h.allowed.length, "public", "private");
    await h.skipped("a-secret", "想记住私密的 A", NOV_4_10AM_JST, "transient_ignored", "sensitive");
    await h.skipped("plain", "我最近想吃牛肉", NOV_4_10AM_JST);
    const service = h.service({ perRun: 1 });
    expect(await service.prereview()).toMatchObject({
      attempted: 1,
      recorded: 1,
      skippedClassification: 1,
      stoppedBy: "done",
    });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts.join("\n")).not.toContain("私密");
    const reads = () => h.reads.filter((ref) => ref === "memory-a-secret").length;
    expect(reads()).toBe(1);
    expect(await service.prereview()).toMatchObject({ attempted: 0, skippedClassification: 1 });
    expect(reads()).toBe(1);
  });

  it("[P4-8][reverse] subjects the model may receive are never skipped", async () => {
    const h = await setup();
    await h.skipped("secret-a", "想记住私密的 A", NOV_4_10AM_JST, "transient_ignored", "sensitive");
    await h.skipped("plain", "我最近想吃牛肉", NOV_4_10AM_JST);
    expect(await h.service().prereview()).toMatchObject({
      attempted: 2,
      recorded: 2,
      skippedClassification: 0,
    });
  });

  it("[P4-8] keeps the daily cap across a restart and starts again the next day", async () => {
    const h = await setup();
    for (let index = 0; index < 5; index += 1)
      await h.skipped(`cap-${index}`, `想买第 ${index} 本书`, NOV_4_10AM_JST);

    expect(await h.service({ dailyLimit: 3 }).prereview()).toMatchObject({
      attempted: 3,
      stoppedBy: "daily_limit",
    });
    const restarted = h.service({ dailyLimit: 3 });
    expect(await restarted.prereview()).toMatchObject({ attempted: 0, stoppedBy: "daily_limit" });
    expect(h.rows()).toHaveLength(3);

    h.clock.advance(DAY_MS);
    expect(await restarted.prereview()).toMatchObject({ attempted: 2, recorded: 2 });
    expect(h.rows()).toHaveLength(5);
    expect(h.failures).toEqual([]);
  });

  it("[P4-8] stores a failed attempt with its cost, counts it toward the cap and retries only after a day", async () => {
    const h = await setup();
    await h.skipped("broken-1", "broken reply", NOV_4_10AM_JST);

    const first = await h.service().prereview();
    expect(first).toMatchObject({ attempted: 1, recorded: 0, failures: ["MODEL_OUTPUT_INVALID"] });
    expect(h.rows()).toEqual([
      expect.objectContaining({
        decisionId: "broken-1",
        status: "failed",
        rating: null,
        failureCode: "MODEL_OUTPUT_INVALID",
        costMicros: 700,
      }),
    ]);

    const restarted = h.service({ dailyLimit: 1 });
    expect(await restarted.prereview()).toMatchObject({ attempted: 0, stoppedBy: "daily_limit" });
    expect(await h.service().prereview()).toMatchObject({ attempted: 0, stoppedBy: "done" });
    expect(h.invocations).toHaveLength(1);

    h.clock.advance(DAY_MS - 60_000);
    expect(await h.service().prereview()).toMatchObject({ attempted: 0 });
    h.clock.advance(120_000);
    expect(await h.service().prereview()).toMatchObject({ attempted: 1 });
    expect(h.rows().filter(({ status }) => status === "failed")).toHaveLength(2);
  });

  it("[P4-8] still stores the attempt and its cost when reading history fails after the model answered", async () => {
    const h = await setup();
    await h.skipped("history-down", "想记住的事", NOV_4_10AM_JST);
    const broken = (store: ReviewPrereviewStorePort): ReviewPrereviewStorePort => ({
      ...store,
      listDone: (input) => store.listDone(input),
      listRecentFailures: (input) => store.listRecentFailures(input),
      countSince: (input) => store.countSince(input),
      listPairs: (input) => store.listPairs(input),
      record: (input) => store.record(input),
      recordFailure: (input) => store.recordFailure(input),
      ownerHistory: async () => {
        throw new Error("EIO");
      },
    });
    const result = await h.service({}, broken).prereview();
    expect(result).toMatchObject({ attempted: 1, recorded: 0 });
    expect(result?.failures).toEqual(["PREREVIEW_STORE_FAILED:unknown"]);
    expect(h.rows()).toEqual([
      expect.objectContaining({
        decisionId: "history-down",
        status: "failed",
        failureCode: "PREREVIEW_STORE_FAILED:unknown",
        costMicros: 300,
      }),
    ]);
    expect(await h.service({ dailyLimit: 1 }).prereview()).toMatchObject({
      attempted: 0,
      stoppedBy: "daily_limit",
    });
  });

  it("[P4-8] stores a failed attempt with its cost when writing the result fails", async () => {
    const h = await setup();
    await h.skipped("write-down", "想记住的事", NOV_4_10AM_JST);
    const broken = (store: ReviewPrereviewStorePort): ReviewPrereviewStorePort => ({
      listDone: (input) => store.listDone(input),
      listRecentFailures: (input) => store.listRecentFailures(input),
      countSince: (input) => store.countSince(input),
      ownerHistory: (input) => store.ownerHistory(input),
      listPairs: (input) => store.listPairs(input),
      recordFailure: (input) => store.recordFailure(input),
      record: async () => {
        throw new ApplicationPortError("PORT_CONFLICT", "SQLite writer remained busy");
      },
    });
    const result = await h.service({}, broken).prereview();
    expect(result?.failures).toEqual(["PREREVIEW_STORE_FAILED:PORT_CONFLICT"]);
    expect(h.rows()).toEqual([
      expect.objectContaining({
        decisionId: "write-down",
        status: "failed",
        failureCode: "PREREVIEW_STORE_FAILED:PORT_CONFLICT",
        costMicros: 300,
      }),
    ]);
    await h.skipped("disk-full", "想记住的另一件事", NOV_4_10AM_JST);
    const down = (store: ReviewPrereviewStorePort): ReviewPrereviewStorePort => ({
      ...broken(store),
      recordFailure: async () => {
        throw new Error("ENOSPC");
      },
    });
    const both = h.service({}, down);
    expect((await both.prereview())?.failures).toEqual(["PREREVIEW_STORE_FAILED:PORT_CONFLICT"]);
    expect(h.rows()).toHaveLength(1);
    expect(await both.prereview()).toMatchObject({ attempted: 0 });
  });

  it("[P4-8] with reduction on and the bar passed, hides only confident items whose text is unchanged, keeping the audit sample and unsure ones", async () => {
    const h = await setup();
    const start = Date.parse(NOV_4_10AM_JST);
    const twoDaysAgo = new Date(start - 2 * DAY_MS).toISOString();
    for (let index = 0; index < 40; index += 1) {
      await h.skipped(`keep-${index}`, `想记住的事 ${index}`, twoDaysAgo);
      await h.skipped(`drop-${index}`, `随口一说 drop ${index}`, twoDaysAgo);
    }
    const all = { perRun: 500, dailyLimit: 500, dailyCostMicros: 10_000_000 };
    expect(await h.service(all).prereview()).toMatchObject({ recorded: 80 });
    for (let index = 0; index < 40; index += 1) {
      await h.ledger.rate({
        ...scope,
        decisionId: `keep-${index}`,
        rating: "useful",
        now: twoDaysAgo,
      });
      await h.ledger.rate({
        ...scope,
        decisionId: `drop-${index}`,
        rating: "missed",
        now: twoDaysAgo,
      });
    }

    const today = h.clock.now();
    const confident = Array.from({ length: 12 }, (_, index) => `today-${index}`);
    for (const id of confident) await h.skipped(id, `今天想记住 ${id}`, today);
    await h.skipped("today-unsure", "今天 unsure 的事", today);
    await h.skipped("today-edited", "今天想记住 edited", today);
    expect(await h.service(all).prereview()).toMatchObject({ recorded: 14 });
    h.texts.set("memory-today-edited", "今天想记住 edited，后来又改了");

    const off = await h.service(all).review({ strict: true });
    expect(off.hiddenByModel).toBe(0);
    const offKeys = off.items.map(({ key }) => key);
    for (const id of [...confident, "today-unsure", "today-edited"])
      expect(offKeys).toContain(`ledger:${id}`);

    const on = await h.service({ ...all, reduction: { enabled: true } }).review({ strict: true });
    const seed = `${OWNER_ID}:${AGENT_ID}`;
    const audited = confident.filter((id) =>
      prereviewAuditPicked(seed, `ledger:${id}`, DEFAULT_REVIEW_PREREVIEW.reduction.auditPermille),
    );
    const expectedHidden = confident.filter((id) => !audited.includes(id));
    expect(expectedHidden.length).toBeGreaterThan(0);
    const onKeys = on.items.map(({ key }) => key);
    expect(on.hiddenByModel).toBe(expectedHidden.length);
    for (const id of expectedHidden) expect(onKeys).not.toContain(`ledger:${id}`);
    for (const id of [...audited, "today-unsure", "today-edited"])
      expect(onKeys).toContain(`ledger:${id}`);
    expect(h.failures).toEqual([]);
  });

  it("[P4-8][reverse] with reduction on but too few rated pairs, hides nothing", async () => {
    const h = await setup();
    const twoDaysAgo = new Date(Date.parse(NOV_4_10AM_JST) - 2 * DAY_MS).toISOString();
    for (let index = 0; index < 5; index += 1)
      await h.skipped(`keep-${index}`, `想记住的事 ${index}`, twoDaysAgo);
    await h.service().prereview();
    for (let index = 0; index < 5; index += 1)
      await h.ledger.rate({
        ...scope,
        decisionId: `keep-${index}`,
        rating: "useful",
        now: twoDaysAgo,
      });
    await h.skipped("today-1", "今天想记住", h.clock.now());
    await h.service().prereview();
    const on = await h.service({ reduction: { enabled: true } }).review({ strict: true });
    expect(on.hiddenByModel).toBe(0);
    expect(on.items.map(({ key }) => key)).toContain("ledger:today-1");
  });

  it("[P4-8] pre-ratings are immutable, and go away with their decision or when mail records are cleared", async () => {
    const h = await setup();
    await h.skipped("gone-with-decision", "想记住 A", NOV_4_10AM_JST);
    await h.skipped("stays", "想记住 B", NOV_4_10AM_JST);
    await h.service().prereview();
    expect(h.rows()).toHaveLength(2);
    expect(() => h.raw.prepare("UPDATE decision_prereviews SET rating = 'missed'").run()).toThrow(
      "DECISION_PREREVIEW_IMMUTABLE",
    );
    expect(() => h.raw.prepare("DELETE FROM decision_prereviews").run()).toThrow(
      "DECISION_PREREVIEW_IMMUTABLE",
    );

    h.raw.prepare("DELETE FROM decision_ledger WHERE id = 'gone-with-decision'").run();
    expect(h.rows().map(({ decisionId }) => decisionId)).toEqual(["stays"]);

    h.raw
      .prepare(
        `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts,
          verdict, outcome, reason_code, inputs, cost_micros, duration_ms)
        VALUES ('mail-check', ?, ?, 'proactive', 'gmail', ?, '{}', 'silent', NULL, 'r', '{}', 0, 0)`,
      )
      .run(OWNER_ID, AGENT_ID, NOV_4_10AM_JST);
    h.raw
      .prepare(
        `INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id,
          thread_id, decision_id, outcome, header_ref, processed_at)
        VALUES (?, ?, 'gmail', 'mail-1', 'thread-1', 'mail-check', 'ignore', NULL, ?)`,
      )
      .run(OWNER_ID, AGENT_ID, NOV_4_10AM_JST);
    h.raw
      .prepare(
        `INSERT INTO decision_prereviews (id, owner_id, agent_id, mail_source, message_id,
          calibration_group, status, rating, confidence_permille, history_conflict, model_ref,
          prompt_id, text_digest, data_classification, cost_micros, duration_ms, created_at)
        VALUES ('mail-pre', ?, ?, 'gmail', 'mail-1', 'proactive_silent', 'done', 'useful', 900,
          0, ?, 'review.prereview@0123456789ab', ?, 'private', 0, 0, ?)`,
      )
      .run(OWNER_ID, AGENT_ID, MODEL_REF, sha256("mail"), NOV_4_10AM_JST);
    expect(
      h.raw.prepare("SELECT COUNT(*) FROM decision_prereviews WHERE id = 'mail-pre'").pluck().get(),
    ).toBe(1);
    await h.store.clearRecords({ ...scope, source: "gmail" });
    expect(
      h.raw.prepare("SELECT COUNT(*) FROM decision_prereviews WHERE id = 'mail-pre'").pluck().get(),
    ).toBe(0);
  });
});
