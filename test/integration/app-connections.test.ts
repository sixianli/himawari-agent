import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
  APP_CONNECTION_CALLBACK_HOST,
  APP_CONNECTIONS_CALLBACK_PATH,
  ProductionAppConnections,
} from "@himawari-agent/platform-node";
import {
  DeterministicIdGenerator,
  DeterministicPayloadProtector,
  ManualClock,
} from "@himawari-agent/testing";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-app-connections");
const AGENT_ID = createAgentId("agent-app-connections");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const ORIGIN = "https://himawari.example";
const CALLBACK = `${ORIGIN}${APP_CONNECTIONS_CALLBACK_PATH}`;
const CLIENT_ID = "Iv1.github-app";
const SECRET = "fixture";
const SCHEME = "win.example.himawari";
const NOW = "2026-11-26T08:00:00.000Z";

interface Grant {
  readonly challenge: string;
  readonly redirect: string;
  readonly resource: string;
}

function loopbackApp() {
  const grants = new Map<string, Grant>();
  const access = new Map<string, number>();
  const refresh = new Set<string>();
  const tokenRequests: URLSearchParams[] = [];
  const calls: string[] = [];
  let origin = "";
  const mcp = createMcpHandler(() => {
    const server = new McpServer({ name: "loopback-github", version: "1.0.0" });
    server.registerTool(
      "get_me",
      { description: "Who is signed in", annotations: { readOnlyHint: true } },
      async () => {
        calls.push("get_me");
        return { content: [{ type: "text", text: "andy" }] };
      },
    );
    return server;
  });
  const issue = () => {
    const token = randomBytes(12).toString("hex");
    const renewal = randomBytes(12).toString("hex");
    access.set(token, Date.now() + 3_600_000);
    refresh.add(renewal);
    return { access_token: token, refresh_token: renewal, token_type: "Bearer", expires_in: 3600 };
  };
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === "/authorize") {
      const query = url.searchParams;
      const target = new URL(query.get("redirect_uri") ?? "");
      if (query.get("client_id") !== CLIENT_ID || query.get("code_challenge_method") !== "S256") {
        target.searchParams.set("error", "invalid_request");
      } else if (url.searchParams.get("deny") === "1") {
        target.searchParams.set("error", "access_denied");
      } else {
        const code = randomBytes(12).toString("hex");
        grants.set(code, {
          challenge: query.get("code_challenge") ?? "",
          redirect: query.get("redirect_uri") ?? "",
          resource: query.get("resource") ?? "",
        });
        target.searchParams.set("code", code);
      }
      target.searchParams.set("state", query.get("state") ?? "");
      target.searchParams.set("iss", origin);
      response.writeHead(302, { location: target.href });
      return response.end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await body(request));
      tokenRequests.push(form);
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== SECRET)
        return json(response, 401, { error: "invalid_client" });
      if (form.get("grant_type") === "refresh_token") {
        const renewal = form.get("refresh_token") ?? "";
        if (!refresh.delete(renewal)) return json(response, 400, { error: "invalid_grant" });
        return json(response, 200, issue());
      }
      const grant = grants.get(form.get("code") ?? "");
      grants.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        !grant ||
        grant.challenge !== challenge ||
        grant.redirect !== form.get("redirect_uri") ||
        grant.resource !== `${origin}/mcp` ||
        form.get("resource") !== `${origin}/mcp`
      )
        return json(response, 400, { error: "invalid_grant" });
      return json(response, 200, issue());
    }
    if (url.pathname === "/mcp") {
      const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
      const expires = bearer === undefined ? undefined : access.get(bearer);
      if (expires === undefined || expires <= Date.now()) {
        response.writeHead(401, {
          "www-authenticate": `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        return response.end();
      }
      const text = request.method === "POST" ? await body(request) : undefined;
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (typeof value === "string") headers.set(key, value);
      const answer = await mcp.fetch(
        new Request(url, {
          method: request.method ?? "GET",
          headers,
          ...(text === undefined ? {} : { body: text }),
        }),
        text === undefined ? {} : { parsedBody: JSON.parse(text) },
      );
      response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
      return response.end(Buffer.from(await answer.arrayBuffer()));
    }
    response.writeHead(404);
    response.end();
  });
  return {
    grants,
    access,
    tokenRequests,
    calls,
    get origin() {
      return origin;
    },
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("[CONN-1] an app is connected through its remote MCP server with the owner's sign-in", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-app-connections-"));
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
    const app = loopbackApp();
    await app.start();
    closers.push(() => app.stop());
    const store = repository.appConnections();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const seal = createProactiveSeal({
      payloads,
      protector: new DeterministicPayloadProtector(),
      ids: new DeterministicIdGenerator(),
    });
    const connections = new ProductionAppConnections({
      scope,
      store,
      seal,
      definitions: [
        {
          name: "github",
          title: "GitHub",
          serverUrl: `${app.origin}/mcp`,
          clientId: CLIENT_ID,
          clientSecret: SECRET,
          trustsReadOnlyLabels: true,
        },
      ],
      publicOrigin: ORIGIN,
      now: () => clock.now(),
    });
    const signIn = async (authorizationUrl: string, deny = false) => {
      const page = new URL(authorizationUrl);
      if (deny) page.searchParams.set("deny", "1");
      const answer = await fetch(page, { redirect: "manual" });
      const back = new URL(answer.headers.get("location") ?? "");
      expect(back.origin + back.pathname).toBe(CALLBACK);
      return connections.callback({
        state: back.searchParams.get("state"),
        code: back.searchParams.get("code"),
        error: back.searchParams.get("error"),
        iss: back.searchParams.get("iss"),
      });
    };
    return { app, store, payloads, connections, clock, signIn };
  }

  it("signs in with PKCE and the resource parameter, keeps the tokens sealed, and calls the app's tools", async () => {
    const h = await setup();
    expect(await h.connections.list()).toEqual([
      { name: "github", title: "GitHub", status: "disconnected", account: null, connectedAt: null },
    ]);
    const started = await h.connections.begin({
      deviceId: "device-a",
      connection: "github",
      callbackScheme: SCHEME,
    });
    expect(started?.kind).toBe("browser");
    const page = new URL(started?.authorizationUrl ?? "");
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    expect(page.searchParams.get("resource")).toBe(`${h.app.origin}/mcp`);
    expect(page.searchParams.get("redirect_uri")).toBe(CALLBACK);
    const state = page.searchParams.get("state") ?? "";
    expect(await h.signIn(started?.authorizationUrl ?? "")).toBe(
      `${SCHEME}://${APP_CONNECTION_CALLBACK_HOST}?state=${state}`,
    );
    expect(await h.connections.complete({ deviceId: "device-a", state })).toBe("connected");
    expect(await h.connections.list()).toEqual([
      { name: "github", title: "GitHub", status: "connected", account: null, connectedAt: NOW },
    ]);
    const record = await h.store.read({ ...scope, name: "github" });
    const token = [...h.app.access.keys()][0] ?? "missing";
    expect(JSON.stringify(record)).not.toContain(token);
    expect(await h.payloads.get(record?.tokensRef ?? "")).toBeDefined();

    const client = await h.connections.open("github");
    const tools = await client?.listTools();
    expect(tools?.tools.map(({ name }) => name)).toEqual(["get_me"]);
    expect(await client?.callTool({ name: "get_me", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "andy" }],
    });
    await client?.close();
    expect(h.app.calls).toEqual(["get_me"]);

    h.app.access.clear();
    const renewed = await h.connections.open("github");
    expect((await renewed?.listTools())?.tools.map(({ name }) => name)).toEqual(["get_me"]);
    await renewed?.close();
    expect(h.app.tokenRequests.map((form) => form.get("grant_type"))).toEqual([
      "authorization_code",
      "refresh_token",
    ]);

    expect(await h.connections.disconnect("github")).toBe(true);
    expect(await h.payloads.get(record?.tokensRef ?? "")).toBeUndefined();
    expect((await h.connections.list())[0]?.status).toBe("disconnected");
    expect(await h.connections.open("github")).toBeUndefined();
  });

  it("[reverse] another device, a refusal, a replayed or forged state, an unknown app or an expired sign-in never connects", async () => {
    const h = await setup();
    const begin = async () => {
      const started = await h.connections.begin({
        deviceId: "device-a",
        connection: "github",
        callbackScheme: SCHEME,
      });
      return {
        url: started?.authorizationUrl ?? "",
        state: new URL(started?.authorizationUrl ?? "").searchParams.get("state") ?? "",
      };
    };
    expect(
      await h.connections.begin({
        deviceId: "device-a",
        connection: "dropbox",
        callbackScheme: SCHEME,
      }),
    ).toBeUndefined();

    const stolen = await begin();
    await h.signIn(stolen.url);
    expect(await h.connections.complete({ deviceId: "device-b", state: stolen.state })).toBe(
      "failed",
    );

    const refused = await begin();
    await h.signIn(refused.url, true);
    expect(await h.connections.complete({ deviceId: "device-a", state: refused.state })).toBe(
      "denied",
    );

    const replayed = await begin();
    await h.signIn(replayed.url);
    expect(await h.connections.complete({ deviceId: "device-a", state: replayed.state })).toBe(
      "connected",
    );
    expect(await h.connections.complete({ deviceId: "device-a", state: replayed.state })).toBe(
      "failed",
    );
    await h.connections.disconnect("github");

    expect(
      h.connections.callback({ state: "forged-state-000000", code: "x", error: null, iss: null }),
    ).toBeUndefined();
    expect(
      await h.connections.complete({ deviceId: "device-a", state: "forged-state-000000" }),
    ).toBe("failed");

    const late = await begin();
    await h.signIn(late.url);
    h.clock.advance(11 * 60_000);
    expect(await h.connections.complete({ deviceId: "device-a", state: late.state })).toBe(
      "failed",
    );

    expect((await h.connections.list())[0]?.status).toBe("disconnected");
    expect(h.app.calls).toEqual([]);
  });
});
