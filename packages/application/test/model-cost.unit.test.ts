import { PORT_ERROR_CODES, usdCostsEqual, usdCostToMicros } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";

describe("gateway dollar accounting", () => {
  it.each([
    ["0.0000001", "0.0000002", false],
    ["1e-7", "0.00000010", true],
    ["0", "0.00000", true],
    ["0.0000130000000000000000000001", "0.000013", false],
  ])("[R2-L5] compares USD fees %s and %s before rounding", (left, right, equal) => {
    expect(usdCostsEqual(left, right)).toBe(equal);
  });

  it.each([
    [0, 0],
    ["0", 0],
    ["0.00000019", 1],
    [0.00000019, 1],
    ["0.0006480004", 649],
    ["0.0000130000000000000000000001", 14],
    ["1e-7", 1],
    ["1.2e-5", 12],
    [1, 1_000_000],
    ["9007199254.740991", Number.MAX_SAFE_INTEGER],
  ])("[R2-L5] rounds the actual USD fee %s upward to %s micros", (dollars, micros) => {
    expect(usdCostToMicros(dollars)).toBe(micros);
  });

  it.each(
    [
      undefined,
      null,
      false,
      {},
      [],
      "",
      " ",
      " 0.1",
      "-0.1",
      "0x10",
      "1.2.3",
      "Infinity",
      "NaN",
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "9007199254.7409910001",
      "1e999",
      "1e-999",
      `0.${"0".repeat(129)}`,
    ].map((dollars) => [dollars] as const),
  )("[R2-L5] rejects an untrusted USD fee %s rather than making it free", (dollars) => {
    expect(() => usdCostToMicros(dollars)).toThrow(
      expect.objectContaining({ code: PORT_ERROR_CODES.INVALID_OPERATION }),
    );
  });
});
