export const MACHINE_SECRET_RULE_IDS = Object.freeze([
  "private-key-block",
  "authorization-bearer",
  "jwt-token",
  "openai-api-key",
  "github-token",
  "aws-access-key",
  "credential-assignment",
] as const);

export type MachineSecretRuleId = (typeof MACHINE_SECRET_RULE_IDS)[number];

export interface MachineSecretFinding {
  readonly ruleId: MachineSecretRuleId;
  readonly count: number;
}

const RULES: ReadonlyArray<{
  readonly id: MachineSecretRuleId;
  readonly pattern: RegExp;
}> = Object.freeze([
  {
    id: "private-key-block",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  { id: "authorization-bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  {
    id: "jwt-token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  { id: "openai-api-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  {
    id: "github-token",
    pattern: /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    id: "credential-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi,
  },
]);

const REDACTED = "[MACHINE_SECRET_REDACTED]";

export function scanMachineSecrets(input: string): readonly MachineSecretFinding[] {
  const findings: MachineSecretFinding[] = [];
  for (const rule of RULES) {
    const matches = input.match(rule.pattern);
    if (matches?.length) findings.push(Object.freeze({ ruleId: rule.id, count: matches.length }));
  }
  return Object.freeze(findings);
}

const PRIVATE_KEY_BOUNDARY = /-----(?:BEGIN|END) (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

export function containsToolOutputSecret(input: string): boolean {
  return scanMachineSecrets(input).length > 0 || PRIVATE_KEY_BOUNDARY.test(input);
}

export function redactMachineSecrets(
  input: string,
  observe?: (ruleId: MachineSecretRuleId, value: string) => void,
): string {
  let result = input;
  for (const rule of RULES)
    result = result.replace(rule.pattern, (match) => {
      observe?.(rule.id, match);
      return REDACTED;
    });
  return result;
}

const KEY_KIND = "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----";
const KEY_MARKER = "PRIVATE KEY-----";
const KEY_LINES = 120;
const KEY_LINE_BREAK = String.raw`(?:\\r\\n|\\n|\r?\n)`;
const KEY_LINE_PREFIX = String.raw`(?:[^\s:\\"]*?[:-]\d+[:-])?[ \t+-]*\d*[ \t:]*`;
const KEY_LINE_START = String.raw`(?<=^|\\n|\n|")`;
const KEY_LINE_END = String.raw`(?=\\r|\\n|\r|\n|"|$)`;
const KEY_TEXT = "[A-Za-z0-9+/=]";
const KEY_LINE = `${KEY_LINE_PREFIX}${KEY_TEXT}{16,}${KEY_LINE_END}`;
const KEY_SHORT_LINE = `${KEY_LINE_PREFIX}${KEY_TEXT}+${KEY_LINE_END}`;
const KEY_TAIL_WINDOW = KEY_LINES * 160;
const PRIVATE_KEY_BLOCK = RULES.filter((rule) => rule.id === "private-key-block").map(
  (rule) => rule.pattern,
);
const KEY_HEAD = new RegExp(
  `-----BEGIN ${KEY_KIND}(?:[ \t]*${KEY_LINE_BREAK}${KEY_LINE_PREFIX}|[ \t]*)${KEY_TEXT}+(?:${KEY_LINE_BREAK}${KEY_SHORT_LINE}){0,${KEY_LINES}}`,
  "g",
);
const KEY_END = new RegExp(`${KEY_LINE_PREFIX}-----END ${KEY_KIND}`, "g");
const KEY_TAIL = new RegExp(
  `${KEY_LINE_START}(?:${KEY_LINE}${KEY_LINE_BREAK}){1,${KEY_LINES}}(?:${KEY_SHORT_LINE}${KEY_LINE_BREAK})?$`,
);

function nextLineStart(input: string, from: number, limit: number): number {
  const candidates = [input.indexOf("\n", from), input.indexOf("\\n", from)]
    .filter((index) => index !== -1 && index < limit)
    .map((index) => index + (input[index] === "\n" ? 1 : 2));
  return candidates.length === 0 ? limit : Math.min(...candidates);
}

function maskKeyTails(input: string, see: (value: string) => void): string {
  if (!input.includes("-----END ")) return input;
  let output = "";
  let cursor = 0;
  for (const marker of input.matchAll(KEY_END)) {
    if (marker.index < cursor) continue;
    const earliest = Math.max(cursor, marker.index - KEY_TAIL_WINDOW);
    const from = earliest === cursor ? earliest : nextLineStart(input, earliest, marker.index);
    const tail = KEY_TAIL.exec(input.slice(from, marker.index));
    if (tail === null) continue;
    const start = from + tail.index;
    const end = marker.index + marker[0].length;
    see(input.slice(start, end));
    output += input.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return output + input.slice(cursor);
}

export function redactPrivateKeyFragments(
  input: string,
  observe?: (ruleId: MachineSecretRuleId, value: string) => void,
): string {
  if (!input.includes(KEY_MARKER)) return input;
  const see = (value: string) => observe?.("private-key-block", value);
  let result = input;
  for (const pattern of PRIVATE_KEY_BLOCK)
    result = result.replace(pattern, (match) => {
      see(match);
      return REDACTED;
    });
  if (result.includes("-----BEGIN "))
    result = result.replace(KEY_HEAD, (match) => {
      see(match);
      return REDACTED;
    });
  return maskKeyTails(result, see);
}

export class MachineSecretExclusionError extends Error {
  readonly code = "MACHINE_SECRET_EXCLUDED" as const;
  readonly findings: readonly MachineSecretFinding[];

  constructor(findings: readonly MachineSecretFinding[]) {
    super("Machine-secret material is not permitted at this boundary");
    this.name = "MachineSecretExclusionError";
    this.findings = Object.freeze(findings.map((finding) => Object.freeze({ ...finding })));
  }
}

export function assertMachineSecretFree(input: string): void {
  const findings = scanMachineSecrets(input);
  if (findings.length > 0) throw new MachineSecretExclusionError(findings);
}

const POTENTIAL_SECRET_MARKERS = Object.freeze([
  "Bearer ",
  "password",
  "api_key",
  "api-key",
  "access_token",
  "access-token",
  "refresh_token",
  "refresh-token",
  "client_secret",
  "client-secret",
  "webhook_secret",
  "webhook-secret",
  "sk-",
  "gho_",
  "ghp_",
  "ghs_",
  "ghu_",
  "ghr_",
  "github_pat_",
  "AKIA",
  "ASIA",
  "eyJ",
  "-----BEGIN",
] as const);

const ACTIVE_SECRET_SUFFIXES = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]*$/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]*$/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]*$/,
  /\b(?:gh[opsu]_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*)$/,
  /\b(?:AKIA|ASIA)[A-Z0-9]*$/,
  /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/,
] as const);

