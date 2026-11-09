import { describe, expect, it } from "vitest";
import { jsonToolArguments } from "../src/json-tool-arguments.js";

function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let level = 0; level < depth; level += 1) value = { child: value };
  return value;
}

describe("tool arguments are plain JSON before Pi validates them", () => {
  it("accepts plain JSON objects, including a value shared by two fields", () => {
    const shared = { path: "a.txt" };
    const value = { a: shared, b: shared, list: [1, "x", true, null], none: Object.create(null) };
    expect(jsonToolArguments(value)).toBe(value);
    expect(jsonToolArguments(nested(63))).toEqual(nested(63));
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "{}"],
    ["undefined inside", { path: undefined }],
    ["a BigInt", { size: 1n }],
    ["a function", { run: () => undefined }],
    ["NaN", { count: Number.NaN }],
    ["Infinity", { count: Number.POSITIVE_INFINITY }],
    ["a Map", { map: new Map() }],
    ["a Date", { when: new Date(0) }],
    ["a symbol key", { [Symbol("hidden")]: 1 }],
    ["a sparse array", { list: new Array(2) }],
    ["too deep", nested(65)],
    ["too many nodes", { list: Array.from({ length: 100_001 }, () => 0) }],
  ])("rejects %s", (_name, value) => {
    expect(() => jsonToolArguments(value)).toThrow("PI_TOOL_ARGUMENTS_INVALID");
  });

  it("rejects a cycle", () => {
    const value: Record<string, unknown> = {};
    value["self"] = value;
    expect(() => jsonToolArguments(value)).toThrow("PI_TOOL_ARGUMENTS_INVALID");
  });
});
