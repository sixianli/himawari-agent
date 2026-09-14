import { describe, expect, it } from "vitest";
import {
  array,
  booleanValue,
  enumeration,
  integer,
  machineString,
  nullable,
  object,
  parseJson,
  timestamp,
} from "../src/validation.ts";

describe("strict wire value boundaries", () => {
  it.each([undefined, null, "true", 1])("does not coerce boolean %j", (value) => {
    expect(() => booleanValue.parse(value, "$.enabled")).toThrow("$.enabled");
  });
  it.each([null, 0, "invalid", "2026-09-14", "2026-09-14T00:00:00+00:00"])(
    "requires canonical timestamp %j",
    (value) => {
      expect(() => timestamp.parse(value, "$.at")).toThrow("$.at");
    },
  );
  it.each([null, "", "a".repeat(129), "contains space", "line\nbreak"])(
    "rejects invalid identifier %j",
    (value) => {
      expect(() => machineString.parse(value)).toThrow();
    },
  );
  it.each([0, 11, 1.5, Number.NaN, Infinity, "2"])(
    "enforces inclusive integer bounds for %j",
    (value) => {
      expect(() => integer(1, 10).parse(value)).toThrow();
    },
  );
  it("preserves primitive types, nullable values, bounds and nested error paths", () => {
    const schema = object({
      enabled: booleanValue,
      count: integer(1, 10),
      state: enumeration(["ready", "waiting"]),
      refs: array(nullable(machineString)),
      at: timestamp,
    });
    const value = {
      enabled: true,
      count: 10,
      state: "ready",
      refs: ["one", null],
      at: "2026-09-14T00:00:00.000Z",
    };
    expect(parseJson(schema, JSON.stringify(value))).toEqual(value);
    expect(Object.isFrozen(schema.parse(value))).toBe(true);
    expect(() => schema.parse({ ...value, refs: ["one", false] })).toThrow("$.refs[1]");
    expect(() => schema.parse({ ...value, refs: "one" })).toThrow("$.refs");
    expect(() => schema.parse({ ...value, extra: true })).toThrow("$.extra");
    const { enabled: _enabled, ...missing } = value;
    expect(() => schema.parse(missing)).toThrow("$.enabled");
    expect(() => schema.parse([])).toThrow("expected an object");
    expect(() => parseJson(schema, "{bad")).toThrow("expected valid JSON");
  });
});
