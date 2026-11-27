import type {
  McpConnectionPushPolicy,
  McpConnectionReadCeiling,
  McpConnectionRecord,
  McpConnectionScope,
} from "./mcp-connections.js";

export const MCP_OAUTH_REGISTRATIONS = ["dynamic", "metadata_document"] as const;
export type McpOAuthRegistration = (typeof MCP_OAUTH_REGISTRATIONS)[number];

export const MCP_OAUTH_TOKEN_KINDS = ["access", "refresh"] as const;
export type McpOAuthTokenKind = (typeof MCP_OAUTH_TOKEN_KINDS)[number];

export const MCP_OAUTH_CLIENT_ID_MAXIMUM = 512;
export const MCP_OAUTH_CLIENT_NAME_MAXIMUM = 128;
export const MCP_OAUTH_REDIRECT_URIS_MAXIMUM = 10;
export const MCP_OAUTH_REDIRECT_URI_MAXIMUM = 512;
export const MCP_OAUTH_UNBOUND_CLIENT_MAXIMUM = 100;
export const MCP_OAUTH_UNBOUND_CLIENT_KEEP_MS = 24 * 3_600_000;

export interface McpOAuthClientRecord extends McpConnectionScope {
  readonly clientId: string;
  readonly registration: McpOAuthRegistration;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly connectionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpOAuthClientRegister extends McpConnectionScope {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: string;
}

export interface McpOAuthGrantBind extends McpConnectionScope {
  readonly clientId: string;
  readonly registration: McpOAuthRegistration;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly newConnection: {
    readonly id: string;
    readonly name: string;
    readonly readCeiling: McpConnectionReadCeiling;
    readonly pushPolicy: McpConnectionPushPolicy;
  };
  readonly now: string;
}

export interface McpOAuthTokenIssue {
  readonly tokenSha256: string;
  readonly expiresAt: string;
}

export interface McpOAuthTokenPair extends McpConnectionScope {
  readonly connectionId: string;
  readonly clientId: string;
  readonly familyId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly access: McpOAuthTokenIssue;
  readonly refresh: McpOAuthTokenIssue;
  readonly now: string;
}

export interface McpOAuthTokenRecord extends McpConnectionScope {
  readonly tokenSha256: string;
  readonly kind: McpOAuthTokenKind;
  readonly connectionId: string;
  readonly clientId: string;
  readonly familyId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
}

export interface McpOAuthAccess {
  readonly token: McpOAuthTokenRecord;
  readonly connection: McpConnectionRecord;
}

export type McpOAuthRotation =
  | { readonly status: "rotated"; readonly previous: McpOAuthTokenRecord }
  | { readonly status: "reused" | "not_found" | "expired" | "connection_closed" };

export interface McpOAuthStorePort {
  registerClient(input: McpOAuthClientRegister): Promise<McpOAuthClientRecord>;
  readClient(
    input: McpConnectionScope & { readonly clientId: string },
  ): Promise<McpOAuthClientRecord | null>;
  bindGrant(input: McpOAuthGrantBind): Promise<McpConnectionRecord>;
  issueTokens(input: McpOAuthTokenPair): Promise<void>;
  findAccess(
    input: McpConnectionScope & { readonly tokenSha256: string; readonly now: string },
  ): Promise<McpOAuthAccess | null>;
  rotateRefresh(
    input: McpConnectionScope & {
      readonly refreshSha256: string;
      readonly clientId: string;
      readonly next: Omit<
        McpOAuthTokenPair,
        | "connectionId"
        | "clientId"
        | "familyId"
        | "scopes"
        | "resource"
        | "ownerId"
        | "agentId"
        | "now"
      >;
      readonly now: string;
    },
  ): Promise<McpOAuthRotation>;
  revokeToken(
    input: McpConnectionScope & {
      readonly tokenSha256: string;
      readonly clientId: string;
      readonly now: string;
    },
  ): Promise<void>;
  pruneExpired(input: McpConnectionScope & { readonly now: string }): Promise<number>;
}
