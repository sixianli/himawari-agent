import {
  TOOL_RESULT_DEVICE_ACTION_USAGE_ALARM_LIST,
  TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_CHANGE,
  TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_READ,
  TOOL_RESULT_DEVICE_ACTION_USAGE_CONTACT_SEARCH,
  TOOL_RESULT_DEVICE_ACTION_USAGE_CONTACT_UPDATE,
  TOOL_RESULT_DEVICE_ACTION_USAGE_DEVICE_REMINDER,
  TOOL_RESULT_DEVICE_ACTION_USAGE_DEVICE_REMINDER_COMPLETE,
  TOOL_RESULT_DEVICE_ACTION_USAGE_DEVICE_REMINDER_READ,
  TOOL_RESULT_DEVICE_ACTION_USAGE_HOME_CONTROL,
  TOOL_RESULT_DEVICE_ACTION_USAGE_HOME_READ,
} from "@himawari-agent/prompt-catalog";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ActionKind } from "../ports/authorization.js";
import { PAIRED_DEVICE_KINDS, type PairedDeviceKind } from "../ports/paired-devices.js";
import type { DeviceMirrorKind } from "../ports/perception.js";
import { WEB_PUSH_LOCALES } from "../ports/web-push.js";

export const DEVICE_ACTION_LOCALES = WEB_PUSH_LOCALES;
export type DeviceActionLocale = (typeof DEVICE_ACTION_LOCALES)[number];
export type DeviceActionDetail = Readonly<Record<DeviceActionLocale, string>>;

export const DEVICE_ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

export type DeviceActionField =
  | {
      readonly type: "string";
      readonly required: boolean;
      readonly maxLength: number;
      readonly format?: "local_time" | "date";
      readonly values?: readonly string[];
    }
  | {
      readonly type: "integer";
      readonly required: boolean;
      readonly minimum: number;
      readonly maximum: number;
    }
  | {
      readonly type: "number";
      readonly required: boolean;
      readonly minimum: number;
      readonly maximum: number;
    }
  | { readonly type: "boolean"; readonly required: boolean }
  | {
      readonly type: "string_list";
      readonly required: boolean;
      readonly maxItems: number;
      readonly maxLength: number;
    };

export type DeviceActionParameters = Readonly<Record<string, DeviceActionField>>;
export type DeviceActionArguments = Readonly<Record<string, unknown>>;

export const DEVICE_ACTION_READ_BACK_KINDS = [
  "none",
  "read_item",
  "confirm_absent",
  "read_state",
] as const;
export type DeviceActionReadBack = (typeof DEVICE_ACTION_READ_BACK_KINDS)[number];

export type DeviceActionTargetData = Readonly<Record<string, string | number | boolean>>;

export interface DeviceActionContext {
  readonly target: DeviceActionTargetData | null;
  readonly localTime: (milliseconds: number) => string;
}

export interface DeviceActionUndoPlan {
  readonly action: string;
  readonly arguments: DeviceActionArguments;
}

export type DeviceActionUndo = (
  args: DeviceActionArguments,
  evidence: Readonly<Record<string, unknown>>,
) => DeviceActionUndoPlan | null;

export interface DeviceActionTarget {
  readonly mirrorKind: DeviceMirrorKind;
  readonly idKey: string;
  readonly listedBy?: { readonly action: string; readonly list: string };
}

