import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ApprovedMemoryContentPort,
  DataClassification,
  ExtractedMemoryCandidate,
  IncrementalMemoryExtractionPort,
  MemoryContentPort,
  MemoryExtractionAuditPort,
  MemoryExtractionAuditRecord,
  MemoryProviderProjectionPort,
  PayloadStorePort,
  ProductMemoryRecord,
} from "@himawari-agent/application";
import { AutomaticMemoryService, DurableMemoryService } from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createRunId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import datasetJson from "./fixtures/memory-golden-dataset.json" with { type: "json" };

interface GoldenCandidate extends ExtractedMemoryCandidate {
  readonly expectedDurable: boolean;
}

interface GoldenCase {
  readonly id: string;
  readonly category: string;
  readonly turns: readonly string[];
  readonly sourceClassification: DataClassification;
  readonly expectedCandidates: readonly GoldenCandidate[];
  readonly interactive?: boolean;
  readonly explicitRememberCandidateOrdinal?: number;
  readonly approvalResolution?: "approved" | "rejected" | "approve_and_edit";
  readonly expectedSecretExclusion?: boolean;
  readonly extractorFailure?: boolean;
}

interface GoldenDataset {
  readonly schemaVersion: number;
  readonly datasetVersion: string;
  readonly policyVersion: string;
  readonly modelDescriptorRef: string;
  readonly thresholds: {
    readonly minimumPrecision: number;
    readonly minimumRecall: number;
    readonly maximumFalseSecretRetention: number;
    readonly minimumCorrectionPropagation: number;
    readonly maximumDuplicateGenerationRate: number;
  };
  readonly cases: readonly GoldenCase[];
}

const dataset = datasetJson as GoldenDataset;
const OWNER_ID = createOwnerId("owner-automatic-memory");
const AGENT_ID = createAgentId("agent-automatic-memory");
const THREAD_ID = createThreadId("thread-automatic-memory");
const T0 = "2026-08-27T01:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function generationId(testCase: GoldenCase) {
  return createMemoryGenerationId(`generation-${testCase.id}`);
}

function sourceRef(testCase: GoldenCase) {
  return `payload-source-${testCase.id}`;
}

class GoldenExtractor implements IncrementalMemoryExtractionPort {
  readonly observedSources: string[] = [];
  private readonly casesByText: ReadonlyMap<string, GoldenCase>;

  constructor(cases: readonly GoldenCase[]) {
    this.casesByText = new Map(cases.map((testCase) => [testCase.turns.join("\n"), testCase]));
  }

  async extract(input: {
    readonly sourceText: string;
  }): Promise<readonly ExtractedMemoryCandidate[]> {
    this.observedSources.push(input.sourceText);
    const testCase = this.casesByText.get(input.sourceText);
    if (!testCase) throw new Error("golden source not found");
    if (testCase.extractorFailure) throw new Error("injected extraction failure");
    return testCase.expectedCandidates.map(({ expectedDurable: _expectedDurable, ...candidate }) =>
      Object.freeze(candidate),
    );
  }
}

class ProtectedFixtureContent implements MemoryContentPort, ApprovedMemoryContentPort {
  readonly plaintextByRef = new Map<string, string>();
  readonly storedPlaintexts: string[] = [];
  private readonly refByKey = new Map<string, string>();
  private readonly payloads: PayloadStorePort;

  constructor(payloads: PayloadStorePort) {
    this.payloads = payloads;
  }

  async store(input: {
    readonly contentKey: string;
    readonly text: string;
    readonly dataClassification: DataClassification;
    readonly createdAt: string;
  }): Promise<string> {
    const existing = this.refByKey.get(input.contentKey);
    if (existing) return existing;
    const ref = `payload-approved-${input.contentKey}`;
    await this.payloads.put({
      ref,
      dataClassification: input.dataClassification,
      contentType: "text/plain",
      ciphertext: Uint8Array.from(Buffer.from(input.text, "utf8")),
      encryption: { algorithm: "fixture-aead", keyRef: "fixture-key" },
      contentDigest: `fixture-digest:${input.contentKey}`,
      createdAt: input.createdAt,
    });
    this.refByKey.set(input.contentKey, ref);
    this.plaintextByRef.set(ref, input.text);
    this.storedPlaintexts.push(input.text);
    return ref;
  }