export function machineSecretHoldStart(value: string): number | null {
  let holdStart: number | null = null;
  const hold = (index: number) => {
    holdStart = holdStart === null ? index : Math.min(holdStart, index);
  };
  const privateKeyStart = value.search(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  if (
    privateKeyStart >= 0 &&
    !/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value.slice(privateKeyStart))
  ) {
    hold(privateKeyStart);
  }
  for (const pattern of ACTIVE_SECRET_SUFFIXES) {
    const match = pattern.exec(value);
    if (match?.index !== undefined) hold(match.index);
  }
  for (const marker of POTENTIAL_SECRET_MARKERS) {
    const maximum = Math.min(marker.length - 1, value.length);
    for (let length = maximum; length > 0; length -= 1) {
      if (value.endsWith(marker.slice(0, length))) {
        hold(value.length - length);
        break;
      }
    }
  }
  return holdStart;
}

export class StreamingMachineSecretRedactor {
  #pending = "";

  append(value: string): string {
    this.#pending += value;
    const holdStart = machineSecretHoldStart(this.#pending);
    if (holdStart === null) {
      const safe = this.#pending;
      this.#pending = "";
      return redactMachineSecrets(safe);
    }
    if (holdStart === 0) return "";
    const safe = this.#pending.slice(0, holdStart);
    this.#pending = this.#pending.slice(holdStart);
    return redactMachineSecrets(safe);
  }

  flush(): string {
    const safe = redactMachineSecrets(this.#pending);
    this.#pending = "";
    return safe;
  }
}
