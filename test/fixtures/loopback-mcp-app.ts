import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

interface Grant {
  readonly challenge: string;
  readonly redirect: string;
  readonly resource: string;
}

export function loopbackMcpApp(client: { readonly id: string; readonly secret: string }) {
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
    server.registerTool(
      "create_issue",
      {
        description: "Open an issue",
        inputSchema: fromJsonSchema<{ title: string }>({
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        }),
        annotations: { readOnlyHint: false },
      },
      async ({ title }) => {
        calls.push(`create_issue:${title}`);
        return { content: [{ type: "text", text: "issue #7" }] };
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
      if (query.get("client_id") !== client.id || query.get("code_challenge_method") !== "S256") {
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
      if (form.get("client_id") !== client.id || form.get("client_secret") !== client.secret)
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
