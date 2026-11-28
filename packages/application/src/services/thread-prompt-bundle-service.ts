import type { ThreadId } from "@himawari-agent/domain";
import {
  EGRESS_RULESET_CURRENT,
  EGRESS_RULESET_FIRST_KEEPS_IDENTIFIERS,
} from "@himawari-agent/sensitive-capture";
import { sha256 as sha256Bytes } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DataClassification } from "../ports/common.js";
import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";
import type { RunPayloadArtifactPort } from "../ports/run-payload-artifacts.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type {
  RuntimePromptBundle,
  RuntimePromptBundlePort,
  RuntimePromptBundleResolveInput,
  ThreadPromptBundleIdentity,
  ThreadPromptBundleOrigin,
  ThreadPromptBundleRecord,
  ThreadPromptBundleScope,
  ThreadPromptBundleStorePort,
} from "../ports/thread-prompt-bundles.js";
import { canonicalAuthorizationSnapshot } from "./action-intent-snapshot.js";
import type { RecordTraceInput } from "./session-trace-recorder.js";

export const LEGACY_REDACTION_RULESET = 1;
export const MINIMUM_THREAD_RULESET = EGRESS_RULESET_FIRST_KEEPS_IDENTIFIERS;
function storedRuleset(record: ThreadPromptBundleRecord): number {
  const stored = record.identity.redactionRuleset;
  if (stored === undefined || !Number.isSafeInteger(stored) || stored < 1)
    return LEGACY_REDACTION_RULESET;
  return Math.min(stored, EGRESS_RULESET_CURRENT);
}

export const THREAD_PROMPT_BUNDLE_PIN_KEY = "thread-prompt-bundle-pin:v1";
export const PROMPT_BUNDLE_INVALIDATED_EVENT = "prompt.bundle.invalidated";

const CLASSIFICATION_RANK: Readonly<Record<DataClassification, number>> = {
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
};

const MAXIMUM_CREATE_ATTEMPTS = 3;

const SCHEMA_TEXT_KEYWORDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "examples",
  "$comment",
]);
const SCHEMA_VALUE_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default"]);
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

export interface ThreadPromptBundleServiceDependencies {
  readonly store: ThreadPromptBundleStorePort;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly artifacts: RunPayloadArtifactPort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly trace: (input: RecordTraceInput) => Promise<unknown>;
}

interface Pin {
  readonly version: "thread-prompt-bundle-pin.v1";
  readonly threadId: string;
  readonly generation: number;
}

function sha256(text: string): string {
  return bytesToHex(sha256Bytes(new TextEncoder().encode(text)));
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => right[index] === name);
}

export function promptBundleChange(
  record: ThreadPromptBundleRecord,
  identity: ThreadPromptBundleIdentity,
  classification: DataClassification,
): ThreadPromptBundleOrigin | undefined {
  if (record.supersededAt !== null) return "rebuild_requested";
  if (storedRuleset(record) < MINIMUM_THREAD_RULESET) return "rebuild_requested";
  if (CLASSIFICATION_RANK[classification] < CLASSIFICATION_RANK[record.dataClassification])
    return "classification_lower";
  if (!sameNames(record.identity.toolNames, identity.toolNames)) return "tool_set_changed";
  if (record.identity.modelRef !== identity.modelRef) return "model_changed";
  if (record.identity.thinkingLevel !== identity.thinkingLevel) return "thinking_level_changed";
  if (record.identity.answerLocale !== identity.answerLocale) return "answer_locale_changed";
  return undefined;
}

function parsedTools(
  tools: string,
): readonly { readonly name: string; readonly parameters: unknown }[] {
  const parsed = JSON.parse(tools) as unknown;
  if (!Array.isArray(parsed)) throw new TypeError("RUNTIME_PROMPT_BUNDLE_TOOLS_INVALID");
  return parsed.map((tool) => {
    const { name, parameters } = (tool ?? {}) as {
      readonly name?: unknown;
      readonly parameters?: unknown;
    };
    if (typeof name !== "string" || name.length === 0)
      throw new TypeError("RUNTIME_PROMPT_BUNDLE_TOOLS_INVALID");
    return { name, parameters: parameters ?? null };
  });
}

export function frozenToolNames(tools: string): readonly string[] {
  return parsedTools(tools).map(({ name }) => name);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaStructure(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaStructure);
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).flatMap(([keyword, value]): [string, unknown][] => {
      if (SCHEMA_TEXT_KEYWORDS.has(keyword)) return [];
      if (SCHEMA_VALUE_KEYWORDS.has(keyword)) return [[keyword, value]];
      if (keyword === "required" && Array.isArray(value))
        return [[keyword, [...value].map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))]];
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isRecord(value))
        return [
          [
            keyword,
            Object.fromEntries(
              Object.entries(value).map(([name, nested]) => [name, schemaStructure(nested)]),
            ),
          ],
        ];
      return [[keyword, schemaStructure(value)]];
    }),
  );
}

