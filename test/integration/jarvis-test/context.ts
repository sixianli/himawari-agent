import { createHash } from "node:crypto";
import path from "node:path";
import {
  ContextFormationService,
  DurableMemoryService,
  type MemoryPort,
  modelVisibleClassifications,
  type OwnerProfilePort,
  OwnerProfileService,
  SessionTraceRecorder,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import { type Embedder, HybridMemoryProvider, indexTerms } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { vi } from "vitest";
import type { CaseMemory, JarvisCase, JarvisDataset } from "./cases.ts";

export const OWNER_ID = createOwnerId("owner-ai-gateway-live-qualification");
export const AGENT_ID = createAgentId("agent-ai-gateway-live-qualification");
export const MEMORY_LIMIT = 10;
const THREAD_ID = createThreadId("thread-jarvis-test");
const GENERATION_ID = createMemoryGenerationId("generation-jarvis-test");
const HASH_DIMENSIONS = 256;

class TermHashEmbedder implements Embedder {
  embedQuery(query: string): Promise<Float32Array> {
    return this.embed(query);
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  readonly model = "jarvis-test-term-hash";
  readonly dimensions = HASH_DIMENSIONS;

  async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(HASH_DIMENSIONS);
    for (const term of indexTerms(text)) {
      let hash = 2166136261;
      for (const character of term)
        hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
      const slot = (hash >>> 0) % HASH_DIMENSIONS;
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }
}

function contentRef(memory: CaseMemory): string {
  return `payload-${memory.id}`;
}

export function caseMemories(dataset: JarvisDataset, item: JarvisCase): readonly CaseMemory[] {
  return [...dataset.sharedMemories, ...(item.memories ?? [])];
}

export async function assembleContext(
  dataset: JarvisDataset,
  item: JarvisCase,
  stateRoot: string,
  runId = createRunId(`run-jarvis-${item.id}`),
) {
  const memories = caseMemories(dataset, item);
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
    .run(THREAD_ID, OWNER_ID, AGENT_ID, dataset.today, dataset.today);
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
      encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
      'active', ?, 'text/plain')`,
  );
  for (const memory of memories)
    insertPayload.run(contentRef(memory), OWNER_ID, AGENT_ID, `sha256:${memory.id}`, dataset.today);
  database
    .prepare(
      `INSERT INTO thread_checkpoint_jobs (
        id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
        policy_version, status, attempt_count, requested_at
      ) VALUES ('checkpoint-jarvis-test', ?, ?, ?, ?, 1, 1,
        'memory-policy-v1', 'completed', 1, ?)`,
    )
    .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, dataset.today);
  database
    .prepare(
      `INSERT INTO memory_generations (
        id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
        model_descriptor_ref, policy_version, output_ref
      ) VALUES (?, 'checkpoint-jarvis-test', ?, ?, ?, 'completed',
        'model-memory-fixture', 'memory-policy-v1', NULL)`,
    )
    .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
  database.close();

  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now: () => dataset.today,
  });
  const clock = new ManualClock(dataset.today);
  const adapters = createReferenceAdapterSet({
    clock,
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
  });
  const texts = new Map(memories.map((memory) => [contentRef(memory), memory.text]));
  const storeText = async (ref: string, text: string) => {
    texts.set(ref, text);
    if (await adapters.payload.get(ref)) return;
    await adapters.payload.put(
      await adapters.payloadProtector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref,
        contentType: "text/plain",
        dataClassification: "private",
        plaintext: new TextEncoder().encode(text),
        createdAt: dataset.today,
      }),
    );
  };
  for (const memory of memories) await storeText(contentRef(memory), memory.text);
  const queryRef = `query-${item.id}`;
  const promptRef = `trigger-${item.id}`;
  await storeText(queryRef, item.prompt);
  await storeText(promptRef, item.prompt);
  const providerNow = vi.fn(() => dataset.today);
  const provider = new HybridMemoryProvider({
    index: repository.memoryIndex(),
    embedder: new TermHashEmbedder(),
    embeddableClassifications: ["public", "private"],
    now: providerNow,
    timeZone: dataset.timeZone,
  });
  let memoryClock = dataset.today;
  const durable = new DurableMemoryService({
    state: repository.productMemoryState(),
    jobs: repository.memoryProjectionJobs(),
    provider,
    content: {
      readText: async (ref) => {
        const text = texts.get(ref);
        if (text === undefined) throw new Error(`JARVIS_CONTENT_MISSING:${ref}`);
        return text;
      },
    },
    workerId: "jarvis-test",
    now: () => memoryClock,
    maximumProjectionAttempts: 1,
    projectionLeaseMs: 60_000,
  });
  for (const memory of [...memories].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt),
  )) {
    memoryClock = memory.recordedAt;
    await durable.applyProposal(
      {
        decision: "create",
        memory: {
          id: createMemoryId(memory.id),
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          contentRef: contentRef(memory),
          dataClassification: "private",
          sourceThreadId: THREAD_ID,
          sourceRefs: [`message-${memory.id}`],
          inference: false,
          confidencePermille: 950,
          policyVersion: "memory-capture:v3",
          attributes: {
            category: memory.category,
            importancePermille: memory.importance,
            entities: memory.entities ?? [],
            validFrom: memory.validFrom ?? memory.recordedAt,
            validTo: null,
            supersededBy: null,
            evidenceVerified: true,
          },
        },
        ...(memory.supersedes ? { supersedes: createMemoryId(memory.supersedes) } : {}),
      },
      GENERATION_ID,
    );
  }
  memoryClock = dataset.today;
  while ((await durable.runProjectionBatch(100)).length > 0);

  const ownerProfile = new OwnerProfileService({
    state: repository.productMemoryState(),
    reminders: repository.memoryReminders(),
    readText: async (record) => texts.get(record.contentRef),
    storeText: (input) => storeText(input.ref, input.text),
    digest: (text) => createHash("sha256").update(text).digest("hex"),
    timeZone: dataset.timeZone,
  });
  const profileNow: string[] = [];
  const profile: OwnerProfilePort = {
    compose: async (input) => {
      profileNow.push(input.now);
      return ownerProfile.compose(input);
    },
  };
  const memory: Pick<MemoryPort, "search"> = {
    search: async (request) =>
      (
        await durable.search({
          ownerId: request.ownerId,
          agentId: request.agentId,
          queryRef: request.queryRef,
          policy: { limit: request.limit, allowedClassifications: modelVisibleClassifications() },
        })
      ).map(({ memory: found, score }) => ({
        id: found.id,
        ownerId: found.ownerId,
        agentId: found.agentId,
        contentRef: found.contentRef,
        sourceRef: found.sourceRefs[0] ?? found.id,
        searchTerms: [],
        dataClassification: found.dataClassification,
        updatedAt: found.updatedAt,
        score,
      })),
  };
  const context = new ContextFormationService({
    profile,
    memory,
    trace: new SessionTraceRecorder({
      trace: adapters.trace,
      artifacts: adapters.runPayloadArtifacts,
      protector: adapters.payloadProtector,
      audit: adapters.audit,
      clock,
      ids: adapters.ids,
    }),
    artifacts: adapters.runPayloadArtifacts,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    clock,
    ids: adapters.ids,
  });
  const sessionId = createSessionId(`session-jarvis-${item.id}`);
  const formed = await context.form({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    sessionId,
    threadId: null,
    runId,
    trigger: {
      id: `trigger-jarvis-${item.id}`,
      sourceType: "user_message",
      payloadRef: promptRef,
      occurredAt: dataset.today,
    },
    threadMessages: [],
    sourceWatermark: null,
    policyVersion: "jarvis-test-context-v1",
    policies: [],
    memoryQueryRef: queryRef,
    memoryQueryTerms: indexTerms(item.prompt),
    memoryLimit: MEMORY_LIMIT,
    capabilities: [],
    correlationId: `correlation-jarvis-${item.id}` as never,
    causationId: `cause-jarvis-${item.id}`,
    parentEventId: null,
    actorId: "jarvis-test",
    dataClassification: "private",
  });
  await repository.close?.();
  const material = formed.injectedContentRefs
    .map((ref) => texts.get(ref))
    .filter((text): text is string => text !== undefined)
    .join("\n");
  return { formed, material, profileNow, providerNow, adapters, clock, runId, sessionId };
}
