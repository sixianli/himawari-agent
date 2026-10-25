import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";

function invalidCost(): ApplicationPortError {
  return new ApplicationPortError(
    PORT_ERROR_CODES.INVALID_OPERATION,
    "Reported USD cost is invalid",
  );
}

function parseUsdCost(value: unknown): {
  readonly coefficient: bigint;
  readonly scale: number;
  readonly micros: number;
} {
  if (typeof value !== "string" && typeof value !== "number") throw invalidCost();
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw invalidCost();
  const text = String(value);
  if (text.length > 128) throw invalidCost();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (match === null) throw invalidCost();
  const exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 324) throw invalidCost();
  const fraction = match[2] ?? "";
  const coefficient = BigInt(`${match[1]}${fraction}`);
  const scale = exponent + 6 - fraction.length;
  const denominator = scale < 0 ? 10n ** BigInt(-scale) : 1n;
  const numerator = scale >= 0 ? coefficient * 10n ** BigInt(scale) : coefficient;
  const micros = (numerator + denominator - 1n) / denominator;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidCost();
  return { coefficient, scale, micros: Number(micros) };
}

export function usdCostToMicros(value: unknown): number {
  return parseUsdCost(value).micros;
}

export function usdCostsEqual(leftValue: unknown, rightValue: unknown): boolean {
  const left = parseUsdCost(leftValue);
  const right = parseUsdCost(rightValue);
  const scale = Math.min(left.scale, right.scale);
  return (
    left.coefficient * 10n ** BigInt(left.scale - scale) ===
    right.coefficient * 10n ** BigInt(right.scale - scale)
  );
}
