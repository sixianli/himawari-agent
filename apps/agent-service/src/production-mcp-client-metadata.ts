import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

export const MCP_CLIENT_METADATA_MAXIMUM_BYTES = 5_120;
export const MCP_CLIENT_METADATA_TIMEOUT_MS = 5_000;
export const MCP_CLIENT_METADATA_CACHE_MINIMUM_MS = 5 * 60_000;
export const MCP_CLIENT_METADATA_CACHE_MAXIMUM_MS = 24 * 3_600_000;
export const MCP_CLIENT_METADATA_CACHE_DEFAULT_MS = 3_600_000;
export const MCP_CLIENT_METADATA_CACHE_ENTRIES = 100;

export interface McpClientMetadata {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
}

export type McpClientMetadataResult =
  | { readonly status: "ok"; readonly metadata: McpClientMetadata }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface McpClientMetadataDocuments {
  readonly read: (clientId: string) => Promise<McpClientMetadataResult>;
}

export interface McpClientMetadataFetch {
  readonly fetch: (url: URL) => Promise<
    | {
        readonly status: number;
        readonly cacheControl: string | null;
        readonly body: string;
      }
    | { readonly failure: string }
  >;
}

const SPECIAL_USE = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  SPECIAL_USE.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  SPECIAL_USE.addSubnet(address, prefix, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !SPECIAL_USE.check(address, "ipv4");
  if (family === 6) return !SPECIAL_USE.check(address, "ipv6");
  return false;
}

export function metadataDocumentAddress(clientId: string): URL | null {
  if (!URL.canParse(clientId)) return null;
  const url = new URL(clientId);
  if (url.href !== clientId) return null;
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.hash !== "" || clientId.includes("#")) return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  if (url.pathname.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0) return null;
  return url;
}

export const nodeClientMetadataFetch: McpClientMetadataFetch = {
  fetch: (url) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value: Awaited<ReturnType<McpClientMetadataFetch["fetch"]>>) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const outgoing = request(
        url,
        {
          method: "GET",
          headers: { accept: "application/json", "user-agent": "Himawari-MCP-Authorization" },
          timeout: MCP_CLIENT_METADATA_TIMEOUT_MS,
          lookup: (hostname, _options, callback) => {
            lookup(hostname, { all: true, verbatim: true })
              .then((addresses) => {
                const chosen = addresses.find(({ address }) => publicAddress(address));
                if (!chosen || addresses.some(({ address }) => !publicAddress(address)))
                  callback(new Error("MCP_CLIENT_METADATA_ADDRESS_NOT_PUBLIC"), "", 4);
                else callback(null, chosen.address, chosen.family);
              })
              .catch((error: unknown) => callback(error as Error, "", 4));
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MCP_CLIENT_METADATA_MAXIMUM_BYTES) {
              outgoing.destroy();
              finish({ failure: "MCP_CLIENT_METADATA_TOO_LARGE" });
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            const cacheControl = response.headers["cache-control"];
            finish({
              status: response.statusCode ?? 0,
              cacheControl: typeof cacheControl === "string" ? cacheControl : null,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          response.on("error", () => finish({ failure: "MCP_CLIENT_METADATA_READ_FAILED" }));
        },
      );
      outgoing.on("timeout", () => {
        outgoing.destroy();
        finish({ failure: "MCP_CLIENT_METADATA_TIMEOUT" });
      });
      outgoing.on("error", (error) =>
        finish({
          failure:
            error.message === "MCP_CLIENT_METADATA_ADDRESS_NOT_PUBLIC"
              ? error.message
              : "MCP_CLIENT_METADATA_UNREACHABLE",
        }),
      );
      outgoing.end();
    }),
};

export function cacheLifetimeMs(cacheControl: string | null): number {
  const directives = (cacheControl ?? "")
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim());
  if (directives.some((entry) => entry === "no-store" || entry === "no-cache"))
    return MCP_CLIENT_METADATA_CACHE_MINIMUM_MS;
  const maxAge = directives
    .map((entry) => /^max-age=(\d{1,10})$/u.exec(entry)?.[1])
    .find((value) => value !== undefined);
  const wanted =
    maxAge === undefined ? MCP_CLIENT_METADATA_CACHE_DEFAULT_MS : Number(maxAge) * 1_000;
  return Math.min(
    MCP_CLIENT_METADATA_CACHE_MAXIMUM_MS,
    Math.max(MCP_CLIENT_METADATA_CACHE_MINIMUM_MS, wanted),
  );
}

