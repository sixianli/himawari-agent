import { maskSensitiveText } from "./redaction.js";

const TOKEN = /^[A-Za-z0-9_\-+/=.:@]+$/u;
const DIGITS = /\d/gu;
const LETTER = /[A-Za-z]/u;

export function looksLikeSecretToken(word: string): boolean {
  const value = word.normalize("NFKC");
  if (!TOKEN.test(value)) return false;
  if (/^\d{6,}$/u.test(value)) return true;
  if (value.length >= 24) return true;
  if (!LETTER.test(value)) return false;
  const digits = value.match(DIGITS)?.length ?? 0;
  if (digits === 0) return false;
  return value.length >= 16 || (value.length >= 8 && digits >= 3);
}

export function isSafeToIndex(text: string): boolean {
  return (
    maskSensitiveText(text) === text &&
    !text.split(/[\s,，;；]+/u).some((part) => looksLikeSecretToken(part))
  );
}
