import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { AppConnectionScope, AppConnectionStorePort } from "@himawari-agent/application";
import {
  auth,
  Client,
  type FetchLike,
  LATEST_PROTOCOL_VERSION,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  DeviceConnection,
  DeviceConnectionAddOutcome,
  DeviceConnectionAuthorizationStart,
} from "./device-api-routes.js";

export const APP_CONNECTIONS_CALLBACK_PATH = "/api/connections/v1/callback";
export const APP_CONNECTIONS_CLIENT_METADATA_PATH = "/api/connections/v1/client.json";
export const APP_CONNECTION_CALLBACK_HOST = "connection-authorization";

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 20;
const CLIENT_NAME = "Himawari";
const MAX_TOOL_PAGES = 20;
const ADDED_NAME_PREFIX = "app_";
const TITLE_MAXIMUM = 80;
const SERVER_URL_MAXIMUM = 2048;
const PROBE_TIMEOUT_MS = 15_000;
const PUBLIC_CLIENT_AUTH = "none";

export function isAllowedAppServerUrl(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    host.length > 0 &&
    isIP(host) === 0 &&
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    host.includes(".")
  );
}

export interface AppTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly readOnly: boolean;
}

export interface AppToolResult {
  readonly content: readonly unknown[];
  readonly isError: boolean;
}

export interface AppConnectionDefinition {
  readonly name: string;
  readonly title: string;
  readonly serverUrl: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly trustsReadOnlyLabels: boolean;
}

export interface AppConnectionApp {
  readonly name: string;
  readonly title: string;
  readonly serverUrl: string;
  readonly trustsReadOnlyLabels: boolean;
  readonly added: boolean;
}

export interface AppConnectionSealPort {
  seal(input: AppConnectionScope & { readonly text: string; readonly at: string }): Promise<string>;
  open(input: AppConnectionScope & { readonly ref: string }): Promise<string | undefined>;
  release(input: AppConnectionScope & { readonly refs: readonly string[] }): Promise<void>;
}

export type AppConnectionOutcome = "connected" | "denied" | "failed";

interface Pending {
  readonly name: string;
  readonly deviceId: string;
  readonly callbackScheme: string;
  readonly expiresAt: number;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  reply?: {
    readonly code: string | null;
    readonly error: string | null;
    readonly iss: string | null;
  };
}

interface SavedGrant {
  readonly tokens?: StoredOAuthTokens;
  readonly discovery?: OAuthDiscoveryState;
}

interface ResolvedApp {
  readonly definition: AppConnectionDefinition;
  readonly added: boolean;
}

interface ClientHolder {
  readonly fixed: boolean;
  information?: StoredOAuthClientInformation;
}

export interface ProductionAppConnectionsOptions {
  readonly scope: AppConnectionScope;
  readonly store: AppConnectionStorePort;
  readonly seal: AppConnectionSealPort;
  readonly definitions: readonly AppConnectionDefinition[];
  readonly publicOrigin: string;
  readonly now: () => string;
  readonly fetch?: FetchLike;
  readonly serverUrlAllowed?: (url: URL) => boolean;
}

export class ProductionAppConnections {
  readonly #options: ProductionAppConnectionsOptions;
  readonly #definitions: ReadonlyMap<string, AppConnectionDefinition>;
  readonly #states = new Map<string, Pending>();

