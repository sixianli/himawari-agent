import { randomBytes } from "node:crypto";
import type { AppConnectionScope, AppConnectionStorePort } from "@himawari-agent/application";
import {
  auth,
  Client,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { DeviceConnection, DeviceConnectionAuthorizationStart } from "./device-api-routes.js";

export const APP_CONNECTIONS_CALLBACK_PATH = "/api/connections/v1/callback";
export const APP_CONNECTION_CALLBACK_HOST = "connection-authorization";

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 20;
const CLIENT_NAME = "Himawari";

export interface AppConnectionDefinition {
  readonly name: string;
  readonly title: string;
  readonly serverUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly trustsReadOnlyLabels: boolean;
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
  readonly tokens: StoredOAuthTokens;
  readonly discovery?: OAuthDiscoveryState;
}

export interface ProductionAppConnectionsOptions {
  readonly scope: AppConnectionScope;
  readonly store: AppConnectionStorePort;
  readonly seal: AppConnectionSealPort;
  readonly definitions: readonly AppConnectionDefinition[];
  readonly publicOrigin: string;
  readonly now: () => string;
  readonly fetch?: FetchLike;
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

  definition(name: string): AppConnectionDefinition | undefined {
    return this.#definitions.get(name);
  }

  async list(): Promise<readonly DeviceConnection[]> {
    const { scope, store } = this.#options;
    const saved = new Map((await store.list(scope)).map((record) => [record.name, record]));
    return this.#options.definitions.map((definition) => {
      const record = saved.get(definition.name);
      return {
        name: definition.name,
        title: definition.title,
        status: record?.status ?? "disconnected",
        account: null,
        connectedAt: record?.connectedAt ?? null,
      };
    });
  }

  async begin(input: {
    readonly deviceId: string;
    readonly connection: string;
    readonly callbackScheme: string;
  }): Promise<DeviceConnectionAuthorizationStart | undefined> {
    const definition = this.#definitions.get(input.connection);
    if (!definition) return undefined;
    const state = this.#issueState({
      name: definition.name,
      deviceId: input.deviceId,
      callbackScheme: input.callbackScheme,
    });
    const pending = this.#states.get(state);
    if (!pending) return undefined;
    let authorizationUrl: URL | undefined;
    const provider = this.#provider(definition, {
      state,
      pending,
      redirect: (url) => {
        authorizationUrl = url;
      },
    });
    const result = await auth(provider, {
      serverUrl: definition.serverUrl,
      ...(this.#options.fetch === undefined ? {} : { fetchFn: this.#options.fetch }),
    });
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
    const definition = this.#definitions.get(pending.name);
    if (!definition) return "failed";
    let granted: SavedGrant | undefined;
    const provider = this.#provider(definition, {
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
    const definition = this.#definitions.get(name);
    if (!definition) return undefined;
    const { scope, store, seal } = this.#options;
    const record = await store.read({ ...scope, name });
    if (!record || record.status !== "connected") return undefined;
    const text = await seal.open({ ...scope, ref: record.tokensRef });
    if (text === undefined) return undefined;
    let grant = JSON.parse(text) as SavedGrant;
    const provider = this.#provider(definition, {
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

  #provider(
    definition: AppConnectionDefinition,
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
    const metadata: OAuthClientMetadata = {
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        definition.clientSecret === undefined ? "none" : "client_secret_post",
    };
    const secret = definition.clientSecret;
    const information: StoredOAuthClientInformation = {
      client_id: definition.clientId,
      ...(secret === undefined ? {} : { client_secret: secret }),
    };
    const { pending } = hooks;
    return {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata() {
        return metadata;
      },
      ...(hooks.state === undefined ? {} : { state: () => hooks.state as string }),
      clientInformation: () => information,
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
      discoveryState: () => pending?.discovery ?? hooks.grant?.().discovery,
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