const SHARED_SECRET_METHODS = new Set([
  "client_secret_basic",
  "client_secret_post",
  "client_secret_jwt",
]);

export function parseClientMetadataDocument(
  clientId: string,
  body: string,
  acceptRedirect: (uri: string) => boolean,
): McpClientMetadataResult {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return { status: "invalid", reason: "MCP_CLIENT_METADATA_NOT_JSON" };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document))
    return { status: "invalid", reason: "MCP_CLIENT_METADATA_NOT_OBJECT" };
  const fields = document as Record<string, unknown>;
  if (fields["client_id"] !== clientId)
    return { status: "invalid", reason: "MCP_CLIENT_METADATA_CLIENT_ID_MISMATCH" };
  if ("client_secret" in fields || "client_secret_expires_at" in fields)
    return { status: "invalid", reason: "MCP_CLIENT_METADATA_SHARED_SECRET" };
  const method = fields["token_endpoint_auth_method"];
  if (method !== undefined && method !== "none")
    return {
      status: "invalid",
      reason:
        typeof method === "string" && SHARED_SECRET_METHODS.has(method)
          ? "MCP_CLIENT_METADATA_SHARED_SECRET"
          : "MCP_CLIENT_METADATA_AUTH_METHOD_UNSUPPORTED",
    };
  const grantTypes = fields["grant_types"];
  if (
    grantTypes !== undefined &&
    (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code"))
  )
    return { status: "invalid", reason: "MCP_CLIENT_METADATA_GRANT_TYPES" };
  const responseTypes = fields["response_types"];
  if (
    responseTypes !== undefined &&
    (!Array.isArray(responseTypes) || !responseTypes.includes("code"))
  )
    return { status: "invalid", reason: "MCP_CLIENT_METADATA_RESPONSE_TYPES" };
  const name = fields["client_name"];
  if (typeof name !== "string" || name.trim().length === 0)
    return { status: "invalid", reason: "MCP_CLIENT_METADATA_NAME" };
  const redirects = fields["redirect_uris"];
  if (
    !Array.isArray(redirects) ||
    redirects.length === 0 ||
    !redirects.every((uri) => typeof uri === "string" && acceptRedirect(uri))
  )
    return { status: "invalid", reason: "MCP_CLIENT_METADATA_REDIRECT_URIS" };
  return {
    status: "ok",
    metadata: { clientId, clientName: name.trim(), redirectUris: redirects as string[] },
  };
}

export class McpClientMetadataCache implements McpClientMetadataDocuments {
  readonly #fetch: McpClientMetadataFetch;
  readonly #now: () => number;
  readonly #ownOrigin: string;
  readonly #acceptRedirect: (uri: string) => boolean;
  readonly #cache = new Map<
    string,
    { readonly metadata: McpClientMetadata; readonly until: number }
  >();

  constructor(options: {
    readonly fetch: McpClientMetadataFetch;
    readonly now: () => number;
    readonly ownOrigin: string;
    readonly acceptRedirect: (uri: string) => boolean;
  }) {
    this.#fetch = options.fetch;
    this.#now = options.now;
    this.#ownOrigin = options.ownOrigin;
    this.#acceptRedirect = options.acceptRedirect;
  }

  async read(clientId: string): Promise<McpClientMetadataResult> {
    const url = metadataDocumentAddress(clientId);
    if (!url) return { status: "invalid", reason: "MCP_CLIENT_METADATA_ADDRESS_INVALID" };
    if (url.origin === this.#ownOrigin)
      return { status: "invalid", reason: "MCP_CLIENT_METADATA_OWN_ORIGIN" };
    const cached = this.#cache.get(clientId);
    if (cached && cached.until > this.#now()) return { status: "ok", metadata: cached.metadata };
    this.#cache.delete(clientId);
    const fetched = await this.#fetch.fetch(url);
    if ("failure" in fetched) return { status: "unavailable", reason: fetched.failure };
    if (fetched.status !== 200)
      return fetched.status >= 500
        ? { status: "unavailable", reason: "MCP_CLIENT_METADATA_SERVER_ERROR" }
        : { status: "invalid", reason: "MCP_CLIENT_METADATA_STATUS" };
    const parsed = parseClientMetadataDocument(clientId, fetched.body, this.#acceptRedirect);
    if (parsed.status !== "ok") return parsed;
    while (this.#cache.size >= MCP_CLIENT_METADATA_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    this.#cache.set(clientId, {
      metadata: parsed.metadata,
      until: this.#now() + cacheLifetimeMs(fetched.cacheControl),
    });
    return parsed;
  }
}
