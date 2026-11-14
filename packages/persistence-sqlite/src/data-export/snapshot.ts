import type { PayloadRecord } from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { PerceptionFileKey } from "./schemas.js";
import type { ExportScope } from "./types.js";

export type Row = Record<string, unknown>;

export interface PortableSnapshot {
  readonly memories: readonly Row[];
  readonly history: readonly Row[];
  readonly provenance: readonly Row[];
  readonly entities: readonly Row[];
  readonly mentions: readonly Row[];
  readonly pins: readonly Row[];
  readonly people: readonly Row[];
  readonly aliases: readonly Row[];
  readonly importBatches: readonly Row[];
  readonly pairedDevices: readonly Row[];
  readonly perception: Readonly<Record<PerceptionFileKey, readonly Row[]>>;
  readonly runs: readonly Row[];
  readonly changes: readonly Row[];
  readonly basis: readonly Row[];
  readonly reviews: readonly Row[];
  readonly reviewChanges: readonly Row[];
  readonly decisions: readonly Row[];
  readonly signals: readonly Row[];
  readonly decisionPayloads: readonly Row[];
  readonly sourceInsights: readonly Row[];
  readonly processedMessages: readonly Row[];
  readonly museEntries: readonly Row[];
  readonly rules: readonly Row[];
  readonly ruleHistory: readonly Row[];
  readonly prereviews: readonly Row[];
  readonly payloads: ReadonlyMap<string, PayloadRecord | { readonly unavailable: true }>;
  readonly omittedMemories: number;
  readonly restrictedMemories: number;
  readonly restrictedMemoryTexts: readonly Row[];
  readonly externalProposals: readonly Row[];
  readonly ownerProposals: readonly Row[];
  readonly externalProposalKeys: readonly Row[];
  readonly externalProposalUnkeyed: readonly Row[];
  readonly openMemoryReviews: number;
}

const EXPORTABLE_STATUSES = "('active', 'archived', 'trashed')";

