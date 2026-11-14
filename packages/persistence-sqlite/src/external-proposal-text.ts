import { createHash } from "node:crypto";

const INVISIBLE_FORMATTING = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;

export function normalizeProposalText(text: string): string {
  return text.normalize("NFC").replace(INVISIBLE_FORMATTING, " ").replace(/ {2,}/gu, " ").trim();
}

export function proposalTextDigest(text: string): string {
  return createHash("sha256").update(normalizeProposalText(text)).digest("hex");
}