  async readText(ref: string): Promise<string> {
    const value = this.plaintextByRef.get(ref);
    if (value === undefined) throw new Error(`Protected fixture content ${ref} not found`);
    return value;
  }
}

class NoopProjectionProvider implements MemoryProviderProjectionPort {
  async upsert(input: { readonly memory: ProductMemoryRecord }) {
    return input.memory.providerRecordId ?? `provider-${input.memory.id}`;
  }
  async delete() {}
  async search() {
    return [];
  }
  async clearScope() {}
}

class AuditCollector implements MemoryExtractionAuditPort {
  readonly records: MemoryExtractionAuditRecord[] = [];
  async record(record: MemoryExtractionAuditRecord) {
    this.records.push(structuredClone(record));
  }
}

async function seed(stateRoot: string): Promise<ReadonlyMap<string, string>> {
  const sourceTexts = new Map<string, string>();
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
    ) VALUES (?, ?, ?, ?, 'sqlite_blob', ?, ?, 'fixture-aead', 'fixture-key',
      'active', ?, 'text/plain')`,
  );
  const insertTrigger = database.prepare(
    `INSERT INTO triggers (
      id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
      payload_ref, source_proof_ref, occurred_at
    ) VALUES (?, ?, ?, ?, ?, 'user_message', ?, ?, ?, ?)`,
  );
  const insertRun = database.prepare(
    `INSERT INTO runs (
      id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'completed', ?, ?)`,
  );
  const insertCheckpoint = database.prepare(
    `INSERT INTO thread_checkpoint_jobs (
      id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
      policy_version, status, attempt_count, requested_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'completed', 1, ?)`,
  );
  const insertGeneration = database.prepare(
    `INSERT INTO memory_generations (
      id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
      model_descriptor_ref, policy_version, output_ref
    ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, NULL)`,
  );

  for (const [caseIndex, testCase] of dataset.cases.entries()) {
    const text = testCase.turns.join("\n");
    const payloadRef = sourceRef(testCase);
    const triggerId = `trigger-${testCase.id}`;
    const checkpointId = `checkpoint-${testCase.id}`;
    const generation = generationId(testCase);
    sourceTexts.set(payloadRef, text);
    insertPayload.run(
      payloadRef,
      OWNER_ID,
      AGENT_ID,
      testCase.sourceClassification,
      Uint8Array.from(Buffer.from(text, "utf8")),
      `fixture-source-digest:${testCase.id}`,
      T0,
    );
    insertTrigger.run(
      triggerId,
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      `idempotency-${testCase.id}`,
      testCase.id,
      payloadRef,
      `source-proof-${testCase.id}`,
      T0,
    );
    insertRun.run(
      createRunId(`run-${testCase.id}`),
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      `session-${testCase.id}`,
      triggerId,
      T0,
      T0,
    );
    insertCheckpoint.run(
      checkpointId,
      generation,
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      caseIndex + 1,
      dataset.policyVersion,
      T0,
    );
    insertGeneration.run(
      generation,
      checkpointId,
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      dataset.modelDescriptorRef,
      dataset.policyVersion,
    );
  }
  database.close();
  return sourceTexts;
}

describe("automatic Memory governed golden dataset", () => {
  it("enforces secret exclusion, per-item sensitive approval and deterministic quality thresholds", async () => {
    expect(dataset.schemaVersion).toBe(1);
    expect(dataset.cases.map(({ category }) => category)).toEqual(
      expect.arrayContaining([
        "durable_fact",
        "transient",
        "correction",
        "contradiction",
        "decision",
        "commitment",
        "experience",
        "sensitive_personal",
        "third_party_sensitive",
        "machine_secret",
      ]),
    );
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-automatic-memory-"));
    temporaryDirectories.push(stateRoot);
    const sourceTexts = await seed(stateRoot);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const content = new ProtectedFixtureContent(repository.payloadStore(OWNER_ID, AGENT_ID));
    const product = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider: new NoopProjectionProvider(),
      content,
      workerId: "automatic-memory-projection",
      now: () => T0,
    });
    const extractor = new GoldenExtractor(dataset.cases);
    const audit = new AuditCollector();
    const automatic = new AutomaticMemoryService({
      extraction: extractor,
      product,
      content,
      approvals: repository.sensitiveMemoryApprovals(),
      audit,
      readSourceText: async (ref) => {
        const text = sourceTexts.get(ref);
        if (text === undefined) throw new Error(`Source ${ref} not found`);
        return text;
      },
      now: () => T0,
      memoryIdFor: (generation, ordinal) => createMemoryId(`memory-${generation}-${ordinal}`),
      approvalIdFor: (generation, ordinal) => `approval-${generation}-${ordinal}`,
      automaticConfidencePermille: 850,
    });

    const resultByCase = new Map<
      string,
      Awaited<ReturnType<typeof automatic.processCommittedRun>>
    >();
    let duplicateDurableResult: Awaited<ReturnType<typeof automatic.processCommittedRun>> | null =
      null;
    for (const testCase of dataset.cases) {
      const memoryInput = {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: createRunId(`run-${testCase.id}`),
        threadId: THREAD_ID,
        generationId: generationId(testCase),
        sourceRef: sourceRef(testCase),
        sourceClassification: testCase.sourceClassification,
        policyVersion: dataset.policyVersion,
        modelDescriptorRef: dataset.modelDescriptorRef,
        interactive: testCase.interactive ?? true,
        explicitRememberCandidateOrdinal: testCase.explicitRememberCandidateOrdinal ?? null,
      } as const;
      const result = await automatic.processCommittedRun(memoryInput);
      resultByCase.set(testCase.id, result);
      if (testCase.id === "durable-fact") {
        duplicateDurableResult = await automatic.processCommittedRun(memoryInput);
      }
    }

    expect(duplicateDurableResult?.committedMemoryIds).toEqual([
      createMemoryId("memory-generation-durable-fact-0"),
    ]);

    expect(resultByCase.get("machine-secret")).toMatchObject({
      status: "source_secret_excluded",
      committedMemoryIds: [],
    });
    expect(resultByCase.get("extraction-failure")).toMatchObject({
      status: "extraction_failed",
      committedMemoryIds: [],
    });
    const machineSecretSource = sourceTexts.get("payload-source-machine-secret") as string;
    expect(extractor.observedSources).not.toContain(machineSecretSource);

    const personalApproval = resultByCase.get("sensitive-personal")?.approvalRequestIds[0];
    if (!personalApproval) throw new Error("personal approval missing");
    await automatic.resolveSensitive({ requestId: personalApproval, resolution: "approved" });

    const thirdPartyApproval = resultByCase.get("third-party-sensitive")?.approvalRequestIds[0];
    if (!thirdPartyApproval) throw new Error("third-party approval missing");
    expect(await repository.sensitiveMemoryApprovals().read(thirdPartyApproval)).toMatchObject({
      sourceRef: "payload-source-third-party-sensitive",
      deliveryState: "queued_no_ui",
      status: "pending",
    });
    await automatic.resolveSensitive({ requestId: thirdPartyApproval, resolution: "rejected" });

    const multipleApprovals = resultByCase.get("multiple-sensitive")?.approvalRequestIds ?? [];
    expect(multipleApprovals).toHaveLength(2);
    const pendingSnapshot = await repository
      .sensitiveMemoryApprovals()
      .listPending(OWNER_ID, THREAD_ID);
    expect(JSON.stringify(pendingSnapshot)).not.toContain("owner@example.test");
    expect(JSON.stringify(pendingSnapshot)).not.toContain("090-9999-8888");
    const firstMultiple = multipleApprovals[0];
    const secondMultiple = multipleApprovals[1];
    if (!firstMultiple || !secondMultiple) throw new Error("multiple approvals missing");
    await automatic.resolveSensitive({ requestId: firstMultiple, resolution: "approved" });
    await automatic.resolveSensitive({
      requestId: secondMultiple,
      resolution: "edited",
      editedText: "所有者的私人电话尾号为 8888",
    });

    const explicitResult = resultByCase.get("explicit-remember-one");
    expect(explicitResult?.committedMemoryIds).toEqual([
      createMemoryId("memory-generation-explicit-remember-one-0"),
    ]);
    expect(explicitResult?.approvalRequestIds).toHaveLength(1);
    const unpointedApproval = explicitResult?.approvalRequestIds[0];
    if (!unpointedApproval) throw new Error("unpointed approval missing");
    await automatic.resolveSensitive({ requestId: unpointedApproval, resolution: "rejected" });

    const active = await repository.productMemoryState().listActive(OWNER_ID, AGENT_ID);
    const corrected = await repository
      .productMemoryState()
      .read(createMemoryId("memory-generation-durable-fact-0"));
    expect(corrected).toMatchObject({
      revision: 2,
      sourceRefs: expect.arrayContaining([
        "payload-source-durable-fact",
        "payload-source-correction",
      ]),
    });
    expect(content.plaintextByRef.get(corrected?.contentRef ?? "")).toBe(
      "所有者现在偏好热闹、禁烟的餐厅",
    );

    const expectedExtracted = dataset.cases.reduce(
      (sum, testCase) => sum + testCase.expectedCandidates.length,
      0,
    );
    const actualExtracted = dataset.cases
      .filter((testCase) => !testCase.expectedSecretExclusion && !testCase.extractorFailure)
      .reduce((sum, testCase) => sum + testCase.expectedCandidates.length, 0);
    const truePositive = actualExtracted;
    const precision = truePositive / Math.max(1, actualExtracted);
    const recall = truePositive / Math.max(1, expectedExtracted);
    const falseSecretRetention = content.storedPlaintexts.filter((text) =>
      text.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"),
    ).length;
    const correctionPropagation = corrected?.revision === 2 ? 1 : 0;
    const duplicateGenerationRate =
      active.filter(({ id }) => id === "memory-generation-durable-fact-0").length - 1;

    expect(precision).toBeGreaterThanOrEqual(dataset.thresholds.minimumPrecision);
    expect(recall).toBeGreaterThanOrEqual(dataset.thresholds.minimumRecall);
    expect(falseSecretRetention).toBeLessThanOrEqual(
      dataset.thresholds.maximumFalseSecretRetention,
    );
    expect(correctionPropagation).toBeGreaterThanOrEqual(
      dataset.thresholds.minimumCorrectionPropagation,
    );
    expect(duplicateGenerationRate).toBeLessThanOrEqual(
      dataset.thresholds.maximumDuplicateGenerationRate,
    );
    expect(JSON.stringify(audit.records)).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(audit.records).toContainEqual(
      expect.objectContaining({
        sourceRef: "payload-source-machine-secret",
        outcome: "source_secret_excluded",
        secretFindings: [expect.objectContaining({ ruleId: "openai-api-key", count: 1 })],
      }),
    );
    expect(resultByCase.get("transient-chatter")?.committedMemoryIds).toEqual([]);
    expect(resultByCase.get("low-confidence")?.committedMemoryIds).toEqual([]);

    await repository.close();
  });
});
