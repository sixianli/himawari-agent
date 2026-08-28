import { createHmac } from "node:crypto";
import type { GatewayAuthenticationContext } from "@himawari-agent/application";
import type {
  HttpGatewayPayloadAdmissionPort,
  HttpGatewayThreadSearchPort,
} from "./http-gateway-server.js";

const SEARCH_TOKEN_CONTEXT = "himawari.thread-search.token.v1";
const SEARCH_QUERY_CONTEXT = "himawari.thread-search.query.v1";
const MAXIMUM_QUERY_CHARACTERS = 2_048;
const MAXIMUM_TOKENS = 64;

export interface ThreadSearchKeyPort {
  resolve(input: { readonly ownerId: string; readonly agentId: string }): Promise<Uint8Array>;
}

export interface ScopedThreadSearchTokenizerOptions {
  readonly keys: ThreadSearchKeyPort;
  readonly projectionVersion: string;
}

function canonicalTokens(text: string): readonly string[] {
  const normalized = text.normalize("NFKC").toLowerCase().trim();
  if (!normalized || normalized.length > MAXIMUM_QUERY_CHARACTERS) {
    throw new Error("THREAD_SEARCH_QUERY_INVALID");
  }
  const candidates: string[] = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const segment = match[0];
    candidates.push(segment);
    const characters = [...segment];
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(segment)) {
      for (let index = 0; index < characters.length - 1; index += 1) {
        candidates.push(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  const unique = [...new Set(candidates)].slice(0, MAXIMUM_TOKENS);
  if (unique.length === 0) throw new Error("THREAD_SEARCH_QUERY_INVALID");
  return Object.freeze(unique);
}

function scopedDigest(
  key: Uint8Array,
  context: string,
  ownerId: string,
  agentId: string,
  projectionVersion: string,
  value: string,
): string {
  if (key.byteLength < 32) throw new Error("THREAD_SEARCH_KEY_INVALID");
  return createHmac("sha256", key)
    .update(context)
    .update("\0")
    .update(ownerId)
    .update("\0")
    .update(agentId)
    .update("\0")
    .update(projectionVersion)
    .update("\0")
    .update(value)
    .digest("hex");
}

export class ScopedThreadSearchTokenizer {
  readonly #options: ScopedThreadSearchTokenizerOptions;

  constructor(options: ScopedThreadSearchTokenizerOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.projectionVersion)) {
      throw new Error("THREAD_SEARCH_PROJECTION_VERSION_INVALID");
    }
    this.#options = options;
  }

  get projectionVersion(): string {
    return this.#options.projectionVersion;
  }

  async tokenize(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly text: string;
  }): Promise<readonly string[]> {
    const key = await this.#options.keys.resolve(input);
    return Object.freeze(
      canonicalTokens(input.text).map(
        (token) =>
          `search-token:${scopedDigest(
            key,
            SEARCH_TOKEN_CONTEXT,
            input.ownerId,
            input.agentId,
            this.#options.projectionVersion,
            token,
          )}`,
      ),
    );
  }

  async queryIdempotencyKey(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly text: string;
  }): Promise<string> {
    const normalized = input.text.normalize("NFKC").trim();
    canonicalTokens(normalized);
    const key = await this.#options.keys.resolve(input);
    return `thread-search-query:${scopedDigest(
      key,
      SEARCH_QUERY_CONTEXT,
      input.ownerId,
      input.agentId,
      this.#options.projectionVersion,
      normalized,
    )}`;
  }
}

export interface BrowserThreadSearchPreparerOptions {
  readonly tokenizer: ScopedThreadSearchTokenizer;
  readonly payloadAdmission: HttpGatewayPayloadAdmissionPort;
}

export class BrowserThreadSearchPreparer implements HttpGatewayThreadSearchPort {
  readonly #options: BrowserThreadSearchPreparerOptions;

  constructor(options: BrowserThreadSearchPreparerOptions) {
    this.#options = options;
  }

  async prepare(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly agentId: string;
    readonly query: string;
  }): Promise<{
    readonly queryRef: string;
    readonly tokenRefs: readonly string[];
    readonly projectionVersion: string;
  }> {
    const scope = {
      ownerId: input.authentication.ownerId,
      agentId: input.agentId,
      text: input.query,
    };
    const [tokenRefs, idempotencyKey] = await Promise.all([
      this.#options.tokenizer.tokenize(scope),
      this.#options.tokenizer.queryIdempotencyKey(scope),
    ]);
    const protectedQuery = await this.#options.payloadAdmission.protect({
      authentication: input.authentication,
      idempotencyKey,
      content: input.query.normalize("NFKC").trim(),
      dataClassification: "private",
      contentType: "text/plain",
    });
    return Object.freeze({
      queryRef: protectedQuery.payloadRef,
      tokenRefs,
      projectionVersion: this.#options.tokenizer.projectionVersion,
    });
  }
}
