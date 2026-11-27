import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RealEvalRunRecord } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  GATEWAY_V2_SCHEMA_VERSION,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductionSpokenDecisions,
  spokenMessagesReader,
} from "../../apps/agent-service/src/production-spoken-decisions.js";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-spoken");
const AGENT_ID = createAgentId("agent-spoken");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-26T00:00:00.000Z";
const T0 = "2026-11-01T00:00:00.000Z";
const DAY = 24 * 3_600_000;
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

const TEXTS: Record<string, string> = {
  "decision-reason:a": "这封邮件说明天的会改到上午，你日程上还写着下午",
  "decision-reason:b": "到点的提醒",
  "decision-reason:c": "上周的事",
  "inbox-summary:mail1": "来自 山田：会议改到明天上午 10 点",
  "inbox-summary:memory1": "记忆 #12 刚存下",
};

function envelope(kind: "query" | "command", type: string, payload: Record<string, unknown>) {
  return {
    schemaVersion: GATEWAY_V2_SCHEMA_VERSION,
    kind,
    type,
    messageId: `m-${type}`,
    correlationId: `c-${type}`,
    causationId: null,
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope,
    authority: { deploymentId: "d1", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: OWNER_ID },
    ...(kind === "command" ? { idempotencyKey: `k-${type}` } : {}),
    payload,
  };
}

function run(
  id: string,
  finishedAt: string,
  correct: number,
  asked: number,
  outcome = "completed",
) {
  return {
    id,
    startedAt: finishedAt,
    finishedAt,
    outcome,
    trigger: "weekly",
    model: "m",
    costMicros: 0,
    summary: { scores: { fixed: { successes: correct, samples: asked } } },
  } as unknown as RealEvalRunRecord;
}