export interface DeviceActionRegistration {
  readonly name: string;
  readonly schemaVersion: number;
  readonly deviceKinds: readonly PairedDeviceKind[];
  readonly parameters: DeviceActionParameters;
  readonly target: DeviceActionTarget | null;
  readonly actionKind: ActionKind;
  readonly escalation:
    | ((args: DeviceActionArguments, context: DeviceActionContext) => ActionKind | null)
    | null;
  readonly ownerPresence: (args: DeviceActionArguments, context: DeviceActionContext) => boolean;
  readonly recipients: ((args: DeviceActionArguments) => readonly string[]) | null;
  readonly resultOrigin: "owner" | "external";
  readonly readBack: DeviceActionReadBack;
  readonly snapshotBefore: boolean;
  readonly reversible: boolean;
  readonly undo?: DeviceActionUndo;
  readonly usage?: string;
  readonly title: DeviceActionDetail;
  readonly confirmLabel: DeviceActionDetail;
  readonly declineLabel: DeviceActionDetail;
  readonly detail: (
    args: DeviceActionArguments,
    context: DeviceActionContext,
  ) => DeviceActionDetail;
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function realLocalTime(value: string): boolean {
  const parsed = Date.parse(`${value.length === 10 ? `${value}T00:00` : value}:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, value.length) === value;
}

function fieldProblem(field: DeviceActionField, value: unknown): boolean {
  switch (field.type) {
    case "string":
      return (
        typeof value !== "string" ||
        value.length === 0 ||
        [...value].length > field.maxLength ||
        value !== value.normalize("NFC") ||
        (field.values !== undefined && !field.values.includes(value)) ||
        (field.format === "local_time" && !(LOCAL_TIME.test(value) && realLocalTime(value))) ||
        (field.format === "date" && !(DATE.test(value) && realLocalTime(value)))
      );
    case "integer":
      return (
        !Number.isSafeInteger(value) ||
        (value as number) < field.minimum ||
        (value as number) > field.maximum
      );
    case "number":
      return (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < field.minimum ||
        value > field.maximum
      );
    case "boolean":
      return typeof value !== "boolean";
    case "string_list":
      return (
        !Array.isArray(value) ||
        value.length > field.maxItems ||
        new Set(value).size !== value.length ||
        value.some(
          (item) =>
            typeof item !== "string" ||
            item.length === 0 ||
            [...item].length > field.maxLength ||
            item !== item.normalize("NFC"),
        )
      );
  }
}

export function validateDeviceActionArguments(
  parameters: DeviceActionParameters,
  input: DeviceActionArguments,
): DeviceActionArguments | undefined {
  if (Object.keys(input).some((name) => !Object.hasOwn(parameters, name))) return undefined;
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(parameters).sort()) {
    const field = parameters[name] as DeviceActionField;
    const value = input[name];
    if (value === undefined) {
      if (field.required) return undefined;
      continue;
    }
    if (fieldProblem(field, value)) return undefined;
    result[name] = field.type === "string_list" ? Object.freeze([...(value as string[])]) : value;
  }
  return Object.freeze(result);
}

export function deviceActionFingerprint(name: string, args: DeviceActionArguments): string {
  const canonical = JSON.stringify(
    Object.keys(args)
      .sort()
      .map((key) => {
        const value = args[key];
        return [key, Array.isArray(value) ? [...(value as string[])].sort() : value];
      }),
  );
  return bytesToHex(sha256(utf8ToBytes(`${name}\n${canonical}`)));
}

export function describeDeviceActionParameters(
  parameters: DeviceActionParameters,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.keys(parameters)
        .sort()
        .map((name) => {
          const field = parameters[name] as DeviceActionField;
          const { type, required, ...limits } = field;
          return [
            name,
            Object.freeze({
              type,
              required,
              ...Object.fromEntries(
                Object.keys(limits)
                  .sort()
                  .map((key) => [key, (limits as Record<string, unknown>)[key]]),
              ),
            }),
          ];
        }),
    ),
  );
}

const CALENDAR_FIELDS = [
  "title",
  "start",
  "end",
  "allDay",
  "calendar",
  "location",
  "notes",
] as const;
const CALENDAR_CHANGEABLE = ["title", "start", "end", "location", "notes"] as const;
const CONTACT_FIELDS = ["givenName", "familyName", "phones", "emails", "organization"] as const;

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function undoCreatedItem(action: string, idKey: string): DeviceActionUndo {
  return (_args, evidence) => {
    const id = evidence[idKey];
    return typeof id === "string" && id !== "" ? { action, arguments: { [idKey]: id } } : null;
  };
}

function undoRestoring(
  action: string,
  idKey: string,
  fields: readonly string[],
  occurrence: boolean,
): DeviceActionUndo {
  return (args, evidence) => {
    const before = recordOf(evidence["before"]);
    const id = args[idKey];
    if (!before || typeof id !== "string") return null;
    const changed = fields.filter((field) => args[field] !== undefined);
    if (changed.length === 0 || changed.some((field) => before[field] === undefined)) return null;
    return {
      action,
      arguments: {
        [idKey]: id,
        ...(occurrence && args["occurrenceStart"] !== undefined
          ? { occurrenceStart: args["occurrenceStart"] }
          : {}),
        ...Object.fromEntries(changed.map((field) => [field, before[field]])),
      },
    };
  };
}

const undoDeletedEvent: DeviceActionUndo = (args, evidence) => {
  const before = recordOf(evidence["before"]);
  if (!before || args["occurrenceStart"] !== undefined) return null;
  const restored = Object.fromEntries(
    CALENDAR_FIELDS.filter((field) => before[field] !== undefined).map((field) => [
      field,
      before[field],
    ]),
  );
  return { action: "calendar.create", arguments: restored };
};

export class DeviceActionRegistry {
  readonly #byName: ReadonlyMap<string, DeviceActionRegistration>;

  constructor(registrations: readonly DeviceActionRegistration[]) {
    const byName = new Map<string, DeviceActionRegistration>();
    for (const registration of registrations) {
      if (
        !DEVICE_ACTION_NAME_PATTERN.test(registration.name) ||
        registration.name.length > 64 ||
        !Number.isSafeInteger(registration.schemaVersion) ||
        registration.schemaVersion < 1 ||
        registration.deviceKinds.length === 0 ||
        registration.deviceKinds.some((kind) => !PAIRED_DEVICE_KINDS.includes(kind)) ||
        DEVICE_ACTION_LOCALES.some(
          (locale) =>
            (registration.confirmLabel?.[locale] ?? "").trim().length === 0 ||
            (registration.title?.[locale] ?? "").trim().length === 0 ||
            (registration.declineLabel?.[locale] ?? "").trim().length === 0,
        ) ||
        byName.has(registration.name)
      )
        throw new Error(`DEVICE_ACTION_REGISTRATION_INVALID ${registration.name}`);
      byName.set(registration.name, Object.freeze({ ...registration }));
    }
    for (const registration of byName.values()) {
      const lister = registration.target?.listedBy;
      if (lister && byName.get(lister.action)?.actionKind !== "READ")
        throw new Error(`DEVICE_ACTION_REGISTRATION_INVALID ${registration.name}`);
    }
    this.#byName = byName;
  }

  get(name: string): DeviceActionRegistration | undefined {
    return this.#byName.get(name);
  }

  names(): readonly string[] {
    return [...this.#byName.keys()].sort();
  }

  kindOf(
    registration: DeviceActionRegistration,
    args: DeviceActionArguments,
    context: DeviceActionContext,
  ): ActionKind {
    return registration.escalation?.(args, context) ?? registration.actionKind;
  }

  supportedBy(kind: PairedDeviceKind, reported: readonly string[]): readonly string[] {
    return this.names().filter(
      (name) =>
        reported.includes(name) &&
        (this.#byName.get(name) as DeviceActionRegistration).deviceKinds.includes(kind),
    );
  }
}

const text = (maxLength: number, required = true) =>
  ({ type: "string", required, maxLength }) as const;
const localTime = (required = true) =>
  ({ type: "string", required, maxLength: 16, format: "local_time" }) as const;
const flag = () => ({ type: "boolean", required: false }) as const;
const never = () => false;

export const HOME_ROUTINE_CATEGORIES: readonly string[] = Object.freeze([
  "air_purifier",
  "fan",
  "humidifier",
  "light",
  "outlet",
  "speaker",
  "switch",
  "television",
  "thermostat",
  "window_covering",
]);

function joined(parts: readonly (string | false | undefined)[], separator: string): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(separator);
}

function shownTime(value: string): string {
  return value.replace("T", " ");
}

function period(start: string, end: string | undefined): string {
  if (end === undefined) return start;
  return `${start}–${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end}`;
}

function changes(
  args: DeviceActionArguments,
  labels: Readonly<Record<string, DeviceActionDetail>>,
  locale: DeviceActionLocale,
): string {
  return Object.keys(labels)
    .filter((key) => args[key] !== undefined)
    .map((key) => {
      const value = args[key];
      const shown = Array.isArray(value)
        ? value.join(locale === "en" ? ", " : "、")
        : typeof value === "string"
          ? value.replace(/^(\d{4}-\d{2}-\d{2})T/u, "$1 ")
          : String(value);
      return `${(labels[key] as DeviceActionDetail)[locale]}${locale === "en" ? ": " : "："}${shown}`;
    })
    .join(locale === "en" ? "; " : "；");
}

function detail(build: (locale: DeviceActionLocale) => string): DeviceActionDetail {
  return Object.freeze({ "zh-CN": build("zh-CN"), en: build("en"), ja: build("ja") });
}

const label = (zh: string, en: string, ja: string): DeviceActionDetail =>
  Object.freeze({ "zh-CN": zh, en, ja });

const CALENDAR_LABELS = Object.freeze({
  title: label("标题", "title", "タイトル"),
  start: label("开始", "start", "開始"),
  end: label("结束", "end", "終了"),
  location: label("地点", "location", "場所"),
  notes: label("备注", "notes", "メモ"),
});

const REMINDER_LABELS = Object.freeze({
  due: label("到期", "due", "期限"),
  notes: label("备注", "notes", "メモ"),
  list: label("列表", "list", "リスト"),
});

const CONTACT_LABELS = Object.freeze({
  givenName: label("名", "given name", "名"),
  familyName: label("姓", "family name", "姓"),
  phones: label("电话", "phones", "電話"),
  emails: label("邮箱", "emails", "メール"),
  organization: label("公司", "organization", "会社"),
});

const HOME_LABELS = Object.freeze({
  on: label("开关", "power", "電源"),
  level: label("亮度或开合", "level", "レベル"),
  targetTemperature: label("目标温度", "target temperature", "設定温度"),
  locked: label("上锁", "locked", "施錠"),
});

function named(context: DeviceActionContext, key: string): string {
  return String(context.target?.[key] ?? "");
}

function eventPeriod(context: DeviceActionContext): string {
  const start = context.target?.["startsAtMs"];
  const end = context.target?.["endsAtMs"];
  if (typeof start !== "number") return "";
  return period(
    context.localTime(start),
    typeof end === "number" ? context.localTime(end) : undefined,
  );
}

function invites(context: DeviceActionContext): boolean {
  const known = context.target?.["attendeeCount"];
  return typeof known === "number" && known > 0;
}

const ONLY_CHANGE = label("只改这一次", "this occurrence only", "この回だけ");
const ONLY_DELETE = label("只删这一次", "this occurrence only", "この回だけ");

function occurrence(
  args: DeviceActionArguments,
  context: DeviceActionContext,
  locale: DeviceActionLocale,
  only: DeviceActionDetail,
): string {
  const single = args["occurrenceStart"];
  if (typeof single !== "string") return eventPeriod(context);
  const shown = shownTime(single);
  return locale === "en" ? `${shown} (${only.en})` : `${shown}（${only[locale]}）`;
}

function homeSafety(_args: DeviceActionArguments, context: DeviceActionContext): boolean {
  return !HOME_ROUTINE_CATEGORIES.includes(named(context, "category"));
}

const APPLE_DEVICES: readonly PairedDeviceKind[] = ["iphone", "mac"];
const CALENDAR_TARGET: DeviceActionTarget = {
  mirrorKind: "calendar_event",
  idKey: "eventId",
  listedBy: { action: "calendar.read", list: "events" },
};
const PHONE_AND_WATCH: readonly PairedDeviceKind[] = ["iphone", "watch"];
const HOME_TARGET: DeviceActionTarget = {
  mirrorKind: "home_accessory",
  idKey: "accessoryId",
  listedBy: { action: "home.read", list: "accessories" },
};
export const DEVICE_ACTION_REGISTRATIONS: readonly DeviceActionRegistration[] = Object.freeze([
  {
    name: "alarm.list",
    schemaVersion: 1,
    deviceKinds: ["iphone"],
    parameters: {},
    target: null,
    actionKind: "READ",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "none",
    snapshotBefore: false,
    reversible: true,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_ALARM_LIST.text,
    title: label("读取闹钟", "Read alarms", "アラームを読む"),
    confirmLabel: label("读取", "Read", "読み取る"),
    declineLabel: label("不读", "Don't read", "読まない"),
    detail: () =>
      label(
        "读取 Himawari 设的闹钟",
        "Read the alarms Himawari set",
        "Himawari が設定したアラームを読む",
      ),
  },
  {
    name: "alarm.set",
    schemaVersion: 1,
    deviceKinds: ["iphone"],
    parameters: { time: localTime(), label: text(120, false) },
    target: null,
    actionKind: "CREATE_OR_UPDATE",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "read_item",
    snapshotBefore: false,
    reversible: true,
    title: label("设闹钟", "Set alarms", "アラームを設定"),
    confirmLabel: label("设闹钟", "Set alarm", "アラームを設定"),
    declineLabel: label("不设", "Don't set", "設定しない"),
    detail: (args) =>
      detail((locale) => {
        const at = shownTime(String(args["time"]));
        const name = args["label"] as string | undefined;
        if (locale === "en") return joined([`Set alarm: ${at}`, name && `"${name}"`], " ");
        if (locale === "ja") return joined([`アラームを設定：${at}`, name && `「${name}」`], " ");
        return joined([`设闹钟：${at}`, name && `“${name}”`], " ");
      }),
  },
  {
    name: "calendar.read",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: { from: localTime(), to: localTime() },
    target: null,
    actionKind: "READ",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "none",
    snapshotBefore: false,
    reversible: true,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_READ.text,
    title: label("读取日程", "Read events", "予定を読む"),
    confirmLabel: label("读取", "Read", "読み取る"),
    declineLabel: label("不读", "Don't read", "読まない"),
    detail: (args) =>
      detail((locale) => {
        const when = period(shownTime(String(args["from"])), shownTime(String(args["to"])));
        if (locale === "en") return `Read events: ${when}`;
        if (locale === "ja") return `予定を読む：${when}`;
        return `读取日程：${when}`;
      }),
  },
  {
    name: "calendar.create",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: {
      title: text(200),
      start: localTime(),
      end: localTime(),
      allDay: flag(),
      calendar: text(120, false),
      location: text(200, false),
      notes: text(2000, false),
    },
    target: null,
    actionKind: "CREATE_OR_UPDATE",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "read_item",
    snapshotBefore: false,
    reversible: true,
    undo: undoCreatedItem("calendar.delete", "eventId"),
    title: label("新建日程", "Create events", "予定を作成"),
    confirmLabel: label("加进日历", "Add", "追加"),
    declineLabel: label("不加", "Don't add", "追加しない"),
    detail: (args) =>
      detail((locale) => {
        const when = period(shownTime(String(args["start"])), shownTime(String(args["end"])));
        if (locale === "en") return `Create event "${args["title"]}": ${when}`;
        if (locale === "ja") return `予定「${args["title"]}」を作成：${when}`;
        return `新建日程“${args["title"]}”：${when}`;
      }),
  },
  {
    name: "calendar.delete",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: { eventId: text(256), occurrenceStart: localTime(false) },
    target: CALENDAR_TARGET,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_CHANGE.text,
    actionKind: "DELETE",
    escalation: null,
    ownerPresence: () => true,
    recipients: null,
    resultOrigin: "owner",
    readBack: "confirm_absent",
    snapshotBefore: true,
    reversible: true,
    undo: undoDeletedEvent,
    title: label("删除日程", "Delete events", "予定を削除"),
    confirmLabel: label("删掉", "Delete", "削除"),
    declineLabel: label("不删", "Don't delete", "削除しない"),
    detail: (args, context) =>
      detail((locale) => {
        const title = named(context, "title");
        const at = occurrence(args, context, locale, ONLY_DELETE);
        if (locale === "en") return joined([`Delete event "${title}"`, at], ": ");
        if (locale === "ja") return joined([`予定「${title}」を削除`, at], "：");
        return joined([`删除日程“${title}”`, at], "：");
      }),
  },
  {
    name: "calendar.update",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: {
      eventId: text(256),
      occurrenceStart: localTime(false),
      title: text(200, false),
      start: localTime(false),
      end: localTime(false),
      location: text(200, false),
      notes: text(2000, false),
    },
    target: CALENDAR_TARGET,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_CHANGE.text,
    actionKind: "CREATE_OR_UPDATE",
    escalation: (_args, context) => (invites(context) ? "COMMUNICATE" : null),
    ownerPresence: (_args, context) => invites(context),
    recipients: null,
    resultOrigin: "owner",
    readBack: "read_item",
    snapshotBefore: true,
    reversible: true,
    undo: undoRestoring("calendar.update", "eventId", CALENDAR_CHANGEABLE, true),
    title: label("修改日程", "Change events", "予定を変更"),
    confirmLabel: label("改掉", "Change", "変更"),
    declineLabel: label("不改", "Don't change", "変更しない"),
    detail: (args, context) =>
      detail((locale) => {
        const title = named(context, "title");
        const at = occurrence(args, context, locale, ONLY_CHANGE);
        const changed = changes(args, CALENDAR_LABELS, locale);
        if (locale === "en")
          return joined([joined([`Change event "${title}"`, at && `(${at})`], " "), changed], ": ");
        if (locale === "ja")
          return joined([joined([`予定「${title}」`, at && `（${at}）`], ""), changed], "を変更：");
        return joined([joined([`修改日程“${title}”`, at && `（${at}）`], ""), changed], "：");
      }),
  },
  {
    name: "contact.search",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: { query: text(100) },
    target: null,
    actionKind: "READ",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "none",
    snapshotBefore: false,
    reversible: true,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_CONTACT_SEARCH.text,
    title: label("查找联系人", "Find contacts", "連絡先を探す"),
    confirmLabel: label("查找", "Find", "探す"),
    declineLabel: label("不查", "Don't find", "探さない"),
    detail: (args) =>
      detail((locale) => {
        if (locale === "en") return `Find contacts: ${args["query"]}`;
        if (locale === "ja") return `連絡先を探す：${args["query"]}`;
        return `查找联系人：${args["query"]}`;
      }),
  },
  {
    name: "contact.update",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: {
      contactId: text(256),
      givenName: text(100, false),
      familyName: text(100, false),
      phones: { type: "string_list", required: false, maxItems: 20, maxLength: 64 },
      emails: { type: "string_list", required: false, maxItems: 20, maxLength: 254 },
      organization: text(200, false),
    },
    target: {
      mirrorKind: "contact",
      idKey: "contactId",
      listedBy: { action: "contact.search", list: "contacts" },
    },
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_CONTACT_UPDATE.text,
    actionKind: "CREATE_OR_UPDATE",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "read_item",
    snapshotBefore: true,
    reversible: true,
    undo: undoRestoring("contact.update", "contactId", CONTACT_FIELDS, false),
    title: label("修改联系人", "Change contacts", "連絡先を変更"),
    confirmLabel: label("改掉", "Change", "変更"),
    declineLabel: label("不改", "Don't change", "変更しない"),
    detail: (args, context) =>
      detail((locale) => {
        const name = named(context, "name");
        const changed = changes(args, CONTACT_LABELS, locale);
        if (locale === "en") return joined([`Update contact "${name}"`, changed], ": ");
        if (locale === "ja") return joined([`連絡先「${name}」を更新`, changed], "：");
        return joined([`修改联系人“${name}”`, changed], "：");
      }),
  },
  {
    name: "device_reminder.complete",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: { reminderId: text(256) },
    target: {
      mirrorKind: "reminder",
      idKey: "reminderId",
      listedBy: { action: "device_reminder.read", list: "reminders" },
    },
    actionKind: "CREATE_OR_UPDATE",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "read_item",
    snapshotBefore: false,
    reversible: true,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_DEVICE_REMINDER_COMPLETE.text,
    title: label(
      "在“提醒事项”里标成完成",
      "Mark done in Reminders",
      "「リマインダー」で完了にする",
    ),
    confirmLabel: label("标成完成", "Mark done", "完了にする"),
    declineLabel: label("先不标", "Not yet", "まだしない"),
    detail: (_args, context) =>
      detail((locale) => {
        const title = named(context, "title");
        if (locale === "en") return `In Reminders, mark as done: ${title}`;
        if (locale === "ja") return `「リマインダー」で完了にする：${title}`;
        return `在“提醒事项”里标成完成：${title}`;
      }),
  },
  {
    name: "device_reminder.create",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: {
      title: text(200),
      due: localTime(false),
      notes: text(2000, false),
      list: text(120, false),
    },
    target: null,
    actionKind: "CREATE_OR_UPDATE",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "read_item",
    snapshotBefore: false,
    reversible: true,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_DEVICE_REMINDER.text,
    title: label("在“提醒事项”里新建", "Create in Reminders", "「リマインダー」に作成"),
    confirmLabel: label("新建", "Create", "作成"),
    declineLabel: label("不建", "Don't create", "作成しない"),
    detail: (args) =>
      detail((locale) => {
        const rest = changes(args, REMINDER_LABELS, locale);
        if (locale === "en") return joined([`In Reminders, create: ${args["title"]}`, rest], "; ");
        if (locale === "ja")
          return joined([`「リマインダー」に作成：${args["title"]}`, rest], "；");
        return joined([`在“提醒事项”里新建：${args["title"]}`, rest], "；");
      }),
  },
  {
    name: "device_reminder.read",
    schemaVersion: 1,
    deviceKinds: APPLE_DEVICES,
    parameters: {
      query: text(200, false),
      list: text(120, false),
      includeCompleted: { type: "boolean", required: false },
    },
    target: null,
    actionKind: "READ",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "none",
    snapshotBefore: false,
    reversible: true,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_DEVICE_REMINDER_READ.text,
    title: label("读取“提醒事项”", "Read Reminders", "「リマインダー」を読む"),
    confirmLabel: label("读取", "Read", "読み取る"),
    declineLabel: label("不读", "Don't read", "読まない"),
    detail: (args) =>
      detail((locale) => {
        const where = (args["list"] as string | undefined) ?? "";
        if (locale === "en") return joined(["Read Reminders", where], ": ");
        if (locale === "ja") return joined(["「リマインダー」を読む", where], "：");
        return joined(["读取“提醒事项”", where], "：");
      }),
  },
  {
    name: "home.control",
    schemaVersion: 1,
    deviceKinds: PHONE_AND_WATCH,
    parameters: {
      accessoryId: text(256),
      on: flag(),
      level: { type: "integer", required: false, minimum: 0, maximum: 100 },
      targetTemperature: { type: "number", required: false, minimum: 5, maximum: 40 },
      locked: flag(),
    },
    target: HOME_TARGET,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_HOME_CONTROL.text,
    actionKind: "CREATE_OR_UPDATE",
    escalation: (args, context) => (homeSafety(args, context) ? "PHYSICAL_SAFETY" : null),
    ownerPresence: homeSafety,
    recipients: null,
    resultOrigin: "owner",
    readBack: "read_state",
    snapshotBefore: false,
    reversible: false,
    title: label("控制家居", "Control home accessories", "家の機器を操作"),
    confirmLabel: label("照做", "Do it", "実行"),
    declineLabel: label("不做", "Don't", "しない"),
    detail: (args, context) =>
      detail((locale) => {
        const name = joined([named(context, "room"), named(context, "name")], " ");
        const changed = changes(args, HOME_LABELS, locale);
        if (locale === "en") return joined([`Control "${name}"`, changed], ": ");
        if (locale === "ja") return joined([`「${name}」を操作`, changed], "：");
        return joined([`控制“${name}”`, changed], "：");
      }),
  },
  {
    name: "home.read",
    schemaVersion: 1,
    deviceKinds: PHONE_AND_WATCH,
    parameters: { accessoryId: text(256, false), room: text(120, false) },
    target: HOME_TARGET,
    usage: TOOL_RESULT_DEVICE_ACTION_USAGE_HOME_READ.text,
    actionKind: "READ",
    escalation: null,
    ownerPresence: never,
    recipients: null,
    resultOrigin: "owner",
    readBack: "none",
    snapshotBefore: false,
    reversible: true,
    title: label("读取家居状态", "Read home state", "家の状態を読む"),
    confirmLabel: label("读取", "Read", "読み取る"),
    declineLabel: label("不读", "Don't read", "読まない"),
    detail: (args, context) =>
      detail((locale) => {
        const where = named(context, "name") || ((args["room"] as string | undefined) ?? "");
        if (locale === "en") return joined(["Read home state", where], ": ");
        if (locale === "ja") return joined(["家の状態を読む", where], "：");
        return joined(["读取家居状态", where], "：");
      }),
  },
]);

export const DEVICE_ACTION_REGISTRY = new DeviceActionRegistry(DEVICE_ACTION_REGISTRATIONS);
