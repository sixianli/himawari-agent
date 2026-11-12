import { maskSensitiveText } from "@himawari-agent/sensitive-capture";

export const APPROVAL_BODY_PREVIEW_DEFAULT_CHARACTERS = 300;
export const APPROVAL_BODY_PREVIEW_MAXIMUM_CHARACTERS = 2000;

const DISALLOWED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function approvalBodyPreview(text: string, maximumCharacters: number): string | null {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 1)
    throw new RangeError("Approval body preview limit must be a positive integer");
  const masked = maskSensitiveText(text).replace(DISALLOWED_CONTROL_CHARACTERS, "\uFFFD");
  if (masked.trim() === "") return null;
  const characters = [...masked];
  if (characters.length <= maximumCharacters) return masked;
  return `${characters.slice(0, maximumCharacters).join("")}…`;
}
