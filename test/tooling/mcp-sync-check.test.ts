import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MCP_SYNC_RESERVED_PROJECT_ID,
  type McpMemorySyncStorePort,
  MEMORY_CATEGORIES,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import { MEMORY_EXTERNAL_CATEGORY_NAMES, machineString } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { EXTERNAL_PROPOSAL_CATEGORIES as WRITER_CATEGORIES } from "../../apps/agent-service/src/production-mcp-memory-writer.ts";
import {
  MCP_SYNC_CATEGORIES,
  ProductionMcpSync,
} from "../../apps/agent-service/src/production-mcp-sync.ts";
import { EXTERNAL_PROPOSAL_CATEGORIES as EXPORT_CATEGORIES } from "../../packages/persistence-sqlite/src/data-export/schemas.ts";
import { EXTERNAL_PROPOSAL_STORE_CATEGORIES } from "../../packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts";
import { SqliteMcpMemorySyncOperations } from "../../packages/persistence-sqlite/src/sqlite-mcp-memory-sync-operations.ts";

const OWNER_ID = createOwnerId("owner-sync-check");
const AGENT_ID = createAgentId("agent-sync-check");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-15T03:00:00.000Z";

const expected = MEMORY_CATEGORIES.filter((category) => category !== "rule");

function sameCategories(copy: readonly string[], reference: readonly string[] = expected): boolean {
  return (
    copy.length === reference.length &&
    new Set(copy).size === copy.length &&
    reference.every((category) => copy.includes(category))
  );
}

function tableCheck(database: ReturnType<typeof openQualifiedDatabase>): string[] {
  const row = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_memory_proposals'",
    )
    .get() as { sql: string };
  const match = /category TEXT NOT NULL CHECK \(\s*category IN \(([^)]*)\)/u.exec(row.sql);
  return [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/gu)].map((entry) => entry[1] as string);
}

describe("[P5-C][check] one list of external memory categories, one set of keys", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function database() {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-sync-check-"));
    directories.push(directory);
    const db = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    applyMigrations(db, await loadBundledMigrations());
    db.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    db.prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)").run(
      AGENT_ID,
      OWNER_ID,
    );
    return db;
  }

  it("every copy of the category list equals MEMORY_CATEGORIES without rule", async () => {
    const db = await database();
    try {
      const copies: Record<string, readonly string[]> = {
        "production-mcp-memory-writer EXTERNAL_PROPOSAL_CATEGORIES": WRITER_CATEGORIES,
        "sqlite-external-memory-proposal-operations categories": EXTERNAL_PROPOSAL_STORE_CATEGORIES,
        "data-export schemas EXTERNAL_PROPOSAL_CATEGORIES": EXPORT_CATEGORIES,
        "contracts-v2 MEMORY_EXTERNAL_CATEGORY_NAMES": MEMORY_EXTERNAL_CATEGORY_NAMES,
        "production-mcp-sync MCP_SYNC_CATEGORIES": MCP_SYNC_CATEGORIES,
        "external_memory_proposals CHECK after all migrations": tableCheck(db),
      };
      expect(expected).not.toContain("rule");
      expect(Object.entries(copies).filter(([, copy]) => !sameCategories(copy))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("fails when a copy has one too many or one too few, or repeats one", () => {
    expect(sameCategories([...expected, "rule"])).toBe(false);
    expect(sameCategories(expected.slice(1))).toBe(false);
    expect(sameCategories([...expected.slice(1), expected[1] as string])).toBe(false);
    expect(sameCategories(expected)).toBe(true);
  });

  it("walks identifiers from the push side to storage and back through the generated keys", async () => {
    const db = await database();
    try {
      db.pragma("foreign_keys = OFF");
      db.prepare(
        `INSERT INTO mcp_connections (id, owner_id, agent_id, name, secret_sha256, capabilities,
          read_ceiling, push_policy, status, created_at, updated_at)
         VALUES ('conn-check', ?, ?, 'check', ?, '[]', 'private', 'ask', 'active', ?, ?)`,
      ).run(OWNER_ID, AGENT_ID, "a".repeat(64), NOW, NOW);
      const ops = new SqliteMcpMemorySyncOperations(
        db,
        (code, message) => {
          throw new Error(`${code}:${message}`);
        },
        () => undefined,
      );
      const store: McpMemorySyncStorePort = {
        push: async (input) => ops.execute("mcpMemorySync.push", input) as never,
        limits: async (input) => ops.execute("mcpMemorySync.limits", input) as never,
        projectNotes: async (input) => ops.execute("mcpMemorySync.projectNotes", input) as never,
        replacedMemory: async (input) =>
          ops.execute("mcpMemorySync.replacedMemory", input) as never,
        overview: async (input) => ops.execute("mcpMemorySync.overview", input) as never,
        decideProject: async (input) => ops.execute("mcpMemorySync.decideProject", input) as never,
        decideNote: async (input) => ops.execute("mcpMemorySync.decideNote", input) as never,
        resolveAttention: async (input) =>
          ops.execute("mcpMemorySync.resolveAttention", input) as never,
      };
      const payloads = new Map<string, never>();
      const adapters = createReferenceAdapterSet();
      const sync = new ProductionMcpSync({
        configuration: scope,
        store,
        payloads: {
          get: async (ref: string) => payloads.get(ref),
          put: async (payload: { ref: string }) => {
            payloads.set(payload.ref, payload as never);
          },
        } as never,
        protector: adapters.payloadProtector,
        clock: { now: () => NOW },
        timeZone: "Asia/Tokyo",
      });
      const ids = [
        "~/.claude/projects/a b/memory/偏好.md",
        "x".repeat(400),
        "项目/笔记 一.md",
        "plain",
      ];
      const result = await sync.sync(
        { id: "conn-check", entry: "oauth" },
        {
          entries: ids.map((id, index) => ({
            id,
            text: `内容 ${index}`,
            kind: "project_note",
            project: "调研 #2",
          })),
        },
      );
      expect(result.entries.map(({ status }) => status)).toEqual(
        ids.map(() => "awaiting_project_approval"),
      );
      const rows = db
        .prepare("SELECT entry_id, project_id, stable_id FROM mcp_sync_entries ORDER BY stable_id")
        .all() as { entry_id: string; project_id: string; stable_id: string }[];
      expect(rows.map(({ stable_id }) => stable_id).sort()).toEqual([...ids].sort());
      for (const row of rows) {
        expect(() => machineString.parse(row.entry_id)).not.toThrow();
        expect(() => machineString.parse(row.project_id)).not.toThrow();
        expect(row.entry_id).not.toBe(row.stable_id);
        expect(row.project_id).not.toBe(MCP_SYNC_RESERVED_PROJECT_ID);
      }
      expect(() => machineString.parse(MCP_SYNC_RESERVED_PROJECT_ID)).not.toThrow();
      expect(() => machineString.parse("x".repeat(400))).toThrow();
      expect(() => machineString.parse("~/.claude/projects/a b/memory/偏好.md")).toThrow();
      db.exec(
        "UPDATE mcp_project_approvals SET status = 'approved'; UPDATE mcp_sync_entries SET state = 'active'",
      );
      const found = await store.projectNotes({
        ...scope,
        projectName: "调研 #2",
        maxClassification: "private",
        limit: 10,
      });
      expect(found.notes.map(({ stableId }) => stableId).sort()).toEqual([...ids].sort());
    } finally {
      db.close();
    }
  });
});
