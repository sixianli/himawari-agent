import type { JsonValue } from "./canonical.js";

export interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: JsonValue;
  readonly description?: string;
  readonly properties?: { readonly [key: string]: JsonSchema };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export function validateAgainst(schema: JsonSchema, value: unknown, at = "$"): string | null {
  const types = schema.type === undefined ? null : [schema.type].flat();
  if (types !== null && !types.some((type) => matchesType(type, value)))
    return `${at}: 类型应为 ${types.join("|")}`;
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean | null))
    return `${at}: 不在允许的取值内`;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value))
    return `${at}: 取值不符`;
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at}: 小于下限`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at}: 大于上限`;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return `${at}: 过短`;
    if (schema.maxLength !== undefined && length > schema.maxLength) return `${at}: 过长`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      return `${at}: 格式不符`;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const problem = validateAgainst(schema.items, value[index], `${at}[${index}]`);
      if (problem !== null) return problem;
    }
  }
  if (isRecord(value) && schema.properties !== undefined) {
    for (const key of schema.required ?? []) if (!(key in value)) return `${at}: 缺少字段 ${key}`;
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties[key];
      if (child === undefined) {
        if (schema.additionalProperties === false) return `${at}: 多出字段 ${key}`;
        continue;
      }
      const problem = validateAgainst(child, item, `${at}.${key}`);
      if (problem !== null) return problem;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return false;
  }
}
