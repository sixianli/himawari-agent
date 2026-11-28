import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProactiveSeal } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  APP_CONNECTIONS_CALLBACK_PATH,
  APP_CONNECTIONS_CLIENT_METADATA_PATH,
  isAllowedAppServerUrl,
  ProductionAppConnections,
} from "@himawari-agent/platform-node";
import {
  DeterministicIdGenerator,
  DeterministicPayloadProtector,
  ManualClock,
} from "@himawari-agent/testing";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerAppConnectionRoutes } from "../../apps/agent-service/src/production-http-composition.ts";
import { type LoopbackRegistration, loopbackMcpApp } from "../fixtures/loopback-mcp-app.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-added-apps");
const AGENT_ID = createAgentId("agent-added-apps");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const ORIGIN = "https://himawari.example";
const CALLBACK = `${ORIGIN}${APP_CONNECTIONS_CALLBACK_PATH}`;
const METADATA_URL = `${ORIGIN}${APP_CONNECTIONS_CLIENT_METADATA_PATH}`;
const SCHEME = "win.example.himawari";
const NOW = "2026-11-27T02:00:00.000Z";

describe("[CONN-ADD-2] the owner adds any remote MCP app by its address", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(
    app: {
      readonly registration?: LoopbackRegistration;
      readonly signIn?: boolean;
      readonly title?: string;
    } = {},
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-added-apps-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = new ManualClock(NOW);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    closers.push(() => repository.close());
    const server = loopbackMcpApp({ id: "typed-client", secret: "typed-pass" }, app);
    await server.start();
    closers.push(() => server.stop());
    const store = repository.appConnections();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const connections = new ProductionAppConnections({
      scope,
      store,
      seal: createProactiveSeal({
        payloads,
        protector: new DeterministicPayloadProtector(),
        ids: new DeterministicIdGenerator(),
      }),
      definitions: [],
      publicOrigin: ORIGIN,
      now: () => clock.now(),
      serverUrlAllowed: (url) => url.hostname === "127.0.0.1",
    });
    const signIn = async (name: string) => {
      const started = await connections.begin({
        deviceId: "device-a",
        connection: name,
        callbackScheme: SCHEME,
      });
      if (started?.kind !== "browser") return { started, outcome: undefined };
      const answer = await fetch(started.authorizationUrl, { redirect: "manual" });
      const back = new URL(answer.headers.get("location") ?? "");
      expect(back.origin + back.pathname).toBe(CALLBACK);
      const state = back.searchParams.get("state") ?? "";
      connections.callback({
        state,
        code: back.searchParams.get("code"),
        error: back.searchParams.get("error"),
        iss: back.searchParams.get("iss"),
      });
      return { started, outcome: await connections.complete({ deviceId: "device-a", state }) };
    };
    return { server, store, payloads, connections, signIn };
  }

  it("registers itself dynamically once, keeps the registration sealed and reuses it on the next sign-in", async () => {
    const h = await setup({ registration: "dynamic" });
    const added = await h.connections.add({ serverUrl: `${h.server.origin}/mcp` });
    expect(added.outcome).toBe("added");
    const name = added.outcome === "added" ? added.connection.name : "";
    expect(name).toMatch(/^app_[0-9a-f]{12}$/u);
    expect(added).toMatchObject({
      connection: { title: "127.0.0.1", status: "disconnected", added: true },
    });

    expect((await h.signIn(name)).outcome).toBe("connected");
    expect(h.server.registrations).toHaveLength(1);
    expect(h.server.registrations[0]).toMatchObject({
      client_name: "Himawari",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
    });
    const client = await h.store.readClient({ ...scope, name });
    const sealed = await h.payloads.get(client?.clientRef ?? "");
    expect(sealed).toBeDefined();
    expect(JSON.stringify(client)).not.toContain("dyn-");

    await h.connections.disconnect(name);
    expect((await h.signIn(name)).outcome).toBe("connected");
    expect(h.server.registrations).toHaveLength(1);
    expect(new Set(h.server.authorizedClients).size).toBe(1);

    const tools = await h.connections.tools(name);
    expect(tools?.map(({ name: tool }) => tool)).toEqual(["create_issue", "get_me"]);
    expect((await h.connections.definition(name))?.trustsReadOnlyLabels).toBe(false);
  });

  it("uses its client ID metadata document when the sign-in server accepts one, without registering", async () => {
    const h = await setup({ registration: "metadata_document" });
    const added = await h.connections.add({ serverUrl: `${h.server.origin}/mcp`, title: "Linear" });
    const name = added.outcome === "added" ? added.connection.name : "";
    expect((await h.signIn(name)).outcome).toBe("connected");
    expect(h.server.registrations).toEqual([]);
    expect(h.server.authorizedClients).toEqual([METADATA_URL]);
    expect(h.connections.clientMetadataDocument()).toEqual({
      client_id: METADATA_URL,
      client_name: "Himawari",
      client_uri: `${ORIGIN}/`,
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect((await h.connections.list()).map(({ title }) => title)).toEqual(["Linear"]);

    const app = Fastify();
    registerAppConnectionRoutes(app, h.connections);
    const served = await app.inject({ method: "GET", url: APP_CONNECTIONS_CLIENT_METADATA_PATH });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("application/json");
    expect(served.json()).toEqual(h.connections.clientMetadataDocument());
    await app.close();
  });

  it("uses the client ID the owner typed, and connects a server that needs no sign-in with its own name", async () => {
    const typed = await setup({ registration: "none" });
    const added = await typed.connections.add({
      serverUrl: `${typed.server.origin}/mcp`,
      clientId: "typed-client",
      clientSecret: "typed-pass",
    });
    const name = added.outcome === "added" ? added.connection.name : "";
    expect((await typed.signIn(name)).outcome).toBe("connected");
    expect(typed.server.authorizedClients).toEqual(["typed-client"]);

    const open = await setup({ signIn: false, title: "Open Docs" });
    const opened = await open.connections.add({ serverUrl: `${open.server.origin}/mcp` });
    expect(opened).toMatchObject({
      outcome: "added",
      connection: { title: "Open Docs", status: "connected", added: true },
    });
    const openName = opened.outcome === "added" ? opened.connection.name : "";
    expect((await open.connections.call(openName, "get_me", {}))?.content).toEqual([
      { type: "text", text: "andy" },
    ]);
  });

  it("removing an added app deletes its tokens and its client identity", async () => {
    const h = await setup({ registration: "dynamic" });
    const added = await h.connections.add({ serverUrl: `${h.server.origin}/mcp` });
    const name = added.outcome === "added" ? added.connection.name : "";
    await h.signIn(name);
    const tokens = await h.store.read({ ...scope, name });
    const client = await h.store.readClient({ ...scope, name });
    expect(await h.connections.remove(name)).toBe(true);
    expect(await h.connections.list()).toEqual([]);
    expect(await h.payloads.get(tokens?.tokensRef ?? "")).toBeUndefined();
    expect(await h.payloads.get(client?.clientRef ?? "")).toBeUndefined();
    expect(await h.connections.open(name)).toBeUndefined();
  });

  it("[reverse] a sign-in server with no way to give Himawari a client asks the owner for one and stores nothing", async () => {
    const h = await setup({ registration: "none" });
    const added = await h.connections.add({ serverUrl: `${h.server.origin}/mcp` });
    const name = added.outcome === "added" ? added.connection.name : "";
    expect((await h.signIn(name)).started).toEqual({
      kind: "client_required",
      redirectUri: CALLBACK,
    });
    expect(await h.store.read({ ...scope, name })).toBeUndefined();
    expect(await h.store.readClient({ ...scope, name })).toBeUndefined();
    expect(h.server.authorizedClients).toEqual([]);
  });

  it("[reverse] a refused, unreachable or non-MCP address is never added, and configured apps cannot be removed", async () => {
    const h = await setup();
    for (const serverUrl of [
      "not a url",
      "http://mcp.example.com/mcp",
      "https://localhost/mcp",
      "https://10.0.0.8/mcp",
    ])
      expect(await h.connections.add({ serverUrl })).toEqual({ outcome: "invalid_address" });
    expect(await h.connections.add({ serverUrl: `${h.server.origin}/missing` })).toEqual({
      outcome: "unreachable",
    });
    expect(await h.connections.list()).toEqual([]);
    expect(await h.connections.remove("github")).toBeUndefined();
    expect(await h.connections.remove("app_000000000000")).toBeUndefined();
  });

  it("[reverse] only public https names pass the production address rule", () => {
    for (const allowed of ["https://mcp.linear.app/mcp", "https://api.githubcopilot.com/mcp/"])
      expect(isAllowedAppServerUrl(new URL(allowed))).toBe(true);
    for (const refused of [
      "http://mcp.linear.app/mcp",
      "https://user:pass@mcp.linear.app/mcp",
      "https://127.0.0.1/mcp",
      "https://[::1]/mcp",
      "https://169.254.169.254/latest",
      "https://localhost/mcp",
      "https://printer.localhost/mcp",
      "https://intranet/mcp",
      "https://mcp.linear.app/mcp#x",
    ])
      expect(isAllowedAppServerUrl(new URL(refused))).toBe(false);
  });
});
