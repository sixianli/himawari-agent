import { PERCEPTION_IMAGE_UNDERSTAND } from "@himawari-agent/prompt-catalog";

const DESCRIPTION_MAXIMUM = 80;

function jsonObject(output: string): Record<string, unknown> | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function bounded(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || [...trimmed].length > maximum ? null : trimmed;
}

export function perceptionImagePrompt(): string {
  return PERCEPTION_IMAGE_UNDERSTAND.text;
}

export function parsePerceptionImage(
  output: string,
): { readonly text: string; readonly description: string } | null {
  const parsed = jsonObject(output);
  if (!parsed || typeof parsed["text"] !== "string") return null;
  const description = bounded(parsed["description"], DESCRIPTION_MAXIMUM);
  return description === null ? null : { text: parsed["text"], description };
}
