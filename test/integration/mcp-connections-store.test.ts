import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MCP_CONNECTION_MAXIMUM,
  MCP_OAUTH_UNBOUND_CLIENT_MAXIMUM,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { newMcpConnectionId } from "../../apps/agent-service/src/production-mcp-connections.ts";

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
    const oauth = repository.mcpOAuth();
    const create = async (
      input: {
        readonly id?: string;
        readonly agentId?: typeof AGENT_ID;
        readonly name?: string;
      } = {},
    ) => {
      const id = input.id ?? newMcpConnectionId();
      const record = await oauth.bindGrant({
        ownerId: OWNER_ID,
        agentId: input.agentId ?? AGENT_ID,
        clientId: `client-${id}`,
        registration: "dynamic",
        clientName: input.name ?? "Claude Code",
        redirectUris: ["http://127.0.0.1/callback"],
        newConnection: {
          id,
          name: input.name ?? "Claude Code",
          readCeiling: "private",
          pushPolicy: "ask",
        },
        now: NOW,
      });
      return { record };
    };
    return { store, oauth, create };
  }

  it("binds a client to a new connection with the chosen settings, and only within its own agent", async () => {
    const { store, create } = await setup();
    const { record } = await create({ id: "conn-a" });
    expect(record).toMatchObject({
      id: "conn-a",
      name: "Claude Code",
      capabilities: ["mcp"],
      readCeiling: "private",
      pushPolicy: "ask",
      status: "active",
      reportedClient: null,
      lastSeenAt: null,
      oauthClientId: "client-conn-a",
    });
    expect(record).not.toHaveProperty("secretSha256");
    expect(await store.read({ ...scope, id: "conn-a" })).toMatchObject({
      oauthClientId: "client-conn-a",
    });
    expect(await store.list({ ownerId: OWNER_ID, agentId: OTHER_AGENT_ID })).toEqual([]);
  });

  it("refuses ids that do not start with a letter or digit, names that are too long or hide characters, and unknown settings", async () => {
    const { store, oauth } = await setup();
    const bind = (id: string, connection: Record<string, unknown> = {}) =>
      oauth.bindGrant({
        ...scope,
        clientId: `client-${id.length}-${Object.keys(connection).join("")}`,
        registration: "dynamic",
        clientName: "x",
        redirectUris: ["http://127.0.0.1/callback"],
        newConnection: {
          id,
          name: "x",
          readCeiling: "private",
          pushPolicy: "ask",
          ...connection,
        } as never,
        now: NOW,
      });
    for (const [id, connection] of [
      ["-conn", {}],
      ["c".repeat(129), {}],
      ["conn a", {}],
      ["conn-ok", { name: "" }],
      ["conn-ok", { name: "n".repeat(65) }],
      ["conn-ok", { name: "Claude\u200bCode" }],
      ["conn-ok", { name: "Claude\u202eCode" }],
      ["conn-ok", { name: "Claude\u{E0001}Code" }],
      ["conn-ok", { name: "\u{1F600}".repeat(65) }],
      ["conn-ok", { readCeiling: "restricted" }],
      ["conn-ok", { pushPolicy: "sometimes" }],
    ] as const)
      await expect(bind(id, connection)).rejects.toMatchObject({
        code: "PORT_INVALID_OPERATION",
      });
    expect(await store.list(scope)).toEqual([]);
    await bind("conn-64", { name: "\u{1F600}".repeat(64) });
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

  it("renames and pauses, and refuses any change once revoked", async () => {
    const { store, create } = await setup();
    await create({ id: "conn-a" });
    expect(
      await store.change({
        ...scope,
        id: "conn-a",
        updatedAt: LATER,
        name: "Codex",
        status: "paused",
      }),
    ).toMatchObject({ name: "Codex", status: "paused", updatedAt: LATER });
    await store.change({ ...scope, id: "conn-a", updatedAt: LATER, status: "revoked" });
    await expect(
      store.change({ ...scope, id: "conn-a", updatedAt: LATER, status: "active" }),
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

  describe("OAuth clients and tokens", () => {
    const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
    const RESOURCE = "https://agent.example.test/api/mcp/v1";
    const pair = (connectionId: string, clientId: string, seed: string, familyId: string) => ({
      ...scope,
      connectionId,
      clientId,
      familyId,
      scopes: ["himawari:read"],
      resource: RESOURCE,
      access: { tokenSha256: digest(`${seed}-access`), expiresAt: LATER },
      refresh: { tokenSha256: digest(`${seed}-refresh`), expiresAt: "2026-12-13T03:00:00.000Z" },
      now: NOW,
    });

    it("keeps registered clients unbound until a grant, then reuses the same connection", async () => {
      const { store, oauth, create } = await setup();
      const registered = await oauth.registerClient({
        ...scope,
        clientId: "client-dyn",
        clientName: "Muse",
        redirectUris: ["https://muse.example/callback"],
        createdAt: NOW,
      });
      expect(registered).toMatchObject({ registration: "dynamic", connectionId: null });
      expect(await store.list(scope)).toEqual([]);
      const first = await oauth.bindGrant({
        ...scope,
        clientId: "client-dyn",
        registration: "dynamic",
        clientName: "Muse",
        redirectUris: ["https://muse.example/callback"],
        newConnection: { id: "conn-muse", name: "Muse", readCeiling: "private", pushPolicy: "ask" },
        now: NOW,
      });
      const again = await oauth.bindGrant({
        ...scope,
        clientId: "client-dyn",
        registration: "dynamic",
        clientName: "Muse 2",
        redirectUris: ["https://muse.example/callback2"],
        newConnection: {
          id: "conn-other",
          name: "Other",
          readCeiling: "public",
          pushPolicy: "ask",
        },
        now: LATER,
      });
      expect(again.id).toBe(first.id);
      expect(await oauth.readClient({ ...scope, clientId: "client-dyn" })).toMatchObject({
        clientName: "Muse 2",
        redirectUris: ["https://muse.example/callback2"],
        connectionId: "conn-muse",
      });
      await expect(
        oauth.bindGrant({
          ...scope,
          clientId: "client-dyn",
          registration: "metadata_document",
          clientName: "Muse",
          redirectUris: ["https://muse.example/callback"],
          newConnection: { id: "conn-x", name: "x", readCeiling: "private", pushPolicy: "ask" },
          now: LATER,
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await create({ id: "conn-b" });
      expect((await store.list(scope)).map(({ id }) => id).sort()).toEqual(["conn-b", "conn-muse"]);
    });

    it("finds access only for live tokens of a live connection still bound to the same client", async () => {
      const { store, oauth, create } = await setup();
      await create({ id: "conn-a" });
      await oauth.issueTokens(pair("conn-a", "client-conn-a", "one", "family-one-aaaaaaaa"));
      const find = (seed: string, now = NOW) =>
        oauth.findAccess({ ...scope, tokenSha256: digest(seed), now });
      expect(await find("one-access")).toMatchObject({
        token: { kind: "access", scopes: ["himawari:read"], resource: RESOURCE },
        connection: { id: "conn-a" },
      });
      expect(await find("one-refresh")).toBeNull();
      expect(await find("one-access", LATER)).toBeNull();
      expect(
        await oauth.findAccess({
          ownerId: OWNER_ID,
          agentId: OTHER_AGENT_ID,
          tokenSha256: digest("one-access"),
          now: NOW,
        }),
      ).toBeNull();
      await store.change({ ...scope, id: "conn-a", status: "revoked", updatedAt: NOW });
      expect(await find("one-access")).toBeNull();
      await expect(
        oauth.issueTokens(pair("conn-a", "client-conn-a", "two", "family-two-aaaaaaaa")),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      const rebound = await create({ id: "conn-a2" });
      expect(rebound.record.oauthClientId).toBe("client-conn-a2");
    });

    it("rotates a refresh token once, and a second use revokes the whole family", async () => {
      const { oauth, create } = await setup();
      await create({ id: "conn-a" });
      await oauth.issueTokens(pair("conn-a", "client-conn-a", "one", "family-one-aaaaaaaa"));
      const next = (seed: string) => ({
        access: { tokenSha256: digest(`${seed}-access`), expiresAt: LATER },
        refresh: { tokenSha256: digest(`${seed}-refresh`), expiresAt: "2026-12-13T03:00:00.000Z" },
      });
      const rotate = (seed: string, nextSeed: string, clientId = "client-conn-a") =>
        oauth.rotateRefresh({
          ...scope,
          refreshSha256: digest(`${seed}-refresh`),
          clientId,
          next: next(nextSeed),
          now: NOW,
        });
      expect(await rotate("one", "x", "client-other")).toEqual({ status: "not_found" });
      expect(await rotate("one", "two")).toMatchObject({ status: "rotated" });
      const find = (seed: string) =>
        oauth.findAccess({ ...scope, tokenSha256: digest(seed), now: NOW });
      expect(await find("one-access")).toBeNull();
      expect(await find("two-access")).not.toBeNull();
      expect(await rotate("one", "three")).toEqual({ status: "reused" });
      expect(await find("two-access")).toBeNull();
      expect(await rotate("two", "four")).toEqual({ status: "not_found" });
    });

    it("revokes an access token alone and a refresh token with its family, then prunes expired rows", async () => {
      const { oauth, create } = await setup();
      await create({ id: "conn-a" });
      await oauth.issueTokens(pair("conn-a", "client-conn-a", "one", "family-one-aaaaaaaa"));
      await oauth.issueTokens(pair("conn-a", "client-conn-a", "two", "family-two-aaaaaaaa"));
      const find = (seed: string) =>
        oauth.findAccess({ ...scope, tokenSha256: digest(seed), now: NOW });
      await oauth.revokeToken({
        ...scope,
        tokenSha256: digest("one-access"),
        clientId: "client-other",
        now: NOW,
      });
      expect(await find("one-access")).not.toBeNull();
      await oauth.revokeToken({
        ...scope,
        tokenSha256: digest("one-access"),
        clientId: "client-conn-a",
        now: NOW,
      });
      expect(await find("one-access")).toBeNull();
      await oauth.revokeToken({
        ...scope,
        tokenSha256: digest("two-refresh"),
        clientId: "client-conn-a",
        now: NOW,
      });
      expect(await find("two-access")).toBeNull();
      expect(await oauth.pruneExpired({ ...scope, now: LATER })).toBe(2);
    });

    it("forgets unused dynamic registrations after a day and caps how many wait unbound", async () => {
      const { oauth } = await setup();
      const register = (index: number, createdAt = NOW) =>
        oauth.registerClient({
          ...scope,
          clientId: `client-${index}`,
          clientName: "Spam",
          redirectUris: ["https://spam.example/callback"],
          createdAt,
        });
      for (let index = 0; index < MCP_OAUTH_UNBOUND_CLIENT_MAXIMUM; index += 1)
        await register(index);
      await expect(register(-1)).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      await register(-2, "2026-11-14T03:00:01.000Z");
      expect(await oauth.readClient({ ...scope, clientId: "client-0" })).toBeNull();
      await expect(
        oauth.registerClient({
          ...scope,
          clientId: "client bad",
          clientName: "Bad",
          redirectUris: ["https://spam.example/callback"],
          createdAt: NOW,
        }),
      ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    });
  });
});
