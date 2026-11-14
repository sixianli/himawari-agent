import {
  type DataClassification,
  highestClassification,
  isModelVisible,
  type PairedDevice,
  PERCEPTION_RECORD_TYPE_NAMES,
  PERCEPTION_SENSES,
  type PerceptionConfiguration,
  type PerceptionRecord,
  type PerceptionRecordType,
  type PerceptionScope,
  type PerceptionSense,
  type PerceptionStorePort,
  perceptionTypesOfSense,
  type RuntimeToolDescriptor,
  type RuntimeToolInvocation,
  zonedTime,
} from "@himawari-agent/application";
import {
  PERCEPTION_DATA_NOTICE,
  renderPrompt,
  TOOL_DEVICE_ACTION,
  TOOL_DEVICE_ACTION_ACTION,
  TOOL_DEVICE_ACTION_ARGUMENTS,
  TOOL_DEVICE_ACTION_DEVICE,
  TOOL_PERCEPTION_READ,
  TOOL_PERCEPTION_READ_DETAIL,
  TOOL_PERCEPTION_READ_FROM,
  TOOL_PERCEPTION_READ_KINDS,
  TOOL_PERCEPTION_READ_QUERY,
  TOOL_PERCEPTION_READ_TO,
  TOOL_RESULT_DEVICE_ACTION_DESCRIBE,
  TOOL_RESULT_DEVICE_ACTION_EXPIRED,
  TOOL_RESULT_DEVICE_ACTION_FAILED,
  TOOL_RESULT_DEVICE_ACTION_INVALID,
  TOOL_RESULT_DEVICE_ACTION_NO_DEVICE,
  TOOL_RESULT_DEVICE_ACTION_QUEUED,
  TOOL_RESULT_DEVICE_ACTION_REJECTED,
  TOOL_RESULT_DEVICE_ACTION_RESULT_UNKNOWN,
  TOOL_RESULT_DEVICE_ACTION_SUCCEEDED,
  TOOL_RESULT_DEVICE_ACTION_UNAVAILABLE,
  TOOL_RESULT_DEVICE_ACTION_UNKNOWN,
  TOOL_RESULT_DEVICE_ACTION_UNSUPPORTED,
  TOOL_RESULT_DEVICE_ACTION_WAITING_OWNER,
  TOOL_RESULT_PERCEPTION_READ_EMPTY,
  TOOL_RESULT_PERCEPTION_READ_HIDDEN,
  TOOL_RESULT_PERCEPTION_READ_INVALID,
  TOOL_RESULT_PERCEPTION_READ_TRUNCATED,
  TOOL_RESULT_PERCEPTION_READ_UNAVAILABLE,
  TOOL_RESULT_PERCEPTION_READ_UNEXAMINED,
  TOOL_RESULT_PERCEPTION_READ_UNKNOWN_KINDS,
} from "@himawari-agent/prompt-catalog";
import { localTimeText } from "./production-reminder-writer.js";

export const PERCEPTION_READ_CAPABILITY_REF = "perception.read";
export const DEVICE_ACTION_CAPABILITY_REF = "device.action";
export const PERCEPTION_TOOL_CAPABILITY_REFS: readonly string[] = [
  DEVICE_ACTION_CAPABILITY_REF,
  PERCEPTION_READ_CAPABILITY_REF,
];
export const DEVICE_ACTION_DESCRIBE = "describe";
export const PERCEPTION_READ_DETAILS = ["summary", "full"] as const;

const READ_ARGUMENTS = ["kinds", "from", "to", "query", "detail"];
const ACTION_ARGUMENTS = ["action", "device", "arguments"];
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/u;
const DAY_MS = 86_400_000;
const SCAN_PAGE = 500;

export const DEVICE_ACTION_STATES = [
  "queued",
  "succeeded",
  "failed",
  "result_unknown",
  "expired",
  "rejected",
  "waiting_owner",
] as const;
export type DeviceActionState = (typeof DEVICE_ACTION_STATES)[number];

