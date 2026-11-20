import { describe, expect, it } from "vitest";
import {
  array,
  booleanValue,
  codePointString,
  enumeration,
  integer,
  machineString,
  nullable,
  object,
  parseJson,
  timestamp,
} from "../src/validation.ts";

describe("code point strings", () => {
  it("counts emoji as one character and rejects them past the limit", () => {
    expect(codePointString(64).parse("😀".repeat(64))).toBe("😀".repeat(64));
    expect(() => codePointString(64).parse("😀".repeat(65))).toThrow();
  });
  it("accepts line breaks and tabs only when asked, and never other control characters", () => {
    const text = "第一行\n\t第二行";
    expect(codePointString(100, { allowLineBreaks: true }).parse(text)).toBe(text);
    expect(() => codePointString(100).parse(text)).toThrow();
    expect(() => codePointString(100, { allowLineBreaks: true }).parse("a\u0000b")).toThrow();
    expect(() => codePointString(100, { allowLineBreaks: true }).parse("")).toThrow();
  });
});

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