  constructor(options: ProductionAppConnectionsOptions) {
    this.#options = options;
    this.#definitions = new Map(
      options.definitions.map((definition) => [definition.name, definition]),
    );
  }

  get callbackUrl(): string {
    return new URL(APP_CONNECTIONS_CALLBACK_PATH, this.#options.publicOrigin).href;
  }

  get clientMetadataUrl(): string {
    return new URL(APP_CONNECTIONS_CLIENT_METADATA_PATH, this.#options.publicOrigin).href;
  }

  clientMetadataDocument(): Readonly<Record<string, unknown>> {
    return {
      client_id: this.clientMetadataUrl,
      client_name: CLIENT_NAME,
      client_uri: new URL("/", this.#options.publicOrigin).href,
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: PUBLIC_CLIENT_AUTH,
    };
  }

  async definition(name: string): Promise<AppConnectionApp | undefined> {
    const resolved = await this.#resolve(name);
    if (!resolved) return undefined;
    const { definition, added } = resolved;
    return {
      name: definition.name,
      title: definition.title,
      serverUrl: definition.serverUrl,
      trustsReadOnlyLabels: definition.trustsReadOnlyLabels,
      added,
    };
  }

  async list(): Promise<readonly DeviceConnection[]> {
    const { scope, store } = this.#options;
    const saved = new Map((await store.list(scope)).map((record) => [record.name, record]));
    const added = (await store.listApps(scope)).filter(({ name }) => !this.#definitions.has(name));
    return [
      ...this.#options.definitions.map((definition) => ({ definition, added: false })),
      ...added.map((app) => ({ definition: this.#addedDefinition(app), added: true })),
    ].map(({ definition, added: isAdded }) => {
      const record = saved.get(definition.name);
      return {
        name: definition.name,
        title: definition.title,
        status: record?.status ?? "disconnected",
        account: null,
        connectedAt: record?.connectedAt ?? null,
        added: isAdded,
      };
    });
  }

  async add(input: {
    readonly serverUrl: string;
    readonly title?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
  }): Promise<DeviceConnectionAddOutcome> {
    let url: URL;
    try {
      url = new URL(input.serverUrl);
    } catch {
      return { outcome: "invalid_address" };
    }
    const allowed = this.#options.serverUrlAllowed ?? isAllowedAppServerUrl;
    if (input.serverUrl.length > SERVER_URL_MAXIMUM || !allowed(url))
      return { outcome: "invalid_address" };
    const probe = await this.#probe(url);
    if (probe.kind === "unreachable") return { outcome: "unreachable" };
    const { scope, store, now } = this.#options;
    const at = now();
    const name = `${ADDED_NAME_PREFIX}${randomBytes(6).toString("hex")}`;
    const title =
      shortTitle(input.title) ??
      (probe.kind === "open" ? shortTitle(probe.title) : undefined) ??
      shortTitle(url.hostname);
    await store.addApp({ ...scope, name, title: title ?? name, serverUrl: url.href, now: at });
    if (input.clientId !== undefined)
      await this.#saveClient(name, typedClient(input.clientId, input.clientSecret));
    if (probe.kind === "open") await this.#saveGrant(name, {}, "connect");
    const listed = (await this.list()).find((entry) => entry.name === name);
    return listed ? { outcome: "added", connection: listed } : { outcome: "unreachable" };
  }

  async remove(name: string): Promise<boolean | undefined> {
    const resolved = await this.#resolve(name);
    if (!resolved?.added) return undefined;
    const { scope, store, seal } = this.#options;
    const refs = await store.removeApp({ ...scope, name });
    if (refs.length > 0) await seal.release({ ...scope, refs });
    return true;
  }

  async begin(input: {
    readonly deviceId: string;
    readonly connection: string;
    readonly callbackScheme: string;
  }): Promise<DeviceConnectionAuthorizationStart | undefined> {
    const resolved = await this.#resolve(input.connection);
    if (!resolved) return undefined;
    const { definition } = resolved;
    const state = this.#issueState({
      name: definition.name,
      deviceId: input.deviceId,
      callbackScheme: input.callbackScheme,
    });
    const pending = this.#states.get(state);
    if (!pending) return undefined;
    let authorizationUrl: URL | undefined;
    const provider = this.#provider(definition, await this.#client(definition), {
      state,
      pending,
      redirect: (url) => {
        authorizationUrl = url;
      },
    });
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, {
        serverUrl: definition.serverUrl,
        ...(this.#options.fetch === undefined ? {} : { fetchFn: this.#options.fetch }),
      });
    } catch (error) {
      this.#states.delete(state);
      if (isRegistrationUnavailable(error))
        return { kind: "client_required", redirectUri: this.callbackUrl };
      return undefined;
    }
    if (result !== "REDIRECT" || authorizationUrl === undefined) {
      this.#states.delete(state);
      return undefined;
    }
    return { kind: "browser", authorizationUrl: authorizationUrl.href };
  }

  owns(state: string): boolean {
    return this.#states.has(state);
  }

  callback(input: {
    readonly state: string | null;
    readonly code: string | null;
    readonly error: string | null;
    readonly iss: string | null;
  }): string | undefined {
    const pending = input.state ? this.#states.get(input.state) : undefined;
    if (!input.state || !pending) return undefined;
    if (pending.reply === undefined && pending.expiresAt > Date.parse(this.#options.now()))
      pending.reply = { code: input.code, error: input.error, iss: input.iss };
    return `${pending.callbackScheme}://${APP_CONNECTION_CALLBACK_HOST}?${new URLSearchParams({ state: input.state })}`;
  }

  async complete(input: {
    readonly deviceId: string;
    readonly state: string;
  }): Promise<AppConnectionOutcome> {
    const pending = this.#states.get(input.state);
    if (!pending || pending.deviceId !== input.deviceId) return "failed";
    this.#states.delete(input.state);
    const reply = pending.reply;
    if (!reply || pending.expiresAt <= Date.parse(this.#options.now())) return "failed";
    if (reply.error === "access_denied") return "denied";
    if (reply.error !== null || reply.code === null) return "failed";
    const resolved = await this.#resolve(pending.name);
    if (!resolved) return "failed";
    const { definition } = resolved;
    let granted: SavedGrant | undefined;
    const provider = this.#provider(definition, await this.#client(definition), {
      state: input.state,
      pending,
      saveTokens: (tokens) => {
        granted = { tokens, ...(pending.discovery ? { discovery: pending.discovery } : {}) };
      },
    });
    try {
      const result = await auth(provider, {
        serverUrl: definition.serverUrl,
        authorizationCode: reply.code,
        ...(reply.iss === null ? {} : { iss: reply.iss }),
        ...(this.#options.fetch === undefined ? {} : { fetchFn: this.#options.fetch }),
      });
      if (result !== "AUTHORIZED" || !granted) return "failed";
    } catch {
      return "failed";
    }
    await this.#saveGrant(definition.name, granted, "connect");
    return "connected";
  }

  async disconnect(name: string): Promise<boolean> {
    const { scope, store, seal } = this.#options;
    const refs = await store.remove({ ...scope, name });
    if (refs.length > 0) await seal.release({ ...scope, refs });
    return refs.length > 0;
  }

  async open(name: string): Promise<Client | undefined> {
    const resolved = await this.#resolve(name);
    if (!resolved) return undefined;
    const { definition } = resolved;
    const { scope, store, seal } = this.#options;
    const record = await store.read({ ...scope, name });
    if (!record || record.status !== "connected") return undefined;
    const text = await seal.open({ ...scope, ref: record.tokensRef });
    if (text === undefined) return undefined;
    let grant = JSON.parse(text) as SavedGrant;
    const provider = this.#provider(definition, await this.#client(definition), {
      grant: () => grant,
      saveTokens: async (tokens) => {
        grant = { ...grant, tokens };
        await this.#saveGrant(name, grant, "refresh");
      },
      onInvalid: async () => {
        await store.mark({ ...scope, name, status: "needs_reconnect", now: this.#options.now() });
      },
    });
    const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(definition.serverUrl), {
        authProvider: provider,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      }),
    );
    return client;
  }

  async tools(name: string): Promise<readonly AppTool[] | undefined> {
    const client = await this.open(name);
    if (!client) return undefined;
    try {
      const found: AppTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const listed = await client.listTools(cursor === undefined ? {} : { cursor });
        for (const tool of listed.tools)
          found.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
            readOnly: tool.annotations?.readOnlyHint === true,
          });
        cursor = listed.nextCursor;
        if (cursor === undefined) break;
      }
      return found.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    } finally {
      await client.close();
    }
  }

  async call(
    name: string,
    tool: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<AppToolResult | undefined> {
    const client = await this.open(name);
    if (!client) return undefined;
    try {
      const result = await client.callTool({ name: tool, arguments: { ...input } });
      return {
        content: Array.isArray(result.content) ? result.content : [],
        isError: result.isError === true,
      };
    } finally {
      await client.close();
    }
  }

  async #saveGrant(name: string, grant: SavedGrant, reason: "connect" | "refresh") {
    const { scope, store, seal, now } = this.#options;
    const at = now();
    const tokensRef = await seal.seal({ ...scope, text: JSON.stringify(grant), at });
    const before = await store.read({ ...scope, name });
    const released = await store.save({
      ...scope,
      name,
      tokensRef,
      status: "connected",
      connectedAt: reason === "refresh" && before ? before.connectedAt : at,
      now: at,
    });
    if (released.length > 0) await seal.release({ ...scope, refs: released });
  }

  async #resolve(name: string): Promise<ResolvedApp | undefined> {
    const configured = this.#definitions.get(name);
    if (configured) return { definition: configured, added: false };
    if (!name.startsWith(ADDED_NAME_PREFIX)) return undefined;
    const app = (await this.#options.store.listApps(this.#options.scope)).find(
      (entry) => entry.name === name,
    );
    return app ? { definition: this.#addedDefinition(app), added: true } : undefined;
  }

  #addedDefinition(app: {
    readonly name: string;
    readonly title: string;
    readonly serverUrl: string;
  }): AppConnectionDefinition {
    return {
      name: app.name,
      title: app.title,
      serverUrl: app.serverUrl,
      trustsReadOnlyLabels: false,
    };
  }

  async #client(definition: AppConnectionDefinition): Promise<ClientHolder> {
    if (definition.clientId !== undefined)
      return {
        fixed: true,
        information: typedClient(definition.clientId, definition.clientSecret),
      };
    const { scope, store, seal } = this.#options;
    const record = await store.readClient({ ...scope, name: definition.name });
    const text = record ? await seal.open({ ...scope, ref: record.clientRef }) : undefined;
    return text === undefined
      ? { fixed: false }
      : { fixed: false, information: JSON.parse(text) as StoredOAuthClientInformation };
  }

  async #saveClient(name: string, information: StoredOAuthClientInformation) {
    const { scope, store, seal, now } = this.#options;
    const at = now();
    const clientRef = await seal.seal({ ...scope, text: JSON.stringify(information), at });
    const released = await store.saveClient({ ...scope, name, clientRef, now: at });
    if (released.length > 0) await seal.release({ ...scope, refs: released });
  }

  async #probe(
    url: URL,
  ): Promise<
    | { readonly kind: "open"; readonly title?: string }
    | { readonly kind: "sign_in" }
    | { readonly kind: "unreachable" }
  > {
    const fetcher = this.#options.fetch ?? fetch;
    let status: number;
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
          },
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: "manual",
      });
      status = response.status;
      await response.body?.cancel();
    } catch {
      return { kind: "unreachable" };
    }
    if (status === 401) return { kind: "sign_in" };
    if (status < 200 || status >= 300) return { kind: "unreachable" };
    const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        }),
      );
      const info = client.getServerVersion();
      const title = info?.title ?? info?.name;
      return title === undefined ? { kind: "open" } : { kind: "open", title };
    } catch {
      return { kind: "unreachable" };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  #provider(
    definition: AppConnectionDefinition,
    client: ClientHolder,
    hooks: {
      readonly state?: string;
      readonly pending?: Pending;
      readonly grant?: () => SavedGrant;
      readonly redirect?: (url: URL) => void;
      readonly saveTokens?: (tokens: StoredOAuthTokens) => void | Promise<void>;
      readonly onInvalid?: () => Promise<void>;
    },
  ): OAuthClientProvider {
    const redirectUrl = this.callbackUrl;
    const clientMetadataUrl = this.clientMetadataUrl;
    const metadata: OAuthClientMetadata = {
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        client.information?.client_secret === undefined ? PUBLIC_CLIENT_AUTH : "client_secret_post",
    };
    const { pending } = hooks;
    const discovery = () => pending?.discovery ?? hooks.grant?.().discovery;
    const acceptsPublicClients = () => {
      const methods =
        discovery()?.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
      return Array.isArray(methods) && methods.includes(PUBLIC_CLIENT_AUTH);
    };
    return {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata() {
        return metadata;
      },
      get clientMetadataUrl(): string {
        return !client.fixed && acceptsPublicClients() ? clientMetadataUrl : "";
      },
      ...(hooks.state === undefined ? {} : { state: () => hooks.state as string }),
      clientInformation: () => client.information,
      saveClientInformation: async (information: OAuthClientInformationMixed) => {
        if (client.fixed) return;
        client.information = information as StoredOAuthClientInformation;
        await this.#saveClient(definition.name, client.information);
      },
      tokens: () => hooks.grant?.().tokens,
      saveTokens: async (tokens) => {
        await hooks.saveTokens?.(tokens);
      },
      redirectToAuthorization: (url) => {
        hooks.redirect?.(url);
      },
      saveCodeVerifier: (verifier) => {
        if (pending) pending.verifier = verifier;
      },
      codeVerifier: () => {
        if (!pending?.verifier) throw new Error("APP_CONNECTION_VERIFIER_MISSING");
        return pending.verifier;
      },
      saveDiscoveryState: (state) => {
        if (pending) pending.discovery = state;
      },
      discoveryState: discovery,
      invalidateCredentials: async (scope) => {
        if (scope === "all" || scope === "tokens") await hooks.onInvalid?.();
      },
    };
  }

  #issueState(pending: Omit<Pending, "expiresAt">): string {
    const now = Date.parse(this.#options.now());
    for (const [state, entry] of this.#states)
      if (entry.expiresAt <= now) this.#states.delete(state);
    while (this.#states.size >= MAX_PENDING_STATES) {
      const oldest = this.#states.keys().next().value;
      if (oldest === undefined) break;
      this.#states.delete(oldest);
    }
    const state = randomBytes(24).toString("base64url");
    this.#states.set(state, { ...pending, expiresAt: now + STATE_TTL_MS });
    return state;
  }
}

function shortTitle(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return [...trimmed].slice(0, TITLE_MAXIMUM).join("");
}

function isRegistrationUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(
      "Incompatible auth server: does not support dynamic client registration",
    )
  );
}

function typedClient(id: string, secret: string | undefined): StoredOAuthClientInformation {
  return { client_id: id, ...(secret === undefined ? {} : { client_secret: secret }) };
}
