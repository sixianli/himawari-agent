import type {
  MemoryImportBatch,
  MemoryPerson,
  MemoryPersonLinkMention,
  MemoryPersonMention,
  MemoryPersonSuggestion,
  MemoryProfilePin,
  MemorySettings,
  MemorySubCategoryCount,
} from "@himawari-agent/application";
import type { AgentId, MemoryGenerationId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { insertObservationEvent } from "./sqlite-observation-operations.ts";

interface Scope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly relation: string | null;
  readonly reverseRelation: string | null;
  readonly updatedAt: string;
}

const IMPORT_SOURCES = new Set(["codex", "assistant", "himawari"]);
const MAXIMUM_PEOPLE_PER_MEMORY = 8;
const MAXIMUM_LINKS_PER_MEMORY = 8;

function label(value: string | null | undefined, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFKC").trim();
  return trimmed.length === 0 || [...trimmed].length > maximum ? null : trimmed;
}

function key(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteMemoryBookOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "memoryBook.readSettings":
        return this.readSettings(payload as Scope);
      case "memoryBook.writeSettings":
        return this.writeSettings(payload as Scope & { capturePaused: boolean; updatedAt: string });
      case "memoryBook.markViewed":
        return this.markViewed(payload as Scope & { viewedAt: string });
      case "memoryBook.setProfilePin":
        return this.setProfilePin(
          payload as Scope & { memoryId: MemoryId; pinned: boolean; updatedAt: string },
        );
      case "memoryBook.listProfilePins":
        return this.listProfilePins(payload as Scope);
      case "memoryBook.latestGeneration":
        return this.latestGeneration(payload as Scope);
      case "memoryBook.directGeneration":
        return this.directGeneration(payload as Scope);
      case "memoryBook.listExpiredTrash":
        return this.listExpiredTrash(payload as Scope & { trashedBefore: string; limit: number });
      case "memoryBook.listSubCategories":
        return this.listSubCategories(payload as Scope);
      case "memoryBook.recordPeople":
        return this.recordPeople(
          payload as Scope & {
            memoryId: MemoryId;
            people: readonly MemoryPersonMention[];
            links: readonly MemoryPersonLinkMention[];
            now: string;
          },
        );
      case "memoryBook.listPeople":
        return this.listPeople(payload as Scope);
      case "memoryBook.listPersonSuggestions":
        return this.listPersonSuggestions(payload as Scope);
      case "memoryBook.decidePersonSuggestion":
        return this.decidePersonSuggestion(
          payload as Scope & { id: string; merge: boolean; now: string },
        );
      case "memoryBook.createImportBatch":
        return this.createImportBatch(payload as Scope & MemoryImportBatch);
      case "memoryBook.listImportBatches":
        return this.listImportBatches(payload as Scope & { limit: number });
      case "memoryBook.markImportUndone":
        return this.markImportUndone(payload as Scope & { id: string; undoneAt: string });
      case "memoryBook.findOwnerMessages":
        return this.findOwnerMessages(
          payload as Scope & {
            lookups: readonly { threadId: string; refs: readonly string[] }[];
          },
        );
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown Memory book operation ${operation}`);
    }
  }

  private limit(value: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
      this.fail("PORT_INVALID_OPERATION", "Memory book limit is invalid");
  }

  private readSettings(scope: Scope): MemorySettings {
    const row = this.database
      .prepare(
        `SELECT capture_paused AS capturePaused, updated_at AS updatedAt,
          last_viewed_at AS lastViewedAt FROM memory_settings
        WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(scope.ownerId, scope.agentId) as
      | {
          readonly capturePaused: number;
          readonly updatedAt: string;
          readonly lastViewedAt: string | null;
        }
      | undefined;
    return {
      capturePaused: row?.capturePaused === 1,
      updatedAt: row?.updatedAt ?? null,
      lastViewedAt: row?.lastViewedAt ?? null,
    };
  }

  private markViewed(input: Scope & { viewedAt: string }): void {
    this.assertDiskHeadroom();
    if (!validTime(input.viewedAt))
      this.fail("PORT_INVALID_OPERATION", "Memory page view time is invalid");
    this.database
      .prepare(
        `INSERT INTO memory_settings (owner_id, agent_id, capture_paused, updated_at, last_viewed_at)
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT (owner_id, agent_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at`,
      )
      .run(input.ownerId, input.agentId, input.viewedAt, input.viewedAt);
  }

  private setProfilePin(
    input: Scope & { memoryId: MemoryId; pinned: boolean; updatedAt: string },
  ): void {
    this.assertDiskHeadroom();
    if (typeof input.pinned !== "boolean" || !validTime(input.updatedAt))
      this.fail("PORT_INVALID_OPERATION", "Memory profile choice is invalid");
    const owned = this.database
      .prepare("SELECT 1 FROM memory_records WHERE id = ? AND owner_id = ? AND agent_id = ?")
      .get(input.memoryId, input.ownerId, input.agentId);
    if (!owned) this.fail("PORT_NOT_FOUND", `Memory ${input.memoryId} not found`);
    this.database
      .prepare(
        `INSERT INTO memory_profile_pins (memory_id, owner_id, agent_id, pinned, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (memory_id) DO UPDATE SET pinned = excluded.pinned,
          updated_at = excluded.updated_at`,
      )
      .run(input.memoryId, input.ownerId, input.agentId, input.pinned ? 1 : 0, input.updatedAt);
  }

  private listProfilePins(scope: Scope): MemoryProfilePin[] {
    return (
      this.database
        .prepare(
          `SELECT memory_id AS memoryId, pinned, updated_at AS updatedAt FROM memory_profile_pins
          WHERE owner_id = ? AND agent_id = ? ORDER BY memory_id`,
        )
        .all(scope.ownerId, scope.agentId) as {
        memoryId: MemoryId;
        pinned: number;
        updatedAt: string;
      }[]
    ).map((row) => ({
      memoryId: row.memoryId,
      pinned: row.pinned === 1,
      updatedAt: row.updatedAt,
    }));
  }

  private writeSettings(input: Scope & { capturePaused: boolean; updatedAt: string }): void {
    this.assertDiskHeadroom();
    if (typeof input.capturePaused !== "boolean" || !validTime(input.updatedAt))
      this.fail("PORT_INVALID_OPERATION", "Memory settings are invalid");
    this.database.transaction(() => {
      const before = this.database
        .prepare(
          "SELECT capture_paused AS paused FROM memory_settings WHERE owner_id = ? AND agent_id = ?",
        )
        .get(input.ownerId, input.agentId) as { paused: number } | undefined;
      this.database
        .prepare(
          `INSERT INTO memory_settings (owner_id, agent_id, capture_paused, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (owner_id, agent_id) DO UPDATE SET capture_paused = excluded.capture_paused,
            updated_at = excluded.updated_at`,
        )
        .run(input.ownerId, input.agentId, input.capturePaused ? 1 : 0, input.updatedAt);
      if ((before?.paused === 1) !== input.capturePaused)
        insertObservationEvent(this.database, {
          ownerId: input.ownerId,
          agentId: input.agentId,
          kind: input.capturePaused ? "memory_capture_paused" : "memory_capture_resumed",
          occurredAt: input.updatedAt,
        });
    })();
  }

  private directGeneration(scope: Scope): MemoryGenerationId {
    const id = `memory-direct:${scope.ownerId}:${scope.agentId}`;
    this.database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status, model_descriptor_ref,
          policy_version, output_ref
        ) VALUES (?, NULL, ?, ?, NULL, 'completed', 'owner-direct', 'memory-direct.v1', NULL)
        ON CONFLICT (id) DO NOTHING`,
      )
      .run(id, scope.ownerId, scope.agentId);
    return id as MemoryGenerationId;
  }

  private latestGeneration(scope: Scope): MemoryGenerationId | undefined {
    return this.database
      .prepare(
        `SELECT id FROM memory_generations WHERE owner_id = ? AND agent_id = ?
        ORDER BY rowid DESC LIMIT 1`,
      )
      .pluck()
      .get(scope.ownerId, scope.agentId) as MemoryGenerationId | undefined;
  }

  private listExpiredTrash(input: Scope & { trashedBefore: string; limit: number }): MemoryId[] {
    this.limit(input.limit);
    return this.database
      .prepare(
        `SELECT id FROM memory_records WHERE owner_id = ? AND agent_id = ? AND status = 'trashed'
          AND updated_at <= ? ORDER BY updated_at, id LIMIT ?`,
      )
      .pluck()
      .all(input.ownerId, input.agentId, input.trashedBefore, input.limit) as MemoryId[];
  }

  private listSubCategories(scope: Scope): MemorySubCategoryCount[] {
    return this.database
      .prepare(
        `SELECT category, sub_category AS subCategory, COUNT(*) AS count FROM memory_records
        WHERE owner_id = ? AND agent_id = ? AND status = 'active' AND sub_category IS NOT NULL
        GROUP BY category, sub_category ORDER BY category, count DESC, sub_category`,
      )
      .all(scope.ownerId, scope.agentId) as MemorySubCategoryCount[];
  }

  private livePerson(scope: Scope, id: string | null): string | null {
    let current = id;
    for (let step = 0; current !== null && step < 16; step += 1) {
      const row = this.database
        .prepare(
          "SELECT merged_into AS mergedInto FROM memory_people WHERE id = ? AND owner_id = ? AND agent_id = ?",
        )
        .get(current, scope.ownerId, scope.agentId) as
        | { readonly mergedInto: string | null }
        | undefined;
      if (!row) return null;
      if (row.mergedInto === null) return current;
      current = row.mergedInto;
    }
    return null;
  }

  private personByName(scope: Scope, name: string): string | null {
    const wanted = key(name);
    const rows = this.database
      .prepare(
        `SELECT p.id, p.name, a.alias FROM memory_people p
        LEFT JOIN memory_person_aliases a ON a.person_id = p.id
        WHERE p.owner_id = ? AND p.agent_id = ? AND p.merged_into IS NULL
        ORDER BY p.created_at, p.id`,
      )
      .all(scope.ownerId, scope.agentId) as {
      readonly id: string;
      readonly name: string;
      readonly alias: string | null;
    }[];
    return (
      rows.find(
        (row) => key(row.name) === wanted || (row.alias !== null && key(row.alias) === wanted),
      )?.id ?? null
    );
  }

  private addAlias(personId: string, alias: string) {
    const name = this.database
      .prepare("SELECT name FROM memory_people WHERE id = ?")
      .pluck()
      .get(personId) as string;
    if (key(name) === key(alias)) return;
    this.database
      .prepare(
        "INSERT INTO memory_person_aliases (person_id, alias) VALUES (?, ?) ON CONFLICT DO NOTHING",
      )
      .run(personId, alias);
  }

  private recordPeople(
    input: Scope & {
      memoryId: MemoryId;
      people: readonly MemoryPersonMention[];
      links: readonly MemoryPersonLinkMention[];
      now: string;
    },
  ): void {
    this.assertDiskHeadroom();
    if (!validTime(input.now)) this.fail("PORT_INVALID_OPERATION", "Memory people time is invalid");
    this.database
      .transaction(() => {
        const memory = this.database
          .prepare("SELECT 1 FROM memory_records WHERE id = ? AND owner_id = ? AND agent_id = ?")
          .get(input.memoryId, input.ownerId, input.agentId);
        if (!memory) this.fail("PORT_NOT_FOUND", "Memory for people not found");
        const resolved = new Map<string, string>();
        input.people.slice(0, MAXIMUM_PEOPLE_PER_MEMORY).forEach((mention, ordinal) => {
          const name = label(mention.name, 64);
          if (!name) return;
          const relation = label(mention.relation, 32);
          const reverse = label(mention.reverseRelation, 32);
          const aliases = (mention.aliases ?? [])
            .map((alias) => label(alias, 64))
            .filter((alias): alias is string => alias !== null);
          let personId =
            this.livePerson(input, mention.personId) ??
            [name, ...aliases].map((value) => this.personByName(input, value)).find(Boolean) ??
            null;
          if (personId === null) {
            personId = `person:${input.memoryId}:${ordinal}`;
            this.database
              .prepare(
                `INSERT INTO memory_people (
                  id, owner_id, agent_id, name, relation, reverse_relation, merged_into,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT DO NOTHING`,
              )
              .run(
                personId,
                input.ownerId,
                input.agentId,
                name,
                relation,
                reverse,
                input.now,
                input.now,
              );
            const candidate = this.livePerson(input, mention.maybeSameAs);
            if (candidate !== null && candidate !== personId)
              this.database
                .prepare(
                  `INSERT INTO memory_person_suggestions (
                    id, owner_id, agent_id, person_id, candidate_id, status, created_at, decided_at
                  ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL) ON CONFLICT DO NOTHING`,
                )
                .run(
                  `person-suggestion:${personId}:${candidate}`,
                  input.ownerId,
                  input.agentId,
                  personId,
                  candidate,
                  input.now,
                );
          } else {
            this.database
              .prepare(
                `UPDATE memory_people SET relation = COALESCE(?, relation),
                  reverse_relation = COALESCE(?, reverse_relation), updated_at = ?
                WHERE id = ?`,
              )
              .run(relation, reverse, input.now, personId);
            this.addAlias(personId, name);
          }
          for (const alias of aliases) this.addAlias(personId, alias);
          this.database
            .prepare(
              "INSERT INTO memory_person_mentions (memory_id, person_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
            )
            .run(input.memoryId, personId);
          for (const value of [name, ...aliases]) resolved.set(key(value), personId);
        });
        const find = (name: string) => {
          const value = label(name, 64);
          if (!value) return null;
          return resolved.get(key(value)) ?? this.personByName(input, value);
        };
        const link = this.database.prepare(
          `INSERT INTO memory_person_links (person_id, other_person_id, relation, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (person_id, other_person_id) DO UPDATE SET relation = excluded.relation,
            updated_at = excluded.updated_at`,
        );
        for (const mention of input.links.slice(0, MAXIMUM_LINKS_PER_MEMORY)) {
          const from = find(mention.from);
          const to = find(mention.to);
          const relation = label(mention.relation, 32);
          if (!from || !to || from === to || !relation) continue;
          link.run(from, to, relation, input.now);
          const reverse = label(mention.reverseRelation, 32);
          if (reverse) link.run(to, from, reverse, input.now);
        }
      })
      .immediate();
  }

  private listPeople(scope: Scope): MemoryPerson[] {
    const people = this.database
      .prepare(
        `SELECT id, name, relation, reverse_relation AS reverseRelation, updated_at AS updatedAt
        FROM memory_people WHERE owner_id = ? AND agent_id = ? AND merged_into IS NULL
        ORDER BY created_at, id`,
      )
      .all(scope.ownerId, scope.agentId) as PersonRow[];
    const aliases = this.database.prepare(
      "SELECT alias FROM memory_person_aliases WHERE person_id = ? ORDER BY alias",
    );
    const links = this.database.prepare(
      `SELECT l.other_person_id AS personId, l.relation FROM memory_person_links l
      JOIN memory_people o ON o.id = l.other_person_id AND o.merged_into IS NULL
      WHERE l.person_id = ? ORDER BY l.other_person_id`,
    );
    const mentions = this.database.prepare(
      `SELECT n.memory_id FROM memory_person_mentions n
      JOIN memory_records m ON m.id = n.memory_id
        AND m.status IN ('active', 'archived', 'trashed')
      WHERE n.person_id = ? ORDER BY n.memory_id`,
    );
    return people.map((person) => ({
      ...person,
      aliases: aliases.pluck().all(person.id) as string[],
      links: links.all(person.id) as { personId: string; relation: string }[],
      memoryIds: mentions.pluck().all(person.id) as MemoryId[],
    }));
  }

  private listPersonSuggestions(scope: Scope): MemoryPersonSuggestion[] {
    return this.database
      .prepare(
        `SELECT s.id, s.person_id AS personId, s.candidate_id AS candidateId,
          s.created_at AS createdAt
        FROM memory_person_suggestions s
        JOIN memory_people p ON p.id = s.person_id AND p.merged_into IS NULL
        JOIN memory_people c ON c.id = s.candidate_id AND c.merged_into IS NULL
        WHERE s.owner_id = ? AND s.agent_id = ? AND s.status = 'pending'
        ORDER BY s.created_at, s.id`,
      )
      .all(scope.ownerId, scope.agentId) as MemoryPersonSuggestion[];
  }

  private decidePersonSuggestion(input: Scope & { id: string; merge: boolean; now: string }) {
    this.assertDiskHeadroom();
    if (!validTime(input.now)) this.fail("PORT_INVALID_OPERATION", "Memory people time is invalid");
    return this.database
      .transaction(() => {
        const suggestion = this.database
          .prepare(
            `SELECT person_id AS personId, candidate_id AS candidateId FROM memory_person_suggestions
            WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'`,
          )
          .get(input.id, input.ownerId, input.agentId) as
          | { readonly personId: string; readonly candidateId: string }
          | undefined;
        if (!suggestion) return false;
        this.database
          .prepare("UPDATE memory_person_suggestions SET status = ?, decided_at = ? WHERE id = ?")
          .run(input.merge ? "merged" : "rejected", input.now, input.id);
        if (!input.merge) return true;
        const from = this.livePerson(input, suggestion.personId);
        const into = this.livePerson(input, suggestion.candidateId);
        if (!from || !into || from === into) return true;
        const source = this.database
          .prepare(
            "SELECT name, relation, reverse_relation AS reverseRelation FROM memory_people WHERE id = ?",
          )
          .get(from) as { name: string; relation: string | null; reverseRelation: string | null };
        this.addAlias(into, source.name);
        for (const alias of this.database
          .prepare("SELECT alias FROM memory_person_aliases WHERE person_id = ?")
          .pluck()
          .all(from) as string[])
          this.addAlias(into, alias);
        this.database
          .prepare(
            `UPDATE memory_people SET relation = COALESCE(relation, ?),
              reverse_relation = COALESCE(reverse_relation, ?), updated_at = ? WHERE id = ?`,
          )
          .run(source.relation, source.reverseRelation, input.now, into);
        this.database
          .prepare(
            `INSERT INTO memory_person_mentions (memory_id, person_id)
            SELECT memory_id, ? FROM memory_person_mentions WHERE person_id = ?
            ON CONFLICT DO NOTHING`,
          )
          .run(into, from);
        this.database
          .prepare(
            `INSERT INTO memory_person_links (person_id, other_person_id, relation, updated_at)
            SELECT ?, other_person_id, relation, ? FROM memory_person_links
            WHERE person_id = ? AND other_person_id != ?
            ON CONFLICT DO NOTHING`,
          )
          .run(into, input.now, from, into);
        this.database
          .prepare(
            `INSERT INTO memory_person_links (person_id, other_person_id, relation, updated_at)
            SELECT person_id, ?, relation, ? FROM memory_person_links
            WHERE other_person_id = ? AND person_id != ?
            ON CONFLICT DO NOTHING`,
          )
          .run(into, input.now, from, into);
        this.database
          .prepare("UPDATE memory_people SET merged_into = ?, updated_at = ? WHERE id = ?")
          .run(into, input.now, from);
        return true;
      })
      .immediate();
  }

  private createImportBatch(input: Scope & MemoryImportBatch): void {
    this.assertDiskHeadroom();
    if (
      !IMPORT_SOURCES.has(input.source) ||
      !Number.isSafeInteger(input.itemCount) ||
      input.itemCount < 1 ||
      input.itemCount > 500 ||
      !validTime(input.createdAt) ||
      input.undoneAt !== null
    )
      this.fail("PORT_INVALID_OPERATION", "Memory import batch is invalid");
    this.database
      .prepare(
        `INSERT INTO memory_import_batches (
          id, owner_id, agent_id, source, item_count, created_at, undone_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(input.id, input.ownerId, input.agentId, input.source, input.itemCount, input.createdAt);
  }

  private listImportBatches(input: Scope & { limit: number }): MemoryImportBatch[] {
    this.limit(input.limit);
    return this.database
      .prepare(
        `SELECT id, source, item_count AS itemCount, created_at AS createdAt,
          undone_at AS undoneAt
        FROM memory_import_batches WHERE owner_id = ? AND agent_id = ?
        ORDER BY created_at DESC, id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.limit) as MemoryImportBatch[];
  }

  private findOwnerMessages(
    input: Scope & { lookups: readonly { threadId: string; refs: readonly string[] }[] },
  ) {
    const found: {
      contentRef: string;
      threadId: string;
      messageId: string;
      sequence: number;
    }[] = [];
    for (const { threadId, refs: all } of input.lookups) {
      const refs = [...new Set(all)];
      for (let index = 0; index < refs.length; index += 200) {
        const batch = refs.slice(index, index + 200);
        found.push(
          ...(this.database
            .prepare(
              `SELECT t.content_ref AS contentRef, t.thread_id AS threadId, t.id AS messageId,
                t.sequence AS sequence
              FROM thread_messages t JOIN threads h ON h.id = t.thread_id
              WHERE t.owner_id = ? AND t.agent_id = ? AND t.thread_id = ? AND t.role = 'owner'
                AND t.message_status = 'committed'
                AND h.status NOT IN ('trashed', 'deletion_pending', 'deleted_verified')
                AND t.content_ref IN (${batch.map(() => "?").join(", ")})
              ORDER BY t.sequence`,
            )
            .all(input.ownerId, input.agentId, threadId, ...batch) as typeof found),
        );
      }
    }
    return found;
  }

  private markImportUndone(input: Scope & { id: string; undoneAt: string }): boolean {
    if (!validTime(input.undoneAt))
      this.fail("PORT_INVALID_OPERATION", "Memory import undo time is invalid");
    return (
      this.database
        .prepare(
          `UPDATE memory_import_batches SET undone_at = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND undone_at IS NULL`,
        )
        .run(input.undoneAt, input.id, input.ownerId, input.agentId).changes === 1
    );
  }
}
