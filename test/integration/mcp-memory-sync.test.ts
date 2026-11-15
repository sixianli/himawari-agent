import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MCP_SYNC_LIMIT_DEFAULTS } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpConnectionSecretDigest,
  newMcpConnectionSecret,
} from "../../apps/agent-service/src/production-mcp-connections.ts";
import {
  MCP_SYNC_BATCH_TOO_LARGE,
  MCP_SYNC_FULL,
  ProductionMcpSync,
} from "../../apps/agent-service/src/production-mcp-sync.ts";

const OWNER_ID = createOwnerId("owner-mcp-sync");
const AGENT_ID = createAgentId("agent-mcp-sync");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-15T03:00:00.000Z";
const OAUTH = "oauth" as const;
const HOOK = "service_token" as const;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("[P5-C] sync_memories storage and deletion rules", () => {
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-mcp-sync-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => NOW,
    });
    closers.push(() => repository.close());
    const adapters = createReferenceAdapterSet();
    const connections = repository.mcpConnections();
    const connection = async (id: string) => {
      await connections.create({
        ...scope,
        id,
        name: `接入-${id}`,
        secretSha256: mcpConnectionSecretDigest(newMcpConnectionSecret()),
        capabilities: ["mcp"],
        readCeiling: "private",
        pushPolicy: "ask",
        createdAt: NOW,
      });
      return id;
    };
    const first = await connection("conn-first");
    const second = await connection("conn-second");
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const sync = new ProductionMcpSync({
      configuration: scope,
      store: repository.mcpMemorySync(),
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => NOW },
      timeZone: "Asia/Tokyo",
    });
    const raw = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    closers.push(async () => {
      raw.close();
    });
    return { sync, first, second, raw, repository, adapters, payloads };
  }

  const owner = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    id,
    text,
    kind: "about_owner",
    ...extra,
  });
  const note = (id: string, text: string, project: string | undefined, extra = {}) => ({
    id,
    text,
    kind: "project_note",
    ...(project === undefined ? {} : { project }),
    ...extra,
  });

  it("stores about-owner entries as pending, keeps versions and ignores a resend", async () => {
    const { sync, first, raw } = await setup();
    const one = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [owner("notes/偏好 一.md", "主人喜欢早上开会")] },
    );
    expect(one.entries).toEqual([
      { index: 0, status: "pending", versionTag: sha("主人喜欢早上开会") },
    ]);
    const again = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [owner("notes/偏好 一.md", "主人喜欢早上开会")] },
    );
    expect(again.entries[0]).toMatchObject({ status: "unchanged" });
    const changed = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [owner("notes/偏好 一.md", "主人喜欢下午开会")] },
    );
    expect(changed.entries[0]).toMatchObject({
      status: "updated",
      versionTag: sha("主人喜欢下午开会"),
    });
    expect(
      raw
        .prepare("SELECT status, COUNT(*) AS n FROM external_memory_proposals GROUP BY status")
        .all(),
    ).toEqual([
      { status: "pending", n: 1 },
      { status: "superseded", n: 1 },
    ]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries").get()).toEqual({ n: 1 });
    expect(raw.prepare("SELECT version FROM mcp_sync_versions ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    expect(raw.prepare("SELECT version FROM mcp_sync_entries").get()).toEqual({ version: 2 });
  });

  it("stores the business key in three columns and never merges two projects", async () => {
    const { sync, first, raw } = await setup();
    await sync.sync(
      { id: first, entry: HOOK },
      {
        entries: [
          note("a:b", "第一份笔记 alpha", "项目甲"),
          note("a", "第二份笔记 beta", "b:项目甲"),
          note("a:b", "第三份笔记 gamma", "项目乙"),
          owner("a:b", "无项目的内容 delta"),
        ],
      },
    );
    const rows = raw
      .prepare(
        "SELECT connection_id, project_id, stable_id FROM mcp_sync_entries ORDER BY stable_id, project_id",
      )
      .all() as { connection_id: string; project_id: string; stable_id: string }[];
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => `${row.project_id}|${row.stable_id}`)).size).toBe(4);
    expect(rows.some((row) => row.project_id === "proj-none")).toBe(true);
    const generated = rows.filter((row) => row.project_id !== "proj-none");
    for (const row of generated) expect(row.project_id).toMatch(/^proj-[0-9a-f]{24}$/u);
    await sync.sync({ id: first, entry: HOOK }, { entries: [owner("a:b", "无项目的内容 delta")] });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries").get()).toEqual({ n: 4 });
  });

  it("accepts plain-text identifiers and refuses hidden characters and over-long ones", async () => {
    const { sync, first } = await setup();
    const ok = [
      "~/.claude/projects/a b/memory/偏好.md",
      "x".repeat(400),
      "Q3: 计划 #2",
      "C:\\Users\\me\\notes.md",
    ];
    const bad = [
      "a\u0000b",
      "a\u200bb",
      "a\u202eb",
      "a\u2028b",
      "x".repeat(MCP_SYNC_LIMIT_DEFAULTS.stable_id_chars + 1),
      "",
    ];
    const result = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [...ok, ...bad].map((id, index) => owner(id, `内容 ${index}`)) },
    );
    expect(result.entries.slice(0, ok.length).every((entry) => entry.status === "pending")).toBe(
      true,
    );
    expect(result.entries.slice(ok.length)).toEqual(
      bad.map((_, offset) => ({
        index: ok.length + offset,
        status: "invalid",
        reason: "id_invalid",
        detail: offset === 4 ? "too_long" : offset === 5 ? "empty" : "hidden_character",
      })),
    );
  });

  describe("project names", () => {
    const accepted = [
      "调研#2",
      "Q3?计划",
      "Q3: 计划 #2",
      "meeting: bob@corp.com",
      "看 https://x.com/a 的笔记",
      "C:\\Users\\me\\notes",
      "主机/路径?token=1",
      "  带空白的名字  ",
    ];
    const refused = [
      "https://用户:令牌@主机/路径",
      "HTTPS://用户:令牌@主机/路径",
      "//用户:令牌@主机/路径",
      "https:/用户:令牌@主机/路径",
      "https:用户:令牌@主机/路径",
      "https://:令牌@主机/路径",
      "https:\\\\用户:令牌@主机\\路径",
      "https:\\用户:令牌@主机\\路径",
      " https://用户:令牌@主机/路径 ",
      "https://主机/路径?token=1",
      "https://主机/路径#frag",
      "https:/主机/路径?token=1",
      "https://用户:令牌@/路径",
      "//用户:令牌@/路径",
      "看 https://用户:令牌@主机/路径",
      "用户:令牌@主机/路径",
      "用户@主机:路径",
      "meeting:bob@corp.com",
      "proj\u200bect",
    ];

    it("keeps ordinary names as plain text and groups NFC variants and padding", async () => {
      const { sync, first, raw } = await setup();
      const result = await sync.sync(
        { id: first, entry: OAUTH },
        {
          entries: accepted.map((project, index) => note(`id-${index}`, `笔记 ${index}`, project)),
        },
      );
      expect(result.entries.every((entry) => entry.status === "awaiting_project_approval")).toBe(
        true,
      );
      const names = (
        raw.prepare("SELECT name FROM mcp_project_names ORDER BY name").all() as { name: string }[]
      ).map(({ name }) => name);
      expect(names).toContain("Q3: 计划 #2");
      expect(names).toContain("带空白的名字");
      const composed = "café";
      const decomposed = "cafe\u0301";
      await sync.sync(
        { id: first, entry: OAUTH },
        {
          entries: [note("n1", "一", composed), note("n2", "二", ` ${decomposed} `)],
        },
      );
      const projects = raw
        .prepare("SELECT DISTINCT project_id FROM mcp_sync_entries WHERE stable_id IN ('n1', 'n2')")
        .all();
      expect(projects).toHaveLength(1);
    });

    it("refuses names that carry credentials without echoing them anywhere", async () => {
      const { sync, first, raw } = await setup();
      for (const project of refused) {
        const result = await sync.sync(
          { id: first, entry: OAUTH },
          { entries: [note("secret-id", "正文", project)] },
        );
        expect(result.entries[0]).toMatchObject({ status: "invalid", reason: "project_invalid" });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("令牌");
        expect(serialized).not.toContain("token");
      }
      expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries").get()).toEqual({ n: 0 });
      expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_projects").get()).toEqual({ n: 0 });
    });
  });

  it("checks the category hint and judges sensitivity itself", async () => {
    const { sync, first, raw } = await setup();
    const result = await sync.sync(
      { id: first, entry: OAUTH },
      {
        entries: [
          owner("a", "没写类别"),
          owner("b", "写了错的类别", { category: "rule" }),
          owner("c", "类别类型不对", { category: 3 }),
          owner("d", "每月在家服药", { category: "health" }),
          note("e", "对方把健康内容标成项目笔记", "项目甲", { category: "health" }),
        ],
      },
    );
    expect(result.entries.map(({ status }) => status)).toEqual([
      "pending",
      "invalid",
      "invalid",
      "pending",
      "pending",
    ]);
    expect(result.entries[1]).toMatchObject({
      reason: "category_unknown",
      allowedCategories: expect.arrayContaining(["other", "health"]),
    });
    expect(result.entries[1]?.allowedCategories).not.toContain("rule");
    expect(
      raw.prepare("SELECT category FROM mcp_sync_entries WHERE stable_id = 'a'").get(),
    ).toEqual({
      category: "other",
    });
    expect(
      raw
        .prepare("SELECT classification FROM external_memory_proposals WHERE category = 'health'")
        .get(),
    ).toEqual({
      classification: "sensitive",
    });
    expect(
      raw.prepare("SELECT state, classification FROM mcp_sync_entries WHERE stable_id = 'e'").get(),
    ).toEqual({
      state: "awaiting_confirmation",
      classification: "sensitive",
    });
  });

  it("refuses machine secrets and bad batches without storing anything", async () => {
    const { sync, first, raw } = await setup();
    const secret = await sync.sync(
      { id: first, entry: OAUTH },
      {
        entries: [owner("k", `token ${["sk", "a1b2".repeat(12)].join("-")}`)],
      },
    );
    expect(secret.entries[0]).toMatchObject({ status: "invalid", reason: "secret" });
    await expect(sync.sync({ id: first, entry: OAUTH }, {})).rejects.toThrow(
      "MCP_SYNC_REQUEST_INVALID",
    );
    await expect(
      sync.sync(
        { id: first, entry: OAUTH },
        {
          entries: Array.from({ length: MCP_SYNC_LIMIT_DEFAULTS.batch_entries + 1 }, (_, i) =>
            owner(`e${i}`, `内容 ${i}`),
          ),
        },
      ),
    ).rejects.toThrow(MCP_SYNC_BATCH_TOO_LARGE);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries").get()).toEqual({ n: 0 });
  });

  it("rolls the whole batch back when one entry cannot be stored", async () => {
    const { sync, first, raw } = await setup();
    raw.exec("PRAGMA foreign_keys = OFF");
    const insert = raw.prepare(
      `INSERT INTO external_memory_proposals (id, owner_id, agent_id, subject_ref, client, text_sha256,
        normalization, content_ref, category, classification, status, received_at)
       VALUES (?, ?, ?, 's', 'c', ?, 'mcp-text:v1', 'ref', 'other', 'private', 'pending', ?)`,
    );
    for (let index = 0; index < 999; index += 1)
      insert.run(`filler-${index}`, OWNER_ID, AGENT_ID, sha(`filler-${index}`), NOW);
    raw.exec("PRAGMA foreign_keys = ON");
    await expect(
      sync.sync(
        { id: first, entry: OAUTH },
        { entries: [owner("one", "第一条"), owner("two", "第二条")] },
      ),
    ).rejects.toThrow(MCP_SYNC_FULL);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_versions").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM external_memory_proposals").get()).toEqual({
      n: 999,
    });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM payloads").get()).toEqual({ n: 0 });
  });

  it("keeps stored text that a rolled back batch did not use and drops only the unused", async () => {
    const { sync, first, raw } = await setup();
    await sync.sync({ id: first, entry: OAUTH }, { entries: [owner("kept", "已经存下的内容")] });
    const before = raw.prepare("SELECT COUNT(*) AS n FROM payloads").get();
    raw.exec("PRAGMA foreign_keys = OFF");
    const insert = raw.prepare(
      `INSERT INTO external_memory_proposals (id, owner_id, agent_id, subject_ref, client, text_sha256,
        normalization, content_ref, category, classification, status, received_at)
       VALUES (?, ?, ?, 's', 'c', ?, 'mcp-text:v1', 'ref', 'other', 'private', 'pending', ?)`,
    );
    for (let index = 0; index < 999; index += 1)
      insert.run(`filler-${index}`, OWNER_ID, AGENT_ID, sha(`filler-${index}`), NOW);
    raw.exec("PRAGMA foreign_keys = ON");
    await expect(
      sync.sync(
        { id: first, entry: OAUTH },
        { entries: [owner("kept", "已经存下的内容"), owner("new", "没存成的内容")] },
      ),
    ).rejects.toThrow(MCP_SYNC_FULL);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM payloads").get()).toEqual(before);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries").get()).toEqual({ n: 1 });
  });

  it("marks only the entry whose kind changed as invalid and still saves the others", async () => {
    const { sync, first, raw } = await setup();
    await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [owner("x", "关于主人的一句话", { project: "项目甲" })] },
    );
    const result = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [note("x", "改成项目笔记", "项目甲"), owner("y", "另一条内容")] },
    );
    expect(result.entries[1]).toMatchObject({ index: 1, status: "pending" });
    expect(result.entries[0]).toEqual({ index: 0, status: "invalid", reason: "kind_changed" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries").get()).toEqual({ n: 2 });
    await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [note("z", "项目甲的笔记", "项目甲")] },
    );
    const payloadsBefore = raw.prepare("SELECT COUNT(*) AS n FROM payloads").get();
    const sameProject = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [owner("z", "同编号别的种类", { project: "项目甲" })] },
    );
    expect(sameProject.entries).toEqual([{ index: 0, status: "invalid", reason: "kind_changed" }]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM payloads").get()).toEqual(payloadsBefore);
  });

  it("refuses a project note with no project and keeps it out of storage", async () => {
    const { sync, first, raw } = await setup();
    const result = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [note("n1", "没有项目的笔记", undefined), note("n2", "空项目名", "   ")] },
    );
    expect(result.entries).toEqual([
      { index: 0, status: "invalid", reason: "project_invalid", detail: "empty" },
      { index: 1, status: "invalid", reason: "project_invalid", detail: "empty" },
    ]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_project_approvals").get()).toEqual({ n: 0 });
  });

  describe("deletion", () => {
    async function withFour() {
      const harness = await setup();
      const pushed = await harness.sync.sync(
        { id: harness.first, entry: HOOK },
        {
          entries: ["a", "b", "c", "d"].map((id) =>
            owner(id, `关于主人的内容 ${id}`, { project: "P" }),
          ),
        },
      );
      const tags = new Map(
        pushed.entries.map((entry, index) => [
          ["a", "b", "c", "d"][index],
          entry.versionTag as string,
        ]),
      );
      const del = (id: string, tag?: string) => ({
        id,
        project: "P",
        versionTag: tag ?? (tags.get(id) as string),
      });
      return { ...harness, tags, del };
    }

    it("does not accept deletions that arrive through the OAuth login", async () => {
      const { sync, first, raw, del } = await withFour();
      const result = await sync.sync({ id: first, entry: OAUTH }, { deletes: [del("a")] });
      expect(result.deletes).toEqual([{ index: 0, status: "not_accepted" }]);
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries WHERE state = 'active'").get(),
      ).toEqual({ n: 4 });
      expect(
        raw
          .prepare("SELECT COUNT(*) AS n FROM external_memory_proposals WHERE status = 'pending'")
          .get(),
      ).toEqual({ n: 4 });
    });

    it("withdraws a pending entry, marks a confirmed one, and refuses a stale tag", async () => {
      const { sync, first, raw, del, tags } = await withFour();
      raw.exec(
        `UPDATE external_memory_proposals SET status = 'committed', decided_at = '${NOW}'
         WHERE id = (SELECT proposal_id FROM mcp_sync_entries WHERE stable_id = 'b')`,
      );
      const result = await sync.sync(
        { id: first, entry: HOOK },
        { deletes: [del("a"), del("b"), del("c", sha("旧内容")), del("zzz", tags.get("a"))] },
      );
      expect(result.deletes.map(({ status }) => status)).toEqual([
        "deleted",
        "deleted",
        "version_mismatch",
        "version_mismatch",
      ]);
      expect(
        raw
          .prepare(
            `SELECT e.stable_id AS id, e.state, e.source_deleted_at AS marked, p.status
             FROM mcp_sync_entries e JOIN external_memory_proposals p ON p.id = e.proposal_id
             WHERE e.stable_id IN ('a', 'b', 'c') ORDER BY e.stable_id`,
          )
          .all(),
      ).toEqual([
        { id: "a", state: "deleted", marked: null, status: "superseded" },
        { id: "b", state: "active", marked: NOW, status: "committed" },
        { id: "c", state: "active", marked: null, status: "pending" },
      ]);
      const again = await sync.sync({ id: first, entry: HOOK }, { deletes: [del("a")] });
      expect(again.deletes[0]?.status).toBe("deleted");
    });

    it("reports a malformed deletion as invalid", async () => {
      const { sync, first } = await withFour();
      const result = await sync.sync(
        { id: first, entry: HOOK },
        {
          deletes: [
            { project: "P", versionTag: sha("x") },
            { id: "a", project: "P" },
            { id: "a", project: "P", versionTag: "short" },
          ],
        },
      );
      expect(result.deletes.map(({ status }) => status)).toEqual(["invalid", "invalid", "invalid"]);
    });

    it("brakes at more than half a day and cannot be walked around with several requests", async () => {
      const { sync, first, raw, del } = await withFour();
      const two = await sync.sync({ id: first, entry: HOOK }, { deletes: [del("a"), del("b")] });
      expect(two.deletes.map(({ status }) => status)).toEqual(["deleted", "deleted"]);
      const third = await sync.sync({ id: first, entry: HOOK }, { deletes: [del("c")] });
      expect(third.deletes[0]?.status).toBe("awaiting_owner");
      const fourth = await sync.sync({ id: first, entry: HOOK }, { deletes: [del("d")] });
      expect(fourth.deletes[0]?.status).toBe("awaiting_owner");
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries WHERE state = 'active'").get(),
      ).toEqual({ n: 2 });
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_attention WHERE status = 'open'").get(),
      ).toEqual({ n: 1 });
      expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_attention_entries").get()).toEqual({
        n: 2,
      });
      const resent = await sync.sync({ id: first, entry: HOOK }, { deletes: [del("c")] });
      expect(resent.deletes[0]?.status).toBe("awaiting_owner");
      expect(raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_attention_entries").get()).toEqual({
        n: 2,
      });
    });

    it("brakes a whole emptied folder in one request and deletes exactly half", async () => {
      const { sync, first, raw, del } = await withFour();
      const all = await sync.sync(
        { id: first, entry: HOOK },
        { deletes: [del("a"), del("b"), del("c"), del("d")] },
      );
      expect(all.deletes.every(({ status }) => status === "awaiting_owner")).toBe(true);
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries WHERE state = 'active'").get(),
      ).toEqual({ n: 4 });
    });

    it("deletes only the project that was reported", async () => {
      const { sync, first, raw, tags } = await withFour();
      await sync.sync(
        { id: first, entry: HOOK },
        {
          entries: [
            owner("a", "关于主人的内容 a", { project: "Q" }),
            owner("x1", "补一条 x1", { project: "Q" }),
            owner("x2", "补一条 x2", { project: "Q" }),
          ],
        },
      );
      const result = await sync.sync(
        { id: first, entry: HOOK },
        { deletes: [{ id: "a", project: "P", versionTag: tags.get("a") }] },
      );
      expect(result.deletes[0]?.status).toBe("deleted");
      expect(
        raw
          .prepare(
            "SELECT COUNT(*) AS n FROM mcp_sync_entries WHERE stable_id = 'a' AND state = 'active'",
          )
          .get(),
      ).toEqual({ n: 1 });
    });
  });

  it("keeps one connection's entries invisible to another", async () => {
    const { sync, first, second, raw } = await setup();
    await sync.sync({ id: first, entry: OAUTH }, { entries: [owner("same", "甲的内容")] });
    const other = await sync.sync(
      { id: second, entry: OAUTH },
      { entries: [owner("same", "乙的内容")] },
    );
    expect(other.entries[0]).toMatchObject({ status: "pending" });
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM mcp_sync_entries WHERE stable_id = 'same'").get(),
    ).toEqual({ n: 2 });
    raw.exec(
      `UPDATE mcp_sync_entries SET state = 'owner_deleted'
       WHERE connection_id = 'conn-first' AND stable_id = 'same'`,
    );
    const again = await sync.sync(
      { id: second, entry: OAUTH },
      { entries: [owner("same", "乙的内容")] },
    );
    expect(again.entries[0]?.status).toBe("unchanged");
    const gone = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [owner("same", "甲的内容")] },
    );
    expect(gone.entries[0]?.status).toBe("owner_deleted");
  });

  it("tells the connection when the owner deleted a confirmed memory and does not take it back", async () => {
    const { sync, first, raw } = await setup();
    await sync.sync({ id: first, entry: OAUTH }, { entries: [owner("m", "要被删掉的")] });
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(
      `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref, classification,
        inference, confidence_permille, policy_version, updated_at)
       SELECT 'memory:trashed', owner_id, agent_id, 1, 'trashed', content_ref, 'private', 0, 1000, 'p',
        '${NOW}' FROM mcp_sync_entries LIMIT 1`,
    );
    raw.exec(
      `UPDATE external_memory_proposals SET status = 'committed', decided_at = '${NOW}',
         memory_id = 'memory:trashed'`,
    );
    raw.exec("PRAGMA foreign_keys = ON");
    const result = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [owner("m", "要被删掉的")] },
    );
    expect(result.entries[0]?.status).toBe("owner_deleted");
    const payloadsBeforeChange = raw.prepare("SELECT COUNT(*) AS n FROM payloads").get();
    const changed = await sync.sync(
      { id: first, entry: OAUTH },
      { entries: [owner("m", "改过的内容")] },
    );
    expect(changed.entries[0]?.status).toBe("owner_deleted");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM payloads").get()).toEqual(payloadsBeforeChange);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM external_memory_proposals").get()).toEqual({
      n: 1,
    });
  });

  it("counts every kind of result", async () => {
    const { sync, first } = await setup();
    const result = await sync.sync(
      { id: first, entry: OAUTH },
      {
        entries: [owner("a", "内容一"), owner("b", "内容二", { category: "nope" })],
        deletes: [{ id: "q", versionTag: sha("q") }],
      },
    );
    expect(result.counts).toEqual({
      entries_pending: 1,
      entries_invalid: 1,
      deletes_not_accepted: 1,
    });
  });
  describe("owner decisions", () => {
    const stateOf = (raw: {
      prepare: (sql: string) => { pluck: () => { all: () => unknown[] } };
    }) => raw.prepare("SELECT state FROM mcp_sync_entries ORDER BY stable_id").pluck().all();

    async function pendingNotes() {
      const harness = await setup();
      await harness.sync.sync(
        { id: harness.first, entry: OAUTH },
        {
          entries: [note("n1", "项目甲的第一条笔记", "甲"), note("n2", "项目甲的第二条笔记", "甲")],
        },
      );
      const store = harness.repository.mcpMemorySync();
      const overview = await store.overview({ ...scope, limit: 50 });
      return { ...harness, store, overview };
    }

    it("lists notes waiting for the project approval, grouped with their connection and project", async () => {
      const { overview, first } = await pendingNotes();
      expect(overview.entriesTotal).toBe(2);
      expect(overview.entries.map((entry) => entry.state)).toEqual([
        "awaiting_project_approval",
        "awaiting_project_approval",
      ]);
      expect(overview.entries[0]).toMatchObject({
        connectionId: first,
        connectionName: `接入-${first}`,
        projectName: "甲",
        kind: "project_note",
        previousContentRef: null,
        sourceDeleted: false,
      });
      expect(overview.projects).toEqual([
        {
          connectionId: first,
          connectionName: `接入-${first}`,
          projectId: overview.entries[0]?.projectId,
          projectName: "甲",
          approval: "pending",
        },
      ]);
    });

    it("approving a project activates its notes and later pushes land active", async () => {
      const { store, overview, first, sync, raw } = await pendingNotes();
      const projectId = overview.entries[0]?.projectId as string;
      expect(
        await store.decideProject({
          ...scope,
          connectionId: first,
          projectId,
          decision: "approve",
          now: NOW,
        }),
      ).toEqual({ found: true, changed: 2 });
      expect(stateOf(raw)).toEqual(["active", "active"]);
      await sync.sync({ id: first, entry: OAUTH }, { entries: [note("n3", "第三条", "甲")] });
      expect(stateOf(raw)).toEqual(["active", "active", "active"]);
      expect((await store.overview({ ...scope, limit: 50 })).entriesTotal).toBe(0);
    });

    it("declining refuses the notes, keeps them listed and lets the owner restore one", async () => {
      const { store, overview, first, raw } = await pendingNotes();
      const projectId = overview.entries[0]?.projectId as string;
      await store.decideProject({
        ...scope,
        connectionId: first,
        projectId,
        decision: "decline",
        now: NOW,
      });
      const refused = await store.overview({ ...scope, limit: 50 });
      expect(refused.entries.map((entry) => entry.state)).toEqual(["refused", "refused"]);
      const entryId = refused.entries[0]?.entryId as string;
      expect(await store.decideNote({ ...scope, entryId, decision: "restore", now: NOW })).toEqual({
        found: true,
        state: "awaiting_project_approval",
      });
      await store.decideProject({
        ...scope,
        connectionId: first,
        projectId,
        decision: "approve",
        now: NOW,
      });
      expect(stateOf(raw)).toEqual(["active", "active"]);
    });

    it("keeps the connection name on an approved project that has nothing waiting", async () => {
      const { store, overview, first } = await pendingNotes();
      const projectId = overview.entries[0]?.projectId as string;
      await store.decideProject({
        ...scope,
        connectionId: first,
        projectId,
        decision: "approve",
        now: NOW,
      });
      const after = await store.overview({ ...scope, limit: 50 });
      expect(after.entries).toEqual([]);
      expect(after.projects).toEqual([
        expect.objectContaining({
          connectionId: first,
          connectionName: `接入-${first}`,
          approval: "approved",
        }),
      ]);
    });

    it("declining also refuses a sensitive note already waiting for confirmation, and later ones", async () => {
      const harness = await setup();
      await harness.sync.sync(
        { id: harness.first, entry: OAUTH },
        { entries: [note("s1", "体检结果记录", "甲", { category: "health" })] },
      );
      const store = harness.repository.mcpMemorySync();
      const before = await store.overview({ ...scope, limit: 50 });
      const projectId = before.entries[0]?.projectId as string;
      await store.decideProject({
        ...scope,
        connectionId: harness.first,
        projectId,
        decision: "approve",
        now: NOW,
      });
      expect(stateOf(harness.raw)).toEqual(["awaiting_confirmation"]);
      await store.decideProject({
        ...scope,
        connectionId: harness.first,
        projectId,
        decision: "decline",
        now: NOW,
      });
      expect(stateOf(harness.raw)).toEqual(["refused"]);
      const entryId = (await store.overview({ ...scope, limit: 50 })).entries[0]?.entryId as string;
      expect(await store.decideNote({ ...scope, entryId, decision: "confirm", now: NOW })).toEqual({
        found: true,
        state: "refused",
      });
      await harness.sync.sync(
        { id: harness.first, entry: OAUTH },
        { entries: [note("s2", "另一份体检记录", "甲", { category: "health" })] },
      );
      expect(stateOf(harness.raw)).toEqual(["refused", "refused"]);
    });

    it("answers not found for a project or note that is not there or belongs to nothing", async () => {
      const { store, first } = await pendingNotes();
      expect(
        await store.decideProject({
          ...scope,
          connectionId: first,
          projectId: "proj-nope",
          decision: "approve",
          now: NOW,
        }),
      ).toEqual({ found: false, changed: 0 });
      expect(
        await store.decideNote({ ...scope, entryId: "entry-nope", decision: "refuse", now: NOW }),
      ).toEqual({
        found: false,
        state: null,
      });
      expect(
        await store.resolveAttention({
          ...scope,
          attentionId: "attn-nope",
          decision: "keep",
          now: NOW,
        }),
      ).toEqual({
        found: false,
        released: 0,
      });
    });

    it("lists a brake hold and either releases the held deletions or keeps the entries", async () => {
      for (const decision of ["release", "keep"] as const) {
        const harness = await setup();
        const pushed = await harness.sync.sync(
          { id: harness.first, entry: HOOK },
          {
            entries: ["a", "b", "c", "d"].map((id) =>
              owner(id, `关于主人的内容 ${id}`, { project: "P" }),
            ),
          },
        );
        const tags = pushed.entries.map((entry) => entry.versionTag as string);
        const held = await harness.sync.sync(
          { id: harness.first, entry: HOOK },
          {
            deletes: ["a", "b", "c"].map((id, index) => ({
              id,
              project: "P",
              versionTag: tags[index] as string,
            })),
          },
        );
        expect(held.deletes.map(({ status }) => status)).toEqual([
          "awaiting_owner",
          "awaiting_owner",
          "awaiting_owner",
        ]);
        const store = harness.repository.mcpMemorySync();
        const { attention } = await store.overview({ ...scope, limit: 50 });
        expect(attention).toHaveLength(1);
        expect(attention[0]).toMatchObject({ heldEntries: 3, baseline: 4, projectName: "P" });
        const result = await store.resolveAttention({
          ...scope,
          attentionId: attention[0]?.attentionId as string,
          decision,
          now: NOW,
        });
        expect(result).toEqual({ found: true, released: decision === "release" ? 3 : 0 });
        expect((await store.overview({ ...scope, limit: 50 })).attention).toEqual([]);
        expect(
          harness.raw
            .prepare(
              "SELECT COUNT(*) FROM mcp_sync_entries WHERE state = 'deleted' OR source_deleted_at IS NOT NULL",
            )
            .pluck()
            .get(),
        ).toBe(decision === "release" ? 3 : 0);
        expect(
          await store.resolveAttention({
            ...scope,
            attentionId: attention[0]?.attentionId as string,
            decision,
            now: NOW,
          }),
        ).toEqual({ found: false, released: 0 });
      }
    });
  });
});
