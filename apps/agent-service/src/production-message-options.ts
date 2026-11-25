import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type AuthorityFence,
  type ClockPort,
  type GatewayAuthenticationContext,
  type IdempotentAgentCommand,
  type JsonObject,
  type PayloadProtectorPort,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type RuntimeToolDescriptor,
  type RuntimeToolInvocation,
  type ThreadCommandService,
  type ThreadRepositoryPort,
  type ToolActionRegistry,
  type ToolActionRow,
} from "@himawari-agent/application";
import {
  MESSAGE_OPTION_DISMISS_ID,
  type MessageOptionsV3,
} from "@himawari-agent/gateway-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { OPTION_DISMISS_LABEL, TOOL_OFFER_OPTIONS } from "@himawari-agent/prompt-catalog";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";
import { isConflict } from "./context-external-content.js";
import { parameterFingerprint } from "./parameter-fingerprint.js";

type Admission = Parameters<ThreadCommandService["admitOwnerMessage"]>[0];
type OwnerId = Admission["ownerId"];
type AgentId = Admission["agentId"];
type ThreadId = Admission["threadId"];
type MessageId = NonNullable<Admission["messageId"]>;
type ProductThreadMessage = Awaited<ReturnType<ThreadRepositoryPort["listMessages"]>>[number];

export const OFFER_OPTIONS_CAPABILITY_REF = "owner.options.offer";
export const OPTION_CHOICE_MESSAGE_PREFIX = "message:option:";

const LABEL_LIMIT = 200;
const REASON_LIMIT = 500;
const SUMMARY_LIMIT = 1000;
const OPTION_LIMIT = 50;
const ARGUMENT_LIMIT = 8000;
const LATER_MESSAGES = 200;
const WRITE_ATTEMPTS = 3;
const ADMIT_ATTEMPTS = 3;
const SET_PREFIX = "message-options:set:";
const RUN_PREFIX = "message-options:run:";
const CHOICE_PREFIX = "message-options:choice:";
const GRANT_PREFIX = "message-options:grant:";
const GRANT_USE_PREFIX = "message-options:grant-use:";

const digest = (value: unknown, length = 32) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);

export class OfferOptionsInputError extends Error {
  readonly code: "OFFER_OPTIONS_INPUT_INVALID" | "OFFER_OPTIONS_NOT_AVAILABLE";

  constructor(code: OfferOptionsInputError["code"]) {
    super(code);
    this.name = "OfferOptionsInputError";
    this.code = code;
  }
}

export function offerOptionsDescriptor(): RuntimeToolDescriptor {
  return {
    name: "offer_options",
    capabilityRef: OFFER_OPTIONS_CAPABILITY_REF,
    capabilityHandleRef: null,
    description: TOOL_OFFER_OPTIONS.text,
    parameters: {
      type: "object",
      properties: {
        options: {
          type: "array",
          minItems: 1,
          maxItems: OPTION_LIMIT,
          items: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1, maxLength: LABEL_LIMIT },
              reason: { type: "string", minLength: 1, maxLength: REASON_LIMIT },
              action: {
                type: "object",
                properties: {
                  tool: { type: "string", minLength: 1, maxLength: 128 },
                  arguments: { type: "object" },
                },
                required: ["tool", "arguments"],
                additionalProperties: false,
              },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
      },
      required: ["options"],
      additionalProperties: false,
    },
  };
}

interface StoredAction {
  readonly tool: string;
  readonly arguments: JsonObject;
  readonly fingerprint: string;
  readonly summary: string;
}

interface StoredItem {
  readonly optionId: string;
  readonly label: string;
  readonly reason: string | null;
  readonly action: StoredAction | null;
}

interface StoredSet {
  readonly setId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly items: readonly StoredItem[];
}

interface StoredChoice {
  readonly setId: string;
  readonly optionId: string;
}

