import { findSensitiveValues, maskSensitiveText } from "./redaction.js";

const TOKEN = /^[A-Za-z0-9_\-+/=.:@]+$/u;
const TOKEN_RUN = /[A-Za-z0-9_\-+/=.:@]+/gu;
const LETTER = /[A-Za-z]/u;
const DIGIT = /\d/u;
const SHORTEST_REMEMBERED_VALUE = 4;

export function looksLikeSecretToken(word: string): boolean {
  const value = word.normalize("NFKC");
  if (!TOKEN.test(value)) return false;
  if (/^\d{6,}$/u.test(value)) return true;
  if (value.length >= 24) return true;
  return value.length >= 8 && LETTER.test(value) && DIGIT.test(value);
}

export function maskForIndex(text: string): string {
  const values = [
    ...new Set(
      findSensitiveValues(text)
        .map(({ value }) => value)
        .filter((value) => value.length >= SHORTEST_REMEMBERED_VALUE),
    ),
  ].sort((left, right) => right.length - left.length);
  let masked = maskSensitiveText(text);
  for (const value of values) masked = masked.split(value).join(" ");
  return masked.replace(TOKEN_RUN, (run) => (looksLikeSecretToken(run) ? " " : run));
}

export function isSafeToIndex(text: string): boolean {
  return maskForIndex(text) === text;
}
