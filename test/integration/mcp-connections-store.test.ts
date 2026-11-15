import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MCP_CONNECTION_MAXIMUM } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpConnectionSecretDigest,
  newMcpConnectionId,
  newMcpConnectionSecret,
} from "../../apps/agent-service/src/production-mcp-connections.ts";

const OWNER_ID = createOwnerId("owner-mcp-connections");
const AGENT_ID = createAgentId("agent-mcp-connections");
const OTHER_AGENT_ID = createAgentId("agent-mcp-connections-other");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-13T03:00:00.000Z";
const LATER = "2026-11-13T04:00:00.000Z";

describe("[P5-B] MCP connection store through the SQLite worker", () => {
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-mcp-connections-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    for (const agentId of [AGENT_ID, OTHER_AGENT_ID])
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run(agentId, OWNER_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => NOW,
    });
    closers.push(() => repository.close());
    const store = repository.mcpConnections();
    const create = async (
      input: {
        readonly id?: string;
        readonly agentId?: typeof AGENT_ID;
        readonly name?: string;
      } = {},
    ) => {
      const secret = newMcpConnectionSecret();
      const record = await store.create({
        ownerId: OWNER_ID,
        agentId: input.agentId ?? AGENT_ID,
        id: input.id ?? newMcpConnectionId(),
        name: input.name ?? "Claude Code",
        secretSha256: mcpConnectionSecretDigest(secret),
        capabilities: ["scheduled_tasks", "mcp"],
        readCeiling: "private",
        pushPolicy: "ask",
        createdAt: NOW,
      });
      return { record, secret };
    };
    return { store, create };
  }

  it("creates a connection with the default settings and finds it only by its own key", async () => {
    const { store, create } = await setup();
    const { record, secret } = await create({ id: "conn-a" });
    expect(record).toMatchObject({
      id: "conn-a",
      name: "Claude Code",
      capabilities: ["mcp", "scheduled_tasks"],
      readCeiling: "private",
      pushPolicy: "ask",
      status: "active",
      reportedClient: null,
      lastSeenAt: null,
      secretRotatedAt: null,
    });
    expect(record).not.toHaveProperty("secretSha256");
    expect(
      await store.findBySecret({ ...scope, secretSha256: mcpConnectionSecretDigest(secret) }),
    ).toMatchObject({ id: "conn-a" });
    expect(
      await store.findBySecret({
        ...scope,
        secretSha256: mcpConnectionSecretDigest(newMcpConnectionSecret()),
      }),
    ).toBeNull();
    expect(
      await store.findBySecret({
        ownerId: OWNER_ID,
        agentId: OTHER_AGENT_ID,
        secretSha256: mcpConnectionSecretDigest(secret),
      }),
    ).toBeNull();
    expect(await store.list({ ownerId: OWNER_ID, agentId: OTHER_AGENT_ID })).toEqual([]);
  });

  it("refuses ids that do not start with a letter or digit, names that are too long or hide characters, and unknown settings", async () => {
    const { store } = await setup();
    const base = {
      ...scope,
      name: "x",
      secretSha256: mcpConnectionSecretDigest(newMcpConnectionSecret()),
      capabilities: ["mcp"] as const,
      readCeiling: "private" as const,
      pushPolicy: "ask" as const,
      createdAt: NOW,
    };
    for (const input of [
      { ...base, id: "-conn" },
      { ...base, id: "c".repeat(129) },
      { ...base, id: "conn a" },
      { ...base, id: "conn-ok", name: "" },
      { ...base, id: "conn-ok", name: "n".repeat(65) },
      { ...base, id: "conn-ok", name: "Claude\u200bCode" },
      { ...base, id: "conn-ok", name: "Claude\u202eCode" },
      { ...base, id: "conn-ok", name: "Claude\u{E0001}Code" },
      { ...base, id: "conn-ok", name: "\u{1F600}".repeat(65) },
      { ...base, id: "conn-ok", readCeiling: "restricted" },
      { ...base, id: "conn-ok", capabilities: ["mcp", "mcp"] },
      { ...base, id: "conn-ok", secretSha256: "not-a-digest" },
    ])
      await expect(store.create(input as never)).rejects.toMatchObject({
        code: "PORT_INVALID_OPERATION",
      });
    expect(await store.list(scope)).toEqual([]);
    await store.create({ ...base, id: "conn-64", name: "\u{1F600}".repeat(64) });
    expect((await store.list(scope)).map(({ name }) => [...name].length)).toEqual([64]);
    expect(newMcpConnectionId()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  });

  it(`stops at ${MCP_CONNECTION_MAXIMUM} connections per agent, not counting revoked ones`, async () => {
    const { store, create } = await setup();
    for (let index = 0; index < MCP_CONNECTION_MAXIMUM; index += 1)
      await create({ id: `conn-${index}` });
    await expect(create({ id: "conn-one-too-many" })).rejects.toMatchObject({
      code: "PORT_CONFLICT",
    });
    expect(await store.list(scope)).toHaveLength(MCP_CONNECTION_MAXIMUM);
    await create({ id: "conn-other-agent", agentId: OTHER_AGENT_ID });
    await store.change({ ...scope, id: "conn-0", status: "paused", updatedAt: LATER });
    await expect(create({ id: "conn-paused-still-counts" })).rejects.toMatchObject({
      code: "PORT_CONFLICT",
    });
    await store.change({ ...scope, id: "conn-0", status: "revoked", updatedAt: LATER });
    await create({ id: "conn-after-revoke" });
    await expect(create({ id: "conn-full-again" })).rejects.toMatchObject({
      code: "PORT_CONFLICT",
    });
    expect(await store.list(scope)).toHaveLength(MCP_CONNECTION_MAXIMUM + 1);
  });

  it("renames, pauses and rotates, and refuses any change once revoked", async () => {
    const { store, create } = await setup();
    const { secret } = await create({ id: "conn-a" });
    expect(
      await store.change({
        ...scope,
        id: "conn-a",
        updatedAt: LATER,
        name: "Codex",
        status: "paused",
      }),
    ).toMatchObject({ name: "Codex", status: "paused", updatedAt: LATER });
    const rotated = newMcpConnectionSecret();
    expect(
      await store.rotateSecret({
        ...scope,
        id: "conn-a",
        secretSha256: mcpConnectionSecretDigest(rotated),
        rotatedAt: LATER,
      }),
    ).toMatchObject({ id: "conn-a", secretRotatedAt: LATER, name: "Codex" });
    expect(
      await store.findBySecret({ ...scope, secretSha256: mcpConnectionSecretDigest(secret) }),
    ).toBeNull();
    await store.change({ ...scope, id: "conn-a", updatedAt: LATER, status: "revoked" });
    await expect(
      store.change({ ...scope, id: "conn-a", updatedAt: LATER, status: "active" }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    await expect(
      store.rotateSecret({
        ...scope,
        id: "conn-a",
        secretSha256: mcpConnectionSecretDigest(newMcpConnectionSecret()),
        rotatedAt: LATER,
      }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    expect(await store.change({ ...scope, id: "conn-missing", updatedAt: LATER })).toBeNull();
  });

  it("keeps the latest seen time and the last reported name", async () => {
    const { store, create } = await setup();
    await create({ id: "conn-a" });
    await store.touch({ ...scope, id: "conn-a", seenAt: LATER, reportedClient: "claude-code" });
    await store.touch({ ...scope, id: "conn-a", seenAt: NOW, reportedClient: null });
    expect(await store.read({ ...scope, id: "conn-a" })).toMatchObject({
      lastSeenAt: LATER,
      reportedClient: "claude-code",
    });
  });

  it("only adds to the daily counts and reads them back in a fixed order within the day range", async () => {
    const { store, create } = await setup();
    await create({ id: "conn-a" });
    await create({ id: "conn-b" });
    const add = (connectionId: string, day: string, counts: Record<string, number>, auto = false) =>
      store.addUsage({
        ...scope,
        connectionId,
        day,
        tool: "find_memories",
        entry: "oauth",
        auto,
        counts,
      });
    await add("conn-b", "2026-11-13", { calls: 1, delivered: 1 });
    await add("conn-a", "2026-11-13", { calls: 1, empty: 1 }, true);
    await add("conn-a", "2026-11-13", { calls: 2, empty: 1 }, true);
    await add("conn-a", "2026-11-12", { calls: 5 });
    await add("conn-a", "2026-11-14", { calls: 7 });
    await expect(add("conn-a", "2026-11-13", { calls: 0 })).rejects.toMatchObject({
      code: "PORT_INVALID_OPERATION",
    });
    await expect(add("conn-a", "2026-11-13", { unknown: 1 })).rejects.toMatchObject({
      code: "PORT_INVALID_OPERATION",
    });
    const rows = await store.usage({ ...scope, fromDay: "2026-11-12", toDay: "2026-11-13" });
    expect(
      rows.map(({ connectionId, day, auto, counter, value }) => [
        connectionId,
        day,
        auto,
        counter,
        value,
      ]),
    ).toEqual([
      ["conn-a", "2026-11-12", false, "calls", 5],
      ["conn-a", "2026-11-13", true, "calls", 3],
      ["conn-a", "2026-11-13", true, "empty", 2],
      ["conn-b", "2026-11-13", false, "calls", 1],
      ["conn-b", "2026-11-13", false, "delivered", 1],
    ]);
    expect(
      await store.usage({
        ownerId: OWNER_ID,
        agentId: OTHER_AGENT_ID,
        fromDay: "2026-11-01",
        toDay: "2026-11-30",
      }),
    ).toEqual([]);
  });
});