const DEVICE_ACTION_NOTES: Readonly<Record<DeviceActionState, string>> = Object.freeze({
  queued: TOOL_RESULT_DEVICE_ACTION_QUEUED.text,
  succeeded: TOOL_RESULT_DEVICE_ACTION_SUCCEEDED.text,
  failed: TOOL_RESULT_DEVICE_ACTION_FAILED.text,
  result_unknown: TOOL_RESULT_DEVICE_ACTION_RESULT_UNKNOWN.text,
  expired: TOOL_RESULT_DEVICE_ACTION_EXPIRED.text,
  rejected: TOOL_RESULT_DEVICE_ACTION_REJECTED.text,
  waiting_owner: TOOL_RESULT_DEVICE_ACTION_WAITING_OWNER.text,
});

export function deviceActionNote(state: DeviceActionState): string {
  return DEVICE_ACTION_NOTES[state];
}

export function perceptionToolDescriptors(): readonly RuntimeToolDescriptor[] {
  return [
    {
      name: "device_action",
      capabilityRef: DEVICE_ACTION_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_DEVICE_ACTION.text,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: TOOL_DEVICE_ACTION_ACTION.text },
          device: { type: "string", description: TOOL_DEVICE_ACTION_DEVICE.text },
          arguments: { type: "object", description: TOOL_DEVICE_ACTION_ARGUMENTS.text },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "perception_read",
      capabilityRef: PERCEPTION_READ_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_PERCEPTION_READ.text,
      parameters: {
        type: "object",
        properties: {
          kinds: {
            type: "array",
            items: { type: "string" },
            description: TOOL_PERCEPTION_READ_KINDS.text,
          },
          from: { type: "string", description: TOOL_PERCEPTION_READ_FROM.text },
          to: { type: "string", description: TOOL_PERCEPTION_READ_TO.text },
          query: { type: "string", description: TOOL_PERCEPTION_READ_QUERY.text },
          detail: {
            type: "string",
            enum: [...PERCEPTION_READ_DETAILS],
            description: TOOL_PERCEPTION_READ_DETAIL.text,
          },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  ];
}

export interface DeviceActionDefinition {
  readonly name: string;
  readonly reads: boolean;
  readonly confirm: boolean;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly usage?: string;
}

export interface DeviceActionRequest {
  readonly invocation: RuntimeToolInvocation;
  readonly device: PairedDevice;
  readonly action: DeviceActionDefinition;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface DeviceActionOutcome {
  readonly state: DeviceActionState;
  readonly reason?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface ProductionPerceptionToolsOptions {
  readonly scope: PerceptionScope;
  readonly store: Pick<PerceptionStorePort, "listRecordsBetween">;
  readonly devices: (scope: PerceptionScope) => Promise<readonly PairedDevice[]>;
  readonly readText: (contentRef: string) => Promise<string | undefined>;
  readonly configuration: () => PerceptionConfiguration;
  readonly actions?: () => readonly DeviceActionDefinition[];
  readonly offered?: (device: PairedDevice) => Promise<readonly string[]>;
  readonly perform?: (request: DeviceActionRequest) => Promise<DeviceActionOutcome>;
  readonly timeZone?: string;
  readonly now: () => string;
}

export class PerceptionToolError extends Error {
  readonly code: string;
  readonly note: string;
  constructor(code: string, note: string) {
    super(code);
    this.name = "PerceptionToolError";
    this.code = code;
    this.note = note;
  }
}

export interface PerceptionToolHooks {
  readonly authorize: () => Promise<void>;
  readonly markExternalContent: () => Promise<void>;
}

export interface PerceptionToolResult {
  readonly value: unknown;
  readonly contentClassification?: DataClassification;
}

function localInstant(value: string, timeZone: string, endOfDay: boolean): number | null {
  const match = LOCAL_TIME.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  )
    return null;
  const timed = match[4] !== undefined;
  const hours = timed ? Number(match[4]) : 0;
  const minutes = timed ? Number(match[5]) : 0;
  if (hours > 23 || minutes > 59) return null;
  const start = Date.parse(zonedTime({ year, month, day }, hours * 60 + minutes, timeZone));
  if (timed) return endOfDay ? start + 59_999 : start;
  if (!endOfDay) return start;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return (
    Date.parse(
      zonedTime(
        { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
        0,
        timeZone,
      ),
    ) - 1
  );
}

function sortedEvidence(
  evidence: PerceptionRecord["evidence"],
): Readonly<Record<string, string | number | boolean>> {
  return Object.fromEntries(
    Object.keys(evidence)
      .sort()
      .map((key) => [key, evidence[key] as string | number | boolean]),
  );
}

export class ProductionPerceptionTools {
  readonly #options: ProductionPerceptionToolsOptions;
  readonly #timeZone: string;

  constructor(options: ProductionPerceptionToolsOptions) {
    this.#options = options;
    this.#timeZone = options.timeZone ?? "UTC";
  }

  run(
    invocation: RuntimeToolInvocation,
    hooks: PerceptionToolHooks,
  ): Promise<PerceptionToolResult> {
    return invocation.capabilityRef === PERCEPTION_READ_CAPABILITY_REF
      ? this.#read(invocation, hooks)
      : this.#action(invocation, hooks);
  }

  #kinds(raw: unknown): readonly PerceptionRecordType[] | null | undefined {
    if (raw === undefined) return null;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const types = new Set<PerceptionRecordType>();
    for (const kind of raw) {
      if ((PERCEPTION_RECORD_TYPE_NAMES as readonly unknown[]).includes(kind))
        types.add(kind as PerceptionRecordType);
      else if ((PERCEPTION_SENSES as readonly unknown[]).includes(kind))
        for (const type of perceptionTypesOfSense(kind as PerceptionSense)) types.add(type);
      else return undefined;
    }
    return PERCEPTION_RECORD_TYPE_NAMES.filter((type) => types.has(type));
  }

  async #read(
    invocation: RuntimeToolInvocation,
    hooks: PerceptionToolHooks,
  ): Promise<PerceptionToolResult> {
    const args = invocation.arguments;
    const configuration = this.#options.configuration();
    const invalid = () =>
      new PerceptionToolError(
        "PERCEPTION_READ_INPUT_INVALID",
        renderPrompt(TOOL_RESULT_PERCEPTION_READ_INVALID, {
          days: String(configuration.readMaximumDays),
        }),
      );
    const detail = args["detail"] ?? "summary";
    const query = args["query"];
    if (
      Object.keys(args).some((name) => !READ_ARGUMENTS.includes(name)) ||
      typeof args["from"] !== "string" ||
      typeof args["to"] !== "string" ||
      !(PERCEPTION_READ_DETAILS as readonly unknown[]).includes(detail) ||
      (query !== undefined && (typeof query !== "string" || query.trim().length === 0))
    )
      throw invalid();
    const fromMs = localInstant(args["from"], this.#timeZone, false);
    const toMs = localInstant(args["to"], this.#timeZone, true);
    if (
      fromMs === null ||
      toMs === null ||
      toMs < fromMs ||
      toMs - fromMs > configuration.readMaximumDays * DAY_MS
    )
      throw invalid();
    const types = this.#kinds(args["kinds"]);
    if (types === undefined)
      return {
        value: {
          records: [],
          availableKinds: [...PERCEPTION_SENSES, ...PERCEPTION_RECORD_TYPE_NAMES],
          note: TOOL_RESULT_PERCEPTION_READ_UNKNOWN_KINDS.text,
        },
      };
    const needle = typeof query === "string" ? query.trim().toLowerCase() : null;
    const listed: Record<string, unknown>[] = [];
    const shown: PerceptionRecord[] = [];
    let characters = 0;
    let hidden = 0;
    let matchedBeyond = 0;
    let examined = 0;
    let total = 0;
    let after: { readonly atMs: number; readonly id: string } | null = null;
    let full = false;
    for (;;) {
      const scanLimit = Math.min(SCAN_PAGE, configuration.readMaximumScanned - examined);
      const page = await this.#options.store.listRecordsBetween({
        ...this.#options.scope,
        fromMs,
        toMs,
        types,
        after,
        limit: scanLimit,
      });
      total = page.total;
      for (const record of page.records) {
        examined += 1;
        if (!isModelVisible(record.dataClassification)) {
          hidden += 1;
          continue;
        }
        if (full && needle === null) {
          matchedBeyond += 1;
          continue;
        }
        const text =
          record.contentRef === null ? undefined : await this.#options.readText(record.contentRef);
        if (needle !== null && !(text ?? "").toLowerCase().includes(needle)) continue;
        const body =
          text === undefined
            ? undefined
            : detail === "full"
              ? text
              : [...text].slice(0, configuration.previewCharacters).join("");
        const entry = {
          id: record.id,
          kind: record.type,
          at: localTimeText(new Date(record.occurredAtMs).toISOString(), this.#timeZone),
          origin: record.origin,
          source: record.captureSource,
          ...(record.speakerKind === null ? {} : { speaker: record.speakerKind }),
          ...(body === undefined ? {} : { text: body }),
          ...(body !== undefined && text !== undefined && body.length < text.length
            ? { more: true }
            : {}),
          evidence: sortedEvidence(record.evidence),
        };
        const size = [...JSON.stringify(entry)].length;
        if (
          full ||
          listed.length >= configuration.readMaximumRecords ||
          characters + size > configuration.readMaximumCharacters
        ) {
          full = true;
          matchedBeyond += 1;
          continue;
        }
        characters += size;
        listed.push(entry);
        shown.push(record);
      }
      const last = page.records.at(-1);
      if (
        !last ||
        page.records.length < scanLimit ||
        (full && needle !== null) ||
        examined >= configuration.readMaximumScanned
      )
        break;
      after = { atMs: last.occurredAtMs, id: last.id };
    }
    const unexamined = total - examined;
    const notes: string[] = [];
    if (listed.length === 0 && matchedBeyond === 0 && unexamined === 0)
      notes.push(TOOL_RESULT_PERCEPTION_READ_EMPTY.text);
    if (needle === null && matchedBeyond + unexamined > 0)
      notes.push(
        renderPrompt(TOOL_RESULT_PERCEPTION_READ_TRUNCATED, {
          remaining: String(matchedBeyond + unexamined),
        }),
      );
    if (needle !== null && matchedBeyond > 0)
      notes.push(
        renderPrompt(TOOL_RESULT_PERCEPTION_READ_TRUNCATED, { remaining: String(matchedBeyond) }),
      );
    if (needle !== null && unexamined > 0)
      notes.push(
        renderPrompt(TOOL_RESULT_PERCEPTION_READ_UNEXAMINED, { unexamined: String(unexamined) }),
      );
    if (hidden > 0)
      notes.push(renderPrompt(TOOL_RESULT_PERCEPTION_READ_HIDDEN, { hidden: String(hidden) }));
    if (shown.some((record) => record.origin === "other")) await hooks.markExternalContent();
    return {
      value: {
        ...(listed.length > 0 ? { notice: PERCEPTION_DATA_NOTICE.text } : {}),
        timeZone: this.#timeZone,
        records: listed,
        ...(notes.length > 0 ? { note: notes.join("\n") } : {}),
      },
      contentClassification: highestClassification(
        invocation.dataClassification,
        shown.map((record) => record.dataClassification),
      ),
    };
  }

  async #action(
    invocation: RuntimeToolInvocation,
    hooks: PerceptionToolHooks,
  ): Promise<PerceptionToolResult> {
    const args = invocation.arguments;
    const action = args["action"];
    const device = args["device"];
    const parameters = args["arguments"] ?? {};
    if (
      Object.keys(args).some((name) => !ACTION_ARGUMENTS.includes(name)) ||
      typeof action !== "string" ||
      action.length === 0 ||
      (device !== undefined && typeof device !== "string") ||
      typeof parameters !== "object" ||
      parameters === null ||
      Array.isArray(parameters)
    )
      throw new PerceptionToolError(
        "DEVICE_ACTION_INPUT_INVALID",
        TOOL_RESULT_DEVICE_ACTION_INVALID.text,
      );
    const devices = (await this.#options.devices(this.#options.scope))
      .filter(({ status }) => status === "active")
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const registry = [...(this.#options.actions?.() ?? [])].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    const allowed = new Map<string, readonly string[]>();
    for (const target of devices)
      allowed.set(
        target.id,
        this.#options.offered ? await this.#options.offered(target) : target.supportedActions,
      );
    const offered = (target: PairedDevice) =>
      registry.filter(({ name }) => (allowed.get(target.id) ?? []).includes(name));
    if (action === DEVICE_ACTION_DESCRIBE) {
      if (devices.length === 0)
        return {
          value: { devices: [], actions: [], note: TOOL_RESULT_DEVICE_ACTION_NO_DEVICE.text },
        };
      const used = new Set(devices.flatMap((target) => offered(target).map(({ name }) => name)));
      return {
        value: {
          devices: devices.map((target) => ({
            device: target.id,
            name: target.name,
            kind: target.kind,
            actions: offered(target).map(({ name }) => name),
          })),
          actions: registry
            .filter(({ name }) => used.has(name))
            .map(({ name, confirm, parameters: shape, usage }) => ({
              name,
              confirm,
              parameters: shape,
              ...(usage === undefined ? {} : { usage }),
            })),
          note: TOOL_RESULT_DEVICE_ACTION_DESCRIBE.text,
        },
      };
    }
    if (devices.length === 0)
      return { value: { done: false, note: TOOL_RESULT_DEVICE_ACTION_NO_DEVICE.text } };
    const definition = registry.find(({ name }) => name === action);
    const capable = devices.filter((target) => target.supportedActions.includes(action));
    if (!definition)
      return {
        value: {
          done: false,
          availableActions: registry
            .filter(({ name }) =>
              devices.some((target) => (allowed.get(target.id) ?? []).includes(name)),
            )
            .map(({ name }) => name),
          note: TOOL_RESULT_DEVICE_ACTION_UNKNOWN.text,
        },
      };
    const target =
      device === undefined
        ? (capable.find(({ id }) => (allowed.get(id) ?? []).includes(action)) ?? capable[0])
        : devices.find(({ id }) => id === device);
    if (!target || !target.supportedActions.includes(action))
      return {
        value: {
          done: false,
          note:
            capable.length === 0
              ? TOOL_RESULT_DEVICE_ACTION_NO_DEVICE.text
              : TOOL_RESULT_DEVICE_ACTION_UNSUPPORTED.text,
        },
      };
    if (!this.#options.perform)
      throw new PerceptionToolError(
        "DEVICE_ACTION_UNAVAILABLE",
        TOOL_RESULT_DEVICE_ACTION_UNAVAILABLE.text,
      );
    const request: DeviceActionRequest = {
      invocation,
      device: target,
      action: definition,
      arguments: parameters as Readonly<Record<string, unknown>>,
    };
    if (!definition.reads) await hooks.authorize();
    const outcome = await this.#options.perform(request);
    return {
      value: {
        done: outcome.state === "succeeded",
        state: outcome.state,
        device: target.id,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }),
        note: deviceActionNote(outcome.state),
      },
    };
  }
}

export function perceptionReadUnavailable(): { readonly errorCode: string; readonly note: string } {
  return {
    errorCode: "PERCEPTION_READ_UNAVAILABLE",
    note: TOOL_RESULT_PERCEPTION_READ_UNAVAILABLE.text,
  };
}
