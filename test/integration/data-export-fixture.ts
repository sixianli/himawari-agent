import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  LATEST_MIGRATION_SEQUENCE,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import type Database from "better-sqlite3";

export const T0 = "2026-11-01T00:00:00.000Z";
export const SECRET_BANK_CARD = "6222021234567890123";
export const SECRET_PASSWORD = "Zk9#vQ2mLp8Rtx";
export const SECRET_API_KEY = `sk-proj-${"AbCdEf0123456789"}GhIjKlMnOp`;
export const SECRET_MAIL_BODY = "第三方邮件正文：请把合同发给 stranger@example.org 并保密";
export const SECRETS = [SECRET_BANK_CARD, SECRET_PASSWORD, SECRET_API_KEY];

export const PAYLOAD_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

export interface Side {
  readonly database: Database.Database;
  readonly ownerId: ReturnType<typeof createOwnerId>;
  readonly agentId: ReturnType<typeof createAgentId>;
  readonly protector: EnvelopePayloadProtector;
  readonly migrationSequence: number;
  readonly directory: string;
}

export function newProtector(): EnvelopePayloadProtector {
  return new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "payload-kek@v1": PAYLOAD_KEY }),
    activeKey: { keyRef: "payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
  });
}

export async function openSide(suffix: string): Promise<Side> {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-data-export-"));
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  const ownerId = createOwnerId(`owner-export-${suffix}`);
  const agentId = createAgentId(`agent-export-${suffix}`);
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  return {
    database,
    ownerId,
    agentId,
    protector: newProtector(),
    migrationSequence: LATEST_MIGRATION_SEQUENCE,
    directory,
  };
}

export async function putPayload(
  side: Side,
  ref: string,
  text: string,
  classification: "public" | "private" | "sensitive" | "restricted" = "private",
  contentType = "text/plain",
): Promise<string> {
  const record = await side.protector.protect({
    ownerId: side.ownerId,
    agentId: side.agentId,
    ref,
    dataClassification: classification,
    contentType,
    plaintext: new TextEncoder().encode(text),
    createdAt: T0,
  });
  side.database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type,
        encryption_metadata_json
      ) VALUES (?, ?, ?, ?, 'sqlite_blob', ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(
      ref,
      side.ownerId,
      side.agentId,
      classification,
      record.ciphertext,
      record.contentDigest,
      record.encryption.algorithm,
      record.encryption.keyRef,
      T0,
      contentType,
      JSON.stringify(record.encryption),
    );
  return ref;
}

interface MemorySeed {
  readonly id: string;
  readonly text: string;
  readonly status?: string;
  readonly classification?: "public" | "private" | "sensitive" | "restricted";
  readonly category?: string;
  readonly tentative?: boolean;
  readonly recordedAt?: string;
  readonly supersededBy?: string | null;
  readonly sensitiveTopic?: string | null;
  readonly batch?: string | null;
  readonly versions?: readonly {
    readonly kind: string;
    readonly text: string;
    readonly at: string;
  }[];
}

export async function seedMemory(side: Side, seed: MemorySeed): Promise<void> {
  const classification = seed.classification ?? "private";
  const contentRef = await putPayload(side, `payload-${seed.id}`, seed.text, classification);
  side.database
    .prepare(
      `INSERT INTO memory_records (
        id, owner_id, agent_id, revision, status, content_ref, classification, inference,
        confidence_permille, policy_version, updated_at, category, importance_permille,
        use_count, evidence_verified, sensitive_topic, recorded_at, tentative, superseded_by,
        import_batch_id, stance, last_used_at, sub_category, valid_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 800, 'memory-policy-v1', ?, ?, 600, 3, 1, ?, ?, ?, ?, ?, 'neutral', ?, 'food', ?)`,
    )
    .run(
      seed.id,
      side.ownerId,
      side.agentId,
      (seed.versions?.length ?? 0) + 1,
      seed.status ?? "active",
      contentRef,
      classification,
      seed.recordedAt ?? T0,
      seed.category ?? "preference",
      seed.sensitiveTopic ?? null,
      seed.recordedAt ?? T0,
      seed.tentative ? 1 : 0,
      seed.supersededBy ?? null,
      seed.batch ?? null,
      T0,
      "2026-01-01",
    );
  const history = side.database.prepare(
    `INSERT INTO memory_history_events (memory_id, kind, content_ref, stance, quote_ref, source_thread_id, source_deleted, occurred_at)
    VALUES (?, ?, ?, 'neutral', ?, NULL, ?, ?)`,
  );
  let index = 0;
  for (const version of seed.versions ?? []) {
    const ref = await putPayload(
      side,
      `payload-${seed.id}-h${index}`,
      version.text,
      classification,
    );
    const quote =
      index === 0
        ? await putPayload(
            side,
            `payload-${seed.id}-q`,
            `主人原话：${version.text}`,
            classification,
          )
        : null;
    history.run(seed.id, version.kind, ref, quote, index === 0 ? 1 : 0, version.at);
    index += 1;
  }
  history.run(seed.id, "reaffirmed", contentRef, null, 0, "2026-11-02T00:00:00.000Z");
  side.database
    .prepare(
      "INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted) VALUES (?, 'reference', ?, 0)",
    )
    .run(seed.id, `message-${seed.id}`);
  side.database
    .prepare("INSERT INTO memory_entities (memory_id, name) VALUES (?, ?)")
    .run(seed.id, `实体-${seed.id}`);
}

