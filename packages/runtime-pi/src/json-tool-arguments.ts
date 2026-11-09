import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

const MAXIMUM_DEPTH = 64;
const MAXIMUM_NODES = 100_000;

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
  budget: { nodes: number },
): asserts value is JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAXIMUM_NODES || depth > MAXIMUM_DEPTH)
    throw new Error("PI_TOOL_ARGUMENTS_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("PI_TOOL_ARGUMENTS_INVALID");
    return;
  }
  if (typeof value !== "object") throw new Error("PI_TOOL_ARGUMENTS_INVALID");
  if (seen.has(value)) throw new Error("PI_TOOL_ARGUMENTS_INVALID");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error("PI_TOOL_ARGUMENTS_INVALID");
      assertJsonValue(value[index], depth + 1, seen, budget);
    }
  } else {
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0)
      throw new Error("PI_TOOL_ARGUMENTS_INVALID");
    for (const entry of Object.values(value)) assertJsonValue(entry, depth + 1, seen, budget);
  }
  seen.delete(value);
}

export function jsonToolArguments(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("PI_TOOL_ARGUMENTS_INVALID");
  assertJsonValue(value, 0, new Set(), { nodes: 0 });
  return value as JsonObject;
}
