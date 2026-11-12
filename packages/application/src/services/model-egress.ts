import type { AgentId, OwnerId, ThreadId } from "@himawari-agent/domain";
import { TRUSTED_PROMPT_TEXTS } from "@himawari-agent/prompt-catalog";
import {
  assertMachineSecretFree,
  EGRESS_PLACEHOLDER_PATTERN,
  type EgressPlaceholderKind,
  EgressRedactionError,
  type EgressRedactionFinding,
  type EgressRedactionKind,
  type EgressRedactionRuleId,
  type EgressRedactionSighting,
  redactForEgress,
  redactMachineSecrets,
  scanMachineSecrets,
} from "@himawari-agent/sensitive-capture";
import type {
  SensitiveInterceptionPart,
  SensitiveInterceptionSource,
} from "../ports/sensitive-interceptions.js";

export class ModelEgressRefusedError extends Error {
  readonly code = "MODEL_EGRESS_REFUSED" as const;
  readonly reason: string;
  constructor(reason: string) {
    super(`Model request was not sent: ${reason}`);
    this.name = "ModelEgressRefusedError";
    this.reason = reason;
  }
}

export interface ModelEgressContext {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId | null;
  readonly source: SensitiveInterceptionSource;
  readonly purpose: string | null;
  readonly redactionRuleset?: number;
}

export interface ModelEgressSighting {
  readonly part: SensitiveInterceptionPart;
  readonly category: EgressRedactionKind;
  readonly ruleId: EgressRedactionRuleId;
  readonly fingerprint: string;
  readonly outcome?: "withheld";
}

export interface ModelEgressOptions {
  readonly key: () => Promise<Uint8Array>;
  readonly sign: (key: Uint8Array, message: string) => Uint8Array;
  readonly trusted?: readonly string[];
  readonly report?: (
    context: ModelEgressContext,
    sightings: readonly ModelEgressSighting[],
  ) => void;
}

const FINGERPRINT_LABEL = "himawari.sensitive-interception.fingerprint.v1";

function hex(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < 16; index += 1)
    out += (bytes[index] ?? 0).toString(16).padStart(2, "0");
  return out;
}

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(reason: string): never {
  throw new ModelEgressRefusedError(reason);
}

export interface ModelEgressExchange {
  wrapFetch<F extends (input: never, init?: never) => Promise<unknown>>(base: F): F;
  restore(text: string): string;
  streamingRestorer(): StreamingPlaceholderRestorer;
  readonly table: ReadonlyMap<string, string>;
  readonly findings: () => readonly EgressRedactionFinding[];
}

export class StreamingPlaceholderRestorer {
  #pending = "";
  readonly #restore: (text: string) => string;
  constructor(restore: (text: string) => string) {
    this.#restore = restore;
  }

  append(chunk: string): string {
    this.#pending += chunk;
    const open = this.#pending.lastIndexOf("[");
    const close = this.#pending.lastIndexOf("]");
    if (open === -1 || close > open || this.#pending.length - open > 48) {
      const safe = this.#pending;
      this.#pending = "";
      return this.#restore(safe);
    }
    const safe = this.#pending.slice(0, open);
    this.#pending = this.#pending.slice(open);
    return this.#restore(safe);
  }

  flush(): string {
    const safe = this.#pending;
    this.#pending = "";
    return this.#restore(safe);
  }
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function letters(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < 8; index += 1) out += LETTERS[(bytes[index] ?? 0) % 26];
  return out;
}

function placeholderTag(
  options: ModelEgressOptions,
  key: Uint8Array,
): (kind: EgressPlaceholderKind, value: string) => string {
  return (kind, value) => letters(options.sign(key, `${kind}\u0000${value}`));
}

class Exchange implements ModelEgressExchange {
  readonly table = new Map<string, string>();
  readonly #known = new Map<string, string>();
  readonly #counts = new Map<string, number>();
  #lastRequest:
    | {
        readonly href: string;
        readonly method: string;
        readonly body: string;
        readonly redacted: string | undefined;
        readonly refusal: ModelEgressRefusedError | undefined;
      }
    | undefined;
  readonly #options: ModelEgressOptions;
  readonly #context: ModelEgressContext | undefined;

