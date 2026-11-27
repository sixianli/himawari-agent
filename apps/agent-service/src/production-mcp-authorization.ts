import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ApplicationPortError,
  type ClockPort,
  MCP_CONNECTION_DEFAULT_READ_CEILING,
  MCP_CONNECTION_NAME_MAXIMUM,
  type McpConnectionPushPolicy,
  type McpConnectionReadCeiling,
  type McpConnectionRecord,
  type McpConnectionScope,
  type McpConnectionStorePort,
  type McpOAuthRegistration,
  type McpOAuthStorePort,
  mcpConnectionNameHasHiddenCharacter,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import type { McpClientMetadataDocuments } from "./production-mcp-client-metadata.js";
import { newMcpConnectionId } from "./production-mcp-connections.js";

export const MCP_AUTH_PREFIX = "/api/mcp-auth/v1";
export const MCP_READ_SCOPE = "himawari:read";
export const MCP_WRITE_SCOPE = "himawari:write";
export const MCP_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE] as const;
export const MCP_ACCESS_TOKEN_TTL_MS = 3_600_000;
export const MCP_REFRESH_TOKEN_TTL_MS = 90 * 24 * 3_600_000;
export const MCP_GRANT_TTL_MS = 10 * 60_000;
export const MCP_CODE_TTL_MS = 5 * 60_000;
export const MCP_TOKEN_PRUNE_INTERVAL_MS = 3_600_000;
export const MCP_PENDING_GRANT_MAXIMUM = 20;
export const MCP_DEFAULT_PUSH_POLICY: McpConnectionPushPolicy = "direct";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const GRANT_ID_PATTERN = /^grant-[A-Za-z0-9_-]{22}$/u;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const STATE_MAXIMUM = 1_024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type McpGrantStatus = "pending" | "approved" | "denied" | "expired";

