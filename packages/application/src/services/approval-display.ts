import { maskSensitiveText } from "@himawari-agent/sensitive-capture";

export const APPROVAL_BODY_PREVIEW_DEFAULT_CHARACTERS = 300;
export const APPROVAL_BODY_PREVIEW_MAXIMUM_CHARACTERS = 2000;

function isDisallowedCharacter(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    code === 0x7f ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function replaceDisallowedCharacters(text: string): string {
  return [...text]
    .map((character) => (isDisallowedCharacter(character.charCodeAt(0)) ? "\uFFFD" : character))
    .join("");
}

export function approvalBodyPreview(text: string, maximumCharacters: number): string | null {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 1)
    throw new RangeError("Approval body preview limit must be a positive integer");
  const masked = replaceDisallowedCharacters(maskSensitiveText(text));
  if (masked.trim() === "") return null;
  const characters = [...masked];
  if (characters.length <= maximumCharacters) return masked;
  return `${characters.slice(0, maximumCharacters).join("")}…`;
}
