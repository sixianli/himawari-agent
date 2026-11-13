import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  type MemoryContentPort,
  type MemoryProviderProjectionPort,
  type ProductMemoryRecord,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.js";
import { ProductionMemoryControl } from "../../apps/agent-service/src/production-memory-control.js";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-chain");
const AGENT_ID = createAgentId("agent-chain");
const THREAD_ID = createThreadId("thread-chain");
const GENERATION_ID = createMemoryGenerationId("generation-chain");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-11-01T00:00:00.000Z";
const DECIDED_AT = "2026-11-05T00:00:00.000Z";
const SENTINEL = "SENTINEL-SENSITIVE-QUOTE";

const TEXTS: Record<string, string> = {
  "payload-a": "不要在周末给我发工作邮件",
  "payload-b": "周五下午不开会",
  "payload-c": "每天 9 点前不要提醒我",
  "payload-insight": "我偏好安静的工作时间",
  "payload-sensitive": "我的血压偏高",
  "payload-quote-a": "以后周末别发工作邮件给我",
  "payload-quote-sensitive": SENTINEL,
  "message-memory-a": "以后周末别发工作邮件给我",
};

class FixtureContent implements MemoryContentPort {
  async readText(): Promise<string> {
    return "fixture";
  }
}

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

const COUNTS = {
  fetched: 2,
  skipped: 0,
  judged: 2,
  act: 1,
  know: 1,
  check: 0,
  ignore: 0,
  floorRaised: 1,
  pushed: 1,
};