describe.each(["worker", "direct"] as const)("spoken decisions through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture(runs: readonly RealEvalRunRecord[] = []) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-spoken-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const ref of Object.keys(TEXTS))
      insertPayload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => NOW,
    });
    const ledger = repository.decisionLedger();
    const spoken = (
      id: string,
      overrides: Partial<Parameters<typeof ledger.recordSpoken>[0]> = {},
    ) =>
      ledger.recordSpoken({
        id,
        ...scope,
        scenario: "mail",
        decidedAt: daysAgo(1),
        verdict: "pushed",
        reasonCode: "told_pushed",
        subjectRef: "inbox:mail1",
        runId: "run-1",
        messageId: "message:said:1",
        reasonRef: "decision-reason:a",
        pushSourceKey: null,
        sourceIds: ["gmail-1"],
        durationMs: 60_000,
        ...overrides,
      });
    await spoken("inbox:mail1");
    await spoken("inbox:memory1", {
      scenario: "memory_saved",
      subjectRef: "inbox:memory1",
      sourceIds: ["memory-12"],
      verdict: "pushed",
    });
    await spoken("inbox:reminder1", {
      scenario: "reminder",
      subjectRef: "inbox:reminder1",
      messageId: "message:said:2",
      reasonCode: "told_in_app",
      verdict: "silent",
      reasonRef: "decision-reason:b",
      decidedAt: daysAgo(2),
    });
    await spoken("inbox:quiet1", {
      subjectRef: "inbox:quiet1",
      messageId: null,
      verdict: "silent",
      reasonCode: "kept_silent",
      reasonRef: null,
    });
    await spoken("inbox:old1", {
      subjectRef: "inbox:old1",
      messageId: "message:said:old",
      reasonRef: "decision-reason:c",
      decidedAt: daysAgo(10),
    });
    const control = new ProductionSpokenDecisions({
      scope,
      ledger,
      readText: async (ref) => TEXTS[ref] ?? null,
      recallRuns: async () => runs,
      clock: { now: () => NOW },
    });
    return { ledger, control };
  }

  const read = async (control: ProductionSpokenDecisions, messageId: string) => {
    const query = gatewayV2MessageSchema.parse(
      envelope("query", "decision.spoken.read", { messageId }),
    );
    const snapshot = gatewayV2MessageSchema.parse(await control.query(query as never));
    if (snapshot.type !== "decision.spoken.snapshot") throw new Error(snapshot.type);
    return snapshot.payload;
  };
  const stats = async (control: ProductionSpokenDecisions, span: "week" | "four_weeks") => {
    const query = gatewayV2MessageSchema.parse(envelope("query", "decision.stats.read", { span }));
    const snapshot = gatewayV2MessageSchema.parse(await control.query(query as never));
    if (snapshot.type !== "decision.stats.snapshot") throw new Error(snapshot.type);
    return snapshot.payload;
  };
  const rate = async (
    control: ProductionSpokenDecisions,
    messageId: string,
    rating: "useful" | "unneeded" | null,
  ) =>
    control.execute(
      gatewayV2MessageSchema.parse(
        envelope("command", "decision.spoken.rate", { messageId, rating }),
      ) as never,
    );

  it("marks only her messages that came from a decision to speak", async () => {
    const { ledger } = await fixture();
    const reader = spokenMessagesReader(ledger);
    const message = (id: string, role: "agent" | "owner", committedAt: string) =>
      ({ id, role, committedAt }) as never;
    const marked = await reader.spoken({
      ...scope,
      messages: [
        message("message:said:1", "agent", daysAgo(3)),
        message("message:said:2", "agent", daysAgo(3)),
        message("message:reply", "agent", daysAgo(3)),
        message("message:said:old", "owner", daysAgo(11)),
      ],
    });
    expect([...marked].sort()).toEqual(["message:said:1", "message:said:2"]);
    expect(
      await reader.spoken({ ...scope, messages: [message("message:said:1", "owner", T0)] }),
    ).toEqual(new Set());
    const late = await reader.spoken({
      ...scope,
      messages: [message("message:said:old", "agent", daysAgo(5))],
    });
    expect(late).toEqual(new Set());
  });

  it("explains a spoken message with its reason and what caused it", async () => {
    const { control } = await fixture();
    const payload = await read(control, "message:said:1");
    expect(payload.rating).toBeNull();
    expect(payload.decisions.map(({ decisionId }) => decisionId)).toEqual([
      "inbox:mail1",
      "inbox:memory1",
    ]);
    const [mail, memory] = payload.decisions;
    expect(mail).toMatchObject({
      pushed: true,
      reason: TEXTS["decision-reason:a"],
      cause: {
        kind: "mail",
        at: new Date(Date.parse(daysAgo(1)) - 60_000).toISOString(),
        summary: TEXTS["inbox-summary:mail1"],
        memoryId: null,
      },
    });
    expect(memory?.cause).toMatchObject({ kind: "memory_saved", memoryId: "memory-12" });
  });

  it("has nothing to explain for a message she did not decide to say", async () => {
    const { control } = await fixture();
    await expect(read(control, "message:reply")).rejects.toMatchObject({
      code: "PORT_NOT_FOUND",
    });
    await expect(rate(control, "message:reply", "useful")).rejects.toMatchObject({
      code: "PORT_NOT_FOUND",
    });
  });

  it("stores the owner's rating on every decision behind the message and counts it", async () => {
    const { control } = await fixture();
    expect(await rate(control, "message:said:1", "useful")).toEqual({
      resultRef: "message:said:1:useful",
      replayed: false,
    });
    expect((await read(control, "message:said:1")).rating).toBe("useful");
    expect(await rate(control, "message:said:1", "useful")).toMatchObject({ replayed: true });
    const week = await stats(control, "week");
    expect(week.current).toMatchObject({ spoken: 2, rated: 1, useful: 1, unneeded: 0 });
    expect(week.previous).toMatchObject({ spoken: 1, rated: 0 });
    expect(week.minimumSamples).toBeGreaterThan(0);
    await rate(control, "message:said:2", "unneeded");
    expect((await stats(control, "week")).current).toMatchObject({ rated: 2, unneeded: 1 });
    await rate(control, "message:said:1", null);
    expect((await read(control, "message:said:1")).rating).toBeNull();
    expect((await stats(control, "week")).current).toMatchObject({ rated: 1, useful: 0 });
    expect((await stats(control, "four_weeks")).current).toMatchObject({ spoken: 3 });
  });

  it("reports the latest memory check and the one before it, skipping failed runs", async () => {
    const { control } = await fixture([
      run("r3", daysAgo(1), 0, 0, "failed"),
      run("r2", daysAgo(2), 24, 30),
      run("r1", daysAgo(9), 20, 30),
    ]);
    const payload = await stats(control, "week");
    expect(payload.recall).toEqual({ at: daysAgo(2), correct: 24, asked: 30 });
    expect(payload.previousRecall).toEqual({ at: daysAgo(9), correct: 20, asked: 30 });
    const { control: empty } = await fixture();
    expect((await stats(empty, "week")).recall).toBeNull();
  });
});
