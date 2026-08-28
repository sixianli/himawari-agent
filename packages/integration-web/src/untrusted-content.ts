const EXECUTABLE_ELEMENTS =
  /<(script|style|noscript|template|iframe|object|embed|form|input|button|textarea|select)\b[^>]*>[\s\S]*?<\/\1\s*>|<(script|style|noscript|template|iframe|object|embed|form|input|button|textarea|select)\b[^>]*\/?\s*>/gi;
const HTML_TAG = /<[^>]+>/g;
const SECRET_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{12,}|(?:password|passwd|token|secret|recovery[_ -]?code)\s*[:=]\s*[^\s,;]{4,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;
const INSTRUCTION_PATTERN =
  /(?:ignore (?:all )?(?:previous|system) instructions?|upload (?:your )?(?:key|secret|token)|run (?:this )?(?:command|shell)|install (?:this )?(?:plugin|capability))/gi;

export interface UntrustedExtractionResult {
  readonly text: string;
  readonly excludedReasonCodes: readonly string[];
  readonly instructionMatches: readonly string[];
}

export function extractUntrustedWebContent(input: {
  readonly contentType: string;
  readonly body: string;
  readonly maximumCharacters: number;
}): UntrustedExtractionResult {
  const excluded = new Set<string>();
  let text = input.body;
  if (input.contentType.includes("html")) {
    if (EXECUTABLE_ELEMENTS.test(text)) excluded.add("executable_elements_removed");
    EXECUTABLE_ELEMENTS.lastIndex = 0;
    text = text.replace(EXECUTABLE_ELEMENTS, " ").replace(HTML_TAG, " ");
  }
  if (SECRET_PATTERN.test(text)) excluded.add("machine_secret_removed");
  SECRET_PATTERN.lastIndex = 0;
  text = text.replace(SECRET_PATTERN, "[REDACTED_MACHINE_SECRET]");
  const instructionMatches = [...text.matchAll(INSTRUCTION_PATTERN)].map((match) => match[0]);
  INSTRUCTION_PATTERN.lastIndex = 0;
  if (instructionMatches.length > 0) excluded.add("prompt_injection_observed");
  text = decodeBasicEntities(text).replace(/\s+/g, " ").trim();
  if (text.length > input.maximumCharacters) {
    text = text.slice(0, input.maximumCharacters);
    excluded.add("content_truncated");
  }
  return Object.freeze({
    text,
    excludedReasonCodes: Object.freeze([...excluded].sort()),
    instructionMatches: Object.freeze(instructionMatches),
  });
}

function decodeBasicEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}