  constructor(options: ModelEgressOptions, context: ModelEgressContext | undefined) {
    this.#options = options;
    this.#context = context;
  }

  #report(sightings: ReadonlyMap<string, ModelEgressSighting>): void {
    const report = this.#options.report;
    if (report === undefined || this.#context === undefined || sightings.size === 0) return;
    try {
      report(this.#context, Object.freeze([...sightings.values()]));
    } catch {
      return;
    }
  }

  findings(): readonly EgressRedactionFinding[] {
    return [...this.#counts].map(([kind, count]) =>
      Object.freeze({ kind: kind as EgressRedactionFinding["kind"], count }),
    );
  }

  restore(text: string): string {
    if (this.table.size === 0 || !text.includes("#")) return text;
    return text.replace(EGRESS_PLACEHOLDER_PATTERN, (match) => this.table.get(match) ?? match);
  }

  streamingRestorer(): StreamingPlaceholderRestorer {
    return new StreamingPlaceholderRestorer((text) => this.restore(text));
  }

  wrapFetch<F extends (input: never, init?: never) => Promise<unknown>>(base: F): F {
    const wrapped = async (input: unknown, init?: unknown): Promise<unknown> => {
      const prepared = await this.#prepare(input, init);
      return (base as unknown as (input: unknown, init?: unknown) => Promise<unknown>)(
        prepared.input,
        prepared.init,
      );
    };
    return wrapped as unknown as F;
  }

  async #prepare(
    input: unknown,
    init: unknown,
  ): Promise<{ readonly input: unknown; readonly init: unknown }> {
    const options = isRecord(init) ? init : {};
    const href = typeof input === "string" ? input : urlOf(input);
    if (href === undefined) refuse("request target is not a URL");
    if (hasBodyInRequest(input)) refuse("request object carries its own body");
    const method = String(options["method"] ?? methodOf(input) ?? "GET").toUpperCase();
    const body = options["body"];
    const last = this.#lastRequest;
    if (
      last !== undefined &&
      typeof body === "string" &&
      last.href === href &&
      last.method === method &&
      last.body === body
    ) {
      if (last.refusal !== undefined) throw last.refusal;
      if (last.redacted === undefined) return { input, init };
      return {
        input,
        init: { ...options, body: last.redacted, headers: withoutLength(options["headers"]) },
      };
    }
    try {
      const prepared = await this.#prepareFresh(input, init);
      if (typeof body === "string") {
        const preparedBody = isRecord(prepared.init) ? prepared.init["body"] : undefined;
        this.#lastRequest = {
          href,
          method,
          body,
          redacted:
            prepared.init !== init && typeof preparedBody === "string" ? preparedBody : undefined,
          refusal: undefined,
        };
      }
      return prepared;
    } catch (error) {
      if (
        error instanceof ModelEgressRefusedError &&
        href !== undefined &&
        typeof body === "string"
      )
        this.#lastRequest = { href, method, body, redacted: undefined, refusal: error };
      throw error;
    }
  }

  async #prepareFresh(
    input: unknown,
    init: unknown,
  ): Promise<{ readonly input: unknown; readonly init: unknown }> {
    const href = typeof input === "string" ? input : urlOf(input);
    if (href === undefined) refuse("request target is not a URL");
    if (hasBodyInRequest(input)) refuse("request object carries its own body");
    const options = isRecord(init) ? init : {};
    const method = String(options["method"] ?? methodOf(input) ?? "GET").toUpperCase();
    const body = options["body"];
    if (body === undefined || body === null) {
      if (method === "GET" || method === "HEAD") return { input, init };
      refuse("request has no readable body");
    }
    if (typeof body !== "string") refuse("request body is not text");
    const path = pathOf(href);
    const redactor = this.#redactorFor(path);
    if (redactor === undefined) refuse(`unsupported request path ${path}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      refuse("request body is not JSON");
    }
    const key = await this.#options.key();
    const sightings = new Map<string, ModelEgressSighting>();
    const recording = this.#options.report !== undefined && this.#context !== undefined;
    const sighting = (
      part: SensitiveInterceptionPart,
      { kind, ruleId, value: seen }: EgressRedactionSighting,
    ): readonly [string, ModelEgressSighting] => {
      const fingerprint = hex(
        this.#options.sign(key, `${FINGERPRINT_LABEL}\u0000${kind}\u0000${seen}`),
      );
      return [
        `${part}\u0000${kind}\u0000${fingerprint}`,
        Object.freeze({ part, category: kind, ruleId, fingerprint }),
      ];
    };
    const see = (part: SensitiveInterceptionPart, seen: EgressRedactionSighting): void => {
      if (!recording) return;
      const [identity, value] = sighting(part, seen);
      if (!sightings.has(identity)) sightings.set(identity, value);
    };
    const text = (value: string, part: SensitiveInterceptionPart): string => {
      const result = redactedOrRefused(value, {
        tag: placeholderTag(this.#options, key),
        known: this.#known,
        table: this.table,
        trusted: this.#options.trusted ?? TRUSTED_PROMPT_TEXTS,
        ...(this.#context?.redactionRuleset === undefined
          ? {}
          : { ruleset: this.#context.redactionRuleset }),
        ...(recording ? { observe: (seen: EgressRedactionSighting) => see(part, seen) } : {}),
      });
      for (const finding of result.findings)
        this.#counts.set(finding.kind, (this.#counts.get(finding.kind) ?? 0) + finding.count);
      try {
        assertMachineSecretFree(result.text);
      } catch {
        if (recording) {
          const withheld = new Map<string, ModelEgressSighting>();
          const hold = ([identity, value]: readonly [string, ModelEgressSighting]) =>
            withheld.set(identity, Object.freeze({ ...value, outcome: "withheld" }));
          for (const entry of sightings) hold(entry);
          redactMachineSecrets(result.text, (ruleId, seen) =>
            hold(sighting(part, { kind: "machine-secret", ruleId, value: seen })),
          );
          this.#report(withheld);
        }
        refuse("sensitive material remained after redaction");
      }
      return result.text;
    };
    const next = redactor(parsed, text);
    this.#report(sightings);
    if (next === parsed) return { input, init };
    return {
      input,
      init: {
        ...options,
        body: JSON.stringify(next),
        headers: withoutLength(options["headers"]),
      },
    };
  }

  #redactorFor(path: string): ((body: unknown, text: TextRedactor) => unknown) | undefined {
    if (path.endsWith("/chat/completions")) return redactChatCompletions;
    if (path.endsWith("/responses")) return redactResponses;
    if (path.endsWith("/messages")) return redactAnthropicMessages;
    if (path.endsWith("/embeddings")) return redactEmbeddings;
    return undefined;
  }
}

function urlOf(input: unknown): string | undefined {
  if (isRecord(input) && typeof input["href"] === "string") return input["href"];
  if (isRecord(input) && typeof input["url"] === "string") return input["url"];
  return undefined;
}

function methodOf(input: unknown): string | undefined {
  return isRecord(input) && typeof input["method"] === "string" ? input["method"] : undefined;
}

function hasBodyInRequest(input: unknown): boolean {
  return (
    isRecord(input) && "body" in input && input["body"] !== null && input["body"] !== undefined
  );
}

function pathOf(href: string): string {
  const withoutQuery = href.split("?")[0] ?? href;
  const afterScheme = withoutQuery.replace(/^[a-z]+:\/\/[^/]*/iu, "");
  return afterScheme.replace(/\/+$/u, "");
}

function withoutLength(headers: unknown): unknown {
  if (headers === undefined || headers === null) return headers;
  if (Array.isArray(headers))
    return headers.filter(
      (entry) => !(Array.isArray(entry) && String(entry[0]).toLowerCase() === "content-length"),
    );
  if (isRecord(headers) && typeof headers["delete"] === "function") {
    const clone = new (headers.constructor as new (init: unknown) => Record_)(headers);
    (clone["delete"] as (name: string) => void).call(clone, "content-length");
    return clone;
  }
  if (isRecord(headers)) {
    const next: Record_ = {};
    for (const [name, value] of Object.entries(headers))
      if (name.toLowerCase() !== "content-length") next[name] = value;
    return next;
  }
  return headers;
}

type TextRedactor = (value: string, part: SensitiveInterceptionPart) => string;

function partOf(record: Record_, inherited: SensitiveInterceptionPart): SensitiveInterceptionPart {
  const type = record["type"];
  if (typeof type === "string") {
    if (type.endsWith("tool_use") || type.endsWith("function_call") || type.endsWith("tool_call"))
      return "tool_call";
    if (type.endsWith("tool_result") || type.endsWith("_output")) return "tool_result";
  }
  switch (record["role"]) {
    case "system":
    case "developer":
      return "system";
    case "assistant":
      return "assistant_message";
    case "tool":
      return "tool_result";
    case "user":
      return "owner_message";
    default:
      return inherited;
  }
}

function mapArray(
  items: readonly unknown[],
  visit: (item: unknown) => unknown,
): readonly unknown[] {
  let changed = false;
  const next = items.map((item) => {
    const result = visit(item);
    if (result !== item) changed = true;
    return result;
  });
  return changed ? next : items;
}

function withField(record: Record_, field: string, value: unknown): Record_ {
  return value === record[field] ? record : { ...record, [field]: value };
}

const SKIPPED_KEYS = new Set([
  "id",
  "type",
  "role",
  "name",
  "model",
  "tool_call_id",
  "call_id",
  "tool_use_id",
  "item_id",
  "previous_response_id",
  "prompt_cache_key",
  "status",
  "object",
  "finish_reason",
  "stop_reason",
  "reasoning_effort",
  "effort",
  "service_tier",
]);

const OPAQUE_TYPES = new Set([
  "thinking",
  "redacted_thinking",
  "reasoning",
  "image_url",
  "image",
  "input_image",
  "input_audio",
  "audio",
  "file",
  "input_file",
  "document",
  "item_reference",
]);

const OPAQUE_MESSAGE_KEYS = new Set([
  "reasoning_content",
  "reasoning",
  "reasoning_details",
  "reasoning_text",
]);

const DEFINITION_KEYS = new Set(["tools", "functions", "tool_choice", "response_format"]);

function isIdentifierKey(key: string): boolean {
  return key.endsWith("_id") || key.endsWith("_ids") || key.endsWith("Id") || key.endsWith("Ids");
}

function maskArguments(
  value: unknown,
  text: TextRedactor,
  part: SensitiveInterceptionPart,
): unknown {
  if (typeof value !== "string") return maskTree(value, text, true, part);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return text(value, part);
  }
  const next = maskTree(parsed, text, true, part);
  return next === parsed ? value : JSON.stringify(next);
}

const BASE64_DATA_URL =
  /^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/\r\n]*={0,2}$/u;

function maskTree(
  value: unknown,
  text: TextRedactor,
  data: boolean,
  inherited: SensitiveInterceptionPart,
): unknown {
  if (typeof value === "string") {
    if (BASE64_DATA_URL.test(value) && scanMachineSecrets(value).length === 0) return value;
    const result = text(value, inherited);
    return result === value ? value : result;
  }
  if (Array.isArray(value)) return mapArray(value, (item) => maskTree(item, text, data, inherited));
  if (!isRecord(value)) return value;
  if (!data && typeof value["type"] === "string" && OPAQUE_TYPES.has(value["type"])) return value;
  const part = data ? inherited : partOf(value, inherited);
  let changed = false;
  const next: Record_ = {};
  for (const [key, item] of Object.entries(value)) {
    let result: unknown;
    if (data) {
      result = maskTree(item, text, true, part);
    } else if (typeof item === "string" && (SKIPPED_KEYS.has(key) || isIdentifierKey(key))) {
      result = item;
    } else if (OPAQUE_MESSAGE_KEYS.has(key)) {
      result = item;
    } else if (key === "arguments") {
      result = maskArguments(item, text, part === "tool_result" ? part : "tool_call");
    } else if (
      key === "input" &&
      typeof value["type"] === "string" &&
      value["type"].endsWith("tool_use")
    ) {
      result = maskTree(item, text, true, part);
    } else if (key === "tool_calls") {
      result = maskTree(item, text, false, "tool_call");
    } else {
      result = maskTree(item, text, false, part);
    }
    if (result !== item) changed = true;
    next[key] = result;
  }
  return changed ? next : value;
}

function maskRequest(body: unknown, text: TextRedactor, conversation: string): unknown {
  if (!isRecord(body)) refuse("request has an unknown shape");
  const conversational = body[conversation];
  if (typeof conversational !== "string" && !Array.isArray(conversational))
    refuse(`request has no ${conversation}`);
  let changed = false;
  const next: Record_ = {};
  for (const [key, item] of Object.entries(body)) {
    const result =
      DEFINITION_KEYS.has(key) || SKIPPED_KEYS.has(key)
        ? item
        : maskTree(item, text, false, key === conversation ? "owner_message" : "system");
    if (result !== item) changed = true;
    next[key] = result;
  }
  return changed ? next : body;
}

const redactChatCompletions = (body: unknown, text: TextRedactor): unknown =>
  maskRequest(body, text, "messages");
const redactResponses = (body: unknown, text: TextRedactor): unknown =>
  maskRequest(body, text, "input");
const redactAnthropicMessages = (body: unknown, text: TextRedactor): unknown =>
  maskRequest(body, text, "messages");

function redactEmbeddings(body: unknown, text: TextRedactor): unknown {
  if (!isRecord(body)) refuse("embeddings request has an unknown shape");
  const input = body["input"];
  if (typeof input === "string") return withField(body, "input", text(input, "embedding_input"));
  if (Array.isArray(input) && input.every((item) => typeof item === "string"))
    return withField(
      body,
      "input",
      mapArray(input, (item) => text(item as string, "embedding_input")),
    );
  return refuse("embeddings input is not text");
}

function redactedOrRefused(
  value: string,
  options: Parameters<typeof redactForEgress>[1],
): ReturnType<typeof redactForEgress> {
  try {
    return redactForEgress(value, options);
  } catch (error) {
    if (error instanceof EgressRedactionError) refuse("trusted text could not be restored");
    throw error;
  }
}

export class ModelEgress {
  readonly #options: ModelEgressOptions;

  constructor(options: ModelEgressOptions) {
    this.#options = options;
  }

  exchange(context?: ModelEgressContext): ModelEgressExchange {
    return new Exchange(this.#options, context);
  }

  async externalTag(): Promise<(kind: EgressPlaceholderKind, value: string) => string> {
    return placeholderTag(this.#options, await this.#options.key());
  }

  async reportMasked(
    context: ModelEgressContext,
    part: SensitiveInterceptionPart,
    sightings: readonly EgressRedactionSighting[],
  ): Promise<void> {
    const report = this.#options.report;
    if (report === undefined || sightings.length === 0) return;
    try {
      const key = await this.#options.key();
      const unique = new Map<string, ModelEgressSighting>();
      for (const { kind, ruleId, value } of sightings) {
        const fingerprint = hex(
          this.#options.sign(key, `${FINGERPRINT_LABEL}\u0000${kind}\u0000${value}`),
        );
        if (!unique.has(`${kind}\u0000${fingerprint}`))
          unique.set(
            `${kind}\u0000${fingerprint}`,
            Object.freeze({ part, category: kind, ruleId, fingerprint }),
          );
      }
      report(context, Object.freeze([...unique.values()]));
    } catch {
      return;
    }
  }
}