describe.each(["worker", "direct"] as const)("decision chain through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-decision-chain-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
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
      .run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, ?, 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const ref of Object.keys(TEXTS))
      insertPayload.run(
        ref,
        OWNER_ID,
        AGENT_ID,
        ref.includes("sensitive") ? "restricted" : "private",
        `sha256:${ref}`,
        T0,
      );
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-chain', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-chain', ?, ?, ?, 'completed', 'model-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database
      .prepare(
        `INSERT INTO thread_messages (
          id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
          classification, committed_at
        ) VALUES ('message-a', ?, ?, ?, 0, 1, 'owner', 'message-memory-a', 'private', ?)`,
      )
      .run(OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider: new NoopProvider(),
      content: new FixtureContent(),
      workerId: "chain-worker",
      now: () => T0,
      maximumProjectionAttempts: 3,
      projectionLeaseMs: 10_000,
    });
    const writes: string[] = [];
    const guarded = new Proxy(
      {},
      {
        get: (_target, name) => () => {
          writes.push(String(name));
          throw new Error(`MEMORY_WRITE_${String(name)}`);
        },
      },
    );
    const ledger = repository.decisionLedger();
    const spy =
      <TName extends "append" | "rate" | "rateMany" | "recordMuse">(name: TName) =>
      (...args: Parameters<typeof ledger.append>) => {
        writes.push(`ledger.${name}`);
        return (ledger[name] as (...input: unknown[]) => unknown)(...args);
      };
    const spiedLedger = {
      ...ledger,
      append: spy("append"),
      rate: spy("rate"),
      rateMany: spy("rateMany"),
      recordMuse: spy("recordMuse"),
    } as unknown as typeof ledger;
    const control = new ProductionMemoryControl({
      configuration: scope,
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      approvals: repository.sensitiveMemoryApprovals(),
      unitOfWork: repository.unitOfWork(),
      memory: guarded,
      book: repository.memoryBook(),
      ledger: spiedLedger,
      consolidation: { store: repository.memoryConsolidation(), undo: async () => undefined },
      payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: {
        unprotect: async ({ payload }: { payload: { ref: string } }) =>
          new TextEncoder().encode(TEXTS[payload.ref] ?? ""),
      },
      clock: { now: () => "2026-11-09T00:00:00.000Z" },
      onAudit: () => undefined,
    } as never);
    const sql = (run: (database: ReturnType<typeof openQualifiedDatabase>) => void) => {
      const handle = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
      try {
        run(handle);
      } finally {
        handle.close();
      }
    };
    return { repository, memory, control, writes, sql, ledger };
  }

  const proposal = (
    id: string,
    contentRef: string,
    extra: { classification?: "private" | "restricted"; quoteRef?: string; refs?: string[] } = {},
  ) =>
    ({
      decision: "create",
      memory: {
        id: createMemoryId(id),
        ...scope,
        contentRef,
        dataClassification: extra.classification ?? "private",
        sourceThreadId: THREAD_ID,
        sourceRefs: extra.refs ?? [`message-${id}`],
        inference: false,
        confidencePermille: 1000,
        policyVersion: "memory-policy-v1",
      },
      ...(extra.quoteRef ? { quoteRef: extra.quoteRef } : {}),
    }) as never;

  const query = (decisionId: string) =>
    ({
      schemaVersion: "gateway.v2",
      messageId: "message-chain",
      correlationId: "correlation-chain",
      causationId: null,
      dataClassification: "private",
      risk: "medium",
      authorizationRef: null,
      scope,
      authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType: "owner", actorId: OWNER_ID },
      kind: "query",
      type: "decision.chain.read",
      payload: { decisionId },
    }) as never;

  async function chainOf(control: ProductionMemoryControl, decisionId: string) {
    const snapshot = await control.query(query(decisionId));
    if (snapshot.type !== "decision.chain.snapshot") throw new Error("snapshot");
    gatewayV2MessageSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    return snapshot.payload;
  }

  async function recordGmail(
    repository: SqliteProductStateRepository,
    id: string,
    inputs: Record<string, unknown>,
  ) {
    await repository.proactive().record({
      ...scope,
      decision: {
        id,
        scenario: "gmail",
        checkedAt: DECIDED_AT,
        counts: COUNTS,
        verdict: "pushed",
        reasonCode: "FLOOR_RAISED",
        pushSourceKey: null,
        costMicros: 0,
        durationMs: 1,
        ownerRating: null,
        ratedAt: null,
      },
      inputs: inputs as never,
      modelPayloads: [],
      processed: [],
      insights: [],
      repliedThreads: [],
      push: null,
      cursor: null,
    });
  }

  async function seedMemories(
    f: Awaited<ReturnType<typeof fixture>>,
    options: { sensitive?: boolean } = {},
  ) {
    const { memory, repository } = f;
    await memory.applyProposal(
      proposal("memory-a", "payload-a", {
        quoteRef: "payload-quote-a",
        refs: ["message-memory-a"],
      }),
      GENERATION_ID,
    );
    await memory.applyProposal(proposal("memory-b", "payload-b"), GENERATION_ID);
    await memory.applyProposal(proposal("memory-c", "payload-c"), GENERATION_ID);
    if (options.sensitive)
      await memory.applyProposal(
        proposal("memory-sensitive", "payload-sensitive", {
          classification: "restricted",
          quoteRef: "payload-quote-sensitive",
        }),
        GENERATION_ID,
      );
    const store = repository.memoryConsolidation();
    await store.begin({
      id: "consolidation-1",
      ...scope,
      day: "2026-11-02",
      triggerRunId: "run-1",
      status: "running",
      reviewedThrough: null,
      modelCalled: false,
      changeCount: 0,
      errorCode: null,
      startedAt: T0,
      finishedAt: null,
    });
    await memory.applyProposal(
      proposal("memory-insight", "payload-insight"),
      GENERATION_ID,
      undefined,
      (saved) => ({
        change: {
          id: "consolidation-1:c1",
          consolidationId: "consolidation-1",
          ...scope,
          memoryId: createMemoryId("memory-insight"),
          relatedMemoryId: createMemoryId("memory-b"),
          action: "reflect",
          beforeRevision: null,
          afterRevision: saved.revision,
          beforeStatus: "active",
          beforeSupersededBy: null,
          beforeValidTo: null,
          createdAt: T0,
          undoneAt: null,
        },
        basisMemoryIds: [createMemoryId("memory-b"), createMemoryId("memory-c")],
        resultMemoryIds: [createMemoryId("memory-insight")],
      }),
    );
  }

  const gmailInputs = (overrides: Record<string, unknown> = {}) => ({
    ruleIds: ["floor_important_sender", "floor_unregistered_rule"],
    sourceIds: ["mail-1", "mail-2"],
    floorHits: {
      "mail-1": ["floor_important_sender"],
      "mail-2": ["floor_important_sender", "floor_unregistered_rule"],
    },
    memoryInjected: true,
    memoryIds: ["memory-a", "memory-insight", "memory-gone"],
    usedMemoryIds: ["memory-a"],
    tentativeMemoryIds: [],
    memoryByMail: { "mail-1": ["memory-a"], "mail-2": ["memory-insight", "memory-gone"] },
    memoryRecall: "ok",
    relatedByMail: { "mail-1": ["related-1", "related-2"], "mail-2": ["related-2"] },
    relatedRead: "ok",
    ...overrides,
  });

  it("[P1-3] reads the whole chain of a Gmail decision: rule, memory with original words and source, basis chain, rating", async () => {
    const f = await fixture();
    try {
      await seedMemories(f);
      await recordGmail(f.repository, "gmail-1", gmailInputs());
      await f.ledger.rate({ ...scope, decisionId: "gmail-1", rating: "useful", now: DECIDED_AT });
      f.sql((database) =>
        database
          .prepare(
            "UPDATE memory_records SET updated_at = '2026-11-06T00:00:00.000Z' WHERE id = 'memory-a'",
          )
          .run(),
      );
      f.writes.length = 0;
      const chain = await chainOf(f.control, "gmail-1");
      expect(chain.decision).toMatchObject({
        kind: "proactive",
        decidedAt: DECIDED_AT,
        outcome: "pushed",
        reasonCode: "FLOOR_RAISED",
        rating: "useful",
        ratedAt: DECIDED_AT,
      });
      expect(chain.inputs).toBe("recorded");
      expect(chain.rules).toEqual({
        state: "recorded",
        items: [
          {
            ruleId: "floor_important_sender",
            revision: null,
            current: false,
            kind: "important_sender",
            origin: null,
            source: null,
            status: null,
            changedAt: null,
            memory: null,
            wording: null,
            tests: { state: "unavailable", total: 0, failedAt: null },
            mailCount: 2,
          },
          {
            ruleId: "floor_unregistered_rule",
            revision: null,
            current: false,
            kind: "unknown",
            origin: null,
            source: null,
            status: null,
            changedAt: null,
            memory: null,
            wording: null,
            tests: { state: "unavailable", total: 0, failedAt: null },
            mailCount: 1,
          },
        ],
      });
      expect(chain.mails).toEqual({ judged: 2, related: 2, relatedRead: "ok", summaries: null });
      expect(chain.memories).toMatchObject({
        state: "recorded",
        recall: "ok",
        total: 3,
        truncated: false,
      });
      const byId = new Map(chain.memories.items.map((item) => [item.memoryId, item]));
      expect([...byId.keys()]).toEqual(["memory-a", "memory-gone", "memory-insight"]);
      expect(byId.get("memory-a")).toMatchObject({
        state: "visible",
        text: TEXTS["payload-a"],
        status: "active",
        usedByModel: true,
        changedSinceDecision: true,
        source: {
          threadId: THREAD_ID,
          messageId: "message-a",
          quote: TEXTS["payload-quote-a"],
          firstSourceDeleted: false,
        },
        basis: { nodes: [], complete: true },
      });
      const insight = byId.get("memory-insight");
      expect(insight).toMatchObject({
        state: "visible",
        usedByModel: false,
        changedSinceDecision: false,
      });
      expect(
        insight?.basis.nodes.map(({ memoryId, action, text, basisMemoryIds }) => [
          memoryId,
          action,
          text,
          basisMemoryIds,
        ]),
      ).toEqual([
        ["memory-insight", "reflect", TEXTS["payload-insight"], ["memory-b", "memory-c"]],
        ["memory-b", null, TEXTS["payload-b"], []],
        ["memory-c", null, TEXTS["payload-c"], []],
      ]);
      expect(insight?.basis.complete).toBe(true);
      expect(byId.get("memory-gone")).toMatchObject({
        state: "missing",
        text: null,
        status: null,
        source: { threadId: null, messageId: null, quote: null },
        basis: { nodes: [], complete: true },
      });
      expect(f.writes).toEqual([]);
    } finally {
      await f.repository.close();
    }
  });

  it("[P3-6] lists how many recent chat summaries a Gmail check sent and whether the read was whole", async () => {
    const f = await fixture();
    try {
      await recordGmail(
        f.repository,
        "gmail-summaries",
        gmailInputs({
          summaryInjected: true,
          summaryIds: ["episode:day_summary:thread-a:1", "episode:day_summary:thread-b:4"],
          summaryDays: ["2026-11-03", "2026-11-04"],
          summaryCharacters: 120,
          summaryRead: "partial",
          summaryGenerated: 1,
        }),
      );
      await recordGmail(
        f.repository,
        "gmail-no-summaries",
        gmailInputs({
          summaryInjected: false,
          summaryIds: [],
          summaryDays: [],
          summaryCharacters: 0,
          summaryRead: "off",
          summaryGenerated: 0,
        }),
      );
      expect((await chainOf(f.control, "gmail-summaries")).mails?.summaries).toEqual({
        count: 2,
        read: "partial",
      });
      expect((await chainOf(f.control, "gmail-no-summaries")).mails?.summaries).toEqual({
        count: 0,
        read: "off",
      });
      const [entry] = (
        await f.ledger.list({
          ...scope,
          kind: "proactive",
          since: "2026-11-01T00:00:00.000Z",
          limit: 10,
        })
      ).filter(({ id }) => id === "gmail-summaries");
      expect(entry?.inputs).toMatchObject({
        summaryInjected: true,
        summaryDays: ["2026-11-03", "2026-11-04"],
        summaryCharacters: 120,
        summaryRead: "partial",
        summaryGenerated: 1,
      });
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] shows 'not recorded' for every section of a Gmail row whose inputs were never written, never 'none'", async () => {
    const f = await fixture();
    try {
      await recordGmail(f.repository, "gmail-old", gmailInputs());
      f.sql((database) =>
        database.prepare("UPDATE decision_ledger SET inputs = '{}' WHERE id = 'gmail-old'").run(),
      );
      const chain = await chainOf(f.control, "gmail-old");
      expect(chain.inputs).toBe("not_recorded");
      expect(chain.rules).toEqual({ state: "not_recorded", items: [] });
      expect(chain.mails).toEqual({
        judged: null,
        related: null,
        relatedRead: "not_recorded",
        summaries: null,
      });
      expect(chain.memories).toMatchObject({
        state: "not_recorded",
        recall: "not_recorded",
        total: 0,
        items: [],
      });
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] tells 'recorded as empty' from 'not recorded': a check that injected no memory and hit no rule", async () => {
    const f = await fixture();
    try {
      await recordGmail(
        f.repository,
        "gmail-empty",
        gmailInputs({
          ruleIds: [],
          floorHits: {},
          memoryInjected: false,
          memoryIds: [],
          usedMemoryIds: [],
          memoryByMail: {},
          memoryRecall: "off",
        }),
      );
      const chain = await chainOf(f.control, "gmail-empty");
      expect(chain.rules.state).toBe("none");
      expect(chain.memories).toMatchObject({ state: "none", recall: "off", items: [] });
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] refuses an unknown decision and another owner's decision instead of returning an empty chain", async () => {
    const f = await fixture();
    try {
      await recordGmail(f.repository, "gmail-1", gmailInputs());
      await expect(f.control.query(query("gmail-missing"))).rejects.toMatchObject({
        code: "PORT_NOT_FOUND",
      });
      expect(
        await f.ledger.read({
          ownerId: createOwnerId("owner-other"),
          agentId: AGENT_ID,
          decisionId: "gmail-1",
        }),
      ).toBeUndefined();
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] hides every text of a restricted memory, including its original words, and nothing leaks into the snapshot", async () => {
    const f = await fixture();
    try {
      await seedMemories(f, { sensitive: true });
      await recordGmail(
        f.repository,
        "gmail-sensitive",
        gmailInputs({ memoryIds: ["memory-sensitive"], memoryByMail: {}, usedMemoryIds: [] }),
      );
      const snapshot = await f.control.query(query("gmail-sensitive"));
      if (snapshot.type !== "decision.chain.snapshot") throw new Error("snapshot");
      const [item] = snapshot.payload.memories.items;
      expect(item).toMatchObject({
        memoryId: "memory-sensitive",
        state: "hidden",
        text: null,
        source: { quote: null },
      });
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain(TEXTS["payload-sensitive"] as string);
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] shows a sensitive-tier memory with its text and original words, because the model sees it too", async () => {
    const f = await fixture();
    try {
      await seedMemories(f, { sensitive: true });
      f.sql((database) =>
        database
          .prepare(
            "UPDATE memory_records SET classification = 'sensitive' WHERE id = 'memory-sensitive'",
          )
          .run(),
      );
      await recordGmail(
        f.repository,
        "gmail-sensitive-tier",
        gmailInputs({ memoryIds: ["memory-sensitive"], memoryByMail: {}, usedMemoryIds: [] }),
      );
      const chain = await chainOf(f.control, "gmail-sensitive-tier");
      expect(chain.memories.items[0]).toMatchObject({
        state: "visible",
        text: TEXTS["payload-sensitive"],
        source: { quote: SENTINEL },
      });
    } finally {
      await f.repository.close();
    }
  });

  it("[P5-1] keeps the recent-summary fields of an external read readable, without a mail section", async () => {
    const f = await fixture();
    try {
      await f.ledger.append({
        id: "ledger:external-read",
        ...scope,
        kind: "external_read",
        decidedAt: DECIDED_AT,
        outcome: "read",
        reasonCode: "today_context",
        subjectRef: "mcp-client:test",
        inputs: {
          memoryIds: [],
          ruleIds: [],
          summaryInjected: true,
          summaryIds: ["episode:day_summary:thread-a:1"],
          summaryDays: ["2026-11-04"],
          summaryCharacters: 40,
          summaryRead: "ok",
          summaryGenerated: 0,
        },
        reasonRef: null,
        contentRef: null,
        costMicros: 0,
        durationMs: 0,
      });
      const found = await f.ledger.read({ ...scope, decisionId: "ledger:external-read" });
      expect(found?.inputFields).toEqual(
        expect.arrayContaining([
          "summaryCharacters",
          "summaryDays",
          "summaryGenerated",
          "summaryIds",
          "summaryInjected",
          "summaryRead",
        ]),
      );
      const chain = await chainOf(f.control, "ledger:external-read");
      expect(chain.mails).toBeNull();
      expect(chain.rules).toEqual({ state: "not_applicable", items: [] });
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] says a row is not applicable to rules for kinds that write a reason code into rule ids", async () => {
    const f = await fixture();
    try {
      await f.ledger.append({
        id: "ledger:candidate",
        ...scope,
        kind: "memory_candidate",
        decidedAt: DECIDED_AT,
        outcome: "discarded",
        reasonCode: "confidence_below_threshold",
        subjectRef: null,
        inputs: { memoryIds: [], ruleIds: ["confidence_below_threshold"] },
        reasonRef: null,
        contentRef: null,
        costMicros: 0,
        durationMs: 0,
      });
      const chain = await chainOf(f.control, "ledger:candidate");
      expect(chain.rules).toEqual({ state: "not_applicable", items: [] });
      expect(chain.mails).toBeNull();
      expect(chain.memories.recall).toBeNull();
    } finally {
      await f.repository.close();
    }
  });

  it("[P2-7] shows each rule as the version the check used: wording, source, revision and examples run now", async () => {
    const f = await fixture();
    try {
      const proactive = f.repository.proactive();
      const settings = (senders: string[], now: string) =>
        proactive.writeSettings({
          ...scope,
          enabled: true,
          quietHours: [{ days: [1, 2], start: "22:00", end: "06:30" }],
          importantSenders: senders,
          now,
        });
      await settings(["boss@corp.example"], "2026-11-01T00:00:00.000Z");
      await settings(["bank.example"], "2026-11-02T00:00:00.000Z");
      await recordGmail(
        f.repository,
        "gmail-versions",
        gmailInputs({
          ruleIds: [
            "floor_important_sender@1",
            "floor_money_words@2",
            "quiet_hours@1",
            "suppress_small_amount@1",
          ],
          floorHits: { "mail-1": ["floor_important_sender", "floor_money_words"] },
          ruleHits: { "mail-2": ["suppress_small_amount@1"] },
          memoryIds: [],
          memoryByMail: {},
          usedMemoryIds: [],
        }),
      );
      const chain = await chainOf(f.control, "gmail-versions");
      const byId = new Map(chain.rules.items.map((item) => [item.ruleId, item]));
      expect(byId.get("floor_important_sender")).toEqual({
        ruleId: "floor_important_sender",
        revision: 1,
        current: false,
        kind: "important_sender",
        origin: "owner_setting",
        source: "ADR 0106 第 4 条；主人的设置“重要发件人”",
        status: "active",
        changedAt: "2026-11-01T00:00:00.000Z",
        memory: null,
        wording: { values: ["boss@corp.example"], quietHours: [], amount: null },
        tests: { state: "passed", total: 2, failedAt: null },
        mailCount: 1,
      });
      expect(byId.get("floor_money_words")).toMatchObject({
        kind: "money_words",
        origin: "built_in",
        revision: 2,
        source: "ADR 0106 第 4 条；ADR 0209；ADR 0248",
        tests: { state: "passed", failedAt: null },
        mailCount: 1,
      });
      expect(byId.get("floor_money_words")?.wording?.values).toEqual([]);
      expect(byId.get("quiet_hours")).toMatchObject({
        kind: "quiet_hours",
        revision: 1,
        wording: { quietHours: [{ days: [1, 2], start: "22:00", end: "06:30" }] },
        tests: { state: "passed", failedAt: null },
        mailCount: 0,
      });
      expect(byId.get("suppress_small_amount")).toMatchObject({
        kind: "amount_threshold",
        revision: 1,
        wording: null,
        tests: { state: "unavailable" },
        mailCount: 1,
      });
    } finally {
      await f.repository.close();
    }
  });

  it("[P2-7] shows the default quiet hours and an empty important list for revision 0, and nothing for a bare id with no row", async () => {
    const f = await fixture();
    try {
      await recordGmail(
        f.repository,
        "gmail-defaults",
        gmailInputs({
          ruleIds: ["__proto__", "floor_important_sender@0", "quiet_hours", "quiet_hours@0"],
          floorHits: {},
          memoryIds: [],
          memoryByMail: {},
          usedMemoryIds: [],
        }),
      );
      const chain = await chainOf(f.control, "gmail-defaults");
      const items = chain.rules.items;
      expect(
        items.find((item) => item.ruleId === "quiet_hours" && item.revision === 0),
      ).toMatchObject({
        current: false,
        changedAt: null,
        wording: { quietHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }] },
        tests: { state: "passed", failedAt: null },
      });
      expect(items.find((item) => item.ruleId === "floor_important_sender")).toMatchObject({
        revision: 0,
        wording: { values: [] },
        tests: { state: "passed", total: 1 },
      });
      expect(
        items.find((item) => item.ruleId === "quiet_hours" && item.revision === null),
      ).toMatchObject({
        current: false,
        wording: null,
        tests: { state: "unavailable" },
      });
      expect(items.find((item) => item.ruleId === "__proto__")).toMatchObject({
        kind: "unknown",
        current: false,
        wording: null,
      });
    } finally {
      await f.repository.close();
    }
  });

  it("[P2-7] shows the rule's own words when it came from a rule memory, and its review state", async () => {
    const f = await fixture();
    try {
      await seedMemories(f);
      await f.repository.proactive().writeSettings({
        ...scope,
        enabled: true,
        quietHours: [],
        importantSenders: ["bank.example"],
        now: "2026-11-01T00:00:00.000Z",
      });
      f.sql((database) => {
        database
          .prepare(
            "UPDATE rule_book_rules SET source_memory_id = 'memory-a', status = 'needs_review', review_after = updated_at WHERE rule_id = 'floor_important_sender'",
          )
          .run();
      });
      await recordGmail(
        f.repository,
        "gmail-memory-rule",
        gmailInputs({
          ruleIds: ["floor_important_sender"],
          floorHits: { "mail-1": ["floor_important_sender"] },
          memoryIds: [],
          memoryByMail: {},
          usedMemoryIds: [],
        }),
      );
      const chain = await chainOf(f.control, "gmail-memory-rule");
      expect(chain.rules.items).toMatchObject([
        {
          ruleId: "floor_important_sender",
          current: true,
          status: "needs_review",
          memory: { memoryId: "memory-a", state: "visible", text: TEXTS["payload-a"] },
          wording: { values: ["bank.example"] },
          tests: { state: "passed" },
        },
      ]);
    } finally {
      await f.repository.close();
    }
  });

  it("[P2-7] refuses an important sender with a control character and still reads a chain whose stored list has one", async () => {
    const f = await fixture();
    try {
      await expect(
        f.repository.proactive().writeSettings({
          ...scope,
          enabled: true,
          quietHours: [],
          importantSenders: ["bank\n.example"],
          now: "2026-11-01T00:00:00.000Z",
        }),
      ).rejects.toThrow();
      await f.repository.proactive().writeSettings({
        ...scope,
        enabled: true,
        quietHours: [],
        importantSenders: ["bank.example", "x\u0080y.example"],
        now: "2026-11-01T00:00:00.000Z",
      });
      expect((await f.repository.proactive().readSettings(scope)).importantSenders).toEqual([
        "bank.example",
        "x\u0080y.example",
      ]);
      f.sql((database) => {
        database
          .prepare(
            "UPDATE rule_book_rules SET parameters = ? WHERE rule_id = 'floor_important_sender'",
          )
          .run(JSON.stringify({ senders: ["bank\n.example"] }));
      });
      await recordGmail(
        f.repository,
        "gmail-control-sender",
        gmailInputs({
          ruleIds: ["floor_important_sender"],
          floorHits: { "mail-1": ["floor_important_sender"] },
          memoryIds: [],
          memoryByMail: {},
          usedMemoryIds: [],
        }),
      );
      const chain = await chainOf(f.control, "gmail-control-sender");
      expect(chain.rules.items).toMatchObject([
        { ruleId: "floor_important_sender", current: true, wording: { values: ["bank .example"] } },
      ]);
    } finally {
      await f.repository.close();
    }
  });

  it("[P2-2] lists the hard rule a rule review record points at", async () => {
    const f = await fixture();
    try {
      await f.ledger.append({
        id: "ledger:rule-review",
        ...scope,
        kind: "rule_review",
        decidedAt: DECIDED_AT,
        outcome: "needs_review",
        reasonCode: "memory_edited",
        subjectRef: "floor_important_sender",
        inputs: {
          memoryIds: ["memory-a"],
          ruleIds: ["floor_important_sender"],
          batchId: null,
          resultMemoryIds: [],
        },
        reasonRef: null,
        contentRef: null,
        costMicros: 0,
        durationMs: 0,
      });
      const chain = await chainOf(f.control, "ledger:rule-review");
      expect(chain.rules).toMatchObject({
        state: "recorded",
        items: [{ ruleId: "floor_important_sender", mailCount: 0 }],
      });
      expect(chain.mails).toBeNull();
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] caps the memories shown and says so", async () => {
    const f = await fixture();
    try {
      const ids = Array.from(
        { length: 130 },
        (_, index) => `memory-x${String(index).padStart(3, "0")}`,
      );
      await recordGmail(
        f.repository,
        "gmail-many",
        gmailInputs({ memoryIds: ids, memoryByMail: {}, usedMemoryIds: [] }),
      );
      const chain = await chainOf(f.control, "gmail-many");
      expect(chain.memories.total).toBe(130);
      expect(chain.memories.truncated).toBe(true);
      expect(chain.memories.items).toHaveLength(100);
      expect(chain.memories.items[0]?.memoryId).toBe("memory-x000");
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] hides the text of a restricted memory that supersedes a visible one and of a restricted basis node", async () => {
    const f = await fixture();
    try {
      await seedMemories(f, { sensitive: true });
      f.sql((database) => {
        database
          .prepare(
            "UPDATE memory_records SET superseded_by = 'memory-sensitive' WHERE id = 'memory-a'",
          )
          .run();
        database
          .prepare("UPDATE memory_records SET classification = 'restricted' WHERE id = 'memory-b'")
          .run();
      });
      await recordGmail(
        f.repository,
        "gmail-hidden-links",
        gmailInputs({
          memoryIds: ["memory-a", "memory-insight"],
          memoryByMail: {},
          usedMemoryIds: [],
        }),
      );
      const chain = await chainOf(f.control, "gmail-hidden-links");
      const memoryA = chain.memories.items.find((item) => item.memoryId === "memory-a");
      expect(memoryA?.supersededBy).toEqual({ memoryId: "memory-sensitive", text: null });
      const insight = chain.memories.items.find((item) => item.memoryId === "memory-insight");
      expect(insight?.basis.nodes.some((node) => node.memoryId === "memory-b")).toBe(true);
      const serialized = JSON.stringify(chain);
      expect(serialized).not.toContain(TEXTS["payload-sensitive"] as string);
      expect(serialized).not.toContain(TEXTS["payload-b"] as string);
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] shows a rule id that is not a machine string as an unregistered rule instead of failing the whole read", async () => {
    const f = await fixture();
    try {
      const odd = `规则 with spaces/${"x".repeat(200)}`;
      await recordGmail(
        f.repository,
        "gmail-odd-rule",
        gmailInputs({ ruleIds: [odd], floorHits: { "mail-1": [odd] }, memoryIds: [] }),
      );
      const chain = await chainOf(f.control, "gmail-odd-rule");
      expect(chain.rules.items).toMatchObject([
        { ruleId: odd, kind: "unknown", origin: null, wording: null, mailCount: 1 },
      ]);
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] hides the text of a visible memory that supersedes a restricted one, and shows a control character in a rule id as a space", async () => {
    const f = await fixture();
    try {
      await seedMemories(f, { sensitive: true });
      f.sql((database) =>
        database
          .prepare(
            "UPDATE memory_records SET superseded_by = 'memory-b' WHERE id = 'memory-sensitive'",
          )
          .run(),
      );
      const odd = "rule\nwith\tcontrol";
      await recordGmail(
        f.repository,
        "gmail-reverse-supersede",
        gmailInputs({
          ruleIds: [odd],
          floorHits: { "mail-1": [odd] },
          memoryIds: ["memory-sensitive"],
          memoryByMail: {},
          usedMemoryIds: [],
        }),
      );
      const chain = await chainOf(f.control, "gmail-reverse-supersede");
      expect(chain.memories.items[0]).toMatchObject({
        state: "hidden",
        supersededBy: { memoryId: "memory-b", text: null },
      });
      expect(JSON.stringify(chain)).not.toContain(TEXTS["payload-b"] as string);
      expect(chain.rules.items[0]).toMatchObject({ ruleId: "rule with control", mailCount: 1 });
    } finally {
      await f.repository.close();
    }
  });

  it("[P1-3] is reachable through the real approval gateway, and an unknown record is refused there too", async () => {
    const f = await fixture();
    try {
      await recordGmail(f.repository, "gmail-gateway", gmailInputs({ memoryIds: [] }));
      const fence = { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 };
      const gateway = createProductionApprovalGateway({
        configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
        repository: f.repository,
        authority: () => fence as never,
        executionAuthority: () => fence as never,
        clock: { now: () => DECIDED_AT },
        access: { authorize: async () => ({ allowed: true, reasonCode: "TEST_OWNER" }) },
        recentAuthentication: { assertRecentAuthentication: async () => ({}) as never },
        memoryControl: f.control,
      });
      const authentication = {
        ownerId: OWNER_ID,
        subjectId: OWNER_ID,
        deviceId: "device-01",
        authenticatedAt: DECIDED_AT,
        authenticationRef: "auth-01",
      };
      const found = await gateway.request(authentication as never, query("gmail-gateway"));
      expect(found).toMatchObject({
        type: "decision.chain.snapshot",
        payload: { decisionId: "gmail-gateway" },
      });
      await expect(
        gateway.request(authentication as never, query("gmail-missing")),
      ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
    } finally {
      await f.repository.close();
    }
  });

  it("[P3-8-undo] the memory overview says a tidy-up can be undone until its memory is changed", async () => {
    const f = await fixture();
    try {
      await seedMemories(f);
      const overview = async () => {
        const snapshot = await f.control.query({
          ...(query("unused") as object),
          type: "memory.overview.read",
          payload: {},
        } as never);
        if (snapshot.type !== "memory.overview.snapshot") throw new Error("snapshot");
        return snapshot.payload.tidyUps;
      };
      expect(await overview()).toMatchObject([
        { changeId: "consolidation-1:c1", undone: false, undoable: true },
      ]);
      const current = await f.repository
        .productMemoryState()
        .read(createMemoryId("memory-insight"));
      if (!current) throw new Error("insight missing");
      await f.memory.revise({
        memoryId: current.id,
        expectedRevision: current.revision,
        generationId: GENERATION_ID,
        attributes: { tentative: true },
      });
      expect(await overview()).toMatchObject([
        { changeId: "consolidation-1:c1", undone: false, undoable: false },
      ]);
    } finally {
      await f.repository.close();
    }
  });

  it("[P3-8-undo] the memory overview never calls an already undone tidy-up undoable, even when its memory is untouched", async () => {
    const f = await fixture();
    try {
      await seedMemories(f);
      await f.repository
        .memoryConsolidation()
        .markUndone({ id: "consolidation-1:c1", undoneAt: "2026-11-09T00:00:00.000Z" });
      const snapshot = await f.control.query({
        ...(query("unused") as object),
        type: "memory.overview.read",
        payload: {},
      } as never);
      if (snapshot.type !== "memory.overview.snapshot") throw new Error("snapshot");
      expect(snapshot.payload.tidyUps).toMatchObject([
        { changeId: "consolidation-1:c1", undone: true, undoable: false },
      ]);
    } finally {
      await f.repository.close();
    }
  });
});
