import { createHash } from "node:crypto";
import type {
  AgentId,
  AuthorityFence,
  IdempotentAgentCommand,
  JsonObject,
  OwnerId,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import {
  type ChatSetting,
  type ChatSettingTier,
  ContractValidationError,
  chatSettingsCatalog,
  chatSettingTier,
  findChatSetting,
  gatewayV2PayloadSchema,
} from "@himawari-agent/gateway-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  TOOL_RESULT_SETTINGS_CHANGED,
  TOOL_RESULT_SETTINGS_INVALID,
  TOOL_RESULT_SETTINGS_LIST,
  TOOL_RESULT_SETTINGS_NO_SESSION,
  TOOL_RESULT_SETTINGS_NOT_CONFIRMED,
  TOOL_RESULT_SETTINGS_NOT_UNDOABLE,
  TOOL_RESULT_SETTINGS_REJECTED,
  TOOL_RESULT_SETTINGS_UNKNOWN,
  TOOL_SETTINGS_CHANGE,
  TOOL_SETTINGS_CHANGE_SETTING,
  TOOL_SETTINGS_CHANGE_VALUES,
  TOOL_SETTINGS_LIST,
  TOOL_SETTINGS_LIST_SETTING,
  TOOL_SETTINGS_UNDO,
  TOOL_SETTINGS_UNDO_CHANGE,
} from "@himawari-agent/prompt-catalog";
import {
  type OwnerSettingsGatewayPort,
  OwnerSettingsSessionError,
} from "./production-settings-gateway.js";

export const SETTINGS_LIST_CAPABILITY_REF = "settings.list";
export const SETTINGS_CHANGE_CAPABILITY_REF = "settings.change";
export const SETTINGS_UNDO_CAPABILITY_REF = "settings.undo";

const SERVER_FILLED = new Set(["authorizationRef", "recentAuthenticationRef"]);
const VERSION_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  expectedRevision: "revision",
  expectedVersion: "version",
});

export class SettingsToolError extends Error {
  readonly code: string;
  readonly note: string;
  readonly detail: string | undefined;
  constructor(code: string, note: string, detail?: string) {
    super(code);
    this.name = "SettingsToolError";
    this.code = code;
    this.note = note;
    this.detail = detail;
  }
}

const invalid = (detail?: string) =>
  new SettingsToolError("SETTINGS_INVALID", TOOL_RESULT_SETTINGS_INVALID.text, detail);
const unknown = () => new SettingsToolError("SETTINGS_UNKNOWN", TOOL_RESULT_SETTINGS_UNKNOWN.text);
const noSession = () =>
  new SettingsToolError("SETTINGS_NO_SESSION", TOOL_RESULT_SETTINGS_NO_SESSION.text);
const rejected = (detail?: string) =>
  new SettingsToolError("SETTINGS_REJECTED", TOOL_RESULT_SETTINGS_REJECTED.text, detail);

export function settingsToolDescriptors(): readonly RuntimeToolDescriptor[] {
  return [
    {
      name: "settings_list",
      capabilityRef: SETTINGS_LIST_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_SETTINGS_LIST.text,
      parameters: {
        type: "object",
        properties: { setting: { type: "string", description: TOOL_SETTINGS_LIST_SETTING.text } },
        additionalProperties: false,
      },
    },
    {
      name: "settings_change",
      capabilityRef: SETTINGS_CHANGE_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_SETTINGS_CHANGE.text,
      parameters: {
        type: "object",
        properties: {
          setting: { type: "string", description: TOOL_SETTINGS_CHANGE_SETTING.text },
          values: { type: "object", description: TOOL_SETTINGS_CHANGE_VALUES.text },
        },
        required: ["setting", "values"],
        additionalProperties: false,
      },
    },
    {
      name: "settings_undo",
      capabilityRef: SETTINGS_UNDO_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_SETTINGS_UNDO.text,
      parameters: {
        type: "object",
        properties: { changeId: { type: "string", description: TOOL_SETTINGS_UNDO_CHANGE.text } },
        required: ["changeId"],
        additionalProperties: false,
      },
    },
  ];
}

export interface SettingsChangeRecord {
  readonly changeId: string;
  readonly setting: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly before: Readonly<Record<string, unknown>>;
  readonly undoable: boolean;
}

export interface SettingsChangeRecords {
  read(changeId: string): Promise<SettingsChangeRecord | undefined>;
  write(record: SettingsChangeRecord): Promise<void>;
}

export interface SettingsAccess {
  readonly setting: ChatSetting;
  readonly tier: ChatSettingTier;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly before: Readonly<Record<string, unknown>>;
}

export interface SettingsHooks {
  readonly sessionId: () => Promise<string | undefined>;
  readonly authorize: (
    access: SettingsAccess,
  ) => Promise<{ readonly recentlyAuthenticated: boolean }>;
  readonly externalSources: () => Promise<readonly string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function shortDigest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
}