export async function seedEverything(side: Side): Promise<void> {
  const db = side.database;
  db.prepare(
    "INSERT INTO memory_import_batches (id, owner_id, agent_id, source, item_count, created_at) VALUES ('batch-1', ?, ?, 'codex', 2, ?)",
  ).run(side.ownerId, side.agentId, T0);
  db.prepare(
    "INSERT INTO memory_people (id, owner_id, agent_id, name, relation, created_at, updated_at) VALUES ('person-1', ?, ?, '小林', '朋友', ?, ?)",
  ).run(side.ownerId, side.agentId, T0, T0);
  db.prepare(
    "INSERT INTO memory_people (id, owner_id, agent_id, name, merged_into, created_at, updated_at) VALUES ('person-2', ?, ?, '林', 'person-1', ?, ?)",
  ).run(side.ownerId, side.agentId, T0, T0);
  db.prepare(
    "INSERT INTO memory_person_aliases (person_id, alias) VALUES ('person-1', '阿林')",
  ).run();
  await seedMemory(side, {
    id: "m-plain",
    text: "喜欢喝无糖美式咖啡",
    versions: [
      { kind: "created", text: "喜欢喝咖啡", at: "2026-11-01T01:00:00.000Z" },
      { kind: "updated", text: "喜欢喝美式咖啡", at: "2026-11-01T02:00:00.000Z" },
    ],
    batch: "batch-1",
  });
  await seedMemory(side, {
    id: "m-topic",
    text: "最近在看牙科，下周复诊",
    classification: "sensitive",
    category: "health",
    sensitiveTopic: "health",
  });
  await seedMemory(side, {
    id: "m-card",
    text: `我的银行卡号是 ${SECRET_BANK_CARD}`,
    classification: "sensitive",
    category: "finance",
    sensitiveTopic: "finance",
  });
  await seedMemory(side, {
    id: "m-pass",
    text: `路由器管理密码是 ${SECRET_PASSWORD}`,
    classification: "sensitive",
  });
  await seedMemory(side, {
    id: "m-key",
    text: `API key ${SECRET_API_KEY} 用于构建`,
    classification: "sensitive",
    category: "project",
  });
  await seedMemory(side, {
    id: "m-archived",
    text: "以前住在大阪",
    status: "archived",
    category: "identity",
    supersededBy: "m-plain",
  });
  await seedMemory(side, { id: "m-trashed", text: "一条被丢进回收站的记忆", status: "trashed" });
  await seedMemory(side, { id: "m-tentative", text: "可能喜欢爵士乐（待确认）", tentative: true });
  await seedMemory(side, {
    id: "m-pending",
    text: "待删内容-唯一标记-Q1",
    status: "deletion_pending",
  });
  await seedMemory(side, {
    id: "m-verified",
    text: "已删内容-唯一标记-Q2",
    status: "deleted_verified",
  });
  await seedMemory(side, {
    id: "m-restricted",
    text: "受限内容-唯一标记-Q3",
    classification: "restricted",
  });
  db.prepare(
    "INSERT INTO memory_person_mentions (memory_id, person_id) VALUES ('m-plain', 'person-1')",
  ).run();
  db.prepare(
    "INSERT INTO memory_profile_pins (memory_id, owner_id, agent_id, pinned, updated_at) VALUES ('m-plain', ?, ?, 1, ?)",
  ).run(side.ownerId, side.agentId, T0);
  db.prepare(
    "INSERT INTO memory_consolidation_runs (id, owner_id, agent_id, day, trigger_run_id, status, model_called, change_count, started_at, finished_at) VALUES ('run-1', ?, ?, '2026-11-01', 'trigger-1', 'completed', 1, 3, ?, ?)",
  ).run(side.ownerId, side.agentId, T0, T0);
  const change = db.prepare(
    `INSERT INTO memory_consolidation_changes (id, consolidation_id, owner_id, agent_id, memory_id, related_memory_id, action, before_revision, after_revision, before_status, created_at)
    VALUES (?, 'run-1', ?, ?, ?, ?, ?, 1, 2, 'active', ?)`,
  );
  change.run("run-1:c1", side.ownerId, side.agentId, "m-archived", "m-plain", "supersede", T0);
  change.run("run-1:c2", side.ownerId, side.agentId, "m-pending", "m-plain", "archive", T0);
  db.prepare(
    "INSERT INTO memory_consolidation_change_basis (change_id, position, memory_id) VALUES ('run-1:c1', 0, 'm-plain'), ('run-1:c1', 1, 'm-pending')",
  ).run();
  db.prepare(
    "INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at) VALUES ('thread-review', ?, ?, 1, 'open', ?, ?)",
  ).run(side.ownerId, side.agentId, T0, T0);
  const review = db.prepare(
    `INSERT INTO memory_conversation_reviews (id, owner_id, agent_id, thread_id, episode_id, episode_created_at, day, status, attempts, output_ref, error_code, started_at, finished_at, undone_at)
    VALUES (?, ?, ?, 'thread-review', ?, ?, '2026-11-01', ?, ?, ?, ?, ?, ?, NULL)`,
  );
  review.run(
    "review-1",
    side.ownerId,
    side.agentId,
    "episode-1",
    T0,
    "completed",
    1,
    "payload-review-output",
    null,
    T0,
    T0,
  );
  review.run(
    "review-2",
    side.ownerId,
    side.agentId,
    "episode-2",
    T0,
    "gave_up",
    3,
    null,
    "MEMORY_REVIEW_OUTPUT_INVALID",
    T0,
    T0,
  );
  const reviewChange = db.prepare(
    `INSERT INTO memory_conversation_review_changes (review_id, memory_id, action, source_message_id, after_revision, before_superseded_by, before_valid_to, created_at)
    VALUES ('review-1', ?, ?, 'message-1', 1, ?, ?, ?)`,
  );
  reviewChange.run("m-plain", "created", null, null, T0);
  reviewChange.run("m-archived", "superseded", null, null, T0);
  reviewChange.run("m-tentative", "confirmed", null, null, T0);
  reviewChange.run("m-pending", "created", null, null, T0);
  db.prepare(
    "UPDATE memory_conversation_review_changes SET undone_revision = 2 WHERE memory_id = 'm-archived'",
  ).run();
  db.prepare(
    `INSERT INTO memory_conversation_review_changes (review_id, memory_id, action, source_message_id, after_revision, before_superseded_by, before_valid_to, created_at)
    VALUES ('review-2', 'm-plain', 'created', 'message-1', NULL, NULL, NULL, ?)`,
  ).run(T0);

  const decision = db.prepare(
    `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code, subject_ref, inputs, reason_ref, content_ref, cost_micros, duration_ms, owner_rating, rated_at, category, confidence_permille, inferred)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const kinds = [
    ["d-proactive", "proactive", "gmail", "pushed", null, "mail_important"],
    ["d-candidate", "memory_candidate", null, null, "kept", "stable_preference"],
    ["d-consolidation", "consolidation", null, null, "supersede", "duplicate"],
    ["d-truncation", "context_truncation", null, null, "truncated", "window_full"],
    ["d-degrade", "retrieval_degrade", null, null, "degraded", "embedder_down"],
    ["d-read", "external_read", null, null, "read", "owner_asked"],
    ["d-rule-review", "rule_review", null, null, "needs_review", "memory_edited"],
  ] as const;
  let index = 0;
  for (const [id, kind, scenario, verdict, outcome, reason] of kinds) {
    const content =
      kind === "memory_candidate"
        ? await putPayload(side, `payload-${id}-content`, "候选记忆：喜欢无糖美式咖啡")
        : null;
    const reasonRef =
      kind === "memory_candidate"
        ? await putPayload(side, `payload-${id}-reason`, "稳定偏好，已多次出现")
        : null;
    decision.run(
      id,
      side.ownerId,
      side.agentId,
      kind,
      scenario,
      `2026-11-0${index + 1}T00:00:00.000Z`,
      JSON.stringify({ considered: 3, kept: 1 }),
      verdict,
      outcome,
      reason,
      `ref-${id}`,
      JSON.stringify({ memoryIds: ["m-plain"], batchId: "batch-1" }),
      reasonRef,
      content,
      1200 + index,
      300 + index,
      kind === "proactive" ? "useful" : null,
      kind === "proactive" ? "2026-11-03T00:00:00.000Z" : null,
      kind === "memory_candidate" ? "preference" : null,
      kind === "memory_candidate" ? 700 : null,
      kind === "memory_candidate" ? 0 : null,
    );
    index += 1;
  }
  db.prepare(
    `INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at)
    VALUES ('sig-1', ?, ?, 'd-proactive', 'opened', '2026-11-01T00:05:00.000Z', 300000, '{"via":"push"}', 'open-1', '2026-11-01T00:05:01.000Z')`,
  ).run(side.ownerId, side.agentId);
  const input = await putPayload(side, "payload-d-input", `{"mail":"${SECRET_MAIL_BODY}"}`);
  const output = await putPayload(side, "payload-d-output", "判断：重要");
  db.prepare(
    "INSERT INTO decision_ledger_payloads (decision_id, sequence, role, payload_ref) VALUES ('d-proactive', 0, 'model_input', ?), ('d-proactive', 1, 'model_output', ?)",
  ).run(input, output);
  const insight = await putPayload(side, "payload-insight", `合同到期提醒 ${SECRET_MAIL_BODY}`);
  db.prepare(
    `INSERT INTO source_insights (id, owner_id, agent_id, source, thread_id, last_message_id, result, floor_raised, content_ref, status, decision_id, created_at, updated_at)
    VALUES ('ins-1', ?, ?, 'gmail', 'gthread-1', 'gmsg-1', 'act', 0, ?, 'open', 'd-proactive', ?, ?)`,
  ).run(side.ownerId, side.agentId, insight, T0, T0);
  const header = await putPayload(
    side,
    "payload-header",
    `From: stranger@example.org Subject: 合同`,
  );
  db.prepare(
    `INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, header_ref, processed_at)
    VALUES (?, ?, 'gmail', 'gmsg-1', 'gthread-1', 'd-proactive', 'act', ?, ?)`,
  ).run(side.ownerId, side.agentId, header, T0);
  const museContent = await putPayload(side, "payload-muse", "Muse 当时提醒了合同");
  db.prepare(
    `INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref, paired_decision_id, recorded_at)
    VALUES ('muse-1', ?, ?, ?, 1, 1, 1, ?, 'd-proactive', ?)`,
  ).run(side.ownerId, side.agentId, T0, museContent, T0);
  const prereview = db.prepare(
    `INSERT INTO decision_prereviews (id, owner_id, agent_id, decision_id, mail_source, message_id, calibration_group, category, status, rating, confidence_permille, history_conflict, failure_code, model_ref, prompt_id, text_digest, data_classification, cost_micros, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'model-a', 'review.prereview@0123456789ab', ?, 'private', ?, 40, ?)`,
  );
  prereview.run(
    "pre-1",
    side.ownerId,
    side.agentId,
    "d-candidate",
    null,
    null,
    "memory_kept",
    "preference",
    "done",
    "useful",
    920,
    0,
    null,
    "a".repeat(64),
    310,
    T0,
  );
  prereview.run(
    "pre-2",
    side.ownerId,
    side.agentId,
    null,
    "gmail",
    "gmsg-1",
    "proactive_silent",
    null,
    "done",
    "missed",
    640,
    1,
    null,
    "b".repeat(64),
    320,
    T0,
  );
  prereview.run(
    "pre-3",
    side.ownerId,
    side.agentId,
    "d-consolidation",
    null,
    null,
    "consolidation",
    null,
    "failed",
    null,
    null,
    null,
    "MODEL_OUTPUT_INVALID",
    "c".repeat(64),
    330,
    T0,
  );
  await seedRules(side);
}

export const RULE_SECRET_PHRASE = SECRET_API_KEY.toLowerCase();

interface RuleVersionSeed {
  readonly ruleId: string;
  readonly parameters: Record<string, unknown>;
  readonly status?: "active" | "retired";
  readonly source: string;
  readonly sourceMemoryId?: string | null;
  readonly reason?: string | null;
  readonly at: string;
}

export function writeRuleVersion(side: Side, seed: RuleVersionSeed): void {
  const db = side.database;
  db.prepare(
    `INSERT INTO rule_book_rules (
      owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, agent_id, rule_id) DO UPDATE SET revision = revision + 1,
      parameters = excluded.parameters, status = excluded.status, source = excluded.source,
      source_memory_id = excluded.source_memory_id, updated_at = excluded.updated_at`,
  ).run(
    side.ownerId,
    side.agentId,
    seed.ruleId,
    JSON.stringify(seed.parameters),
    seed.status ?? "active",
    seed.source,
    seed.sourceMemoryId ?? null,
    seed.at,
  );
  db.prepare(
    `INSERT INTO rule_book_history (
      owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
      change_reason, changed_at
    ) SELECT owner_id, agent_id, rule_id, revision, parameters, status, source,
      source_memory_id, ?, updated_at
    FROM rule_book_rules WHERE owner_id = ? AND agent_id = ? AND rule_id = ?`,
  ).run(seed.reason ?? null, side.ownerId, side.agentId, seed.ruleId);
}

export function ownerRuleParameters(
  type: "mail_must_notify" | "mail_read_whole_thread",
  params: Record<string, readonly string[]>,
  summary: string,
): Record<string, unknown> {
  return { type, params, summary };
}

export async function seedRules(side: Side): Promise<void> {
  writeRuleVersion(side, {
    ruleId: "quiet_hours",
    parameters: { periods: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }] },
    source: "ADR 0106；主人的设置“静默时段”",
    at: "2026-11-01T03:00:00.000Z",
  });
  writeRuleVersion(side, {
    ruleId: "floor_important_sender",
    parameters: { senders: ["smbc.co.jp"] },
    source: "ADR 0106 第 4 条；主人的设置“重要发件人”",
    at: "2026-11-01T03:00:00.000Z",
  });
  writeRuleVersion(side, {
    ruleId: "floor_important_sender",
    parameters: { senders: ["boss@example.com", "smbc.co.jp"] },
    source: "ADR 0106 第 4 条；主人的设置“重要发件人”",
    at: "2026-11-02T03:00:00.000Z",
  });
  writeRuleVersion(side, {
    ruleId: "owner:refund-thread",
    parameters: ownerRuleParameters(
      "mail_read_whole_thread",
      { phrases: ["退款"], words: ["refund"] },
      "涉及退款的邮件先读完整个邮件串",
    ),
    source: "ADR 0213；主人在对话里说的一句话",
    sourceMemoryId: "m-plain",
    reason: "owner_sentence",
    at: "2026-11-03T03:00:00.000Z",
  });
  const subscription = ownerRuleParameters(
    "mail_must_notify",
    { phrases: ["续费"], excludePhrases: ["广告"] },
    "订阅续费的邮件一定提醒",
  );
  writeRuleVersion(side, {
    ruleId: "owner:subscription",
    parameters: subscription,
    source: "ADR 0213；主人在对话里说的一句话",
    sourceMemoryId: "m-verified",
    reason: "owner_sentence",
    at: "2026-11-03T05:00:00.000Z",
  });
  writeRuleVersion(side, {
    ruleId: "owner:subscription",
    parameters: subscription,
    status: "retired",
    source: "ADR 0213；主人在对话里说的一句话",
    sourceMemoryId: "m-verified",
    reason: "owner_undo",
    at: "2026-11-05T00:00:00.000Z",
  });
  writeRuleVersion(side, {
    ruleId: "owner:build-key",
    parameters: ownerRuleParameters(
      "mail_must_notify",
      { phrases: [RULE_SECRET_PHRASE] },
      "提到构建密钥的邮件一定提醒",
    ),
    source: "ADR 0213；主人在对话里说的一句话",
    reason: "owner_sentence",
    at: "2026-11-03T06:00:00.000Z",
  });
}
