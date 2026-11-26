import { randomBytes } from "node:crypto";
import type {
  ClockPort,
  McpConnectionPushPolicy,
  McpConnectionReadCeiling,
  McpConnectionScope,
  McpConnectionStorePort,
  McpOAuthStorePort,
} from "@himawari-agent/application";
import {
  MCP_ACCESS_TOKEN_TTL_MS,
  MCP_READ_SCOPE,
  MCP_REFRESH_TOKEN_TTL_MS,
  MCP_WRITE_SCOPE,
  ProductionMcpAuthorization,
  sha256Hex,
} from "../../src/production-mcp-authorization.js";
import { MCP_READ_PATH } from "../../src/production-mcp-read.js";

export const MCP_TEST_ORIGIN = "https://agent.example.test";

export interface McpOAuthFixture {
  readonly authorization: ProductionMcpAuthorization;
  readonly connect: (input: {
    readonly id: string;
    readonly name?: string;
    readonly readCeiling?: McpConnectionReadCeiling;
    readonly pushPolicy?: McpConnectionPushPolicy;
    readonly write?: boolean;
  }) => Promise<{ readonly connectionId: string; readonly token: string }>;
  readonly issue: (connectionId: string, clientId: string, write?: boolean) => Promise<string>;
}

export function createMcpOAuth(options: {
  readonly scope: McpConnectionScope;
  readonly clock: ClockPort;
  readonly store: McpOAuthStorePort;
  readonly connections: Pick<McpConnectionStorePort, "read">;
}): McpOAuthFixture {
  const authorization = new ProductionMcpAuthorization({
    scope: options.scope,
    clock: options.clock,
    publicOrigin: MCP_TEST_ORIGIN,
    resourcePath: MCP_READ_PATH,
    store: options.store,
    connections: options.connections,
    metadata: { read: async () => ({ status: "invalid", reason: "MCP_TEST_NO_DOCUMENTS" }) },
    notify: async () => undefined,
    onFailure: () => undefined,
  });
  const issue = async (connectionId: string, clientId: string, write = true) => {
    const token = randomBytes(32).toString("base64url");
    const now = Date.parse(options.clock.now());
    await options.store.issueTokens({
      ...options.scope,
      connectionId,
      clientId,
      familyId: randomBytes(18).toString("base64url"),
      scopes: write ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE] : [MCP_READ_SCOPE],
      resource: authorization.resource,
      access: {
        tokenSha256: sha256Hex(token),
        expiresAt: new Date(now + MCP_ACCESS_TOKEN_TTL_MS).toISOString(),
      },
      refresh: {
        tokenSha256: sha256Hex(randomBytes(32).toString("base64url")),
        expiresAt: new Date(now + MCP_REFRESH_TOKEN_TTL_MS).toISOString(),
      },
      now: options.clock.now(),
    });
    return token;
  };
  return {
    authorization,
    issue,
    connect: async (input) => {
      const clientId = `client-${input.id}`;
      const connection = await options.store.bindGrant({
        ...options.scope,
        clientId,
        registration: "dynamic",
        clientName: input.name ?? input.id,
        redirectUris: ["http://localhost/callback"],
        newConnection: {
          id: input.id,
          name: input.name ?? input.id,
          readCeiling: input.readCeiling ?? "private",
          pushPolicy: input.pushPolicy ?? "ask",
        },
        now: options.clock.now(),
      });
      return {
        connectionId: connection.id,
        token: await issue(connection.id, clientId, input.write ?? true),
      };
    },
  };
}
