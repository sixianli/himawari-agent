import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROMPT_BUNDLE_INVALIDATED_EVENT,
  type RecordTraceInput,
  type RuntimePromptBundleResolveInput,
  type RuntimeRequest,
  ThreadPromptBundleService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunExecutionLeaseId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  requestThreadPromptRebuild,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { EGRESS_RULESET_CURRENT } from "@himawari-agent/sensitive-capture";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-prompt-bundle");
const AGENT_ID = createAgentId("agent-prompt-bundle");
const DEPLOYMENT_ID = createDeploymentId("deployment-prompt-bundle");
const LEASE_ID = createAuthorityLeaseId("lease-prompt-bundle");
const THREAD_ID = createThreadId("thread-prompt-bundle");
const NOW = "2026-11-04T00:00:00.000Z";
const AUTHORITY = {
  product: { deploymentId: DEPLOYMENT_ID, authorityEpoch: 1, fencingToken: 1 },
  lease: { leaseId: LEASE_ID, fencingToken: 1 },
} as const;
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 7);
const RUNS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"] as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runId(name: string) {
  return createRunId(`run-prompt-bundle-${name}`);
}

function protector() {
  return new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "bundle-kek@v1": KEY }),
    activeKey: { keyRef: "bundle-kek", kekVersion: "v1", dekVersion: "v1" },
  });
}