interface StoredGrant {
  readonly enabled: true;
  readonly tool: string;
  readonly fingerprint: string;
  readonly setId: string;
  readonly optionId: string;
}

export interface MessageOptionsDecoration {
  readonly options: MessageOptionsV3 | null;
  readonly chosenFrom: StoredChoice | null;
}

export interface ProductionMessageOptionsOptions {
  readonly ownerId: string;
  readonly agentId: string;
  readonly state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
  readonly authority: () => AuthorityFence;
  readonly registry: Pick<ToolActionRegistry, "forTool">;
  readonly threads: Pick<
    ThreadRepositoryPort,
    "read" | "listMessages" | "readCommittedMessagesByIds"
  >;
  readonly commands: Pick<ThreadCommandService, "admitOwnerMessage">;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
}

function clip(text: string, limit: number): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length <= limit
    ? characters.join("")
    : `${characters.slice(0, limit - 1).join("")}…`;
}

function plainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argumentText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function optionActionAllowed(row: ToolActionRow | undefined): row is ToolActionRow {
  return (
    row !== undefined &&
    row.authorization === "owner_scope" &&
    row.actionKind !== "READ" &&
    row.capabilityRef !== OFFER_OPTIONS_CAPABILITY_REF &&
    row.targetType !== "owner-message"
  );
}

function notFound(reason: string): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, reason);
}

function stale(): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "OPTION_STALE");
}

export class ProductionMessageOptions {
  readonly #options: ProductionMessageOptionsOptions;

  constructor(options: ProductionMessageOptionsOptions) {
    this.#options = options;
  }

  async offer(invocation: RuntimeToolInvocation): Promise<unknown> {
    const args = invocation.arguments;
    const listed = args["options"];
    if (
      Object.keys(args).some((name) => name !== "options") ||
      !Array.isArray(listed) ||
      listed.length === 0 ||
      listed.length > OPTION_LIMIT
    )
      throw new OfferOptionsInputError("OFFER_OPTIONS_INPUT_INVALID");
    const threadId = invocation.context?.threadId;
    if (!threadId) throw new OfferOptionsInputError("OFFER_OPTIONS_NOT_AVAILABLE");
    const items = listed.map((entry, index) => this.#item(entry, index));
    const setId = `set:${digest([invocation.runId, invocation.toolCallId], 24)}`;
    const value: StoredSet = {
      setId,
      threadId,
      runId: invocation.runId,
      createdAt: this.#options.clock.now(),
      items,
    };
    await this.#writeOnce(`${SET_PREFIX}${setId}`, value as unknown as JsonObject);
    await this.#put(`${RUN_PREFIX}${invocation.runId}`, { setId }, "message_options.run");
    return {
      offered: true,
      setId,
      options: [
        ...items.map(({ optionId, label, action }) => ({
          optionId,
          label,
          action: action ? action.tool : null,
        })),
        { optionId: MESSAGE_OPTION_DISMISS_ID, label: OPTION_DISMISS_LABEL.text, action: null },
      ],
    };
  }

  #item(entry: unknown, index: number): StoredItem {
    const invalid = () => new OfferOptionsInputError("OFFER_OPTIONS_INPUT_INVALID");
    if (!plainObject(entry)) throw invalid();
    if (Object.keys(entry).some((name) => !["label", "reason", "action"].includes(name)))
      throw invalid();
    const label = entry["label"];
    const reason = entry["reason"];
    const action = entry["action"];
    if (typeof label !== "string" || label.trim().length === 0) throw invalid();
    if (reason !== undefined && (typeof reason !== "string" || reason.trim().length === 0))
      throw invalid();
    const optionId = `o${index + 1}`;
    const base = {
      optionId,
      reason: typeof reason === "string" ? clip(reason, REASON_LIMIT) : null,
    };
    if (action === undefined) return { ...base, label: clip(label, LABEL_LIMIT), action: null };
    if (
      !plainObject(action) ||
      Object.keys(action).some((name) => !["tool", "arguments"].includes(name))
    )
      throw invalid();
    const tool = action["tool"];
    const parameters = action["arguments"];
    if (typeof tool !== "string" || !plainObject(parameters)) throw invalid();
    if (JSON.stringify(parameters).length > ARGUMENT_LIMIT) throw invalid();
    const row = this.#options.registry.forTool(tool);
    if (!optionActionAllowed(row) || row.toolIsPrefix) throw invalid();
    const detail = row.detail(parameters, "zh");
    const lines = Object.entries(parameters).map(
      ([name, value]) => `${name}：${argumentText(value)}`,
    );
    return {
      ...base,
      label: clip(detail, LABEL_LIMIT),
      action: {
        tool,
        arguments: parameters,
        fingerprint: parameterFingerprint(parameters),
        summary: clip([detail, ...lines].join("\n"), SUMMARY_LIMIT),
      },
    };
  }

