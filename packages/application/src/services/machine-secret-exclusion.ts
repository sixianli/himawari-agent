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