export function readSnapshot(
  database: Database.Database,
  scope: ExportScope,
  withEvidence: boolean,
): PortableSnapshot {
  const parameters = { ownerId: scope.ownerId, agentId: scope.agentId };
  const all = (sql: string): Row[] => database.prepare(sql).all(parameters) as Row[];
  const memberOfMemory = `memory_id IN (SELECT id FROM memory_records
    WHERE owner_id = @ownerId AND agent_id = @agentId AND status IN ${EXPORTABLE_STATUSES}
      AND classification != 'restricted')`;
  return database
    .transaction((): PortableSnapshot => {
      const memories = all(
        `SELECT id, status, revision, classification, inference, confidence_permille,
          policy_version, updated_at, recorded_at, last_used_at, category,
          sub_category, importance_permille, valid_from, valid_to, superseded_by, use_count,
          evidence_verified, sensitive_topic, tentative, stance, import_batch_id, content_ref
        FROM memory_records
        WHERE owner_id = @ownerId AND agent_id = @agentId AND status IN ${EXPORTABLE_STATUSES}
          AND classification != 'restricted'
        ORDER BY COALESCE(recorded_at, updated_at), id`,
      );
      const count = (sql: string): number =>
        database.prepare(sql).pluck().get(parameters) as number;
      const omittedMemories = count(
        `SELECT COUNT(*) FROM memory_records WHERE owner_id = @ownerId AND agent_id = @agentId
          AND status NOT IN ${EXPORTABLE_STATUSES}`,
      );
      const restrictedMemories = count(
        `SELECT COUNT(*) FROM memory_records WHERE owner_id = @ownerId AND agent_id = @agentId
          AND status IN ${EXPORTABLE_STATUSES} AND classification = 'restricted'`,
      );
      const restrictedMemoryTexts = all(
        `SELECT content_ref FROM memory_records
        WHERE owner_id = @ownerId AND agent_id = @agentId AND classification = 'restricted'
          AND content_ref IS NOT NULL
        UNION
        SELECT history.content_ref FROM memory_history_events history
        JOIN memory_records memory ON memory.id = history.memory_id
        WHERE memory.owner_id = @ownerId AND memory.agent_id = @agentId
          AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
        UNION
        SELECT history.quote_ref FROM memory_history_events history
        JOIN memory_records memory ON memory.id = history.memory_id
        WHERE memory.owner_id = @ownerId AND memory.agent_id = @agentId
          AND memory.classification = 'restricted' AND history.quote_ref IS NOT NULL
        ORDER BY content_ref`,
      );
      const externalProposals = all(
        `SELECT id, subject_ref, client, source_key, text_sha256, normalization, content_ref,
          category, classification, status, received_at, decided_at, batch_id, memory_id,
          superseded_by, memory_id IN (SELECT id FROM memory_records
            WHERE owner_id = @ownerId AND agent_id = @agentId AND classification = 'restricted')
            AS restricted_link
        FROM external_memory_proposals
        WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY received_at, id`,
      );
      const ownerProposals = all(
        `SELECT id, type, summary, effect, origin, source_ref, source_version, version, fingerprint,
          status, exec_status, proposed_at, expires_at, decided_at, proposed_count, reject_count,
          last_rejected_at, attempts, executed_at, requires_full_read, requires_presence,
          evidence_ref, execution_ref
        FROM owner_proposals
        WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY proposed_at, id`,
      );
      const externalProposalKeys = all(
        `SELECT proposal_id, client, source_key FROM external_memory_proposal_keys
        WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY proposal_id, client, source_key`,
      );
      const externalProposalUnkeyed = all(
        `SELECT unkeyed.proposal_id, unkeyed.client FROM external_memory_proposal_unkeyed unkeyed
        JOIN external_memory_proposals proposal ON proposal.id = unkeyed.proposal_id
        WHERE proposal.owner_id = @ownerId AND proposal.agent_id = @agentId
        ORDER BY unkeyed.proposal_id, unkeyed.client`,
      );
      const openMemoryReviews = count(
        `SELECT COUNT(*) FROM memory_review_items
          WHERE owner_id = @ownerId AND agent_id = @agentId AND status = 'open'`,
      );
      const history = all(
        `SELECT memory_id, kind, content_ref, stance, quote_ref, source_deleted, occurred_at
        FROM memory_history_events WHERE ${memberOfMemory}
        ORDER BY memory_id, occurred_at, rowid`,
      );
      const provenance = all(
        `SELECT memory_id, source_type, source_id, source_deleted FROM memory_provenance
        WHERE ${memberOfMemory} ORDER BY memory_id, source_type, source_id`,
      );
      const entities = all(
        `SELECT memory_id, name FROM memory_entities WHERE ${memberOfMemory}
        ORDER BY memory_id, name`,
      );
      const mentions = all(
        `SELECT memory_id, person_id FROM memory_person_mentions WHERE ${memberOfMemory}
        ORDER BY memory_id, person_id`,
      );
      const pins = all(
        `SELECT memory_id, pinned, updated_at FROM memory_profile_pins
        WHERE owner_id = @ownerId AND agent_id = @agentId AND ${memberOfMemory}
        ORDER BY memory_id`,
      );
      const people = all(
        `SELECT id, name, relation, reverse_relation, merged_into, created_at, updated_at
        FROM memory_people WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY created_at, id`,
      );
      const aliases = all(
        `SELECT person_id, alias FROM memory_person_aliases
        WHERE person_id IN (SELECT id FROM memory_people
          WHERE owner_id = @ownerId AND agent_id = @agentId)
        ORDER BY person_id, alias`,
      );
      const importBatches = all(
        `SELECT id, source, item_count, created_at, undone_at FROM memory_import_batches
        WHERE owner_id = @ownerId AND agent_id = @agentId ORDER BY created_at, id`,
      );
      const pairedDevices = all(
        `SELECT id, kind, name, release_channel, status, paired_at, confirmed_at, revoked_at, last_seen_at
        FROM paired_devices WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY paired_at, id`,
      );
      const scoped = "owner_id = @ownerId AND agent_id = @agentId";
      const perception: Record<PerceptionFileKey, Row[]> = {
        perceptionRecords: all(
          `SELECT id, device_id, type, origin, capture_source, occurred_at_ms, occurred_at_device,
            local_day, confidence, speaker_kind, speaker_ref, episode_id, content_ref,
            data_classification, evidence
          FROM perception_records WHERE ${scoped} AND status = 'active'
          ORDER BY occurred_at_ms, id`,
        ),
        perceptionEpisodes: all(
          `SELECT id, started_at_ms, ended_at_ms, local_day, record_count
          FROM perception_episodes WHERE ${scoped} AND status = 'active'
          ORDER BY started_at_ms, id`,
        ),
        deviceMirrorItems: all(
          `SELECT device_id, kind, external_id, version, updated_at_ms, data
          FROM device_mirror_items WHERE ${scoped} AND deleted = 0
          ORDER BY device_id, kind, external_id`,
        ),
        trackPoints: all(
          `SELECT device_id, occurred_at_ms, latitude_e7, longitude_e7, accuracy_dm, speed_cms
          FROM location_track_points WHERE ${scoped} ORDER BY occurred_at_ms, device_id`,
        ),
        perceptionSettings: all(
          `SELECT disabled_senses, paused_from, paused_until, retention_days, limit_overrides,
            updated_at
          FROM perception_settings WHERE ${scoped}`,
        ),
        limitUsage: all(
          `SELECT key, period_start, device_id, used
          FROM limit_usage WHERE ${scoped} ORDER BY period_start, key, device_id`,
        ),
      };
      const runs = all(
        `SELECT id, day, trigger_run_id, status, reviewed_through, model_called, change_count,
          error_code, started_at, finished_at
        FROM memory_consolidation_runs WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY started_at, id`,
      );
      const changes = all(
        `SELECT id, consolidation_id, memory_id, related_memory_id, action, before_revision,
          after_revision, before_status, before_superseded_by, before_valid_to, created_at,
          undone_at
        FROM memory_consolidation_changes WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY created_at, id`,
      );
      const basis = all(
        `SELECT change_id, position, memory_id FROM memory_consolidation_change_basis
        WHERE change_id IN (SELECT id FROM memory_consolidation_changes
          WHERE owner_id = @ownerId AND agent_id = @agentId)
        ORDER BY change_id, position`,
      );
      const reviews = all(
        `SELECT id, day, status, attempts, error_code, started_at, finished_at, undone_at
        FROM memory_conversation_reviews WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY started_at, id`,
      );
      const reviewChanges = all(
        `SELECT review_id, memory_id, action, after_revision, before_superseded_by,
          before_valid_to, created_at, undone_revision
        FROM memory_conversation_review_changes WHERE after_revision IS NOT NULL AND review_id IN (
          SELECT id FROM memory_conversation_reviews
          WHERE owner_id = @ownerId AND agent_id = @agentId)
        ORDER BY review_id, created_at, memory_id`,
      );
      const decisions = all(
        `SELECT id, kind, scenario, checked_at, counts, verdict, outcome, reason_code,
          subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros,
          duration_ms, owner_rating, rated_at, category, confidence_permille, inferred
        FROM decision_ledger WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY checked_at, id`,
      );
      const signals = all(
        `SELECT id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at
        FROM decision_signals WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY decision_id, occurred_at, id`,
      );
      const decisionPayloads = withEvidence
        ? all(
            `SELECT decision_id, sequence, role, payload_ref FROM decision_ledger_payloads
            WHERE decision_id IN (SELECT id FROM decision_ledger
              WHERE owner_id = @ownerId AND agent_id = @agentId)
            ORDER BY decision_id, sequence`,
          )
        : [];
      const sourceInsights = withEvidence
        ? all(
            `SELECT id, source, thread_id, last_message_id, result, floor_raised, content_ref,
              due_at, priority, status, decision_id, owner_rating, push_source_key, created_at,
              updated_at, push_class
            FROM source_insights WHERE owner_id = @ownerId AND agent_id = @agentId
            ORDER BY created_at, id`,
          )
        : [];
      const processedMessages = withEvidence
        ? all(
            `SELECT source, message_id, thread_id, decision_id, outcome, skip_reason, header_ref,
              processed_at, reviewed_at, owner_rating, received_at
            FROM proactive_processed_messages WHERE owner_id = @ownerId AND agent_id = @agentId
            ORDER BY processed_at, message_id`,
          )
        : [];
      const museEntries = withEvidence
        ? all(
            `SELECT id, muse_at, muse_reminded, timing_ok, content_ok, content_ref, note_ref,
              paired_decision_id, intake_item_key, recorded_at, paired_message_id
            FROM muse_reference_entries WHERE owner_id = @ownerId AND agent_id = @agentId
            ORDER BY muse_at, id`,
          )
        : [];
      const rules = all(
        `SELECT rule_id, revision, parameters, status, source, source_memory_id, updated_at,
          suspend_reason, suggestion
        FROM rule_book_rules WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY rule_id`,
      );
      const ruleHistory = all(
        `SELECT rule_id, revision, parameters, status, source, source_memory_id, change_reason,
          changed_at
        FROM rule_book_history WHERE owner_id = @ownerId AND agent_id = @agentId
        ORDER BY rule_id, revision`,
      );
      const prereviews = withEvidence
        ? all(
            `SELECT id, decision_id, mail_source, message_id, calibration_group, category, status,
              rating, confidence_permille, history_conflict, failure_code, model_ref, prompt_id,
              text_digest, data_classification, cost_micros, duration_ms, created_at
            FROM decision_prereviews WHERE owner_id = @ownerId AND agent_id = @agentId
            ORDER BY created_at, id`,
          )
        : [];
      const refs = new Set<string>();
      for (const row of [
        ...memories,
        ...history,
        ...decisions,
        ...decisionPayloads,
        ...sourceInsights,
        ...processedMessages,
        ...museEntries,
        ...externalProposals,
        ...ownerProposals,
        ...restrictedMemoryTexts,
        ...perception.perceptionRecords,
      ])
        for (const key of [
          "content_ref",
          "quote_ref",
          "reason_ref",
          "payload_ref",
          "header_ref",
          "note_ref",
          "evidence_ref",
          "execution_ref",
        ]) {
          const ref = row[key];
          if (typeof ref === "string") refs.add(ref);
        }
      const payloads = new Map<string, PayloadRecord | { readonly unavailable: true }>();
      const read = database.prepare(
        `SELECT ref, classification, content_type, storage_kind, ciphertext, ciphertext_path,
          encryption_algorithm, key_ref, encryption_metadata_json, content_digest, created_at,
          lifecycle_state
        FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?`,
      );
      for (const ref of refs) {
        const row = read.get(ref, scope.ownerId, scope.agentId) as
          | {
              ref: string;
              classification: PayloadRecord["dataClassification"];
              content_type: string | null;
              storage_kind: string;
              ciphertext: Uint8Array | null;
              ciphertext_path: string | null;
              encryption_algorithm: string | null;
              key_ref: string | null;
              encryption_metadata_json: string | null;
              content_digest: string;
              created_at: string;
              lifecycle_state: string;
            }
          | undefined;
        if (
          !row ||
          row.storage_kind !== "sqlite_blob" ||
          row.ciphertext === null ||
          row.lifecycle_state === "deletion_pending" ||
          row.lifecycle_state === "deleted_verified"
        ) {
          payloads.set(ref, { unavailable: true });
          continue;
        }
        payloads.set(ref, {
          ref: row.ref,
          dataClassification: row.classification,
          contentType: row.content_type ?? "application/octet-stream",
          ciphertext: new Uint8Array(row.ciphertext),
          encryption: row.encryption_metadata_json
            ? (JSON.parse(row.encryption_metadata_json) as PayloadRecord["encryption"])
            : {
                algorithm: row.encryption_algorithm ?? "unknown",
                keyRef: row.key_ref ?? "unknown",
              },
          storage: { kind: "inline" },
          contentDigest: row.content_digest,
          createdAt: row.created_at,
        });
      }
      return {
        memories,
        history,
        provenance,
        entities,
        mentions,
        pins,
        people,
        aliases,
        importBatches,
        pairedDevices,
        perception,
        runs,
        changes,
        basis,
        reviews,
        reviewChanges,
        decisions,
        signals,
        decisionPayloads,
        sourceInsights,
        processedMessages,
        museEntries,
        rules,
        ruleHistory,
        prereviews,
        payloads,
        omittedMemories,
        restrictedMemories,
        restrictedMemoryTexts,
        externalProposals,
        ownerProposals,
        externalProposalKeys,
        externalProposalUnkeyed,
        openMemoryReviews,
      };
    })
    .deferred();
}
