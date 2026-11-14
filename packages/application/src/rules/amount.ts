export type AmountState = "known" | "uncertain" | "missing";

export interface MailAmount {
  readonly state: AmountState;
  readonly minor: number;
  readonly currency: string;
}

export const MISSING_AMOUNT: MailAmount = Object.freeze({
  state: "missing",
  minor: 0,
  currency: "",
});

const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  JPY: 0,
  KRW: 0,
  VND: 0,
  CNY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  TWD: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  KWD: 3,
});

export function currencyExponent(currency: string): number | undefined {
  return Object.hasOwn(CURRENCY_EXPONENTS, currency) ? CURRENCY_EXPONENTS[currency] : undefined;
}

export function toMinorUnits(value: unknown, currency: unknown): number | undefined {
  if (typeof value !== "string" || typeof currency !== "string") return undefined;
  const exponent = currencyExponent(currency);
  if (exponent === undefined) return undefined;
  const match = /^(\d{1,15})(?:\.(\d{1,15}))?$/u.exec(value.trim());
  if (!match) return undefined;
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) return undefined;
  const minor = Number(`${match[1]}${fraction.padEnd(exponent, "0")}`);
  return Number.isSafeInteger(minor) ? minor : undefined;
}

export function parseMailAmount(raw: unknown, bodyComplete: boolean): MailAmount {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return MISSING_AMOUNT;
  const entry = raw as Record<string, unknown>;
  const currency =
    typeof entry["currency"] === "string" ? entry["currency"].trim().toUpperCase() : "";
  const minor = toMinorUnits(entry["value"], currency);
  if (minor === undefined) return MISSING_AMOUNT;
  const sure = entry["confidence"] === "sure" && bodyComplete;
  return Object.freeze({ state: sure ? "known" : "uncertain", minor, currency });
}

export type MoneyState = "yes" | "no" | "unknown";

export function parseMailMoney(raw: unknown): MoneyState {
  return raw === "yes" || raw === "no" ? raw : "unknown";
}