function fields(setting: ChatSetting): readonly string[] {
  const required = setting.parameters["required"];
  return Array.isArray(required) ? (required as string[]) : [];
}

function picked(source: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
}

export class ProductionSettingsTools {
  readonly #gateway: () => OwnerSettingsGatewayPort | undefined;
  readonly #records: SettingsChangeRecords;

  constructor(options: {
    readonly gateway: () => OwnerSettingsGatewayPort | undefined;
    readonly records: SettingsChangeRecords;
  }) {
    this.#gateway = options.gateway;
    this.#records = options.records;
  }

  #port(): OwnerSettingsGatewayPort {
    const port = this.#gateway();
    if (!port) throw rejected("settings gateway unavailable");
    return port;
  }

  async #read(sessionId: string, setting: ChatSetting): Promise<Readonly<Record<string, unknown>>> {
    try {
      const current = await this.#port().query(
        sessionId,
        setting.row.read,
        setting.row.readPayload,
      );
      return isRecord(current) ? current : {};
    } catch (error) {
      if (error instanceof OwnerSettingsSessionError) throw noSession();
      throw rejected(error instanceof Error ? error.message : undefined);
    }
  }

  async #session(hooks: SettingsHooks): Promise<string> {
    const sessionId = await hooks.sessionId();
    if (!sessionId) throw noSession();
    return sessionId;
  }

  async run(call: RuntimeToolInvocation, hooks: SettingsHooks): Promise<unknown> {
    if (call.capabilityRef === SETTINGS_LIST_CAPABILITY_REF)
      return this.#list(call.arguments, hooks);
    if (call.capabilityRef === SETTINGS_CHANGE_CAPABILITY_REF) {
      const { setting, values } = call.arguments;
      if (
        typeof setting !== "string" ||
        !isRecord(values) ||
        Object.keys(call.arguments).some((key) => key !== "setting" && key !== "values")
      )
        throw invalid();
      return this.#change(call, setting, values, hooks);
    }
    if (call.capabilityRef === SETTINGS_UNDO_CAPABILITY_REF) {
      const { changeId } = call.arguments;
      if (typeof changeId !== "string" || Object.keys(call.arguments).length !== 1) throw invalid();
      return this.#undo(call, changeId, hooks);
    }
    throw invalid();
  }

  async #list(input: JsonObject, hooks: SettingsHooks): Promise<unknown> {
    const wanted = input["setting"];
    if (
      (wanted !== undefined && typeof wanted !== "string") ||
      Object.keys(input).some((key) => key !== "setting")
    )
      throw invalid();
    const catalog = chatSettingsCatalog();
    const chosen = wanted === undefined ? catalog : catalog.filter((s) => s.row.type === wanted);
    if (chosen.length === 0) throw unknown();
    const sessionId = await this.#session(hooks);
    const reads = new Map<string, Readonly<Record<string, unknown>> | null>();
    const settings = [];
    for (const setting of chosen) {
      if (!reads.has(setting.row.read)) {
        let current: Readonly<Record<string, unknown>> | null;
        try {
          current = await this.#read(sessionId, setting);
        } catch (error) {
          if (error instanceof SettingsToolError && error.code === "SETTINGS_NO_SESSION")
            throw error;
          current = null;
        }
        reads.set(setting.row.read, current);
      }
      settings.push({
        setting: setting.row.type,
        name: setting.row.name,
        tier: setting.row.tier,
        ...(setting.row.payloadTiers ? { tierWhen: setting.row.payloadTiers } : {}),
        current: reads.get(setting.row.read) ?? null,
        parameters: setting.parameters,
      });
    }
    return { note: TOOL_RESULT_SETTINGS_LIST.text, settings };
  }

  #payload(
    setting: ChatSetting,
    values: Readonly<Record<string, unknown>>,
    before: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const keys = fields(setting);
    const extra = Object.keys(values).filter(
      (key) => !keys.includes(key) || SERVER_FILLED.has(key),
    );
    if (extra.length > 0) throw invalid(`unknown fields: ${extra.sort().join(", ")}`);
    const payload: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const key of keys) {
      const versionField = VERSION_FIELDS[key];
      if (SERVER_FILLED.has(key)) payload[key] = null;
      else if (Object.hasOwn(values, key)) payload[key] = values[key];
      else if (versionField && Object.hasOwn(before, versionField))
        payload[key] = before[versionField];
      else if (Object.hasOwn(before, key)) payload[key] = before[key];
      else missing.push(key);
    }
    if (missing.length > 0) throw invalid(`missing fields: ${missing.join(", ")}`);
    const schema = gatewayV2PayloadSchema(setting.row.type);
    try {
      schema?.parse(payload, "$.values");
    } catch (error) {
      if (error instanceof ContractValidationError) throw invalid(error.message);
      throw error;
    }
    return payload;
  }

  async #change(
    call: RuntimeToolInvocation,
    type: string,
    values: Readonly<Record<string, unknown>>,
    hooks: SettingsHooks,
    undoOf?: string,
  ): Promise<unknown> {
    const setting = findChatSetting(type);
    if (!setting) throw unknown();
    const sessionId = await this.#session(hooks);
    const before = focused(await this.#read(sessionId, setting), values);
    const payload = this.#payload(setting, values, before);
    const tier = chatSettingTier(setting, payload);
    const { recentlyAuthenticated } = await hooks.authorize({ setting, tier, payload, before });
    const changeId = `setting-change:${shortDigest([call.runId, call.toolCallId])}`;
    try {
      await this.#port().command({
        sessionId,
        type,
        payload,
        idempotencyKey: changeId,
        recentlyAuthenticated,
      });
    } catch (error) {
      if (error instanceof OwnerSettingsSessionError) throw noSession();
      throw rejected(error instanceof Error ? error.message.slice(0, 200) : undefined);
    }
    const after = focused(await this.#read(sessionId, setting), values);
    const changed = Object.keys(values);
    const comparable = changed.filter((key) => Object.hasOwn(after, key));
    const confirmed = comparable.every((key) => same(after[key], values[key]));
    const external = await hooks.externalSources();
    const undoable =
      tier <= 3 && changed.length > 0 && changed.every((key) => Object.hasOwn(before, key));
    if (confirmed)
      await this.#records.write({
        changeId,
        setting: type,
        values: { ...values },
        before: picked(before, changed),
        undoable,
      });
    return {
      note: confirmed ? TOOL_RESULT_SETTINGS_CHANGED.text : TOOL_RESULT_SETTINGS_NOT_CONFIRMED.text,
      setting: type,
      tier,
      confirmed,
      before: changed.length > 0 ? picked(before, changed) : before,
      after: changed.length > 0 ? picked(after, changed) : after,
      ...(confirmed ? { changeId: undoable ? changeId : null } : {}),
      ...(undoOf ? { undoOf } : {}),
      ...(external.length > 0 ? { afterExternalContent: external } : {}),
    };
  }

  async #undo(
    call: RuntimeToolInvocation,
    changeId: string,
    hooks: SettingsHooks,
  ): Promise<unknown> {
    const record = await this.#records.read(changeId);
    if (!record) throw unknown();
    if (!record.undoable)
      throw new SettingsToolError(
        "SETTINGS_NOT_UNDOABLE",
        TOOL_RESULT_SETTINGS_NOT_UNDOABLE.text,
        JSON.stringify(record.before).slice(0, 400),
      );
    return this.#change(call, record.setting, record.before, hooks, changeId);
  }
}