async function fixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-prompt-bundle-"));
  roots.push(stateRoot);
  await mkdir(path.join(stateRoot, "data"), { recursive: true });
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
       VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
         fencing_token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, 'bundle-test', 1, 1, ?, '2999-12-31T23:59:59.999Z')`,
    )
    .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
         content_digest, lifecycle_state, created_at, content_type)
       VALUES ('payload-bundle-trigger', ?, ?, 'private', 'sqlite_blob', X'00',
         'sha256:bundle-trigger', 'active', ?, 'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, NOW);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'open', ?, ?)`,
    )
    .run(THREAD_ID, OWNER_ID, AGENT_ID, NOW, NOW);
  for (const name of RUNS) {
    database
      .prepare(
        `INSERT INTO triggers (id, owner_id, agent_id, thread_id, idempotency_key, source_type,
           source_id, payload_ref, source_proof_ref, occurred_at)
         VALUES (?, ?, ?, ?, ?, 'user_message', ?, 'payload-bundle-trigger', ?, ?)`,
      )
      .run(
        `trigger-bundle-${name}`,
        OWNER_ID,
        AGENT_ID,
        THREAD_ID,
        `trigger-bundle-${name}`,
        `fixture-${name}`,
        `proof-${name}`,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO runs (id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'session-prompt-bundle', ?, 1, 'running', ?, ?)`,
      )
      .run(runId(name), OWNER_ID, AGENT_ID, THREAD_ID, `trigger-bundle-${name}`, NOW, NOW);
  }
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => NOW,
  });
  const traces: RecordTraceInput[] = [];
  let sequence = 0;
  const service = new ThreadPromptBundleService({
    store: repository.threadPromptBundles(),
    payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
    artifacts: repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, AUTHORITY),
    protector: protector(),
    clock: { now: () => NOW },
    ids: {
      next: (namespace) => {
        sequence += 1;
        return `${namespace}-${sequence}`;
      },
    },
    trace: async (input) => {
      traces.push(input);
    },
  });
  const rows = () => {
    const reader = openQualifiedDatabase(databasePath);
    try {
      return reader
        .prepare(
          `SELECT generation, origin, superseded_at AS supersededAt, rebuild_reason AS rebuildReason,
             rebuild_operator AS rebuildOperator, classification, created_by_run_id AS runId
           FROM thread_prompt_bundles ORDER BY generation`,
        )
        .all() as Array<Record<string, unknown>>;
    } finally {
      reader.close();
    }
  };
  const count = (sql: string) => {
    const reader = openQualifiedDatabase(databasePath);
    try {
      return Number(reader.prepare(sql).pluck().get());
    } finally {
      reader.close();
    }
  };
  return { stateRoot, databasePath, repository, service, traces, rows, count };
}

function request(name: string, overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: runId(name),
    sessionId: createSessionId("session-prompt-bundle"),
    threadId: THREAD_ID,
    modelRef: "model-primary",
    systemInstructionRef: "system",
    contextEnvelopeRef: "context",
    workerResultRefs: [],
    capabilityHandleRefs: [],
    budget: {},
    correlationId: `correlation-${name}`,
    dataClassification: "private",
    executionLease: {
      ...AUTHORITY.product,
      executionLeaseId: createRunExecutionLeaseId(`execution:${name}`),
      expectedLeaseRevision: 1,
      authorityLeaseId: LEASE_ID,
      authorityFencingToken: 1,
      consumerId: name,
    },
    ...overrides,
  } as RuntimeRequest;
}

const READ_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "要读的文件路径" },
    limit: { type: "integer", minimum: 1, description: "最多读多少行" },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

function input(
  name: string,
  options: {
    readonly systemPrompt?: string;
    readonly toolNames?: readonly string[];
    readonly modelRef?: string;
    readonly request?: Partial<RuntimeRequest>;
    readonly hasHistory?: boolean;
    readonly readDescription?: string;
    readonly readParameters?: unknown;
  } = {},
): RuntimePromptBundleResolveInput {
  const toolNames = options.toolNames ?? ["read", "memory_recall"];
  const tool = (toolName: string) =>
    toolName === "read"
      ? {
          name: toolName,
          description: options.readDescription ?? "read 工具",
          parameters: options.readParameters ?? READ_PARAMETERS,
        }
      : { name: toolName, description: `${toolName} 工具` };
  return {
    request: request(name, {
      ...(options.modelRef ? { modelRef: options.modelRef } : {}),
      ...options.request,
    }),
    identity: {
      toolNames,
      modelRef: options.modelRef ?? "model-primary",
      thinkingLevel: "off",
      answerLocale: null,
    },
    candidate: {
      systemPrompt: options.systemPrompt ?? "规则第一版",
      tools: JSON.stringify(toolNames.map(tool)),
    },
    hasHistory: options.hasHistory ?? false,
  };
}

describe.each(["worker", "direct"] as const)("thread prompt bundles through %s", (execution) => {
  useSqliteContractExecution(execution);

  it("creates generation 1 for a new conversation and keeps its bytes when only the prompt text changes", async () => {
    const resource = await fixture();
    try {
      const first = await resource.service.resolve(input("first"));
      const second = await resource.service.resolve(
        input("second", { systemPrompt: "规则第二版（上线了新文字）" }),
      );
      expect(first).toMatchObject({ generation: 1, systemPrompt: "规则第一版" });
      expect(second).toEqual(first);
      expect(resource.rows()).toEqual([
        expect.objectContaining({ generation: 1, origin: "new_thread", supersededAt: null }),
      ]);
      expect(resource.traces).toEqual([]);
    } finally {
      await resource.repository.close();
    }
  });

  it("marks the first bundle of a conversation that already has history as a rollout", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first", { hasHistory: true }));
      expect(resource.rows()).toEqual([expect.objectContaining({ origin: "rollout" })]);
    } finally {
      await resource.repository.close();
    }
  });

  const rulesetOf = (resource: { count: (sql: string) => number }, generation: number) =>
    resource.count(
      `SELECT coalesce(json_extract(identity_json, '$.redactionRuleset'), 0)
       FROM thread_prompt_bundles WHERE generation = ${generation}`,
    );

  it("[ADR-0188][I-129] gives a new conversation and an existing one the current masking ruleset", async () => {
    const fresh = await fixture();
    try {
      const first = await fresh.service.resolve(input("first"));
      expect(first?.redactionRuleset).toBe(EGRESS_RULESET_CURRENT);
      expect(rulesetOf(fresh, 1)).toBe(EGRESS_RULESET_CURRENT);
    } finally {
      await fresh.repository.close();
    }
    const existing = await fixture();
    try {
      const first = await existing.service.resolve(input("first", { hasHistory: true }));
      expect(first?.redactionRuleset).toBe(EGRESS_RULESET_CURRENT);
      expect(rulesetOf(existing, 1)).toBe(EGRESS_RULESET_CURRENT);
      const renewed = await existing.service.resolve(
        input("second", { toolNames: ["read", "memory_recall", "web_search"] }),
      );
      expect(renewed?.generation).toBe(2);
      expect(renewed?.redactionRuleset).toBe(EGRESS_RULESET_CURRENT);
    } finally {
      await existing.repository.close();
    }
  });

  it("[ADR-0188] keeps the old ruleset when only the data classification drops, because the prompt and tools stay the same", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first", { hasHistory: true }));
      const lowered = await resource.service.resolve(
        input("second", { request: { dataClassification: "public" } }),
      );
      expect(lowered).toMatchObject({ generation: 2, redactionRuleset: EGRESS_RULESET_CURRENT });
      expect(rulesetOf(resource, 2)).toBe(EGRESS_RULESET_CURRENT);
      expect(resource.rows().map(({ origin }) => origin)).toEqual([
        "rollout",
        "classification_lower",
      ]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[ADR-0188] upgrades the ruleset when the data classification drops together with a change to the tools", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first", { hasHistory: true }));
      const changed = await resource.service.resolve(
        input("second", {
          toolNames: ["read", "memory_recall", "web_search"],
          request: { dataClassification: "public" },
        }),
      );
      expect(changed).toMatchObject({ generation: 2, redactionRuleset: EGRESS_RULESET_CURRENT });
      expect(rulesetOf(resource, 2)).toBe(EGRESS_RULESET_CURRENT);
    } finally {
      await resource.repository.close();
    }
  });

  const storeRuleset = (databasePath: string, sql: string) => {
    const writer = openQualifiedDatabase(databasePath);
    try {
      writer.exec(sql);
    } finally {
      writer.close();
    }
  };

  it("[ADR-0188][I-129] reads a bundle saved before the field existed as the old ruleset and moves it to the current one once", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first"));
      storeRuleset(
        resource.databasePath,
        "UPDATE thread_prompt_bundles SET identity_json = json_remove(identity_json, '$.redactionRuleset')",
      );
      const again = await resource.service.resolve(input("second"));
      expect(again).toMatchObject({ generation: 2, redactionRuleset: EGRESS_RULESET_CURRENT });
      const third = await resource.service.resolve(input("third"));
      expect(third).toMatchObject({ generation: 2, redactionRuleset: EGRESS_RULESET_CURRENT });
      expect(resource.rows().map(({ origin }) => origin)).toEqual([
        "new_thread",
        "rebuild_requested",
      ]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[I-129] moves a conversation still masking card and identity numbers to the current ruleset on its next turn, once", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first"));
      storeRuleset(
        resource.databasePath,
        "UPDATE thread_prompt_bundles SET identity_json = json_set(identity_json, '$.redactionRuleset', 2)",
      );
      const pinned = await resource.service.resolve(input("first"));
      expect(pinned).toMatchObject({ generation: 1, redactionRuleset: 2 });
      const next = await resource.service.resolve(input("second"));
      expect(next).toMatchObject({ generation: 2, redactionRuleset: EGRESS_RULESET_CURRENT });
      const after = await resource.service.resolve(input("third"));
      expect(after?.generation).toBe(2);
      expect(rulesetOf(resource, 2)).toBe(EGRESS_RULESET_CURRENT);
      expect(resource.traces).toHaveLength(1);
    } finally {
      await resource.repository.close();
    }
  });

  it("pins a Run to its generation and renews the next Run once when the tool set changes, keeping the old row and a trace", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first"));
      const withSearch = ["read", "memory_recall", "web_search"];
      const pinned = await resource.service.resolve(
        input("first", { toolNames: withSearch, systemPrompt: "规则第二版" }),
      );
      expect(pinned).toMatchObject({ generation: 1, systemPrompt: "规则第一版" });
      const renewed = await resource.service.resolve(
        input("second", { toolNames: withSearch, systemPrompt: "规则第二版" }),
      );
      expect(renewed).toMatchObject({ generation: 2, systemPrompt: "规则第二版" });
      expect(JSON.parse(renewed?.tools ?? "[]").map(({ name }: { name: string }) => name)).toEqual(
        withSearch,
      );
      expect(resource.rows()).toEqual([
        expect.objectContaining({ generation: 1, supersededAt: NOW }),
        expect.objectContaining({ generation: 2, origin: "tool_set_changed", supersededAt: null }),
      ]);
      expect(resource.traces).toEqual([
        expect.objectContaining({
          eventType: PROMPT_BUNDLE_INVALIDATED_EVENT,
          runId: runId("second"),
          payload: { reason: "tool_set_changed", previousGeneration: 1, generation: 2 },
        }),
      ]);
      const resumed = await resource.service.resolve(
        input("second", {
          toolNames: withSearch,
          systemPrompt: "规则第三版",
          request: { continuationRef: "continuation-second" },
        }),
      );
      expect(resumed).toEqual(renewed);
    } finally {
      await resource.repository.close();
    }
  });

  it("[tool-schema] renews once when a frozen tool's parameter structure changes and keeps the new generation afterwards", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first"));
      const changed = {
        ...READ_PARAMETERS,
        properties: { ...READ_PARAMETERS.properties, encoding: { type: "string" } },
        required: ["path", "encoding"],
      };
      const renewed = await resource.service.resolve(
        input("second", { readParameters: changed, systemPrompt: "规则第二版" }),
      );
      expect(renewed).toMatchObject({ generation: 2, systemPrompt: "规则第二版" });
      expect(JSON.parse(renewed?.tools ?? "[]")[0].parameters).toEqual(changed);
      const next = await resource.service.resolve(
        input("third", { readParameters: changed, systemPrompt: "规则第三版" }),
      );
      expect(next).toEqual(renewed);
      expect(resource.rows().map(({ generation, origin }) => [generation, origin])).toEqual([
        [1, "new_thread"],
        [2, "tool_schema_changed"],
      ]);
      expect(resource.traces).toEqual([
        expect.objectContaining({
          eventType: PROMPT_BUNDLE_INVALIDATED_EVENT,
          runId: runId("second"),
          payload: { reason: "tool_schema_changed", previousGeneration: 1, generation: 2 },
        }),
      ]);
    } finally {
      await resource.repository.close();
    }
  });

  it("[tool-schema] keeps the frozen bundle when only descriptions, titles or key order change, but not when a parameter named description is added", async () => {
    const resource = await fixture();
    try {
      const first = await resource.service.resolve(input("first"));
      const reworded = await resource.service.resolve(
        input("second", {
          readDescription: "读取工作区里的一个文件（新说明）",
          readParameters: {
            additionalProperties: false,
            required: ["path"],
            title: "读文件参数",
            properties: {
              limit: { description: "行数上限（新说明）", minimum: 1, type: "integer" },
              path: { description: "工作区内的相对路径（新说明）", type: "string" },
            },
            type: "object",
          },
        }),
      );
      expect(reworded).toEqual(first);
      const reordered = await resource.service.resolve(
        input("third", {
          readParameters: {
            properties: {
              limit: { minimum: 1, type: "integer" },
              path: { type: "string" },
            },
            type: "object",
            additionalProperties: false,
            required: ["path"],
          },
        }),
      );
      expect(reordered).toEqual(first);
      expect(resource.rows()).toEqual([
        expect.objectContaining({ generation: 1, origin: "new_thread" }),
      ]);
      expect(resource.traces).toEqual([]);
      const withDescriptionParameter = await resource.service.resolve(
        input("fourth", {
          readParameters: {
            ...READ_PARAMETERS,
            properties: { ...READ_PARAMETERS.properties, description: { type: "string" } },
          },
        }),
      );
      expect(withDescriptionParameter).toMatchObject({ generation: 2 });
      expect(resource.rows().map(({ generation, origin }) => [generation, origin])).toEqual([
        [1, "new_thread"],
        [2, "tool_schema_changed"],
      ]);
    } finally {
      await resource.repository.close();
    }
  });

  it("renews once on a model change, a lower classification and an explicit rebuild", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first"));
      await resource.service.resolve(input("second", { modelRef: "model-other" }));
      await resource.service.resolve(
        input("third", { modelRef: "model-other", request: { dataClassification: "public" } }),
      );
      const database = openQualifiedDatabase(resource.databasePath);
      try {
        requestThreadPromptRebuild(database, {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          threadId: THREAD_ID,
          reason: "安全修复：更新身份说明",
          operator: "andy",
          now: NOW,
        });
      } finally {
        database.close();
      }
      await resource.service.resolve(
        input("fourth", { modelRef: "model-other", request: { dataClassification: "public" } }),
      );
      await resource.service.resolve(
        input("fifth", { modelRef: "model-other", request: { dataClassification: "private" } }),
      );
      expect(resource.rows().map(({ generation, origin }) => [generation, origin])).toEqual([
        [1, "new_thread"],
        [2, "model_changed"],
        [3, "classification_lower"],
        [4, "rebuild_requested"],
      ]);
      expect(resource.rows()[2]).toMatchObject({
        rebuildReason: "安全修复：更新身份说明",
        rebuildOperator: "andy",
        supersededAt: NOW,
      });
      expect(resource.traces.map(({ payload }) => payload)).toEqual([
        { reason: "model_changed", previousGeneration: 1, generation: 2 },
        { reason: "classification_lower", previousGeneration: 2, generation: 3 },
        {
          reason: "rebuild_requested",
          previousGeneration: 3,
          generation: 4,
          rebuildReason: "安全修复：更新身份说明",
          rebuildOperator: "andy",
        },
      ]);
    } finally {
      await resource.repository.close();
    }
  });

  it("creates exactly one generation when two first Runs of a conversation resolve together", async () => {
    const resource = await fixture();
    try {
      const results = await Promise.all([
        resource.service.resolve(input("first")),
        resource.service.resolve(input("second", { systemPrompt: "另一个进程拼出的文字" })),
      ]);
      expect(resource.rows()).toHaveLength(1);
      expect(results[0]).toEqual(results[1]);
    } finally {
      await resource.repository.close();
    }
  });

  it("stores nothing for a Run without a conversation or a Run resumed from before the rollout", async () => {
    const resource = await fixture();
    try {
      expect(
        await resource.service.resolve(input("first", { request: { threadId: null } })),
      ).toBeUndefined();
      expect(
        await resource.service.resolve(
          input("second", { request: { continuationRef: "continuation-before-rollout" } }),
        ),
      ).toBeUndefined();
      expect(resource.rows()).toEqual([]);
    } finally {
      await resource.repository.close();
    }
  });

  it("refuses a rebuild for a conversation without a bundle", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    try {
      expect(() =>
        requestThreadPromptRebuild(database, {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          threadId: THREAD_ID,
          reason: "无记录",
          operator: "andy",
          now: NOW,
        }),
      ).toThrow("THREAD_PROMPT_BUNDLE_NOT_FOUND");
    } finally {
      database.close();
      await resource.repository.close();
    }
  });

  it("deletes every generation and its payloads together with the conversation", async () => {
    const resource = await fixture();
    try {
      await resource.service.resolve(input("first"));
      await resource.service.resolve(input("second", { modelRef: "model-other" }));
      expect(resource.count("SELECT COUNT(*) FROM thread_prompt_bundles")).toBe(2);
      await resource.repository.close();
      const deletion = new SqliteGovernedDeletionAdapter({
        stateRoot: resource.stateRoot,
        databasePath: resource.databasePath,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        now: () => NOW,
      });
      await deletion.deleteImmediately({ objectType: "thread", objectId: THREAD_ID });
      expect(resource.count("SELECT COUNT(*) FROM thread_prompt_bundles")).toBe(0);
      expect(
        resource.count("SELECT COUNT(*) FROM payloads WHERE ref LIKE 'thread-prompt-bundle-%'"),
      ).toBe(0);
    } finally {
      await resource.repository.close().catch(() => undefined);
    }
  });
});
