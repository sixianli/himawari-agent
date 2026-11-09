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

const PLACEHOLDER = /(\[(?:密码|验证码|证件号|密钥|银行卡 尾号\d{4})\])/u;
const ASCII_PIECE = /[A-Za-z0-9_\-+/@#$%^&*~!?.]+/gu;
const PIECE_EDGE_PUNCTUATION = /^[.!?]+|[.!?]+$/gu;
const ASCII_WORD = /[A-Za-z0-9_]/u;

function bareForms(value: string): readonly string[] {
  const pieces = (value.match(ASCII_PIECE) ?? []).map((piece) =>
    piece.replace(PIECE_EDGE_PUNCTUATION, ""),
  );
  return [value, ...pieces];
}

function wholeWordPattern(value: string): RegExp {
  const before = ASCII_WORD.test(value[0] ?? "") ? "(?<![A-Za-z0-9_])" : "";
  const after = ASCII_WORD.test(value.at(-1) ?? "") ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${before}${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}${after}`, "gu");
}

export function maskForIndex(text: string): string {
  const values = [
    ...new Set(
      findSensitiveValues(text)
        .flatMap(({ value }) => bareForms(value))
        .filter((value) => value.length >= SHORTEST_REMEMBERED_VALUE),
    ),
  ].sort((left, right) => right.length - left.length);
  const patterns = values.map(wholeWordPattern);
  return maskSensitiveText(text)
    .split(PLACEHOLDER)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      const cleared = patterns.reduce((current, pattern) => current.replace(pattern, " "), part);
      return cleared.replace(TOKEN_RUN, (run) => (looksLikeSecretToken(run) ? " " : run));
    })
    .join("");
}

export function isSafeToIndex(text: string): boolean {
  return maskForIndex(text) === text;
}
