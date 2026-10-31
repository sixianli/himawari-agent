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

export function redactMachineSecrets(input: string): string {
  let result = input;
  for (const rule of RULES) result = result.replace(rule.pattern, REDACTED);
  return result;
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
