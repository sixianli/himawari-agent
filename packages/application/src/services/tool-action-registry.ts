import type { ActionKind, ActionSideEffect, DisclosureMode } from "../ports/authorization.js";
import type { JsonObject } from "../ports/common.js";
import type { RuntimeToolDescriptor } from "../ports/intelligence.js";

export const TOOL_ACTION_FAMILIES = Object.freeze([
  "builtin",
  "coding",
  "web",
  "authorized_handle",
  "task_management",
  "device_action",
] as const);
export type ToolActionFamily = (typeof TOOL_ACTION_FAMILIES)[number];

export const TOOL_CONTENT_ORIGINS = Object.freeze(["owner_data", "external"] as const);
export type ToolContentOrigin = (typeof TOOL_CONTENT_ORIGINS)[number];

export const TOOL_AUTHORIZATION_PATHS = Object.freeze([
  "read",
  "owner_scope",
  "governed_workflow",
] as const);
export type ToolAuthorizationPath = (typeof TOOL_AUTHORIZATION_PATHS)[number];

export const TOOL_ACTION_LOCALES = Object.freeze(["zh", "en", "ja"] as const);
export type ToolActionLocale = (typeof TOOL_ACTION_LOCALES)[number];

export interface DeviceToolAction {
  readonly schemaVersion: number;
  readonly deviceKinds: readonly string[];
  readonly parameters: JsonObject;
  readonly readBack: string;
  readonly snapshotBefore: boolean;
}

export interface ToolActionRow {
  readonly tool: string;
  readonly toolIsPrefix?: true;
  readonly family: ToolActionFamily;
  readonly capabilityRef: string | null;
  readonly operation: string;
  readonly actionKind: ActionKind;
  readonly reversible: boolean;
  readonly sideEffect: ActionSideEffect;
  readonly targetType: string;
  readonly disclosure: DisclosureMode;
  readonly ownerPresenceRequired: boolean;
  readonly standingRuleChange: boolean;
  readonly resultOrigin: ToolContentOrigin;
  readonly mayFollowExternalContent: boolean;
  readonly authorization: ToolAuthorizationPath;
  readonly executor: string;
  readonly deduplication: string;
  readonly detail: (input: JsonObject, locale: ToolActionLocale) => string;
  readonly device?: DeviceToolAction;
}

export class ToolActionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolActionRegistryError";
  }
}

function assertRow(row: ToolActionRow): void {
  const fail = (reason: string): never => {
    throw new ToolActionRegistryError(`工具动作登记表的 ${row.tool || "（无名）"} 这一行${reason}`);
  };
  if (!row.tool || !row.operation || !row.targetType || !row.executor || !row.deduplication)
    fail("缺字段");
  if (!TOOL_ACTION_FAMILIES.includes(row.family)) fail("家族不在清单里");
  if (!TOOL_CONTENT_ORIGINS.includes(row.resultOrigin)) fail("内容来源不在清单里");
  if (!TOOL_AUTHORIZATION_PATHS.includes(row.authorization)) fail("授权路径不在清单里");
  if (typeof row.detail !== "function") fail("缺明细函数");
  const consequential = row.actionKind !== "READ" || row.sideEffect !== "none";
  if (row.authorization === "read" && consequential) fail("有后果却登记成读取");
  if (row.authorization === "read" && (row.ownerPresenceRequired || row.standingRuleChange))
    fail("读取不能要求本人在场或标成改规则");
  if (row.authorization === "owner_scope" && row.capabilityRef === null)
    fail("走统一出口的工具必须写明能力名");
  if (row.reversible !== (row.sideEffect !== "irreversible")) fail("能否撤销和后果对不上");
  if (row.family === "device_action" && !row.device) fail("设备动作缺设备那几列");
  if (row.family !== "device_action" && row.device) fail("不是设备动作却带了设备那几列");
}

const READ_ONLY_FAMILIES: readonly ToolActionFamily[] = Object.freeze(["builtin", "web"]);

export function readOnlyRow(row: ToolActionRow): boolean {
  return (
    row.actionKind === "READ" &&
    row.sideEffect === "none" &&
    READ_ONLY_FAMILIES.includes(row.family)
  );
}

export class ToolActionRegistry {
  readonly rows: readonly ToolActionRow[];
  readonly #exact = new Map<string, ToolActionRow>();
  readonly #prefixes: readonly ToolActionRow[];
  readonly #byCapability = new Map<string, ToolActionRow>();

  constructor(rows: readonly ToolActionRow[]) {
    for (const row of rows) {
      assertRow(row);
      if (!row.toolIsPrefix) {
        if (this.#exact.has(row.tool))
          throw new ToolActionRegistryError(`工具动作登记表里 ${row.tool} 重复`);
        this.#exact.set(row.tool, row);
      }
      if (row.capabilityRef !== null) {
        if (this.#byCapability.has(row.capabilityRef))
          throw new ToolActionRegistryError(`工具动作登记表里能力 ${row.capabilityRef} 重复`);
        this.#byCapability.set(row.capabilityRef, row);
      }
    }
    this.#prefixes = Object.freeze(rows.filter((row) => row.toolIsPrefix));
    const prefixNames = this.#prefixes.map(({ tool }) => tool);
    if (
      new Set(prefixNames).size !== prefixNames.length ||
      [...this.#exact.keys()].some((name) => prefixNames.some((prefix) => name.startsWith(prefix)))
    )
      throw new ToolActionRegistryError("工具动作登记表里的名字前缀和别的行撞了");
    this.rows = Object.freeze([...rows]);
  }

  forTool(name: string): ToolActionRow | undefined {
    return this.#exact.get(name) ?? this.#prefixes.find(({ tool }) => name.startsWith(tool));
  }

  forCapability(capabilityRef: string): ToolActionRow | undefined {
    return this.#byCapability.get(capabilityRef);
  }

  offer(
    descriptors: readonly RuntimeToolDescriptor[],
    options: { readonly readOnly?: boolean } = {},
  ): readonly RuntimeToolDescriptor[] {
    return descriptors.filter((descriptor) => {
      const row = this.forTool(descriptor.name);
      if (!row) return false;
      if (options.readOnly === true && !readOnlyRow(row)) return false;
      const parallel = "executionMode" in descriptor && descriptor.executionMode === "parallel";
      return !parallel || row.actionKind === "READ";
    });
  }
}
