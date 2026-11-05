const WEB_CONTENT_SECRET =
  /(?:sk-[A-Za-z0-9_-]{12,}|(?:password|passwd|token|secret|recovery[_ -]?code)\s*[:=]\s*[^\s,;]{4,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;

export function redactWebContentSecrets(text: string): {
  readonly text: string;
  readonly found: boolean;
} {
  const found = WEB_CONTENT_SECRET.test(text);
  WEB_CONTENT_SECRET.lastIndex = 0;
  return { text: text.replace(WEB_CONTENT_SECRET, "[REDACTED_MACHINE_SECRET]"), found };
}