  async decorate(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly threadId: string;
    readonly messages: readonly ProductThreadMessage[];
  }): Promise<ReadonlyMap<string, MessageOptionsDecoration>> {
    const decorations = new Map<string, MessageOptionsDecoration>();
    if (input.ownerId !== this.#options.ownerId || input.agentId !== this.#options.agentId)
      return decorations;
    const lastByRun = new Map<string, ProductThreadMessage>();
    for (const message of input.messages)
      if (message.role === "agent" && message.runId) lastByRun.set(message.runId, message);
    for (const [runId, message] of lastByRun) {
      const set = await this.#setForRun(runId);
      if (!set || set.threadId !== input.threadId) continue;
      decorations.set(message.id, {
        options: await this.#view(set, message),
        chosenFrom: null,
      });
    }
    for (const message of input.messages) {
      if (message.role !== "owner" || !message.id.startsWith(OPTION_CHOICE_MESSAGE_PREFIX))
        continue;
      const choice = await this.#choice(message.id);
      if (choice) decorations.set(message.id, { options: null, chosenFrom: choice });
    }
    return decorations;
  }

  async choose(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly setId: string;
    readonly optionId: string;
    readonly idempotencyKey: string;
    readonly authentication: GatewayAuthenticationContext;
  }): ReturnType<ThreadCommandService["admitOwnerMessage"]> {
    const { ownerId, agentId, threadId } = input;
    if (ownerId !== this.#options.ownerId || agentId !== this.#options.agentId)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "OPTION_SCOPE_MISMATCH");
    const set = await this.#set(input.setId);
    if (!set || set.threadId !== threadId) notFound("OPTION_SET_NOT_FOUND");
    const [message] = await this.#options.threads.readCommittedMessagesByIds({
      ownerId,
      agentId,
      threadId,
      messageIds: [input.messageId as MessageId],
    });
    if (!message || message.role !== "agent" || message.runId !== set.runId)
      notFound("OPTION_MESSAGE_NOT_FOUND");
    const dismiss = input.optionId === MESSAGE_OPTION_DISMISS_ID;
    const item = dismiss
      ? undefined
      : set.items.find(({ optionId }) => optionId === input.optionId);
    if (!dismiss && !item) notFound("OPTION_NOT_FOUND");
    const action = item?.action ?? null;
    const key = action
      ? digest(["action", set.setId, input.optionId])
      : digest(["say", set.setId, input.optionId, input.idempotencyKey]);
    const ownerMessageId = `${OPTION_CHOICE_MESSAGE_PREFIX}${key}`;
    const runId = `run:option:${key}`;
    if (action && !(await this.#choice(ownerMessageId))) {
      const current = await this.#setForRun(set.runId);
      if (current?.setId !== set.setId) stale();
      const states = await this.#states(set, message);
      if (states.get(input.optionId) !== "open") stale();
    }
    const label = item ? item.label : OPTION_DISMISS_LABEL.text;
    const contentRef = `option-content:${key}`;
    const resultRef = `option-result:${key}`;
    const dataClassification = await this.#write(contentRef, label);
    await this.#write(resultRef, "thread-action:option");
    await this.#writeOnce(`${CHOICE_PREFIX}${ownerMessageId}`, {
      setId: set.setId,
      optionId: input.optionId,
    });
    if (action)
      await this.#writeOnce(`${GRANT_PREFIX}${runId}`, {
        tool: action.tool,
        fingerprint: action.fingerprint,
        setId: set.setId,
        optionId: input.optionId,
        enabled: true,
      });
    let lastError: unknown;
    for (let attempt = 0; attempt < ADMIT_ATTEMPTS; attempt += 1) {
      const thread = await this.#options.threads.read(ownerId, agentId, threadId);
      if (!thread) notFound("THREAD_NOT_FOUND");
      try {
        return await this.#options.commands.admitOwnerMessage({
          ownerId,
          agentId,
          threadId,
          expectedThreadRevision: thread.revision,
          sessionId: (input.authentication.sessionId ??
            `session:option:${digest(input.authentication.deviceId, 24)}`) as Admission["sessionId"],
          idempotencyKey: `option:${key}`,
          contentRef: contentRef as Admission["contentRef"],
          sourceProofRef: `option:${set.setId}:${input.optionId}`,
          dataClassification,
          resultRef: resultRef as Admission["resultRef"],
          messageId: ownerMessageId as MessageId,
          turnId: `turn:option:${key}` as NonNullable<Admission["turnId"]>,
          runId: runId as NonNullable<Admission["runId"]>,
          occurredAt: this.#options.clock.now(),
        });
      } catch (error) {
        lastError = error;
        if (!isConflict(error)) throw error;
      }
    }
    throw lastError;
  }

  async claimGrant(input: {
    readonly runId: string;
    readonly tool: string;
    readonly parameterFingerprint: string;
    readonly intentId: string;
  }): Promise<{ readonly key: string; readonly revision: number } | undefined> {
    const key = `${GRANT_PREFIX}${input.runId}`;
    const record = await this.#read(key);
    const grant = record?.value as Partial<StoredGrant> | undefined;
    if (
      !record ||
      !grant ||
      grant.enabled !== true ||
      grant.tool !== input.tool ||
      grant.fingerprint !== input.parameterFingerprint
    )
      return undefined;
    const useKey = `${GRANT_USE_PREFIX}${input.runId}`;
    await this.#writeOnce(useKey, { intentId: input.intentId });
    const use = await this.#read(useKey);
    return use?.value["intentId"] === input.intentId
      ? { key, revision: record.revision }
      : undefined;
  }

  async #view(set: StoredSet, message: ProductThreadMessage): Promise<MessageOptionsV3> {
    const states = set.items.some(({ action }) => action)
      ? await this.#states(set, message)
      : new Map<string, "open" | "chosen" | "stale">();
    return {
      setId: set.setId,
      items: [
        ...set.items.map((item) => ({
          optionId: item.optionId,
          label: item.label,
          reason: item.reason,
          action: item.action ? { tool: item.action.tool, summary: item.action.summary } : null,
          state: item.action ? (states.get(item.optionId) ?? "stale") : ("open" as const),
        })),
        {
          optionId: MESSAGE_OPTION_DISMISS_ID,
          label: OPTION_DISMISS_LABEL.text,
          reason: null,
          action: null,
          state: "open" as const,
        },
      ],
    };
  }

  async #states(
    set: StoredSet,
    message: ProductThreadMessage,
  ): Promise<ReadonlyMap<string, "open" | "chosen" | "stale">> {
    const actions = set.items.filter(({ action }) => action).map(({ optionId }) => optionId);
    const all = (state: "open" | "stale") => new Map(actions.map((id) => [id, state] as const));
    const later = await this.#options.threads.listMessages(
      this.#options.ownerId as OwnerId,
      this.#options.agentId as AgentId,
      message.threadId,
      message.sequence,
      LATER_MESSAGES,
    );
    const owner = later.find(({ role }) => role === "owner");
    if (owner) {
      const choice = owner.id.startsWith(OPTION_CHOICE_MESSAGE_PREFIX)
        ? await this.#choice(owner.id)
        : undefined;
      const chosen = choice?.setId === set.setId ? choice.optionId : undefined;
      return new Map(actions.map((id) => [id, id === chosen ? "chosen" : "stale"] as const));
    }
    if (later.length >= LATER_MESSAGES) return all("stale");
    const runs = new Set(
      later.flatMap(({ role, runId }) =>
        role === "agent" && runId && runId !== set.runId ? [runId] : [],
      ),
    );
    for (const runId of runs) if (await this.#setForRun(runId)) return all("stale");
    return all("open");
  }

  async #setForRun(runId: string): Promise<StoredSet | undefined> {
    const pointer = await this.#read(`${RUN_PREFIX}${runId}`);
    const setId = pointer?.value["setId"];
    return typeof setId === "string" ? this.#set(setId) : undefined;
  }

  async #set(setId: string): Promise<StoredSet | undefined> {
    const record = await this.#read(`${SET_PREFIX}${setId}`);
    return record ? (record.value as unknown as StoredSet) : undefined;
  }

  async #choice(messageId: string): Promise<StoredChoice | undefined> {
    const record = await this.#read(`${CHOICE_PREFIX}${messageId}`);
    const setId = record?.value["setId"];
    const optionId = record?.value["optionId"];
    return typeof setId === "string" && typeof optionId === "string"
      ? { setId, optionId }
      : undefined;
  }

  #read(key: string) {
    return this.#options.state.readScopedState(
      this.#options.ownerId as OwnerId,
      this.#options.agentId as AgentId,
      key,
    );
  }

  async #commit(
    key: string,
    expectedRevision: number | null,
    value: JsonObject,
    commandType: string,
  ): Promise<void> {
    await this.#options.state.commitStateAndEvents({
      command: {
        ownerId: this.#options.ownerId as OwnerId,
        agentId: this.#options.agentId as AgentId,
        commandType,
        idempotencyKey:
          `${key}:${expectedRevision ?? 0}:${digest(value, 16)}` as IdempotentAgentCommand["idempotencyKey"],
        commandFingerprint: digest([expectedRevision, value], 64),
        authority: this.#options.authority(),
      },
      state: { key, expectedRevision, value },
      events: [],
      resultRef: key,
      committedAt: this.#options.clock.now(),
    });
  }

  async #writeOnce(key: string, value: JsonObject): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (await this.#read(key)) return;
      try {
        await this.#commit(key, null, value, "message_options.record");
        return;
      } catch (error) {
        if (!isConflict(error) || attempt >= WRITE_ATTEMPTS - 1) throw error;
      }
    }
  }

  async #put(key: string, value: JsonObject, commandType: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const record = await this.#read(key);
      if (record && digest(record.value) === digest(value)) return;
      try {
        await this.#commit(key, record?.revision ?? null, value, commandType);
        return;
      } catch (error) {
        if (!isConflict(error) || attempt >= WRITE_ATTEMPTS - 1) throw error;
      }
    }
  }

  async #write(ref: string, text: string) {
    const { payloads, protector, clock } = this.#options;
    const dataClassification = classificationWithIdentifiers(text, "private");
    if (!(await payloads.get(ref as never)))
      await payloads.put(
        await protector.protect({
          ownerId: this.#options.ownerId as OwnerId,
          agentId: this.#options.agentId as AgentId,
          ref,
          contentType: "text/plain",
          dataClassification,
          plaintext: new TextEncoder().encode(text),
          createdAt: clock.now(),
        }),
      );
    return dataClassification;
  }
}
