const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?[A-Za-z0-9._~+/=-]{12,}(?:\\?["'])?/gi,
];

export function redactText(text, { sentinels = [] } = {}) {
  let output = String(text);
  for (const sentinel of sentinels) {
    if (typeof sentinel !== "string" || sentinel.length === 0)
      throw new Error("PUBLIC_SENTINEL_INVALID");
    output = output.split(sentinel).join("[REDACTED]");
  }
  for (const pattern of patterns) output = output.replace(pattern, "[REDACTED]");
  return output;
}
