import { randomBytes } from "node:crypto";
import {
  MCP_SYNC_CLASSIFICATIONS,
  MCP_SYNC_KINDS,
  MCP_SYNC_LIMIT_CEILINGS,
  MCP_SYNC_LIMIT_DEFAULTS,
  MCP_SYNC_LIMIT_NAMES,
  MCP_SYNC_PROJECT_ID_PREFIX,
  MCP_SYNC_RESERVED_PROJECT_ID,
  type McpProjectNote,
  type McpSyncAttentionDecision,
  type McpSyncAttentionView,
  type McpSyncClassification,
  type McpSyncDeleteResult,
  type McpSyncItemResult,
  type McpSyncItemStatus,
  type McpSyncLimits,
  type McpSyncNoteDecision,
  type McpSyncOverview,
  type McpSyncPendingEntry,
  type McpSyncProjectDecision,
  type McpSyncProjectView,
  type McpSyncPushDelete,
  type McpSyncPushInput,
  type McpSyncPushItem,
  type McpSyncPushResult,
  type McpSyncScope,
} from "@himawari-agent/application/mcp-memory-sync";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.ts";
import { SqliteExternalMemoryProposalOperations } from "./sqlite-external-memory-proposal-operations.ts";

type Scope = McpSyncScope;

interface EntryRow {
  readonly entryId: string;
  readonly projectId: string;
  readonly stableId: string;
  readonly kind: string;
  readonly version: number;
  readonly textSha256: string;
  readonly state: string;
  readonly proposalId: string | null;
  readonly replacesMemoryId: string | null;
  readonly sourceDeletedAt: string | null;
}

interface ProposalRow {
  readonly id: string;
  readonly status: string;
  readonly memoryId: string | null;
}

const ENTRY_SELECT = `SELECT entry_id AS entryId, project_id AS projectId, stable_id AS stableId,
  kind, version, text_sha256 AS textSha256, state, proposal_id AS proposalId,
  replaces_memory_id AS replacesMemoryId, source_deleted_at AS sourceDeletedAt
  FROM mcp_sync_entries`;

const ENTRY_KEY = `owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ?
  AND stable_id = ?`;

const DIGEST = /^[0-9a-f]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const PROPOSAL_NORMALIZATION = "mcp-text:v1";
const RANK: Readonly<Record<string, number>> = { public: 0, private: 1, sensitive: 2 };

const STATE_ACTIVE = "active";
const STATE_DELETED = "deleted";
const STATE_OWNER_DELETED = "owner_deleted";
const STATE_AWAITING_APPROVAL = "awaiting_project_approval";
const STATE_AWAITING_CONFIRMATION = "awaiting_confirmation";
const STATE_REFUSED = "refused";

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function randomId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

export class SqliteMcpMemorySyncOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;
  private readonly proposals: SqliteExternalMemoryProposalOperations;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.proposals = new SqliteExternalMemoryProposalOperations(database, fail, assertDiskHeadroom);
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "mcpMemorySync.push":
        return this.push(payload as McpSyncPushInput);
      case "mcpMemorySync.limits":
        return this.limits(payload as Scope);
      case "mcpMemorySync.projectNotes":
        return this.projectNotes(
          payload as Scope & {
            projectName: string;
            maxClassification: McpSyncClassification;
            limit: number;
          },
        );
      case "mcpMemorySync.replacedMemory":
        return this.replacedMemory(payload as Scope & { proposalId: string });
      case "mcpMemorySync.overview":
        return this.overview(payload as Scope & { limit: number });
      case "mcpMemorySync.decideProject":
        return this.decideProject(
          payload as Scope & {
            connectionId: string;
            projectId: string;
            decision: McpSyncProjectDecision;
            now: string;
          },
        );
      case "mcpMemorySync.decideNote":
        return this.decideNote(
          payload as Scope & { entryId: string; decision: McpSyncNoteDecision; now: string },
        );
      case "mcpMemorySync.resolveAttention":
        return this.resolveAttention(
          payload as Scope & {
            attentionId: string;
            decision: McpSyncAttentionDecision;
            now: string;
          },
        );
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown MCP memory sync operation ${operation}`,
        );
    }
  }

  private invalid(): never {
    return this.fail("PORT_INVALID_OPERATION", "MCP_SYNC_INPUT_INVALID");
  }

  private limits(scope: Scope): McpSyncLimits {
    const rows = this.database
      .prepare("SELECT name, value FROM mcp_sync_limits WHERE owner_id = ? AND agent_id = ?")
      .all(scope.ownerId, scope.agentId) as { name: string; value: number }[];
    const merged: Record<string, number> = { ...MCP_SYNC_LIMIT_DEFAULTS };
    for (const { name, value } of rows)
      if ((MCP_SYNC_LIMIT_NAMES as readonly string[]).includes(name))
        merged[name] = Math.min(
          value,
          MCP_SYNC_LIMIT_CEILINGS[name as keyof typeof MCP_SYNC_LIMIT_CEILINGS],
        );
    return Object.freeze(merged) as McpSyncLimits;
  }

  private replacedMemory(input: Scope & { proposalId: string }): string | null {
    const found = this.database
      .prepare(
        `SELECT replaces_memory_id FROM mcp_sync_entries
         WHERE owner_id = ? AND agent_id = ? AND proposal_id = ? AND replaces_memory_id IS NOT NULL
         ORDER BY entry_id LIMIT 1`,
      )
      .pluck()
      .get(input.ownerId, input.agentId, input.proposalId) as string | undefined;
    return found ?? null;
  }

  private projectNotes(
    input: Scope & { projectName: string; maxClassification: McpSyncClassification; limit: number },
  ): { found: boolean; notes: McpProjectNote[] } {
    const known = this.database
      .prepare(
        `SELECT p.merge_group FROM mcp_project_names n
         JOIN mcp_projects p ON p.owner_id = n.owner_id AND p.agent_id = n.agent_id
           AND p.id = n.project_id
         WHERE n.owner_id = ? AND n.agent_id = ? AND n.name = ?`,
      )
      .pluck()
      .get(input.ownerId, input.agentId, input.projectName) as string | undefined;
    if (known === undefined) return { found: false, notes: [] };
    const allowed = MCP_SYNC_CLASSIFICATIONS.filter(
      (value) => (RANK[value] ?? 9) <= (RANK[input.maxClassification] ?? -1),
    );
    if (allowed.length === 0) return { found: true, notes: [] };
    const rows = this.database
      .prepare(
        `SELECT e.entry_id AS entryId, e.stable_id AS stableId, e.project_id AS projectId,
           p.display_name AS projectName, c.name AS connectionName, e.category,
           e.classification, e.content_ref AS contentRef, e.version,
           e.last_synced_at AS lastSyncedAt
         FROM mcp_sync_entries e
         JOIN mcp_projects p ON p.owner_id = e.owner_id AND p.agent_id = e.agent_id
           AND p.id = e.project_id
         JOIN mcp_connections c ON c.id = e.connection_id
         WHERE e.owner_id = ? AND e.agent_id = ? AND p.merge_group = ?
           AND e.kind = 'project_note' AND e.state = ? AND c.status <> 'revoked'
           AND e.source_deleted_at IS NULL
           AND e.classification IN (${allowed.map(() => "?").join(", ")})
         ORDER BY e.last_synced_at DESC, e.entry_id
         LIMIT ?`,
      )
      .all(
        input.ownerId,
        input.agentId,
        known,
        STATE_ACTIVE,
        ...allowed,
        Math.max(1, Math.min(100, Math.trunc(input.limit))),
      ) as McpProjectNote[];
    return { found: true, notes: rows.map((row) => Object.freeze({ ...row })) };
  }

  private push(input: McpSyncPushInput): McpSyncPushResult {
    try {
      return this.pushBatch(input);
    } finally {
      this.dropUnusedPayloads(input);
    }
  }

  private pushBatch(input: McpSyncPushInput): McpSyncPushResult {
    this.assertDiskHeadroom();
    if (
      !instant(input.now) ||
      typeof input.day !== "string" ||
      !DAY.test(input.day) ||
      !Array.isArray(input.items) ||
      !Array.isArray(input.deletes) ||
      !Number.isInteger(input.brakePermille) ||
      input.brakePermille < 0 ||
      input.brakePermille > 1000 ||
      (input.pushPolicy !== "ask" && input.pushPolicy !== "direct") ||
      input.items.some((item) => !this.itemValid(item))
    )
      return this.invalid();
    return this.database.transaction((): McpSyncPushResult => {
      const connection = this.database
        .prepare(
          "SELECT status FROM mcp_connections WHERE id = ? AND owner_id = ? AND agent_id = ?",
        )
        .pluck()
        .get(input.connectionId, input.ownerId, input.agentId) as string | undefined;
      if (connection !== "active") return this.fail("PORT_CONFLICT", "MCP_CONNECTION_NOT_ACTIVE");
      const deletes = this.applyDeletes(input);
      const items = input.items.flatMap((item) => {
        const applied = this.applyItem(input, item);
        return applied === null ? [] : [applied];
      });
      return Object.freeze({ items: Object.freeze(items), deletes: Object.freeze(deletes) });
    })();
  }

  private dropUnusedPayloads(input: McpSyncPushInput): void {
    if (!Array.isArray(input.items)) return;
    const refs = new Set<string>();
    for (const item of input.items) {
      if (typeof item?.contentRef === "string") refs.add(item.contentRef);
      if (typeof item?.proposalContentRef === "string") refs.add(item.proposalContentRef);
    }
    for (const ref of refs) {
      try {
        this.database
          .prepare("DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
          .run(ref, input.ownerId, input.agentId);
      } catch {}
    }
  }

  private itemValid(item: McpSyncPushItem): boolean {
    return (
      Number.isInteger(item.index) &&
      typeof item.stableId === "string" &&
      item.stableId.length > 0 &&
      (item.projectName === null ||
        (typeof item.projectName === "string" && item.projectName.length > 0)) &&
      (MCP_SYNC_KINDS as readonly string[]).includes(item.kind) &&
      (MCP_SYNC_CLASSIFICATIONS as readonly string[]).includes(item.classification) &&
      typeof item.category === "string" &&
      item.category.length > 0 &&
      typeof item.textSha256 === "string" &&
      DIGEST.test(item.textSha256) &&
      typeof item.contentRef === "string" &&
      item.contentRef.length > 0 &&
      typeof item.proposalId === "string" &&
      (item.kind === "project_note" ||
        (typeof item.proposalContentRef === "string" && item.proposalContentRef.length > 0))
    );
  }

  private projectFor(
    scope: Scope,
    name: string | null,
    now: string,
    create: boolean,
  ): string | null {
    if (name === null) return MCP_SYNC_RESERVED_PROJECT_ID;
    const found = this.database
      .prepare(
        "SELECT project_id FROM mcp_project_names WHERE owner_id = ? AND agent_id = ? AND name = ?",
      )
      .pluck()
      .get(scope.ownerId, scope.agentId, name) as string | undefined;
    if (found !== undefined) return found;
    if (!create) return null;
    const id = randomId(MCP_SYNC_PROJECT_ID_PREFIX);
    this.database
      .prepare(
        `INSERT INTO mcp_projects (owner_id, agent_id, id, display_name, merge_group, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(scope.ownerId, scope.agentId, id, name, id, now);
    this.database
      .prepare(
        "INSERT INTO mcp_project_names (owner_id, agent_id, name, project_id) VALUES (?, ?, ?, ?)",
      )
      .run(scope.ownerId, scope.agentId, name, id);
    return id;
  }

  private entry(
    input: McpSyncPushInput,
    projectId: string,
    stableId: string,
  ): EntryRow | undefined {
    return this.database
      .prepare(`${ENTRY_SELECT} WHERE ${ENTRY_KEY}`)
      .get(input.ownerId, input.agentId, input.connectionId, projectId, stableId) as
      | EntryRow
      | undefined;
  }

  private proposal(scope: Scope, id: string | null): ProposalRow | undefined {
    if (id === null) return undefined;
    return this.database
      .prepare(
        `SELECT id, status, memory_id AS memoryId FROM external_memory_proposals
         WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .get(scope.ownerId, scope.agentId, id) as ProposalRow | undefined;
  }

  private memoryGone(scope: Scope, memoryId: string | null): boolean {
    if (memoryId === null) return false;
    const status = this.database
      .prepare("SELECT status FROM memory_records WHERE id = ? AND owner_id = ? AND agent_id = ?")
      .pluck()
      .get(memoryId, scope.ownerId, scope.agentId) as string | undefined;
    return status === "trashed" || status === "deletion_pending" || status === "deleted_verified";
  }

  private liveSharers(scope: Scope, proposalId: string, exceptEntryId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM mcp_sync_entries
           WHERE owner_id = ? AND agent_id = ? AND proposal_id = ? AND entry_id <> ?
             AND state = ? AND source_deleted_at IS NULL LIMIT 1`,
        )
        .get(scope.ownerId, scope.agentId, proposalId, exceptEntryId, STATE_ACTIVE) !== undefined
    );
  }

  private applyDeletes(input: McpSyncPushInput): McpSyncDeleteResult[] {
    if (input.entry !== "service_token")
      return input.deletes.map(({ index }) => ({ index, status: "not_accepted" as const }));
    const results = new Map<number, McpSyncDeleteResult>();
    const candidates = new Map<
      string,
      { project: string; entries: EntryRow[]; deletes: McpSyncPushDelete[] }
    >();
    for (const del of input.deletes) {
      const projectId = this.projectFor(input, del.projectName, input.now, false);
      const row = projectId === null ? undefined : this.entry(input, projectId, del.stableId);
      if (projectId === null || row === undefined || row.textSha256 !== del.versionTag) {
        results.set(del.index, { index: del.index, status: "version_mismatch" });
        continue;
      }
      if (row.state === STATE_DELETED || row.sourceDeletedAt !== null) {
        results.set(del.index, { index: del.index, status: "deleted" });
        continue;
      }
      const group = candidates.get(projectId) ?? { project: projectId, entries: [], deletes: [] };
      group.entries.push(row);
      group.deletes.push(del);
      candidates.set(projectId, group);
    }
    for (const group of [...candidates.values()].sort((a, b) => (a.project < b.project ? -1 : 1))) {
      const day = this.database
        .prepare(
          `SELECT baseline, auto_deleted AS auto FROM mcp_sync_deletion_days
           WHERE owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ? AND day = ?`,
        )
        .get(input.ownerId, input.agentId, input.connectionId, group.project, input.day) as
        | { baseline: number; auto: number }
        | undefined;
      const baseline =
        day?.baseline ??
        (this.database
          .prepare(
            `SELECT COUNT(*) FROM mcp_sync_entries
             WHERE owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ?
               AND state NOT IN (?, ?) AND source_deleted_at IS NULL`,
          )
          .pluck()
          .get(
            input.ownerId,
            input.agentId,
            input.connectionId,
            group.project,
            STATE_DELETED,
            STATE_OWNER_DELETED,
          ) as number);
      const auto = day?.auto ?? 0;
      if (day === undefined)
        this.database
          .prepare(
            `INSERT INTO mcp_sync_deletion_days (
               owner_id, agent_id, connection_id, project_id, day, baseline, auto_deleted
             ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            input.ownerId,
            input.agentId,
            input.connectionId,
            group.project,
            input.day,
            baseline,
          );
      const braked = (group.entries.length + auto) * 1000 > baseline * input.brakePermille;
      if (braked) {
        this.holdForOwner(input, group.project, group.entries);
        for (const del of group.deletes)
          results.set(del.index, { index: del.index, status: "awaiting_owner" });
        continue;
      }
      for (const row of group.entries) this.deleteEntry(input, row);
      this.database
        .prepare(
          `UPDATE mcp_sync_deletion_days SET auto_deleted = auto_deleted + ?
           WHERE owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ? AND day = ?`,
        )
        .run(
          group.entries.length,
          input.ownerId,
          input.agentId,
          input.connectionId,
          group.project,
          input.day,
        );
      for (const del of group.deletes)
        results.set(del.index, { index: del.index, status: "deleted" });
    }
    return input.deletes.map(({ index }) => results.get(index) as McpSyncDeleteResult);
  }

  private holdForOwner(
    input: McpSyncPushInput,
    projectId: string,
    entries: readonly EntryRow[],
  ): void {
    const open = this.database
      .prepare(
        `SELECT id FROM mcp_sync_attention
         WHERE owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ?
           AND status = 'open' ORDER BY created_at, id LIMIT 1`,
      )
      .pluck()
      .get(input.ownerId, input.agentId, input.connectionId, projectId) as string | undefined;
    const id = open ?? randomId("attn-");
    if (open === undefined)
      this.database
        .prepare(
          `INSERT INTO mcp_sync_attention (
             id, owner_id, agent_id, connection_id, project_id, status, created_at
           ) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(id, input.ownerId, input.agentId, input.connectionId, projectId, input.now);
    const link = this.database.prepare(
      `INSERT INTO mcp_sync_attention_entries (attention_id, entry_id) VALUES (?, ?)
       ON CONFLICT (attention_id, entry_id) DO NOTHING`,
    );
    for (const row of entries) link.run(id, row.entryId);
  }

  private deleteEntry(input: Scope & { readonly now: string }, row: EntryRow): void {
    const proposal = this.proposal(input, row.proposalId);
    if (row.kind === "owner" && proposal?.status === "committed") {
      this.database
        .prepare("UPDATE mcp_sync_entries SET source_deleted_at = ? WHERE entry_id = ?")
        .run(input.now, row.entryId);
      return;
    }
    if (
      row.kind === "owner" &&
      proposal?.status === "pending" &&
      !this.liveSharers(input, proposal.id, row.entryId)
    )
      this.database
        .prepare(
          `UPDATE external_memory_proposals SET status = 'superseded', decided_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(input.now, proposal.id);
    this.database
      .prepare("UPDATE mcp_sync_entries SET state = ?, last_synced_at = ? WHERE entry_id = ?")
      .run(STATE_DELETED, input.now, row.entryId);
  }

  private approval(input: McpSyncPushInput, projectId: string): string {
    const found = this.database
      .prepare(
        `SELECT status FROM mcp_project_approvals
         WHERE owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ?`,
      )
      .pluck()
      .get(input.ownerId, input.agentId, input.connectionId, projectId) as string | undefined;
    if (found !== undefined) return found;
    this.database
      .prepare(
        `INSERT INTO mcp_project_approvals (
           owner_id, agent_id, connection_id, project_id, status, created_at
         ) VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.ownerId, input.agentId, input.connectionId, projectId, input.now);
    return "pending";
  }

  private result(
    status: McpSyncItemStatus,
    item: McpSyncPushItem,
    entryId: string,
    projectId: string,
  ): McpSyncItemResult {
    return { index: item.index, status, versionTag: item.textSha256, entryId, projectId };
  }

  private applyItem(input: McpSyncPushInput, item: McpSyncPushItem): McpSyncItemResult | null {
    const projectId = this.projectFor(input, item.projectName, input.now, true) as string;
    const existing = this.entry(input, projectId, item.stableId);
    return item.kind === "owner"
      ? this.applyOwner(input, item, projectId, existing)
      : this.applyNote(input, item, projectId, existing);
  }

  private writeVersion(
    input: McpSyncPushInput,
    item: McpSyncPushItem,
    entryId: string,
    version: number,
    proposalId: string | null,
  ): void {
    this.database
      .prepare(
        `INSERT INTO mcp_sync_versions (
           entry_id, version, text_sha256, content_ref, proposal_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entryId, version, item.textSha256, item.contentRef, proposalId, input.now);
  }

  private applyOwner(
    input: McpSyncPushInput,
    item: McpSyncPushItem,
    projectId: string,
    existing: EntryRow | undefined,
  ): McpSyncItemResult | null {
    if (existing !== undefined && existing.kind !== "owner") return null;
    const previous = this.proposal(input, existing?.proposalId ?? null);
    if (
      existing !== undefined &&
      (existing.state === STATE_OWNER_DELETED ||
        (previous?.status === "committed" && this.memoryGone(input, previous.memoryId)))
    ) {
      this.database
        .prepare("UPDATE mcp_sync_entries SET state = ?, last_synced_at = ? WHERE entry_id = ?")
        .run(STATE_OWNER_DELETED, input.now, existing.entryId);
      return this.result("owner_deleted", item, existing.entryId, projectId);
    }
    if (
      existing !== undefined &&
      existing.textSha256 === item.textSha256 &&
      previous !== undefined &&
      previous.status !== "superseded"
    ) {
      this.database
        .prepare(
          `UPDATE mcp_sync_entries SET state = ?, source_deleted_at = NULL, last_synced_at = ?
           WHERE entry_id = ?`,
        )
        .run(STATE_ACTIVE, input.now, existing.entryId);
      const status: McpSyncItemStatus =
        previous?.status === "rejected" ? "declined_before" : "unchanged";
      return this.result(status, item, existing.entryId, projectId);
    }
    const submitted = this.proposals.execute("externalMemoryProposal.submit", {
      ownerId: input.ownerId,
      agentId: input.agentId,
      id: item.proposalId,
      subjectRef: `mcp-connection:${input.connectionId}`,
      client: input.connectionId,
      sourceKey: null,
      textSha256: item.textSha256,
      normalization: PROPOSAL_NORMALIZATION,
      contentRef: item.proposalContentRef,
      category: item.category,
      dataClassification: item.classification,
      receivedAt: input.now,
    }) as { proposal: ProposalRow & { status: string } };
    const proposal = submitted.proposal;
    const replaces =
      previous?.status === "committed" && previous.memoryId !== null
        ? previous.memoryId
        : (existing?.replacesMemoryId ?? null);
    const status: McpSyncItemStatus =
      proposal.status === "rejected"
        ? "declined_before"
        : proposal.status === "committed"
          ? "saved"
          : existing === undefined
            ? "pending"
            : "updated";
    if (existing === undefined) {
      const entryId = randomId("entry-");
      this.database
        .prepare(
          `INSERT INTO mcp_sync_entries (
             owner_id, agent_id, connection_id, project_id, stable_id, entry_id, kind, category,
             classification, version, text_sha256, content_ref, state, proposal_id,
             replaces_memory_id, source_deleted_at, first_synced_at, last_synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          input.ownerId,
          input.agentId,
          input.connectionId,
          projectId,
          item.stableId,
          entryId,
          item.category,
          item.classification,
          item.textSha256,
          item.contentRef,
          STATE_ACTIVE,
          proposal.id,
          input.now,
          input.now,
        );
      this.writeVersion(input, item, entryId, 1, proposal.id);
      return this.result(status, item, entryId, projectId);
    }
    const version = existing.version + 1;
    this.database
      .prepare(
        `UPDATE mcp_sync_entries SET category = ?, classification = ?, version = ?,
           text_sha256 = ?, content_ref = ?, state = ?, proposal_id = ?, replaces_memory_id = ?,
           source_deleted_at = NULL, last_synced_at = ?
         WHERE entry_id = ?`,
      )
      .run(
        item.category,
        item.classification,
        version,
        item.textSha256,
        item.contentRef,
        STATE_ACTIVE,
        proposal.id,
        replaces,
        input.now,
        existing.entryId,
      );
    this.writeVersion(input, item, existing.entryId, version, proposal.id);
    if (
      previous?.status === "pending" &&
      previous.id !== proposal.id &&
      !this.liveSharers(input, previous.id, existing.entryId)
    )
      this.database
        .prepare(
          `UPDATE external_memory_proposals SET status = 'superseded', decided_at = ?,
             superseded_by = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(input.now, proposal.id, previous.id);
    return this.result(status, item, existing.entryId, projectId);
  }

  private applyNote(
    input: McpSyncPushInput,
    item: McpSyncPushItem,
    projectId: string,
    existing: EntryRow | undefined,
  ): McpSyncItemResult | null {
    if (existing !== undefined && existing.kind !== "project_note") return null;
    if (existing?.state === STATE_OWNER_DELETED)
      return this.result("owner_deleted", item, existing.entryId, projectId);
    const approval = this.approval(input, projectId);
    const state =
      item.classification === "sensitive"
        ? STATE_AWAITING_CONFIRMATION
        : approval === "approved"
          ? STATE_ACTIVE
          : approval === "declined"
            ? STATE_REFUSED
            : STATE_AWAITING_APPROVAL;
    const itemStatus = (changed: boolean): McpSyncItemStatus =>
      state === STATE_ACTIVE
        ? changed
          ? existing === undefined
            ? "saved"
            : "updated"
          : "unchanged"
        : state === STATE_AWAITING_CONFIRMATION
          ? "pending"
          : state === STATE_REFUSED
            ? "declined_before"
            : "awaiting_project_approval";
    if (existing !== undefined && existing.textSha256 === item.textSha256) {
      const keep =
        existing.state === STATE_DELETED || existing.state === STATE_REFUSED
          ? state
          : existing.state;
      const revived = existing.state === STATE_DELETED || existing.sourceDeletedAt !== null;
      const settled = revived ? state : keep;
      this.database
        .prepare(
          `UPDATE mcp_sync_entries SET state = ?, source_deleted_at = NULL, last_synced_at = ?
           WHERE entry_id = ?`,
        )
        .run(settled, input.now, existing.entryId);
      const status: McpSyncItemStatus =
        settled === STATE_ACTIVE
          ? "unchanged"
          : settled === STATE_AWAITING_CONFIRMATION
            ? "pending"
            : settled === STATE_REFUSED
              ? "declined_before"
              : "awaiting_project_approval";
      return this.result(status, item, existing.entryId, projectId);
    }
    if (existing === undefined) {
      const entryId = randomId("entry-");
      this.database
        .prepare(
          `INSERT INTO mcp_sync_entries (
             owner_id, agent_id, connection_id, project_id, stable_id, entry_id, kind, category,
             classification, version, text_sha256, content_ref, state, proposal_id,
             replaces_memory_id, source_deleted_at, first_synced_at, last_synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'project_note', ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          input.ownerId,
          input.agentId,
          input.connectionId,
          projectId,
          item.stableId,
          entryId,
          item.category,
          item.classification,
          item.textSha256,
          item.contentRef,
          state,
          input.now,
          input.now,
        );
      this.writeVersion(input, item, entryId, 1, null);
      return this.result(itemStatus(true), item, entryId, projectId);
    }
    const version = existing.version + 1;
    this.database
      .prepare(
        `UPDATE mcp_sync_entries SET category = ?, classification = ?, version = ?,
           text_sha256 = ?, content_ref = ?, state = ?, source_deleted_at = NULL,
           last_synced_at = ?
         WHERE entry_id = ?`,
      )
      .run(
        item.category,
        item.classification,
        version,
        item.textSha256,
        item.contentRef,
        state,
        input.now,
        existing.entryId,
      );
    this.writeVersion(input, item, existing.entryId, version, null);
    return this.result(itemStatus(true), item, existing.entryId, projectId);
  }

  private projectName(scope: Scope, projectId: string): string | null {
    if (projectId === MCP_SYNC_RESERVED_PROJECT_ID) return null;
    return (
      (this.database
        .prepare(
          "SELECT display_name FROM mcp_projects WHERE owner_id = ? AND agent_id = ? AND id = ?",
        )
        .pluck()
        .get(scope.ownerId, scope.agentId, projectId) as string | undefined) ?? null
    );
  }

  private overview(input: Scope & { limit: number }): McpSyncOverview {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) this.invalid();
    const pendingStates = [STATE_AWAITING_APPROVAL, STATE_AWAITING_CONFIRMATION, STATE_REFUSED];
    const marks = pendingStates.map(() => "?").join(", ");
    const total = this.database
      .prepare(
        `SELECT COUNT(*) FROM mcp_sync_entries
         WHERE owner_id = ? AND agent_id = ? AND state IN (${marks})
           AND (kind = 'project_note' OR state = ?)`,
      )
      .pluck()
      .get(input.ownerId, input.agentId, ...pendingStates, STATE_REFUSED) as number;
    const rows = this.database
      .prepare(
        `SELECT e.entry_id AS entryId, e.connection_id AS connectionId,
           c.name AS connectionName, e.project_id AS projectId, e.kind, e.category,
           e.classification, e.state, e.version, e.content_ref AS contentRef,
           e.source_deleted_at AS sourceDeletedAt, e.last_synced_at AS lastSyncedAt,
           (SELECT v.content_ref FROM mcp_sync_versions v
             WHERE v.entry_id = e.entry_id AND v.version < e.version
             ORDER BY v.version DESC LIMIT 1) AS previousContentRef
         FROM mcp_sync_entries e JOIN mcp_connections c ON c.id = e.connection_id
         WHERE e.owner_id = ? AND e.agent_id = ? AND e.state IN (${marks})
           AND (e.kind = 'project_note' OR e.state = ?)
         ORDER BY e.connection_id, e.project_id, e.last_synced_at DESC, e.entry_id
         LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, ...pendingStates, STATE_REFUSED, input.limit) as {
      entryId: string;
      connectionId: string;
      connectionName: string;
      projectId: string;
      kind: McpSyncPendingEntry["kind"];
      category: string;
      classification: McpSyncPendingEntry["classification"];
      state: McpSyncPendingEntry["state"];
      version: number;
      contentRef: string;
      sourceDeletedAt: string | null;
      lastSyncedAt: string;
      previousContentRef: string | null;
    }[];
    const entries: McpSyncPendingEntry[] = rows.map(({ sourceDeletedAt, ...row }) => ({
      ...row,
      projectName: this.projectName(input, row.projectId),
      sourceDeleted: sourceDeletedAt !== null,
    }));
    const projects = (
      this.database
        .prepare(
          `SELECT connection_id AS connectionId, project_id AS projectId, status AS approval
           FROM mcp_project_approvals WHERE owner_id = ? AND agent_id = ?
           ORDER BY connection_id, project_id`,
        )
        .all(input.ownerId, input.agentId) as {
        connectionId: string;
        projectId: string;
        approval: McpSyncProjectView["approval"];
      }[]
    ).map((row) => ({ ...row, projectName: this.projectName(input, row.projectId) }));
    const attention = (
      this.database
        .prepare(
          `SELECT a.id AS attentionId, a.connection_id AS connectionId, a.project_id AS projectId,
             a.created_at AS createdAt,
             (SELECT COUNT(*) FROM mcp_sync_attention_entries x WHERE x.attention_id = a.id)
               AS heldEntries,
             COALESCE((SELECT d.baseline FROM mcp_sync_deletion_days d
               WHERE d.owner_id = a.owner_id AND d.agent_id = a.agent_id
                 AND d.connection_id = a.connection_id AND d.project_id = a.project_id
               ORDER BY d.day DESC LIMIT 1), 0) AS baseline
           FROM mcp_sync_attention a
           WHERE a.owner_id = ? AND a.agent_id = ? AND a.status = 'open'
           ORDER BY a.created_at, a.id`,
        )
        .all(input.ownerId, input.agentId) as Omit<McpSyncAttentionView, "projectName">[]
    ).map((row) => ({ ...row, projectName: this.projectName(input, row.projectId) }));
    return { projects, entries, entriesTotal: total, attention };
  }

  private decideProject(
    input: Scope & {
      connectionId: string;
      projectId: string;
      decision: McpSyncProjectDecision;
      now: string;
    },
  ): { found: boolean; changed: number } {
    if (!instant(input.now) || (input.decision !== "approve" && input.decision !== "decline"))
      this.invalid();
    const status = input.decision === "approve" ? "approved" : "declined";
    const found = this.database
      .prepare(
        `UPDATE mcp_project_approvals SET status = ?, decided_at = ?
         WHERE owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ?`,
      )
      .run(status, input.now, input.ownerId, input.agentId, input.connectionId, input.projectId);
    if (found.changes === 0) return { found: false, changed: 0 };
    const rows = this.database
      .prepare(
        `SELECT entry_id AS entryId, classification FROM mcp_sync_entries
         WHERE owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ?
           AND kind = 'project_note' AND state IN (?, ?)`,
      )
      .all(
        input.ownerId,
        input.agentId,
        input.connectionId,
        input.projectId,
        STATE_AWAITING_APPROVAL,
        STATE_REFUSED,
      ) as { entryId: string; classification: string }[];
    const move = this.database.prepare(
      "UPDATE mcp_sync_entries SET state = ? WHERE entry_id = ? AND state IN (?, ?)",
    );
    let changed = 0;
    for (const row of rows) {
      const state =
        input.decision === "decline"
          ? STATE_REFUSED
          : row.classification === "sensitive"
            ? STATE_AWAITING_CONFIRMATION
            : STATE_ACTIVE;
      changed += move.run(state, row.entryId, STATE_AWAITING_APPROVAL, STATE_REFUSED).changes;
    }
    return { found: true, changed };
  }

  private decideNote(
    input: Scope & { entryId: string; decision: McpSyncNoteDecision; now: string },
  ): { found: boolean; state: string | null } {
    if (
      !instant(input.now) ||
      !["confirm", "refuse", "restore"].includes(input.decision) ||
      typeof input.entryId !== "string"
    )
      this.invalid();
    const row = this.database
      .prepare(
        `SELECT state, connection_id AS connectionId, project_id AS projectId
         FROM mcp_sync_entries
         WHERE owner_id = ? AND agent_id = ? AND entry_id = ? AND kind = 'project_note'`,
      )
      .get(input.ownerId, input.agentId, input.entryId) as
      | { state: string; connectionId: string; projectId: string }
      | undefined;
    if (row === undefined) return { found: false, state: null };
    let next: string = row.state;
    if (input.decision === "confirm" && row.state === STATE_AWAITING_CONFIRMATION)
      next = STATE_ACTIVE;
    else if (
      input.decision === "refuse" &&
      (row.state === STATE_AWAITING_CONFIRMATION || row.state === STATE_ACTIVE)
    )
      next = STATE_REFUSED;
    else if (input.decision === "restore" && row.state === STATE_REFUSED) {
      const approval = this.database
        .prepare(
          `SELECT status FROM mcp_project_approvals
           WHERE owner_id = ? AND agent_id = ? AND connection_id = ? AND project_id = ?`,
        )
        .pluck()
        .get(input.ownerId, input.agentId, row.connectionId, row.projectId) as string | undefined;
      next = approval === "approved" ? STATE_AWAITING_CONFIRMATION : STATE_AWAITING_APPROVAL;
    }
    if (next !== row.state)
      this.database
        .prepare("UPDATE mcp_sync_entries SET state = ? WHERE entry_id = ?")
        .run(next, input.entryId);
    return { found: true, state: next };
  }

  private resolveAttention(
    input: Scope & { attentionId: string; decision: McpSyncAttentionDecision; now: string },
  ): { found: boolean; released: number } {
    if (!instant(input.now) || (input.decision !== "release" && input.decision !== "keep"))
      this.invalid();
    const open = this.database
      .prepare(
        `SELECT id FROM mcp_sync_attention
         WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'open'`,
      )
      .get(input.attentionId, input.ownerId, input.agentId);
    if (open === undefined) return { found: false, released: 0 };
    let released = 0;
    if (input.decision === "release") {
      const rows = this.database
        .prepare(
          `${ENTRY_SELECT} WHERE entry_id IN (
             SELECT entry_id FROM mcp_sync_attention_entries WHERE attention_id = ?)
           AND state NOT IN (?, ?) AND source_deleted_at IS NULL`,
        )
        .all(input.attentionId, STATE_DELETED, STATE_OWNER_DELETED) as EntryRow[];
      for (const row of rows) this.deleteEntry(input, row);
      released = rows.length;
    }
    this.database
      .prepare("UPDATE mcp_sync_attention SET status = 'resolved', resolved_at = ? WHERE id = ?")
      .run(input.now, input.attentionId);
    return { found: true, released };
  }
}