function toolSchemas(tools: string): ReadonlyMap<string, string> {
  return new Map(
    parsedTools(tools).map(({ name, parameters }) => [
      name,
      canonicalAuthorizationSnapshot(schemaStructure(parameters)),
    ]),
  );
}

function toolSchemaChanged(frozenTools: string, currentTools: string): boolean {
  const current = toolSchemas(currentTools);
  return [...toolSchemas(frozenTools)].some(
    ([name, schema]) => current.has(name) && current.get(name) !== schema,
  );
}

export class ThreadPromptBundleService implements RuntimePromptBundlePort {
  readonly #dependencies: ThreadPromptBundleServiceDependencies;

  constructor(dependencies: ThreadPromptBundleServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async resolve(input: RuntimePromptBundleResolveInput): Promise<RuntimePromptBundle | undefined> {
    const { request } = input;
    if (request.threadId === null) return undefined;
    const scope: ThreadPromptBundleScope = {
      ownerId: request.ownerId,
      agentId: request.agentId,
      threadId: request.threadId,
    };
    const pin = await this.#readPin(input);
    if (pin) {
      if (pin.threadId !== request.threadId) throw new Error("RUNTIME_PROMPT_BUNDLE_PIN_INVALID");
      const pinned = await this.#dependencies.store.get({ ...scope, generation: pin.generation });
      if (!pinned) throw new Error("RUNTIME_PROMPT_BUNDLE_MISSING");
      const opened = await this.#open(pinned);
      if (!this.#toolsAvailable(opened, input.identity))
        throw new Error("RUNTIME_PROMPT_BUNDLE_TOOL_MISSING");
      return opened;
    }
    if (request.continuationRef !== undefined) return undefined;
    const opened = await this.#current(input, scope);
    await this.#writePin(input, opened.generation);
    return opened;
  }

  async #current(
    input: RuntimePromptBundleResolveInput,
    scope: ThreadPromptBundleScope,
  ): Promise<RuntimePromptBundle> {
    let latest = await this.#dependencies.store.latest(scope);
    for (let attempt = 0; attempt < MAXIMUM_CREATE_ATTEMPTS; attempt += 1) {
      let origin: ThreadPromptBundleOrigin | undefined = latest
        ? promptBundleChange(latest, input.identity, input.request.dataClassification)
        : input.hasHistory
          ? "rollout"
          : "new_thread";
      if (latest && origin === undefined) {
        const opened = await this.#open(latest);
        if (!this.#toolsAvailable(opened, input.identity)) origin = "tool_missing";
        else if (toolSchemaChanged(opened.tools, input.candidate.tools))
          origin = "tool_schema_changed";
        else return opened;
      }
      const result = await this.#create(input, scope, latest, origin as ThreadPromptBundleOrigin);
      if (result.created) {
        if (latest) await this.#traceInvalidated(input, latest, result.record);
        return this.#open(result.record);
      }
      latest = result.record;
    }
    throw new Error("RUNTIME_PROMPT_BUNDLE_CONTENDED");
  }

  #toolsAvailable(bundle: RuntimePromptBundle, identity: ThreadPromptBundleIdentity): boolean {
    const current = new Set(identity.toolNames);
    return frozenToolNames(bundle.tools).every((name) => current.has(name));
  }

  async #create(
    input: RuntimePromptBundleResolveInput,
    scope: ThreadPromptBundleScope,
    latest: ThreadPromptBundleRecord | undefined,
    origin: ThreadPromptBundleOrigin,
  ) {
    const { request, candidate } = input;
    const now = this.#dependencies.clock.now();
    const protect = (text: string, contentType: string, namespace: string) =>
      this.#dependencies.protector.protect({
        ownerId: request.ownerId,
        agentId: request.agentId,
        ref: this.#dependencies.ids.next(namespace),
        dataClassification: request.dataClassification,
        contentType,
        plaintext: new TextEncoder().encode(text),
        createdAt: now,
      });
    return this.#dependencies.store.create({
      ...scope,
      expectedLatestGeneration: latest?.generation ?? null,
      origin,
      identity: {
        ...input.identity,
        redactionRuleset: this.#rulesetFor(origin, latest, input),
      },
      systemPrompt: await protect(
        candidate.systemPrompt,
        "text/plain",
        "thread-prompt-bundle-system",
      ),
      tools: await protect(candidate.tools, "application/json", "thread-prompt-bundle-tools"),
      systemPromptSha256: sha256(candidate.systemPrompt),
      toolsSha256: sha256(candidate.tools),
      dataClassification: request.dataClassification,
      runId: request.runId,
      now,
    });
  }

  #rulesetFor(
    origin: ThreadPromptBundleOrigin,
    latest: ThreadPromptBundleRecord | undefined,
    input: RuntimePromptBundleResolveInput,
  ): number {
    if (
      origin === "classification_lower" &&
      latest &&
      sha256(input.candidate.systemPrompt) === latest.systemPromptSha256 &&
      sha256(input.candidate.tools) === latest.toolsSha256 &&
      latest.identity.modelRef === input.identity.modelRef &&
      latest.identity.thinkingLevel === input.identity.thinkingLevel &&
      latest.identity.answerLocale === input.identity.answerLocale
    )
      return storedRuleset(latest);
    return EGRESS_RULESET_CURRENT;
  }

  async #open(record: ThreadPromptBundleRecord): Promise<RuntimePromptBundle> {
    const systemPrompt = await this.#readText(record, record.systemPromptRef);
    const tools = await this.#readText(record, record.toolsRef);
    if (sha256(systemPrompt) !== record.systemPromptSha256 || sha256(tools) !== record.toolsSha256)
      throw new Error("RUNTIME_PROMPT_BUNDLE_FINGERPRINT_MISMATCH");
    return Object.freeze({
      generation: record.generation,
      systemPrompt,
      tools,
      redactionRuleset: storedRuleset(record),
    });
  }

  async #readText(record: ThreadPromptBundleRecord, ref: string): Promise<string> {
    const payload = await this.#dependencies.payloads.get(ref);
    if (!payload) throw new Error("RUNTIME_PROMPT_BUNDLE_PAYLOAD_MISSING");
    const plaintext = await this.#dependencies.protector.unprotect({
      ownerId: record.ownerId,
      agentId: record.agentId,
      payload,
    });
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  }

  async #readPin(input: RuntimePromptBundleResolveInput): Promise<Pin | undefined> {
    const artifact = await this.#dependencies.artifacts.lookup({
      runId: input.request.runId,
      purpose: "context",
      operationKey: THREAD_PROMPT_BUNDLE_PIN_KEY,
    });
    if (!artifact) return undefined;
    const payload = await this.#dependencies.payloads.get(artifact.payloadRef);
    if (!payload) throw new Error("RUNTIME_PROMPT_BUNDLE_PIN_MISSING");
    const pin = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await this.#dependencies.protector.unprotect({
          ownerId: input.request.ownerId,
          agentId: input.request.agentId,
          payload,
        }),
      ),
    ) as Pin;
    if (
      pin.version !== "thread-prompt-bundle-pin.v1" ||
      typeof pin.threadId !== "string" ||
      !Number.isSafeInteger(pin.generation) ||
      pin.generation < 1
    )
      throw new Error("RUNTIME_PROMPT_BUNDLE_PIN_INVALID");
    return pin;
  }

  async #writePin(input: RuntimePromptBundleResolveInput, generation: number): Promise<void> {
    const { request } = input;
    const pin: Pin = {
      version: "thread-prompt-bundle-pin.v1",
      threadId: request.threadId as ThreadId,
      generation,
    };
    await this.#dependencies.artifacts.commit({
      runId: request.runId,
      purpose: "context",
      operationKey: THREAD_PROMPT_BUNDLE_PIN_KEY,
      payload: await this.#dependencies.protector.protect({
        ownerId: request.ownerId,
        agentId: request.agentId,
        ref: this.#dependencies.ids.next("thread-prompt-bundle-pin"),
        dataClassification: request.dataClassification,
        contentType: "application/json",
        plaintext: new TextEncoder().encode(JSON.stringify(pin)),
        createdAt: this.#dependencies.clock.now(),
      }),
    });
  }

  async #traceInvalidated(
    input: RuntimePromptBundleResolveInput,
    previous: ThreadPromptBundleRecord,
    next: ThreadPromptBundleRecord,
  ): Promise<void> {
    const { request } = input;
    await this.#dependencies.trace({
      ownerId: request.ownerId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      threadId: request.threadId,
      runId: request.runId,
      turnId: null,
      parentEventId: null,
      causationId: null,
      correlationId: request.correlationId,
      actorId: "agent-service",
      dataClassification: request.dataClassification,
      eventType: PROMPT_BUNDLE_INVALIDATED_EVENT,
      payload: {
        reason: next.origin,
        previousGeneration: previous.generation,
        generation: next.generation,
        ...(next.origin === "rebuild_requested"
          ? { rebuildReason: previous.rebuildReason, rebuildOperator: previous.rebuildOperator }
          : {}),
      },
    });
  }
}