function focused(
  snapshot: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const targets = Object.entries(values).filter(
    ([key, value]) => key.endsWith("Id") && typeof value === "string",
  );
  if (targets.length === 0) return snapshot;
  for (const list of Object.values(snapshot)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      if (targets.some(([key, value]) => item[key] === value || item["id"] === value))
        return { ...Object.fromEntries(targets), ...item };
    }
  }
  return snapshot;
}

export type SettingsScopedState = Pick<
  SqliteProductStateRepository,
  "readScopedState" | "commitStateAndEvents"
>;

export function scopedSettingsChangeRecords(options: {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly state: SettingsScopedState;
  readonly authority: () => AuthorityFence;
  readonly now: () => string;
}): SettingsChangeRecords {
  const read = async (changeId: string) =>
    options.state.readScopedState(options.ownerId, options.agentId, changeId);
  return {
    read: async (changeId) => {
      if (!changeId.startsWith("setting-change:")) return undefined;
      const found = await read(changeId);
      const value = found?.value;
      if (
        !value ||
        typeof value["setting"] !== "string" ||
        typeof value["undoable"] !== "boolean" ||
        !isRecord(value["values"]) ||
        !isRecord(value["before"])
      )
        return undefined;
      return {
        changeId,
        setting: value["setting"],
        values: value["values"],
        before: value["before"],
        undoable: value["undoable"],
      };
    },
    write: async (record) => {
      if (await read(record.changeId)) return;
      const value = JSON.parse(JSON.stringify(record)) as JsonObject;
      await options.state
        .commitStateAndEvents({
          command: {
            ownerId: options.ownerId,
            agentId: options.agentId,
            commandType: "settings.chat.change",
            idempotencyKey: record.changeId as IdempotentAgentCommand["idempotencyKey"],
            commandFingerprint: shortDigest([JSON.stringify(canonical(value))]),
            authority: options.authority(),
          },
          state: { key: record.changeId, expectedRevision: null, value },
          events: [],
          resultRef: record.changeId,
          committedAt: options.now(),
        })
        .catch(async (error: unknown) => {
          if (!(await read(record.changeId))) throw error;
        });
    },
  };
}