export interface McpGrantView {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly registration: McpOAuthRegistration;
  readonly clientHost: string;
  readonly redirectHost: string;
  readonly localRedirect: boolean;
  readonly wantsWrite: boolean;
  readonly existingConnection: {
    readonly id: string;
    readonly name: string;
    readonly readCeiling: McpConnectionReadCeiling;
    readonly pushPolicy: McpConnectionPushPolicy;
  } | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface Grant {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly registration: McpOAuthRegistration;
  readonly registeredRedirects: readonly string[];
  readonly redirectUri: string;
  readonly state: string | null;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: McpGrantStatus;
  location: string | null;
}

interface Code {
  readonly grantId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly connectionId: string;
  readonly expiresAt: number;
  familyId: string | null;
  refreshSha256: string | null;
}

export interface OAuthReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export type AuthorizeOutcome =
  | { readonly kind: "redirect"; readonly location: string }
  | {
      readonly kind: "waiting";
      readonly grantId: string;
      readonly clientName: string;
      readonly clientHost: string;
    }
  | { readonly kind: "error"; readonly reason: AuthorizeErrorReason };

export type AuthorizeErrorReason =
  | "client_unknown"
  | "client_unavailable"
  | "redirect_invalid"
  | "busy";

export interface McpBearerAccess {
  readonly connection: McpConnectionRecord;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

export interface ProductionMcpAuthorizationOptions {
  readonly scope: McpConnectionScope;
  readonly clock: ClockPort;
  readonly publicOrigin: string;
  readonly resourcePath: string;
  readonly store: McpOAuthStorePort;
  readonly connections: Pick<McpConnectionStorePort, "read">;
  readonly metadata: McpClientMetadataDocuments;
  readonly notify: (grant: McpGrantView) => Promise<void>;
  readonly onFailure: (error: unknown) => void;
  readonly random?: (size: number) => Buffer;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function acceptableRedirectUri(uri: string): boolean {
  if (uri.length > 512 || !URL.canParse(uri)) return false;
  const url = new URL(uri);
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/u.test(url.protocol);
}

function loopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!URL.canParse(requested)) return false;
  const wanted = new URL(requested);
  if (!loopback(wanted)) return false;
  return registered.some((entry) => {
    if (!URL.canParse(entry)) return false;
    const candidate = new URL(entry);
    return (
      loopback(candidate) &&
      candidate.hostname === wanted.hostname &&
      candidate.pathname === wanted.pathname &&
      candidate.search === wanted.search
    );
  });
}

function hostOf(uri: string): string {
  if (!URL.canParse(uri)) return uri;
  const url = new URL(uri);
  return url.host === "" ? url.protocol.replace(/:$/u, "") : url.host;
}

function sameResource(requested: string, resource: string): boolean {
  const trim = (value: string) => value.replace(/\/+$/u, "");
  return trim(requested) === trim(resource);
}

function connectionName(clientName: string, fallback: string): string {
  const cleaned = [...clientName.normalize("NFC")]
    .filter((character) => !mcpConnectionNameHasHiddenCharacter(character))
    .join("")
    .trim();
  const clipped = [...(cleaned.length > 0 ? cleaned : fallback)]
    .slice(0, MCP_CONNECTION_NAME_MAXIMUM)
    .join("")
    .trim();
  return clipped.length > 0 ? clipped : "agent";
}

function oauthError(status: number, error: string, description?: string): OAuthReply {
  return {
    status,
    body: { error, ...(description ? { error_description: description } : {}) },
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class ProductionMcpAuthorization {
  readonly #options: ProductionMcpAuthorizationOptions;
  readonly #grants = new Map<string, Grant>();
  readonly #codes = new Map<string, Code>();
  readonly #random: (size: number) => Buffer;
  #prunedAt = 0;

  constructor(options: ProductionMcpAuthorizationOptions) {
    this.#options = options;
    this.#random = options.random ?? randomBytes;
  }

  get issuer(): string {
    return this.#options.publicOrigin;
  }

  get resource(): string {
    return `${this.#options.publicOrigin}${this.#options.resourcePath}`;
  }

  get resourceMetadataUrl(): string {
    return `${this.#options.publicOrigin}/.well-known/oauth-protected-resource${this.#options.resourcePath}`;
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Himawari",
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const base = `${this.issuer}${MCP_AUTH_PREFIX}`;
    return {
      issuer: this.issuer,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      scopes_supported: [...MCP_SCOPES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  #now(): number {
    return Date.parse(this.#options.clock.now());
  }

  #iso(at: number): string {
    return new Date(at).toISOString();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, grant] of this.#grants)
      if (grant.expiresAt <= now) {
        if (grant.status === "pending") grant.status = "expired";
        if (grant.expiresAt + MCP_GRANT_TTL_MS <= now) this.#grants.delete(id);
      }
    for (const [code, entry] of this.#codes)
      if (entry.expiresAt + MCP_CODE_TTL_MS <= now) this.#codes.delete(code);
  }

  async register(body: unknown): Promise<OAuthReply> {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return oauthError(400, "invalid_client_metadata", "body must be a JSON object");
    const fields = body as Record<string, unknown>;
    const redirects = fields["redirect_uris"];
    if (
      !Array.isArray(redirects) ||
      redirects.length === 0 ||
      redirects.length > 10 ||
      !redirects.every((uri) => typeof uri === "string" && acceptableRedirectUri(uri))
    )
      return oauthError(400, "invalid_redirect_uri");
    const grantTypes = fields["grant_types"];
    if (
      grantTypes !== undefined &&
      (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code"))
    )
      return oauthError(
        400,
        "invalid_client_metadata",
        "grant_types must include authorization_code",
      );
    const responseTypes = fields["response_types"];
    if (
      responseTypes !== undefined &&
      (!Array.isArray(responseTypes) || !responseTypes.includes("code"))
    )
      return oauthError(400, "invalid_client_metadata", "response_types must include code");
    const name = text(fields["client_name"])?.trim();
    const clientName = [...(name && name.length > 0 ? name : hostOf(redirects[0] as string))]
      .slice(0, 128)
      .join("")
      .trim();
    const clientId = `mcp-client-${base64Url(this.#random(18))}`;
    const now = this.#options.clock.now();
    try {
      await this.#options.store.registerClient({
        ...this.#options.scope,
        clientId,
        clientName,
        redirectUris: redirects as string[],
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.CONFLICT)
        return oauthError(429, "temporarily_unavailable", "too many unapproved registrations");
      throw error;
    }
    return {
      status: 201,
      body: {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.parse(now) / 1_000),
        client_name: clientName,
        redirect_uris: redirects,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    };
  }

  async #client(clientId: string): Promise<
    | {
        readonly status: "ok";
        readonly registration: McpOAuthRegistration;
        readonly clientName: string;
        readonly redirectUris: readonly string[];
      }
    | { readonly status: "unknown" | "unavailable" }
  > {
    if (clientId.startsWith("https://")) {
      const read = await this.#options.metadata.read(clientId);
      if (read.status === "unavailable") {
        this.#options.onFailure({ code: read.reason });
        return { status: "unavailable" };
      }
      if (read.status === "invalid") {
        this.#options.onFailure({ code: read.reason });
        return { status: "unknown" };
      }
      return {
        status: "ok",
        registration: "metadata_document",
        clientName: read.metadata.clientName,
        redirectUris: read.metadata.redirectUris,
      };
    }
    const stored = await this.#options.store.readClient({ ...this.#options.scope, clientId });
    if (!stored || stored.registration !== "dynamic") return { status: "unknown" };
    return {
      status: "ok",
      registration: "dynamic",
      clientName: stored.clientName,
      redirectUris: stored.redirectUris,
    };
  }

  #errorRedirect(redirectUri: string, state: string | null, error: string): string {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    if (state !== null) url.searchParams.set("state", state);
    url.searchParams.set("iss", this.issuer);
    return url.href;
  }

  async authorize(query: URLSearchParams): Promise<AuthorizeOutcome> {
    this.#sweep();
    const single = (name: string) => (query.getAll(name).length === 1 ? query.get(name) : null);
    const clientId = single("client_id");
    if (!clientId || clientId.length > 512) return { kind: "error", reason: "client_unknown" };
    const client = await this.#client(clientId);
    if (client.status === "unavailable") return { kind: "error", reason: "client_unavailable" };
    if (client.status !== "ok") return { kind: "error", reason: "client_unknown" };
    const requestedRedirect = query.has("redirect_uri") ? single("redirect_uri") : undefined;
    const redirectUri =
      requestedRedirect === undefined
        ? client.redirectUris.length === 1
          ? (client.redirectUris[0] as string)
          : null
        : requestedRedirect;
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri))
      return { kind: "error", reason: "redirect_invalid" };
    const state = query.has("state") ? single("state") : null;
    if (state !== null && state.length > STATE_MAXIMUM)
      return {
        kind: "redirect",
        location: this.#errorRedirect(redirectUri, null, "invalid_request"),
      };
    const fail = (error: string): AuthorizeOutcome => ({
      kind: "redirect",
      location: this.#errorRedirect(redirectUri, state, error),
    });
    if (single("response_type") !== "code") return fail("unsupported_response_type");
    const challenge = single("code_challenge");
    if (
      single("code_challenge_method") !== "S256" ||
      !challenge ||
      !CHALLENGE_PATTERN.test(challenge)
    )
      return fail("invalid_request");
    const resources = query.getAll("resource");
    if (
      resources.length > 1 ||
      (resources[0] !== undefined && !sameResource(resources[0], this.resource))
    )
      return fail("invalid_target");
    const scopeText = single("scope");
    const requested =
      scopeText === null || scopeText.trim() === ""
        ? [...MCP_SCOPES]
        : [...new Set(scopeText.trim().split(/\s+/u))];
    const scopes = MCP_SCOPES.filter((entry) => requested.includes(entry));
    if (scopes.length === 0) return fail("invalid_scope");
    if (!scopes.includes(MCP_READ_SCOPE)) scopes.unshift(MCP_READ_SCOPE);
    const pending = [...this.#grants.values()].filter((grant) => grant.status === "pending");
    if (pending.length >= MCP_PENDING_GRANT_MAXIMUM) return { kind: "error", reason: "busy" };
    const now = this.#now();
    const grant: Grant = {
      id: `grant-${base64Url(this.#random(16))}`,
      clientId,
      clientName: client.clientName,
      registration: client.registration,
      registeredRedirects: client.redirectUris,
      redirectUri,
      state,
      codeChallenge: challenge,
      scopes,
      resource: this.resource,
      createdAt: now,
      expiresAt: now + MCP_GRANT_TTL_MS,
      status: "pending",
      location: null,
    };
    this.#grants.set(grant.id, grant);
    const view = await this.#view(grant);
    try {
      await this.#options.notify(view);
    } catch (error) {
      this.#options.onFailure(error);
    }
    return {
      kind: "waiting",
      grantId: grant.id,
      clientName: view.clientName,
      clientHost: view.clientHost,
    };
  }

  status(
    grantId: string,
  ): { readonly state: McpGrantStatus; readonly location: string | null } | null {
    this.#sweep();
    if (!GRANT_ID_PATTERN.test(grantId)) return null;
    const grant = this.#grants.get(grantId);
    if (!grant) return null;
    if (grant.status === "expired" && grant.location === null)
      grant.location = this.#errorRedirect(grant.redirectUri, grant.state, "access_denied");
    return { state: grant.status, location: grant.status === "pending" ? null : grant.location };
  }

  async #view(grant: Grant): Promise<McpGrantView> {
    const stored = await this.#options.store
      .readClient({ ...this.#options.scope, clientId: grant.clientId })
      .catch(() => null);
    const connections = stored?.connectionId ? await this.#existing(stored.connectionId) : null;
    return {
      id: grant.id,
      clientId: grant.clientId,
      clientName: grant.clientName,
      registration: grant.registration,
      clientHost:
        grant.registration === "metadata_document"
          ? hostOf(grant.clientId)
          : hostOf(grant.redirectUri),
      redirectHost: hostOf(grant.redirectUri),
      localRedirect: URL.canParse(grant.redirectUri) && loopback(new URL(grant.redirectUri)),
      wantsWrite: grant.scopes.includes(MCP_WRITE_SCOPE),
      existingConnection: connections,
      createdAt: this.#iso(grant.createdAt),
      expiresAt: this.#iso(grant.expiresAt),
    };
  }

  async #existing(connectionId: string): Promise<McpGrantView["existingConnection"]> {
    const connection = await this.#options.connections
      .read({ ...this.#options.scope, id: connectionId })
      .catch(() => null);
    if (!connection || connection.status === "revoked") return null;
    return {
      id: connection.id,
      name: connection.name,
      readCeiling: connection.readCeiling,
      pushPolicy: connection.pushPolicy,
    };
  }

  async pendingGrants(): Promise<readonly McpGrantView[]> {
    this.#sweep();
    const pending = [...this.#grants.values()]
      .filter((grant) => grant.status === "pending")
      .sort((left, right) => left.createdAt - right.createdAt);
    return Promise.all(pending.map((grant) => this.#view(grant)));
  }

  #pending(grantId: string): Grant {
    this.#sweep();
    const grant = this.#grants.get(grantId);
    if (!grant || grant.status !== "pending")
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MCP_GRANT_NOT_PENDING");
    return grant;
  }

  async approve(input: {
    readonly grantId: string;
    readonly name: string | null;
    readonly readCeiling: McpConnectionReadCeiling | null;
    readonly pushPolicy: McpConnectionPushPolicy | null;
    readonly write: boolean;
  }): Promise<string> {
    const grant = this.#pending(input.grantId);
    const now = this.#options.clock.now();
    const connection = await this.#options.store.bindGrant({
      ...this.#options.scope,
      clientId: grant.clientId,
      registration: grant.registration,
      clientName: [...grant.clientName].slice(0, 128).join("").trim() || hostOf(grant.redirectUri),
      redirectUris: grant.registeredRedirects,
      newConnection: {
        id: newMcpConnectionId(),
        name: connectionName(input.name ?? grant.clientName, hostOf(grant.clientId)),
        readCeiling: input.readCeiling ?? MCP_CONNECTION_DEFAULT_READ_CEILING,
        pushPolicy: input.pushPolicy ?? MCP_DEFAULT_PUSH_POLICY,
      },
      now,
    });
    if (grant.status !== "pending")
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MCP_GRANT_NOT_PENDING");
    const code = base64Url(this.#random(TOKEN_BYTES));
    this.#codes.set(sha256Hex(code), {
      grantId: grant.id,
      clientId: grant.clientId,
      redirectUri: grant.redirectUri,
      codeChallenge: grant.codeChallenge,
      scopes: input.write
        ? grant.scopes
        : grant.scopes.filter((entry) => entry !== MCP_WRITE_SCOPE),
      resource: grant.resource,
      connectionId: connection.id,
      expiresAt: this.#now() + MCP_CODE_TTL_MS,
      familyId: null,
      refreshSha256: null,
    });
    const location = new URL(grant.redirectUri);
    location.searchParams.set("code", code);
    if (grant.state !== null) location.searchParams.set("state", grant.state);
    location.searchParams.set("iss", this.issuer);
    grant.status = "approved";
    grant.location = location.href;
    return connection.id;
  }

  deny(grantId: string): void {
    const grant = this.#pending(grantId);
    grant.status = "denied";
    grant.location = this.#errorRedirect(grant.redirectUri, grant.state, "access_denied");
  }

  #mint(): { readonly token: string; readonly sha256: string } {
    const token = base64Url(this.#random(TOKEN_BYTES));
    return { token, sha256: sha256Hex(token) };
  }

  #tokenReply(access: string, refresh: string, scopes: readonly string[]): OAuthReply {
    return {
      status: 200,
      body: {
        access_token: access,
        token_type: "Bearer",
        expires_in: Math.floor(MCP_ACCESS_TOKEN_TTL_MS / 1_000),
        refresh_token: refresh,
        scope: scopes.join(" "),
      },
    };
  }

  async token(form: Readonly<Record<string, string>>): Promise<OAuthReply> {
    this.#sweep();
    const now = Date.parse(this.#options.clock.now());
    if (now - this.#prunedAt >= MCP_TOKEN_PRUNE_INTERVAL_MS) {
      this.#prunedAt = now;
      await this.prune();
    }
    const grantType = form["grant_type"];
    const clientId = form["client_id"];
    if (form["client_secret"] !== undefined) return oauthError(401, "invalid_client");
    if (!clientId) return oauthError(401, "invalid_client");
    if (grantType === "authorization_code") return this.#exchangeCode(form, clientId);
    if (grantType === "refresh_token") return this.#refresh(form, clientId);
    return oauthError(400, "unsupported_grant_type");
  }

  async #exchangeCode(
    form: Readonly<Record<string, string>>,
    clientId: string,
  ): Promise<OAuthReply> {
    const code = form["code"];
    const verifier = form["code_verifier"];
    if (!code || !TOKEN_PATTERN.test(code) || !verifier || !VERIFIER_PATTERN.test(verifier))
      return oauthError(400, "invalid_grant");
    const entry = this.#codes.get(sha256Hex(code));
    if (!entry || entry.clientId !== clientId) return oauthError(400, "invalid_grant");
    const now = this.#now();
    if (entry.familyId !== null) {
      if (entry.refreshSha256 !== null)
        await this.#options.store.revokeToken({
          ...this.#options.scope,
          tokenSha256: entry.refreshSha256,
          clientId,
          now: this.#iso(now),
        });
      this.#codes.delete(sha256Hex(code));
      return oauthError(400, "invalid_grant");
    }
    if (entry.expiresAt <= now) return oauthError(400, "invalid_grant");
    const redirect = form["redirect_uri"];
    if (redirect !== undefined && redirect !== entry.redirectUri)
      return oauthError(400, "invalid_grant");
    const resource = form["resource"];
    if (resource !== undefined && !sameResource(resource, entry.resource))
      return oauthError(400, "invalid_target");
    const expected = Buffer.from(entry.codeChallenge, "utf8");
    const actual = Buffer.from(
      createHash("sha256").update(verifier, "ascii").digest("base64url"),
      "utf8",
    );
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return oauthError(400, "invalid_grant");
    const access = this.#mint();
    const refresh = this.#mint();
    const familyId = base64Url(this.#random(18));
    entry.familyId = familyId;
    entry.refreshSha256 = refresh.sha256;
    try {
      await this.#options.store.issueTokens({
        ...this.#options.scope,
        connectionId: entry.connectionId,
        clientId,
        familyId,
        scopes: entry.scopes,
        resource: entry.resource,
        access: { tokenSha256: access.sha256, expiresAt: this.#iso(now + MCP_ACCESS_TOKEN_TTL_MS) },
        refresh: {
          tokenSha256: refresh.sha256,
          expiresAt: this.#iso(now + MCP_REFRESH_TOKEN_TTL_MS),
        },
        now: this.#iso(now),
      });
    } catch (error) {
      if (error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.CONFLICT)
        return oauthError(400, "invalid_grant");
      throw error;
    }
    return this.#tokenReply(access.token, refresh.token, entry.scopes);
  }

  async #refresh(form: Readonly<Record<string, string>>, clientId: string): Promise<OAuthReply> {
    const presented = form["refresh_token"];
    if (!presented || !TOKEN_PATTERN.test(presented)) return oauthError(400, "invalid_grant");
    const resource = form["resource"];
    if (resource !== undefined && !sameResource(resource, this.resource))
      return oauthError(400, "invalid_target");
    const now = this.#now();
    const access = this.#mint();
    const refresh = this.#mint();
    const rotated = await this.#options.store.rotateRefresh({
      ...this.#options.scope,
      refreshSha256: sha256Hex(presented),
      clientId,
      next: {
        access: { tokenSha256: access.sha256, expiresAt: this.#iso(now + MCP_ACCESS_TOKEN_TTL_MS) },
        refresh: {
          tokenSha256: refresh.sha256,
          expiresAt: this.#iso(now + MCP_REFRESH_TOKEN_TTL_MS),
        },
      },
      now: this.#iso(now),
    });
    if (rotated.status !== "rotated") return oauthError(400, "invalid_grant");
    const requested = form["scope"];
    if (
      requested !== undefined &&
      requested.trim() !== "" &&
      !requested
        .trim()
        .split(/\s+/u)
        .every((entry) => rotated.previous.scopes.includes(entry))
    )
      return oauthError(400, "invalid_scope");
    return this.#tokenReply(access.token, refresh.token, rotated.previous.scopes);
  }

  async revoke(form: Readonly<Record<string, string>>): Promise<void> {
    const token = form["token"];
    const clientId = form["client_id"];
    if (!token || !TOKEN_PATTERN.test(token) || !clientId) return;
    await this.#options.store.revokeToken({
      ...this.#options.scope,
      tokenSha256: sha256Hex(token),
      clientId,
      now: this.#options.clock.now(),
    });
  }

  async verifyAccessToken(token: string): Promise<McpBearerAccess | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const found = await this.#options.store.findAccess({
      ...this.#options.scope,
      tokenSha256: sha256Hex(token),
      now: this.#options.clock.now(),
    });
    if (!found || !sameResource(found.token.resource, this.resource)) return null;
    return {
      connection: found.connection,
      scopes: found.token.scopes,
      expiresAt: Math.floor(Date.parse(found.token.expiresAt) / 1_000),
    };
  }

  async prune(): Promise<void> {
    try {
      await this.#options.store.pruneExpired({
        ...this.#options.scope,
        now: this.#options.clock.now(),
      });
    } catch (error) {
      this.#options.onFailure(error);
    }
  }
}
